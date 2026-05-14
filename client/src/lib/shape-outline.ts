import type { ShapeSettings, ResizeSettings } from "@/lib/types";
import { PDFDocument, PDFName, PDFArray, PDFDict, type PDFImage } from 'pdf-lib';
import { cropImageToContent } from './image-crop';
import { simplifyPathForPDF, buildSmoothPdfPath, type SpotColorInput } from './contour-outline';
import { addSpotColorVectorsToPDF, type SpotPixelMapData } from './spot-color-vectors';

function rotatePoint(px: number, py: number, cx: number, cy: number, deg: number): { x: number; y: number } {
  if (deg === 0) return { x: px, y: py };
  const rad = deg * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

function drawRoundedRectOnCanvas(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number
) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function buildShapeClipPath(
  ctx: CanvasRenderingContext2D,
  type: ShapeSettings['type'],
  clipW: number, clipH: number,
  cornerRadius: number
) {
  ctx.beginPath();
  if (type === 'circle') {
    const r = Math.min(clipW, clipH) / 2;
    ctx.arc(clipW / 2, clipH / 2, r, 0, Math.PI * 2);
  } else if (type === 'oval') {
    ctx.ellipse(clipW / 2, clipH / 2, clipW / 2, clipH / 2, 0, 0, Math.PI * 2);
  } else if (type === 'rounded-square') {
    const size = Math.min(clipW, clipH);
    const sx = (clipW - size) / 2;
    const sy = (clipH - size) / 2;
    const r = Math.min(cornerRadius, size / 2);
    drawRoundedRectOnCanvas(ctx, sx, sy, size, size, r);
  } else if (type === 'rounded-rectangle') {
    const r = Math.min(cornerRadius, clipW / 2, clipH / 2);
    drawRoundedRectOnCanvas(ctx, 0, 0, clipW, clipH, r);
  } else if (type === 'square') {
    const size = Math.min(clipW, clipH);
    const sx = (clipW - size) / 2;
    const sy = (clipH - size) / 2;
    ctx.rect(sx, sy, size, size);
  } else {
    ctx.rect(0, 0, clipW, clipH);
  }
}

function generateShapePDFPath(
  shapeType: ShapeSettings['type'],
  cx: number, cy: number,
  shapeWidthPts: number, shapeHeightPts: number,
  pageWidthPts: number, pageHeightPts: number,
  cornerRadiusPts: number
): string {
  let path = '';
  const k = 0.5522847498;
  if (shapeType === 'circle') {
    const r = Math.min(shapeWidthPts, shapeHeightPts) / 2;
    const rk = r * k;
    path += `${cx + r} ${cy} m\n`;
    path += `${cx + r} ${cy + rk} ${cx + rk} ${cy + r} ${cx} ${cy + r} c\n`;
    path += `${cx - rk} ${cy + r} ${cx - r} ${cy + rk} ${cx - r} ${cy} c\n`;
    path += `${cx - r} ${cy - rk} ${cx - rk} ${cy - r} ${cx} ${cy - r} c\n`;
    path += `${cx + rk} ${cy - r} ${cx + r} ${cy - rk} ${cx + r} ${cy} c\n`;
  } else if (shapeType === 'oval') {
    const rx = shapeWidthPts / 2;
    const ry = shapeHeightPts / 2;
    const rxk = rx * k;
    const ryk = ry * k;
    path += `${cx + rx} ${cy} m\n`;
    path += `${cx + rx} ${cy + ryk} ${cx + rxk} ${cy + ry} ${cx} ${cy + ry} c\n`;
    path += `${cx - rxk} ${cy + ry} ${cx - rx} ${cy + ryk} ${cx - rx} ${cy} c\n`;
    path += `${cx - rx} ${cy - ryk} ${cx - rxk} ${cy - ry} ${cx} ${cy - ry} c\n`;
    path += `${cx + rxk} ${cy - ry} ${cx + rx} ${cy - ryk} ${cx + rx} ${cy} c\n`;
  } else if (shapeType === 'square') {
    const size = Math.min(shapeWidthPts, shapeHeightPts);
    const sx = (pageWidthPts - size) / 2;
    const sy = (pageHeightPts - size) / 2;
    path += `${sx} ${sy} m\n${sx + size} ${sy} l\n${sx + size} ${sy + size} l\n${sx} ${sy + size} l\n`;
  } else if (shapeType === 'rounded-square') {
    const size = Math.min(shapeWidthPts, shapeHeightPts);
    const sx = (pageWidthPts - size) / 2;
    const sy = (pageHeightPts - size) / 2;
    path += getRoundedRectPath(sx, sy, size, size, Math.min(cornerRadiusPts, size / 2));
  } else if (shapeType === 'rounded-rectangle') {
    const offsetX = (pageWidthPts - shapeWidthPts) / 2;
    const offsetY = (pageHeightPts - shapeHeightPts) / 2;
    path += getRoundedRectPath(offsetX, offsetY, shapeWidthPts, shapeHeightPts, Math.min(cornerRadiusPts, shapeWidthPts / 2, shapeHeightPts / 2));
  } else {
    const offsetX = (pageWidthPts - shapeWidthPts) / 2;
    const offsetY = (pageHeightPts - shapeHeightPts) / 2;
    path += `${offsetX} ${offsetY} m\n${offsetX + shapeWidthPts} ${offsetY} l\n${offsetX + shapeWidthPts} ${offsetY + shapeHeightPts} l\n${offsetX} ${offsetY + shapeHeightPts} l\n`;
  }
  return path;
}

function pdfRotationTransform(cx: number, cy: number, deg: number): string {
  if (deg === 0) return '';
  const rad = deg * Math.PI / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return `1 0 0 1 ${cx} ${cy} cm\n${c} ${s} ${-s} ${c} 0 0 cm\n1 0 0 1 ${-cx} ${-cy} cm\n`;
}

async function createClippedShapeImage(
  image: HTMLImageElement,
  shapeSettings: ShapeSettings,
  resizeSettings: ResizeSettings,
  shapeWidthInches: number,
  shapeHeightInches: number,
  pdfDoc: PDFDocument
): Promise<PDFImage> {
  const clipDPI = 300;
  const clipW = Math.round(shapeWidthInches * clipDPI);
  const clipH = Math.round(shapeHeightInches * clipDPI);
  const clipCanvas = document.createElement('canvas');
  clipCanvas.width = clipW;
  clipCanvas.height = clipH;
  const clipCtx = clipCanvas.getContext('2d')!;
  const rotation = shapeSettings.rotation || 0;
  const cornerRadiusPx = (shapeSettings.cornerRadius || 0.25) * clipDPI;

  clipCtx.save();
  if (rotation !== 0) {
    clipCtx.translate(clipW / 2, clipH / 2);
    clipCtx.rotate(rotation * Math.PI / 180);
    clipCtx.translate(-clipW / 2, -clipH / 2);
  }
  buildShapeClipPath(clipCtx, shapeSettings.type, clipW, clipH, cornerRadiusPx);
  clipCtx.clip();

  const croppedCanvas = cropImageToContent(image);
  const sourceImage = croppedCanvas || image;
  const scale = shapeSettings.imageScale || 1;
  const imgW = resizeSettings.widthInches * clipDPI * scale;
  const imgH = resizeSettings.heightInches * clipDPI * scale;
  const imgX = (clipW - imgW) / 2 + (shapeSettings.imageOffsetX || 0) * clipDPI;
  const imgY = (clipH - imgH) / 2 + (shapeSettings.imageOffsetY || 0) * clipDPI;
  clipCtx.drawImage(sourceImage, imgX, imgY, imgW, imgH);
  clipCtx.restore();

  const clippedBlob = await new Promise<Blob>((resolve) => {
    clipCanvas.toBlob((b) => resolve(b!), 'image/png');
  });
  const clippedBytes = new Uint8Array(await clippedBlob.arrayBuffer());
  return pdfDoc.embedPng(clippedBytes);
}

// Helper function to generate PDF path operations for a rounded rectangle
function getRoundedRectPath(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.min(radius, width / 2, height / 2);
  const k = 0.5522847498; // Bezier approximation constant for circles
  const rk = r * k;
  
  let path = `${x + r} ${y} m\n`; // Start at top-left + radius
  path += `${x + width - r} ${y} l\n`; // Top edge
  path += `${x + width - r + rk} ${y} ${x + width} ${y + r - rk} ${x + width} ${y + r} c\n`; // Top-right corner
  path += `${x + width} ${y + height - r} l\n`; // Right edge
  path += `${x + width} ${y + height - r + rk} ${x + width - r + rk} ${y + height} ${x + width - r} ${y + height} c\n`; // Bottom-right corner
  path += `${x + r} ${y + height} l\n`; // Bottom edge
  path += `${x + r - rk} ${y + height} ${x} ${y + height - r + rk} ${x} ${y + height - r} c\n`; // Bottom-left corner
  path += `${x} ${y + r} l\n`; // Left edge
  path += `${x} ${y + r - rk} ${x + r - rk} ${y} ${x + r} ${y} c\n`; // Top-left corner
  
  return path;
}

export function calculateShapeDimensions(
  designWidthInches: number,
  designHeightInches: number,
  shapeType: ShapeSettings['type'],
  offset: number
): { widthInches: number; heightInches: number } {
  const totalOffset = offset * 2;

  if (shapeType === 'circle') {
    const diameter = Math.max(designWidthInches, designHeightInches) + totalOffset;
    return { widthInches: diameter, heightInches: diameter };
  } else if (shapeType === 'square' || shapeType === 'rounded-square') {
    const size = Math.max(designWidthInches, designHeightInches) + totalOffset;
    return { widthInches: size, heightInches: size };
  } else if (shapeType === 'oval') {
    let width = designWidthInches + totalOffset;
    let height = designHeightInches + totalOffset;

    const minAspectRatio = 1.2;
    const currentRatio = Math.max(width, height) / Math.min(width, height);
    if (currentRatio < minAspectRatio) {
      if (width >= height) {
        width = height * minAspectRatio;
      } else {
        height = width * minAspectRatio;
      }
    }

    return {
      widthInches: parseFloat(width.toFixed(3)),
      heightInches: parseFloat(height.toFixed(3))
    };
  } else {
    let width = designWidthInches + totalOffset;
    let height = designHeightInches + totalOffset;

    const minAspectRatio = 1.2;
    const currentRatio = Math.max(width, height) / Math.min(width, height);
    if (currentRatio < minAspectRatio) {
      if (width >= height) {
        width = height * minAspectRatio;
      } else {
        height = width * minAspectRatio;
      }
    }

    return {
      widthInches: parseFloat(width.toFixed(3)),
      heightInches: parseFloat(height.toFixed(3))
    };
  }
}

export function generateShapePathPointsInches(
  shapeSettings: ShapeSettings,
  resizeSettings: ResizeSettings,
): {
  pathPoints: Array<{x: number; y: number}>;
  widthInches: number;
  heightInches: number;
  imageOffsetX: number;
  imageOffsetY: number;
  bleedInches: number;
} {
  let shapeDims = calculateShapeDimensions(
    resizeSettings.widthInches,
    resizeSettings.heightInches,
    shapeSettings.type,
    shapeSettings.offset
  );

  if (shapeSettings.shapeWidthOverride && shapeSettings.shapeWidthOverride > 0) {
    shapeDims = { widthInches: shapeSettings.shapeWidthOverride, heightInches: shapeDims.heightInches };
  }
  if (shapeSettings.shapeHeightOverride && shapeSettings.shapeHeightOverride > 0) {
    shapeDims = { widthInches: shapeDims.widthInches, heightInches: shapeSettings.shapeHeightOverride };
  }

  const bleedInches = 0.10;
  const totalWidthInches = shapeDims.widthInches + bleedInches * 2;
  const totalHeightInches = shapeDims.heightInches + bleedInches * 2;

  const cx = totalWidthInches / 2;
  const cy = totalHeightInches / 2;

  const imgScale = shapeSettings.imageScale || 1;
  const imgW = resizeSettings.widthInches * imgScale;
  const imgH = resizeSettings.heightInches * imgScale;
  const imageOffsetX = (totalWidthInches - imgW) / 2 + (shapeSettings.imageOffsetX || 0);
  const imageOffsetY = (totalHeightInches - imgH) / 2 + (shapeSettings.imageOffsetY || 0);

  const points: Array<{x: number; y: number}> = [];

  if (shapeSettings.type === 'circle') {
    const r = Math.min(shapeDims.widthInches, shapeDims.heightInches) / 2;
    const numPts = 256;
    for (let i = 0; i < numPts; i++) {
      const angle = (i / numPts) * Math.PI * 2;
      points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    }
  } else if (shapeSettings.type === 'oval') {
    const rx = shapeDims.widthInches / 2;
    const ry = shapeDims.heightInches / 2;
    const numPts = 256;
    for (let i = 0; i < numPts; i++) {
      const angle = (i / numPts) * Math.PI * 2;
      points.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
    }
  } else if (shapeSettings.type === 'square') {
    const size = Math.min(shapeDims.widthInches, shapeDims.heightInches);
    const sx = (totalWidthInches - size) / 2;
    const sy = (totalHeightInches - size) / 2;
    points.push({ x: sx, y: sy }, { x: sx + size, y: sy }, { x: sx + size, y: sy + size }, { x: sx, y: sy + size });
  } else if (shapeSettings.type === 'rounded-square') {
    const size = Math.min(shapeDims.widthInches, shapeDims.heightInches);
    const sx = (totalWidthInches - size) / 2;
    const sy = (totalHeightInches - size) / 2;
    const r = Math.min(shapeSettings.cornerRadius || 0.25, size / 2);
    const segs = 16;
    for (let c = 0; c < 4; c++) {
      const cornerX = c === 0 || c === 3 ? sx + r : sx + size - r;
      const cornerY = c < 2 ? sy + r : sy + size - r;
      const startAngle = [Math.PI, Math.PI * 1.5, 0, Math.PI * 0.5][c];
      for (let j = 0; j <= segs; j++) {
        const a = startAngle + (j / segs) * (Math.PI / 2);
        points.push({ x: cornerX + r * Math.cos(a), y: cornerY + r * Math.sin(a) });
      }
    }
  } else if (shapeSettings.type === 'rounded-rectangle') {
    const w = shapeDims.widthInches;
    const h = shapeDims.heightInches;
    const r = Math.min(shapeSettings.cornerRadius || 0.25, w / 2, h / 2);
    const segs = 16;
    const offX = (totalWidthInches - w) / 2;
    const offY = (totalHeightInches - h) / 2;
    for (let c = 0; c < 4; c++) {
      const cornerX = c === 0 || c === 3 ? offX + r : offX + w - r;
      const cornerY = c < 2 ? offY + r : offY + h - r;
      const startAngle = [Math.PI, Math.PI * 1.5, 0, Math.PI * 0.5][c];
      for (let j = 0; j <= segs; j++) {
        const a = startAngle + (j / segs) * (Math.PI / 2);
        points.push({ x: cornerX + r * Math.cos(a), y: cornerY + r * Math.sin(a) });
      }
    }
  } else {
    const w = shapeDims.widthInches;
    const h = shapeDims.heightInches;
    const sx = (totalWidthInches - w) / 2;
    const sy = (totalHeightInches - h) / 2;
    points.push({ x: sx, y: sy }, { x: sx + w, y: sy }, { x: sx + w, y: sy + h }, { x: sx, y: sy + h });
  }

  const rotation = shapeSettings.rotation || 0;
  if (rotation !== 0) {
    for (let i = 0; i < points.length; i++) {
      points[i] = rotatePoint(points[i].x, points[i].y, cx, cy, rotation);
    }
  }

  return { pathPoints: points, widthInches: totalWidthInches, heightInches: totalHeightInches, imageOffsetX, imageOffsetY, bleedInches };
}

export async function downloadShapePDF(
  image: HTMLImageElement,
  shapeSettings: ShapeSettings,
  resizeSettings: ResizeSettings,
  filename: string,
  spotColors?: SpotColorInput[],
  singleArtboard: boolean = true,
  cutContourLabel: string = 'CutContour',
  lockedContour?: { label: string; pathPoints: Array<{x: number; y: number}>; allPathPoints?: Array<Array<{x: number; y: number}>>; widthInches: number; heightInches: number; imageOffsetX: number; imageOffsetY: number } | null,
  spotPixelMap?: SpotPixelMapData
): Promise<void> {
  let shapeDims = calculateShapeDimensions(
    resizeSettings.widthInches,
    resizeSettings.heightInches,
    shapeSettings.type,
    shapeSettings.offset
  );
  if (shapeSettings.shapeWidthOverride && shapeSettings.shapeWidthOverride > 0) {
    shapeDims = { widthInches: shapeSettings.shapeWidthOverride, heightInches: shapeDims.heightInches };
  }
  if (shapeSettings.shapeHeightOverride && shapeSettings.shapeHeightOverride > 0) {
    shapeDims = { widthInches: shapeDims.widthInches, heightInches: shapeSettings.shapeHeightOverride };
  }
  const { widthInches, heightInches } = shapeDims;

  const bleedInches = 0.10;
  const bleedPts = bleedInches * 72;
  const widthPts = widthInches * 72 + bleedPts * 2;
  const heightPts = heightInches * 72 + bleedPts * 2;
  const shapeWidthPts = widthInches * 72;
  const shapeHeightPts = heightInches * 72;

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([widthPts, heightPts]);
  const context = pdfDoc.context;
  const cx = widthPts / 2;
  const cy = heightPts / 2;
  const rotation = shapeSettings.rotation || 0;
  const cornerRadiusPts = (shapeSettings.cornerRadius || 0.25) * 72;

  const hexToRgb = (hex: string) => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16) / 255,
      g: parseInt(result[2], 16) / 255,
      b: parseInt(result[3], 16) / 255
    } : { r: 1, g: 1, b: 1 };
  };

  const appendContent = (ops: string) => {
    const stream = context.stream(ops);
    const ref = context.register(stream);
    const existing = page.node.Contents();
    if (existing instanceof PDFArray) {
      existing.push(ref);
    } else if (existing) {
      page.node.set(PDFName.of('Contents'), context.obj([existing, ref]));
    } else {
      page.node.set(PDFName.of('Contents'), ref);
    }
  };

  // Background fill with bleed
  if (shapeSettings.bleedEnabled && shapeSettings.bleedColor && shapeSettings.bleedColor !== shapeSettings.fillColor) {
    const bleedRgb = hexToRgb(shapeSettings.bleedColor);
    let bleedOps = 'q\n';
    bleedOps += pdfRotationTransform(cx, cy, rotation);
    bleedOps += `${bleedRgb.r} ${bleedRgb.g} ${bleedRgb.b} rg\n`;
    bleedOps += generateShapePDFPath(shapeSettings.type, cx, cy, widthPts, heightPts, widthPts, heightPts, cornerRadiusPts);
    bleedOps += 'h f\nQ\n';
    appendContent(bleedOps);
  }

  const fillRgb = hexToRgb(shapeSettings.fillColor);
  let bgOps = 'q\n';
  bgOps += pdfRotationTransform(cx, cy, rotation);
  bgOps += `${fillRgb.r} ${fillRgb.g} ${fillRgb.b} rg\n`;
  const bgFillW = (shapeSettings.bleedEnabled && shapeSettings.bleedColor && shapeSettings.bleedColor !== shapeSettings.fillColor) ? shapeWidthPts : widthPts;
  const bgFillH = (shapeSettings.bleedEnabled && shapeSettings.bleedColor && shapeSettings.bleedColor !== shapeSettings.fillColor) ? shapeHeightPts : heightPts;
  bgOps += generateShapePDFPath(shapeSettings.type, cx, cy, bgFillW, bgFillH, widthPts, heightPts, cornerRadiusPts);
  bgOps += 'h f\nQ\n';
  appendContent(bgOps);

  // Image (always use clipped shape for proper clipping + rotation + offset handling)
  const clippedImage = await createClippedShapeImage(image, shapeSettings, resizeSettings, widthInches, heightInches, pdfDoc);
  const clippedX = (widthPts - shapeWidthPts) / 2;
  const clippedY = (heightPts - shapeHeightPts) / 2;
  page.drawImage(clippedImage, { x: clippedX, y: clippedY, width: shapeWidthPts, height: shapeHeightPts });

  // Border/stroke (visible printed element, not the CutContour)
  if (shapeSettings.strokeEnabled) {
    const strokeRgb = hexToRgb(shapeSettings.strokeColor || '#000000');
    const strokeW = shapeSettings.strokeWidth || 1;
    let borderOps = 'q\n';
    borderOps += pdfRotationTransform(cx, cy, rotation);
    borderOps += `${strokeRgb.r} ${strokeRgb.g} ${strokeRgb.b} RG\n`;
    borderOps += `${strokeW} w\n`;
    borderOps += generateShapePDFPath(shapeSettings.type, cx, cy, shapeWidthPts, shapeHeightPts, widthPts, heightPts, cornerRadiusPts);
    borderOps += 'h S\nQ\n';
    appendContent(borderOps);
  }

  // CutContour separation color space
  let resources = page.node.Resources();
  const tintFunction = context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 });
  const tintFunctionRef = context.register(tintFunction);
  const separationColorSpace = context.obj([
    PDFName.of('Separation'), PDFName.of(cutContourLabel), PDFName.of('DeviceCMYK'), tintFunctionRef
  ]);
  const separationRef = context.register(separationColorSpace);
  if (resources) {
    let colorSpaceDict = resources.get(PDFName.of('ColorSpace'));
    if (!colorSpaceDict) { colorSpaceDict = context.obj({}); resources.set(PDFName.of('ColorSpace'), colorSpaceDict); }
    (colorSpaceDict as PDFDict).set(PDFName.of(cutContourLabel), separationRef);
  }

  // CutContour path
  let pathOps = 'q\n';
  pathOps += pdfRotationTransform(cx, cy, rotation);
  pathOps += `/${cutContourLabel} CS 1 SCN\n0.5 w\n`;
  pathOps += generateShapePDFPath(shapeSettings.type, cx, cy, shapeWidthPts, shapeHeightPts, widthPts, heightPts, cornerRadiusPts);
  pathOps += 'h S\nQ\n';
  appendContent(pathOps);
  
  if (lockedContour && lockedContour.pathPoints.length > 2) {
    const lcPageHeight = lockedContour.heightInches;
    const lcImgOffX = lockedContour.imageOffsetX;
    const lcImgOffY = lockedContour.imageOffsetY;
    const imgWidthInches = resizeSettings.widthInches;
    const imgHeightInches = resizeSettings.heightInches;
    
    const lcImgBottomY = lcPageHeight - lcImgOffY - imgHeightInches;
    
    const shapeImgXInches = (widthPts / 72 - imgWidthInches) / 2;
    const shapeImgYInches = (heightPts / 72 - imgHeightInches) / 2;
    
    const mapPathToShape = (pts: Array<{x: number; y: number}>) => pts.map(p => ({
      x: shapeImgXInches + (p.x - lcImgOffX),
      y: shapeImgYInches + (p.y - lcImgBottomY),
    }));

    const allMappedPaths = lockedContour.allPathPoints && lockedContour.allPathPoints.length > 0
      ? lockedContour.allPathPoints.map(mapPathToShape)
      : [mapPathToShape(lockedContour.pathPoints)];

    if (lockedContour.label !== cutContourLabel) {
      const lcTintFunction = context.obj({
        FunctionType: 2,
        Domain: [0, 1],
        C0: [0, 0, 0, 0],
        C1: [0, 1, 0, 0],
        N: 1,
      });
      const lcTintRef = context.register(lcTintFunction);
      
      const lcSepCS = context.obj([
        PDFName.of('Separation'),
        PDFName.of(lockedContour.label),
        PDFName.of('DeviceCMYK'),
        lcTintRef,
      ]);
      const lcSepRef = context.register(lcSepCS);
      
      const lcResources = page.node.Resources();
      if (lcResources) {
        let lcColorSpaceDict = lcResources.get(PDFName.of('ColorSpace'));
        if (!lcColorSpaceDict) {
          lcColorSpaceDict = context.obj({});
          lcResources.set(PDFName.of('ColorSpace'), lcColorSpaceDict);
        }
        (lcColorSpaceDict as PDFDict).set(PDFName.of(lockedContour.label), lcSepRef);
      }
    }
    
    let lcPathOps = '';
    for (const mappedPoints of allMappedPaths) {
      const simplified = simplifyPathForPDF(mappedPoints, 0.01);
      lcPathOps += 'q\n';
      lcPathOps += `/${lockedContour.label} CS 1 SCN\n`;
      lcPathOps += '0.5 w\n';
      lcPathOps += buildSmoothPdfPath(simplified, true);
      lcPathOps += 'S\n';
      lcPathOps += 'Q\n';
    }
    
    const lcStream = context.stream(lcPathOps);
    const lcStreamRef = context.register(lcStream);
    
    const lcExistingContents = page.node.Contents();
    if (lcExistingContents instanceof PDFArray) {
      lcExistingContents.push(lcStreamRef);
    } else if (lcExistingContents) {
      const contentsArray = context.obj([lcExistingContents, lcStreamRef]);
      page.node.set(PDFName.of('Contents'), contentsArray);
    }
  }
  
  if (spotColors && spotColors.length > 0) {
    const pageWidthInches = widthPts / 72;
    const pageHeightInches = heightPts / 72;
    const imgOffsetXInches = (pageWidthInches - resizeSettings.widthInches) / 2;
    const imgOffsetYInches = (pageHeightInches - resizeSettings.heightInches) / 2;
    const spotLabels = await addSpotColorVectorsToPDF(
      pdfDoc, page, image, spotColors,
      resizeSettings.widthInches, resizeSettings.heightInches,
      pageHeightInches, imgOffsetXInches, imgOffsetYInches,
      singleArtboard, widthPts, heightPts, spotPixelMap
    );
    console.log('[downloadShapePDF] Added spot color vector layers:', spotLabels);
  }
  
  const whiteName = spotColors?.find(c => c.spotWhite)?.spotWhiteName || 'RDG_WHITE';
  const glossName = spotColors?.find(c => c.spotGloss)?.spotGlossName || 'RDG_GLOSS';
  
  pdfDoc.setTitle('Shape with CutContour and Spot Colors');
  pdfDoc.setSubject(singleArtboard 
    ? `Single artboard with Design + CutContour + ${whiteName} + ${glossName}`
    : `Contains CutContour and spot color layers for cutting machines`);
  pdfDoc.setKeywords(['CutContour', 'spot color', 'cutting', 'vector', 'shape']);
  
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

export async function generateShapePDFBase64(
  image: HTMLImageElement,
  shapeSettings: ShapeSettings,
  resizeSettings: ResizeSettings,
  cutContourLabel: string = 'CutContour'
): Promise<string | null> {
  let shapeDims = calculateShapeDimensions(
    resizeSettings.widthInches, resizeSettings.heightInches, shapeSettings.type, shapeSettings.offset
  );
  if (shapeSettings.shapeWidthOverride && shapeSettings.shapeWidthOverride > 0) {
    shapeDims = { widthInches: shapeSettings.shapeWidthOverride, heightInches: shapeDims.heightInches };
  }
  if (shapeSettings.shapeHeightOverride && shapeSettings.shapeHeightOverride > 0) {
    shapeDims = { widthInches: shapeDims.widthInches, heightInches: shapeSettings.shapeHeightOverride };
  }
  const { widthInches, heightInches } = shapeDims;
  const widthPts = widthInches * 72;
  const heightPts = heightInches * 72;
  const rotation = shapeSettings.rotation || 0;
  const cornerRadiusPts = (shapeSettings.cornerRadius || 0.25) * 72;

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([widthPts, heightPts]);
  const context = pdfDoc.context;
  const cx = widthPts / 2;
  const cy = heightPts / 2;

  const appendContent = (ops: string) => {
    const stream = context.stream(ops);
    const ref = context.register(stream);
    const existing = page.node.Contents();
    if (existing instanceof PDFArray) { existing.push(ref); }
    else if (existing) { page.node.set(PDFName.of('Contents'), context.obj([existing, ref])); }
    else { page.node.set(PDFName.of('Contents'), ref); }
  };

  const clippedImage = await createClippedShapeImage(image, shapeSettings, resizeSettings, widthInches, heightInches, pdfDoc);
  page.drawImage(clippedImage, { x: 0, y: 0, width: widthPts, height: heightPts });

  let resources = page.node.Resources();
  const tintFunction = context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 });
  const tintFunctionRef = context.register(tintFunction);
  const separationColorSpace = context.obj([
    PDFName.of('Separation'), PDFName.of(cutContourLabel), PDFName.of('DeviceCMYK'), tintFunctionRef
  ]);
  const separationRef = context.register(separationColorSpace);
  if (resources) {
    let colorSpaceDict = resources.get(PDFName.of('ColorSpace'));
    if (!colorSpaceDict) { colorSpaceDict = context.obj({}); resources.set(PDFName.of('ColorSpace'), colorSpaceDict); }
    (colorSpaceDict as PDFDict).set(PDFName.of(cutContourLabel), separationRef);
  }

  let pathOps = 'q\n';
  pathOps += pdfRotationTransform(cx, cy, rotation);
  pathOps += `/${cutContourLabel} CS 1 SCN\n0.5 w\n`;
  pathOps += generateShapePDFPath(shapeSettings.type, cx, cy, widthPts, heightPts, widthPts, heightPts, cornerRadiusPts);
  pathOps += 'h S\nQ\n';
  appendContent(pathOps);

  pdfDoc.setTitle('Shape with CutContour');
  pdfDoc.setSubject(`Contains ${cutContourLabel} spot color for cutting machines`);

  const pdfBytes = await pdfDoc.save();
  let binary = '';
  for (let i = 0; i < pdfBytes.length; i++) binary += String.fromCharCode(pdfBytes[i]);
  return btoa(binary);
}
