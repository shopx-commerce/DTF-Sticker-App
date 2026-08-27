// Trims vector imports (PDF/SVG) down to their artwork — a US-Letter PDF holding a 2" logo otherwise imports as an 8.5x11" design of mostly nothing. Recorded as a page fraction, not pixels, so it stays resolution-independent through export's re-rasterise.

import { measureContentBox, sourceSize, type MeasurableSource } from './content-bounds';

// The artwork's box as a fraction of the full page, so it can be reapplied to a render of any size.
export interface VectorInkBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Finds the artwork's box within a rasterised page, or null when there's nothing worth trimming. Minimum-content floor is waived (0, not the raster default) since a small logo alone on a Letter page is exactly what this is for.
export async function measureVectorInkBox(
  image: MeasurableSource,
): Promise<VectorInkBox | null> {
  const { width: w, height: h } = sourceSize(image);
  if (!(w > 0) || !(h > 0)) return null;

  const box = await measureContentBox(image, { minContentFraction: 0 });
  if (!box) return null;

  return {
    x: box.x / w,
    y: box.y / h,
    w: box.width / w,
    h: box.height / h,
  };
}

// Converts a fractional box to whole pixels within a render of w x h. Edges round independently, not offset-floor-then-size-round, so a fraction like 300/1100 doesn't shift the crop a pixel off.
export function inkBoxToPixels(
  box: VectorInkBox,
  w: number,
  h: number,
): { x: number; y: number; width: number; height: number } {
  const x0 = Math.max(0, Math.min(w - 1, Math.round(box.x * w)));
  const y0 = Math.max(0, Math.min(h - 1, Math.round(box.y * h)));
  const x1 = Math.max(x0 + 1, Math.min(w, Math.round((box.x + box.w) * w)));
  const y1 = Math.max(y0 + 1, Math.min(h, Math.round((box.y + box.h) * h)));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('crop load failed')); };
    img.src = url;
  });
}

// Cuts `box` out of a decoded page, as a PNG plus a loaded image for preview.
export async function cropRasterToInkBox(
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  box: VectorInkBox,
): Promise<{ image: HTMLImageElement; blob: Blob; widthPx: number; heightPx: number } | null> {
  const rect = inkBoxToPixels(box, sourceW, sourceH);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = rect.width;
    canvas.height = rect.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    const blob = await canvasToPngBlob(canvas);
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) return null;
    const image = await loadImage(blob);
    return { image, blob, widthPx: rect.width, heightPx: rect.height };
  } catch {
    return null;
  }
}

// Cuts `box` out of an already-encoded page render. Used by the export path.
export async function cropPngBlobToInkBox(
  blob: Blob,
  box: VectorInkBox,
): Promise<Blob | null> {
  try {
    const img = await loadImage(blob);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const cropped = await cropRasterToInkBox(img, w, h, box);
    return cropped?.blob ?? null;
  } catch {
    return null;
  }
}

export interface TrimmedVectorImport {
  image: HTMLImageElement;
  pngBlob: Blob;
  widthPx: number;
  heightPx: number;
  widthInches: number;
  heightInches: number;
  inkBox: VectorInkBox;
}

// Trims a parsed vector page to its artwork, or null if already tight / the crop failed (caller imports unchanged). Physical size shrinks with the pixels, so DPI is unaffected.
export async function trimVectorImport(input: {
  image: HTMLImageElement;
  widthInches: number;
  heightInches: number;
}): Promise<TrimmedVectorImport | null> {
  const box = await measureVectorInkBox(input.image);
  if (!box) return null;

  const sourceW = input.image.naturalWidth || input.image.width;
  const sourceH = input.image.naturalHeight || input.image.height;
  const cropped = await cropRasterToInkBox(input.image, sourceW, sourceH, box);
  if (!cropped) return null;

  return {
    image: cropped.image,
    pngBlob: cropped.blob,
    widthPx: cropped.widthPx,
    heightPx: cropped.heightPx,
    widthInches: input.widthInches * box.w,
    heightInches: input.heightInches * box.h,
    inkBox: box,
  };
}
