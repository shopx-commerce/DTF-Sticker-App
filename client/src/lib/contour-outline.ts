import type { StrokeSettings, ResizeSettings } from "@/lib/types";
import { PDFDocument, PDFName, PDFArray, PDFDict } from 'pdf-lib';
import { removeLoopsWithClipper, ensureClockwise, detectSelfIntersections, gaussianSmoothContour, subsamplePolygon } from "@/lib/clipper-path";
import { getContourWorkerManager } from "@/lib/contour-worker-manager";
import { addSpotColorVectorsToPDF } from "@/lib/spot-color-vectors";

export function simplifyPathForPDF(points: Array<{x: number; y: number}>, epsilon: number = 1.0): Array<{x: number; y: number}> {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIdx = 0;
  const start = points[0];
  const end = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], start, end);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = simplifyPathForPDF(points.slice(0, maxIdx + 1), epsilon);
    const right = simplifyPathForPDF(points.slice(maxIdx), epsilon);
    return left.slice(0, -1).concat(right);
  }

  return [start, end];
}

function perpendicularDistance(
  point: {x: number; y: number},
  lineStart: {x: number; y: number},
  lineEnd: {x: number; y: number}
): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = point.x - lineStart.x;
    const ey = point.y - lineStart.y;
    return Math.sqrt(ex * ex + ey * ey);
  }
  const num = Math.abs(dy * point.x - dx * point.y + lineEnd.x * lineStart.y - lineEnd.y * lineStart.x);
  return num / Math.sqrt(lenSq);
}

export function buildSmoothPdfPath(
  pointsInches: Array<{x: number; y: number}>,
  closed: boolean = true
): string {
  if (pointsInches.length < 2) return '';

  const pts = pointsInches.map(p => ({ x: p.x * 72, y: p.y * 72 }));
  const n = pts.length;

  let path = `${pts[0].x.toFixed(4)} ${pts[0].y.toFixed(4)} m\n`;

  if (n === 2) {
    path += `${pts[1].x.toFixed(4)} ${pts[1].y.toFixed(4)} l\n`;
    if (closed) path += 'h\n';
    return path;
  }

  const segCount = closed ? n : n - 1;

  for (let i = 0; i < segCount; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];

    let p0: typeof p1;
    let p3: typeof p1;

    if (closed) {
      p0 = pts[(i - 1 + n) % n];
      p3 = pts[(i + 2) % n];
    } else {
      p0 = i > 0 ? pts[i - 1] : { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y };
      p3 = i + 2 < n ? pts[i + 2] : { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y };
    }

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    path += `${cp1x.toFixed(4)} ${cp1y.toFixed(4)} ${cp2x.toFixed(4)} ${cp2y.toFixed(4)} ${p2.x.toFixed(4)} ${p2.y.toFixed(4)} c\n`;
  }

  if (closed) path += 'h\n';

  return path;
}

function contourPointsToPDFPathOps(
  pathPointsInches: Array<{x: number; y: number}>,
  pageHeightInches: number,
  spotColorName: string = 'CutContour'
): string {
  const simplified = simplifyPathForPDF(pathPointsInches, 0.005);
  console.log(`[PDF ${spotColorName}] Simplified ${pathPointsInches.length} points to ${simplified.length} points`);
  console.log(`[PDF ${spotColorName}] Page height: ${pageHeightInches.toFixed(3)}in`);

  if (simplified.length < 2) {
    console.warn(`[PDF ${spotColorName}] Too few points after simplification, skipping`);
    return '';
  }

  let pathOps = 'q\n';
  pathOps += `/${spotColorName} CS 1 SCN\n`;
  pathOps += '0.5 w\n';

  const pts = simplified.map(p => ({ x: p.x * 72, y: p.y * 72 }));
  pathOps += `${pts[0].x.toFixed(4)} ${pts[0].y.toFixed(4)} m\n`;
  for (let i = 1; i < pts.length; i++) {
    pathOps += `${pts[i].x.toFixed(4)} ${pts[i].y.toFixed(4)} l\n`;
  }
  pathOps += 'h\n';
  pathOps += 'S\n';
  pathOps += 'Q\n';

  console.log(`[PDF ${spotColorName}] Generated pathOps: ${pathOps.length} chars, first 200: ${pathOps.substring(0, 200)}`);
  return pathOps;
}

export interface ContourPathResult {
  pathPoints: Array<{ x: number; y: number }>;
  widthInches: number;
  heightInches: number;
  imageOffsetX: number;
  imageOffsetY: number;
  backgroundColor: string;
}

interface Point {
  x: number;
  y: number;
}

function getPolygonSignedAreaInches(path: Array<{ x: number; y: number }>): number {
  let area = 0;
  const n = path.length;
  for (let i = 0; i < n; i++) {
    const curr = path[i];
    const next = path[(i + 1) % n];
    area += (curr.x * next.y) - (next.x * curr.y);
  }
  return area / 2;
}

function expandPathOutwardInches(path: Array<{ x: number; y: number }>, expansionInches: number): Array<{ x: number; y: number }> {
  if (path.length < 3) return path;
  
  // Determine winding direction: positive area = counter-clockwise, negative = clockwise
  // For CCW polygons, the perpendicular normals point INWARD, so we need to negate
  // For CW polygons, the perpendicular normals point OUTWARD, so we keep them
  const signedArea = getPolygonSignedAreaInches(path);
  const windingMultiplier = signedArea >= 0 ? -1 : 1;
  
  const expanded: Array<{ x: number; y: number }> = [];
  const n = path.length;
  
  for (let i = 0; i < n; i++) {
    const prev = path[(i - 1 + n) % n];
    const curr = path[i];
    const next = path[(i + 1) % n];
    
    const e1x = curr.x - prev.x;
    const e1y = curr.y - prev.y;
    const e2x = next.x - curr.x;
    const e2y = next.y - curr.y;
    
    const len1 = Math.sqrt(e1x * e1x + e1y * e1y) || 1;
    const len2 = Math.sqrt(e2x * e2x + e2y * e2y) || 1;
    
    const n1x = -e1y / len1;
    const n1y = e1x / len1;
    const n2x = -e2y / len2;
    const n2y = e2x / len2;
    
    let nx = (n1x + n2x) / 2;
    let ny = (n1y + n2y) / 2;
    const nlen = Math.sqrt(nx * nx + ny * ny) || 1;
    nx /= nlen;
    ny /= nlen;
    
    // Apply winding multiplier to ensure outward expansion
    expanded.push({
      x: curr.x + nx * expansionInches * windingMultiplier,
      y: curr.y + ny * expansionInches * windingMultiplier
    });
  }
  
  return expanded;
}

// Close all gaps for solid bleed fill - uses aggressive gap closing with inch-based paths
function closeGapsForBleedInches(points: Array<{ x: number; y: number }>, maxGapInches: number): Array<{ x: number; y: number }> {
  // Convert to pixel-like format for the gap closing algorithm
  // Use 300 DPI as reference for conversion
  const refDPI = 300;
  const pixelPoints: Array<{ x: number; y: number }> = points.map(p => ({ 
    x: p.x * refDPI, 
    y: p.y * refDPI 
  }));
  const gapThresholdPixels = maxGapInches * refDPI;
  
  // Apply gap closing multiple times with progressively smaller thresholds
  let result = closeGapsWithShapes(pixelPoints, gapThresholdPixels);
  result = closeGapsWithShapes(result, gapThresholdPixels * 0.5);
  result = closeGapsWithShapes(result, gapThresholdPixels * 0.25);
  
  // Convert back to inches
  return result.map(p => ({ x: p.x / refDPI, y: p.y / refDPI }));
}

export function createSilhouetteContour(
  image: HTMLImageElement,
  strokeSettings: StrokeSettings,
  resizeSettings?: ResizeSettings
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const effectiveDPI = resizeSettings 
    ? image.width / resizeSettings.widthInches
    : image.width / 5;
  
  // Base offset keeps cutpath away from design edge - increased significantly to prevent any cutting into design
  const baseOffsetInches = 0.125; // 1/8 inch minimum margin
  const baseOffsetPixels = Math.round(baseOffsetInches * effectiveDPI);
  
  const autoBridgeInches = 0.02;
  const autoBridgePixels = Math.round(autoBridgeInches * effectiveDPI);
  
  let gapClosePixels = 0;
  if (strokeSettings.autoBridging) {
    gapClosePixels = Math.round(strokeSettings.autoBridgingThreshold * effectiveDPI);
  }
  
  const userOffsetPixels = Math.round(strokeSettings.width * effectiveDPI);
  
  const totalOffsetPixels = baseOffsetPixels + userOffsetPixels;
  
  const padding = totalOffsetPixels + 10;
  canvas.width = image.width + (padding * 2);
  canvas.height = image.height + (padding * 2);
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  try {
    const silhouetteMask = createSilhouetteMask(image);
    if (silhouetteMask.length === 0) {
      ctx.drawImage(image, padding, padding);
      return canvas;
    }
    
    let autoBridgedMask = silhouetteMask;
    if (autoBridgePixels > 0) {
      const halfAutoBridge = Math.round(autoBridgePixels / 2);
      const dilatedAuto = dilateSilhouette(silhouetteMask, image.width, image.height, halfAutoBridge);
      const dilatedAutoWidth = image.width + halfAutoBridge * 2;
      const dilatedAutoHeight = image.height + halfAutoBridge * 2;
      const filledAuto = fillSilhouette(dilatedAuto, dilatedAutoWidth, dilatedAutoHeight);
      
      autoBridgedMask = new Uint8Array(image.width * image.height);
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          autoBridgedMask[y * image.width + x] = filledAuto[(y + halfAutoBridge) * dilatedAutoWidth + (x + halfAutoBridge)];
        }
      }
    }
    
    let bridgedMask = autoBridgedMask;
    let bridgedWidth = image.width;
    let bridgedHeight = image.height;
    
    if (gapClosePixels > 0) {
      const halfGapPixels = Math.round(gapClosePixels / 2);
      
      const dilatedMask = dilateSilhouette(autoBridgedMask, image.width, image.height, halfGapPixels);
      const dilatedWidth = image.width + halfGapPixels * 2;
      const dilatedHeight = image.height + halfGapPixels * 2;
      
      const filledDilated = fillSilhouette(dilatedMask, dilatedWidth, dilatedHeight);
      
      bridgedMask = new Uint8Array(image.width * image.height);
      bridgedMask.set(autoBridgedMask);
      
      for (let y = 1; y < image.height - 1; y++) {
        for (let x = 1; x < image.width - 1; x++) {
          if (autoBridgedMask[y * image.width + x] === 0) {
            const srcX = x + halfGapPixels;
            const srcY = y + halfGapPixels;
            if (filledDilated[srcY * dilatedWidth + srcX] === 1) {
              let hasContentTop = false, hasContentBottom = false;
              let hasContentLeft = false, hasContentRight = false;
              
              for (let d = 1; d <= halfGapPixels && !hasContentTop; d++) {
                if (y - d >= 0 && autoBridgedMask[(y - d) * image.width + x] === 1) hasContentTop = true;
              }
              for (let d = 1; d <= halfGapPixels && !hasContentBottom; d++) {
                if (y + d < image.height && autoBridgedMask[(y + d) * image.width + x] === 1) hasContentBottom = true;
              }
              for (let d = 1; d <= halfGapPixels && !hasContentLeft; d++) {
                if (x - d >= 0 && autoBridgedMask[y * image.width + (x - d)] === 1) hasContentLeft = true;
              }
              for (let d = 1; d <= halfGapPixels && !hasContentRight; d++) {
                if (x + d < image.width && autoBridgedMask[y * image.width + (x + d)] === 1) hasContentRight = true;
              }
              
              if ((hasContentTop && hasContentBottom) || (hasContentLeft && hasContentRight)) {
                bridgedMask[y * image.width + x] = 1;
              }
            }
          }
        }
      }
      
      const smoothBridgePixels = Math.round(0.03 * effectiveDPI / 2);
      if (smoothBridgePixels > 0) {
        const distanceMap = new Float32Array(image.width * image.height);
        distanceMap.fill(Infinity);
        
        for (let y = 0; y < image.height; y++) {
          for (let x = 0; x < image.width; x++) {
            if (bridgedMask[y * image.width + x] === 1) {
              distanceMap[y * image.width + x] = 0;
            }
          }
        }
        
        for (let y = 1; y < image.height; y++) {
          for (let x = 1; x < image.width - 1; x++) {
            const idx = y * image.width + x;
            const topLeft = distanceMap[(y - 1) * image.width + (x - 1)] + 1.414;
            const top = distanceMap[(y - 1) * image.width + x] + 1;
            const topRight = distanceMap[(y - 1) * image.width + (x + 1)] + 1.414;
            const left = distanceMap[y * image.width + (x - 1)] + 1;
            distanceMap[idx] = Math.min(distanceMap[idx], topLeft, top, topRight, left);
          }
        }
        
        for (let y = image.height - 2; y >= 0; y--) {
          for (let x = image.width - 2; x >= 1; x--) {
            const idx = y * image.width + x;
            const bottomLeft = distanceMap[(y + 1) * image.width + (x - 1)] + 1.414;
            const bottom = distanceMap[(y + 1) * image.width + x] + 1;
            const bottomRight = distanceMap[(y + 1) * image.width + (x + 1)] + 1.414;
            const right = distanceMap[y * image.width + (x + 1)] + 1;
            distanceMap[idx] = Math.min(distanceMap[idx], bottomLeft, bottom, bottomRight, right);
          }
        }
        
        for (let y = 1; y < image.height - 1; y++) {
          for (let x = 1; x < image.width - 1; x++) {
            const idx = y * image.width + x;
            if (bridgedMask[idx] === 0 && distanceMap[idx] <= smoothBridgePixels) {
              let hasContentTop = false, hasContentBottom = false;
              let hasContentLeft = false, hasContentRight = false;
              
              for (let d = 1; d <= smoothBridgePixels && !hasContentTop; d++) {
                if (y - d >= 0 && bridgedMask[(y - d) * image.width + x] === 1) hasContentTop = true;
              }
              for (let d = 1; d <= smoothBridgePixels && !hasContentBottom; d++) {
                if (y + d < image.height && bridgedMask[(y + d) * image.width + x] === 1) hasContentBottom = true;
              }
              for (let d = 1; d <= smoothBridgePixels && !hasContentLeft; d++) {
                if (x - d >= 0 && bridgedMask[y * image.width + (x - d)] === 1) hasContentLeft = true;
              }
              for (let d = 1; d <= smoothBridgePixels && !hasContentRight; d++) {
                if (x + d < image.width && bridgedMask[y * image.width + (x + d)] === 1) hasContentRight = true;
              }
              
              if ((hasContentTop && hasContentBottom) || (hasContentLeft && hasContentRight)) {
                bridgedMask[idx] = 1;
              }
            }
          }
        }
      }
      
      bridgedWidth = image.width;
      bridgedHeight = image.height;
    }
    
    const baseDilatedMask = dilateSilhouette(bridgedMask, bridgedWidth, bridgedHeight, baseOffsetPixels);
    const baseWidth = bridgedWidth + baseOffsetPixels * 2;
    const baseHeight = bridgedHeight + baseOffsetPixels * 2;
    
    const filledMask = fillSilhouette(baseDilatedMask, baseWidth, baseHeight);
    
    const finalDilatedMask = dilateSilhouette(filledMask, baseWidth, baseHeight, userOffsetPixels);
    const dilatedWidth = baseWidth + userOffsetPixels * 2;
    const dilatedHeight = baseHeight + userOffsetPixels * 2;
    
    const bridgedFinalMask = bridgeTouchingContours(finalDilatedMask, dilatedWidth, dilatedHeight, effectiveDPI);
    
    const boundaryPath = traceBoundary(bridgedFinalMask, dilatedWidth, dilatedHeight);
    
    if (boundaryPath.length < 3) {
      ctx.drawImage(image, padding, padding);
      return canvas;
    }
    
    let smoothedPath = smoothPath(boundaryPath, 2);
    
    // CRITICAL: Fix crossings that occur at sharp corners after offset/dilation
    smoothedPath = fixOffsetCrossings(smoothedPath);
    
    // Apply gap closing using U/N shapes based on settings
    const gapThresholdPixels = strokeSettings.autoBridging 
      ? Math.round(strokeSettings.autoBridgingThreshold * effectiveDPI) 
      : 0;
    
    if (gapThresholdPixels > 0) {
      smoothedPath = closeGapsWithShapes(smoothedPath, gapThresholdPixels);
    }
    
    const offsetX = padding - totalOffsetPixels;
    const offsetY = padding - totalOffsetPixels;
    drawSmoothContour(ctx, smoothedPath, strokeSettings.color || '#FFFFFF', offsetX, offsetY);
    
    ctx.drawImage(image, padding, padding);
    
  } catch (error) {
    console.error('Silhouette contour error:', error);
    ctx.drawImage(image, padding, padding);
  }
  
  return canvas;
}

function fillSilhouette(mask: Uint8Array, width: number, height: number): Uint8Array {
  const filled = new Uint8Array(mask.length);
  filled.set(mask);
  
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];
  
  for (let x = 0; x < width; x++) {
    if (mask[x] === 0) queue.push(x);
    if (mask[(height - 1) * width + x] === 0) queue.push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    if (mask[y * width] === 0) queue.push(y * width);
    if (mask[y * width + width - 1] === 0) queue.push(y * width + width - 1);
  }
  
  for (const idx of queue) {
    visited[idx] = 1;
  }
  
  while (queue.length > 0) {
    const idx = queue.shift()!;
    const x = idx % width;
    const y = Math.floor(idx / width);
    
    const neighbors = [
      { nx: x - 1, ny: y },
      { nx: x + 1, ny: y },
      { nx: x, ny: y - 1 },
      { nx: x, ny: y + 1 }
    ];
    
    for (const { nx, ny } of neighbors) {
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const nidx = ny * width + nx;
        if (!visited[nidx] && mask[nidx] === 0) {
          visited[nidx] = 1;
          queue.push(nidx);
        }
      }
    }
  }
  
  for (let i = 0; i < filled.length; i++) {
    if (filled[i] === 0 && !visited[i]) {
      filled[i] = 1;
    }
  }
  
  return filled;
}

function bridgeTouchingContours(mask: Uint8Array, width: number, height: number, effectiveDPI: number): Uint8Array {
  const result = new Uint8Array(mask.length);
  result.set(mask);
  
  const bridgeThresholdPixels = Math.max(2, Math.round(0.03 * effectiveDPI));
  
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      
      if (mask[idx] === 0) {
        let contentDirections = 0;
        let hasContentTop = false, hasContentBottom = false;
        let hasContentLeft = false, hasContentRight = false;
        
        for (let d = 1; d <= bridgeThresholdPixels; d++) {
          if (!hasContentTop && y - d >= 0 && mask[(y - d) * width + x] === 1) {
            hasContentTop = true;
          }
          if (!hasContentBottom && y + d < height && mask[(y + d) * width + x] === 1) {
            hasContentBottom = true;
          }
          if (!hasContentLeft && x - d >= 0 && mask[y * width + (x - d)] === 1) {
            hasContentLeft = true;
          }
          if (!hasContentRight && x + d < width && mask[y * width + (x + d)] === 1) {
            hasContentRight = true;
          }
        }
        
        let hasContentTopLeft = false, hasContentTopRight = false;
        let hasContentBottomLeft = false, hasContentBottomRight = false;
        
        for (let d = 1; d <= bridgeThresholdPixels; d++) {
          if (!hasContentTopLeft && y - d >= 0 && x - d >= 0 && mask[(y - d) * width + (x - d)] === 1) {
            hasContentTopLeft = true;
          }
          if (!hasContentTopRight && y - d >= 0 && x + d < width && mask[(y - d) * width + (x + d)] === 1) {
            hasContentTopRight = true;
          }
          if (!hasContentBottomLeft && y + d < height && x - d >= 0 && mask[(y + d) * width + (x - d)] === 1) {
            hasContentBottomLeft = true;
          }
          if (!hasContentBottomRight && y + d < height && x + d < width && mask[(y + d) * width + (x + d)] === 1) {
            hasContentBottomRight = true;
          }
        }
        
        if (hasContentTop) contentDirections++;
        if (hasContentBottom) contentDirections++;
        if (hasContentLeft) contentDirections++;
        if (hasContentRight) contentDirections++;
        
        const hasOpposingSides = (hasContentTop && hasContentBottom) || (hasContentLeft && hasContentRight);
        const hasDiagonalTouch = (hasContentTopLeft && hasContentBottomRight) || 
                                  (hasContentTopRight && hasContentBottomLeft);
        const isCorner = contentDirections >= 3;
        
        if (hasOpposingSides || isCorner || hasDiagonalTouch) {
          result[idx] = 1;
        }
      }
    }
  }
  
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];
  
  for (let x = 0; x < width; x++) {
    if (result[x] === 0 && !visited[x]) {
      queue.push(x);
      visited[x] = 1;
    }
    const bottomIdx = (height - 1) * width + x;
    if (result[bottomIdx] === 0 && !visited[bottomIdx]) {
      queue.push(bottomIdx);
      visited[bottomIdx] = 1;
    }
  }
  for (let y = 0; y < height; y++) {
    const leftIdx = y * width;
    if (result[leftIdx] === 0 && !visited[leftIdx]) {
      queue.push(leftIdx);
      visited[leftIdx] = 1;
    }
    const rightIdx = y * width + width - 1;
    if (result[rightIdx] === 0 && !visited[rightIdx]) {
      queue.push(rightIdx);
      visited[rightIdx] = 1;
    }
  }
  
  while (queue.length > 0) {
    const idx = queue.shift()!;
    const x = idx % width;
    const y = Math.floor(idx / width);
    
    const neighbors = [
      { nx: x - 1, ny: y },
      { nx: x + 1, ny: y },
      { nx: x, ny: y - 1 },
      { nx: x, ny: y + 1 }
    ];
    
    for (const { nx, ny } of neighbors) {
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const nidx = ny * width + nx;
        if (!visited[nidx] && result[nidx] === 0) {
          visited[nidx] = 1;
          queue.push(nidx);
        }
      }
    }
  }
  
  for (let i = 0; i < result.length; i++) {
    if (result[i] === 0 && !visited[i]) {
      result[i] = 1;
    }
  }
  
  return result;
}

function createSilhouetteMask(image: HTMLImageElement): Uint8Array {
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) return new Uint8Array(0);

  tempCanvas.width = image.width;
  tempCanvas.height = image.height;
  
  tempCtx.drawImage(image, 0, 0);
  const imageData = tempCtx.getImageData(0, 0, image.width, image.height);
  const data = imageData.data;
  
  const mask = new Uint8Array(image.width * image.height);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = data[i * 4 + 3] > 10 ? 1 : 0;
  }
  
  return mask;
}

function dilateSilhouette(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const newWidth = width + radius * 2;
  const newHeight = height + radius * 2;
  const result = new Uint8Array(newWidth * newHeight);
  
  if (radius <= 0) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        result[y * newWidth + x] = mask[y * width + x];
      }
    }
    return result;
  }
  
  // Optimized circular dilation with precomputed offsets
  const radiusSq = radius * radius;
  
  // Precompute circle offsets once
  const offsets: number[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radiusSq) {
        offsets.push(dy * newWidth + dx);
      }
    }
  }
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 1) {
        const centerIdx = (y + radius) * newWidth + (x + radius);
        for (let i = 0; i < offsets.length; i++) {
          result[centerIdx + offsets[i]] = 1;
        }
      }
    }
  }
  
  return result;
}

function traceBoundary(mask: Uint8Array, width: number, height: number): Point[] {
  // MATCHES WORKER EXACTLY - Simple boundary tracing
  let startX = -1, startY = -1;
  outer: for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 1) {
        startX = x;
        startY = y;
        break outer;
      }
    }
  }
  
  if (startX === -1) return [];
  
  const path: Point[] = [];
  const directions = [
    { dx: 1, dy: 0 },
    { dx: 1, dy: 1 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 1 },
    { dx: -1, dy: 0 },
    { dx: -1, dy: -1 },
    { dx: 0, dy: -1 },
    { dx: 1, dy: -1 }
  ];
  
  let x = startX, y = startY;
  let dir = 0;
  const maxSteps = width * height * 2;
  let steps = 0;
  
  do {
    path.push({ x, y });
    
    let found = false;
    for (let i = 0; i < 8; i++) {
      const checkDir = (dir + 6 + i) % 8;
      const nx = x + directions[checkDir].dx;
      const ny = y + directions[checkDir].dy;
      
      if (nx >= 0 && nx < width && ny >= 0 && ny < height && mask[ny * width + nx] === 1) {
        x = nx;
        y = ny;
        dir = checkDir;
        found = true;
        break;
      }
    }
    
    if (!found) break;
    steps++;
  } while ((x !== startX || y !== startY) && steps < maxSteps);
  
  return path;
}

function smoothPath(points: Point[], windowSize: number): Point[] {
  // MATCHES WORKER EXACTLY - simple moving average smoothing
  if (points.length < windowSize * 2 + 1) return points;
  
  const result: Point[] = [];
  const n = points.length;
  
  for (let i = 0; i < n; i++) {
    let sumX = 0, sumY = 0;
    for (let j = -windowSize; j <= windowSize; j++) {
      const idx = (i + j + n) % n;
      sumX += points[idx].x;
      sumY += points[idx].y;
    }
    result.push({
      x: sumX / (windowSize * 2 + 1),
      y: sumY / (windowSize * 2 + 1)
    });
  }
  
  return result;
}

// Generate U-shaped merge path (for outward curves)
function generateUShapeMerge(start: Point, end: Point, depth: number): Point[] {
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return [start, end];
  
  const perpX = -dy / len;
  const perpY = dx / len;
  
  const quarterX = (start.x + midX) / 2;
  const quarterY = (start.y + midY) / 2;
  const threeQuarterX = (midX + end.x) / 2;
  const threeQuarterY = (midY + end.y) / 2;
  
  return [
    start,
    { x: quarterX + perpX * depth * 0.5, y: quarterY + perpY * depth * 0.5 },
    { x: midX + perpX * depth, y: midY + perpY * depth },
    { x: threeQuarterX + perpX * depth * 0.5, y: threeQuarterY + perpY * depth * 0.5 },
    end
  ];
}

// Generate N-shaped merge path (for inward/concave transitions)
function generateNShapeMerge(start: Point, end: Point, depth: number): Point[] {
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return [start, end];
  
  const perpX = dy / len;
  const perpY = -dx / len;
  
  const quarterX = (start.x + midX) / 2;
  const quarterY = (start.y + midY) / 2;
  const threeQuarterX = (midX + end.x) / 2;
  const threeQuarterY = (midY + end.y) / 2;
  
  return [
    start,
    { x: quarterX + perpX * depth * 0.3, y: quarterY + perpY * depth * 0.3 },
    { x: midX + perpX * depth * 0.5, y: midY + perpY * depth * 0.5 },
    { x: threeQuarterX + perpX * depth * 0.3, y: threeQuarterY + perpY * depth * 0.3 },
    end
  ];
}

// Apply merge curves at ALL direction changes
function applyMergeCurves(points: Point[]): Point[] {
  if (points.length < 6) return points;
  
  const result: Point[] = [];
  const n = points.length;
  
  let i = 0;
  while (i < n) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    
    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    
    const len1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const len2 = Math.sqrt(v2x * v2x + v2y * v2y);
    
    if (len1 > 0.5 && len2 > 0.5) {
      const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
      const cross = v1x * v2y - v1y * v2x;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
      
      // Apply to ANY direction change (more than 15 degrees)
      if (angle > Math.PI / 12) {
        const sharpness = angle / Math.PI;
        const baseDepth = Math.min(len1, len2) * 0.4;
        const depth = Math.max(1, baseDepth * (0.3 + sharpness * 0.7));
        
        if (cross < 0) {
          // Concave turn (inward) - use N shape
          const mergePoints = generateNShapeMerge(prev, next, depth);
          for (let m = 1; m < mergePoints.length - 1; m++) {
            result.push(mergePoints[m]);
          }
          i++;
          continue;
        } else if (cross > 0) {
          // Convex turn (outward) - use U shape
          const mergePoints = generateUShapeMerge(prev, next, depth);
          for (let m = 1; m < mergePoints.length - 1; m++) {
            result.push(mergePoints[m]);
          }
          i++;
          continue;
        }
      }
    }
    
    result.push(curr);
    i++;
  }
  
  return result.length >= 3 ? result : points;
}

// Remove points that overshoot or stick out beyond the smooth path
function removeOvershootingPoints(points: Point[]): Point[] {
  if (points.length < 5) return points;
  
  // First pass: detect and unite crossing junctions
  let result = uniteJunctions(points);
  
  // Second pass: remove remaining spikes
  result = removeSpikesFromPath(result);
  
  return result.length >= 3 ? result : points;
}

// Detect where path segments cross or nearly touch and unite them
function uniteJunctions(points: Point[]): Point[] {
  if (points.length < 8) return points;
  
  // First pass: detect sharp turns that need U/N merge shapes
  let result = detectAndMergeSharpTurns(points);
  
  // Second pass: detect close proximity junctions
  result = detectProximityJunctions(result);
  
  return result;
}

// Detect sharp turns (>45 degrees) and apply U/N merge shapes
function detectAndMergeSharpTurns(points: Point[]): Point[] {
  if (points.length < 6) return points;
  
  const result: Point[] = [];
  const n = points.length;
  
  let i = 0;
  while (i < n) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    
    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    
    const len1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const len2 = Math.sqrt(v2x * v2x + v2y * v2y);
    
    if (len1 > 0.1 && len2 > 0.1) {
      const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
      const cross = v1x * v2y - v1y * v2x;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
      
      // Sharp turn detected (more than 45 degrees) - ALWAYS apply merge
      if (angle > Math.PI / 4) {
        const sharpness = angle / Math.PI;
        // Use larger depth for sharper turns to ensure proper merge
        const depth = Math.max(3, Math.min(len1, len2) * sharpness * 0.6);
        
        if (cross < 0) {
          // Concave (inward) - N shape merge
          const midX = (curr.x + next.x) / 2;
          const midY = (curr.y + next.y) / 2;
          const perpX = (next.y - curr.y) / len2;
          const perpY = -(next.x - curr.x) / len2;
          
          result.push({ x: midX + perpX * depth * 0.4, y: midY + perpY * depth * 0.4 });
          i++;
          continue;
        } else {
          // Convex (outward) - U shape merge
          const midX = (curr.x + next.x) / 2;
          const midY = (curr.y + next.y) / 2;
          const perpX = -(next.y - curr.y) / len2;
          const perpY = (next.x - curr.x) / len2;
          
          result.push({ x: midX + perpX * depth * 0.4, y: midY + perpY * depth * 0.4 });
          i++;
          continue;
        }
      }
    }
    
    result.push(curr);
    i++;
  }
  
  return result.length >= 3 ? result : points;
}

// Detect points that are close in space but far in path order
function detectProximityJunctions(points: Point[]): Point[] {
  if (points.length < 8) return points;
  
  const n = points.length;
  const result: Point[] = [];
  const skipIndices = new Set<number>();
  
  for (let i = 0; i < n; i++) {
    if (skipIndices.has(i)) continue;
    
    const pi = points[i];
    let foundJunction = false;
    
    // Increased search range and decreased distance threshold for tighter detection
    for (let j = i + 4; j < Math.min(i + 60, n); j++) {
      const pathDist = j - i;
      if (pathDist < 4) continue;
      
      const pj = points[j];
      const dist = Math.sqrt((pi.x - pj.x) ** 2 + (pi.y - pj.y) ** 2);
      
      // Much tighter detection - within 12 pixels now
      if (dist < 12) {
        // Skip all points in the loop
        for (let k = i + 1; k < j; k++) {
          skipIndices.add(k);
        }
        
        // Create smooth merge at junction center
        const mergePoint = { x: (pi.x + pj.x) / 2, y: (pi.y + pj.y) / 2 };
        result.push(mergePoint);
        foundJunction = true;
        break;
      }
    }
    
    if (!foundJunction) {
      result.push(pi);
    }
  }
  
  return result;
}

// Remove individual spike points
function removeSpikesFromPath(points: Point[]): Point[] {
  if (points.length < 5) return points;
  
  const result: Point[] = [];
  const n = points.length;
  
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    
    const lineX = next.x - prev.x;
    const lineY = next.y - prev.y;
    const lineLen = Math.sqrt(lineX * lineX + lineY * lineY);
    
    if (lineLen > 0) {
      const toPointX = curr.x - prev.x;
      const toPointY = curr.y - prev.y;
      const cross = Math.abs(lineX * toPointY - lineY * toPointX) / lineLen;
      
      // Skip if point sticks out too far
      if (cross > 12) {
        continue;
      }
    }
    
    result.push(curr);
  }
  
  return result;
}

// Fix crossings that occur in offset contours at sharp corners
// Uses Clipper.js for robust loop removal
function fixOffsetCrossings(points: Point[]): Point[] {
  if (points.length < 6) return points;
  
  console.log('[fixOffsetCrossings] BEFORE cleanup - checking for intersections');
  const beforeCheck = detectSelfIntersections(points);
  
  // Use Clipper.js to remove all self-intersections and loops
  let result = removeLoopsWithClipper(points);
  
  // Ensure consistent winding direction (clockwise for cutting)
  result = ensureClockwise(result);
  
  // Additional cleanup pass with legacy method for any remaining issues
  result = mergeClosePathPoints(result);
  
  console.log('[fixOffsetCrossings] AFTER cleanup - checking for intersections');
  const afterCheck = detectSelfIntersections(result);
  
  if (afterCheck.hasLoops) {
    console.warn('[fixOffsetCrossings] WARNING: Still has', afterCheck.intersections.length, 'self-intersections after cleanup!');
  } else {
    console.log('[fixOffsetCrossings] SUCCESS: No self-intersections remaining');
  }
  
  return result;
}

// Detect where lines actually cross and fix them
function detectAndFixLineCrossings(points: Point[]): Point[] {
  if (points.length < 6) return points;
  
  const n = points.length;
  const result: Point[] = [];
  const skipUntil = new Map<number, number>();
  
  // OPTIMIZATION: Use stride for large paths
  const stride = n > 1000 ? 3 : 1;
  
  for (let i = 0; i < n; i += stride) {
    // Check if we should skip this point
    let shouldSkip = false;
    const entries = Array.from(skipUntil.entries());
    for (let e = 0; e < entries.length; e++) {
      const [start, end] = entries[e];
      if (i > start && i < end) {
        shouldSkip = true;
        break;
      }
    }
    if (shouldSkip) continue;
    
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    
    // OPTIMIZATION: Limit search range to nearby segments
    const maxSearch = Math.min(n - 1, i + 300);
    for (let j = i + 3; j < maxSearch; j += stride) {
      const p3 = points[j];
      const p4 = points[(j + 1) % n];
      
      const intersection = lineSegmentIntersect(p1, p2, p3, p4);
      if (intersection) {
        // Found a crossing - skip the loop between them and add merge point
        skipUntil.set(i, j);
        result.push(intersection);
        break;
      }
    }
    
    if (!skipUntil.has(i)) {
      result.push(p1);
    }
  }
  
  return result.length >= 3 ? result : points;
}

// Check if two line segments intersect
function lineSegmentIntersect(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 0.0001) return null; // Parallel
  
  const dx = p3.x - p1.x;
  const dy = p3.y - p1.y;
  
  const t = (dx * d2y - dy * d2x) / cross;
  const u = (dx * d1y - dy * d1x) / cross;
  
  // Check if intersection is within both segments
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return {
      x: p1.x + t * d1x,
      y: p1.y + t * d1y
    };
  }
  
  return null;
}

// Close gaps by detecting where paths are close and applying U/N shapes
function closeGapsWithShapes(points: Point[], gapThreshold: number): Point[] {
  if (points.length < 20) return points;
  
  const n = points.length;
  const result: Point[] = [];
  const processed = new Set<number>();
  
  // OPTIMIZATION: Use larger stride for faster processing
  const stride = n > 2000 ? 8 : n > 1000 ? 5 : n > 500 ? 3 : 2;
  
  // Calculate centroid using sampled points for speed
  let centroidX = 0, centroidY = 0;
  let sampleCount = 0;
  for (let i = 0; i < n; i += stride) {
    centroidX += points[i].x;
    centroidY += points[i].y;
    sampleCount++;
  }
  centroidX /= sampleCount;
  centroidY /= sampleCount;
  
  // Calculate average distance from centroid using sampled points
  let totalDist = 0;
  for (let i = 0; i < n; i += stride) {
    totalDist += Math.sqrt((points[i].x - centroidX) ** 2 + (points[i].y - centroidY) ** 2);
  }
  const avgDistFromCentroid = totalDist / sampleCount;
  
  // Find all gap locations where path points are within threshold but far apart in path order
  const gaps: Array<{i: number, j: number, dist: number}> = [];
  
  // Limit how much of path we can skip to avoid deleting entire outline
  const maxSkipPoints = Math.floor(n * 0.20); // Max 20% of path per gap (reduced from 25%)
  const minSkipPoints = Math.max(15, Math.floor(n / 50)); // Scale minimum with path size
  
  const thresholdSq = gapThreshold * gapThreshold;
  
  // OPTIMIZATION: Limit max gaps to prevent excessive processing
  const maxGaps = 20;
  
  for (let i = 0; i < n && gaps.length < maxGaps; i += stride) {
    const pi = points[i];
    
    // Search ahead but limit to maxSkipPoints to avoid false gaps
    const maxSearch = Math.min(n - 5, i + maxSkipPoints);
    // Use larger inner stride for faster search
    const innerStride = stride * 2;
    for (let j = i + minSkipPoints; j < maxSearch; j += innerStride) {
      const pj = points[j];
      const distSq = (pi.x - pj.x) ** 2 + (pi.y - pj.y) ** 2;
      
      if (distSq < thresholdSq) {
        // Quick check if this is a narrow passage (close) vs a protrusion (keep)
        const dist = Math.sqrt(distSq);
        const dx = pj.x - pi.x;
        const dy = pj.y - pi.y;
        const lineLen = dist;
        
        // Sample only ~10 points for speed
        let maxPerpDist = 0;
        const sampleStride = Math.max(1, Math.floor((j - i) / 10));
        for (let k = i + sampleStride; k < j; k += sampleStride) {
          const pk = points[k];
          const perpDist = Math.abs((pk.x - pi.x) * dy - (pk.y - pi.y) * dx) / (lineLen || 1);
          maxPerpDist = Math.max(maxPerpDist, perpDist);
        }
        
        // If path extends more than 3x the gap distance, it's a protrusion - don't close
        if (maxPerpDist > dist * 3) {
          continue;
        }
        
        gaps.push({i, j, dist});
        break;
      }
    }
  }
  
  console.log('[closeGapsWithShapes] Scanned', n, 'points, stride:', stride, ', threshold:', gapThreshold.toFixed(0), 'px, gaps:', gaps.length);
  
  if (gaps.length === 0) {
    console.log('[closeGapsWithShapes] No gaps found');
    return points;
  }
  
  console.log('[closeGapsWithShapes] Found', gaps.length, 'potential gaps');
  
  // Classify gaps into two categories:
  // 1. Inward gaps (original detection) - these point toward the centroid and get priority
  // 2. Geometry gaps (new detection) - J-shaped, hooks, etc. that don't point inward
  const inwardGaps: Array<{i: number, j: number, dist: number, priority: number}> = [];
  const geometryGaps: Array<{i: number, j: number, dist: number, priority: number}> = [];
  
  for (const gap of gaps) {
    // Calculate average distance of the gap section from centroid
    let gapSectionDist = 0;
    let gapSectionCount = 0;
    const sampleStride = Math.max(1, Math.floor((gap.j - gap.i) / 10));
    for (let k = gap.i; k <= gap.j; k += sampleStride) {
      const pk = points[k];
      gapSectionDist += Math.sqrt((pk.x - centroidX) ** 2 + (pk.y - centroidY) ** 2);
      gapSectionCount++;
    }
    const avgGapDist = gapSectionDist / gapSectionCount;
    
    // Inward gap: section average is LESS than shape average (dips toward center)
    if (avgGapDist < avgDistFromCentroid * 0.95) {
      inwardGaps.push({...gap, priority: 1}); // High priority
      console.log('[closeGapsWithShapes] Inward gap at', gap.i, '-', gap.j);
    } else {
      geometryGaps.push({...gap, priority: 2}); // Lower priority
      console.log('[closeGapsWithShapes] Geometry gap at', gap.i, '-', gap.j);
    }
  }
  
  // Filter geometry gaps to exclude any that overlap with inward gaps
  // This ensures inward detection behavior stays exactly as before
  const nonOverlappingGeometryGaps = geometryGaps.filter(geoGap => {
    for (const inwardGap of inwardGaps) {
      // Check if ranges overlap: geoGap[i,j] overlaps with inwardGap[i,j]
      const overlapStart = Math.max(geoGap.i, inwardGap.i);
      const overlapEnd = Math.min(geoGap.j, inwardGap.j);
      if (overlapStart < overlapEnd) {
        return false; // Overlaps with an inward gap, exclude it
      }
    }
    return true; // No overlap, keep it
  });
  
  // Combine: inward gaps (original behavior) + non-overlapping geometry gaps
  const exteriorGaps = [...inwardGaps, ...nonOverlappingGeometryGaps];
  
  console.log('[closeGapsWithShapes] Inward gaps:', inwardGaps.length, 'Non-overlapping geometry gaps:', nonOverlappingGeometryGaps.length);
  
  if (exteriorGaps.length === 0) {
    console.log('[closeGapsWithShapes] No gaps to close');
    return points;
  }
  
  // For each gap, find the NARROWEST point (peak-to-peak) and bridge there
  // This preserves both sides of the gap instead of cutting one off
  
  // Sort gaps by path position
  const sortedGaps = [...exteriorGaps].sort((a, b) => a.i - b.i);
  
  // Find the actual narrowest point for each gap
  const refinedGaps: Array<{i: number, j: number, dist: number}> = [];
  for (const gap of sortedGaps) {
    let minDist = gap.dist;
    let bestI = gap.i;
    let bestJ = gap.j;
    
    // Search around the initial gap points to find the true narrowest crossing
    const searchRange = Math.min(20, Math.floor((gap.j - gap.i) / 4));
    for (let di = -searchRange; di <= searchRange; di++) {
      const testI = gap.i + di;
      if (testI < 0 || testI >= n) continue;
      
      for (let dj = -searchRange; dj <= searchRange; dj++) {
        const testJ = gap.j + dj;
        if (testJ < 0 || testJ >= n || testJ <= testI + 10) continue;
        
        const pi = points[testI];
        const pj = points[testJ];
        const dist = Math.sqrt((pi.x - pj.x) ** 2 + (pi.y - pj.y) ** 2);
        
        if (dist < minDist) {
          minDist = dist;
          bestI = testI;
          bestJ = testJ;
        }
      }
    }
    
    refinedGaps.push({i: bestI, j: bestJ, dist: minDist});
  }
  
  // Process path, bridging at the narrowest point of each gap
  let currentIdx = 0;
  
  for (const gap of refinedGaps) {
    // Skip overlapping gaps
    if (gap.i < currentIdx) continue;
    
    // Add points before the gap bridge point
    for (let k = currentIdx; k <= gap.i; k++) {
      if (!processed.has(k)) {
        result.push(points[k]);
        processed.add(k);
      }
    }
    
    // Create a minimal bridge at the narrowest point
    const p1 = points[gap.i];
    const p2 = points[gap.j];
    const gapDist = gap.dist;
    
    if (gapDist > 0.5) {
      // Add just 3 points for a small smooth bridge (minimal distortion)
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      result.push({ x: midX, y: midY });
    }
    
    // For exterior caves (already filtered above), ALWAYS delete the cave interior
    // Skip all points between i and j (the "top of the P" / cave interior)
    for (let k = gap.i + 1; k < gap.j; k++) {
      processed.add(k);
    }
    
    currentIdx = gap.j;
  }
  
  // Add remaining points
  for (let k = currentIdx; k < n; k++) {
    if (!processed.has(k)) {
      result.push(points[k]);
    }
  }
  
  // Apply smoothing pass to eliminate wave artifacts from gap closing
  // This is especially important for medium/small offsets
  if (result.length >= 10 && refinedGaps.length > 0) {
    return smoothBridgeAreas(result);
  }
  
  return result.length >= 3 ? result : points;
}

// Smooth the path to eliminate wave artifacts, especially around bridge areas
function smoothBridgeAreas(points: Point[]): Point[] {
  if (points.length < 10) return points;
  
  const n = points.length;
  const result: Point[] = [];
  
  // Apply 3-point weighted average smoothing (preserves shape while reducing waves)
  for (let i = 0; i < n; i++) {
    if (i === 0 || i === n - 1) {
      result.push(points[i]);
    } else {
      const prev = points[i - 1];
      const curr = points[i];
      const next = points[i + 1];
      
      // Check if this point creates a sharp angle (wave artifact)
      const dx1 = curr.x - prev.x;
      const dy1 = curr.y - prev.y;
      const dx2 = next.x - curr.x;
      const dy2 = next.y - curr.y;
      
      const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
      const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
      
      if (len1 > 0.1 && len2 > 0.1) {
        // Calculate angle between segments
        const dot = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
        
        // If sharp angle (less than ~120 degrees), smooth it
        if (dot < 0.5) {
          // Weighted average toward neighbors (flatten the wave)
          result.push({
            x: prev.x * 0.25 + curr.x * 0.5 + next.x * 0.25,
            y: prev.y * 0.25 + curr.y * 0.5 + next.y * 0.25
          });
        } else {
          result.push(curr);
        }
      } else {
        result.push(curr);
      }
    }
  }
  
  return result;
}

// Merge points that are very close together (indicating a near-crossing)
function mergeClosePathPoints(points: Point[]): Point[] {
  if (points.length < 6) return points;
  
  const n = points.length;
  const result: Point[] = [];
  const skipIndices = new Set<number>();
  
  // OPTIMIZATION: Use stride for large paths
  const stride = n > 1000 ? 3 : 1;
  
  for (let i = 0; i < n; i += stride) {
    if (skipIndices.has(i)) continue;
    
    const pi = points[i];
    
    // OPTIMIZATION: Limit search range
    const maxSearch = Math.min(n, i + 300);
    for (let j = i + 10; j < maxSearch; j += stride) {
      if (skipIndices.has(j)) continue;
      
      const pj = points[j];
      const distSq = (pi.x - pj.x) ** 2 + (pi.y - pj.y) ** 2;
      
      // Increased threshold to catch all near-crossings (10px = 100 squared)
      if (distSq < 100) {
        // Skip all points between i and j
        for (let k = i + 1; k < j; k++) {
          skipIndices.add(k);
        }
        // Add merge point
        result.push({ x: (pi.x + pj.x) / 2, y: (pi.y + pj.y) / 2 });
        skipIndices.add(j);
        break;
      }
    }
    
    if (!skipIndices.has(i)) {
      result.push(pi);
    }
  }
  
  return result.length >= 3 ? result : points;
}

function removeSpikes(points: Point[], neighborDistance: number, threshold: number): Point[] {
  if (points.length < neighborDistance * 2 + 3) return points;
  
  const result: Point[] = [];
  const isSpike = new Array(points.length).fill(false);
  
  for (let i = 0; i < points.length; i++) {
    const prevIdx = (i - neighborDistance + points.length) % points.length;
    const nextIdx = (i + neighborDistance) % points.length;
    
    const prev = points[prevIdx];
    const curr = points[i];
    const next = points[nextIdx];
    
    const expectedX = (prev.x + next.x) / 2;
    const expectedY = (prev.y + next.y) / 2;
    
    const deviation = Math.sqrt((curr.x - expectedX) ** 2 + (curr.y - expectedY) ** 2);
    
    const spanDistance = Math.sqrt((next.x - prev.x) ** 2 + (next.y - prev.y) ** 2);
    
    if (spanDistance > 0 && deviation / spanDistance > threshold) {
      const v1x = curr.x - prev.x;
      const v1y = curr.y - prev.y;
      const v2x = next.x - curr.x;
      const v2y = next.y - curr.y;
      
      const dot = v1x * v2x + v1y * v2y;
      const mag1 = Math.sqrt(v1x * v1x + v1y * v1y);
      const mag2 = Math.sqrt(v2x * v2x + v2y * v2y);
      
      if (mag1 > 0 && mag2 > 0) {
        const cosAngle = dot / (mag1 * mag2);
        if (cosAngle < 0.3) {
          isSpike[i] = true;
        }
      }
    }
  }
  
  for (let i = 0; i < points.length; i++) {
    if (isSpike[i]) {
      let prevGood = i - 1;
      while (prevGood >= 0 && isSpike[(prevGood + points.length) % points.length]) {
        prevGood--;
      }
      let nextGood = i + 1;
      while (nextGood < points.length * 2 && isSpike[nextGood % points.length]) {
        nextGood++;
      }
      
      const prev = points[(prevGood + points.length) % points.length];
      const next = points[nextGood % points.length];
      
      const t = 0.5;
      result.push({
        x: prev.x + (next.x - prev.x) * t,
        y: prev.y + (next.y - prev.y) * t
      });
    } else {
      result.push(points[i]);
    }
  }
  
  return result;
}

function douglasPeucker(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;
  
  let maxDist = 0;
  let maxIndex = 0;
  
  const first = points[0];
  const last = points[points.length - 1];
  
  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(points[i], first, last);
    if (dist > maxDist) {
      maxDist = dist;
      maxIndex = i;
    }
  }
  
  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, maxIndex + 1), epsilon);
    const right = douglasPeucker(points.slice(maxIndex), epsilon);
    return left.slice(0, -1).concat(right);
  } else {
    return [first, last];
  }
}

function drawSmoothContour(ctx: CanvasRenderingContext2D, contour: Point[], color: string, offsetX: number, offsetY: number): void {
  if (contour.length < 3) return;

  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
  ctx.shadowBlur = 2;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 1;

  ctx.beginPath();
  
  const start = contour[0];
  ctx.moveTo(start.x + offsetX, start.y + offsetY);
  
  // Use simple lineTo to prevent bezier curves from reintroducing crossings
  for (let i = 1; i < contour.length; i++) {
    const p = contour[i];
    ctx.lineTo(p.x + offsetX, p.y + offsetY);
  }
  
  ctx.closePath();
  ctx.stroke();
  
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
}

export function getContourPath(
  image: HTMLImageElement,
  strokeSettings: StrokeSettings,
  resizeSettings: ResizeSettings
): ContourPathResult | null {
  console.log('[getContourPath] Starting - optimized with downscaling');
  
  // OPTIMIZATION: Downscale large images for faster path computation
  // Use 1200px max to balance speed and accuracy for die-cutting
  // At 1200px for a 4" sticker = 300 DPI effective resolution, sufficient for cut accuracy
  const maxProcessingPixels = 1200;
  const longestSide = Math.max(image.width, image.height);
  const scale = longestSide > maxProcessingPixels ? maxProcessingPixels / longestSide : 1;
  
  const processWidth = Math.round(image.width * scale);
  const processHeight = Math.round(image.height * scale);
  
  // Adjusted DPI for scaled image - maintains inch-based accuracy
  const scaledWidthInches = resizeSettings.widthInches;
  const effectiveDPI = processWidth / scaledWidthInches;
  
  console.log('[getContourPath] Scale:', scale.toFixed(2), 'processSize:', processWidth, 'x', processHeight, 'effectiveDPI:', effectiveDPI.toFixed(0));
  
  // Base offset keeps cutpath away from design edge - increased significantly to prevent any cutting into design
  const baseOffsetInches = 0.125; // 1/8 inch minimum margin
  const baseOffsetPixels = Math.round(baseOffsetInches * effectiveDPI);
  
  const autoBridgeInches = 0.02;
  const autoBridgePixels = Math.round(autoBridgeInches * effectiveDPI);
  
  const userOffsetPixels = Math.round(strokeSettings.width * effectiveDPI);
  const totalOffsetPixels = baseOffsetPixels + userOffsetPixels;
  
  try {
    // Create scaled canvas for faster processing
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');
    if (!tempCtx) return null;
    
    tempCanvas.width = processWidth;
    tempCanvas.height = processHeight;
    // Use high-quality interpolation for downscaling to preserve edge detail
    tempCtx.imageSmoothingEnabled = true;
    tempCtx.imageSmoothingQuality = 'high';
    tempCtx.drawImage(image, 0, 0, processWidth, processHeight);
    const imageData = tempCtx.getImageData(0, 0, processWidth, processHeight);
    const data = imageData.data;
    
    // Create silhouette mask with alpha threshold (matches worker)
    const silhouetteMask = new Uint8Array(processWidth * processHeight);
    const threshold = strokeSettings.alphaThreshold || 10;
    for (let i = 0; i < silhouetteMask.length; i++) {
      silhouetteMask[i] = data[i * 4 + 3] >= threshold ? 1 : 0;
    }
    
    if (silhouetteMask.length === 0) return null;
    
    // Auto bridge step (matches worker) - uses processWidth/Height for speed
    let autoBridgedMask = silhouetteMask;
    if (autoBridgePixels > 0) {
      const halfAutoBridge = Math.round(autoBridgePixels / 2);
      const dilatedAuto = dilateSilhouette(silhouetteMask, processWidth, processHeight, halfAutoBridge);
      const dilatedAutoWidth = processWidth + halfAutoBridge * 2;
      const dilatedAutoHeight = processHeight + halfAutoBridge * 2;
      const filledAuto = fillSilhouette(dilatedAuto, dilatedAutoWidth, dilatedAutoHeight);
      
      autoBridgedMask = new Uint8Array(processWidth * processHeight);
      for (let y = 0; y < processHeight; y++) {
        for (let x = 0; x < processWidth; x++) {
          autoBridgedMask[y * processWidth + x] = filledAuto[(y + halfAutoBridge) * dilatedAutoWidth + (x + halfAutoBridge)];
        }
      }
    }
    
    // Base dilation (matches worker - NO gap closing through mask dilation)
    const baseDilatedMask = dilateSilhouette(autoBridgedMask, processWidth, processHeight, baseOffsetPixels);
    const baseWidth = processWidth + baseOffsetPixels * 2;
    const baseHeight = processHeight + baseOffsetPixels * 2;
    
    // Fill silhouette (matches worker)
    const filledMask = fillSilhouette(baseDilatedMask, baseWidth, baseHeight);
    
    const finalDilatedMask = dilateSilhouette(filledMask, baseWidth, baseHeight, userOffsetPixels);
    const dilatedWidth = baseWidth + userOffsetPixels * 2;
    const dilatedHeight = baseHeight + userOffsetPixels * 2;
    const boundaryPath = traceBoundary(finalDilatedMask, dilatedWidth, dilatedHeight);
    
    if (boundaryPath.length < 3) return null;
    
    // Smooth path (matches worker)
    let smoothedPath = smoothPath(boundaryPath, 2);
    console.log('[getContourPath] After smooth, path points:', smoothedPath.length);
    
    // Fix crossings (matches worker)
    smoothedPath = fixOffsetCrossings(smoothedPath);
    console.log('[getContourPath] After fixOffsetCrossings, path points:', smoothedPath.length);
    
    // OPTIMIZATION: Simplify path BEFORE gap closing to reduce point count
    // This dramatically speeds up gap detection
    if (smoothedPath.length > 500) {
      const targetPoints = 400;
      const step = smoothedPath.length / targetPoints;
      const simplified: Point[] = [];
      for (let i = 0; i < targetPoints; i++) {
        simplified.push(smoothedPath[Math.floor(i * step)]);
      }
      smoothedPath = simplified;
      console.log('[getContourPath] Simplified path to', smoothedPath.length, 'points for gap closing');
    }
    
    // Apply gap closing using U/N shapes based on settings (matches worker)
    const gapThresholdPixels = strokeSettings.autoBridging 
      ? Math.round(strokeSettings.autoBridgingThreshold * effectiveDPI) 
      : 0;
    
    if (gapThresholdPixels > 0) {
      console.log('[getContourPath] Starting gap closing with threshold:', gapThresholdPixels);
      const startTime = performance.now();
      smoothedPath = closeGapsWithShapes(smoothedPath, gapThresholdPixels);
      console.log('[getContourPath] Gap closing took:', (performance.now() - startTime).toFixed(0), 'ms');
      
      // Ensure path is properly closed after gap processing
      if (smoothedPath.length > 2) {
        const first = smoothedPath[0];
        const last = smoothedPath[smoothedPath.length - 1];
        const closeDist = Math.sqrt((first.x - last.x) ** 2 + (first.y - last.y) ** 2);
        if (closeDist > 2) {
          smoothedPath.push({ x: first.x, y: first.y });
        }
      }
    }
    
    // Add bleed to dimensions so expanded background fits within page
    const bleedInches = 0.10;
    const widthInches = dilatedWidth / effectiveDPI + (bleedInches * 2);
    const heightInches = dilatedHeight / effectiveDPI + (bleedInches * 2);
    
    // Path coordinates need to be offset by bleed amount
    const pathInInches = smoothedPath.map(p => ({
      x: (p.x / effectiveDPI) + bleedInches,
      y: heightInches - ((p.y / effectiveDPI) + bleedInches)
    }));
    
    // Image offset includes bleed
    const imageOffsetX = (totalOffsetPixels / effectiveDPI) + bleedInches;
    const imageOffsetY = (totalOffsetPixels / effectiveDPI) + bleedInches;
    
    return {
      pathPoints: pathInInches,
      widthInches,
      heightInches,
      imageOffsetX,
      imageOffsetY,
      backgroundColor: strokeSettings.backgroundColor
    };
  } catch (error) {
    console.error('Error getting contour path:', error);
    return null;
  }
}

export interface CachedContourData {
  pathPoints: Array<{x: number; y: number}>;
  previewPathPoints: Array<{x: number; y: number}>;
  widthInches: number;
  heightInches: number;
  imageOffsetX: number;
  imageOffsetY: number;
  backgroundColor: string;
  effectiveDPI: number;
  minPathX: number;
  minPathY: number;
  bleedInches: number;
}

export interface SpotColorInput {
  hex: string;
  rgb: { r: number; g: number; b: number };
  spotWhite: boolean;
  spotGloss: boolean;
  spotWhiteName?: string;
  spotGlossName?: string;
  spotFluorY: boolean;
  spotFluorM: boolean;
  spotFluorG: boolean;
  spotFluorOrange: boolean;
  spotFluorYName?: string;
  spotFluorMName?: string;
  spotFluorGName?: string;
  spotFluorOrangeName?: string;
}

export async function downloadContourPDF(
  image: HTMLImageElement,
  strokeSettings: StrokeSettings,
  resizeSettings: ResizeSettings,
  filename: string,
  cachedContourData?: CachedContourData,
  spotColors?: SpotColorInput[],
  singleArtboard: boolean = false,
  cutContourLabel: string = 'CutContour',
  lockedContour?: { label: string; pathPoints: Array<{x: number; y: number}>; widthInches: number; heightInches: number } | null
): Promise<void> {
  try {
    console.log('[downloadContourPDF] Starting, cached:', !!cachedContourData);
    const startTime = performance.now();
    
    // Small delay to allow loading indicator to render
    await new Promise(resolve => setTimeout(resolve, 50));
    
    let pathPoints: Array<{x: number; y: number}>;
    let previewPathPoints: Array<{x: number; y: number}>;
    let widthInches: number;
    let heightInches: number;
    let imageOffsetX: number;
    let imageOffsetY: number;
    let backgroundColor: string;
    let effectiveDPI: number;
    let minPathX: number;
    let minPathY: number;
    let bleedInches: number;
    {
      const workerManager = getContourWorkerManager();
      const contourData = workerManager.getCachedContourData();
      if (contourData) {
        console.log('[downloadContourPDF] Using cached preview contour data (instant)');
        pathPoints = contourData.pathPoints;
        previewPathPoints = contourData.previewPathPoints;
        widthInches = contourData.widthInches;
        heightInches = contourData.heightInches;
        imageOffsetX = contourData.imageOffsetX;
        imageOffsetY = contourData.imageOffsetY;
        backgroundColor = contourData.backgroundColor;
        effectiveDPI = contourData.effectiveDPI;
        minPathX = contourData.minPathX;
        minPathY = contourData.minPathY;
        bleedInches = contourData.bleedInches;
      } else {
        console.error('[downloadContourPDF] No contour data available - generate preview first');
        return;
      }
    }
    
    console.log('[downloadContourPDF] Contour data ready in', (performance.now() - startTime).toFixed(0), 'ms');
    console.log('[downloadContourPDF] Page:', widthInches.toFixed(3), 'x', heightInches.toFixed(3), 'in, DPI:', effectiveDPI, ', pathPts:', pathPoints.length, ', bleed:', bleedInches);
    console.log('[downloadContourPDF] Image offset:', imageOffsetX.toFixed(3), imageOffsetY.toFixed(3), 'in');
  
    const widthPts = widthInches * 72;
    const heightPts = heightInches * 72;
    
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([widthPts, heightPts]);
    
    // OPTIMIZATION: Create background and design canvases in parallel
    // Background uses lower DPI (150) since it's solid color - doesn't need 300 DPI
    const bgDPI = 150;
    const bgBleedInches = 0.10;
    const bleedPixels = bgBleedInches * bgDPI;
    const fillColor = backgroundColor || '#ffffff';
    const drawPath = pathPoints;
    
    // Create background canvas (lower DPI for speed)
    const createBackgroundBlob = (): Promise<Blob> => {
      return new Promise((resolve, reject) => {
        const bgCanvas = document.createElement('canvas');
        const bgCtx = bgCanvas.getContext('2d');
        if (!bgCtx) {
          reject(new Error('Failed to get background canvas context'));
          return;
        }
        
        bgCanvas.width = Math.round(widthInches * bgDPI);
        bgCanvas.height = Math.round(heightInches * bgDPI);
        
        bgCtx.fillStyle = fillColor;
        bgCtx.strokeStyle = fillColor;
        bgCtx.lineWidth = bleedPixels * 2;
        bgCtx.lineJoin = 'round';
        bgCtx.lineCap = 'round';
        
        if (drawPath.length > 0) {
          bgCtx.beginPath();
          bgCtx.moveTo(drawPath[0].x * bgDPI, drawPath[0].y * bgDPI);
          for (let i = 1; i < drawPath.length; i++) {
            bgCtx.lineTo(drawPath[i].x * bgDPI, drawPath[i].y * bgDPI);
          }
          bgCtx.closePath();
          bgCtx.stroke();
          bgCtx.fill();
        }
        
        // Flip for PDF coordinate system
        const flippedBgCanvas = document.createElement('canvas');
        flippedBgCanvas.width = bgCanvas.width;
        flippedBgCanvas.height = bgCanvas.height;
        const flippedBgCtx = flippedBgCanvas.getContext('2d');
        if (flippedBgCtx) {
          flippedBgCtx.translate(0, bgCanvas.height);
          flippedBgCtx.scale(1, -1);
          flippedBgCtx.drawImage(bgCanvas, 0, 0);
        }
        
        // Use PNG for better quality backgrounds
        flippedBgCanvas.toBlob((b) => {
          if (b) resolve(b);
          else reject(new Error('Failed to create blob from canvas'));
        }, 'image/png');
      });
    };
    
    // Create design canvas
    const createDesignBlob = (): Promise<Blob> => {
      return new Promise((resolve, reject) => {
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        if (!tempCtx) {
          reject(new Error('Failed to get design canvas context'));
          return;
        }
        
        tempCanvas.width = image.width;
        tempCanvas.height = image.height;
        tempCtx.drawImage(image, 0, 0);
        
        tempCanvas.toBlob((b) => {
          if (b) resolve(b);
          else reject(new Error('Failed to create blob from design canvas'));
        }, 'image/png');
      });
    };
    
    // Run both canvas operations in parallel
    const [bgBlob, designBlob] = await Promise.all([
      createBackgroundBlob(),
      createDesignBlob()
    ]);
    
    // Convert blobs to bytes in parallel
    const [bgPngBytes, pngBytes] = await Promise.all([
      bgBlob.arrayBuffer().then(buf => new Uint8Array(buf)),
      designBlob.arrayBuffer().then(buf => new Uint8Array(buf))
    ]);
    
    // Embed images in PDF as PNG for better quality
    const bgPngImage = await pdfDoc.embedPng(bgPngBytes);
    
    // Draw the background raster image first
    page.drawImage(bgPngImage, {
      x: 0,
      y: 0,
      width: widthPts,
      height: heightPts,
    });
  
  const pngImage = await pdfDoc.embedPng(pngBytes);
  
  const imageXPts = imageOffsetX * 72;
  const imageWidthPts = resizeSettings.widthInches * 72;
  const imageHeightPts = resizeSettings.heightInches * 72;
  const imageYPts = heightPts - (imageOffsetY * 72) - imageHeightPts;
  
  page.drawImage(pngImage, {
    x: imageXPts,
    y: imageYPts,
    width: imageWidthPts,
    height: imageHeightPts,
  });

  const context = pdfDoc.context;
  
  if (pathPoints.length > 2) {
    
    const tintFunction = context.obj({
      FunctionType: 2,
      Domain: [0, 1],
      C0: [0, 0, 0, 0],
      C1: [0, 1, 0, 0],
      N: 1,
    });
    const tintFunctionRef = context.register(tintFunction);
    
    const separationColorSpace = context.obj([
      PDFName.of('Separation'),
      PDFName.of(cutContourLabel),
      PDFName.of('DeviceCMYK'),
      tintFunctionRef,
    ]);
    const separationRef = context.register(separationColorSpace);
    
    const resources = page.node.Resources();
    if (resources) {
      let colorSpaceDict = resources.get(PDFName.of('ColorSpace'));
      if (!colorSpaceDict) {
        colorSpaceDict = context.obj({});
        resources.set(PDFName.of('ColorSpace'), colorSpaceDict);
      }
      (colorSpaceDict as PDFDict).set(PDFName.of(cutContourLabel), separationRef);
    }
    
    const pathOps = contourPointsToPDFPathOps(pathPoints, heightInches, cutContourLabel);
    
    if (pathOps.length > 0) {
      const existingContents = page.node.Contents();
      if (existingContents) {
        const contentStream = context.stream(pathOps);
        const contentStreamRef = context.register(contentStream);
        
        if (existingContents instanceof PDFArray) {
          existingContents.push(contentStreamRef);
        } else {
          const newContents = context.obj([existingContents, contentStreamRef]);
          page.node.set(PDFName.of('Contents'), newContents);
        }
      }
    }
  }
  
  if (lockedContour && lockedContour.pathPoints.length > 2) {
    if (lockedContour.label !== cutContourLabel) {
      const lockedTintFunction = context.obj({
        FunctionType: 2,
        Domain: [0, 1],
        C0: [0, 0, 0, 0],
        C1: [0, 1, 0, 0],
        N: 1,
      });
      const lockedTintRef = context.register(lockedTintFunction);
      
      const lockedSepCS = context.obj([
        PDFName.of('Separation'),
        PDFName.of(lockedContour.label),
        PDFName.of('DeviceCMYK'),
        lockedTintRef,
      ]);
      const lockedSepRef = context.register(lockedSepCS);
      
      const resources = page.node.Resources();
      if (resources) {
        let colorSpaceDict = resources.get(PDFName.of('ColorSpace'));
        if (!colorSpaceDict) {
          colorSpaceDict = context.obj({});
          resources.set(PDFName.of('ColorSpace'), colorSpaceDict);
        }
        (colorSpaceDict as PDFDict).set(PDFName.of(lockedContour.label), lockedSepRef);
      }
    }
    
    const lockedPathOps = contourPointsToPDFPathOps(lockedContour.pathPoints, heightInches, lockedContour.label);
    
    if (lockedPathOps.length > 0) {
      const existingContents = page.node.Contents();
      if (existingContents) {
        const contentStream = context.stream(lockedPathOps);
        const contentStreamRef = context.register(contentStream);
        
        if (existingContents instanceof PDFArray) {
          existingContents.push(contentStreamRef);
        } else {
          const newContents = context.obj([existingContents, contentStreamRef]);
          page.node.set(PDFName.of('Contents'), newContents);
        }
      }
    }
  }
  
  if (spotColors && spotColors.length > 0) {
    const spotLabels = await addSpotColorVectorsToPDF(
      pdfDoc, page, image, spotColors,
      resizeSettings.widthInches, resizeSettings.heightInches,
      heightInches, imageOffsetX, imageOffsetY,
      singleArtboard, widthPts, heightPts
    );
    console.log('[downloadContourPDF] Added spot color vector layers:', spotLabels);
  }
  
  const whiteName = spotColors?.find(c => c.spotWhite)?.spotWhiteName || 'RDG_WHITE';
  const glossName = spotColors?.find(c => c.spotGloss)?.spotGlossName || 'RDG_GLOSS';
  
  pdfDoc.setTitle('Sticker with CutContour and Spot Colors');
  pdfDoc.setSubject(singleArtboard 
    ? `Single artboard with Design + CutContour + ${whiteName} + ${glossName}`
    : `Page 1: Raster + CutContour, Page 2: ${whiteName}, Page 3: ${glossName}`);
  pdfDoc.setKeywords(['CutContour', 'spot color', 'cutting', 'vector', whiteName, glossName]);
  
  const pdfBytes = await pdfDoc.save();
  const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(pdfBlob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  } catch (error) {
    console.error('[downloadContourPDF] Error:', error);
    throw error;
  }
}

export async function downloadDesignOnlyPDF(
  image: HTMLImageElement,
  resizeSettings: ResizeSettings,
  filename: string,
  spotColors?: SpotColorInput[],
  singleArtboard: boolean = false
): Promise<void> {
  try {
    console.log('[downloadDesignOnlyPDF] Starting design-only PDF (no cut lines)');
    await new Promise(resolve => setTimeout(resolve, 50));

    const widthInches = resizeSettings.widthInches;
    const heightInches = resizeSettings.heightInches;
    const widthPts = widthInches * 72;
    const heightPts = heightInches * 72;

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([widthPts, heightPts]);

    const designBlob: Blob = await new Promise((resolve, reject) => {
      const tempCanvas = document.createElement('canvas');
      const tempCtx = tempCanvas.getContext('2d');
      if (!tempCtx) { reject(new Error('Failed to get canvas context')); return; }
      tempCanvas.width = image.width;
      tempCanvas.height = image.height;
      tempCtx.drawImage(image, 0, 0);
      tempCanvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error('Failed to create blob'));
      }, 'image/png');
    });

    const pngBytes = new Uint8Array(await designBlob.arrayBuffer());
    const pngImage = await pdfDoc.embedPng(pngBytes);

    page.drawImage(pngImage, {
      x: 0,
      y: 0,
      width: widthPts,
      height: heightPts,
    });

    if (spotColors && spotColors.length > 0) {
      const spotLabels = await addSpotColorVectorsToPDF(
        pdfDoc, page, image, spotColors,
        widthInches, heightInches,
        heightInches, 0, 0,
        singleArtboard, widthPts, heightPts
      );
      console.log('[downloadDesignOnlyPDF] Added spot color vector layers:', spotLabels);
    }

    pdfDoc.setTitle('Design with Spot Colors');
    pdfDoc.setSubject('Design PDF without cut lines');

    const pdfBytes = await pdfDoc.save();
    const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(pdfBlob);

    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('[downloadDesignOnlyPDF] Error:', error);
    throw error;
  }
}

export async function generateContourPDFBase64(
  image: HTMLImageElement,
  strokeSettings: StrokeSettings,
  resizeSettings: ResizeSettings,
  cachedContourData?: CachedContourData,
  cutContourLabel: string = 'CutContour'
): Promise<string | null> {
  let pathPoints: Array<{x: number; y: number}>;
  let previewPathPoints: Array<{x: number; y: number}>;
  let widthInches: number;
  let heightInches: number;
  let imageOffsetX: number;
  let imageOffsetY: number;
  let backgroundColor: string;
  let effectiveDPI: number;
  let minPathX: number;
  let minPathY: number;
  let bleedInches: number;
  if (cachedContourData && cachedContourData.pathPoints.length > 0) {
    console.log('[generateContourPDFBase64] Using cached contour data for fast export');
    pathPoints = cachedContourData.pathPoints;
    previewPathPoints = cachedContourData.previewPathPoints;
    widthInches = cachedContourData.widthInches;
    heightInches = cachedContourData.heightInches;
    imageOffsetX = cachedContourData.imageOffsetX;
    imageOffsetY = cachedContourData.imageOffsetY;
    backgroundColor = cachedContourData.backgroundColor;
    effectiveDPI = cachedContourData.effectiveDPI;
    minPathX = cachedContourData.minPathX;
    minPathY = cachedContourData.minPathY;
    bleedInches = cachedContourData.bleedInches;
  } else {
    const workerManager = getContourWorkerManager();
    const contourData = workerManager.getCachedContourData();
    if (contourData) {
      pathPoints = contourData.pathPoints;
      previewPathPoints = contourData.previewPathPoints;
      widthInches = contourData.widthInches;
      heightInches = contourData.heightInches;
      imageOffsetX = contourData.imageOffsetX;
      imageOffsetY = contourData.imageOffsetY;
      backgroundColor = contourData.backgroundColor;
      effectiveDPI = contourData.effectiveDPI;
      minPathX = contourData.minPathX;
      minPathY = contourData.minPathY;
      bleedInches = contourData.bleedInches;
    } else {
      console.error('[generateContourPDFBase64] No contour data available - generate preview first');
      return null;
    }
  }
  
  const widthPts = widthInches * 72;
  const heightPts = heightInches * 72;
  
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([widthPts, heightPts]);
  
  // OPTIMIZATION: Create background and design canvases in parallel
  // Background uses lower DPI (150) since it's solid color - doesn't need 300 DPI
  const bgDPI = 150;
  const bgBleedInches = 0.10;
  const bleedPixels = bgBleedInches * bgDPI;
  const fillColor = backgroundColor || '#ffffff';
  const drawPath = pathPoints;
  
  // Create background canvas (lower DPI for speed)
  const createBackgroundBlob = (): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const bgCanvas = document.createElement('canvas');
      const bgCtx = bgCanvas.getContext('2d');
      if (!bgCtx) {
        reject(new Error('Failed to get background canvas context'));
        return;
      }
      
      bgCanvas.width = Math.round(widthInches * bgDPI);
      bgCanvas.height = Math.round(heightInches * bgDPI);
      
      bgCtx.fillStyle = fillColor;
      bgCtx.strokeStyle = fillColor;
      bgCtx.lineWidth = bleedPixels * 2;
      bgCtx.lineJoin = 'round';
      bgCtx.lineCap = 'round';
      
      if (drawPath.length > 0) {
        bgCtx.beginPath();
        bgCtx.moveTo(drawPath[0].x * bgDPI, drawPath[0].y * bgDPI);
        for (let i = 1; i < drawPath.length; i++) {
          bgCtx.lineTo(drawPath[i].x * bgDPI, drawPath[i].y * bgDPI);
        }
        bgCtx.closePath();
        bgCtx.stroke();
        bgCtx.fill();
      }
      
      // Flip for PDF coordinate system
      const flippedBgCanvas = document.createElement('canvas');
      flippedBgCanvas.width = bgCanvas.width;
      flippedBgCanvas.height = bgCanvas.height;
      const flippedBgCtx = flippedBgCanvas.getContext('2d');
      if (flippedBgCtx) {
        flippedBgCtx.translate(0, bgCanvas.height);
        flippedBgCtx.scale(1, -1);
        flippedBgCtx.drawImage(bgCanvas, 0, 0);
      }
      
      // Use PNG for better quality backgrounds
      flippedBgCanvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error('Failed to create blob from canvas'));
      }, 'image/png');
    });
  };
  
  // Create design canvas
  const createDesignBlob = (): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const tempCanvas = document.createElement('canvas');
      const tempCtx = tempCanvas.getContext('2d');
      if (!tempCtx) {
        reject(new Error('Failed to get design canvas context'));
        return;
      }
      
      tempCanvas.width = image.width;
      tempCanvas.height = image.height;
      tempCtx.drawImage(image, 0, 0);
      
      tempCanvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error('Failed to create blob from design canvas'));
      }, 'image/png');
    });
  };
  
  // Run both canvas operations in parallel
  const [bgBlob, designBlob] = await Promise.all([
    createBackgroundBlob(),
    createDesignBlob()
  ]);
  
  // Convert blobs to bytes in parallel
  const [bgPngBytes, pngBytes] = await Promise.all([
    bgBlob.arrayBuffer().then(buf => new Uint8Array(buf)),
    designBlob.arrayBuffer().then(buf => new Uint8Array(buf))
  ]);
  
  // Embed images in PDF as PNG for better quality
  const bgPngImage = await pdfDoc.embedPng(bgPngBytes);
  
  // Draw the background raster image first
  page.drawImage(bgPngImage, {
    x: 0,
    y: 0,
    width: widthPts,
    height: heightPts,
  });
  
  const pngImage = await pdfDoc.embedPng(pngBytes);
  
  const imageXPts = imageOffsetX * 72;
  const imageWidthPts = resizeSettings.widthInches * 72;
  const imageHeightPts = resizeSettings.heightInches * 72;
  const imageYPts = heightPts - (imageOffsetY * 72) - imageHeightPts;
  
  page.drawImage(pngImage, {
    x: imageXPts,
    y: imageYPts,
    width: imageWidthPts,
    height: imageHeightPts,
  });
  
  if (pathPoints.length > 2) {
    const context = pdfDoc.context;
    
    const tintFunction = context.obj({
      FunctionType: 2,
      Domain: [0, 1],
      C0: [0, 0, 0, 0],
      C1: [0, 1, 0, 0],
      N: 1,
    });
    const tintFunctionRef = context.register(tintFunction);
    
    const separationColorSpace = context.obj([
      PDFName.of('Separation'),
      PDFName.of(cutContourLabel),
      PDFName.of('DeviceCMYK'),
      tintFunctionRef,
    ]);
    const separationRef = context.register(separationColorSpace);
    
    const resources = page.node.Resources();
    if (resources) {
      let colorSpaceDict = resources.get(PDFName.of('ColorSpace'));
      if (!colorSpaceDict) {
        colorSpaceDict = context.obj({});
        resources.set(PDFName.of('ColorSpace'), colorSpaceDict);
      }
      (colorSpaceDict as PDFDict).set(PDFName.of(cutContourLabel), separationRef);
    }
    
    const pathOps = contourPointsToPDFPathOps(pathPoints, heightInches, cutContourLabel);
    
    if (pathOps.length > 0) {
      const existingContents = page.node.Contents();
      if (existingContents) {
        const contentStream = context.stream(pathOps);
        const contentStreamRef = context.register(contentStream);
        
        if (existingContents instanceof PDFArray) {
          existingContents.push(contentStreamRef);
        } else {
          const newContents = context.obj([existingContents, contentStreamRef]);
          page.node.set(PDFName.of('Contents'), newContents);
        }
      }
    }
  }
  
  pdfDoc.setTitle('Sticker with CutContour');
  pdfDoc.setSubject(`Contains ${cutContourLabel} spot color for cutting machines`);
  
  const pdfBytes = await pdfDoc.save();
  
  let binary = '';
  for (let i = 0; i < pdfBytes.length; i++) {
    binary += String.fromCharCode(pdfBytes[i]);
  }
  return btoa(binary);
}
