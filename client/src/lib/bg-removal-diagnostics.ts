// ─── Background-removal diagnostics ──────────────────────────────────────
//
// Pure helpers shared by the worker and main-thread paths. The point of
// this module is to make the bg-removal pipeline observable: after a run
// we can see exactly how many pixels were removed at each stage, what
// colour the boundary of the resulting silhouette actually is, and
// whether that boundary looks like a real artwork edge or like a
// residual halo. Surfacing those numbers in the browser console is what
// lets us tell — concretely, not by guessing — why a particular low-res
// design produces a contour far from its visible edges.
//
// Shape of the data we emit per Remove-White-Background run:
//
//   [BG-DIAG] {
//     imageSize: "1024×768",
//     totalPixels: 786432,
//     pixelsRemoved: 412034,                   // bg + halo combined
//     pctRemoved: "52.4%",
//     floodFillRemoved: 380110,                // strict flood-fill stage
//     haloCleanRemoved: 31924,                 // adaptive halo stage
//     sampledBgColor: "rgb(248,245,240)",      // mean of removed pixels
//     silhouetteBbox: { x: 12, y: 8, w: 1000, h: 750 },
//     silhouetteTouchesEdge: false,
//     boundary: {
//       count: 4823,                            // sampled edge pixels
//       avgLuma: 87.4,  minLuma: 0,   maxLuma: 254,
//       avgSat:  0.62,  minSat:  0,   maxSat:  1,
//       avgBgDist: 184.7, minBgDist: 12.3, maxBgDist: 295.0,
//       fractionNearWhite: 0.04,                // luma>230 && sat<0.05
//       fractionDesignLike: 0.81,               // sat>0.20 || luma<100
//       examples: ["rgb(255,0,0)", "rgb(0,0,0)", "rgb(255,255,255)", ...]
//     }
//   }
//
// Reading the output:
//
// • `fractionNearWhite` is the smoking gun. If it's > 0.20, the silhouette
//   boundary is still mostly near-white pixels — meaning we left a halo
//   and the contour will wrap around it.
// • `fractionDesignLike` is the inverse. If it's > 0.7, the boundary is
//   sitting on real artwork colour and the contour will hug the design.
// • `silhouetteTouchesEdge` flags designs that go all the way to the
//   image boundary; in that case the algorithm physically can't shrink
//   any further on that side, which is fine but worth knowing.
// • `avgBgDist` shows how far the boundary pixels are, on average, from
//   the colour we sampled as background. Small values (< 60) mean the
//   boundary is still bg-coloured (= halo); large values mean we're
//   sitting on real design colours.
//
// All counts are exact; the boundary stats are sampled with a stride of 3
// for performance on large images, which is plenty for a stable mean.

export interface BoundaryStats {
  count: number;
  avgLuma: number;
  minLuma: number;
  maxLuma: number;
  avgSat: number;
  minSat: number;
  maxSat: number;
  avgBgDist: number;
  minBgDist: number;
  maxBgDist: number;
  fractionNearWhite: number;
  fractionDesignLike: number;
  examples: string[];
}

export interface ComponentStats {
  /** Total number of connected components of kept (non-removed) pixels. */
  count: number;
  /** Size in pixels of the largest component. */
  largestSize: number;
  /** Bbox of the largest component. */
  largestBbox: { x: number; y: number; w: number; h: number } | null;
  /** Sizes of the top-5 components, descending. */
  top5Sizes: number[];
  /** Pixels in components below `smallComponentThreshold` (i.e. likely noise). */
  smallComponentPixels: number;
}

export interface BgRemovalDiagnostics {
  imageSize: string;
  totalPixels: number;
  pixelsRemoved: number;
  pctRemoved: string;
  floodFillRemoved: number;
  haloCleanRemoved: number;
  smallComponentRemoved: number;
  sampledBgColor: string;
  silhouetteBbox: { x: number; y: number; w: number; h: number } | null;
  silhouetteTouchesEdge: boolean;
  /** Counts of kept pixels in row 0, row H-1, col 0, col W-1 — edge-noise sniffer. */
  edgePixelCounts: { top: number; bottom: number; left: number; right: number };
  components: ComponentStats;
  boundary: BoundaryStats;
}

/**
 * 4-connected flood-fill labelling of all kept (non-removed) pixels.
 * Returns the size and bbox of every component, sorted by size desc.
 *
 * This is the core of detecting JPEG-noise specks at the canvas edges:
 * a clean design has one big component (the artwork itself); a noisy
 * low-res JPEG often has the artwork plus many tiny components from
 * isolated dark-ish specks that survived the bg-removal flood-fill
 * (because they were too dark to qualify as bg).
 */
function labelComponents(
  removed: Uint8Array,
  width: number,
  height: number,
): Array<{ size: number; bbox: { x: number; y: number; w: number; h: number } }> {
  const pixelCount = width * height;
  const labels = new Int32Array(pixelCount); // 0 = unvisited
  const queue = new Int32Array(pixelCount);
  const components: Array<{ size: number; bbox: { x: number; y: number; w: number; h: number } }> = [];
  let nextLabel = 1;

  for (let pos = 0; pos < pixelCount; pos++) {
    if (removed[pos]) continue;
    if (labels[pos]) continue;

    const label = nextLabel++;
    let qHead = 0;
    let qTail = 0;
    queue[qTail++] = pos;
    labels[pos] = label;
    let size = 0;
    let minX = width, minY = height, maxX = -1, maxY = -1;

    while (qHead < qTail) {
      const p = queue[qHead++];
      size++;
      const px = p % width;
      const py = (p - px) / width;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;

      if (px > 0) {
        const np = p - 1;
        if (!removed[np] && !labels[np]) { labels[np] = label; queue[qTail++] = np; }
      }
      if (px < width - 1) {
        const np = p + 1;
        if (!removed[np] && !labels[np]) { labels[np] = label; queue[qTail++] = np; }
      }
      if (py > 0) {
        const np = p - width;
        if (!removed[np] && !labels[np]) { labels[np] = label; queue[qTail++] = np; }
      }
      if (py < height - 1) {
        const np = p + width;
        if (!removed[np] && !labels[np]) { labels[np] = label; queue[qTail++] = np; }
      }
    }

    components.push({
      size,
      bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    });
  }

  components.sort((a, b) => b.size - a.size);
  return components;
}

function bboxesOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

function bboxTouchesImageEdge(
  bb: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
): boolean {
  return bb.x === 0 || bb.y === 0 || bb.x + bb.w === width || bb.y + bb.h === height;
}

/**
 * Number of image edges (top/right/bottom/left) the component's bbox
 * touches. A pure frame ring around the canvas touches all four; a real
 * design element that happens to extend to the canvas border typically
 * touches 1–2.
 */
function bboxEdgesTouched(
  bb: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
): number {
  return (
    (bb.x === 0 ? 1 : 0) +
    (bb.y === 0 ? 1 : 0) +
    (bb.x + bb.w === width ? 1 : 0) +
    (bb.y + bb.h === height ? 1 : 0)
  );
}

/**
 * Remove all kept pixels that belong to non-artwork connected components.
 *
 * Two clearing rules, evaluated against every component except the
 * largest (which is always preserved as the artwork):
 *
 *  1. **Tiny-speck rule.** Component is dust-sized — both
 *       size ≤ `absoluteThreshold` (default 50 px), AND
 *       size ≤ `relativeThreshold` × largestComponentSize (default 0.1%).
 *     Catches isolated JPEG-quantization specks and stray pixels.
 *
 *  2. **Frame-ring rule.** Component's bbox touches all four image
 *     edges. The only way a single connected component can simultaneously
 *     hit the top, right, bottom, AND left edge of the canvas is if it
 *     wraps around the canvas perimeter — i.e. it's a frame / border /
 *     scan-artifact ring. A real design element that happens to extend
 *     to the image border touches at most 2 edges (e.g. a banner along
 *     the bottom touches bottom + left + right at most when it spans
 *     the full width, which would still be 3, never 4).
 *
 *     We require all four edges (not three) deliberately: a U-shaped
 *     decoration along three sides is unusual but plausible art; a
 *     ring touching all four sides is overwhelmingly always an
 *     unintended frame.
 *
 *     The largest component is exempted, so designs that legitimately
 *     fill the canvas (the main artwork *is* the canvas-spanning blob)
 *     are never erased.
 *
 * Returns the number of pixels cleared (across all rules).
 */
export function removeSmallComponents(
  data: Uint8ClampedArray,
  removed: Uint8Array,
  width: number,
  height: number,
  absoluteThreshold = 50,
  relativeThreshold = 0.001,
  log: (...args: unknown[]) => void = console.log,
): number {
  const components = labelComponents(removed, width, height);
  if (components.length <= 1) return 0;
  const largest = components[0];
  const largestBbox = largest.bbox;
  const sizeCap = Math.max(absoluteThreshold, Math.floor(largest.size * relativeThreshold));

  // Re-label and clear in one second pass — cheaper than persisting the
  // full label array. We just re-run BFS from each unvisited kept pixel
  // and decide whether to clear it based on its component size.
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let cleared = 0;

  const pixelCount = width * height;
  for (let pos = 0; pos < pixelCount; pos++) {
    if (removed[pos]) continue;
    if (visited[pos]) continue;

    let qHead = 0;
    let qTail = 0;
    queue[qTail++] = pos;
    visited[pos] = 1;
    const start = qTail - 1;
    let minX = width, minY = height, maxX = -1, maxY = -1;

    while (qHead < qTail) {
      const p = queue[qHead++];
      const px = p % width;
      const py = (p - px) / width;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      if (px > 0) {
        const np = p - 1;
        if (!removed[np] && !visited[np]) { visited[np] = 1; queue[qTail++] = np; }
      }
      if (px < width - 1) {
        const np = p + 1;
        if (!removed[np] && !visited[np]) { visited[np] = 1; queue[qTail++] = np; }
      }
      if (py > 0) {
        const np = p - width;
        if (!removed[np] && !visited[np]) { visited[np] = 1; queue[qTail++] = np; }
      }
      if (py < height - 1) {
        const np = p + width;
        if (!removed[np] && !visited[np]) { visited[np] = 1; queue[qTail++] = np; }
      }
    }

    const size = qTail - start;
    const compBbox = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };

    if (size === largest.size) {
      log(
        `[SmallCompCleanup] component size=${size} bbox=${compBbox.w}×${compBbox.h}@(${compBbox.x},${compBbox.y}) — KEPT (largest)`
      );
      continue;
    }

    const isTinySpeck = size <= sizeCap;
    const edgesTouched = bboxEdgesTouched(compBbox, width, height);
    const isFrameRing = edgesTouched === 4;

    const decision = (isTinySpeck || isFrameRing) ? 'CLEAR' : 'KEEP';
    log(
      `[SmallCompCleanup] component size=${size} ` +
      `bbox=${compBbox.w}×${compBbox.h}@(${compBbox.x},${compBbox.y}) ` +
      `largestBbox=${largestBbox.w}×${largestBbox.h}@(${largestBbox.x},${largestBbox.y}) ` +
      `tinySpeck=${isTinySpeck} edgesTouched=${edgesTouched} ` +
      `frameRing=${isFrameRing} → ${decision}`
    );

    if (!isTinySpeck && !isFrameRing) continue;

    for (let i = start; i < qTail; i++) {
      const p = queue[i];
      data[p * 4 + 3] = 0;
      removed[p] = 1;
      cleared++;
    }
  }

  return cleared;
}

function summarizeComponents(
  removed: Uint8Array,
  width: number,
  height: number,
  smallComponentThreshold: number,
): ComponentStats {
  const components = labelComponents(removed, width, height);
  if (components.length === 0) {
    return {
      count: 0,
      largestSize: 0,
      largestBbox: null,
      top5Sizes: [],
      smallComponentPixels: 0,
    };
  }
  let smallPixels = 0;
  for (let i = 1; i < components.length; i++) {
    if (components[i].size <= smallComponentThreshold) {
      smallPixels += components[i].size;
    }
  }
  return {
    count: components.length,
    largestSize: components[0].size,
    largestBbox: components[0].bbox,
    top5Sizes: components.slice(0, 5).map((c) => c.size),
    smallComponentPixels: smallPixels,
  };
}

function countEdgePixels(
  removed: Uint8Array,
  width: number,
  height: number,
): { top: number; bottom: number; left: number; right: number } {
  let top = 0, bottom = 0, left = 0, right = 0;
  for (let x = 0; x < width; x++) {
    if (!removed[x]) top++;
    if (!removed[(height - 1) * width + x]) bottom++;
  }
  for (let y = 0; y < height; y++) {
    if (!removed[y * width]) left++;
    if (!removed[y * width + width - 1]) right++;
  }
  return { top, bottom, left, right };
}

/**
 * Compute the bounding box of all non-removed (silhouette) pixels.
 * Returns `null` if everything was removed (empty silhouette).
 */
function computeSilhouetteBbox(
  removed: Uint8Array,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      if (removed[rowBase + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Walk every pixel that is on the silhouette boundary (kept pixel with at
 * least one removed 4-neighbour, or kept pixel on the image edge) and
 * accumulate luminance / saturation / distance-to-bg statistics. Stride
 * of 3 along the image so we visit ~1/3 of all pixels worst case.
 */
function summarizeBoundary(
  data: Uint8ClampedArray,
  removed: Uint8Array,
  width: number,
  height: number,
  bgR: number,
  bgG: number,
  bgB: number,
): BoundaryStats {
  let count = 0;
  let lumaSum = 0;
  let lumaMin = 255;
  let lumaMax = 0;
  let satSum = 0;
  let satMin = 1;
  let satMax = 0;
  let distSum = 0;
  let distMin = Infinity;
  let distMax = 0;
  let nearWhiteCount = 0;
  let designLikeCount = 0;
  const examples: string[] = [];
  const pixelCount = width * height;

  for (let pos = 0; pos < pixelCount; pos += 3) {
    if (removed[pos]) continue;
    const x = pos % width;
    const y = (pos - x) / width;

    let isBoundary = (x === 0 || x === width - 1 || y === 0 || y === height - 1);
    if (!isBoundary) {
      if (
        removed[pos - 1] ||
        removed[pos + 1] ||
        removed[pos - width] ||
        removed[pos + width]
      ) {
        isBoundary = true;
      }
    }
    if (!isBoundary) continue;

    count++;
    const idx = pos * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];

    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const maxCh = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const minCh = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const sat = maxCh === 0 ? 0 : (maxCh - minCh) / maxCh;
    const dr = r - bgR;
    const dg = g - bgG;
    const db = b - bgB;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);

    lumaSum += luma;
    if (luma < lumaMin) lumaMin = luma;
    if (luma > lumaMax) lumaMax = luma;
    satSum += sat;
    if (sat < satMin) satMin = sat;
    if (sat > satMax) satMax = sat;
    distSum += dist;
    if (dist < distMin) distMin = dist;
    if (dist > distMax) distMax = dist;

    if (luma > 230 && sat < 0.05) nearWhiteCount++;
    if (sat > 0.2 || luma < 100) designLikeCount++;

    if (examples.length < 8 && (count % 17 === 1)) {
      examples.push(`rgb(${r},${g},${b})`);
    }
  }

  if (count === 0) {
    return {
      count: 0,
      avgLuma: 0, minLuma: 0, maxLuma: 0,
      avgSat: 0, minSat: 0, maxSat: 0,
      avgBgDist: 0, minBgDist: 0, maxBgDist: 0,
      fractionNearWhite: 0,
      fractionDesignLike: 0,
      examples: [],
    };
  }

  return {
    count,
    avgLuma: +(lumaSum / count).toFixed(1),
    minLuma: Math.round(lumaMin),
    maxLuma: Math.round(lumaMax),
    avgSat: +(satSum / count).toFixed(3),
    minSat: +satMin.toFixed(3),
    maxSat: +satMax.toFixed(3),
    avgBgDist: +(distSum / count).toFixed(1),
    minBgDist: +distMin.toFixed(1),
    maxBgDist: +distMax.toFixed(1),
    fractionNearWhite: +(nearWhiteCount / count).toFixed(3),
    fractionDesignLike: +(designLikeCount / count).toFixed(3),
    examples,
  };
}

/**
 * One-line human-readable digest of the diagnostic — handy when the
 * console folds the structured object so the interesting fields aren't
 * visible at a glance.
 */
export function formatBgRemovalDigest(d: BgRemovalDiagnostics): string {
  const bb = d.silhouetteBbox;
  const bbStr = bb
    ? `${bb.w}×${bb.h}@(${bb.x},${bb.y})${d.silhouetteTouchesEdge ? ' touchesEdge' : ''}`
    : 'empty';
  const lb = d.components.largestBbox;
  const lbStr = lb ? `${lb.w}×${lb.h}@(${lb.x},${lb.y})` : 'none';
  const ep = d.edgePixelCounts;
  const epStr = `top=${ep.top} bottom=${ep.bottom} left=${ep.left} right=${ep.right}`;
  const b = d.boundary;
  const bStr =
    `count=${b.count} avgLuma=${b.avgLuma} avgSat=${b.avgSat} ` +
    `avgBgDist=${b.avgBgDist} fracNearWhite=${b.fractionNearWhite} ` +
    `fracDesignLike=${b.fractionDesignLike}`;
  return (
    `image=${d.imageSize} removed=${d.pixelsRemoved}/${d.totalPixels} (${d.pctRemoved}) ` +
    `floodFill=${d.floodFillRemoved} haloClean=${d.haloCleanRemoved} ` +
    `smallComp=${d.smallComponentRemoved} bg=${d.sampledBgColor} ` +
    `silhouette=${bbStr} largestComp=${lbStr} (${d.components.largestSize}px, ` +
    `${d.components.count} comps, top5=[${d.components.top5Sizes.join(',')}]) ` +
    `edgePx={${epStr}} | boundary: ${bStr} | examples=[${b.examples.join(', ')}]`
  );
}

export function computeBgRemovalDiagnostics(
  data: Uint8ClampedArray,
  removed: Uint8Array,
  width: number,
  height: number,
  bgR: number,
  bgG: number,
  bgB: number,
  floodFillRemoved: number,
  haloCleanRemoved: number,
  smallComponentRemoved: number,
): BgRemovalDiagnostics {
  const totalPixels = width * height;
  const pixelsRemoved = floodFillRemoved + haloCleanRemoved + smallComponentRemoved;
  const bbox = computeSilhouetteBbox(removed, width, height);
  const silhouetteTouchesEdge =
    bbox !== null && (
      bbox.x === 0 ||
      bbox.y === 0 ||
      bbox.x + bbox.w === width ||
      bbox.y + bbox.h === height
    );
  const edgePixelCounts = countEdgePixels(removed, width, height);
  const components = summarizeComponents(removed, width, height, 50);
  const boundary = summarizeBoundary(data, removed, width, height, bgR, bgG, bgB);

  return {
    imageSize: `${width}×${height}`,
    totalPixels,
    pixelsRemoved,
    pctRemoved: ((pixelsRemoved / totalPixels) * 100).toFixed(1) + '%',
    floodFillRemoved,
    haloCleanRemoved,
    smallComponentRemoved,
    sampledBgColor: `rgb(${Math.round(bgR)},${Math.round(bgG)},${Math.round(bgB)})`,
    silhouetteBbox: bbox,
    silhouetteTouchesEdge,
    edgePixelCounts,
    components,
    boundary,
  };
}
