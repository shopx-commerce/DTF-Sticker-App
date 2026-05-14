// QR-safe export pipeline.
//
// Print stickers often contain QR codes. The standard sticker workflow
// downscales the design to the print pixel resolution (e.g. a 1000x1000 px
// upload becoming 600x600 for a 2-inch sticker at 300 DPI). Continuous-tone
// resamplers (Lanczos, bicubic) turn the QR's hard B/W edges into gray
// gradients — visually subtle, but a real cause of scanner failures at
// small print sizes.
//
// This module solves it the gold-standard way:
//   1. On upload, run jsQR on the source image (off-thread) to detect QRs
//      and extract their payloads + bboxes.
//   2. At every export step that scales the design to its final pixel size,
//      replace each detected QR region with a freshly-generated QR rendered
//      directly at the target pixel size with `qrcode`. Modules are
//      mathematically perfect, integer-pixel-aligned, max contrast.
//
// The detector is a one-time pass per upload; the re-render is a fast
// canvas op per export.

import QRCode, { type QRCodeErrorCorrectionLevel } from 'qrcode';
import QrDetectWorker from './qr-detect-worker?worker';

export interface DetectedQR {
  payload: string;
  /** Axis-aligned bbox in source image-pixel coords (no quiet zone — QR proper). */
  bbox: { x: number; y: number; width: number; height: number };
  corners: {
    topLeft: { x: number; y: number };
    topRight: { x: number; y: number };
    bottomLeft: { x: number; y: number };
    bottomRight: { x: number; y: number };
  };
  /** Rotation in radians, 0 = upright. Computed from topLeft → topRight edge. */
  rotation: number;
  /** Estimated module size in source pixels. Useful for quiet-zone math. */
  estimatedModuleSize: number;
}

export interface DetectQRsOptions {
  /** Hard cap on QRs to attempt to detect. Default 4. */
  maxCodes?: number;
}

let detectWorker: Worker | null = null;
function getDetectWorker(): Worker {
  if (!detectWorker) detectWorker = new QrDetectWorker();
  return detectWorker;
}

/**
 * Detect every QR code in the source image. Runs jsQR off-thread.
 * Returns an empty array if no QRs are present (this is the common case
 * for non-QR designs — fast no-op).
 */
// ─── Server-side fallback detection ─────────────────────────────────────
// Uploads the image to /api/detect-qr and runs jsQR in Node.js over
// multiple preprocessing variants. Used when the in-browser worker finds
// nothing — bypasses all wasm/CORS/CSP/browser-compatibility issues.
async function detectQRsOnServer(image: HTMLImageElement): Promise<DetectedQR[]> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return [];
    // White background so transparent pixels become white, not black —
    // otherwise a QR on a transparent PNG looks dark on black → unreadable.
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) return [];

    const form = new FormData();
    form.append('image', blob, 'design.png');
    const resp = await fetch('/api/detect-qr', { method: 'POST', body: form });
    if (!resp.ok) return [];
    const json = await resp.json() as { qrCodes?: DetectedQR[] };
    return json.qrCodes ?? [];
  } catch {
    return [];
  }
}

export function detectQRsInImage(
  image: HTMLImageElement,
  options: DetectQRsOptions = {}
): Promise<DetectedQR[]> {
  return new Promise((resolve, reject) => {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;

    if (!width || !height) {
      // Image not decoded yet — skip worker, go straight to server fallback
      detectQRsOnServer(image).then(resolve).catch(reject);
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return reject(new Error('Failed to get canvas context for QR detection'));
    // Use a white background so transparent designs don't trip jsQR's
    // contrast detection (it expects opaque B/W).
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0);

    const imageData = ctx.getImageData(0, 0, width, height);
    const buffer = new Uint8ClampedArray(imageData.data);

    const worker = getDetectWorker();

    const onMessage = (e: MessageEvent) => {
      // Forward worker log messages to the main-thread console so failures
      // are visible without needing DevTools worker context switching.
      if (e.data.type === 'log') {
        console.log('[QR worker]', e.data.message);
        return; // keep listening — result comes in a separate message
      }
      if (e.data.type === 'warn') {
        console.warn('[QR worker]', e.data.message);
        return;
      }

      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);

      if (e.data.type === 'error') return reject(new Error(e.data.error));

      const codes = (e.data.qrCodes ?? []) as DetectedQR[];
      if (codes.length > 0) {
        resolve(codes);
        return;
      }

      // Worker found nothing — try the server-side fallback before giving up.
      console.log('[QR] Worker found 0 codes, trying server-side fallback…');
      detectQRsOnServer(image).then((serverCodes) => {
        if (serverCodes.length > 0) {
          console.log(`[QR] Server fallback found ${serverCodes.length} QR(s)`);
        } else {
          console.log('[QR] Server fallback also found 0 QRs — design has no QR code');
        }
        resolve(serverCodes);
      }).catch(() => resolve([]));
    };

    const onError = (err: ErrorEvent) => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      // Worker crashed — try server fallback
      console.warn('[QR] Worker error, trying server fallback:', err.message);
      detectQRsOnServer(image).then(resolve).catch(() => resolve([]));
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage(
      { imageData: buffer, width, height, maxCodes: options.maxCodes ?? 4 },
      [buffer.buffer]
    );
  });
}

export interface RenderCrispQROptions {
  /** Size in pixels of the rendered QR (square). Module count auto-detected from payload. */
  sizePx: number;
  /** Error correction level. 'M' (15%) is fine for clean prints; 'H' (30%) for outdoor / ink wear. Default 'M'. */
  errorCorrectionLevel?: QRCodeErrorCorrectionLevel;
  /** Quiet zone in *modules* around the QR. Standard requires 4. Default 0 — caller decides whether to include. */
  margin?: number;
  /** Foreground colour (default pure black). */
  dark?: string;
  /** Background colour (default pure white). */
  light?: string;
}

/**
 * Render a crisp QR code at the exact target pixel size, with mathematically
 * perfect modules. Uses the `qrcode` npm package which renders with
 * nearest-neighbor module placement → no anti-aliasing → no scanner blur.
 */
export async function renderCrispQR(
  payload: string,
  options: RenderCrispQROptions
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  await QRCode.toCanvas(canvas, payload, {
    width: options.sizePx,
    margin: options.margin ?? 0,
    errorCorrectionLevel: options.errorCorrectionLevel ?? 'M',
    color: {
      dark: options.dark ?? '#000000FF',
      light: options.light ?? '#FFFFFFFF',
    },
  });
  return canvas;
}

export interface RenderImageWithCrispQRsOptions {
  /** Final canvas width in pixels. */
  destWidth: number;
  /** Final canvas height in pixels. */
  destHeight: number;
  /** Detected QRs in source image-pixel coords (unscaled). */
  qrCodes: DetectedQR[];
  /** Error correction level for re-rendered QRs. Default 'M'. */
  errorCorrectionLevel?: QRCodeErrorCorrectionLevel;
  /** Optional draw kernel for the design (default: high-quality bicubic-equivalent). */
  imageSmoothingQuality?: ImageSmoothingQuality;
}

/**
 * Draw an image at a target size and overlay crisp re-rendered QRs.
 * Drop-in replacement for the pattern:
 *
 *     ctx.drawImage(image, 0, 0, destW, destH);
 *
 * → returns a canvas of `destW × destH` with the design + crisp QRs.
 *
 * Behaviour:
 *  - QRs whose bbox is heavily distorted (rotation > 45° from axis-aligned
 *    or width/height ratio off by > 30%) are left as-is (re-rendering them
 *    would require perspective correction beyond our scope; the original
 *    pixels are preserved which is no worse than the status quo).
 *  - QRs are rendered with rotation matching the source.
 *  - The re-rendered QR is sized to *match the source bbox* in destination
 *    space, not "the standard QR module count × dest module size" — this
 *    keeps it visually identical to the original at the right footprint.
 */
export async function renderImageWithCrispQRs(
  source: HTMLImageElement,
  options: RenderImageWithCrispQRsOptions
): Promise<HTMLCanvasElement> {
  const { destWidth, destHeight, qrCodes } = options;
  const canvas = document.createElement('canvas');
  canvas.width = destWidth;
  canvas.height = destHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get 2D context for QR-safe render');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = options.imageSmoothingQuality ?? 'high';
  ctx.drawImage(source, 0, 0, destWidth, destHeight);

  if (qrCodes.length === 0) return canvas;

  const srcW = source.naturalWidth || source.width;
  const srcH = source.naturalHeight || source.height;
  const scaleX = destWidth / srcW;
  const scaleY = destHeight / srcH;

  for (const qr of qrCodes) {
    // Aspect-ratio guard: a real QR is square. If the detected bbox is
    // strongly non-square the detection was probably noise — skip.
    const aspect = qr.bbox.width / qr.bbox.height;
    if (aspect < 0.7 || aspect > 1.4) continue;

    // Rotation guard: anything beyond ~45° is probably a perspective-distorted
    // QR (photo of a sticker on a curved surface, etc). Re-rendering would
    // require a perspective warp — beyond v1 scope. Leave the original.
    const rotDeg = (qr.rotation * 180) / Math.PI;
    const normalisedRotDeg = ((rotDeg % 90) + 90) % 90;
    const offAxis = Math.min(normalisedRotDeg, 90 - normalisedRotDeg);
    if (offAxis > 8) continue; // mild rotation OK; severe perspective skipped

    // Destination rectangle for this QR in the output canvas.
    const destX = qr.bbox.x * scaleX;
    const destY = qr.bbox.y * scaleY;
    const destQrW = qr.bbox.width * scaleX;
    const destQrH = qr.bbox.height * scaleY;
    const destSize = Math.round(Math.max(destQrW, destQrH));
    if (destSize < 12) continue; // too small to bother — would be unscannable anyway

    let crisp: HTMLCanvasElement;
    try {
      crisp = await renderCrispQR(qr.payload, {
        sizePx: destSize,
        margin: 0,
        errorCorrectionLevel: options.errorCorrectionLevel ?? 'M',
      });
    } catch {
      // qrcode lib refused to encode (e.g. payload too long for max version).
      // Leave the original pixels alone in that case — better than a partial
      // render that won't scan.
      continue;
    }

    // Clear the underlying region (so a transparent design stays transparent
    // outside the QR), then draw the crisp version. Apply rotation if any.
    if (Math.abs(rotDeg) > 0.5) {
      const cx = destX + destQrW / 2;
      const cy = destY + destQrH / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(qr.rotation);
      ctx.clearRect(-destQrW / 2, -destQrH / 2, destQrW, destQrH);
      ctx.imageSmoothingEnabled = false; // crisp QR — no smoothing on the composite
      ctx.drawImage(crisp, -destQrW / 2, -destQrH / 2, destQrW, destQrH);
      ctx.restore();
    } else {
      ctx.clearRect(destX, destY, destQrW, destQrH);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(crisp, destX, destY, destQrW, destQrH);
    }
    ctx.imageSmoothingEnabled = true; // restore for any subsequent draws by the caller
  }

  return canvas;
}

/**
 * Convenience: produce an `HTMLImageElement` of the QR-safe render. Useful
 * when downstream code expects an Image rather than a canvas.
 */
export async function renderImageElementWithCrispQRs(
  source: HTMLImageElement,
  options: RenderImageWithCrispQRsOptions
): Promise<HTMLImageElement> {
  const canvas = await renderImageWithCrispQRs(source, options);
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode QR-safe render'));
    img.src = canvas.toDataURL('image/png');
  });
}

// ─── Vector QR pipeline ──────────────────────────────────────────────────
// The `renderImageWithCrispQRs` path above bakes a crisp raster QR into the
// design PNG. That PNG is then embedded into a PDF and the PDF rasteriser
// downscales it to the print/screen target — a 2nd resampling pass that
// re-blurs the modules.
//
// For *true* print-quality QRs we want the QR to live as actual vector
// shapes inside the PDF: the rasteriser draws the design PNG (with the QR
// region masked out so nothing fights the overlay), then strokes/fills the
// QR modules as vector geometry. Vectors stay sharp at any DPI or zoom.
//
// The two helpers below are the primitives the contour/design-only PDF
// emitters compose to do that. The PDF-side draw lives in contour-outline
// (it needs a `pdf-lib` page handle), so this module just exposes the math.

export interface QRModuleGrid {
  /** Number of modules per side (e.g. 21 for version 1, 25 for version 2). */
  size: number;
  /** Length-`size*size` bit array. modules[y*size + x] === 1 → dark module. */
  modules: Uint8Array;
}

/**
 * Re-encode a QR payload into its module bit grid. Uses the same `qrcode`
 * library as the raster renderer — `qrcode.create()` returns the underlying
 * matrix without rasterising. The bit grid is what we need to draw vector
 * modules on the PDF.
 *
 * Errors (payload too long / invalid for this ECC level / etc) bubble up so
 * the caller can decide whether to fall back to the raster path.
 */
export function getQRModuleGrid(
  payload: string,
  // Defaults to 'H' (30% error-correction capacity). QRs with a centred
  // logo overlay obscure ~10–25% of modules, which exceeds what 'M' (15%)
  // can recover from — so a re-encoded QR at 'M' overlaid with the
  // source logo will fail to decode. 'H' gives enough headroom for
  // typical logo coverage and matches what most logo-style QR generators
  // already use under the hood.
  errorCorrectionLevel: QRCodeErrorCorrectionLevel = 'H'
): QRModuleGrid {
  const qr = QRCode.create(payload, { errorCorrectionLevel });
  // qrcode's internal modules object exposes `data` (Uint8Array) and `size`.
  const size = (qr.modules as { size: number }).size;
  const data = (qr.modules as { data: Uint8Array }).data;
  // Defensive copy — qrcode caches its result and we don't want a downstream
  // mutation to corrupt that cache.
  return { size, modules: new Uint8Array(data) };
}

/**
 * Returns a copy of `source` with the QR bounding boxes wiped to a flat
 * fill colour (default white, opaque). Use this on the design canvas
 * *before* embedding it into the PDF when you plan to overlay vector QR
 * modules — otherwise the underlying raster QR fights with the vector draw
 * and you get aliasing artefacts at the seams.
 */
export function maskQRRegionsOnCanvas(
  source: HTMLImageElement | HTMLCanvasElement,
  qrCodes: DetectedQR[],
  options: {
    /** Padding in *source pixels* around each QR bbox to also wipe. Default 0. */
    paddingPx?: number;
    /** Fill colour for the wiped region. Default '#FFFFFF'. */
    fill?: string;
    /** If true, makes the wiped region transparent instead of filled. Default false. */
    transparent?: boolean;
  } = {}
): HTMLCanvasElement {
  const w = (source as HTMLImageElement).naturalWidth || source.width;
  const h = (source as HTMLImageElement).naturalHeight || source.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('Failed to get 2D context for QR masking');

  ctx.drawImage(source, 0, 0, w, h);
  const pad = options.paddingPx ?? 0;

  for (const qr of qrCodes) {
    const x = Math.max(0, Math.floor(qr.bbox.x - pad));
    const y = Math.max(0, Math.floor(qr.bbox.y - pad));
    const ww = Math.min(w - x, Math.ceil(qr.bbox.width + 2 * pad));
    const hh = Math.min(h - y, Math.ceil(qr.bbox.height + 2 * pad));
    if (options.transparent) {
      ctx.clearRect(x, y, ww, hh);
    } else {
      ctx.fillStyle = options.fill ?? '#FFFFFF';
      ctx.fillRect(x, y, ww, hh);
    }
  }
  return out;
}

export interface VectorQRPlacement {
  grid: QRModuleGrid;
  /** Destination bbox in *source-image-pixel coords* (matches DetectedQR.bbox). */
  bbox: DetectedQR['bbox'];
  /** Rotation in radians (matches DetectedQR.rotation). */
  rotation: number;
}

/**
 * Build the vector-overlay plan for a set of detected QRs. Filters out
 * placements that the renderer will skip (severe rotation, encoding
 * failure, etc). Returned in the same order as the input. Caller is
 * responsible for converting the bbox from source-image pixels to PDF
 * points.
 */
export function planVectorQROverlays(
  qrCodes: DetectedQR[],
  errorCorrectionLevel: QRCodeErrorCorrectionLevel = 'H'
): VectorQRPlacement[] {
  const plans: VectorQRPlacement[] = [];
  for (const qr of qrCodes) {
    const aspect = qr.bbox.width / qr.bbox.height;
    if (aspect < 0.7 || aspect > 1.4) continue;
    const rotDeg = (qr.rotation * 180) / Math.PI;
    const normalisedRotDeg = ((rotDeg % 90) + 90) % 90;
    const offAxis = Math.min(normalisedRotDeg, 90 - normalisedRotDeg);
    if (offAxis > 8) continue;
    let grid: QRModuleGrid;
    try {
      grid = getQRModuleGrid(qr.payload, errorCorrectionLevel);
    } catch {
      continue;
    }
    plans.push({ grid, bbox: qr.bbox, rotation: qr.rotation });
  }
  return plans;
}

// ─── Source-aware appearance + logo detection ───────────────────────────
// Used by the PDF vector-overlay renderer to mimic the user's chosen
// module style (circle/square) and avoid overdrawing centred logos.

export type QRModuleShape = 'square' | 'circle';

export interface QRAppearance {
  /** Detected module shape — `square` (filled tiles) or `circle` (inscribed dots). */
  shape: QRModuleShape;
  /** Dominant dark-module colour (0-255 RGB). Black for most QRs. */
  dark: { r: number; g: number; b: number };
  /** Dominant light/background colour. White for most QRs. */
  light: { r: number; g: number; b: number };
  /**
   * Bounding box (in *source-image-pixel coords*, matching DetectedQR.bbox)
   * of a centred logo / overlay graphic, if one is detected. Null when no
   * logo region is found — we treat the whole QR as scannable modules.
   */
  logoBox: { x: number; y: number; width: number; height: number } | null;
}

/**
 * Reads the source image around a detected QR to figure out three things
 * the vector-overlay renderer needs to faithfully reproduce the design:
 *
 *  1. **Module shape.** Samples the finder-pattern centres (always-dark
 *     3×3 blocks at the QR corners) and measures dark-pixel coverage
 *     within each module bbox. Square modules cover ~95–100% of their
 *     bbox; inscribed circular dots cover ~78.5% (π/4).
 *  2. **Dark / light colour.** Same finder-pattern samples, averaged.
 *     Lets a red-on-cream styled QR re-render as red-on-cream rather than
 *     black-on-white.
 *  3. **Logo region.** Per-module classification of the source pixels:
 *     "matches expected bit" vs "anomalous" (colourful or wrong polarity).
 *     A contiguous anomalous cluster in the centre half of the QR is
 *     treated as a logo overlay. The renderer then *skips* drawing
 *     vectors over those modules so the user's logo art passes through
 *     intact.
 */
export function detectQRAppearance(
  source: HTMLImageElement | HTMLCanvasElement,
  bbox: { x: number; y: number; width: number; height: number },
  grid: QRModuleGrid,
): QRAppearance {
  const w = (source as HTMLImageElement).naturalWidth || source.width;
  const h = (source as HTMLImageElement).naturalHeight || source.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return { shape: 'square', dark: { r: 0, g: 0, b: 0 }, light: { r: 255, g: 255, b: 255 }, logoBox: null };
  }
  // White ground so transparent designs sample clean light pixels.
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);

  const moduleW = bbox.width / grid.size;
  const moduleH = bbox.height / grid.size;

  // ── 1. Module shape + dark colour from finder-pattern centres ────────
  // Each finder pattern is 7×7 modules; the inner 3×3 block is fully dark.
  // We sample the central module of each finder block (offset 3,3).
  const finderCentres = [
    { row: 3, col: 3 }, // top-left
    { row: 3, col: grid.size - 4 }, // top-right
    { row: grid.size - 4, col: 3 }, // bottom-left
  ];

  let totalCoverage = 0;
  let coverageSamples = 0;
  let darkR = 0, darkG = 0, darkB = 0, darkN = 0;
  let lightR = 0, lightG = 0, lightB = 0, lightN = 0;

  for (const fc of finderCentres) {
    const x0 = Math.max(0, Math.floor(bbox.x + fc.col * moduleW));
    const y0 = Math.max(0, Math.floor(bbox.y + fc.row * moduleH));
    const x1 = Math.min(w, Math.ceil(bbox.x + (fc.col + 1) * moduleW));
    const y1 = Math.min(h, Math.ceil(bbox.y + (fc.row + 1) * moduleH));
    if (x1 <= x0 || y1 <= y0) continue;
    const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let dark = 0;
    const total = (x1 - x0) * (y1 - y0);
    for (let i = 0; i < data.length; i += 4) {
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (luma < 128) {
        dark++;
        darkR += data[i]; darkG += data[i + 1]; darkB += data[i + 2]; darkN++;
      } else {
        lightR += data[i]; lightG += data[i + 1]; lightB += data[i + 2]; lightN++;
      }
    }
    totalCoverage += dark / total;
    coverageSamples++;
  }

  // Sample background pixels near the QR (just outside its bbox) for a
  // cleaner light-colour read — finder modules are mostly dark so the
  // light samples from there are biased by the dot edges.
  const bgPad = Math.max(2, Math.round(moduleW));
  const bgX0 = Math.max(0, Math.floor(bbox.x + bbox.width + bgPad));
  const bgY0 = Math.max(0, Math.floor(bbox.y));
  const bgW = Math.min(w - bgX0, Math.max(4, Math.round(moduleW * 2)));
  const bgH = Math.min(h - bgY0, Math.max(4, Math.round(bbox.height)));
  if (bgW > 0 && bgH > 0) {
    const data = ctx.getImageData(bgX0, bgY0, bgW, bgH).data;
    for (let i = 0; i < data.length; i += 4) {
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (luma >= 128) {
        lightR += data[i]; lightG += data[i + 1]; lightB += data[i + 2]; lightN++;
      }
    }
  }

  const shape: QRModuleShape =
    coverageSamples === 0 ? 'square' : (totalCoverage / coverageSamples) > 0.88 ? 'square' : 'circle';
  const dark = darkN > 0
    ? { r: Math.round(darkR / darkN), g: Math.round(darkG / darkN), b: Math.round(darkB / darkN) }
    : { r: 0, g: 0, b: 0 };
  const light = lightN > 0
    ? { r: Math.round(lightR / lightN), g: Math.round(lightG / lightN), b: Math.round(lightB / lightN) }
    : { r: 255, g: 255, b: 255 };

  // ── 2. Logo region detection (PIXEL-LEVEL, grid-independent) ─────────
  // Critical: this MUST NOT depend on `grid.modules` agreeing with the
  // source pixels. Reason: our re-encoded grid uses EC level 'H', but the
  // source QR may have been encoded at L/M/Q — that gives a different
  // version (different module count), so my grid's module positions
  // wouldn't line up with the source's at all. A grid-comparison check
  // would then flag ~every module as "wrong polarity" and the logo bbox
  // would balloon to cover the entire QR.
  //
  // We classify a sampled pixel as "logo-like" if it's either:
  //   1. Chromatic (saturation > 25) — clearly a colour, not pure B/W.
  //      Catches logos with any hint of colour.
  //   2. Mid-luma in a low-sat range (50 < luma < 200, sat < 25) —
  //      a pure-grey pixel. Real QR modules are pure black (luma~0) or
  //      pure white (luma~255); a grey pixel is either antialiasing at
  //      the logo edge or part of a greyscale logo (icons, monograms).
  //      WITHOUT this we'd miss greyscale logos and the carve-out would
  //      stop short of the logo's edges.
  // Both checks are grid-independent and work for any QR encoder.
  const cxQR = bbox.x + bbox.width / 2;
  const cyQR = bbox.y + bbox.height / 2;
  const halfSampleW = bbox.width * 0.40; // central 80% on X — catch large logos
  const halfSampleH = bbox.height * 0.40; // central 80% on Y
  const sampleX0 = Math.max(0, Math.floor(cxQR - halfSampleW));
  const sampleY0 = Math.max(0, Math.floor(cyQR - halfSampleH));
  const sampleX1 = Math.min(w, Math.ceil(cxQR + halfSampleW));
  const sampleY1 = Math.min(h, Math.ceil(cyQR + halfSampleH));

  let logoBox: QRAppearance['logoBox'] = null;
  let coloredCount = 0;
  let greyCount = 0;
  let totalSampled = 0;

  if (sampleX1 > sampleX0 && sampleY1 > sampleY0) {
    const data = ctx.getImageData(sampleX0, sampleY0, sampleX1 - sampleX0, sampleY1 - sampleY0).data;
    const sampleW = sampleX1 - sampleX0;
    const sampleH = sampleY1 - sampleY0;

    // Step in ~half-module increments so we get a few samples per
    // module — enough to catch small logos without running the full
    // pixel-grid (which would be slow for high-DPI sources).
    const step = Math.max(1, Math.floor(Math.min(moduleW, moduleH) * 0.5));

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let y = 0; y < sampleH; y += step) {
      for (let x = 0; x < sampleW; x += step) {
        const i = (y * sampleW + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        totalSampled++;

        const isChromatic = sat > 25;
        const isGrey = !isChromatic && luma > 50 && luma < 200;

        if (isChromatic) coloredCount++;
        if (isGrey) greyCount++;

        if (isChromatic || isGrey) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    // Need a meaningful cluster (≥1.5% of sampled area) before believing
    // a logo is there. Threshold tuned to catch small logos (e.g., a
    // 25-px IG icon in a 200-px QR is ~1.5% of the central sample area)
    // while filtering out isolated chromatic-aberration / JPEG noise.
    const flaggedTotal = coloredCount + greyCount;
    const minFlagged = Math.max(6, Math.floor(totalSampled * 0.015));
    if (flaggedTotal >= minFlagged && maxX >= minX) {
      // Convert sample-local coords back to source-image coords. Pad
      // by ~1 module on each side — generous enough that no logo edge
      // gets clipped, tight enough that we don't preserve old-QR pixels
      // beyond the logo bounds.
      const padX = moduleW * 1.0;
      const padY = moduleH * 1.0;
      const logoX = sampleX0 + minX - padX;
      const logoY = sampleY0 + minY - padY;
      const logoW = (maxX - minX + step) + 2 * padX;
      const logoH = (maxY - minY + step) + 2 * padY;

      // Defensive cap: logos up to 68% of the QR's dimension are accepted.
      // Standard guidance is ≤30% of QR area (≈54% of dimension) at H EC
      // level, but real phones are forgiving well beyond that — if the user's
      // phone can scan it, we should preserve the logo rather than wipe it.
      // Anything larger than 68% of a side is almost certainly a detector
      // false-positive (the whole central zone flagged), not a real logo.
      const maxLogoW = bbox.width * 0.68;
      const maxLogoH = bbox.height * 0.68;
      if (logoW <= maxLogoW && logoH <= maxLogoH) {
        logoBox = { x: logoX, y: logoY, width: logoW, height: logoH };
      } else {
        // eslint-disable-next-line no-console
        console.log(
          `[QR] Logo bbox rejected (too large): ${logoW.toFixed(1)}×${logoH.toFixed(1)}px ` +
          `vs cap ${maxLogoW.toFixed(1)}×${maxLogoH.toFixed(1)}px`
        );
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[QR] Appearance: shape=${shape}, ` +
    `chromaPx=${coloredCount}, greyPx=${greyCount}, total=${totalSampled}, ` +
    `logoBox=${logoBox ? `${Math.round(logoBox.width)}×${Math.round(logoBox.height)}px` : 'none'}`
  );

  return { shape, dark, light, logoBox };
}

// ─── Vector QR overlay onto an HTMLCanvas 2D context ─────────────────────
// Canvas-side mirror of `drawVectorQRsOnPage` (in `contour-outline.ts`).
// Used by the live preview so what the user sees on screen matches what
// gets baked into the exported PDF — same module shape, same dark/light
// colours, same logo cut-out region — instead of the raw (potentially
// blurry) source raster.
//
// Coordinate model:
//   - `imageRect` is in canvas pixel coords (top-left origin, Y-down).
//   - `srcImagePixelWidth/Height` are the source-image dimensions whose
//     pixel coords the QR bboxes are in.
//   - HTML canvas Y axis points down — no flip needed.
export function drawVectorQRsOnCanvas2D(
  ctx: CanvasRenderingContext2D,
  qrCodes: DetectedQR[] | undefined,
  imageRect: { x: number; y: number; width: number; height: number },
  srcImagePixelWidth: number,
  srcImagePixelHeight: number,
  sourceImage: HTMLImageElement | HTMLCanvasElement | undefined,
  options: {
    errorCorrectionLevel?: QRCodeErrorCorrectionLevel;
    /**
     * Quiet-zone halo around the QR, expressed in module widths. Default 1.
     * Spec calls for 4; most modern scanners decode reliably at 1. Lower
     * values reduce visible white border around the rendered QR. Set to 0
     * to disable the halo entirely (the modules will sit flush against the
     * surrounding artwork — risky for scanability).
     */
    quietZoneModules?: number;
    /**
     * Lower bound on the halo expressed as a fraction of the QR bbox.
     * The actual halo is `max(quietZoneModules*moduleSize, quietZoneFraction*bbox)`.
     * Default 0.02 (2%). Was 0.08 (8%) before the visible-border fix.
     */
    quietZoneFraction?: number;
  } = {},
): { drawn: number; skipped: number } {
  if (!qrCodes || qrCodes.length === 0) return { drawn: 0, skipped: 0 };
  const plans = planVectorQROverlays(qrCodes, options.errorCorrectionLevel ?? 'H');
  if (plans.length === 0) return { drawn: 0, skipped: qrCodes.length };

  const sx = imageRect.width / srcImagePixelWidth;
  const sy = imageRect.height / srcImagePixelHeight;

  for (const plan of plans) {
    const { grid, bbox, rotation } = plan;
    const destX = imageRect.x + bbox.x * sx;
    const destY = imageRect.y + bbox.y * sy;
    const destW = bbox.width * sx;
    const destH = bbox.height * sy;

    const appearance: QRAppearance = sourceImage
      ? detectQRAppearance(sourceImage, bbox, grid)
      : { shape: 'square', dark: { r: 0, g: 0, b: 0 }, light: { r: 255, g: 255, b: 255 }, logoBox: null };

    // Force pure-black-on-white for the actual modules. Sampled colours
    // are kept around for diagnostics but using them risks low-contrast
    // output if the sampler was confused by the source background. Pure
    // black/white is what every QR scanner is calibrated for.
    const darkCss = '#000000';
    const lightCss = '#FFFFFF';

    const logoOnCanvas = appearance.logoBox ? {
      x: imageRect.x + appearance.logoBox.x * sx,
      y: imageRect.y + appearance.logoBox.y * sy,
      width: appearance.logoBox.width * sx,
      height: appearance.logoBox.height * sy,
    } : null;

    const moduleW = destW / grid.size;
    const moduleH = destH / grid.size;

    const moduleCentreInLogo = (pxLeft: number, pyTop: number, mW: number = moduleW, mH: number = moduleH): boolean => {
      if (!logoOnCanvas) return false;
      const cx = pxLeft + mW / 2;
      const cy = pyTop + mH / 2;
      return cx >= logoOnCanvas.x && cx <= logoOnCanvas.x + logoOnCanvas.width &&
             cy >= logoOnCanvas.y && cy <= logoOnCanvas.y + logoOnCanvas.height;
    };

    ctx.save();
    if (Math.abs(rotation) > 0.5 * Math.PI / 180) {
      const cx = destX + destW / 2;
      const cy = destY + destH / 2;
      ctx.translate(cx, cy);
      ctx.rotate(rotation);
      ctx.translate(-cx, -cy);
    }

    // ── Pre-wipe pass ─────────────────────────────────────────────────
    // Wipe the QR bbox + halo to white BEFORE drawing modules, but
    // CARVE OUT the centred-logo region so the user's source logo
    // passes through unchanged. Per user request: "we don't need to
    // vectorize the logo... we want to leave the logo they have in
    // the middle there".
    //
    // Halo size = max(quietZoneModules * moduleSize, quietZoneFraction * bbox).
    // Defaults are tighter than QR spec (4 modules) — most scanners decode
    // fine at 1 module of quiet zone, and a smaller halo keeps the QR from
    // bleeding visible white into the surrounding design.
    const quietZoneModules = options.quietZoneModules ?? 1;
    const quietZoneFraction = options.quietZoneFraction ?? 0.02;
    const haloPx = Math.max(
      quietZoneModules * Math.min(moduleW, moduleH),
      quietZoneFraction * Math.min(destW, destH),
    );
    const wipeX = destX - haloPx;
    const wipeY = destY - haloPx;
    const wipeW = destW + 2 * haloPx;
    const wipeH = destH + 2 * haloPx;
    ctx.fillStyle = lightCss;
    if (logoOnCanvas) {
      const lx = Math.max(wipeX, logoOnCanvas.x);
      const ly = Math.max(wipeY, logoOnCanvas.y);
      const lr = Math.min(wipeX + wipeW, logoOnCanvas.x + logoOnCanvas.width);
      const lb = Math.min(wipeY + wipeH, logoOnCanvas.y + logoOnCanvas.height);
      if (lr > lx && lb > ly) {
        // Top / bottom / left / right frames around the carved-out logo.
        if (ly > wipeY) ctx.fillRect(wipeX, wipeY, wipeW, ly - wipeY);
        if (lb < wipeY + wipeH) ctx.fillRect(wipeX, lb, wipeW, wipeY + wipeH - lb);
        if (lx > wipeX) ctx.fillRect(wipeX, ly, lx - wipeX, lb - ly);
        if (lr < wipeX + wipeW) ctx.fillRect(lr, ly, wipeX + wipeW - lr, lb - ly);
      } else {
        ctx.fillRect(wipeX, wipeY, wipeW, wipeH);
      }
    } else {
      ctx.fillRect(wipeX, wipeY, wipeW, wipeH);
    }

    // ── Module pass ───────────────────────────────────────────────────
    // Force SQUARE modules regardless of detected source style. Squares
    // give 100% module fill and best scanner contrast.
    //
    // Crispness: pre-compute integer-pixel module boundaries so adjacent
    // modules tile seamlessly with NO anti-aliasing on canvas. fillRect
    // at fractional coords applies sub-pixel AA which softens module
    // edges enough to reduce contrast for some scanners. Pre-snapping
    // each boundary to the nearest integer pixel and using
    // boundaries[i+1]-boundaries[i] as the width guarantees an integer
    // module size with zero gap and zero overlap between neighbours.
    const xBoundaries = new Int32Array(grid.size + 1);
    const yBoundaries = new Int32Array(grid.size + 1);
    for (let i = 0; i <= grid.size; i++) xBoundaries[i] = Math.round(destX + i * moduleW);
    for (let j = 0; j <= grid.size; j++) yBoundaries[j] = Math.round(destY + j * moduleH);

    // ── Horizontal run-merge ──────────────────────────────────────────
    // Instead of emitting one fill per dark module, walk each row and
    // merge consecutive dark modules into a single wider rectangle —
    // "thicker lines instead of multiple thin ones" (per user request).
    // Print benefits:
    //   - Fewer seams between adjacent dark modules → no ink-bleed gaps
    //   - Cut/print machines cope better with longer continuous shapes
    //   - PDF size drops a lot (one rect per run instead of one per module)
    // Scanner behaviour is unchanged: a 5-module-wide horizontal run of
    // dark modules looks the same to a QR decoder whether it was painted
    // as 5 squares or 1 rectangle — the underlying bit pattern is what
    // gets decoded, and the geometric coverage is identical.
    //
    // A logo-skip in the middle of a run breaks it into two runs, so the
    // logo carve-out still passes the source pixels through.
    ctx.fillStyle = darkCss;
    let drawnRuns = 0;
    let drawnModules = 0;
    let skippedDarkModules = 0;
    for (let j = 0; j < grid.size; j++) {
      const py = yBoundaries[j];
      const moduleHeight = yBoundaries[j + 1] - py;
      let runStart = -1;
      for (let i = 0; i < grid.size; i++) {
        const isDark = grid.modules[j * grid.size + i] === 1;
        let skipForLogo = false;
        if (isDark) {
          const px = xBoundaries[i];
          const moduleWidth = xBoundaries[i + 1] - px;
          if (moduleCentreInLogo(px, py, moduleWidth, moduleHeight)) {
            skipForLogo = true;
            skippedDarkModules++;
          }
        }
        if (isDark && !skipForLogo) {
          if (runStart === -1) runStart = i;
        } else if (runStart !== -1) {
          const xStart = xBoundaries[runStart];
          const xEnd = xBoundaries[i];
          ctx.fillRect(xStart, py, xEnd - xStart, moduleHeight);
          drawnRuns++;
          drawnModules += i - runStart;
          runStart = -1;
        }
      }
      if (runStart !== -1) {
        const xStart = xBoundaries[runStart];
        const xEnd = xBoundaries[grid.size];
        ctx.fillRect(xStart, py, xEnd - xStart, moduleHeight);
        drawnRuns++;
        drawnModules += grid.size - runStart;
      }
    }

    // Diagnostic: scanner-blocking warning if too many dark modules
    // were skipped. Even at H, the QR can only recover ~30% of modules;
    // skipping more than ~22% (leaving headroom for environmental
    // damage / partial occlusion) means the QR likely won't decode.
    const totalDark = drawnModules + skippedDarkModules;
    const skipFrac = totalDark > 0 ? skippedDarkModules / totalDark : 0;
    // eslint-disable-next-line no-console
    console.log(
      `[QR] Render (canvas): ${grid.size}×${grid.size} grid, ` +
      `drew ${drawnModules}/${totalDark} dark modules in ${drawnRuns} runs ` +
      `(${(drawnModules / Math.max(drawnRuns, 1)).toFixed(1)} modules/run avg, ` +
      `skipped ${skippedDarkModules} for logo, ${(skipFrac * 100).toFixed(1)}%)`
    );
    if (skipFrac > 0.22) {
      // eslint-disable-next-line no-console
      console.warn(
        `[QR] WARNING: Skipped ${(skipFrac * 100).toFixed(1)}% of dark modules ` +
        `for logo carve-out. Even at EC=H this QR may not scan reliably.`
      );
    }

    ctx.restore();
  }

  return { drawn: plans.length, skipped: qrCodes.length - plans.length };
}

// ─── Logo region vectorisation ───────────────────────────────────────────
// Generic image-tracing pipeline (same shape as Inkscape's "Trace Bitmap"
// or potrace, but inlined and tuned for the small centred logo region we
// punched out of the QR overlay). For arbitrary user-uploaded raster art,
// we:
//   1. Crop the bbox into a small sample canvas (max ~256 px) so the
//      tracer doesn't choke on huge source images.
//   2. Median-cut the sample to ~5 dominant colours.
//   3. For each colour, build a binary mask, do a 1-px erode+dilate to
//      remove jpeg/anti-alias speckle, find connected components, trace
//      each with Moore-neighbour boundary walking.
//   4. Douglas-Peucker simplify each polygon.
//   5. Project polygon coords back to source-image-pixel space.
//
// The result is a list of solid-colour polygon layers rendered back-to-
// front (lightest first) — what the user uploaded reproduced as crisp
// vectors, no logo-substitution or stylisation. Whatever they uploaded
// is what gets traced.

export interface VectorLogoLayer {
  /** Solid fill colour of this layer (sampled from the source crop). */
  color: { r: number; g: number; b: number };
  /** One or more closed-loop polygon outlines in source-image-pixel
   * coords. Multiple polygons per layer = disjoint same-colour regions. */
  polygons: Array<Array<{ x: number; y: number }>>;
}

export interface VectorLogoResult {
  /** Source-image-pixel coords of the logo region (matches the bbox the
   * QR overlay was given). */
  bbox: { x: number; y: number; width: number; height: number };
  /** Background colour wiped under the layers. We assume the renderer
   * has already painted this under the logo region (the QR pre-wipe
   * does so), so we don't re-emit a backdrop layer. */
  background: { r: number; g: number; b: number };
  /** Layers in render order (back→front: lighter / dominant → darker
   * accents on top). */
  layers: VectorLogoLayer[];
}

/**
 * Vectorise an arbitrary raster region into solid-colour polygon layers.
 * Returns null when the region is too small or the trace produced no
 * meaningful output (caller should fall back to the source raster).
 */
export function vectorizeLogoRegion(
  source: HTMLImageElement | HTMLCanvasElement,
  bbox: { x: number; y: number; width: number; height: number },
  background: { r: number; g: number; b: number },
  options: {
    maxColors?: number;
    sampleMaxSize?: number;
    simplifyToleranceFraction?: number;
    minComponentAreaPx?: number;
  } = {},
): VectorLogoResult | null {
  const maxColors = options.maxColors ?? 6;
  const sampleMaxSize = options.sampleMaxSize ?? 256;
  const simplifyTolFrac = options.simplifyToleranceFraction ?? 0.005;
  // Lowered from 8 → 3 so we don't drop thin strokes (e.g. the 1-2 px
  // outline of a small camera-icon style logo at sample resolution).
  const minAreaPx = options.minComponentAreaPx ?? 3;

  if (bbox.width < 8 || bbox.height < 8) return null;

  const srcW = (source as HTMLImageElement).naturalWidth || source.width;
  const srcH = (source as HTMLImageElement).naturalHeight || source.height;
  const cropX = Math.max(0, Math.floor(bbox.x));
  const cropY = Math.max(0, Math.floor(bbox.y));
  const cropW = Math.min(srcW - cropX, Math.ceil(bbox.width));
  const cropH = Math.min(srcH - cropY, Math.ceil(bbox.height));
  if (cropW <= 0 || cropH <= 0) return null;

  const downscale = Math.min(1, sampleMaxSize / Math.max(cropW, cropH));
  const sampleW = Math.max(8, Math.round(cropW * downscale));
  const sampleH = Math.max(8, Math.round(cropH * downscale));
  const canvas = document.createElement('canvas');
  canvas.width = sampleW;
  canvas.height = sampleH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Background ground so transparent or partially-transparent source
  // pixels sample cleanly against the QR's light colour.
  ctx.fillStyle = `rgb(${background.r},${background.g},${background.b})`;
  ctx.fillRect(0, 0, sampleW, sampleH);
  ctx.drawImage(source, cropX, cropY, cropW, cropH, 0, 0, sampleW, sampleH);

  const data = ctx.getImageData(0, 0, sampleW, sampleH).data;

  // ── 1. Median-cut quantisation to ≤ maxColors palette entries ──────
  const palette = medianCutPalette(data, sampleW, sampleH, maxColors);
  if (palette.length === 0) return null;

  // Map every pixel to nearest palette entry (squared RGB distance).
  const labels = new Uint8Array(sampleW * sampleH);
  for (let p = 0; p < sampleW * sampleH; p++) {
    const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
    let best = 0, bestDist = Infinity;
    for (let k = 0; k < palette.length; k++) {
      const c = palette[k];
      const dr = r - c.r, dg = g - c.g, db = b - c.b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDist) { bestDist = d; best = k; }
    }
    labels[p] = best;
  }

  // ── 2. Per-colour layer extraction ─────────────────────────────────
  const layers: VectorLogoLayer[] = [];
  const bgDistRGB = (c: { r: number; g: number; b: number }) => {
    const dr = c.r - background.r, dg = c.g - background.g, db = c.b - background.b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };

  const scaleBackX = cropW / sampleW;
  const scaleBackY = cropH / sampleH;
  const tolerance = Math.max(0.5, Math.min(sampleW, sampleH) * simplifyTolFrac);

  // Diagnostics for debugging logo vectorisation failures.
  let skippedAsBg = 0;
  let droppedSmall = 0;

  for (let k = 0; k < palette.length; k++) {
    const colour = palette[k];
    // Skip layers very close to the wipe colour (would be invisible
    // anyway). Threshold loosened from 18 → 10 so a slightly-off-white
    // logo background still gets emitted as a layer.
    if (bgDistRGB(colour) < 10) { skippedAsBg++; continue; }

    const mask = new Uint8Array(sampleW * sampleH);
    for (let p = 0; p < sampleW * sampleH; p++) {
      if (labels[p] === k) mask[p] = 1;
    }

    // NOTE: previously we ran morphErode + morphDilate ("morph open")
    // here to clean up speckle, but for thin-stroke logos (e.g. a small
    // camera-icon outline at 1-2 px stroke width in sample space), the
    // erode pass deletes the stroke entirely and dilate can't recover
    // it from nothing. The result was an empty cutout in the QR centre.
    // We trust the median-cut quantisation + minComponentAreaPx filter
    // to handle noise instead.

    const polygons: Array<Array<{ x: number; y: number }>> = [];
    const visited = new Uint8Array(sampleW * sampleH);
    for (let y = 0; y < sampleH; y++) {
      for (let x = 0; x < sampleW; x++) {
        const idx = y * sampleW + x;
        if (mask[idx] === 0 || visited[idx]) continue;

        // BFS to mark this connected component visited and locate its
        // topmost-leftmost pixel for the boundary trace start.
        let count = 0;
        let startX = x, startY = y;
        const queue: number[] = [idx];
        visited[idx] = 1;
        while (queue.length) {
          const cur = queue.pop()!;
          count++;
          const cy = (cur / sampleW) | 0;
          const cx = cur - cy * sampleW;
          if (cy < startY || (cy === startY && cx < startX)) {
            startX = cx; startY = cy;
          }
          if (cx > 0 && mask[cur - 1] && !visited[cur - 1]) { visited[cur - 1] = 1; queue.push(cur - 1); }
          if (cx < sampleW - 1 && mask[cur + 1] && !visited[cur + 1]) { visited[cur + 1] = 1; queue.push(cur + 1); }
          if (cy > 0 && mask[cur - sampleW] && !visited[cur - sampleW]) { visited[cur - sampleW] = 1; queue.push(cur - sampleW); }
          if (cy < sampleH - 1 && mask[cur + sampleW] && !visited[cur + sampleW]) { visited[cur + sampleW] = 1; queue.push(cur + sampleW); }
        }
        if (count < minAreaPx) { droppedSmall++; continue; }

        const trace = mooreNeighborBoundary(mask, sampleW, sampleH, startX, startY);
        if (trace.length < 3) continue;
        const simplified = douglasPeuckerLite(trace, tolerance);
        if (simplified.length < 3) continue;

        // Project polygon coords from sample space → source-pixel coords.
        const projected = simplified.map(p => ({
          x: cropX + (p.x + 0.5) * scaleBackX,
          y: cropY + (p.y + 0.5) * scaleBackY,
        }));
        polygons.push(projected);
      }
    }

    if (polygons.length > 0) {
      layers.push({ color: colour, polygons });
    }
  }

  // Diagnostic — fires once per (source, bbox) thanks to the memo cache.
  // Helps debug "empty hole in the middle of QR" cases where the vectoriser
  // returns null/empty: tells us whether it was bg-skip, small-component
  // filtering, or no detectable colour clusters at all.
  const totalPolys = layers.reduce((n, l) => n + l.polygons.length, 0);
  console.log(
    `[vectorizeLogoRegion] sample=${sampleW}x${sampleH} ` +
    `palette=${palette.length} (skipped-as-bg=${skippedAsBg}) ` +
    `layers=${layers.length} polygons=${totalPolys} ` +
    `dropped-small=${droppedSmall}`
  );

  if (layers.length === 0) return null;

  // Render order: lightest → darkest. Keeps darker accents (typically
  // the foreground glyph or icon) on top of larger lighter regions.
  layers.sort((a, b) => luma(b.color) - luma(a.color));

  return { bbox, background, layers };
}

function luma(c: { r: number; g: number; b: number }): number {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

// ── Median-cut colour quantisation ─────────────────────────────────────
function medianCutPalette(
  data: Uint8ClampedArray, w: number, h: number, k: number,
): Array<{ r: number; g: number; b: number }> {
  const buckets: Array<Array<[number, number, number]>> = [[]];
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] < 128) continue;
    buckets[0].push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
  }
  if (buckets[0].length === 0) return [];

  while (buckets.length < k) {
    let largest = 0;
    for (let i = 1; i < buckets.length; i++) {
      if (buckets[i].length > buckets[largest].length) largest = i;
    }
    const bucket = buckets[largest];
    if (bucket.length < 2) break;

    let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
    for (const [r, g, b] of bucket) {
      if (r < minR) minR = r; if (r > maxR) maxR = r;
      if (g < minG) minG = g; if (g > maxG) maxG = g;
      if (b < minB) minB = b; if (b > maxB) maxB = b;
    }
    const rangeR = maxR - minR, rangeG = maxG - minG, rangeB = maxB - minB;
    let dim: 0 | 1 | 2 = 0;
    if (rangeG >= rangeR && rangeG >= rangeB) dim = 1;
    else if (rangeB >= rangeR) dim = 2;

    bucket.sort((a, b) => a[dim] - b[dim]);
    const mid = bucket.length >> 1;
    const left = bucket.slice(0, mid);
    const right = bucket.slice(mid);
    if (left.length === 0 || right.length === 0) break;
    buckets[largest] = left;
    buckets.push(right);
  }

  return buckets.filter(b => b.length > 0).map(b => {
    let r = 0, g = 0, bb = 0;
    for (const [pr, pg, pb] of b) { r += pr; g += pg; bb += pb; }
    return {
      r: Math.round(r / b.length),
      g: Math.round(g / b.length),
      b: Math.round(bb / b.length),
    };
  });
}

// ── Tiny morphological ops ─────────────────────────────────────────────
function morphErode(mask: Uint8Array, w: number, h: number): void {
  const orig = new Uint8Array(mask);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (orig[i] === 0) continue;
      const t = y > 0 ? orig[i - w] : 0;
      const b = y < h - 1 ? orig[i + w] : 0;
      const l = x > 0 ? orig[i - 1] : 0;
      const r = x < w - 1 ? orig[i + 1] : 0;
      mask[i] = (t & b & l & r) ? 1 : 0;
    }
  }
}

function morphDilate(mask: Uint8Array, w: number, h: number): void {
  const orig = new Uint8Array(mask);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (orig[i] === 1) continue;
      const t = y > 0 ? orig[i - w] : 0;
      const b = y < h - 1 ? orig[i + w] : 0;
      const l = x > 0 ? orig[i - 1] : 0;
      const r = x < w - 1 ? orig[i + 1] : 0;
      if (t | b | l | r) mask[i] = 1;
    }
  }
}

// ── Moore-neighbour boundary trace ─────────────────────────────────────
// Standard textbook implementation. Walks clockwise around a connected
// component starting from a known boundary pixel (the topmost-leftmost
// foreground pixel — guaranteed to be on the boundary since nothing
// foreground is above-left of it).
function mooreNeighborBoundary(
  mask: Uint8Array, w: number, h: number, sx: number, sy: number,
): Array<{ x: number; y: number }> {
  const dirs: Array<[number, number]> = [
    [1, 0], [1, 1], [0, 1], [-1, 1],
    [-1, 0], [-1, -1], [0, -1], [1, -1],
  ];
  const result: Array<{ x: number; y: number }> = [{ x: sx, y: sy }];
  let cx = sx, cy = sy;
  // Simulate having entered the start pixel from the west.
  let prevDir = 4;
  const maxIter = w * h * 4;

  for (let iter = 0; iter < maxIter; iter++) {
    let found = false;
    const searchStart = (prevDir + 6) % 8;
    for (let i = 0; i < 8; i++) {
      const d = (searchStart + i) % 8;
      const nx = cx + dirs[d][0];
      const ny = cy + dirs[d][1];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      if (mask[ny * w + nx] !== 1) continue;
      if (nx === sx && ny === sy && result.length > 1) {
        return result;
      }
      result.push({ x: nx, y: ny });
      prevDir = (d + 4) % 8;
      cx = nx; cy = ny;
      found = true;
      break;
    }
    if (!found) break;
  }
  return result;
}

// ── Douglas-Peucker (iterative, no recursion to avoid stack overflow on
// long boundaries from large logos) ───────────────────────────────────
function douglasPeuckerLite(
  points: Array<{ x: number; y: number }>, eps: number,
): Array<{ x: number; y: number }> {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    const a = points[lo], b = points[hi];
    let maxDist = 0, maxIdx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDist(points[i], a, b);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > eps && maxIdx > 0) {
      keep[maxIdx] = 1;
      stack.push([lo, maxIdx]);
      stack.push([maxIdx, hi]);
    }
  }
  const result: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) result.push(points[i]);
  return result;
}

function perpDist(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.y - a.y) * dx - (p.x - a.x) * dy) / len;
}

// ── Memo cache so vectorisation runs once per (source, bbox), not per
// frame. Renderers may be invoked many times per second during preview
// re-paints. Keyed by source object via WeakMap so cache evicts when
// the user uploads a new image. ────────────────────────────────────────
const vectorLogoMemoCache = new WeakMap<
  HTMLImageElement | HTMLCanvasElement,
  Map<string, VectorLogoResult | null>
>();

export function vectorizeLogoRegionCached(
  source: HTMLImageElement | HTMLCanvasElement,
  bbox: { x: number; y: number; width: number; height: number },
  background: { r: number; g: number; b: number },
): VectorLogoResult | null {
  let map = vectorLogoMemoCache.get(source);
  if (!map) { map = new Map(); vectorLogoMemoCache.set(source, map); }
  const key = `${Math.round(bbox.x)}_${Math.round(bbox.y)}_${Math.round(bbox.width)}_${Math.round(bbox.height)}_${background.r}_${background.g}_${background.b}`;
  if (map.has(key)) return map.get(key) ?? null;
  const result = vectorizeLogoRegion(source, bbox, background);
  map.set(key, result);
  return result;
}

// ── Canvas-side renderer for a vectorised logo ─────────────────────────
export function drawVectorLogoOnCanvas2D(
  ctx: CanvasRenderingContext2D,
  result: VectorLogoResult,
  imageRect: { x: number; y: number; width: number; height: number },
  srcImagePixelWidth: number,
  srcImagePixelHeight: number,
): void {
  const sx = imageRect.width / srcImagePixelWidth;
  const sy = imageRect.height / srcImagePixelHeight;

  for (const layer of result.layers) {
    ctx.fillStyle = `rgb(${layer.color.r}, ${layer.color.g}, ${layer.color.b})`;
    ctx.beginPath();
    for (const polygon of layer.polygons) {
      if (polygon.length < 3) continue;
      const p0 = polygon[0];
      ctx.moveTo(imageRect.x + p0.x * sx, imageRect.y + p0.y * sy);
      for (let i = 1; i < polygon.length; i++) {
        const p = polygon[i];
        ctx.lineTo(imageRect.x + p.x * sx, imageRect.y + p.y * sy);
      }
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }
}
