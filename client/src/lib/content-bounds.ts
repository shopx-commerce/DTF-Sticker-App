// Measures the artwork's box inside a raster by walking it in fixed-size tiles — peak memory is one tile regardless of upload size, and the result is pixel-exact, not a downsample estimate.

export interface ContentBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Anything we can measure: a decoded upload, or a rasterised vector page.
export type MeasurableSource = HTMLImageElement | HTMLCanvasElement;

// Alpha above this counts as artwork.
export const INK_ALPHA_THRESHOLD = 10;

// Longest edge of a single scan tile — peak cost per tile is fixed at TILE_EDGE² x 4 bytes.
const TILE_EDGE = 2048;

// Below this the frame is already tight; not worth a repaint over antialiasing hairlines.
const MIN_TRIM_FRACTION = 0.005;

// Default floor: a box smaller than this fraction of the frame is treated as noise, not the design. Vector imports pass 0 instead.
const MIN_CONTENT_FRACTION = 0.05;

interface TileBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Ink bounds within one tile's pixels, or null if empty — each row probes inward from both ends and stops at the first ink pixel.
function scanTileBounds(data: Uint8ClampedArray, w: number, h: number): TileBounds | null {
  let minX = w;
  let minY = -1;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < h; y++) {
    const rowStart = y * w * 4 + 3;

    let rowMinX = -1;
    for (let x = 0, p = rowStart; x < w; x++, p += 4) {
      if (data[p] > INK_ALPHA_THRESHOLD) {
        rowMinX = x;
        break;
      }
    }
    if (rowMinX < 0) continue;

    let rowMaxX = rowMinX;
    for (let x = w - 1, p = rowStart + (w - 1) * 4; x > rowMinX; x--, p -= 4) {
      if (data[p] > INK_ALPHA_THRESHOLD) {
        rowMaxX = x;
        break;
      }
    }

    if (minY < 0) minY = y;
    maxY = y;
    if (rowMinX < minX) minX = rowMinX;
    if (rowMaxX > maxX) maxX = rowMaxX;
  }

  if (maxY < 0) return null;
  return { minX, minY, maxX, maxY };
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function sourceSize(image: MeasurableSource): { width: number; height: number } {
  return {
    width: ("naturalWidth" in image ? image.naturalWidth : 0) || image.width,
    height: ("naturalHeight" in image ? image.naturalHeight : 0) || image.height,
  };
}

// The artwork's box in source pixels, or null when there's nothing worth trimming. Yields between tiles so a multi-tile scan doesn't freeze the editor.
export async function measureContentBox(
  image: MeasurableSource,
  opts?: { minContentFraction?: number },
): Promise<ContentBox | null> {
  const minContentFraction = opts?.minContentFraction ?? MIN_CONTENT_FRACTION;
  const { width: srcW, height: srcH } = sourceSize(image);
  if (!(srcW > 0) || !(srcH > 0)) return null;

  const tileW = Math.min(TILE_EDGE, srcW);
  const tileH = Math.min(TILE_EDGE, srcH);
  // A single-tile upload is over in milliseconds — yielding there would cost more than the scan.
  const multiTile = Math.ceil(srcW / tileW) * Math.ceil(srcH / tileH) > 1;

  const canvas = document.createElement("canvas");
  canvas.width = tileW;
  canvas.height = tileH;
  // willReadFrequently keeps the canvas CPU-backed — otherwise Chrome's getImageData blocks on a GPU flush.
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  let minX = srcW;
  let minY = srcH;
  let maxX = -1;
  let maxY = -1;

  try {
    for (let ty = 0; ty < srcH; ty += tileH) {
      const th = Math.min(tileH, srcH - ty);
      for (let tx = 0; tx < srcW; tx += tileW) {
        const tw = Math.min(tileW, srcW - tx);

        // A tile wholly inside the box we already have can't widen it — skip the readback once an inked tile has set the box.
        const alreadyCovered =
          maxX >= 0 && tx >= minX && ty >= minY && tx + tw - 1 <= maxX && ty + th - 1 <= maxY;
        if (alreadyCovered) continue;

        ctx.clearRect(0, 0, tw, th);
        ctx.drawImage(image, tx, ty, tw, th, 0, 0, tw, th);
        const { data } = ctx.getImageData(0, 0, tw, th);

        const b = scanTileBounds(data, tw, th);
        if (b) {
          if (tx + b.minX < minX) minX = tx + b.minX;
          if (ty + b.minY < minY) minY = ty + b.minY;
          if (tx + b.maxX > maxX) maxX = tx + b.maxX;
          if (ty + b.maxY > maxY) maxY = ty + b.maxY;
        }

        if (multiTile) await yieldToBrowser();
      }
    }
  } catch (err) {
    console.warn("[content-bounds] measurement failed; keeping the full frame", err);
    return null;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }

  // Nothing but transparency: no artwork to centre on, so leave the frame alone.
  if (maxX < 0) return null;

  const box: ContentBox = {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };

  if (box.width < srcW * minContentFraction || box.height < srcH * minContentFraction) {
    return null;
  }
  if (
    box.width >= srcW * (1 - MIN_TRIM_FRACTION) &&
    box.height >= srcH * (1 - MIN_TRIM_FRACTION)
  ) {
    return null;
  }
  return box;
}
