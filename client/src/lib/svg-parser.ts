// Client-side SVG -> PNG rasteriser and upload-time entry point, sibling to pdf-parser.ts. Untrusted SVG is XML the browser will happily execute (script tags, event-handler attrs, foreignObject HTML), so it's sanitised with DOMPurify then rendered via <img>+canvas (which never runs scripts) rather than injected live; svg-expansion rejects reference-bomb files before any renderer sees them, and svg-raster runs the actual draw in a killable sandboxed frame. Font handling is out of scope: <img>-loaded SVG gets no network access, so externally-linked fonts fall back to the browser default and there's nothing client-side to fix.

import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify';
import { vectorPrintDpi, vectorExportMaxEdge } from './vector-raster-limits';
import { analyseRawSvgExpansion, analyseSvgExpansion } from './svg-expansion';
import { rasteriseSvgToPngBlobSafe, type RasteriseOptions } from './svg-raster';
import { SvgTooComplexError, isSVGFile } from './vector-file';

// Re-exported so callers that only hold this module keep one import — mirrors isPDFFile's role in pdf-parser.ts.
export { SvgTooComplexError, isSVGFile };

export interface ParsedSVGData {
  image: HTMLImageElement;
  pngBlob: Blob;
  // Sanitised SVG source, retained so the export path can re-rasterise at placement size.
  svgSource: string;
  widthPx: number;
  heightPx: number;
  widthInches: number;
  heightInches: number;
  // Print DPI — 300, like a raster upload, since export re-rasterises from svgSource at placement size. Only drops below 300 when the platform's canvas ceiling can't hold a 300 DPI render this large.
  dpi: number;
}

const TARGET_DPI = 300;

// Fallback intrinsic size for SVGs with neither width/height nor a usable viewBox — the SVG spec's own "300x150" default, in inches at 72 DPI.
const FALLBACK_WIDTH_IN = 300 / 72;
const FALLBACK_HEIGHT_IN = 150 / 72;

// <style> is allowed — Illustrator/Figma/Sketch/Inkscape routinely emit a <style> block that classes reference, and stripping it broke fills/strokes/text for real files. foreignObject/script/iframe/object/embed stay forbidden as the primary escape hatches for injecting HTML/JS. <use> is added back via ADD_TAGS since DOMPurify's SVG profile doesn't allow-list it, and dropping it blanks every <symbol>+<use> icon-set / gangsheet-repeat file to a near-empty raster with no error.
const DOMPURIFY_CONFIG: DOMPurifyConfig = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ['use'],
  FORBID_TAGS: ['foreignObject', 'script', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'xml:base'],
  KEEP_CONTENT: false,
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

// A same-document instance reference: # followed by an id, nothing that could be a path or a second document — anything else is a fetch of a document we don't control (SSRF-shaped, and silently draws nothing in the <img> sandbox we actually use).
const LOCAL_FRAGMENT_REF = /^#[^#/\\]+$/;

// <use> elements this pass stripped an unusable reference from. Reset per sanitiseSvg call — safe since DOMPurify.sanitize is synchronous.
let droppedRefsThisPass = 0;

// Confine every admitted <use> to a same-document fragment. Registered once at module scope (this is the only DOMPurify caller in the app) so it can't be lost by an early return; touches nothing but `use`. The reference is stripped rather than the element, leaving an inert <use> that draws nothing — the same outcome the renderer sandbox gives an external reference anyway.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  const el = node as Element;
  if ((el.nodeName || '').toLowerCase() !== 'use') return;
  const raw =
    el.getAttribute('href') ??
    el.getAttributeNS(XLINK_NS, 'href') ??
    el.getAttribute('xlink:href');
  if (raw !== null && LOCAL_FRAGMENT_REF.test(raw.trim())) return;
  el.removeAttribute('href');
  el.removeAttribute('xlink:href');
  el.removeAttributeNS(XLINK_NS, 'href');
  if (raw !== null) droppedRefsThisPass += 1;
});

interface SanitisedSvg {
  source: string;
  // <use> references neutralised because they pointed outside the document — that artwork is absent from the render whatever we do.
  droppedInstanceRefs: number;
  namespaceRestored: boolean;
}

// DOMPurify serialises through the HTML serialiser and does not invent an xmlns the input lacked — a namespace-less root parses fine here but then fails to load as an <img>, dying at onerror as a generic "failed to decode". Namespace-less roots are common in hand-written/inlined SVG, so put it back.
function ensureSvgNamespaces(source: string): { source: string; restored: boolean } {
  const rootMatch = source.match(/<svg\b[^>]*>/i);
  if (!rootMatch) return { source, restored: false };
  const rootTag = rootMatch[0];
  let patched = rootTag;
  let restored = false;
  if (!/\sxmlns\s*=/i.test(rootTag)) {
    patched = patched.replace(/^<svg\b/i, `<svg xmlns="${SVG_NS}"`);
    restored = true;
  }
  // A bare xlink:href with no declaration is a hard XML namespace error, which would fail the parse below on a file the renderer would otherwise take.
  if (/\bxlink:/i.test(source) && !/\sxmlns:xlink\s*=/i.test(rootTag)) {
    patched = patched.replace(/^<svg\b/i, `<svg xmlns:xlink="${XLINK_NS}"`);
    restored = true;
  }
  if (!restored) return { source, restored: false };
  return { source: source.replace(rootTag, patched), restored: true };
}

function sanitiseSvg(raw: string): SanitisedSvg {
  droppedRefsThisPass = 0;
  const cleaned = DOMPurify.sanitize(raw, DOMPURIFY_CONFIG) as unknown as string;
  if (!cleaned || !cleaned.includes('<svg')) {
    throw new Error('SVG failed sanitisation (empty or no <svg> root)');
  }
  let droppedInstanceRefs = droppedRefsThisPass;
  for (const entry of DOMPurify.removed as Array<{ element?: Node }>) {
    const name = entry.element?.nodeName?.toLowerCase();
    if (name === 'use') droppedInstanceRefs += 1;
  }
  const { source, restored } = ensureSvgNamespaces(cleaned);
  return { source, droppedInstanceRefs, namespaceRestored: restored };
}

// The one XML parse of the (already sanitised) document — parsing only the sanitised output, rather than the raw customer XML, keeps this free of DTD entity-expansion exposure.
function parseSanitisedSvg(source: string): Document | null {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return null;
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg') return null;
  return doc;
}

// Parse one SVG length value ("3.5in", "90mm", "900px", "900") to inches. Returns null for values we can't resolve, including % which is meaningless without a containing block.
export function parseSvgLengthToInches(raw: string): number | null {
  const m = raw.trim().match(/^([\d.]+(?:e[+-]?\d+)?)\s*(in|cm|mm|pt|px|pc|)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  switch ((m[2] ?? '').toLowerCase()) {
    case 'in': return n;
    case 'cm': return n / 2.54;
    case 'mm': return n / 25.4;
    case 'pt': return n / 72;
    case 'pc': return n / 6; // 1 pica = 12pt = 1/6 inch — InDesign/Illustrator sometimes export in picas.
    case 'px': return n / 96;
    default: return n / 96;
  }
}

export interface SvgDimensions {
  widthInches: number;
  heightInches: number;
  source: 'attr' | 'viewbox' | 'fallback';
}

// Extract physical dimensions from an SVG string: explicit width+height first, then viewBox (96 user-units = 1 inch), then the spec fallback. Percent units are treated as absent — they're meaningless without a containing block and always mean the SVG was authored for fluid on-screen layout, not print.
export function getSvgDimensionsFromSource(source: string): SvgDimensions | null {
  const doc = parseSanitisedSvg(source);
  return doc ? getSvgDimensions(doc) : null;
}

// Dimension read against an already-parsed document.
export function getSvgDimensions(doc: Document): SvgDimensions | null {
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg') return null;

  const w = root.getAttribute('width');
  const h = root.getAttribute('height');
  const wIn = w ? parseSvgLengthToInches(w) : null;
  const hIn = h ? parseSvgLengthToInches(h) : null;
  if (wIn !== null && hIn !== null) {
    return { widthInches: wIn, heightInches: hIn, source: 'attr' };
  }

  const vb = root.getAttribute('viewBox');
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number);
    if (parts.length >= 4 && parts.slice(2).every((n) => isFinite(n) && n > 0)) {
      // Handle the common case where only one of width/height was set — derive the other from the viewBox aspect ratio so the artwork isn't squashed or stretched.
      const vbW = parts[2];
      const vbH = parts[3];
      if (wIn !== null && hIn === null) {
        return { widthInches: wIn, heightInches: wIn * (vbH / vbW), source: 'attr' };
      }
      if (hIn !== null && wIn === null) {
        return { widthInches: hIn * (vbW / vbH), heightInches: hIn, source: 'attr' };
      }
      return { widthInches: vbW / 96, heightInches: vbH / 96, source: 'viewbox' };
    }
  }

  return { widthInches: FALLBACK_WIDTH_IN, heightInches: FALLBACK_HEIGHT_IN, source: 'fallback' };
}

// Rasterise a sanitised SVG to a PNG blob at exactly the requested pixel size. Exported because the import-time raster is only a preview — the export path (vector-print-source.ts) calls this again at the design's placement size, straight from the retained geometry, so nothing is ever upscaled from a screen-safe-clamped preview.
export async function rasteriseSvgToPngBlob(
  sanitisedSource: string,
  widthPx: number,
  heightPx: number,
  options?: RasteriseOptions
): Promise<Blob> {
  const { blob } = await rasteriseSvgToPngBlobSafe(sanitisedSource, widthPx, heightPx, options);
  return blob;
}

async function rasteriseSvg(
  sanitisedSource: string,
  widthPx: number,
  heightPx: number
): Promise<{ image: HTMLImageElement; blob: Blob }> {
  const blob = await rasteriseSvgToPngBlob(sanitisedSource, widthPx, heightPx);

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load rasterised PNG')); };
    img.src = url;
  });

  return { image, blob };
}

export async function parseSVG(file: File): Promise<ParsedSVGData> {
  const raw = await file.text();

  // Before anything is handed to a renderer: would resolving this file's references ask for more shapes than any real design contains? Judged on the file as authored, since <use> survives sanitisation and other parts of the app (e.g. thumbnails) may hand the raw file to a renderer too.
  const sourceExpansion = analyseRawSvgExpansion(raw);
  if (sourceExpansion?.exceeded) throw new SvgTooComplexError(sourceExpansion);

  const { source: sanitised, droppedInstanceRefs, namespaceRestored } = sanitiseSvg(raw);

  const doc = parseSanitisedSvg(sanitised);
  if (!doc) throw new Error('Could not parse sanitised SVG');

  // And again on what actually survived sanitisation, which is what our own rasteriser will draw.
  const expansion = analyseSvgExpansion(doc.documentElement);
  if (expansion.exceeded) throw new SvgTooComplexError(expansion);

  const dims = getSvgDimensions(doc);
  if (!dims) throw new Error('Could not determine SVG dimensions');

  let widthPx = Math.max(1, Math.round(dims.widthInches * TARGET_DPI));
  let heightPx = Math.max(1, Math.round(dims.heightInches * TARGET_DPI));

  // Clamp the import preview to the platform's safe canvas ceiling — iOS Safari silently no-ops drawImage past it rather than failing loudly.
  const maxEdge = vectorExportMaxEdge();
  const dimensionalScale = Math.min(1, maxEdge / Math.max(widthPx, 1), maxEdge / Math.max(heightPx, 1));
  if (dimensionalScale < 1) {
    widthPx = Math.max(1, Math.round(widthPx * dimensionalScale));
    heightPx = Math.max(1, Math.round(heightPx * dimensionalScale));
  }

  const { image, blob } = await rasteriseSvg(sanitised, widthPx, heightPx);

  if (namespaceRestored) {
    console.warn('[svg-parser] restored a missing xmlns on the sanitised root');
  }
  if (droppedInstanceRefs > 0) {
    console.warn(
      `[svg-parser] ${droppedInstanceRefs} <use> reference(s) pointed outside the document and were dropped; that artwork is missing from the render`
    );
  }

  return {
    image,
    pngBlob: blob,
    svgSource: sanitised,
    widthPx,
    heightPx,
    widthInches: dims.widthInches,
    heightInches: dims.heightInches,
    // Deliberately the print DPI, not the (possibly clamped) preview's — export re-rasterises from svgSource at placement size, so quoting the preview's DPI would understate a file that prints at a full 300.
    dpi: vectorPrintDpi(dims.widthInches, dims.heightInches),
  };
}
