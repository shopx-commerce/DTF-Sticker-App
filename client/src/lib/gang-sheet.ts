import { PDFDocument, PDFName, PDFDict, PDFArray } from 'pdf-lib';
import { contourPointsToPDFPathOps, type CachedContourData } from './contour-outline';
import type { ResizeSettings, StrokeSettings, ShapeSettings } from './types';

const MAX_CANVAS_DIM = 16384;
const MAX_CANVAS_PIXELS = 268_435_456; // ~16384²; Chrome's hard limit

function clampCanvasDims(w: number, h: number): { w: number; h: number; scale: number } {
  let scale = 1;
  if (w > MAX_CANVAS_DIM) { scale = MAX_CANVAS_DIM / w; }
  if (h * scale > MAX_CANVAS_DIM) { scale = MAX_CANVAS_DIM / h; }
  const cw = Math.round(w * scale);
  const ch = Math.round(h * scale);
  if (cw * ch > MAX_CANVAS_PIXELS) {
    const pixelScale = Math.sqrt(MAX_CANVAS_PIXELS / (cw * ch));
    return { w: Math.round(cw * pixelScale), h: Math.round(ch * pixelScale), scale: scale * pixelScale };
  }
  return { w: cw, h: ch, scale };
}

// ─── Types ───

export interface GangSheetItem {
  id: string;
  thumbnail: string;
  imageElement: HTMLImageElement;
  contourData: CachedContourData;
  resizeSettings: ResizeSettings;
  strokeSettings: StrokeSettings;
  shapeSettings?: ShapeSettings;
  cutContourLabel: string;
  quantity: number;
}

export interface GangSheetSettings {
  sheetWidth: number;
  sheetHeight: number;
  gap: number;
  edgePadding: number;
}

export interface PlacedItem {
  itemId: string;
  instanceIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotated?: boolean;
}

export interface PackResult {
  placements: PlacedItem[];
  overflow: number;
  utilization: number;
}

export const GANG_SHEET_PRESETS = [
  { label: '4 x 6', width: 4, height: 6 },
  { label: '8.5 x 11', width: 8.5, height: 11 },
  { label: '22 x 12', width: 22, height: 12 },
  { label: '22 x 22', width: 22, height: 22 },
  { label: '48 x 12', width: 48, height: 12 },
  { label: '48 x 24', width: 48, height: 24 },
  { label: '48 x 48', width: 48, height: 48 },
];

export const DEFAULT_GANG_SHEET_SETTINGS: GangSheetSettings = {
  sheetWidth: 48,
  sheetHeight: 12,
  gap: 0.15,
  edgePadding: 0.25,
};

// ─── Shelf-based bin packer ───

const MAX_GANG_SHEET_COPIES = 500;

export function packGangSheet(
  items: GangSheetItem[],
  settings: GangSheetSettings
): PackResult {
  const { sheetWidth, sheetHeight, gap, edgePadding } = settings;
  if (sheetWidth <= 0 || sheetHeight <= 0) {
    return { placements: [], overflow: 0, utilization: 0 };
  }
  const usableWidth = sheetWidth - edgePadding * 2;
  const usableHeight = sheetHeight - edgePadding * 2;
  if (usableWidth <= 0 || usableHeight <= 0) {
    return { placements: [], overflow: items.length, utilization: 0 };
  }

  interface Entry {
    itemId: string;
    instanceIndex: number;
    w: number;
    h: number;
  }

  const buildEntries = (rotate: boolean): { entries: Entry[]; isRotated: boolean } => {
    const out: Entry[] = [];
    for (const item of items) {
      const qty = Math.min(Math.max(1, item.quantity), MAX_GANG_SHEET_COPIES);
      const origW = item.contourData.widthInches;
      const origH = item.contourData.heightInches;
      if (origW <= 0 || origH <= 0) continue;
      const w = rotate ? origH : origW;
      const h = rotate ? origW : origH;
      for (let i = 0; i < qty; i++) {
        out.push({ itemId: item.id, instanceIndex: i, w, h });
      }
    }
    out.sort((a, b) => b.h - a.h);
    return { entries: out, isRotated: rotate };
  };

  const shelfPack = (data: { entries: Entry[]; isRotated: boolean }): { placements: PlacedItem[]; overflow: number } => {
    const placements: PlacedItem[] = [];
    let cursorX = 0;
    let cursorY = 0;
    let shelfH = 0;
    let overflow = 0;

    for (const entry of data.entries) {
      if (cursorX + entry.w > usableWidth) {
        cursorX = 0;
        cursorY += shelfH + gap;
        shelfH = 0;
      }
      if (cursorY + entry.h > usableHeight) {
        overflow++;
        continue;
      }
      placements.push({
        itemId: entry.itemId,
        instanceIndex: entry.instanceIndex,
        x: edgePadding + cursorX,
        y: edgePadding + cursorY,
        width: entry.w,
        height: entry.h,
        rotated: data.isRotated,
      });
      shelfH = Math.max(shelfH, entry.h);
      cursorX += entry.w + gap;
    }
    return { placements, overflow };
  };

  const normalResult = shelfPack(buildEntries(false));
  const rotatedResult = shelfPack(buildEntries(true));

  const best = rotatedResult.placements.length > normalResult.placements.length
    ? rotatedResult : normalResult;

  const totalArea = sheetWidth * sheetHeight;
  const usedArea = best.placements.reduce((sum, p) => sum + p.width * p.height, 0);
  const utilization = totalArea > 0 ? usedArea / totalArea : 0;

  return { placements: best.placements, overflow: best.overflow, utilization };
}

// ─── Coordinate transform ───
// Each item's contourData.pathPoints are in local inches with Y flipped
// relative to that item's own page (heightInches). We need to remap
// them to the gang sheet's coordinate system.

function remapPathToSheet(
  localPath: Array<{ x: number; y: number }>,
  itemWidthInches: number,
  itemHeightInches: number,
  placementX: number,
  placementY: number,
  sheetHeightInches: number,
  rotated: boolean,
  isShape: boolean
): Array<{ x: number; y: number }> {
  return localPath.map(p => {
    let sx: number, sy: number;
    if (rotated) {
      if (isShape) {
        sx = placementX + p.y;
        sy = sheetHeightInches - (placementY + (itemWidthInches - p.x));
      } else {
        sx = placementX + (itemHeightInches - p.y);
        sy = sheetHeightInches - (placementY + p.x);
      }
    } else {
      const localY = isShape ? p.y : (itemHeightInches - p.y);
      sx = placementX + p.x;
      sy = sheetHeightInches - (placementY + localY);
    }
    return { x: sx, y: sy };
  });
}

// ─── Gang Sheet PDF Export ───

export async function downloadGangSheetPDF(
  items: GangSheetItem[],
  settings: GangSheetSettings,
  placements: PlacedItem[]
): Promise<void> {
  const { sheetWidth, sheetHeight } = settings;
  const widthPts = sheetWidth * 72;
  const heightPts = sheetHeight * 72;

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([widthPts, heightPts]);
  const context = pdfDoc.context;

  pdfDoc.setTitle('Gang Sheet');
  pdfDoc.setSubject('Gang sheet with multiple sticker designs and CutContour paths');

  const itemMap = new Map<string, GangSheetItem>();
  for (const item of items) itemMap.set(item.id, item);

  // --- Background fill (raster at 150 DPI) ---
  const bgDPI = 150;
  const rawBgW = Math.round(sheetWidth * bgDPI);
  const rawBgH = Math.round(sheetHeight * bgDPI);
  const bgClamped = clampCanvasDims(rawBgW, rawBgH);
  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = bgClamped.w;
  bgCanvas.height = bgClamped.h;
  const bgCtx = bgCanvas.getContext('2d');
  if (!bgCtx) throw new Error('Failed to create background canvas context');

  const effectiveBgDPI = bgDPI * bgClamped.scale;

  bgCtx.fillStyle = '#ffffff';
  bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);

  for (const placement of placements) {
    const item = itemMap.get(placement.itemId);
    if (!item) continue;
    const { contourData } = item;
    const fillColor = contourData.backgroundColor || '#ffffff';
    const bleedColor = item.shapeSettings?.bleedEnabled
      ? (item.shapeSettings.bleedColor || '#ffffff')
      : fillColor;
    const paths = contourData.allPathPoints && contourData.allPathPoints.length > 0
      ? contourData.allPathPoints
      : [contourData.pathPoints];

    const itemBleedInches = 0.10;
    bgCtx.lineJoin = 'round';
    bgCtx.lineCap = 'round';
    bgCtx.lineWidth = itemBleedInches * effectiveBgDPI * 2;

    const holeStart = contourData.holePathStartIndex;
    const outerPaths = holeStart != null ? paths.slice(0, holeStart) : paths;
    const holePaths = holeStart != null ? paths.slice(holeStart) : [];

    const isShapeFill = !!item.shapeSettings?.enabled;
    for (const path of outerPaths) {
      if (path.length === 0) continue;
      const sheetPath = remapPathToSheet(
        path, contourData.widthInches, contourData.heightInches,
        placement.x, placement.y, sheetHeight,
        !!placement.rotated, isShapeFill
      );

      // Draw bleed area first (stroke extends beyond cut line)
      if (bleedColor !== fillColor) {
        bgCtx.fillStyle = bleedColor;
        bgCtx.strokeStyle = bleedColor;
        bgCtx.beginPath();
        bgCtx.moveTo(sheetPath[0].x * effectiveBgDPI, sheetPath[0].y * effectiveBgDPI);
        for (let i = 1; i < sheetPath.length; i++) {
          bgCtx.lineTo(sheetPath[i].x * effectiveBgDPI, sheetPath[i].y * effectiveBgDPI);
        }
        bgCtx.closePath();
        bgCtx.stroke();
        bgCtx.fill();
      }

      // Draw fill area (inside cut line)
      bgCtx.fillStyle = fillColor;
      bgCtx.strokeStyle = fillColor;
      bgCtx.beginPath();
      bgCtx.moveTo(sheetPath[0].x * effectiveBgDPI, sheetPath[0].y * effectiveBgDPI);
      for (let i = 1; i < sheetPath.length; i++) {
        bgCtx.lineTo(sheetPath[i].x * effectiveBgDPI, sheetPath[i].y * effectiveBgDPI);
      }
      bgCtx.closePath();
      bgCtx.stroke();
      bgCtx.fill();
    }

    if (holePaths.length > 0) {
      bgCtx.save();
      bgCtx.globalCompositeOperation = 'destination-out';
      bgCtx.fillStyle = 'rgba(0,0,0,1)';
      for (const hp of holePaths) {
        if (hp.length === 0) continue;
        const sheetPath = remapPathToSheet(
          hp, contourData.widthInches, contourData.heightInches,
          placement.x, placement.y, sheetHeight,
          !!placement.rotated, isShapeFill
        );
        bgCtx.beginPath();
        bgCtx.moveTo(sheetPath[0].x * effectiveBgDPI, sheetPath[0].y * effectiveBgDPI);
        for (let i = 1; i < sheetPath.length; i++) {
          bgCtx.lineTo(sheetPath[i].x * effectiveBgDPI, sheetPath[i].y * effectiveBgDPI);
        }
        bgCtx.closePath();
        bgCtx.fill();
      }
      bgCtx.restore();
    }
  }

  // Flip background for PDF (canvas Y-down -> PDF Y-up)
  const flippedBg = document.createElement('canvas');
  flippedBg.width = bgCanvas.width;
  flippedBg.height = bgCanvas.height;
  const flippedCtx = flippedBg.getContext('2d');
  if (!flippedCtx) throw new Error('Failed to create flipped background canvas context');
  flippedCtx.translate(0, bgCanvas.height);
  flippedCtx.scale(1, -1);
  flippedCtx.drawImage(bgCanvas, 0, 0);

  const bgBlob = await new Promise<Blob>((resolve, reject) => {
    flippedBg.toBlob(b => b ? resolve(b) : reject(new Error('bg blob failed')), 'image/png');
  });
  const bgBytes = new Uint8Array(await bgBlob.arrayBuffer());
  const bgImage = await pdfDoc.embedPng(bgBytes);
  page.drawImage(bgImage, { x: 0, y: 0, width: widthPts, height: heightPts });

  // --- Design images (with shape clipping) ---
  const imageCache = new Map<string, Awaited<ReturnType<typeof pdfDoc.embedPng>>>();

  for (const placement of placements) {
    const item = itemMap.get(placement.itemId);
    if (!item) continue;

    const imgNatW = item.imageElement.naturalWidth || item.imageElement.width;
    const imgNatH = item.imageElement.naturalHeight || item.imageElement.height;

    let pdfImage = imageCache.get(item.id);
    if (!pdfImage) {
      const imgClamped = clampCanvasDims(imgNatW, imgNatH);
      const canvas = document.createElement('canvas');
      canvas.width = imgClamped.w;
      canvas.height = imgClamped.h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error(`Failed to create design canvas context for ${item.id}`);
      ctx.drawImage(item.imageElement, 0, 0, imgClamped.w, imgClamped.h);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('design blob failed')), 'image/png');
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      pdfImage = await pdfDoc.embedPng(bytes);
      imageCache.set(item.id, pdfImage);
    }

    const isShapeMode = !!item.shapeSettings?.enabled
      || (item.contourData.minPathX === 0 && item.contourData.minPathY === 0
         && item.contourData.effectiveDPI === 300);
    let imgWidthPts: number, imgHeightPts: number;
    if (isShapeMode) {
      imgWidthPts = item.resizeSettings.widthInches * 72;
      imgHeightPts = item.resizeSettings.heightInches * 72;
    } else {
      const safeNatH = imgNatH || 1;
      const safeResH = item.resizeSettings.heightInches || 1;
      const gsNatAR = imgNatW / safeNatH;
      const gsResAR = item.resizeSettings.widthInches / safeResH;
      let gsContourImgW: number, gsContourImgH: number;
      if (gsNatAR <= gsResAR) {
        gsContourImgW = item.resizeSettings.widthInches;
        gsContourImgH = gsNatAR > 0 ? item.resizeSettings.widthInches / gsNatAR : item.resizeSettings.heightInches;
      } else {
        gsContourImgH = item.resizeSettings.heightInches;
        gsContourImgW = item.resizeSettings.heightInches * gsNatAR;
      }
      imgWidthPts = gsContourImgW * 72;
      imgHeightPts = gsContourImgH * 72;
    }
    const isRotated = !!placement.rotated;

    let drawImgWidthPts = imgWidthPts;
    let drawImgHeightPts = imgHeightPts;
    let drawPdfImage = pdfImage;

    if (isRotated) {
      const rotKey = item.id + '_rot';
      let rotImg = imageCache.get(rotKey);
      if (!rotImg) {
        const rotCanvas = document.createElement('canvas');
        const rotClamped = clampCanvasDims(imgNatH, imgNatW);
        rotCanvas.width = rotClamped.w;
        rotCanvas.height = rotClamped.h;
        const rotCtx = rotCanvas.getContext('2d');
        if (rotCtx) {
          rotCtx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
          rotCtx.rotate(-Math.PI / 2);
          const srcClamped = clampCanvasDims(imgNatW, imgNatH);
          rotCtx.drawImage(item.imageElement, -srcClamped.w / 2, -srcClamped.h / 2, srcClamped.w, srcClamped.h);
          const rotBlob = await new Promise<Blob>((resolve, reject) => {
            rotCanvas.toBlob(b => b ? resolve(b) : reject(new Error('rot blob failed')), 'image/png');
          });
          const rotBytes = new Uint8Array(await rotBlob.arrayBuffer());
          rotImg = await pdfDoc.embedPng(rotBytes);
          imageCache.set(rotKey, rotImg);
        }
      }
      if (rotImg) {
        drawPdfImage = rotImg;
        drawImgWidthPts = imgHeightPts;
        drawImgHeightPts = imgWidthPts;
      }
    }

    const imgXPts = (placement.x + (isRotated ? item.contourData.imageOffsetY : item.contourData.imageOffsetX)) * 72;
    const imgYPts = heightPts - (placement.y + (isRotated ? item.contourData.imageOffsetX : item.contourData.imageOffsetY)) * 72 - drawImgHeightPts;

    // Clip image to contour path for shapes (circle, oval, rounded shapes)
    const needsClip = isShapeMode && item.shapeSettings
      && ['circle', 'oval', 'rounded-square', 'rounded-rectangle'].includes(item.shapeSettings.type);

    if (needsClip) {
      const { contourData } = item;
      const paths = contourData.allPathPoints && contourData.allPathPoints.length > 0
        ? contourData.allPathPoints : [contourData.pathPoints];
      const outerPaths = contourData.holePathStartIndex != null
        ? paths.slice(0, contourData.holePathStartIndex) : paths;

      let clipOps = 'q\n';
      for (const path of outerPaths) {
        if (path.length < 3) continue;
        const sheetPath = remapPathToSheet(
          path, contourData.widthInches, contourData.heightInches,
          placement.x, placement.y, sheetHeight,
          isRotated, !!item.shapeSettings?.enabled
        );
        clipOps += `${sheetPath[0].x * 72} ${sheetPath[0].y * 72} m\n`;
        for (let i = 1; i < sheetPath.length; i++) {
          clipOps += `${sheetPath[i].x * 72} ${sheetPath[i].y * 72} l\n`;
        }
        clipOps += 'h\n';
      }
      clipOps += 'W n\n';

      const imgName = `Img_${item.id.replace(/[^a-zA-Z0-9]/g, '_')}_${placement.instanceIndex}`;
      const resources = page.node.Resources();
      if (resources) {
        let xObjDict = resources.get(PDFName.of('XObject'));
        if (!xObjDict) { xObjDict = context.obj({}); resources.set(PDFName.of('XObject'), xObjDict); }
        (xObjDict as PDFDict).set(PDFName.of(imgName), drawPdfImage.ref);
      }

      clipOps += `${drawImgWidthPts} 0 0 ${drawImgHeightPts} ${imgXPts} ${imgYPts} cm\n`;
      clipOps += `/${imgName} Do\n`;
      clipOps += 'Q\n';

      const clipStream = context.stream(clipOps);
      const clipRef = context.register(clipStream);
      const existing = page.node.Contents();
      if (existing instanceof PDFArray) { existing.push(clipRef); }
      else if (existing) { page.node.set(PDFName.of('Contents'), context.obj([existing, clipRef])); }
    } else {
      page.drawImage(drawPdfImage, {
        x: imgXPts,
        y: imgYPts,
        width: drawImgWidthPts,
        height: drawImgHeightPts,
      });
    }
  }

  // --- Spot color cut paths (per-label) ---

  const usedLabels = new Set<string>();
  for (const item of items) usedLabels.add(item.cutContourLabel);

  const registerSeparation = (label: string) => {
    const tintFn = context.obj({
      FunctionType: 2,
      Domain: [0, 1],
      C0: [0, 0, 0, 0],
      C1: [0, 1, 0, 0],
      N: 1,
    });
    const tintRef = context.register(tintFn);
    const sepCS = context.obj([
      PDFName.of('Separation'),
      PDFName.of(label),
      PDFName.of('DeviceCMYK'),
      tintRef,
    ]);
    const sepRef = context.register(sepCS);

    const resources = page.node.Resources();
    if (resources) {
      let csDict = resources.get(PDFName.of('ColorSpace'));
      if (!csDict) {
        csDict = context.obj({});
        resources.set(PDFName.of('ColorSpace'), csDict);
      }
      (csDict as PDFDict).set(PDFName.of(label), sepRef);
    }
  };

  for (const label of usedLabels) registerSeparation(label);

  let allPathOps = '';
  for (const placement of placements) {
    const item = itemMap.get(placement.itemId);
    if (!item) continue;
    const { contourData } = item;
    const label = item.cutContourLabel;
    const paths = contourData.allPathPoints && contourData.allPathPoints.length > 0
      ? contourData.allPathPoints
      : [contourData.pathPoints];

    const isShapeCut = !!item.shapeSettings?.enabled;
    for (const path of paths) {
      const remapped = remapPathToSheet(
        path, contourData.widthInches, contourData.heightInches,
        placement.x, placement.y, sheetHeight,
        !!placement.rotated, isShapeCut
      );

      allPathOps += contourPointsToPDFPathOps(remapped, sheetHeight, label);
    }
  }

  if (allPathOps.length > 0) {
    const contentStream = context.stream(allPathOps);
    const contentStreamRef = context.register(contentStream);
    const existingContents = page.node.Contents();
    if (existingContents) {
      if (existingContents instanceof PDFArray) {
        existingContents.push(contentStreamRef);
      } else {
        const newContents = context.obj([existingContents, contentStreamRef]);
        page.node.set(PDFName.of('Contents'), newContents);
      }
    }
  }

  // --- Download ---
  const pdfBytes = await pdfDoc.save();
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = `gang_sheet_${sheetWidth}x${sheetHeight}.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    URL.revokeObjectURL(url);
  }
}
