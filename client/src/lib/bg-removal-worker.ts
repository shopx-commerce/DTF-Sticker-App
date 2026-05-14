import {
  computeBgRemovalDiagnostics,
  formatBgRemovalDigest,
  removeSmallComponents,
} from './bg-removal-diagnostics';

// Forward worker logs to the main thread (the MCP browser console capture
// doesn't see worker.console output reliably; postMessage broadcasts do).
function wlog(...args: any[]) {
  try {
    (self as unknown as Worker).postMessage({ type: 'log', args });
  } catch {}
  console.log(...args);
}

function processRemoval(data: Uint8ClampedArray, width: number, height: number, threshold: number): void {
  // Performance-critical path: prior implementation used JS Set<number> for
  // visited/removed/cleanup-visited bookkeeping. For a 2000×2000 image that's
  // up to 4M Set entries, which is 100s of MB of allocator pressure and
  // 30s+ of BFS time. Typed-array bitmaps cut both memory and time by 10–50×
  // while keeping the algorithm identical.
  const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  wlog('[BgRemoval] processRemoval START', width, '×', height, 'threshold=', threshold);

  const thresholdValue = (threshold / 100) * 255;
  const pixelCount = width * height;

  // Pixel-position bitmaps (1 byte per pixel; 0 = absent, 1 = present).
  const visited = new Uint8Array(pixelCount);
  const removed = new Uint8Array(pixelCount);

  // Single growable queue of pixel positions (not byte indices).
  const queue = new Int32Array(pixelCount);
  let qHead = 0;
  let qTail = 0;
  wlog('[BgRemoval] allocated', (pixelCount * 6 / 1024 / 1024).toFixed(1), 'MB of bitmaps');

  const enqueueIfWhite = (pos: number) => {
    if (visited[pos]) return;
    visited[pos] = 1;
    const idx = pos * 4;
    const a = data[idx + 3];
    if (a < 128) {
      queue[qTail++] = pos;
      return;
    }
    const minChannel = Math.min(data[idx], data[idx + 1], data[idx + 2]);
    if (minChannel >= thresholdValue) queue[qTail++] = pos;
  };

  for (let x = 0; x < width; x++) {
    enqueueIfWhite(x);                            // top edge
    enqueueIfWhite((height - 1) * width + x);     // bottom edge
  }
  for (let y = 1; y < height - 1; y++) {
    enqueueIfWhite(y * width);                    // left edge
    enqueueIfWhite(y * width + width - 1);        // right edge
  }
  wlog('[BgRemoval] edge seeds:', qTail, 'after', ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0).toFixed(0), 'ms');

  while (qHead < qTail) {
    const pos = queue[qHead++];
    const idx = pos * 4;
    const a = data[idx + 3];
    if (a >= 128) {
      const minCh = Math.min(data[idx], data[idx + 1], data[idx + 2]);
      if (minCh >= thresholdValue) removed[pos] = 1;
    }

    const x = pos % width;
    const y = (pos - x) / width;

    const tryNeighbor = (npos: number) => {
      if (visited[npos]) return;
      visited[npos] = 1;
      const ni = npos * 4;
      const na = data[ni + 3];
      if (na < 128) { queue[qTail++] = npos; return; }
      const nMin = Math.min(data[ni], data[ni + 1], data[ni + 2]);
      if (nMin >= thresholdValue) queue[qTail++] = npos;
    };

    if (y > 0) tryNeighbor(pos - width);
    if (y < height - 1) tryNeighbor(pos + width);
    if (x > 0) tryNeighbor(pos - 1);
    if (x < width - 1) tryNeighbor(pos + 1);
  }
  let _removedCount = 0;
  for (let i = 0; i < pixelCount; i++) if (removed[i]) _removedCount++;
  wlog('[BgRemoval] BFS done. visited:', qTail, 'removed:', _removedCount, 'after', ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0).toFixed(0), 'ms');

  // Sample the average colour of the removed (background) pixels BEFORE
  // we zero their alpha. The flood-fill above only writes to alpha — RGB
  // is intact — so this gives us the actual background colour the user's
  // image was shot/exported with. On a low-quality JPEG that's rarely a
  // perfect 255/255/255; the cleanup gate below uses this as an adaptive
  // reference so off-tint halos still get caught.
  let bgSumR = 0;
  let bgSumG = 0;
  let bgSumB = 0;
  let bgSampleCount = 0;
  for (let pos = 0; pos < pixelCount; pos += 7) {
    if (!removed[pos]) continue;
    const idx = pos * 4;
    bgSumR += data[idx];
    bgSumG += data[idx + 1];
    bgSumB += data[idx + 2];
    bgSampleCount++;
  }
  const bgR = bgSampleCount > 0 ? bgSumR / bgSampleCount : 255;
  const bgG = bgSampleCount > 0 ? bgSumG / bgSampleCount : 255;
  const bgB = bgSampleCount > 0 ? bgSumB / bgSampleCount : 255;

  // Apply alpha=0 to every removed pixel.
  let floodFillRemoved = 0;
  for (let pos = 0; pos < pixelCount; pos++) {
    if (removed[pos]) {
      data[pos * 4 + 3] = 0;
      floodFillRemoved++;
    }
  }

  // ── Halo cleanup pass ───────────────────────────────────────────────
  // 8-connected BFS that walks inward from every removed pixel. The BFS
  // only advances through pixels that themselves pass the cleanup gate,
  // so coloured design pixels stop the BFS at the silhouette edge — we
  // can chase a halo a long way without ever bleeding into real artwork.
  //
  // Three accept paths through the gate, any one is enough:
  //   • near pure white  (minCh >= 200)
  //   • already partial alpha  (a < 180) — anti-aliased PNG edges
  //   • close in RGB to the sampled background colour
  //     (squared distance <= bgColorToleranceSq, ≈ 60 RGB units).
  //
  // The third path is what makes this robust on low-resolution / heavily
  // compressed JPEG inputs. Their halos are typically tinted gradients
  // (e.g. rgb(210,195,180) running into the artwork) that fail every
  // single fixed-channel threshold but are obviously the same kind of
  // pixel as the bulk background that was already removed. Anchoring
  // the gate on the sampled bg colour catches those without eating into
  // genuine design colours, which sit far outside the tolerance.
  const maxCleanupDepth = 60;
  const alphaCleanupThreshold = 180;
  const whiteCleanupThreshold = 200;
  const bgColorToleranceSq = 60 * 60;

  const cleanupVisited = new Uint8Array(pixelCount);
  // Each entry is (pos | depth<<24). depth fits in 8 bits (max 255).
  const cleanupQueue = new Int32Array(pixelCount);
  let cHead = 0;
  let cTail = 0;
  let haloCleanRemoved = 0;

  for (let pos = 0; pos < pixelCount; pos++) {
    if (!removed[pos]) continue;
    const x = pos % width;
    const y = (pos - x) / width;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const npos = ny * width + nx;
        if (removed[npos]) continue;
        if (cleanupVisited[npos]) continue;
        cleanupVisited[npos] = 1;
        cleanupQueue[cTail++] = npos | (1 << 24);
      }
    }
  }

  while (cHead < cTail) {
    const entry = cleanupQueue[cHead++];
    const pos = entry & 0xFFFFFF;
    const depth = (entry >> 24) & 0xFF;

    const idx = pos * 4;
    const a = data[idx + 3];
    if (a === 0) continue;

    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const minCh = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const dr = r - bgR;
    const dg = g - bgG;
    const db = b - bgB;
    const colorDistSq = dr * dr + dg * dg + db * db;
    if (!(
      minCh >= whiteCleanupThreshold ||
      a < alphaCleanupThreshold ||
      colorDistSq <= bgColorToleranceSq
    )) continue;

    data[idx + 3] = 0;
    removed[pos] = 1;
    haloCleanRemoved++;

    if (depth >= maxCleanupDepth) continue;

    const x = pos % width;
    const y = (pos - x) / width;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const npos = ny * width + nx;
        if (removed[npos] || cleanupVisited[npos]) continue;
        cleanupVisited[npos] = 1;
        cleanupQueue[cTail++] = npos | ((depth + 1) << 24);
      }
    }
  }

  // ── Small-component cleanup pass ───────────────────────────────────────
  // The flood-fill + halo cleanup correctly remove the bulk background and
  // its near-bg-coloured halo, but they leave behind any *isolated dark*
  // pixels — JPEG-quantization specks at the canvas corners, stray dots
  // along the edges, etc. Those specks are too dark to qualify as halo,
  // so they survive every gate above. Visually invisible, but they hold
  // the silhouette bbox open to the entire image, which makes the contour
  // wrap miles outside the actual artwork.
  //
  // We label all kept pixels into 4-connected components and clear any
  // component that's both individually tiny (≤ 50 px) AND tiny relative
  // to the largest component (≤ 0.1% of it). The two-gate rule means a
  // legitimate small design element (a 200-px star next to a 5000-px
  // logo) is safely preserved while a 12-px speck is removed.
  const smallComponentRemoved = removeSmallComponents(
    data, removed, width, height, 50, 0.001, wlog,
  );

  // Emit a structured diagnostic summary so a developer can see — without
  // guessing — how the run actually went. See bg-removal-diagnostics.ts
  // for what each field means and how to read it.
  const diag = computeBgRemovalDiagnostics(
    data, removed, width, height, bgR, bgG, bgB,
    floodFillRemoved, haloCleanRemoved, smallComponentRemoved,
  );
  wlog('[BG-DIAG]', diag);
  wlog('[BG-DIAG-DIGEST]', formatBgRemovalDigest(diag));

  wlog('[BgRemoval] processRemoval END after', ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0).toFixed(0), 'ms');
}

// ─── Edge-connected background removal (auto-detected color) ──────────────
//
// Generalisation of the white-flood-fill above for the case where the
// background is _any_ color the design isn't built out of (the canonical
// example: a logo with lots of internal black sitting on a black textured
// background — a global "remove all dark" pass would destroy the logo, but
// flood-filling _from the image borders only through pixels matching the
// sampled border color_ leaves enclosed dark regions, QR codes, text
// outlines, and shadows untouched because they aren't connected to the
// background.
//
// Pipeline:
//   1. Sample border pixels → mean RGB → background color reference
//   2. Flood-fill from the four edges; a pixel matches when:
//        - alpha >= 128, AND
//        - saturation < `protectSaturation` (so red splashes / lime green
//          near the edge survive), AND
//        - euclidean RGB distance to the sampled bg color <= `tolerance`
//   3. Same halo-cleanup pass the white-mode uses (catches anti-aliased
//      ring around the design after the fill).
//   4. Optional 1–2 px alpha feather for clean edges on splashes / text.

interface BgColor { r: number; g: number; b: number; stdev: number; sampleCount: number }

function sampleBorderBackgroundColor(
  data: Uint8ClampedArray,
  width: number,
  height: number
): BgColor {
  let count = 0;
  let sumR = 0, sumG = 0, sumB = 0;
  let sumR2 = 0, sumG2 = 0, sumB2 = 0;

  const visit = (x: number, y: number) => {
    const idx = (y * width + x) * 4;
    if (data[idx + 3] < 128) return;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    sumR += r; sumG += g; sumB += b;
    sumR2 += r * r; sumG2 += g * g; sumB2 += b * b;
    count++;
  };
  for (let x = 0; x < width; x++) { visit(x, 0); visit(x, height - 1); }
  for (let y = 1; y < height - 1; y++) { visit(0, y); visit(width - 1, y); }

  if (count === 0) return { r: 255, g: 255, b: 255, stdev: 0, sampleCount: 0 };

  const r = sumR / count, g = sumG / count, b = sumB / count;
  const varR = Math.max(0, sumR2 / count - r * r);
  const varG = Math.max(0, sumG2 / count - g * g);
  const varB = Math.max(0, sumB2 / count - b * b);
  const stdev = Math.sqrt((varR + varG + varB) / 3);
  return { r, g, b, stdev, sampleCount: count };
}

function pixelSaturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  if (max === 0) return 0;
  return ((max - Math.min(r, g, b)) / max) * 255;
}

function isEdgeBgPixel(
  data: Uint8ClampedArray,
  index: number,
  bg: BgColor,
  tolerance: number,
  protectSaturation: number
): boolean {
  const a = data[index + 3];
  if (a < 128) return true; // already-transparent pixels are background by definition
  const r = data[index], g = data[index + 1], b = data[index + 2];
  if (pixelSaturation(r, g, b) > protectSaturation) return false;
  const dr = r - bg.r, dg = g - bg.g, db = b - bg.b;
  return Math.sqrt(dr * dr + dg * dg + db * db) <= tolerance;
}

function floodFillEdgeBg(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  bg: BgColor,
  tolerance: number,
  protectSaturation: number
): Set<number> {
  const toRemove = new Set<number>();
  const visited = new Set<number>();
  const queue: number[] = [];
  const getIdx = (x: number, y: number) => (y * width + x) * 4;

  const seed = (x: number, y: number) => {
    const i = getIdx(x, y);
    if (visited.has(i)) return;
    if (isEdgeBgPixel(data, i, bg, tolerance, protectSaturation)) {
      visited.add(i);
      queue.push(i);
    }
  };
  for (let x = 0; x < width; x++) { seed(x, 0); seed(x, height - 1); }
  for (let y = 0; y < height; y++) { seed(0, y); seed(width - 1, y); }

  let qi = 0;
  while (qi < queue.length) {
    const i = queue[qi++];
    if (data[i + 3] >= 128) toRemove.add(i); // don't bother re-marking already-transparent

    const pos = i / 4;
    const x = pos % width;
    const y = Math.floor(pos / width);
    const ns = [
      { nx: x, ny: y - 1 }, { nx: x, ny: y + 1 },
      { nx: x - 1, ny: y }, { nx: x + 1, ny: y },
    ];
    for (const { nx, ny } of ns) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const ni = getIdx(nx, ny);
      if (visited.has(ni)) continue;
      visited.add(ni);
      if (isEdgeBgPixel(data, ni, bg, tolerance, protectSaturation)) queue.push(ni);
    }
  }
  return toRemove;
}

/**
 * Soft 3x3 box blur of the alpha channel for the pixels neighbouring removed
 * regions only. `featherPx=1` blurs once, `featherPx=2` blurs twice. Run after
 * the flood fill so opaque interiors stay perfectly opaque.
 */
function featherAlphaAtBoundary(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  removedSet: Set<number>,
  featherPx: number
): void {
  if (featherPx <= 0 || removedSet.size === 0) return;

  // Boundary = pixels with alpha > 0 that have at least one removed neighbour
  const boundary: number[] = [];
  const removedPos = new Set<number>();
  removedSet.forEach((i) => removedPos.add(i / 4));

  removedPos.forEach((pixelPos) => {
    const x = pixelPos % width;
    const y = Math.floor(pixelPos / width);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const nPos = ny * width + nx;
        if (removedPos.has(nPos)) continue;
        if (data[nPos * 4 + 3] === 0) continue;
        boundary.push(nPos);
      }
    }
  });

  for (let pass = 0; pass < featherPx; pass++) {
    const newAlphas = new Map<number, number>();
    for (const pos of boundary) {
      const x = pos % width;
      const y = Math.floor(pos / width);
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          sum += data[(ny * width + nx) * 4 + 3];
          n++;
        }
      }
      newAlphas.set(pos, Math.round(sum / n));
    }
    newAlphas.forEach((a, pos) => { data[pos * 4 + 3] = a; });
  }
}

function processEdgeColorRemoval(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  tolerance: number,
  protectSaturation: number,
  featherPx: number
): { bg: BgColor; removedCount: number } {
  const bg = sampleBorderBackgroundColor(data, width, height);
  const removed = floodFillEdgeBg(data, width, height, bg, tolerance, protectSaturation);
  removed.forEach((i) => { data[i + 3] = 0; });
  featherAlphaAtBoundary(data, width, height, removed, featherPx);
  return { bg, removedCount: removed.size };
}

// ─── Specific-color background removal (user-picked) ──────────────────────
//
// User-picked variant of the edge-connected mode: instead of auto-sampling
// the border colour, the caller passes the exact RGB they want to remove
// (typically picked via the browser EyeDropper API). The flood-fill still
// starts from the image edges so enclosed pixels of the same colour
// (e.g. internal black inside a logo, QR code modules) remain untouched —
// only the connected outer background is cleared.

function isPickedColorPixel(
  data: Uint8ClampedArray,
  index: number,
  picked: { r: number; g: number; b: number },
  tolerance: number
): boolean {
  const a = data[index + 3];
  if (a < 128) return true; // already-transparent pixels propagate the fill
  const dr = data[index] - picked.r;
  const dg = data[index + 1] - picked.g;
  const db = data[index + 2] - picked.b;
  return Math.sqrt(dr * dr + dg * dg + db * db) <= tolerance;
}

function floodFillPickedColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  picked: { r: number; g: number; b: number },
  tolerance: number
): Set<number> {
  const toRemove = new Set<number>();
  const visited = new Set<number>();
  const queue: number[] = [];
  const getIdx = (x: number, y: number) => (y * width + x) * 4;

  const seed = (x: number, y: number) => {
    const i = getIdx(x, y);
    if (visited.has(i)) return;
    if (isPickedColorPixel(data, i, picked, tolerance)) {
      visited.add(i);
      queue.push(i);
    }
  };
  for (let x = 0; x < width; x++) { seed(x, 0); seed(x, height - 1); }
  for (let y = 0; y < height; y++) { seed(0, y); seed(width - 1, y); }

  let qi = 0;
  while (qi < queue.length) {
    const i = queue[qi++];
    if (data[i + 3] >= 128) toRemove.add(i);

    const pos = i / 4;
    const x = pos % width;
    const y = Math.floor(pos / width);
    const ns = [
      { nx: x, ny: y - 1 }, { nx: x, ny: y + 1 },
      { nx: x - 1, ny: y }, { nx: x + 1, ny: y },
    ];
    for (const { nx, ny } of ns) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const ni = getIdx(nx, ny);
      if (visited.has(ni)) continue;
      visited.add(ni);
      if (isPickedColorPixel(data, ni, picked, tolerance)) queue.push(ni);
    }
  }
  return toRemove;
}

/**
 * Walk every pixel and clear alpha for any opaque pixel within `tolerance`
 * of the picked colour, with no connectivity test. Use this only when the
 * user explicitly opts in (Shift+click in the editor) — it ignores the
 * "preserve enclosed details" guarantee of the flood-fill mode.
 */
function globalRemovePickedColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  picked: { r: number; g: number; b: number },
  tolerance: number
): Set<number> {
  const removed = new Set<number>();
  const total = width * height;
  for (let p = 0; p < total; p++) {
    const i = p * 4;
    if (data[i + 3] < 128) continue;
    const dr = data[i] - picked.r;
    const dg = data[i + 1] - picked.g;
    const db = data[i + 2] - picked.b;
    if (Math.sqrt(dr * dr + dg * dg + db * db) <= tolerance) removed.add(i);
  }
  return removed;
}

// ─── Magic-wand: flood-fill from a single click point ────────────────────
//
// Seeds at the user's clicked pixel, samples its colour, and walks
// connected pixels within `tolerance` of that colour. Removes only the
// connected region containing the click — perfect for cleaning up an
// interior region (e.g. the "8" inside an 8-ball helmet) without touching
// other pixels of the same colour elsewhere in the design.

function floodFillFromPoint(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  tolerance: number
): { removed: Set<number>; seedColor: { r: number; g: number; b: number }; seededOnTransparent: boolean } {
  const seedIdx = (seedY * width + seedX) * 4;
  const seedColor = { r: data[seedIdx], g: data[seedIdx + 1], b: data[seedIdx + 2] };
  const seededOnTransparent = data[seedIdx + 3] < 128;
  if (seededOnTransparent) return { removed: new Set(), seedColor, seededOnTransparent };

  const removed = new Set<number>();
  const visited = new Set<number>();
  const queue: number[] = [seedIdx];
  visited.add(seedIdx);

  const matches = (idx: number): boolean => {
    if (data[idx + 3] < 128) return false;
    const dr = data[idx] - seedColor.r;
    const dg = data[idx + 1] - seedColor.g;
    const db = data[idx + 2] - seedColor.b;
    return Math.sqrt(dr * dr + dg * dg + db * db) <= tolerance;
  };

  let qi = 0;
  while (qi < queue.length) {
    const i = queue[qi++];
    removed.add(i);
    const pos = i / 4;
    const x = pos % width;
    const y = Math.floor(pos / width);
    const ns = [
      { nx: x, ny: y - 1 }, { nx: x, ny: y + 1 },
      { nx: x - 1, ny: y }, { nx: x + 1, ny: y },
    ];
    for (const { nx, ny } of ns) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const ni = (ny * width + nx) * 4;
      if (visited.has(ni)) continue;
      visited.add(ni);
      if (matches(ni)) queue.push(ni);
    }
  }
  return { removed, seedColor, seededOnTransparent };
}

function processClickRegionRemoval(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  tolerance: number,
  featherPx: number
): { removedCount: number; seedColor: { r: number; g: number; b: number }; seededOnTransparent: boolean } {
  const { removed, seedColor, seededOnTransparent } = floodFillFromPoint(data, width, height, seedX, seedY, tolerance);
  removed.forEach((i) => { data[i + 3] = 0; });
  featherAlphaAtBoundary(data, width, height, removed, featherPx);
  return { removedCount: removed.size, seedColor, seededOnTransparent };
}

function processSpecificColorRemoval(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  picked: { r: number; g: number; b: number },
  tolerance: number,
  featherPx: number,
  scope: 'edges' | 'global'
): { removedCount: number } {
  const removed = scope === 'global'
    ? globalRemovePickedColor(data, width, height, picked, tolerance)
    : floodFillPickedColor(data, width, height, picked, tolerance);
  removed.forEach((i) => { data[i + 3] = 0; });
  featherAlphaAtBoundary(data, width, height, removed, featherPx);
  return { removedCount: removed.size };
}

wlog('[BgRemoval] worker module initialized, listening for messages');

self.onmessage = (e: MessageEvent) => {
  wlog('[BgRemoval] received message, mode=', (e.data as any)?.mode ?? '(white-default)');
  const msg = e.data as
    | { mode?: 'white'; imageData: Uint8ClampedArray; width: number; height: number; threshold: number }
    | {
        mode: 'edge-color';
        imageData: Uint8ClampedArray;
        width: number;
        height: number;
        tolerance?: number;
        protectSaturation?: number;
        featherPx?: number;
      }
    | {
        mode: 'specific-color';
        imageData: Uint8ClampedArray;
        width: number;
        height: number;
        pickedColor: { r: number; g: number; b: number };
        tolerance?: number;
        featherPx?: number;
        scope?: 'edges' | 'global';
      }
    | {
        mode: 'click-region';
        imageData: Uint8ClampedArray;
        width: number;
        height: number;
        seedX: number;
        seedY: number;
        tolerance?: number;
        featherPx?: number;
      };

  try {
    if (msg.mode === 'click-region') {
      const tolerance = msg.tolerance ?? 40;
      const featherPx = Math.max(0, Math.min(2, msg.featherPx ?? 1));
      const { removedCount, seedColor, seededOnTransparent } = processClickRegionRemoval(
        msg.imageData, msg.width, msg.height,
        msg.seedX, msg.seedY, tolerance, featherPx
      );
      (self as unknown as Worker).postMessage(
        {
          type: 'result',
          imageData: msg.imageData,
          width: msg.width,
          height: msg.height,
          mode: 'click-region',
          stats: { removedPixels: removedCount, seedColor, seededOnTransparent },
        },
        [msg.imageData.buffer] as any
      );
      return;
    }

    if (msg.mode === 'specific-color') {
      const tolerance = msg.tolerance ?? 40;
      const featherPx = Math.max(0, Math.min(2, msg.featherPx ?? 1));
      const scope: 'edges' | 'global' = msg.scope ?? 'edges';
      const { removedCount } = processSpecificColorRemoval(
        msg.imageData, msg.width, msg.height,
        msg.pickedColor, tolerance, featherPx, scope
      );
      (self as unknown as Worker).postMessage(
        {
          type: 'result',
          imageData: msg.imageData,
          width: msg.width,
          height: msg.height,
          mode: 'specific-color',
          stats: { removedPixels: removedCount, pickedColor: msg.pickedColor, scope },
        },
        [msg.imageData.buffer] as any
      );
      return;
    }

    if (msg.mode === 'edge-color') {
      const tolerance = msg.tolerance ?? 50;
      const protectSaturation = msg.protectSaturation ?? 60;
      const featherPx = Math.max(0, Math.min(2, msg.featherPx ?? 1));
      const { bg, removedCount } = processEdgeColorRemoval(
        msg.imageData, msg.width, msg.height,
        tolerance, protectSaturation, featherPx
      );
      (self as unknown as Worker).postMessage(
        {
          type: 'result',
          imageData: msg.imageData,
          width: msg.width,
          height: msg.height,
          mode: 'edge-color',
          stats: {
            sampledBg: { r: Math.round(bg.r), g: Math.round(bg.g), b: Math.round(bg.b) },
            borderStdev: Number(bg.stdev.toFixed(1)),
            removedPixels: removedCount,
          },
        },
        [msg.imageData.buffer] as any
      );
      return;
    }

    // Default: legacy white-flood-fill mode
    processRemoval(msg.imageData, msg.width, msg.height, msg.threshold);
    (self as unknown as Worker).postMessage(
      { type: 'result', imageData: msg.imageData, width: msg.width, height: msg.height, mode: 'white' },
      [msg.imageData.buffer] as any
    );
  } catch (err: any) {
    (self as unknown as Worker).postMessage({ type: 'error', error: err?.message || String(err) });
  }
};
