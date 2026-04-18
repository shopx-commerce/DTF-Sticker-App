import { StrokeSettings, ResizeSettings, ShapeSettings } from "@/components/image-editor";
import { PDFDocument, PDFPage, rgb, PDFName, PDFArray, PDFDict, PDFStream, PDFRef } from 'pdf-lib';
import { cropImageToContent } from './image-crop';

export interface ContourPathResult {
  pathPoints: Array<{ x: number; y: number }>; // Points in inches
  widthInches: number;
  heightInches: number;
  imageOffsetX: number; // Image position offset in inches
  imageOffsetY: number;
}

export function createSilhouetteContour(
  image: HTMLImageElement,
  strokeSettings: StrokeSettings,
  resizeSettings?: ResizeSettings
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  // Calculate effective DPI based on actual image dimensions and target inches
  const effectiveDPI = resizeSettings 
    ? image.width / resizeSettings.widthInches
    : image.width / 5; // Default assumption: image represents ~5 inches
  
  // Base offset (0.015") to create unified silhouette for multi-object images
  const baseOffsetInches = 0.015;
  const baseOffsetPixels = Math.round(baseOffsetInches * effectiveDPI);
  
  // Auto-bridge offset (0.02") - always applied to bridge outlines within 0.02" of each other
  const autoBridgeInches = 0.02;
  const autoBridgePixels = Math.round(autoBridgeInches * effectiveDPI);
  
  let gapClosePixels = 0;
  if (strokeSettings.autoBridging) {
    gapClosePixels = Math.round(strokeSettings.autoBridgingThreshold * effectiveDPI);
  }
  
  const userOffsetPixels = Math.round(strokeSettings.width * effectiveDPI);
  const totalOffsetPixels = baseOffsetPixels + userOffsetPixels;
  
  // Canvas needs extra space for the total contour offset
  const padding = totalOffsetPixels + 10;
  canvas.width = image.width + (padding * 2);
  canvas.height = image.height + (padding * 2);
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  try {
    // Step 1: Create binary silhouette mask from alpha channel
    const silhouetteMask = createSilhouetteMask(image);
    if (silhouetteMask.length === 0) {
      ctx.drawImage(image, padding, padding);
      return canvas;
    }
    
    // Step 2: Auto-bridge outlines within 0.02" of each other (always applied)
    // This makes cutting easier by connecting nearby elements
    let autoBridgedMask = silhouetteMask;
    if (autoBridgePixels > 0) {
      const halfAutoBridge = Math.round(autoBridgePixels / 2);
      const dilatedAuto = dilateSilhouette(silhouetteMask, image.width, image.height, halfAutoBridge);
      const dilatedAutoWidth = image.width + halfAutoBridge * 2;
      const dilatedAutoHeight = image.height + halfAutoBridge * 2;
      const filledAuto = fillSilhouette(dilatedAuto, dilatedAutoWidth, dilatedAutoHeight);
      
      // Extract center portion
      autoBridgedMask = new Uint8Array(image.width * image.height);
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          autoBridgedMask[y * image.width + x] = filledAuto[(y + halfAutoBridge) * dilatedAutoWidth + (x + halfAutoBridge)];
        }
      }
    }
    
    // Step 3: If gap closing is enabled, only fill interior gaps without changing outer boundary
    let bridgedMask = autoBridgedMask;
    let bridgedWidth = image.width;
    let bridgedHeight = image.height;
    
    if (gapClosePixels > 0) {
      // Use morphological closing: dilate, fill holes, then erode back
      // This closes gaps while preserving the outer boundary shape
      const halfGapPixels = Math.round(gapClosePixels / 2);
      
      // Step 3a: Dilate to connect nearby elements
      const dilatedMask = dilateSilhouette(autoBridgedMask, image.width, image.height, halfGapPixels);
      const dilatedWidth = image.width + halfGapPixels * 2;
      const dilatedHeight = image.height + halfGapPixels * 2;
      
      // Step 3b: Fill interior holes in the dilated mask
      const filledDilated = fillSilhouette(dilatedMask, dilatedWidth, dilatedHeight);
      
      // Step 3c: Find interior gap pixels only (pixels that are gaps surrounded by content)
      bridgedMask = new Uint8Array(image.width * image.height);
      bridgedMask.set(autoBridgedMask); // Start with original
      
      // Only fill pixels that bridge content in opposing directions
      for (let y = 1; y < image.height - 1; y++) {
        for (let x = 1; x < image.width - 1; x++) {
          if (autoBridgedMask[y * image.width + x] === 0) {
            const srcX = x + halfGapPixels;
            const srcY = y + halfGapPixels;
            if (filledDilated[srcY * dilatedWidth + srcX] === 1) {
              // Check for content in opposing directions within halfGapPixels distance
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
              
              // Bridge if content on opposing sides (vertical or horizontal bridge)
              if ((hasContentTop && hasContentBottom) || (hasContentLeft && hasContentRight)) {
                bridgedMask[y * image.width + x] = 1;
              }
            }
          }
        }
      }
      
      // Step 3d: After gap closing, create smooth bridges for any outlines within 0.03" of each other
      const smoothBridgePixels = Math.round(0.03 * effectiveDPI / 2);
      if (smoothBridgePixels > 0) {
        // Create a distance map from the mask - for each empty pixel, find distance to nearest content
        const distanceMap = new Float32Array(image.width * image.height);
        distanceMap.fill(Infinity);
        
        // Initialize with content pixels having distance 0
        for (let y = 0; y < image.height; y++) {
          for (let x = 0; x < image.width; x++) {
            if (bridgedMask[y * image.width + x] === 1) {
              distanceMap[y * image.width + x] = 0;
            }
          }
        }
        
        // Forward pass for distance transform
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
        
        // Backward pass
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
        
        // Find pixels within smoothBridgePixels distance that bridge two separate content areas
        for (let y = 1; y < image.height - 1; y++) {
          for (let x = 1; x < image.width - 1; x++) {
            const idx = y * image.width + x;
            if (bridgedMask[idx] === 0 && distanceMap[idx] <= smoothBridgePixels) {
              // Check if this pixel bridges content (has content in opposing directions)
              let hasContentTop = false, hasContentBottom = false;
              let hasContentLeft = false, hasContentRight = false;
              
              // Look for content in each direction within smoothBridgePixels
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
              
              // Bridge if content on opposing sides (vertical or horizontal bridge)
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
    
    // Step 3: Dilate by base offset to create unified silhouette
    const baseDilatedMask = dilateSilhouette(bridgedMask, bridgedWidth, bridgedHeight, baseOffsetPixels);
    const baseWidth = bridgedWidth + baseOffsetPixels * 2;
    const baseHeight = bridgedHeight + baseOffsetPixels * 2;
    
    // Step 4: Fill the base silhouette to create solid shape
    const filledMask = fillSilhouette(baseDilatedMask, baseWidth, baseHeight);
    
    // Step 5: Dilate the filled silhouette by user-selected offset
    const finalDilatedMask = dilateSilhouette(filledMask, baseWidth, baseHeight, userOffsetPixels);
    const dilatedWidth = baseWidth + userOffsetPixels * 2;
    const dilatedHeight = baseHeight + userOffsetPixels * 2;
    
    // Step 5a: Auto-bridge any touching or nearly touching contours after dilation
    // This detects where contour outlines are touching and fills the gaps
    const bridgedFinalMask = bridgeTouchingContours(finalDilatedMask, dilatedWidth, dilatedHeight, effectiveDPI);
    
    // Step 6: Trace the boundary of the final dilated silhouette
    const boundaryPath = traceBoundary(bridgedFinalMask, dilatedWidth, dilatedHeight);
    
    if (boundaryPath.length < 3) {
      ctx.drawImage(image, padding, padding);
      return canvas;
    }
    
    // Step 6: Smooth and simplify the path
    let smoothedPath = smoothPath(boundaryPath, 2);
    
    // Apply gap closing using U/N shapes based on settings
    const gapThresholdPixels = strokeSettings.autoBridging 
      ? Math.round(strokeSettings.autoBridgingThreshold * effectiveDPI) 
      : 0;
    
    if (gapThresholdPixels > 0) {
      smoothedPath = closeGapsWithShapes(smoothedPath, gapThresholdPixels);
    }
    
    // Step 7: Draw the contour
    const offsetX = padding - totalOffsetPixels;
    const offsetY = padding - totalOffsetPixels;
    drawSmoothContour(ctx, smoothedPath, strokeSettings.color || '#FFFFFF', offsetX, offsetY);
    
    // Step 8: Draw the original image on top
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
  
  const totalPixels = width * height;
  const visited = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  let qHead = 0, qTail = 0;
  
  for (let x = 0; x < width; x++) {
    if (mask[x] === 0 && !visited[x]) { visited[x] = 1; queue[qTail++] = x; }
    const b = (height - 1) * width + x;
    if (mask[b] === 0 && !visited[b]) { visited[b] = 1; queue[qTail++] = b; }
  }
  for (let y = 0; y < height; y++) {
    const l = y * width;
    if (mask[l] === 0 && !visited[l]) { visited[l] = 1; queue[qTail++] = l; }
    const r = y * width + width - 1;
    if (mask[r] === 0 && !visited[r]) { visited[r] = 1; queue[qTail++] = r; }
  }
  
  while (qHead < qTail) {
    const idx = queue[qHead++];
    const x = idx % width;
    const y = (idx / width) | 0;
    if (x > 0)          { const n = idx - 1;     if (!visited[n] && mask[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
    if (x < width - 1)  { const n = idx + 1;     if (!visited[n] && mask[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
    if (y > 0)          { const n = idx - width; if (!visited[n] && mask[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
    if (y < height - 1) { const n = idx + width; if (!visited[n] && mask[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
  }
  
  for (let i = 0; i < filled.length; i++) {
    if (filled[i] === 0 && !visited[i]) {
      filled[i] = 1;
    }
  }
  
  return filled;
}

// Bridge touching or nearly touching contours after dilation
// This fills small gaps where two contour outlines meet or nearly meet
function bridgeTouchingContours(mask: Uint8Array, width: number, height: number, effectiveDPI: number): Uint8Array {
  const result = new Uint8Array(mask.length);
  result.set(mask);
  
  // Bridge gaps up to 0.03" (touching threshold)
  const bridgeThresholdPixels = Math.max(2, Math.round(0.03 * effectiveDPI));
  
  // Find gaps that are surrounded by content on multiple sides
  // This indicates where two contour regions are touching
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      
      if (mask[idx] === 0) {
        // Check if this empty pixel is between content regions
        let contentDirections = 0;
        let hasContentTop = false, hasContentBottom = false;
        let hasContentLeft = false, hasContentRight = false;
        
        // Look for content in each direction within bridgeThreshold
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
        
        // Also check diagonal directions for better corner detection
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
        
        // Count content directions
        if (hasContentTop) contentDirections++;
        if (hasContentBottom) contentDirections++;
        if (hasContentLeft) contentDirections++;
        if (hasContentRight) contentDirections++;
        
        // Bridge if:
        // 1. Content on opposing sides (vertical or horizontal)
        // 2. OR content on 3+ directions (corner case)
        // 3. OR diagonal touching (content on diagonal + adjacent)
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
  
  const totalPixels = width * height;
  const visited = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  let qHead = 0, qTail = 0;
  
  for (let x = 0; x < width; x++) {
    if (result[x] === 0 && !visited[x]) { visited[x] = 1; queue[qTail++] = x; }
    const b = (height - 1) * width + x;
    if (result[b] === 0 && !visited[b]) { visited[b] = 1; queue[qTail++] = b; }
  }
  for (let y = 0; y < height; y++) {
    const l = y * width;
    if (result[l] === 0 && !visited[l]) { visited[l] = 1; queue[qTail++] = l; }
    const r = y * width + width - 1;
    if (result[r] === 0 && !visited[r]) { visited[r] = 1; queue[qTail++] = r; }
  }
  
  while (qHead < qTail) {
    const idx = queue[qHead++];
    const x = idx % width;
    const y = (idx / width) | 0;
    if (x > 0)          { const n = idx - 1;     if (!visited[n] && result[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
    if (x < width - 1)  { const n = idx + 1;     if (!visited[n] && result[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
    if (y > 0)          { const n = idx - width; if (!visited[n] && result[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
    if (y < height - 1) { const n = idx + width; if (!visited[n] && result[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
  }
  
  for (let i = 0; i < result.length; i++) {
    if (result[i] === 0 && !visited[i]) {
      result[i] = 1;
    }
  }
  
  return result;
}

// Performance threshold: images above this pixel count get downsampled for contour detection
const HIGH_DETAIL_THRESHOLD = 400000; // ~632x632 pixels
const MAX_PROCESSING_SIZE = 600; // Max dimension for processing high-detail images

interface MaskResult {
  mask: Uint8Array;
  width: number;
  height: number;
  scale: number; // Scale factor used (1.0 = no downsampling)
}

function createSilhouetteMask(image: HTMLImageElement): Uint8Array {
  const result = createOptimizedSilhouetteMask(image);
  
  // If no downsampling was applied, return the mask directly
  if (result.scale === 1.0) {
    return result.mask;
  }
  
  // Upscale the mask back to original dimensions
  return upscaleMask(result.mask, result.width, result.height, image.width, image.height);
}

function createOptimizedSilhouetteMask(image: HTMLImageElement): MaskResult {
  const totalPixels = image.width * image.height;
  
  // For smaller/simpler images, process at full resolution
  if (totalPixels <= HIGH_DETAIL_THRESHOLD) {
    return {
      mask: createMaskAtResolution(image, image.width, image.height),
      width: image.width,
      height: image.height,
      scale: 1.0
    };
  }
  
  // For high-detail images, downsample for faster processing
  const maxDim = Math.max(image.width, image.height);
  const scale = MAX_PROCESSING_SIZE / maxDim;
  const processWidth = Math.round(image.width * scale);
  const processHeight = Math.round(image.height * scale);
  
  return {
    mask: createMaskAtResolution(image, processWidth, processHeight),
    width: processWidth,
    height: processHeight,
    scale: scale
  };
}

function createMaskAtResolution(image: HTMLImageElement, targetWidth: number, targetHeight: number): Uint8Array {
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) return new Uint8Array(0);

  tempCanvas.width = targetWidth;
  tempCanvas.height = targetHeight;
  
  // Draw image scaled to target size - browser handles the resampling
  tempCtx.drawImage(image, 0, 0, targetWidth, targetHeight);
  const imageData = tempCtx.getImageData(0, 0, targetWidth, targetHeight);
  const data = imageData.data;
  
  // Create binary silhouette: 1 = any visible pixel (alpha > 0), 0 = fully transparent
  // Using a low threshold (10) to catch even semi-transparent edges
  const mask = new Uint8Array(targetWidth * targetHeight);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = data[i * 4 + 3] > 10 ? 1 : 0;
  }
  
  return mask;
}

function upscaleMask(mask: Uint8Array, srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number): Uint8Array {
  const result = new Uint8Array(dstWidth * dstHeight);
  const scaleX = srcWidth / dstWidth;
  const scaleY = srcHeight / dstHeight;
  
  for (let y = 0; y < dstHeight; y++) {
    const srcY = Math.min(Math.floor(y * scaleY), srcHeight - 1);
    for (let x = 0; x < dstWidth; x++) {
      const srcX = Math.min(Math.floor(x * scaleX), srcWidth - 1);
      result[y * dstWidth + x] = mask[srcY * srcWidth + srcX];
    }
  }
  
  return result;
}

function dilateSilhouette(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const newWidth = width + radius * 2;
  const newHeight = height + radius * 2;
  const dilated = new Uint8Array(newWidth * newHeight);
  
  if (radius <= 0) {
    // Just copy to center
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        dilated[y * newWidth + x] = mask[y * width + x];
      }
    }
    return dilated;
  }
  
  // Precompute circle offsets
  const circleOffsets: { dx: number; dy: number }[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) {
        circleOffsets.push({ dx, dy });
      }
    }
  }
  
  // Dilate: for each solid pixel, fill a circle around it
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 1) {
        const centerX = x + radius;
        const centerY = y + radius;
        
        for (const { dx, dy } of circleOffsets) {
          const nx = centerX + dx;
          const ny = centerY + dy;
          if (nx >= 0 && nx < newWidth && ny >= 0 && ny < newHeight) {
            dilated[ny * newWidth + nx] = 1;
          }
        }
      }
    }
  }
  
  return dilated;
}

// Erode silhouette - shrink the mask by removing pixels near edges
function erodeSilhouette(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const newWidth = width - radius * 2;
  const newHeight = height - radius * 2;
  
  if (newWidth <= 0 || newHeight <= 0 || radius <= 0) {
    return new Uint8Array(width * height);
  }
  
  const eroded = new Uint8Array(newWidth * newHeight);
  
  // Precompute circle offsets for checking
  const circleOffsets: { dx: number; dy: number }[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) {
        circleOffsets.push({ dx, dy });
      }
    }
  }
  
  // Erode: a pixel is solid only if ALL pixels in its radius are solid
  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      const srcX = x + radius;
      const srcY = y + radius;
      
      let allSolid = true;
      for (const { dx, dy } of circleOffsets) {
        const checkX = srcX + dx;
        const checkY = srcY + dy;
        if (checkX >= 0 && checkX < width && checkY >= 0 && checkY < height) {
          if (mask[checkY * width + checkX] === 0) {
            allSolid = false;
            break;
          }
        } else {
          allSolid = false;
          break;
        }
      }
      
      eroded[y * newWidth + x] = allSolid ? 1 : 0;
    }
  }
  
  return eroded;
}

interface Point {
  x: number;
  y: number;
}

function traceBoundary(mask: Uint8Array, width: number, height: number): Point[] {
  // Find all edge pixels first
  const edgePixels: Point[] = [];
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 1) {
        // Check if on edge (has at least one transparent neighbor)
        const hasTransparentNeighbor = 
          x === 0 || x === width - 1 || y === 0 || y === height - 1 ||
          mask[y * width + (x - 1)] === 0 ||
          mask[y * width + (x + 1)] === 0 ||
          mask[(y - 1) * width + x] === 0 ||
          mask[(y + 1) * width + x] === 0;
        
        if (hasTransparentNeighbor) {
          edgePixels.push({ x, y });
        }
      }
    }
  }
  
  if (edgePixels.length === 0) return [];
  
  // Create a set for quick lookup
  const edgeSet = new Set(edgePixels.map(p => `${p.x},${p.y}`));
  
  // Start from the topmost-leftmost edge pixel
  let startPixel = edgePixels[0];
  for (const p of edgePixels) {
    if (p.y < startPixel.y || (p.y === startPixel.y && p.x < startPixel.x)) {
      startPixel = p;
    }
  }
  
  // Trace boundary by following connected edge pixels
  const boundary: Point[] = [];
  const visited = new Set<string>();
  
  // 8-directional neighbors (clockwise starting from right)
  const dx = [1, 1, 0, -1, -1, -1, 0, 1];
  const dy = [0, 1, 1, 1, 0, -1, -1, -1];
  
  let current = startPixel;
  let prevDir = 4; // Coming from the left (since we found leftmost pixel)
  
  const maxIterations = edgePixels.length * 2;
  
  for (let iter = 0; iter < maxIterations; iter++) {
    const key = `${current.x},${current.y}`;
    
    if (boundary.length > 0 && current.x === startPixel.x && current.y === startPixel.y) {
      break; // Completed the loop
    }
    
    if (!visited.has(key)) {
      boundary.push({ x: current.x, y: current.y });
      visited.add(key);
    }
    
    // Find next edge pixel, searching clockwise from the direction we came from
    let found = false;
    const searchStart = (prevDir + 5) % 8; // Start searching from 90 degrees left of incoming direction
    
    for (let i = 0; i < 8; i++) {
      const dir = (searchStart + i) % 8;
      const nx = current.x + dx[dir];
      const ny = current.y + dy[dir];
      const nkey = `${nx},${ny}`;
      
      if (edgeSet.has(nkey) && !visited.has(nkey)) {
        current = { x: nx, y: ny };
        prevDir = dir;
        found = true;
        break;
      }
    }
    
    if (!found) {
      // Try to find any unvisited connected edge pixel
      for (let i = 0; i < 8; i++) {
        const nx = current.x + dx[i];
        const ny = current.y + dy[i];
        const nkey = `${nx},${ny}`;
        
        if (edgeSet.has(nkey) && !visited.has(nkey)) {
          current = { x: nx, y: ny };
          prevDir = i;
          found = true;
          break;
        }
      }
    }
    
    if (!found) break;
  }
  
  return boundary;
}

function smoothPath(points: Point[], windowSize: number): Point[] {
  if (points.length < windowSize * 2 + 1) return points;
  
  // Step 1: Remove self-intersections first
  let cleaned = removeSelfIntersections(points);
  
  // Step 2: Remove tiny spikes/bumps that deviate sharply from the overall curve
  cleaned = removeSpikes(cleaned, 10, 0.25);
  
  // Step 3: Apply very aggressive smoothing with large window
  const extraLargeWindow = 8;
  let smoothed: Point[] = [];
  
  for (let i = 0; i < cleaned.length; i++) {
    let sumX = 0, sumY = 0, count = 0;
    
    for (let j = -extraLargeWindow; j <= extraLargeWindow; j++) {
      const idx = (i + j + cleaned.length) % cleaned.length;
      sumX += cleaned[idx].x;
      sumY += cleaned[idx].y;
      count++;
    }
    
    smoothed.push({
      x: sumX / count,
      y: sumY / count
    });
  }
  
  // Step 4: Remove intersections after first smoothing pass
  smoothed = removeSelfIntersections(smoothed);
  
  // Step 5: Second smoothing pass with medium window
  const mediumWindow = 6;
  let medSmoothed: Point[] = [];
  
  for (let i = 0; i < smoothed.length; i++) {
    let sumX = 0, sumY = 0, count = 0;
    
    for (let j = -mediumWindow; j <= mediumWindow; j++) {
      const idx = (i + j + smoothed.length) % smoothed.length;
      sumX += smoothed[idx].x;
      sumY += smoothed[idx].y;
      count++;
    }
    
    medSmoothed.push({
      x: sumX / count,
      y: sumY / count
    });
  }
  
  // Step 6: Apply Chaikin's corner cutting for ultra-smooth curves
  let chaikinSmoothed = applyChaikinSmoothing(medSmoothed, 2);
  
  // Step 7: Remove any remaining intersections
  chaikinSmoothed = removeSelfIntersections(chaikinSmoothed);
  
  // Step 8: Final smoothing pass
  let fineSmoothed: Point[] = [];
  for (let i = 0; i < chaikinSmoothed.length; i++) {
    let sumX = 0, sumY = 0, count = 0;
    
    for (let j = -windowSize; j <= windowSize; j++) {
      const idx = (i + j + chaikinSmoothed.length) % chaikinSmoothed.length;
      sumX += chaikinSmoothed[idx].x;
      sumY += chaikinSmoothed[idx].y;
      count++;
    }
    
    fineSmoothed.push({
      x: sumX / count,
      y: sumY / count
    });
  }
  
  // Step 9: Remove spikes one more time
  fineSmoothed = removeSpikes(fineSmoothed, 6, 0.35);
  
  // Step 10: Final intersection removal
  fineSmoothed = removeSelfIntersections(fineSmoothed);
  
  // Simplify to reduce point count with higher tolerance for smoother result
  return douglasPeucker(fineSmoothed, 1.5);
}

// Chaikin's corner cutting algorithm for smooth curves
function applyChaikinSmoothing(points: Point[], iterations: number): Point[] {
  if (points.length < 3) return points;
  
  let result = [...points];
  
  for (let iter = 0; iter < iterations; iter++) {
    const newPoints: Point[] = [];
    const n = result.length;
    
    for (let i = 0; i < n; i++) {
      const p0 = result[i];
      const p1 = result[(i + 1) % n];
      
      // Create two new points at 1/4 and 3/4 along the segment
      newPoints.push({
        x: p0.x * 0.75 + p1.x * 0.25,
        y: p0.y * 0.75 + p1.y * 0.25
      });
      newPoints.push({
        x: p0.x * 0.25 + p1.x * 0.75,
        y: p0.y * 0.25 + p1.y * 0.75
      });
    }
    
    result = newPoints;
  }
  
  return result;
}

// Detect and remove self-intersecting segments (Y-shaped and T-shaped crossings)
function removeSelfIntersections(points: Point[]): Point[] {
  if (points.length < 4) return points;
  
  // First: remove narrow concave regions where path doubles back on itself
  let result = removeNarrowConcaveRegions(points);
  
  let changed = true;
  let iterations = 0;
  const maxIterations = 50;
  
  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;
    
    const n = result.length;
    
    // Check all segment pairs for intersections
    for (let i = 0; i < n && !changed; i++) {
      const p1 = result[i];
      const p2 = result[(i + 1) % n];
      
      // Check against all non-adjacent segments
      for (let j = i + 2; j < n; j++) {
        if (j === i + 1 || (i === 0 && j === n - 1)) continue;
        
        const p3 = result[j];
        const p4 = result[(j + 1) % n];
        
        const intersection = lineSegmentIntersection(p1, p2, p3, p4);
        
        if (intersection) {
          const loopSize = j - i;
          const remainingSize = n - loopSize;
          
          if (loopSize <= remainingSize) {
            const newPoints: Point[] = [];
            for (let k = 0; k <= i; k++) {
              newPoints.push(result[k]);
            }
            newPoints.push(intersection);
            for (let k = j + 1; k < n; k++) {
              newPoints.push(result[k]);
            }
            result = newPoints;
          } else {
            const newPoints: Point[] = [];
            newPoints.push(intersection);
            for (let k = i + 1; k <= j; k++) {
              newPoints.push(result[k]);
            }
            result = newPoints;
          }
          
          changed = true;
          break;
        }
      }
    }
  }
  
  // Additional passes
  result = fixNearIntersections(result);
  result = removeNarrowConcaveRegions(result);
  
  return result;
}

// Flatten concave regions by replacing them with straight lines
// This prevents crossings by eliminating indentations in the cut path
function removeNarrowConcaveRegions(points: Point[]): Point[] {
  if (points.length < 6) return points;
  
  let result = [...points];
  
  // Pass 1: Detect and flatten concave vertices
  result = flattenConcaveVertices(result);
  
  // Pass 2: Remove any remaining tight loops
  result = removeTightLoops(result);
  
  return result;
}

// Close gaps by detecting where paths are close and applying U/N shapes
function closeGapsWithShapes(points: Point[], gapThreshold: number): Point[] {
  if (points.length < 20) return points;
  
  const n = points.length;
  const result: Point[] = [];
  const processed = new Set<number>();
  
  // Calculate centroid and average distance from centroid for the entire shape
  let centroidX = 0, centroidY = 0;
  for (const p of points) {
    centroidX += p.x;
    centroidY += p.y;
  }
  centroidX /= n;
  centroidY /= n;
  
  // Calculate average distance from centroid (the "normal" radius of the shape)
  let totalDist = 0;
  for (const p of points) {
    totalDist += Math.sqrt((p.x - centroidX) ** 2 + (p.y - centroidY) ** 2);
  }
  const avgDistFromCentroid = totalDist / n;
  
  // Find all gap locations where path points are within threshold but far apart in path order
  const gaps: Array<{i: number, j: number, dist: number}> = [];
  
  // Limit how much of path we can skip to avoid deleting entire outline
  const maxSkipPoints = Math.floor(n * 0.25); // Max 25% of path per gap
  const minSkipPoints = 15; // Must skip at least 15 points to be a real gap
  
  const stride = n > 1000 ? 3 : n > 500 ? 2 : 1;
  const thresholdSq = gapThreshold * gapThreshold;
  
  for (let i = 0; i < n; i += stride) {
    const pi = points[i];
    
    // Search ahead but limit to maxSkipPoints to avoid false gaps
    const maxSearch = Math.min(n - 5, i + maxSkipPoints);
    for (let j = i + minSkipPoints; j < maxSearch; j += stride) {
      const pj = points[j];
      const distSq = (pi.x - pj.x) ** 2 + (pi.y - pj.y) ** 2;
      
      if (distSq < thresholdSq) {
        // Check if this is a narrow passage (close) vs a protrusion (keep)
        const dist = Math.sqrt(distSq);
        const dx = pj.x - pi.x;
        const dy = pj.y - pi.y;
        const lineLen = dist;
        
        // Check max perpendicular distance of points between i and j
        let maxPerpDist = 0;
        const sampleStride = Math.max(1, Math.floor((j - i) / 20));
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
  
  if (gaps.length === 0) return points;
  
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
    } else {
      geometryGaps.push({...gap, priority: 2}); // Lower priority
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
  
  // Sort by path position for processing
  const sortedGaps = [...exteriorGaps].sort((a, b) => a.i - b.i);
  
  const refinedGaps: Array<{i: number, j: number, dist: number}> = [];
  for (const gap of sortedGaps) {
    let minDist = gap.dist;
    let bestI = gap.i;
    let bestJ = gap.j;
    
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
  
  let currentIdx = 0;
  
  for (const gap of refinedGaps) {
    if (gap.i < currentIdx) continue;
    
    for (let k = currentIdx; k <= gap.i; k++) {
      if (!processed.has(k)) {
        result.push(points[k]);
        processed.add(k);
      }
    }
    
    const p1 = points[gap.i];
    const p2 = points[gap.j];
    const gapDist = gap.dist;
    
    if (gapDist > 0.5) {
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      result.push({ x: midX, y: midY });
    }
    
    // For exterior caves, ALWAYS delete the cave interior
    // Skip all points between i and j (the "top of the P" / cave interior)
    for (let k = gap.i + 1; k < gap.j; k++) {
      processed.add(k);
    }
    
    currentIdx = gap.j;
  }
  
  for (let k = currentIdx; k < n; k++) {
    if (!processed.has(k)) {
      result.push(points[k]);
    }
  }
  
  // Apply smoothing pass to eliminate wave artifacts from gap closing
  if (result.length >= 10 && refinedGaps.length > 0) {
    return smoothBridgeAreasForGaps(result);
  }
  
  return result.length >= 3 ? result : points;
}

// Smooth the path to eliminate wave artifacts from gap closing
function smoothBridgeAreasForGaps(points: Point[]): Point[] {
  if (points.length < 10) return points;
  
  const n = points.length;
  const result: Point[] = [];
  
  for (let i = 0; i < n; i++) {
    if (i === 0 || i === n - 1) {
      result.push(points[i]);
    } else {
      const prev = points[i - 1];
      const curr = points[i];
      const next = points[i + 1];
      
      const dx1 = curr.x - prev.x;
      const dy1 = curr.y - prev.y;
      const dx2 = next.x - curr.x;
      const dy2 = next.y - curr.y;
      
      const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
      const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
      
      if (len1 > 0.1 && len2 > 0.1) {
        const dot = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
        
        if (dot < 0.5) {
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

// Generate U-shaped merge path (for outward curves)
function generateUShape(start: Point, end: Point, depth: number): Point[] {
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  
  // Direction perpendicular to the line between start and end
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return [start, end];
  
  // Perpendicular direction (outward)
  const perpX = -dy / len;
  const perpY = dx / len;
  
  // Create U shape with 3 control points
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
function generateNShape(start: Point, end: Point, depth: number): Point[] {
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return [start, end];
  
  // Perpendicular direction (inward - opposite of U)
  const perpX = dy / len;
  const perpY = -dx / len;
  
  // Create gentle N shape
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

// Detect sharp direction changes and insert appropriate merge shapes
function flattenConcaveVertices(points: Point[]): Point[] {
  if (points.length < 6) return points;
  
  const result: Point[] = [];
  const n = points.length;
  
  let i = 0;
  while (i < n) {
    const prevIdx = (i - 1 + n) % n;
    const prev = points[prevIdx];
    const curr = points[i];
    const next = points[(i + 1) % n];
    
    // Calculate vectors
    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    
    const len1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const len2 = Math.sqrt(v2x * v2x + v2y * v2y);
    
    if (len1 > 0 && len2 > 0) {
      // Calculate angle between vectors
      const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
      const cross = v1x * v2y - v1y * v2x;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
      
      // Sharp turn detected (more than 60 degrees)
      if (angle > Math.PI / 3) {
        // Calculate merge depth based on how sharp the turn is
        const sharpness = angle / Math.PI; // 0 to 1
        const baseDepth = Math.min(len1, len2) * 0.3;
        const depth = baseDepth * (0.5 + sharpness * 0.5);
        
        // Determine if concave (cross < 0) or convex (cross > 0)
        if (cross < 0) {
          // Concave turn - use N shape to smooth inward
          // Remove any previous points that would overshoot
          trimOvershootingPoints(result, curr, 3);
          
          const mergePoints = generateNShape(prev, next, depth);
          for (let m = 1; m < mergePoints.length - 1; m++) {
            result.push(mergePoints[m]);
          }
          // Skip ahead past any points that would continue the overshoot
          i = skipOvershootingPoints(points, i + 1, next, n);
          continue;
        } else if (cross > 0 && angle > Math.PI / 2) {
          // Very sharp convex turn - use U shape
          trimOvershootingPoints(result, curr, 3);
          
          const mergePoints = generateUShape(prev, next, depth);
          for (let m = 1; m < mergePoints.length - 1; m++) {
            result.push(mergePoints[m]);
          }
          i = skipOvershootingPoints(points, i + 1, next, n);
          continue;
        }
      }
    }
    
    result.push(curr);
    i++;
  }
  
  // Final pass: remove any remaining overshoot artifacts
  return removeOvershootArtifacts(result);
}

// Remove points from result that overshoot past the merge point
function trimOvershootingPoints(result: Point[], mergePoint: Point, lookback: number): void {
  if (result.length < 2) return;
  
  // Check last few points - if they're moving away from where the merge will connect, remove them
  for (let trim = 0; trim < Math.min(lookback, result.length - 1); trim++) {
    const lastIdx = result.length - 1;
    const last = result[lastIdx];
    const secondLast = result[lastIdx - 1];
    
    // Check if last point is further from merge than second last (overshooting)
    const distLast = Math.sqrt((last.x - mergePoint.x) ** 2 + (last.y - mergePoint.y) ** 2);
    const distSecond = Math.sqrt((secondLast.x - mergePoint.x) ** 2 + (secondLast.y - mergePoint.y) ** 2);
    
    if (distLast > distSecond + 2) {
      result.pop(); // Remove the overshooting point
    } else {
      break;
    }
  }
}

// Skip points that would continue past the merge
function skipOvershootingPoints(points: Point[], startIdx: number, targetPoint: Point, n: number): number {
  let idx = startIdx;
  let prevDist = Infinity;
  
  // Skip points that are moving away from the target
  while (idx < n) {
    const p = points[idx];
    const dist = Math.sqrt((p.x - targetPoint.x) ** 2 + (p.y - targetPoint.y) ** 2);
    
    if (dist < prevDist || dist < 5) {
      // Getting closer or close enough - stop skipping
      break;
    }
    
    prevDist = dist;
    idx++;
  }
  
  return idx;
}

// Remove remaining overshoot artifacts (points that stick out)
function removeOvershootArtifacts(points: Point[]): Point[] {
  if (points.length < 5) return points;
  
  const result: Point[] = [];
  const n = points.length;
  
  for (let i = 0; i < n; i++) {
    const prev2 = points[(i - 2 + n) % n];
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    const next2 = points[(i + 2) % n];
    
    // Check if this point sticks out (further from the line between neighbors)
    const lineX = next.x - prev.x;
    const lineY = next.y - prev.y;
    const lineLen = Math.sqrt(lineX * lineX + lineY * lineY);
    
    if (lineLen > 0) {
      // Distance from curr to line between prev and next
      const toPointX = curr.x - prev.x;
      const toPointY = curr.y - prev.y;
      const cross = Math.abs(lineX * toPointY - lineY * toPointX) / lineLen;
      
      // If point sticks out significantly compared to its neighbors
      const prevCross = Math.abs(lineX * (prev2.y - prev.y) - lineY * (prev2.x - prev.x)) / lineLen;
      const nextCross = Math.abs(lineX * (next2.y - prev.y) - lineY * (next2.x - prev.x)) / lineLen;
      
      // Skip this point if it's a spike (much further from line than neighbors)
      if (cross > 10 && cross > prevCross * 2 && cross > nextCross * 2) {
        continue; // Skip this overshooting point
      }
    }
    
    result.push(curr);
  }
  
  return result.length >= 3 ? result : points;
}

// Remove tight loops where the path doubles back on itself
function removeTightLoops(points: Point[]): Point[] {
  if (points.length < 8) return points;
  
  const result: Point[] = [];
  const n = points.length;
  const skipUntil = new Set<number>();
  
  for (let i = 0; i < n; i++) {
    if (skipUntil.has(i)) continue;
    
    const pi = points[i];
    let foundLoop = false;
    
    // Check if any point ahead is very close (indicating a loop)
    for (let j = i + 4; j < Math.min(i + 30, n); j++) {
      const pj = points[j];
      const dist = Math.sqrt((pi.x - pj.x) ** 2 + (pi.y - pj.y) ** 2);
      
      if (dist < 4) {
        // Found a loop - skip all points in between
        for (let k = i + 1; k < j; k++) {
          skipUntil.add(k);
        }
        foundLoop = true;
        break;
      }
    }
    
    result.push(pi);
  }
  
  return result.length >= 3 ? result : points;
}

// Fix near-intersections where lines come very close but don't technically cross
function fixNearIntersections(points: Point[]): Point[] {
  if (points.length < 6) return points;
  
  const result: Point[] = [];
  const minDistance = 2; // Minimum distance threshold in pixels
  
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    let tooClose = false;
    
    // Check if this point is too close to any non-adjacent segment
    for (let j = 0; j < points.length - 1; j++) {
      // Skip adjacent segments
      if (Math.abs(i - j) <= 2 || Math.abs(i - j) >= points.length - 2) continue;
      
      const segStart = points[j];
      const segEnd = points[j + 1];
      
      const dist = pointToSegmentDistance(current, segStart, segEnd);
      
      if (dist < minDistance) {
        tooClose = true;
        break;
      }
    }
    
    if (!tooClose) {
      result.push(current);
    }
  }
  
  return result.length >= 3 ? result : points;
}

// Calculate distance from point to line segment
function pointToSegmentDistance(p: Point, segStart: Point, segEnd: Point): number {
  const dx = segEnd.x - segStart.x;
  const dy = segEnd.y - segStart.y;
  const lengthSq = dx * dx + dy * dy;
  
  if (lengthSq === 0) {
    return Math.sqrt((p.x - segStart.x) ** 2 + (p.y - segStart.y) ** 2);
  }
  
  let t = ((p.x - segStart.x) * dx + (p.y - segStart.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  
  const nearestX = segStart.x + t * dx;
  const nearestY = segStart.y + t * dy;
  
  return Math.sqrt((p.x - nearestX) ** 2 + (p.y - nearestY) ** 2);
}

// Check if two line segments intersect and return the intersection point
function lineSegmentIntersection(
  p1: Point, p2: Point, 
  p3: Point, p4: Point
): Point | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  
  const cross = d1x * d2y - d1y * d2x;
  
  // Lines are parallel or nearly parallel
  if (Math.abs(cross) < 0.0001) return null;
  
  const dx = p3.x - p1.x;
  const dy = p3.y - p1.y;
  
  const t = (dx * d2y - dy * d2x) / cross;
  const u = (dx * d1y - dy * d1x) / cross;
  
  // Check if intersection is within both segments (very small margin for better detection)
  const margin = 0.001;
  if (t > margin && t < 1 - margin && u > margin && u < 1 - margin) {
    return {
      x: p1.x + t * d1x,
      y: p1.y + t * d1y
    };
  }
  
  return null;
}

// Remove spikes/bumps by detecting points that deviate significantly from the line between neighbors
function removeSpikes(points: Point[], neighborDistance: number, threshold: number): Point[] {
  if (points.length < neighborDistance * 2 + 3) return points;
  
  const result: Point[] = [];
  const isSpike = new Array(points.length).fill(false);
  
  // Detect spikes: points where the angle formed is too sharp or deviation is too large
  for (let i = 0; i < points.length; i++) {
    const prevIdx = (i - neighborDistance + points.length) % points.length;
    const nextIdx = (i + neighborDistance) % points.length;
    
    const prev = points[prevIdx];
    const curr = points[i];
    const next = points[nextIdx];
    
    // Calculate the expected position (midpoint of prev and next)
    const expectedX = (prev.x + next.x) / 2;
    const expectedY = (prev.y + next.y) / 2;
    
    // Calculate distance from expected to actual
    const deviation = Math.sqrt((curr.x - expectedX) ** 2 + (curr.y - expectedY) ** 2);
    
    // Calculate the distance between prev and next
    const spanDistance = Math.sqrt((next.x - prev.x) ** 2 + (next.y - prev.y) ** 2);
    
    // If deviation is large relative to the span, it's likely a spike
    if (spanDistance > 0 && deviation / spanDistance > threshold) {
      // Check if this creates a sharp angle (spike detection)
      const v1x = curr.x - prev.x;
      const v1y = curr.y - prev.y;
      const v2x = next.x - curr.x;
      const v2y = next.y - curr.y;
      
      const dot = v1x * v2x + v1y * v2y;
      const mag1 = Math.sqrt(v1x * v1x + v1y * v1y);
      const mag2 = Math.sqrt(v2x * v2x + v2y * v2y);
      
      if (mag1 > 0 && mag2 > 0) {
        const cosAngle = dot / (mag1 * mag2);
        // If angle is sharp (cosine closer to -1), mark as spike
        if (cosAngle < 0.3) {
          isSpike[i] = true;
        }
      }
    }
  }
  
  // Replace spikes with interpolated positions
  for (let i = 0; i < points.length; i++) {
    if (isSpike[i]) {
      // Find non-spike neighbors
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
      
      // Interpolate
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

function perpendicularDistance(point: Point, lineStart: Point, lineEnd: Point): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  
  if (dx === 0 && dy === 0) {
    return Math.sqrt((point.x - lineStart.x) ** 2 + (point.y - lineStart.y) ** 2);
  }
  
  const t = Math.max(0, Math.min(1,
    ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / (dx * dx + dy * dy)
  ));
  
  const nearestX = lineStart.x + t * dx;
  const nearestY = lineStart.y + t * dy;
  
  return Math.sqrt((point.x - nearestX) ** 2 + (point.y - nearestY) ** 2);
}

function drawSmoothContour(ctx: CanvasRenderingContext2D, contour: Point[], color: string, offsetX: number, offsetY: number): void {
  if (contour.length < 3) return;
  
  // Final cleanup before drawing - focus on removing problematic areas
  let cleanContour = removeSelfIntersections(contour);
  cleanContour = removeNarrowConcaveRegions(cleanContour);
  cleanContour = removeSelfIntersections(cleanContour);

  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  
  // Add subtle shadow for visibility
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
  ctx.shadowBlur = 2;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 1;

  ctx.beginPath();
  
  // Start from the first point
  const start = cleanContour[0];
  ctx.moveTo(start.x + offsetX, start.y + offsetY);
  
  // Use simple quadratic curves that never cross - safer than bezier
  for (let i = 0; i < cleanContour.length; i++) {
    const p1 = cleanContour[i];
    const p2 = cleanContour[(i + 1) % cleanContour.length];
    
    // Simple midpoint curve - guaranteed not to create crossings
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    
    ctx.lineTo(midX + offsetX, midY + offsetY);
  }
  
  ctx.closePath();
  ctx.stroke();
  
  // Reset shadow
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
}

// Get contour path points for vector export
export function getContourPath(
  image: HTMLImageElement,
  strokeSettings: StrokeSettings,
  resizeSettings: ResizeSettings
): ContourPathResult | null {
  const effectiveDPI = image.width / resizeSettings.widthInches;
  
  const baseOffsetInches = 0.015;
  const baseOffsetPixels = Math.round(baseOffsetInches * effectiveDPI);
  
  const autoBridgeInches = 0.02;
  const autoBridgePixels = Math.round(autoBridgeInches * effectiveDPI);
  
  let gapClosePixels = 0;
  if (strokeSettings.autoBridging) {
    gapClosePixels = Math.round(strokeSettings.autoBridgingThreshold * effectiveDPI);
  }
  
  const userOffsetPixels = Math.round(strokeSettings.width * effectiveDPI);
  const totalOffsetPixels = baseOffsetPixels + userOffsetPixels;
  
  try {
    const silhouetteMask = createSilhouetteMask(image);
    if (silhouetteMask.length === 0) return null;
    
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
    }
    
    const baseDilatedMask = dilateSilhouette(bridgedMask, image.width, image.height, baseOffsetPixels);
    const baseWidth = image.width + baseOffsetPixels * 2;
    const baseHeight = image.height + baseOffsetPixels * 2;
    
    const filledMask = fillSilhouette(baseDilatedMask, baseWidth, baseHeight);
    
    const finalDilatedMask = dilateSilhouette(filledMask, baseWidth, baseHeight, userOffsetPixels);
    const dilatedWidth = baseWidth + userOffsetPixels * 2;
    const dilatedHeight = baseHeight + userOffsetPixels * 2;
    
    const boundaryPath = traceBoundary(finalDilatedMask, dilatedWidth, dilatedHeight);
    
    if (boundaryPath.length < 3) return null;
    
    const smoothedPath = smoothPath(boundaryPath, 2);
    
    // Convert to inches and flip Y for PDF coordinate system (Y=0 at bottom)
    const widthInches = dilatedWidth / effectiveDPI;
    const heightInches = dilatedHeight / effectiveDPI;
    
    // Flip Y coordinates so (0,0) is bottom-left instead of top-left
    const pathInInches = smoothedPath.map(p => ({
      x: p.x / effectiveDPI,
      y: heightInches - (p.y / effectiveDPI) // Flip Y
    }));
    
    const imageOffsetX = totalOffsetPixels / effectiveDPI;
    const imageOffsetY = totalOffsetPixels / effectiveDPI;
    
    return {
      pathPoints: pathInInches,
      widthInches,
      heightInches,
      imageOffsetX,
      imageOffsetY
    };
  } catch (error) {
    console.error('Error getting contour path:', error);
    return null;
  }
}

// Download PDF with raster image and vector contour using spot color "CutContour"
export async function downloadContourPDF(
  image: HTMLImageElement,
  strokeSettings: StrokeSettings,
  resizeSettings: ResizeSettings,
  filename: string
): Promise<void> {
  const contourResult = getContourPath(image, strokeSettings, resizeSettings);
  if (!contourResult) {
    console.error('Failed to generate contour path');
    return;
  }
  
  const { pathPoints, widthInches, heightInches, imageOffsetX, imageOffsetY } = contourResult;
  
  // Convert inches to points (72 points per inch)
  const widthPts = widthInches * 72;
  const heightPts = heightInches * 72;
  
  // Create PDF document
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([widthPts, heightPts]);
  
  // Create a canvas to get the image as PNG bytes
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) return;
  
  tempCanvas.width = image.width;
  tempCanvas.height = image.height;
  tempCtx.drawImage(image, 0, 0);
  
  // Get PNG data as blob then array buffer
  const blob = await new Promise<Blob>((resolve) => {
    tempCanvas.toBlob((b) => resolve(b!), 'image/png');
  });
  const pngBytes = new Uint8Array(await blob.arrayBuffer());
  
  // Embed the PNG image
  const pngImage = await pdfDoc.embedPng(pngBytes);
  
  // Draw image on page (convert inches to points)
  // Path points are already flipped to PDF coordinates (Y=0 at bottom)
  // Image Y position: imageOffsetY is from the BOTTOM in this coordinate system
  const imageXPts = imageOffsetX * 72;
  const imageWidthPts = resizeSettings.widthInches * 72;
  const imageHeightPts = resizeSettings.heightInches * 72;
  const imageYPts = imageOffsetY * 72; // Y from bottom
  
  page.drawImage(pngImage, {
    x: imageXPts,
    y: imageYPts,
    width: imageWidthPts,
    height: imageHeightPts,
  });
  
  // Build the contour path as PDF operators with spot color
  if (pathPoints.length > 2) {
    // Create spot color "CutContour" using Separation color space
    // The path will be drawn using raw PDF content stream operators
    const context = pdfDoc.context;
    
    // Create the tint transform function (maps 1.0 tint to magenta in CMYK)
    const tintFunction = context.obj({
      FunctionType: 2,
      Domain: [0, 1],
      C0: [0, 0, 0, 0],  // 0% tint = no color
      C1: [0, 1, 0, 0],  // 100% tint = magenta (in CMYK)
      N: 1,
    });
    const tintFunctionRef = context.register(tintFunction);
    
    // Create the Separation color space array
    const separationColorSpace = context.obj([
      PDFName.of('Separation'),
      PDFName.of('CutContour'),
      PDFName.of('DeviceCMYK'),
      tintFunctionRef,
    ]);
    const separationRef = context.register(separationColorSpace);
    
    // Add color space to page resources
    const resources = page.node.Resources();
    if (resources) {
      let colorSpaceDict = resources.get(PDFName.of('ColorSpace'));
      if (!colorSpaceDict) {
        colorSpaceDict = context.obj({});
        resources.set(PDFName.of('ColorSpace'), colorSpaceDict);
      }
      (colorSpaceDict as PDFDict).set(PDFName.of('CutContour'), separationRef);
    }
    
    // Build path operators
    let pathOps = '';
    
    // Set spot color for stroking: /CutContour CS 1 SCN
    pathOps += '/CutContour CS 1 SCN\n';
    
    // Set line width (0.5 points = thin line for cutting)
    pathOps += '0.5 w\n';
    
    // Move to first point (convert to points, Y already flipped in path data)
    const startX = pathPoints[0].x * 72;
    const startY = pathPoints[0].y * 72;
    pathOps += `${startX.toFixed(4)} ${startY.toFixed(4)} m\n`;
    
    // Draw smooth bezier curves
    for (let i = 0; i < pathPoints.length; i++) {
      const p0 = pathPoints[(i - 1 + pathPoints.length) % pathPoints.length];
      const p1 = pathPoints[i];
      const p2 = pathPoints[(i + 1) % pathPoints.length];
      const p3 = pathPoints[(i + 2) % pathPoints.length];
      
      const tension = 0.5;
      const cp1x = (p1.x + (p2.x - p0.x) * tension / 3) * 72;
      const cp1y = (p1.y + (p2.y - p0.y) * tension / 3) * 72;
      const cp2x = (p2.x - (p3.x - p1.x) * tension / 3) * 72;
      const cp2y = (p2.y - (p3.y - p1.y) * tension / 3) * 72;
      const endX = p2.x * 72;
      const endY = p2.y * 72;
      
      pathOps += `${cp1x.toFixed(4)} ${cp1y.toFixed(4)} ${cp2x.toFixed(4)} ${cp2y.toFixed(4)} ${endX.toFixed(4)} ${endY.toFixed(4)} c\n`;
    }
    
    // Close and stroke
    pathOps += 'h S\n';
    
    // Append to page content stream
    const existingContents = page.node.Contents();
    if (existingContents) {
      // Get existing content and append our path
      const contentStream = context.stream(pathOps);
      const contentStreamRef = context.register(contentStream);
      
      // Create array with existing content + new content
      if (existingContents instanceof PDFArray) {
        existingContents.push(contentStreamRef);
      } else {
        const newContents = context.obj([existingContents, contentStreamRef]);
        page.node.set(PDFName.of('Contents'), newContents);
      }
    }
  }
  
  // Set PDF metadata
  pdfDoc.setTitle('Sticker with CutContour');
  pdfDoc.setSubject('Contains CutContour spot color for cutting machines');
  pdfDoc.setKeywords(['CutContour', 'spot color', 'cutting', 'vector']);
  
  // Save and download
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
}

// Download PDF with shape background and CutContour spot color outline
export async function downloadShapePDF(
  image: HTMLImageElement,
  shapeSettings: ShapeSettings,
  resizeSettings: ResizeSettings,
  filename: string
): Promise<void> {
  // Calculate dimensions in points (72 points per inch)
  const widthPts = shapeSettings.widthInches * 72;
  const heightPts = shapeSettings.heightInches * 72;
  
  // Create PDF document
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([widthPts, heightPts]);
  const context = pdfDoc.context;
  
  // Parse fill color from hex to RGB (0-1 range)
  const hexToRgb = (hex: string) => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16) / 255,
      g: parseInt(result[2], 16) / 255,
      b: parseInt(result[3], 16) / 255
    } : { r: 1, g: 1, b: 1 };
  };
  
  const fillColor = hexToRgb(shapeSettings.fillColor);
  
  // Center coordinates
  const cx = widthPts / 2;
  const cy = heightPts / 2;
  
  // No shape fill - only draw the cutline outline later
  
  // Crop image to remove empty space
  const croppedCanvas = cropImageToContent(image);
  let imageCanvas: HTMLCanvasElement;
  
  if (croppedCanvas) {
    imageCanvas = croppedCanvas;
  } else {
    imageCanvas = document.createElement('canvas');
    imageCanvas.width = image.width;
    imageCanvas.height = image.height;
    const ctx = imageCanvas.getContext('2d');
    if (ctx) ctx.drawImage(image, 0, 0);
  }
  
  // Get PNG bytes from cropped image
  const blob = await new Promise<Blob>((resolve) => {
    imageCanvas.toBlob((b) => resolve(b!), 'image/png');
  });
  const pngBytes = new Uint8Array(await blob.arrayBuffer());
  
  // Embed image
  const pngImage = await pdfDoc.embedPng(pngBytes);
  
  // Calculate image size based on resize settings (same as preview)
  const imageWidth = resizeSettings.widthInches * 72; // Convert inches to points
  const imageHeight = resizeSettings.heightInches * 72;
  
  // Image position: centered with optional offset
  // Offset is stored at 300 DPI scale, convert to PDF points (72 per inch)
  // Canvas Y increases downward, PDF Y increases upward - flip Y offset
  const dpiToPoints = 72 / 300; // Convert 300 DPI pixels to points
  const offsetXPts = (shapeSettings.offsetX || 0) * dpiToPoints;
  const offsetYPts = (shapeSettings.offsetY || 0) * dpiToPoints;
  const imageX = (widthPts - imageWidth) / 2 + offsetXPts;
  const imageY = (heightPts - imageHeight) / 2 - offsetYPts; // Flip Y: canvas down = PDF up
  
  // Use pdf-lib's drawImage (same as working contour PDF)
  page.drawImage(pngImage, {
    x: imageX,
    y: imageY,
    width: imageWidth,
    height: imageHeight,
  });
  
  // Get resources for adding color space
  let resources = page.node.Resources();
  
  // Create CutContour spot color
  const tintFunction = context.obj({
    FunctionType: 2,
    Domain: [0, 1],
    C0: [0, 0, 0, 0],
    C1: [0, 1, 0, 0], // Magenta in CMYK
    N: 1,
  });
  const tintFunctionRef = context.register(tintFunction);
  
  const separationColorSpace = context.obj([
    PDFName.of('Separation'),
    PDFName.of('CutContour'),
    PDFName.of('DeviceCMYK'),
    tintFunctionRef,
  ]);
  const separationRef = context.register(separationColorSpace);
  
  // Add color space to page resources
  if (resources) {
    let colorSpaceDict = resources.get(PDFName.of('ColorSpace'));
    if (!colorSpaceDict) {
      colorSpaceDict = context.obj({});
      resources.set(PDFName.of('ColorSpace'), colorSpaceDict);
    }
    (colorSpaceDict as PDFDict).set(PDFName.of('CutContour'), separationRef);
  }
  
  // Build shape outline path with CutContour spot color
  let pathOps = 'q\n'; // Save graphics state
  pathOps += '/CutContour CS 1 SCN\n';
  pathOps += '0.5 w\n'; // Line width
  
  // Calculate outline center - use page center (same as shape would be)
  const outlineCx = cx;
  const outlineCy = cy;
  
  if (shapeSettings.type === 'circle') {
    const r = Math.min(widthPts, heightPts) / 2;
    const k = 0.5522847498;
    const rk = r * k;
    // Circle uses same center as other shapes (no offset needed)
    const circleCy = outlineCy;
    pathOps += `${outlineCx + r} ${circleCy} m\n`;
    pathOps += `${outlineCx + r} ${circleCy + rk} ${outlineCx + rk} ${circleCy + r} ${outlineCx} ${circleCy + r} c\n`;
    pathOps += `${outlineCx - rk} ${circleCy + r} ${outlineCx - r} ${circleCy + rk} ${outlineCx - r} ${circleCy} c\n`;
    pathOps += `${outlineCx - r} ${circleCy - rk} ${outlineCx - rk} ${circleCy - r} ${outlineCx} ${circleCy - r} c\n`;
    pathOps += `${outlineCx + rk} ${circleCy - r} ${outlineCx + r} ${circleCy - rk} ${outlineCx + r} ${circleCy} c\n`;
  } else if (shapeSettings.type === 'oval') {
    const rx = widthPts / 2;
    const ry = heightPts / 2;
    const k = 0.5522847498;
    const rxk = rx * k;
    const ryk = ry * k;
    pathOps += `${outlineCx + rx} ${outlineCy} m\n`;
    pathOps += `${outlineCx + rx} ${outlineCy + ryk} ${outlineCx + rxk} ${outlineCy + ry} ${outlineCx} ${outlineCy + ry} c\n`;
    pathOps += `${outlineCx - rxk} ${outlineCy + ry} ${outlineCx - rx} ${outlineCy + ryk} ${outlineCx - rx} ${outlineCy} c\n`;
    pathOps += `${outlineCx - rx} ${outlineCy - ryk} ${outlineCx - rxk} ${outlineCy - ry} ${outlineCx} ${outlineCy - ry} c\n`;
    pathOps += `${outlineCx + rxk} ${outlineCy - ry} ${outlineCx + rx} ${outlineCy - ryk} ${outlineCx + rx} ${outlineCy} c\n`;
  } else if (shapeSettings.type === 'square') {
    const size = Math.min(widthPts, heightPts);
    const sx = (widthPts - size) / 2;
    const sy = (heightPts - size) / 2;
    pathOps += `${sx} ${sy} m\n`;
    pathOps += `${sx + size} ${sy} l\n`;
    pathOps += `${sx + size} ${sy + size} l\n`;
    pathOps += `${sx} ${sy + size} l\n`;
  } else {
    // Rectangle - full page
    pathOps += `0 0 m\n`;
    pathOps += `${widthPts} 0 l\n`;
    pathOps += `${widthPts} ${heightPts} l\n`;
    pathOps += `0 ${heightPts} l\n`;
  }
  
  pathOps += 'h S\n'; // Close and stroke
  pathOps += 'Q\n'; // Restore graphics state
  
  // Create outline content stream
  const outlineStream = context.stream(pathOps);
  const outlineStreamRef = context.register(outlineStream);
  
  // Append outline to existing page contents (shape fill + image already drawn by pdf-lib)
  const existingContents = page.node.Contents();
  
  if (existingContents instanceof PDFArray) {
    existingContents.push(outlineStreamRef);
  } else if (existingContents) {
    const contentsArray = context.obj([existingContents, outlineStreamRef]);
    page.node.set(PDFName.of('Contents'), contentsArray);
  } else {
    page.node.set(PDFName.of('Contents'), outlineStreamRef);
  }
  
  // Set PDF metadata
  pdfDoc.setTitle('Shape with CutContour');
  pdfDoc.setSubject('Contains CutContour spot color for cutting machines');
  pdfDoc.setKeywords(['CutContour', 'spot color', 'cutting', 'vector', 'shape']);
  
  // Save and download
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
}

// Generate Contour PDF as base64 string (for email attachment)
export async function generateContourPDFBase64(
  image: HTMLImageElement,
  strokeSettings: StrokeSettings,
  resizeSettings: ResizeSettings
): Promise<string | null> {
  const contourResult = getContourPath(image, strokeSettings, resizeSettings);
  if (!contourResult) {
    console.error('Failed to generate contour path');
    return null;
  }
  
  const { pathPoints, widthInches, heightInches, imageOffsetX, imageOffsetY } = contourResult;
  
  const widthPts = widthInches * 72;
  const heightPts = heightInches * 72;
  
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([widthPts, heightPts]);
  
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) return null;
  
  tempCanvas.width = image.width;
  tempCanvas.height = image.height;
  tempCtx.drawImage(image, 0, 0);
  
  const blob = await new Promise<Blob>((resolve) => {
    tempCanvas.toBlob((b) => resolve(b!), 'image/png');
  });
  const pngBytes = new Uint8Array(await blob.arrayBuffer());
  
  const pngImage = await pdfDoc.embedPng(pngBytes);
  
  const imageXPts = imageOffsetX * 72;
  const imageWidthPts = resizeSettings.widthInches * 72;
  const imageHeightPts = resizeSettings.heightInches * 72;
  const imageYPts = imageOffsetY * 72;
  
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
      PDFName.of('CutContour'),
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
      (colorSpaceDict as PDFDict).set(PDFName.of('CutContour'), separationRef);
    }
    
    let pathOps = '';
    pathOps += '/CutContour CS 1 SCN\n';
    pathOps += '0.5 w\n';
    
    const startX = pathPoints[0].x * 72;
    const startY = pathPoints[0].y * 72;
    pathOps += `${startX.toFixed(4)} ${startY.toFixed(4)} m\n`;
    
    for (let i = 0; i < pathPoints.length; i++) {
      const p0 = pathPoints[(i - 1 + pathPoints.length) % pathPoints.length];
      const p1 = pathPoints[i];
      const p2 = pathPoints[(i + 1) % pathPoints.length];
      const p3 = pathPoints[(i + 2) % pathPoints.length];
      
      const tension = 0.5;
      const cp1x = (p1.x + (p2.x - p0.x) * tension / 3) * 72;
      const cp1y = (p1.y + (p2.y - p0.y) * tension / 3) * 72;
      const cp2x = (p2.x - (p3.x - p1.x) * tension / 3) * 72;
      const cp2y = (p2.y - (p3.y - p1.y) * tension / 3) * 72;
      const endX = p2.x * 72;
      const endY = p2.y * 72;
      
      pathOps += `${cp1x.toFixed(4)} ${cp1y.toFixed(4)} ${cp2x.toFixed(4)} ${cp2y.toFixed(4)} ${endX.toFixed(4)} ${endY.toFixed(4)} c\n`;
    }
    
    pathOps += 'h S\n';
    
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
  
  pdfDoc.setTitle('Sticker with CutContour');
  pdfDoc.setSubject('Contains CutContour spot color for cutting machines');
  
  const pdfBytes = await pdfDoc.save();
  
  let binary = '';
  for (let i = 0; i < pdfBytes.length; i++) {
    binary += String.fromCharCode(pdfBytes[i]);
  }
  return btoa(binary);
}

// Generate Shape PDF as base64 string (for email attachment)
export async function generateShapePDFBase64(
  image: HTMLImageElement,
  shapeSettings: ShapeSettings,
  resizeSettings: ResizeSettings
): Promise<string | null> {
  const widthPts = shapeSettings.widthInches * 72;
  const heightPts = shapeSettings.heightInches * 72;
  
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([widthPts, heightPts]);
  const context = pdfDoc.context;
  
  const cx = widthPts / 2;
  const cy = heightPts / 2;
  
  const croppedCanvas = cropImageToContent(image);
  let imageCanvas: HTMLCanvasElement;
  
  if (croppedCanvas) {
    imageCanvas = croppedCanvas;
  } else {
    imageCanvas = document.createElement('canvas');
    imageCanvas.width = image.width;
    imageCanvas.height = image.height;
    const ctx = imageCanvas.getContext('2d');
    if (ctx) ctx.drawImage(image, 0, 0);
  }
  
  const blob = await new Promise<Blob>((resolve) => {
    imageCanvas.toBlob((b) => resolve(b!), 'image/png');
  });
  const pngBytes = new Uint8Array(await blob.arrayBuffer());
  
  const pngImage = await pdfDoc.embedPng(pngBytes);
  
  const imageWidth = resizeSettings.widthInches * 72;
  const imageHeight = resizeSettings.heightInches * 72;
  
  const dpiToPoints = 72 / 300;
  const offsetXPts = (shapeSettings.offsetX || 0) * dpiToPoints;
  const offsetYPts = (shapeSettings.offsetY || 0) * dpiToPoints;
  const imageX = (widthPts - imageWidth) / 2 + offsetXPts;
  const imageY = (heightPts - imageHeight) / 2 - offsetYPts;
  
  page.drawImage(pngImage, {
    x: imageX,
    y: imageY,
    width: imageWidth,
    height: imageHeight,
  });
  
  let resources = page.node.Resources();
  
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
    PDFName.of('CutContour'),
    PDFName.of('DeviceCMYK'),
    tintFunctionRef,
  ]);
  const separationRef = context.register(separationColorSpace);
  
  if (resources) {
    let colorSpaceDict = resources.get(PDFName.of('ColorSpace'));
    if (!colorSpaceDict) {
      colorSpaceDict = context.obj({});
      resources.set(PDFName.of('ColorSpace'), colorSpaceDict);
    }
    (colorSpaceDict as PDFDict).set(PDFName.of('CutContour'), separationRef);
  }
  
  let pathOps = 'q\n';
  pathOps += '/CutContour CS 1 SCN\n';
  pathOps += '0.5 w\n';
  
  const outlineCx = cx;
  const outlineCy = cy;
  
  if (shapeSettings.type === 'circle') {
    const r = Math.min(widthPts, heightPts) / 2;
    const k = 0.5522847498;
    const rk = r * k;
    const circleCy = outlineCy;
    pathOps += `${outlineCx + r} ${circleCy} m\n`;
    pathOps += `${outlineCx + r} ${circleCy + rk} ${outlineCx + rk} ${circleCy + r} ${outlineCx} ${circleCy + r} c\n`;
    pathOps += `${outlineCx - rk} ${circleCy + r} ${outlineCx - r} ${circleCy + rk} ${outlineCx - r} ${circleCy} c\n`;
    pathOps += `${outlineCx - r} ${circleCy - rk} ${outlineCx - rk} ${circleCy - r} ${outlineCx} ${circleCy - r} c\n`;
    pathOps += `${outlineCx + rk} ${circleCy - r} ${outlineCx + r} ${circleCy - rk} ${outlineCx + r} ${circleCy} c\n`;
  } else if (shapeSettings.type === 'oval') {
    const rx = widthPts / 2;
    const ry = heightPts / 2;
    const k = 0.5522847498;
    const rxk = rx * k;
    const ryk = ry * k;
    pathOps += `${outlineCx + rx} ${outlineCy} m\n`;
    pathOps += `${outlineCx + rx} ${outlineCy + ryk} ${outlineCx + rxk} ${outlineCy + ry} ${outlineCx} ${outlineCy + ry} c\n`;
    pathOps += `${outlineCx - rxk} ${outlineCy + ry} ${outlineCx - rx} ${outlineCy + ryk} ${outlineCx - rx} ${outlineCy} c\n`;
    pathOps += `${outlineCx - rx} ${outlineCy - ryk} ${outlineCx - rxk} ${outlineCy - ry} ${outlineCx} ${outlineCy - ry} c\n`;
    pathOps += `${outlineCx + rxk} ${outlineCy - ry} ${outlineCx + rx} ${outlineCy - ryk} ${outlineCx + rx} ${outlineCy} c\n`;
  } else if (shapeSettings.type === 'square') {
    const size = Math.min(widthPts, heightPts);
    const sx = (widthPts - size) / 2;
    const sy = (heightPts - size) / 2;
    pathOps += `${sx} ${sy} m\n`;
    pathOps += `${sx + size} ${sy} l\n`;
    pathOps += `${sx + size} ${sy + size} l\n`;
    pathOps += `${sx} ${sy + size} l\n`;
  } else {
    pathOps += `0 0 m\n`;
    pathOps += `${widthPts} 0 l\n`;
    pathOps += `${widthPts} ${heightPts} l\n`;
    pathOps += `0 ${heightPts} l\n`;
  }
  
  pathOps += 'h S\n';
  pathOps += 'Q\n';
  
  const outlineStream = context.stream(pathOps);
  const outlineStreamRef = context.register(outlineStream);
  
  const existingContents = page.node.Contents();
  
  if (existingContents instanceof PDFArray) {
    existingContents.push(outlineStreamRef);
  } else if (existingContents) {
    const contentsArray = context.obj([existingContents, outlineStreamRef]);
    page.node.set(PDFName.of('Contents'), contentsArray);
  } else {
    page.node.set(PDFName.of('Contents'), outlineStreamRef);
  }
  
  pdfDoc.setTitle('Shape with CutContour');
  pdfDoc.setSubject('Contains CutContour spot color for cutting machines');
  
  const pdfBytes = await pdfDoc.save();
  
  let binary = '';
  for (let i = 0; i < pdfBytes.length; i++) {
    binary += String.fromCharCode(pdfBytes[i]);
  }
  return btoa(binary);
}
