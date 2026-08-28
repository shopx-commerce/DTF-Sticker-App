// Print sources for vector uploads — re-rasterises the retained PDF/SVG at export/placement size instead of reusing the screen-clamped import preview.

import { fitWithinMegapixels, vectorExportMaxEdge, SVG_EXPORT_RASTER_TIMEOUT_MS } from './vector-raster-limits';
import { SvgRasterTimeoutError } from './svg-raster';
import { cropPngBlobToInkBox } from './vector-trim';
import type { ImageInfo } from './types';

export { vectorExportMaxEdge };

// Memory backstop for long, thin artwork that an edge cap alone would miss.
const VECTOR_EXPORT_MAX_MEGAPIXELS = 80;

// True when this upload kept geometry we can re-rasterise at any size.
export function hasVectorPrintSource(info: ImageInfo): boolean {
  if (info.svgSource) return true;
  // A detached buffer reports zero length; treat it as absent rather than handing pdf.js something it'll reject mid-export.
  return !!info.originalPdfData && info.originalPdfData.byteLength > 0;
}

async function rasteriseAtSize(
  info: ImageInfo,
  targetW: number,
  targetH: number
): Promise<Blob | null> {
  const maxEdge = vectorExportMaxEdge();
  // The source renders whole pages, so a trimmed import needs the page rendered proportionally larger for its artwork to land at the target size.
  const box = info.vectorInkBox;
  const pageW = box ? targetW / box.w : targetW;
  const pageH = box ? targetH / box.h : targetH;
  const scale = Math.min(
    1,
    maxEdge / Math.max(pageW, pageH, 1),
    fitWithinMegapixels(pageW, pageH, VECTOR_EXPORT_MAX_MEGAPIXELS)
  );
  const w = Math.max(1, Math.round(pageW * scale));
  const h = Math.max(1, Math.round(pageH * scale));

  // Loaded here, not at module scope — the parsers behind them are DOMPurify and the whole pdf.js engine, only a design that's actually vector should pay for them.
  let page: Blob | null = null;
  if (info.svgSource) {
    const { rasteriseSvgToPngBlob } = await import('./svg-parser');
    page = await rasteriseSvgToPngBlob(info.svgSource, w, h, {
      timeoutMs: SVG_EXPORT_RASTER_TIMEOUT_MS
    });
  } else if (info.originalPdfData && info.originalPdfData.byteLength > 0) {
    const { rasterisePdfPageToPngBlob } = await import('./pdf-parser');
    page = await rasterisePdfPageToPngBlob(info.originalPdfData, w, h, maxEdge);
  }
  if (!page || !box) return page;

  // A failed crop would print the whole page in the artwork's box — fall back to the import preview instead.
  return await cropPngBlobToInkBox(page, box);
}

// One design whose print-resolution re-render failed, so it prints from the preview.
export interface VectorPrintSourceShortfall {
  timedOut: boolean;
  targetW: number;
  targetH: number;
  fallbackW: number;
  fallbackH: number;
  // True when the fallback can't cover the target — a failed re-render alone isn't automatically a quality loss.
  material: boolean;
  reason: string;
}

// Shortfalls worth telling the customer about — see `material`.
export function materialShortfalls(resolver: VectorPrintSourceResolver): VectorPrintSourceShortfall[] {
  return resolver.shortfalls().filter((s) => s.material);
}

export interface VectorPrintSourceResolver {
  // Placement-size raster for a vector design, or undefined when not vector-backed or rasterising failed — caller falls back to the retained preview.
  resolve(info: ImageInfo, targetW: number, targetH: number): Promise<Blob | undefined>;
  shortfalls(): VectorPrintSourceShortfall[];
}

// Per-export resolver with caching, keyed by source identity + target size — two copies at different scales need different rasters, twenty at the same scale rasterise once.
export function createVectorPrintSourceResolver(): VectorPrintSourceResolver {
  const bySource = new WeakMap<ImageInfo, Map<string, Promise<Blob | null>>>();
  const shortfalls: VectorPrintSourceShortfall[] = [];

  return {
    async resolve(info, targetW, targetH) {
      if (!hasVectorPrintSource(info)) return undefined;
      let bySize = bySource.get(info);
      if (!bySize) {
        bySize = new Map();
        bySource.set(info, bySize);
      }
      const key = `${targetW}x${targetH}`;
      let pending = bySize.get(key);
      if (!pending) {
        pending = rasteriseAtSize(info, targetW, targetH).catch((err) => {
          // A failed re-render must not fail the whole export — fall back to the preview, recorded here rather than shipping a quietly softer sheet.
          const timedOut = err instanceof SvgRasterTimeoutError;
          const fallbackW = info.originalWidth || 0;
          const fallbackH = info.originalHeight || 0;
          shortfalls.push({
            timedOut,
            targetW,
            targetH,
            fallbackW,
            fallbackH,
            material: fallbackW < targetW || fallbackH < targetH,
            reason: err instanceof Error ? err.message : String(err)
          });
          console.error(
            `[vector-print-source] re-rasterise failed at ${targetW}x${targetH}; printing from the import preview instead:`,
            err instanceof Error ? err.message : err
          );
          return null;
        });
        bySize.set(key, pending);
      }
      return (await pending) ?? undefined;
    },
    shortfalls() {
      return shortfalls.slice();
    }
  };
}
