// Static expansion analysis for imported SVG — guards against `<use>` chains that grow the file linearly but the rendered primitive count exponentially (each level referencing two of the level below doubles the count per level; depth 16 is ~65k primitives from 1.6KB of source and can hang the main thread for a minute). Runs on the raw, as-authored file, not the sanitised one: `<use>` survives sanitisation (dropping it blanked legitimate `<symbol>`-based artwork), so this guard is what actually stands between a `<use>` bomb and the rasteriser. A `<pattern>` is charged once for its content rather than multiplied by tile count, since the browser rasterises a tile once and repeats the bitmap. Thresholds below are set from measurement against real gangsheet/icon-set artwork vs. deliberately pathological `<use>` chains.

const XLINK_NS = 'http://www.w3.org/1999/xlink';

// Hard ceiling on rendered primitives — ~3.3x above the heaviest plausible legitimate artwork measured (a 300-copy gangsheet of a 2,000-path logo via `<use>`).
export const MAX_EFFECTIVE_PRIMITIVES = 2_000_000;

// Below this many primitives nothing is rejected on amplification grounds, however the count was reached — keeps small-but-reused files out of the ratio check.
export const AMPLIFIED_PRIMITIVE_FLOOR = 50_000;

// Ratio of rendered to source primitives — the real signal for a bomb vs. heavy artwork. Legitimate reuse tops out around 400x measured; a `<use>` chain reaches 65,536x by depth 16. Erring generous is deliberate: rejecting real artwork is worse than a slow import, and svg-raster's timeout is the backstop for anything that slips through.
export const MAX_EXPANSION_FACTOR = 1_000;

// Constant weight approximating the measured overhead of wrapping a subtree in a pattern (~6x the subtree alone).
const PATTERN_CONTENT_WEIGHT = 4;

// Keeps arithmetic finite for pathological inputs; well above any threshold.
const COUNT_CEILING = 1_000_000_000;

// Elements that put a mark on the canvas where they sit.
const GRAPHIC_TAGS = new Set([
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'image',
]);

// Elements that define something for later reference and render nothing in place — their content is counted only where instantiated.
const DEFINITION_TAGS = new Set([
  'defs', 'symbol', 'pattern', 'marker', 'mask', 'clippath', 'filter',
  'lineargradient', 'radialgradient', 'style', 'title', 'desc', 'metadata',
  'animate', 'animatetransform', 'animatemotion', 'animatecolor', 'set', 'view',
  'font', 'font-face', 'glyph', 'missing-glyph', 'script',
]);

// Definition wrappers whose children are what an instance actually draws.
const INSTANTIABLE_WRAPPERS = new Set([
  'symbol', 'pattern', 'defs', 'marker', 'mask', 'clippath',
]);

export interface SvgExpansionReport {
  // Primitives the renderer would be asked to draw, after resolving references.
  effectivePrimitives: number;
  // Primitives physically present in the source, however many times reused.
  sourcePrimitives: number;
  // effectivePrimitives / sourcePrimitives, 1 when there is no reuse.
  expansionFactor: number;
  // True when the artwork should be rejected rather than handed to a renderer.
  exceeded: boolean;
  // Which limit was hit, for the message and for diagnostics.
  reason: 'total' | 'amplified' | null;
  // Counting was clamped at COUNT_CEILING; the real figure is larger still.
  truncated: boolean;
  // A <use> referenced itself or a mutual partner — invalid per spec, but the analysis has to survive it; the cyclic edge contributes nothing.
  cyclicReferences: boolean;
  // <use> elements whose target id is not in the document.
  unresolvedReferences: number;
}

const localName = (el: Element): string => (el.localName || el.tagName).toLowerCase();

// Same-document fragment target of a <use> reference, resolved the way a renderer resolves it: href first, then legacy xlink:href, and only #id — a reference into another file is a network load the <img> sandbox blocks anyway.
function fragmentTarget(el: Element): string | null {
  const raw =
    el.getAttribute('href') ??
    el.getAttributeNS(XLINK_NS, 'href') ??
    el.getAttribute('xlink:href');
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('#')) return null;
  const id = trimmed.slice(1);
  return id.length > 0 ? id : null;
}

// Pattern ids referenced by this element's paint properties.
function referencedPaintIds(el: Element): string[] {
  const out: string[] = [];
  const sources = [el.getAttribute('fill'), el.getAttribute('stroke'), el.getAttribute('style')];
  for (const value of sources) {
    if (!value || !value.includes('url(')) continue;
    // Array.from rather than a direct for-of, since matchAll's iterator needs downlevelIteration under this project's target.
    for (const m of Array.from(value.matchAll(/url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)/g))) {
      out.push(m[1]);
    }
  }
  return out;
}

const clamp = (n: number): number => (n > COUNT_CEILING ? COUNT_CEILING : n);

const EMPTY_REPORT: SvgExpansionReport = {
  effectivePrimitives: 0, sourcePrimitives: 0, expansionFactor: 1,
  exceeded: false, reason: null, truncated: false,
  cyclicReferences: false, unresolvedReferences: 0,
};

// Effective rendered primitive count for an SVG root element. Linear in document size despite the exponential counts it reports, because each referenced element's cost is memoised — a depth-30 chain is 30 lookups producing 2^30, not 2^30 units of work.
export function analyseSvgExpansion(root: Element | null): SvgExpansionReport {
  if (!root) return EMPTY_REPORT;

  // First definition wins, matching getElementById on a document with duplicate ids.
  const byId = new Map<string, Element>();
  for (const el of Array.from(root.querySelectorAll('[id]'))) {
    const id = el.getAttribute('id');
    if (id && !byId.has(id)) byId.set(id, el);
  }

  // Costs differ inside a pattern's content, so they memoise separately. A pattern can only nest inside another pattern, so "inside" is sticky.
  const memoOutside = new Map<Element, number>();
  const memoInside = new Map<Element, number>();
  const inProgress = new Set<Element>();
  let truncated = false;
  let cyclicReferences = false;
  let unresolvedReferences = 0;

  // What one instance of `target` draws.
  const instanceCost = (target: Element, inPattern: boolean): number => {
    const memo = inPattern ? memoInside : memoOutside;
    const cached = memo.get(target);
    if (cached !== undefined) return cached;
    if (inProgress.has(target)) {
      // Invalid self- or mutual reference — contribute nothing rather than recursing forever; the renderer refuses these too.
      cyclicReferences = true;
      return 0;
    }
    inProgress.add(target);
    const cost = INSTANTIABLE_WRAPPERS.has(localName(target))
      ? childrenCost(target, inPattern)
      : renderedCost(target, inPattern);
    inProgress.delete(target);
    memo.set(target, cost);
    return cost;
  };

  const childrenCost = (el: Element, inPattern: boolean): number => {
    let sum = 0;
    for (const child of Array.from(el.children)) {
      sum = clamp(sum + renderedCost(child, inPattern));
      if (sum >= COUNT_CEILING) { truncated = true; break; }
    }
    return sum;
  };

  // Paint-server content pulled in by fill/stroke (e.g. a pattern). Charged once per pattern definition, not per reference or nesting level — that's what the renderer does: the tile is rasterised once and repeated as a bitmap.
  const chargedPatterns = new Set<Element>();
  const paintCost = (el: Element, inPattern: boolean): number => {
    let extra = 0;
    for (const id of referencedPaintIds(el)) {
      const target = byId.get(id);
      if (!target || localName(target) !== 'pattern') continue;
      if (chargedPatterns.has(target)) continue;
      chargedPatterns.add(target);
      const weight = inPattern ? 1 : PATTERN_CONTENT_WEIGHT;
      extra = clamp(extra + instanceCost(target, true) * weight);
    }
    return extra;
  };

  // What this element draws where it sits in the tree.
  const renderedCost = (el: Element, inPattern: boolean): number => {
    const tag = localName(el);
    if (DEFINITION_TAGS.has(tag)) return 0;

    if (tag === 'use') {
      const id = fragmentTarget(el);
      if (!id) { unresolvedReferences += 1; return 0; }
      const target = byId.get(id);
      if (!target) { unresolvedReferences += 1; return 0; }
      const memo = inPattern ? memoInside : memoOutside;
      if (memo.get(target) === undefined && inProgress.has(target)) {
        cyclicReferences = true;
        return 0;
      }
      return clamp(instanceCost(target, inPattern) + paintCost(el, inPattern));
    }

    if (GRAPHIC_TAGS.has(tag)) return clamp(1 + paintCost(el, inPattern));

    // Containers: g, a, switch, nested svg, and anything unrecognised that might still hold drawable children.
    return clamp(childrenCost(el, inPattern) + paintCost(el, inPattern));
  };

  const effectivePrimitives = renderedCost(root, false);
  const sourcePrimitives = root.querySelectorAll(
    'path, rect, circle, ellipse, line, polyline, polygon, text, image'
  ).length;

  const expansionFactor = sourcePrimitives > 0
    ? effectivePrimitives / sourcePrimitives
    : effectivePrimitives > 0 ? Number.POSITIVE_INFINITY : 1;

  let reason: SvgExpansionReport['reason'] = null;
  if (effectivePrimitives > MAX_EFFECTIVE_PRIMITIVES) {
    reason = 'total';
  } else if (
    effectivePrimitives > AMPLIFIED_PRIMITIVE_FLOOR &&
    expansionFactor > MAX_EXPANSION_FACTOR
  ) {
    reason = 'amplified';
  }

  return {
    effectivePrimitives,
    sourcePrimitives,
    expansionFactor: Number.isFinite(expansionFactor)
      ? Math.round(expansionFactor * 10) / 10
      : expansionFactor,
    exceeded: reason !== null,
    reason,
    truncated,
    cyclicReferences,
    unresolvedReferences,
  };
}

// The same analysis on the file exactly as authored — this is the one that matters (see header note). Parsed as text/html deliberately: the same parse DOMPurify performs, expands no DTD entities, and keeps the SVG subtree/attributes/self-closing tags intact. Tag names come back lower-cased. Returns null when there's no <svg> root to analyse.
export function analyseRawSvgExpansion(rawSource: string): SvgExpansionReport | null {
  let root: Element | null = null;
  try {
    root = new DOMParser().parseFromString(rawSource, 'text/html').querySelector('svg');
  } catch {
    return null;
  }
  return root ? analyseSvgExpansion(root) : null;
}
