// Platform limits for rasterising vector artwork — a canvas past the platform ceiling doesn't fail loudly (iOS Safari silently no-ops drawImage), so vectorPrintDpi reports the DPI the export can genuinely deliver instead of always assuming 300.

export const VECTOR_TARGET_DPI = 300;

// iOS Safari's real-world safe ceiling; desktop allows far more but 8192 already covers a 27" design at 300 DPI.
const IOS_SAFE_CANVAS_DIM = 4096;
const DESKTOP_VECTOR_MAX_EDGE = 8192;

function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  if (/iPhone|iPad|iPod|Android|Mobile|Windows Phone/i.test(ua)) return true;
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

export function vectorExportMaxEdge(): number {
  return isMobileDevice() ? IOS_SAFE_CANVAS_DIM : DESKTOP_VECTOR_MAX_EDGE;
}

// The DPI a vector design will actually print at — 300, unless its longest edge at 300 DPI would exceed the platform's canvas ceiling.
export function vectorPrintDpi(widthInches: number, heightInches: number): number {
  const longestInches = Math.max(widthInches, heightInches);
  if (!(longestInches > 0)) return VECTOR_TARGET_DPI;
  const dpiAtCeiling = vectorExportMaxEdge() / longestInches;
  return Math.max(1, Math.round(Math.min(VECTOR_TARGET_DPI, dpiAtCeiling)));
}

// Wall-clock budgets for rasterising an SVG — import preview size, and the larger export re-render.
export const SVG_RASTER_TIMEOUT_MS = 20_000;
export const SVG_EXPORT_RASTER_TIMEOUT_MS = 45_000;

// Scale factor (<=1) that keeps w x h within maxMP megapixels (and maxEdge, if given) — catches long, thin artwork an edge cap alone would miss.
export function fitWithinMegapixels(w: number, h: number, maxMP: number, maxEdge?: number): number {
  const pixels = Math.max(1, w * h);
  const mpScale = Math.sqrt((maxMP * 1_000_000) / pixels);
  const edgeScale =
    maxEdge && maxEdge > 0 ? Math.min(maxEdge / Math.max(w, 1), maxEdge / Math.max(h, 1)) : 1;
  return Math.min(1, mpScale, edgeScale);
}
