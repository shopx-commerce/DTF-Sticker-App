import { PDFDocument, PDFName, PDFDict, PDFArray } from 'pdf-lib';
import {
  contourPointsToPDFPathOps,
  bezierPathToPDFPathOps,
  type CachedContourData,
  type SpotColorInput,
} from './contour-outline';
import type { BezierPath } from './contour-worker-manager';
import type { ResizeSettings, StrokeSettings, ShapeSettings } from './types';
import { renderImageWithCrispQRs } from './qr';
import { addGangSheetSpotColorsToPDF, type SpotPixelMapData } from './spot-color-vectors';

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
  /**
   * QR codes detected in `imageElement` (in source pixel coords).
   * The PDF rasteriser uses this to replace QR regions with crisp re-renders
   * at the target print resolution so they survive aggressive downscaling
   * (a 1000px QR scaled to 200px via Lanczos becomes unscannable).
   * Empty array / undefined = no QRs / detection still pending → skip pass.
   */
  qrCodes?: import('./qr').DetectedQR[];
  /** User opt-IN for crisp re-render (default off — preserves source QR as-is). */
  qrRerenderEnabled?: boolean;
  /**
   * Snapshot of the design's spot color extraction at the moment it was
   * added to the gang sheet. When any of the spot flags (white / gloss /
   * fluorescent) are enabled, the gang sheet PDF export traces this design
   * and emits the matching vector spot color separations on every placement
   * — the same separations a single-design export would produce, just tiled.
   */
  spotColors?: SpotColorInput[];
  /** Pixel-exact selection map (matches the on-canvas overlay) for spot color tracing. */
  spotPixelMap?: SpotPixelMapData;
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

// ─── Bin packer ───
/** Hard cap so pathological quantities cannot freeze the tab (each copy is one pack entry). */
export const MAX_GANG_SHEET_USER_QUANTITY = 100_000;

/** Theoretical grid count for one w×h sticker on an empty sheet (upper bound for search / caps). */
function gridPlacementUpperBound(
  usableW: number,
  usableH: number,
  gap: number,
  w: number,
  h: number
): number {
  if (usableW <= 0 || usableH <= 0 || w <= 0 || h <= 0) return 0;
  const ew = w + gap;
  const eh = h + gap;
  const cols = Math.floor((usableW + gap) / ew);
  const rows = Math.floor((usableH + gap) / eh);
  return Math.max(0, cols * rows);
}

/** Clamp gang sheet line quantity to a safe integer (avoids string concat bugs from `<input type="number">`). */
export function clampGangSheetQuantity(q: unknown): number {
  const n = Math.floor(Number(q));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_GANG_SHEET_USER_QUANTITY);
}

function containsRect(
  outer: { x: number; y: number; w: number; h: number },
  inner: { x: number; y: number; w: number; h: number }
): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

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
      const qty = clampGangSheetQuantity(item.quantity);
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

  /**
   * Optimal tiling when every sticker has the same footprint (any number of line items / SKUs).
   * The guillotine heuristic can stop far short of this for many identical copies.
   */
  const homogeneousGridPack = (data: { entries: Entry[]; isRotated: boolean }): { placements: PlacedItem[]; overflow: number } | null => {
    const { entries } = data;
    if (entries.length === 0) return { placements: [], overflow: 0 };
    const w0 = entries[0].w;
    const h0 = entries[0].h;
    if (!entries.every((e) => e.w === w0 && e.h === h0)) return null;

    const ew = w0 + gap;
    const eh = h0 + gap;
    const cols = Math.floor((usableWidth + gap) / ew);
    const rows = Math.floor((usableHeight + gap) / eh);
    const maxCells = Math.max(0, cols * rows);
    const placedCount = Math.min(entries.length, maxCells);
    const placements: PlacedItem[] = [];
    for (let idx = 0; idx < placedCount; idx++) {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const e = entries[idx];
      placements.push({
        itemId: e.itemId,
        instanceIndex: e.instanceIndex,
        x: edgePadding + col * ew,
        y: edgePadding + row * eh,
        width: w0,
        height: h0,
        rotated: data.isRotated,
      });
    }
    return { placements, overflow: entries.length - placedCount };
  };

  /** Guillotine BL pack with gap between stickers (same spacing model as the old shelf packer). */
  const guillotinePack = (data: { entries: Entry[]; isRotated: boolean }): { placements: PlacedItem[]; overflow: number } => {
    const binW = usableWidth + gap;
    const binH = usableHeight + gap;
    interface FreeRect {
      x: number;
      y: number;
      w: number;
      h: number;
    }
    const freeRects: FreeRect[] = [{ x: 0, y: 0, w: binW, h: binH }];
    const placements: PlacedItem[] = [];
    let overflow = 0;

    const pruneFreeList = () => {
      for (let i = 0; i < freeRects.length; i++) {
        for (let j = i + 1; j < freeRects.length; j++) {
          const a = freeRects[i];
          const b = freeRects[j];
          const ai = containsRect(a, b);
          const bi = containsRect(b, a);
          if (ai) {
            freeRects.splice(j, 1);
            j--;
          } else if (bi) {
            freeRects.splice(i, 1);
            i--;
            break;
          }
        }
      }
    };

    for (const entry of data.entries) {
      const ew = entry.w + gap;
      const eh = entry.h + gap;
      let bestIdx = -1;
      let bestShort = Infinity;

      for (let i = 0; i < freeRects.length; i++) {
        const fr = freeRects[i];
        if (ew <= fr.w && eh <= fr.h) {
          const leftoverW = fr.w - ew;
          const leftoverH = fr.h - eh;
          const shortSide = Math.min(leftoverW, leftoverH);
          if (shortSide < bestShort) {
            bestShort = shortSide;
            bestIdx = i;
          }
        }
      }

      if (bestIdx < 0) {
        overflow++;
        continue;
      }

      const fr = freeRects[bestIdx];
      const x = fr.x;
      const y = fr.y;
      freeRects.splice(bestIdx, 1);

      placements.push({
        itemId: entry.itemId,
        instanceIndex: entry.instanceIndex,
        x: edgePadding + x,
        y: edgePadding + y,
        width: entry.w,
        height: entry.h,
        rotated: data.isRotated,
      });

      if (fr.h - eh > 0) {
        freeRects.push({ x: fr.x, y: fr.y + eh, w: fr.w, h: fr.h - eh });
      }
      if (fr.w - ew > 0) {
        freeRects.push({ x: fr.x + ew, y: fr.y, w: fr.w - ew, h: eh });
      }

      pruneFreeList();
    }

    return { placements, overflow };
  };

  const packOriented = (data: { entries: Entry[]; isRotated: boolean }) => {
    const grid = homogeneousGridPack(data);
    return grid ?? guillotinePack(data);
  };

  const normalResult = packOriented(buildEntries(false));
  const rotatedResult = packOriented(buildEntries(true));

  const best = rotatedResult.placements.length > normalResult.placements.length
    ? rotatedResult : normalResult;

  const totalArea = sheetWidth * sheetHeight;
  const usedArea = best.placements.reduce((sum, p) => sum + p.width * p.height, 0);
  const utilization = totalArea > 0 ? usedArea / totalArea : 0;

  return { placements: best.placements, overflow: best.overflow, utilization };
}

/** Largest quantity for `itemId` that packs with zero overflow (others keep their current quantities). */
export function maxQuantityForItem(
  items: GangSheetItem[],
  settings: GangSheetSettings,
  itemId: string,
  hiCap: number = MAX_GANG_SHEET_USER_QUANTITY
): number {
  const { sheetWidth, sheetHeight, gap, edgePadding } = settings;
  const usableW = sheetWidth - edgePadding * 2;
  const usableH = sheetHeight - edgePadding * 2;
  const target = items.find((i) => i.id === itemId);
  if (!target) return 1;
  const w0 = target.contourData.widthInches;
  const h0 = target.contourData.heightInches;
  const soloGrid = Math.max(
    gridPlacementUpperBound(usableW, usableH, gap, w0, h0),
    gridPlacementUpperBound(usableW, usableH, gap, h0, w0)
  );
  const sumOtherQty = items
    .filter((i) => i.id !== itemId)
    .reduce((s, i) => s + clampGangSheetQuantity(i.quantity), 0);
  const derivedHi = Math.max(1, soloGrid + sumOtherQty + 64);
  const mk = (q: number) =>
    items.map((i) => (i.id === itemId ? { ...i, quantity: q } : i));
  let lo = 1;
  let hi = Math.max(1, Math.min(hiCap, derivedHi, MAX_GANG_SHEET_USER_QUANTITY));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const pack = packGangSheet(mk(mid), settings);
    if (pack.overflow === 0) lo = mid;
    else hi = mid - 1;
  }
  while (lo > 1 && packGangSheet(mk(lo), settings).overflow > 0) lo--;
  return Math.max(1, lo);
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
      // CCW 90° rotation to match the image rotation (`rotate(-π/2)`) applied
      // to the design pixels. Using a transpose here instead would mirror the
      // contour relative to the image for asymmetric designs (e.g. text
      // protruding off one edge), causing the cutline to miss the design
      // content after the packer flips to the rotated layout.
      if (isShape) {
        sx = placementX + p.y;
        sy = sheetHeightInches - (placementY + (itemWidthInches - p.x));
      } else {
        sx = placementX + (itemHeightInches - p.y);
        sy = sheetHeightInches - (placementY + (itemWidthInches - p.x));
      }
    } else {
      const localY = isShape ? p.y : (itemHeightInches - p.y);
      sx = placementX + p.x;
      sy = sheetHeightInches - (placementY + localY);
    }
    return { x: sx, y: sy };
  });
}

// Remap a Bezier path the same way `remapPathToSheet` remaps a polyline:
// transform every anchor and every control point. Anchors and control points
// share the same coordinate space (item-local PDF inches), so the same affine
// transform applies. Used by the gang-sheet Zero Hero export so smooth curves
// survive the placement transform.
function remapBezierPathToSheet(
  bp: BezierPath,
  itemWidthInches: number,
  itemHeightInches: number,
  placementX: number,
  placementY: number,
  sheetHeightInches: number,
  rotated: boolean,
  isShape: boolean
): BezierPath {
  const tx = (p: { x: number; y: number }): { x: number; y: number } => {
    let sx: number, sy: number;
    if (rotated) {
      // Same CCW 90° rotation as remapPathToSheet — see the comment there for
      // why a transpose breaks asymmetric designs after the packer rotates.
      if (isShape) {
        sx = placementX + p.y;
        sy = sheetHeightInches - (placementY + (itemWidthInches - p.x));
      } else {
        sx = placementX + (itemHeightInches - p.y);
        sy = sheetHeightInches - (placementY + (itemWidthInches - p.x));
      }
    } else {
      const localY = isShape ? p.y : (itemHeightInches - p.y);
      sx = placementX + p.x;
      sy = sheetHeightInches - (placementY + localY);
    }
    return { x: sx, y: sy };
  };
  return {
    start: tx(bp.start),
    segments: bp.segments.map(seg =>
      seg.type === 'line'
        ? { type: 'line', to: tx(seg.to) }
        : { type: 'cubic', cp1: tx(seg.cp1), cp2: tx(seg.cp2), to: tx(seg.to) }
    ),
    closed: true,
  };
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
  const bgCtx = bgCanvas.getContext('2d', { alpha: true });
  if (!bgCtx) throw new Error('Failed to create background canvas context');

  const effectiveBgDPI = bgDPI * bgClamped.scale;

  // Transparent sheet; only sticker fills/bleeds are painted (gaps stay clear in the PNG alpha).
  bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);

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
  const flippedCtx = flippedBg.getContext('2d', { alpha: true });
  if (!flippedCtx) throw new Error('Failed to create flipped background canvas context');
  flippedCtx.clearRect(0, 0, flippedBg.width, flippedBg.height);
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
      // QR-safe rasterise: if the design has detected QRs and the user
      // hasn't opted out, replace each QR's pixel region with a freshly
      // rendered, integer-pixel-aligned QR at the destination scale.
      // Otherwise fall back to a plain drawImage. Same output shape either
      // way (a canvas at imgClamped.w × imgClamped.h).
      const useQRFix = item.qrRerenderEnabled === true && item.qrCodes && item.qrCodes.length > 0;
      const canvas = useQRFix
        ? await renderImageWithCrispQRs(item.imageElement, {
            destWidth: imgClamped.w,
            destHeight: imgClamped.h,
            qrCodes: item.qrCodes!,
          })
        : (() => {
            const c = document.createElement('canvas');
            c.width = imgClamped.w;
            c.height = imgClamped.h;
            const cx = c.getContext('2d');
            if (!cx) throw new Error(`Failed to create design canvas context for ${item.id}`);
            cx.drawImage(item.imageElement, 0, 0, imgClamped.w, imgClamped.h);
            return c;
          })();

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
          // QR-safe: rasterise the un-rotated design at full target resolution
          // first (with crisp QR overlays), then rotate that. Keeps the QR's
          // module grid integer-aligned in the un-rotated canvas before the
          // 90° turn — the rotation is exact (no resampling), so crispness
          // survives.
          const srcClamped = clampCanvasDims(imgNatW, imgNatH);
          const useQRFix = item.qrRerenderEnabled === true && item.qrCodes && item.qrCodes.length > 0;
          const sourceForRotation: CanvasImageSource = useQRFix
            ? await renderImageWithCrispQRs(item.imageElement, {
                destWidth: srcClamped.w,
                destHeight: srcClamped.h,
                qrCodes: item.qrCodes!,
              })
            : item.imageElement;
          rotCtx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
          rotCtx.rotate(-Math.PI / 2);
          rotCtx.drawImage(sourceForRotation, -srcClamped.w / 2, -srcClamped.h / 2, srcClamped.w, srcClamped.h);
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
    const isShapeCut = !!item.shapeSettings?.enabled;
    // Zero Hero items have `strokeSettings.width === 0` AND carry the
    // `allBezierPaths` field produced by the corner-aware Bezier
    // reconstruction in the worker. When present, we emit those directly
    // as smooth `c` operators (preview-≡-PDF parity); otherwise fall
    // back to the polyline emit path.
    const isZeroHero = item.strokeSettings.width === 0;
    const useBezier = isZeroHero
      && contourData.allBezierPaths
      && contourData.allBezierPaths.length > 0;

    if (useBezier) {
      for (const bp of contourData.allBezierPaths!) {
        const remappedBp = remapBezierPathToSheet(
          bp, contourData.widthInches, contourData.heightInches,
          placement.x, placement.y, sheetHeight,
          !!placement.rotated, isShapeCut
        );
        allPathOps += bezierPathToPDFPathOps(remappedBp, sheetHeight, label);
      }
    } else {
      const paths = contourData.allPathPoints && contourData.allPathPoints.length > 0
        ? contourData.allPathPoints
        : [contourData.pathPoints];
      for (const path of paths) {
        const remapped = remapPathToSheet(
          path, contourData.widthInches, contourData.heightInches,
          placement.x, placement.y, sheetHeight,
          !!placement.rotated, isShapeCut
        );
        // Zero Hero polyline fallback (no bezier data available): disable
        // Catmull-Rom spline smoothing so the cut path matches the preview
        // exactly. Same convention as `downloadContourPDF` in contour-outline.
        allPathOps += contourPointsToPDFPathOps(remapped, sheetHeight, label, isZeroHero);
      }
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

  // --- Spot color vector layers (RDG_WHITE / RDG_GLOSS / fluorescent) ---
  // For each item with active spot color flags, trace its regions ONCE and
  // tile them across every placement on the sheet. All separations land on
  // the same page (singleArtboard semantics), color spaces deduped by name.
  const spotItems = items
    .filter(item => item.spotColors && item.spotColors.length > 0)
    .map(item => {
      const itemPlacements = placements
        .filter(p => p.itemId === item.id)
        .map(p => ({ x: p.x, y: p.y, rotated: !!p.rotated }));
      return {
        imageElement: item.imageElement,
        spotColors: item.spotColors!,
        spotPixelMap: item.spotPixelMap,
        widthInches: item.contourData.widthInches,
        heightInches: item.contourData.heightInches,
        placements: itemPlacements,
      };
    })
    .filter(it => it.placements.length > 0);

  if (spotItems.length > 0) {
    try {
      await addGangSheetSpotColorsToPDF(pdfDoc, page, spotItems, sheetHeight);
    } catch (err) {
      // Don't fail the whole PDF if spot color tracing throws — log and skip.
      console.error('[GangSheet] Spot color emission failed:', err);
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
