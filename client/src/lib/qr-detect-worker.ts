// Multi-engine QR detection worker.
//
// Goal: detection accuracy approaching a phone camera. Phones do this by
// running multiple decoders simultaneously over many frames with heavy
// preprocessing. We have a single static image, so we trade real-time
// constraints for thoroughness — running several engines × several
// preprocessing variants × several spatial tiles, then deduping results
// by payload.
//
// Engines (in priority order):
//   1. BarcodeDetector  — native browser API, backed by the OS detector
//      (CoreImage / MLKit). Best-in-class when present, near-instant. Not
//      yet available in Firefox / Safari workers; we feature-detect.
//   2. ZBar (zbar-wasm)  — compiled C/C++ ZBar, 38.95% accuracy on
//      Dynamsoft's 536-image real-world benchmark (vs ZXing 31.87%, jsQR
//      worse still). Strong on stylised, low-contrast, and partially
//      occluded codes.
//   3. jsQR             — pure JS, fast, weakest accuracy but different
//      failure mode from ZBar — sometimes catches what ZBar misses on
//      very small or very crisp synthetic QRs.
//
// Preprocessing variants (each engine sees each variant):
//   - raw                  — the source image as-is
//   - otsu                 — global Otsu threshold (handles styled dots)
//   - inverted             — for white-on-dark QRs
//   - contrast             — histogram-stretch then Otsu (low-contrast)
//   - logo-erased          — centre 22% wiped (defeats centred logos)
//   - rotated 90/180/270   — for QRs not upright (jsQR, others auto-rotate)
//   - tiled (4 quadrants)  — finds small QRs in large designs
//
// All findings are deduped by payload first (identical payloads collapse
// into one result), and ties broken by spatial overlap. The result is
// returned in image-pixel coords (caller's source image).

import jsQR from 'jsqr';
import { scanImageData, ZBarSymbolType, type ZBarSymbol } from '@undecaf/zbar-wasm';

interface DetectRequest {
  imageData: Uint8ClampedArray;
  width: number;
  height: number;
  /** Hard cap on how many QRs we attempt to detect. Default 4. */
  maxCodes?: number;
}

interface DetectedQRPayload {
  payload: string;
  /** Axis-aligned bounding box in image pixel coords (source-image space). */
  bbox: { x: number; y: number; width: number; height: number };
  corners: {
    topLeft: { x: number; y: number };
    topRight: { x: number; y: number };
    bottomLeft: { x: number; y: number };
    bottomRight: { x: number; y: number };
  };
  rotation: number;
  estimatedModuleSize: number;
  /** Which engine + variant detected this QR (debug aid, surfaces in logs). */
  source?: string;
}

// ─── Geometry helpers ────────────────────────────────────────────────────

function bboxFromCorners(corners: DetectedQRPayload['corners']): DetectedQRPayload['bbox'] {
  const xs = [corners.topLeft.x, corners.topRight.x, corners.bottomLeft.x, corners.bottomRight.x];
  const ys = [corners.topLeft.y, corners.topRight.y, corners.bottomLeft.y, corners.bottomRight.y];
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function rotationFromCorners(corners: DetectedQRPayload['corners']): number {
  const dx = corners.topRight.x - corners.topLeft.x;
  const dy = corners.topRight.y - corners.topLeft.y;
  return Math.atan2(dy, dx);
}

function estimateModuleSize(corners: DetectedQRPayload['corners']): number {
  const topEdge = Math.hypot(
    corners.topRight.x - corners.topLeft.x,
    corners.topRight.y - corners.topLeft.y,
  );
  const leftEdge = Math.hypot(
    corners.bottomLeft.x - corners.topLeft.x,
    corners.bottomLeft.y - corners.topLeft.y,
  );
  return (topEdge + leftEdge) / 2 / 21;
}

// IoU on axis-aligned bboxes — used to drop duplicate detections of the
// same physical QR by different engines / variants when their payloads
// somehow differ (rare; usually same payload + spatial overlap means same QR).
function bboxIoU(a: DetectedQRPayload['bbox'], b: DetectedQRPayload['bbox']): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return inter / union;
}

// ─── Preprocessing ───────────────────────────────────────────────────────

function rgbaToLuma(src: Uint8ClampedArray): Uint8ClampedArray {
  const luma = new Uint8ClampedArray(src.length / 4);
  for (let i = 0, j = 0; i < src.length; i += 4, j++) {
    // Premultiply against white so transparent pixels read as light, not
    // black — otherwise a transparent design with a dark QR fails Otsu.
    const a = src[i + 3] / 255;
    const r = src[i] * a + 255 * (1 - a);
    const g = src[i + 1] * a + 255 * (1 - a);
    const b = src[i + 2] * a + 255 * (1 - a);
    luma[j] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
  }
  return luma;
}

function lumaToRgba(luma: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(luma.length * 4);
  for (let i = 0, j = 0; i < luma.length; i++, j += 4) {
    out[j] = luma[i]; out[j + 1] = luma[i]; out[j + 2] = luma[i]; out[j + 3] = 255;
  }
  return out;
}

function computeOtsuThreshold(luma: Uint8ClampedArray): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < luma.length; i++) hist[luma[i]]++;
  const total = luma.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, maxVar = -1, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) { maxVar = v; threshold = t; }
  }
  return threshold;
}

function applyThreshold(luma: Uint8ClampedArray, threshold: number, invert = false): Uint8ClampedArray {
  const out = new Uint8ClampedArray(luma.length);
  if (invert) {
    for (let i = 0; i < luma.length; i++) out[i] = luma[i] < threshold ? 255 : 0;
  } else {
    for (let i = 0; i < luma.length; i++) out[i] = luma[i] < threshold ? 0 : 255;
  }
  return out;
}

// Histogram-stretch contrast normalisation — the 2nd–98th percentile range
// is mapped to [0,255]. Defeats washed-out / low-contrast QRs that Otsu
// alone can't handle because the dark and light populations sit too close.
function stretchContrast(luma: Uint8ClampedArray): Uint8ClampedArray {
  const hist = new Uint32Array(256);
  for (let i = 0; i < luma.length; i++) hist[luma[i]]++;
  let lo = 0, hi = 255;
  const lowCount = luma.length * 0.02;
  const highCount = luma.length * 0.98;
  let acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= lowCount) { lo = i; break; } }
  acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= highCount) { hi = i; break; } }
  const range = Math.max(1, hi - lo);
  const out = new Uint8ClampedArray(luma.length);
  for (let i = 0; i < luma.length; i++) {
    const v = ((luma[i] - lo) * 255 / range) | 0;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

// Wipe the centre of the image to white. Many QRs have a logo overlaid
// in the middle (Instagram, brand marks, etc) which kills decoders that
// rely on full-codeword integrity. Erasing the centre lets the decoder
// reconstruct the missing modules from QR's built-in error correction.
function eraseCentre(rgba: Uint8ClampedArray, width: number, height: number, fraction: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba);
  const w = Math.round(width * fraction);
  const h = Math.round(height * fraction);
  const x0 = Math.round((width - w) / 2);
  const y0 = Math.round((height - h) / 2);
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * width + x) * 4;
      out[i] = 255; out[i + 1] = 255; out[i + 2] = 255; out[i + 3] = 255;
    }
  }
  return out;
}

function rotateRgba90(src: Uint8ClampedArray, width: number, height: number): { data: Uint8ClampedArray; width: number; height: number } {
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sIdx = (y * width + x) * 4;
      const dx = height - 1 - y;
      const dy = x;
      const dIdx = (dy * height + dx) * 4;
      out[dIdx] = src[sIdx]; out[dIdx + 1] = src[sIdx + 1]; out[dIdx + 2] = src[sIdx + 2]; out[dIdx + 3] = src[sIdx + 3];
    }
  }
  return { data: out, width: height, height: width };
}

// Map corners detected on a rotated buffer back into the original
// source-image coordinate frame. `rotations` is the number of CW 90°
// turns applied to the source before detection.
function unrotateCorners(
  corners: DetectedQRPayload['corners'],
  rotations: number,
  origW: number,
  origH: number,
): DetectedQRPayload['corners'] {
  if (rotations === 0) return corners;
  const map = (p: { x: number; y: number }, rotsRemaining: number, w: number, h: number): { x: number; y: number } => {
    if (rotsRemaining === 0) return p;
    // Inverse of one CW 90° rotation: (x, y) → (y, w - 1 - x), mapping back
    // from a (h × w) rotated frame into the (w × h) original.
    const inv = { x: p.y, y: w - 1 - p.x };
    return map(inv, rotsRemaining - 1, h, w);
  };
  const w0 = rotations % 2 === 1 ? origH : origW;
  const h0 = rotations % 2 === 1 ? origW : origH;
  return {
    topLeft: map(corners.topLeft, rotations, w0, h0),
    topRight: map(corners.topRight, rotations, w0, h0),
    bottomLeft: map(corners.bottomLeft, rotations, w0, h0),
    bottomRight: map(corners.bottomRight, rotations, w0, h0),
  };
}

// ─── Engine adapters ─────────────────────────────────────────────────────

async function detectWithZBar(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  source: string,
): Promise<DetectedQRPayload[]> {
  try {
    const symbols: ZBarSymbol[] = await scanImageData(new ImageData(rgba, width, height));
    const out: DetectedQRPayload[] = [];
    for (const sym of symbols) {
      if (sym.type !== ZBarSymbolType.ZBAR_QRCODE) continue;
      const payload = sym.decode();
      const pts = sym.points;
      if (pts.length < 4) continue;
      // ZBar gives 4 points but order isn't guaranteed to be TL/TR/BL/BR;
      // fall back to bbox-derived corner labels so we have *some* rotation
      // estimate. A 4-point Hungarian matching would be more accurate but
      // we don't actually need precise corner identity for any downstream
      // logic — only the bbox.
      const corners = approximateCornersFromPoints(pts);
      out.push({
        payload,
        bbox: bboxFromCorners(corners),
        corners,
        rotation: rotationFromCorners(corners),
        estimatedModuleSize: estimateModuleSize(corners),
        source,
      });
    }
    return out;
  } catch (err) {
    // ZBar wasm load failure (e.g. blocked by CSP) — log once and continue.
    console.warn('[QR] ZBar engine failed, falling through to other engines:', err);
    return [];
  }
}

function approximateCornersFromPoints(points: Array<{ x: number; y: number }>): DetectedQRPayload['corners'] {
  // Sort by y, take top two as top, bottom two as bottom; within each pair
  // sort by x. Robust enough for axis-ish-aligned QRs which is what we
  // accept for the vector overlay anyway (off-axis ones are filtered).
  const sortedByY = [...points].sort((a, b) => a.y - b.y);
  const top = sortedByY.slice(0, 2).sort((a, b) => a.x - b.x);
  const bot = sortedByY.slice(2, 4).sort((a, b) => a.x - b.x);
  return {
    topLeft: top[0],
    topRight: top[1],
    bottomLeft: bot[0],
    bottomRight: bot[1],
  };
}

function detectWithJsQR(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  source: string,
): DetectedQRPayload[] {
  const out: DetectedQRPayload[] = [];
  // jsQR finds one per call; iterate by masking out and re-running.
  const buf = new Uint8ClampedArray(rgba);
  for (let i = 0; i < 6; i++) {
    const result = jsQR(buf, width, height, { inversionAttempts: 'attemptBoth' });
    if (!result) break;
    const corners = {
      topLeft: result.location.topLeftCorner,
      topRight: result.location.topRightCorner,
      bottomLeft: result.location.bottomLeftCorner,
      bottomRight: result.location.bottomRightCorner,
    };
    const bbox = bboxFromCorners(corners);
    if (bbox.width < 8 || bbox.height < 8 || bbox.width > width || bbox.height > height) break;
    out.push({
      payload: result.data,
      bbox,
      corners,
      rotation: rotationFromCorners(corners),
      estimatedModuleSize: estimateModuleSize(corners),
      source,
    });
    // Mask the QR out of the buffer so the next iteration can find another.
    const x0 = Math.max(0, Math.floor(bbox.x));
    const y0 = Math.max(0, Math.floor(bbox.y));
    const x1 = Math.min(width, Math.ceil(bbox.x + bbox.width));
    const y1 = Math.min(height, Math.ceil(bbox.y + bbox.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * width + x) * 4;
        buf[idx] = 255; buf[idx + 1] = 255; buf[idx + 2] = 255; buf[idx + 3] = 255;
      }
    }
  }
  return out;
}

// Native BarcodeDetector — backed by the OS detector when available
// (CoreImage / MLKit). Easily the most accurate engine when present.
// We feature-detect because it's not yet in Firefox / Safari workers.
interface NativeBarcode {
  rawValue: string;
  cornerPoints: Array<{ x: number; y: number }>;
  boundingBox: DOMRectReadOnly;
}
interface NativeBarcodeDetector {
  detect: (image: ImageBitmap | ImageData) => Promise<NativeBarcode[]>;
}
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => NativeBarcodeDetector;

async function detectWithNative(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  source: string,
): Promise<DetectedQRPayload[]> {
  const Ctor = (self as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (!Ctor) return [];
  try {
    const detector = new Ctor({ formats: ['qr_code'] });
    const imageData = new ImageData(rgba, width, height);
    // Some implementations want an ImageBitmap; try ImageData first, fall
    // back to bitmap if rejected.
    let results: NativeBarcode[];
    try {
      results = await detector.detect(imageData);
    } catch {
      const bmp = await createImageBitmap(imageData);
      results = await detector.detect(bmp);
      bmp.close();
    }
    const out: DetectedQRPayload[] = [];
    for (const r of results) {
      const pts = r.cornerPoints && r.cornerPoints.length === 4
        ? r.cornerPoints
        : [
            { x: r.boundingBox.left, y: r.boundingBox.top },
            { x: r.boundingBox.right, y: r.boundingBox.top },
            { x: r.boundingBox.right, y: r.boundingBox.bottom },
            { x: r.boundingBox.left, y: r.boundingBox.bottom },
          ];
      const corners = approximateCornersFromPoints(pts);
      out.push({
        payload: r.rawValue,
        bbox: bboxFromCorners(corners),
        corners,
        rotation: rotationFromCorners(corners),
        estimatedModuleSize: estimateModuleSize(corners),
        source,
      });
    }
    return out;
  } catch (err) {
    console.warn('[QR] BarcodeDetector engine failed, falling through:', err);
    return [];
  }
}

// ─── Variant runner ──────────────────────────────────────────────────────

interface DetectionContext {
  width: number;
  height: number;
  rotations: number; // 0–3, # of 90° CW rotations applied before detection
  baseOriginX: number; // for tile crops: where this tile sits in the source
  baseOriginY: number;
}

async function runEngines(
  rgba: Uint8ClampedArray,
  ctx: DetectionContext,
  variant: string,
  origW: number,
  origH: number,
): Promise<DetectedQRPayload[]> {
  const findings: DetectedQRPayload[] = [];

  // Engine order: native first (best when present), then ZBar (best
  // open-source), then jsQR (different failure mode catches edge cases).
  const native = await detectWithNative(rgba, ctx.width, ctx.height, `native:${variant}`);
  findings.push(...native);

  const zbar = await detectWithZBar(rgba, ctx.width, ctx.height, `zbar:${variant}`);
  findings.push(...zbar);

  const js = detectWithJsQR(rgba, ctx.width, ctx.height, `jsqr:${variant}`);
  findings.push(...js);

  // Map all findings back into source-image coordinate space.
  return findings.map((f) => {
    const corners = unrotateCorners(f.corners, ctx.rotations, origW, origH);
    const sourceCorners = {
      topLeft: { x: corners.topLeft.x + ctx.baseOriginX, y: corners.topLeft.y + ctx.baseOriginY },
      topRight: { x: corners.topRight.x + ctx.baseOriginX, y: corners.topRight.y + ctx.baseOriginY },
      bottomLeft: { x: corners.bottomLeft.x + ctx.baseOriginX, y: corners.bottomLeft.y + ctx.baseOriginY },
      bottomRight: { x: corners.bottomRight.x + ctx.baseOriginX, y: corners.bottomRight.y + ctx.baseOriginY },
    };
    return {
      ...f,
      corners: sourceCorners,
      bbox: bboxFromCorners(sourceCorners),
      rotation: rotationFromCorners(sourceCorners),
      estimatedModuleSize: estimateModuleSize(sourceCorners),
    };
  });
}

// ─── Dedup ───────────────────────────────────────────────────────────────

function dedupe(findings: DetectedQRPayload[]): DetectedQRPayload[] {
  // Group by payload (the exclusion principle for "is this the same QR").
  // Within each payload, prefer the finding with the largest bbox area
  // (usually the most accurate localisation), and merge any spatial
  // overlaps.
  const byPayload = new Map<string, DetectedQRPayload[]>();
  for (const f of findings) {
    const arr = byPayload.get(f.payload) ?? [];
    arr.push(f);
    byPayload.set(f.payload, arr);
  }
  const out: DetectedQRPayload[] = [];
  byPayload.forEach((group) => {
    // Cluster within payload by bbox IoU — handles the (rare) case of two
    // identical QRs in the same image at different locations.
    const clusters: DetectedQRPayload[][] = [];
    for (const f of group) {
      let placed = false;
      for (const cluster of clusters) {
        if (cluster.some((c) => bboxIoU(c.bbox, f.bbox) > 0.3)) {
          cluster.push(f);
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push([f]);
    }
    for (const cluster of clusters) {
      // Pick the largest-bbox representative — that engine likely had the
      // best fix on the corners.
      cluster.sort((a, b) => b.bbox.width * b.bbox.height - a.bbox.width * a.bbox.height);
      out.push(cluster[0]);
    }
  });
  return out;
}

// ─── Main pipeline ───────────────────────────────────────────────────────

// Pixel budget for downscaling huge images before running detection. ZBar
// and jsQR both struggle and use proportional memory on multi-megapixel
// images. 1.5MP is plenty for QR localisation (a real QR needs ~5-7px per
// module to decode reliably; even at 1.5MP we have headroom for QRs as
// small as ~100px on a 4-inch sticker design). Source-coord findings get
// scaled back up by the caller.
const DETECT_PIXEL_BUDGET = 1_500_000;

function maybeDownscale(src: Uint8ClampedArray, width: number, height: number): { rgba: Uint8ClampedArray; w: number; h: number; scale: number } {
  const total = width * height;
  if (total <= DETECT_PIXEL_BUDGET) return { rgba: src, w: width, h: height, scale: 1 };
  const scale = Math.sqrt(DETECT_PIXEL_BUDGET / total);
  const newW = Math.max(1, Math.round(width * scale));
  const newH = Math.max(1, Math.round(height * scale));
  // Bilinear downscale — fine for QR localisation, much faster than offscreen
  // canvas calls inside a worker.
  const out = new Uint8ClampedArray(newW * newH * 4);
  const xRatio = width / newW;
  const yRatio = height / newH;
  for (let y = 0; y < newH; y++) {
    const sy = Math.min(height - 1, Math.floor(y * yRatio));
    for (let x = 0; x < newW; x++) {
      const sx = Math.min(width - 1, Math.floor(x * xRatio));
      const sIdx = (sy * width + sx) * 4;
      const dIdx = (y * newW + x) * 4;
      out[dIdx] = src[sIdx]; out[dIdx + 1] = src[sIdx + 1]; out[dIdx + 2] = src[sIdx + 2]; out[dIdx + 3] = src[sIdx + 3];
    }
  }
  return { rgba: out, w: newW, h: newH, scale };
}

self.onmessage = async (e: MessageEvent) => {
  const { imageData, width: srcW, height: srcH, maxCodes = 4 } = e.data as DetectRequest;
  const start = Date.now();

  try {
    // Downscale huge images before detection. We map detected coords back
    // to source-image space at the very end so callers always see
    // source-pixel bboxes.
    const { rgba: workRgba, w: width, h: height, scale: workScale } = maybeDownscale(imageData, srcW, srcH);
    const upscale = 1 / workScale;

    // Compute luma + Otsu once — these feed many variants, no point
    // recomputing.
    const luma = rgbaToLuma(workRgba);
    const otsuT = computeOtsuThreshold(luma);
    const stretched = stretchContrast(luma);
    const stretchedOtsuT = computeOtsuThreshold(stretched);
    const otsuRgba = lumaToRgba(applyThreshold(luma, otsuT));

    // Variants are described as factory functions so we never hold more
    // than one large RGBA buffer in memory at a time. Order is rough
    // priority — earlier variants are cheaper / more common to succeed.
    type VariantFn = () => { name: string; rgba: Uint8ClampedArray; w: number; h: number; rotations: number; baseOriginX: number; baseOriginY: number };
    const variantFactories: VariantFn[] = [
      () => ({ name: 'raw', rgba: workRgba, w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
      () => ({ name: 'otsu', rgba: otsuRgba, w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
      () => ({ name: 'logo-erased', rgba: eraseCentre(workRgba, width, height, 0.22), w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
      () => ({ name: 'otsu+logo-erased', rgba: eraseCentre(otsuRgba, width, height, 0.22), w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
      () => ({ name: 'otsu-inv', rgba: lumaToRgba(applyThreshold(luma, otsuT, true)), w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
      () => ({ name: 'contrast', rgba: lumaToRgba(applyThreshold(stretched, stretchedOtsuT)), w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
    ];
    // Rotation variants — most engines auto-rotate but jsQR doesn't, and
    // some heavily-stylised QRs are easier for engines to localise when
    // upright. Generate on-demand to avoid keeping rotated buffers around.
    for (let r = 1; r <= 3; r++) {
      const turns = r;
      variantFactories.push(() => {
        let rotated = { data: workRgba, width, height };
        for (let i = 0; i < turns; i++) rotated = rotateRgba90(rotated.data, rotated.width, rotated.height);
        return { name: `rot${turns * 90}`, rgba: rotated.data, w: rotated.width, h: rotated.height, rotations: turns, baseOriginX: 0, baseOriginY: 0 };
      });
    }

    const allFindings: DetectedQRPayload[] = [];
    for (const factory of variantFactories) {
      const v = factory();
      const ctx: DetectionContext = { width: v.w, height: v.h, rotations: v.rotations, baseOriginX: v.baseOriginX, baseOriginY: v.baseOriginY };
      const found = await runEngines(v.rgba, ctx, v.name, width, height);
      allFindings.push(...found);
      const distinct = new Set(allFindings.map((f) => f.payload)).size;
      // Aggressive early-exit: once we've found `maxCodes` distinct
      // payloads, we're done — every additional variant just adds dedup
      // work for no new info. Most simple designs hit this on variant 1.
      if (distinct >= maxCodes) break;
    }

    // Tile-based scan — only run if we haven't found enough yet *and*
    // the source is large enough that small QRs tucked into corners are
    // plausible after the work-canvas downscale.
    const distinctSoFar = new Set(allFindings.map((f) => f.payload)).size;
    if (distinctSoFar < maxCodes && Math.max(width, height) >= 800) {
      const tw = Math.floor(width / 2);
      const th = Math.floor(height / 2);
      const overlap = Math.floor(Math.min(tw, th) * 0.25);
      const tiles: Array<{ x: number; y: number; w: number; h: number }> = [
        { x: 0, y: 0, w: tw + overlap, h: th + overlap },
        { x: tw - overlap, y: 0, w: width - (tw - overlap), h: th + overlap },
        { x: 0, y: th - overlap, w: tw + overlap, h: height - (th - overlap) },
        { x: tw - overlap, y: th - overlap, w: width - (tw - overlap), h: height - (th - overlap) },
      ];
      for (const tile of tiles) {
        const tileBuf = new Uint8ClampedArray(tile.w * tile.h * 4);
        for (let y = 0; y < tile.h; y++) {
          const srcRow = (tile.y + y) * width * 4;
          const dstRow = y * tile.w * 4;
          tileBuf.set(workRgba.subarray(srcRow + tile.x * 4, srcRow + (tile.x + tile.w) * 4), dstRow);
        }
        const tileLuma = rgbaToLuma(tileBuf);
        const tileOtsu = computeOtsuThreshold(tileLuma);
        const tileOtsuRgba = lumaToRgba(applyThreshold(tileLuma, tileOtsu));
        for (const tv of [
          { name: `tile-raw[${tile.x},${tile.y}]`, rgba: tileBuf },
          { name: `tile-otsu[${tile.x},${tile.y}]`, rgba: tileOtsuRgba },
        ]) {
          const ctx: DetectionContext = { width: tile.w, height: tile.h, rotations: 0, baseOriginX: tile.x, baseOriginY: tile.y };
          const found = await runEngines(tv.rgba, ctx, tv.name, tile.w, tile.h);
          allFindings.push(...found);
          if (new Set(allFindings.map((f) => f.payload)).size >= maxCodes) break;
        }
        if (new Set(allFindings.map((f) => f.payload)).size >= maxCodes) break;
      }
    }

    // Map work-coords back to source-image coords.
    const sourceCoordFindings = upscale === 1 ? allFindings : allFindings.map((f) => {
      const map = (p: { x: number; y: number }) => ({ x: p.x * upscale, y: p.y * upscale });
      const corners = {
        topLeft: map(f.corners.topLeft),
        topRight: map(f.corners.topRight),
        bottomLeft: map(f.corners.bottomLeft),
        bottomRight: map(f.corners.bottomRight),
      };
      return {
        ...f,
        corners,
        bbox: bboxFromCorners(corners),
        rotation: rotationFromCorners(corners),
        estimatedModuleSize: estimateModuleSize(corners),
      };
    });

    const deduped = dedupe(sourceCoordFindings);
    const final = deduped.filter((f) =>
      f.bbox.width >= 8 && f.bbox.height >= 8 &&
      f.bbox.width <= srcW * 1.05 && f.bbox.height <= srcH * 1.05);

    if (final.length > 0) {
      const sources = final.map((f) => `"${f.payload.slice(0, 30)}${f.payload.length > 30 ? '…' : ''}" via ${f.source}`).join(' | ');
      console.log(`[QR worker] ${final.length} unique QR(s) in ${Date.now() - start}ms (workScale=${workScale.toFixed(2)}) — ${sources}`);
    } else {
      console.log(`[QR worker] No QRs found in ${Date.now() - start}ms (workScale=${workScale.toFixed(2)})`);
    }

    (self as unknown as Worker).postMessage({
      type: 'result',
      qrCodes: final.slice(0, maxCodes),
      elapsedMs: Date.now() - start,
    });
  } catch (err: unknown) {
    (self as unknown as Worker).postMessage({
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export {};
