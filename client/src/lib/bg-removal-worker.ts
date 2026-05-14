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

// ── Typed-array BFS helpers ──────────────────────────────────────────────
//
// All flood-fill functions below were rewritten to use pre-allocated
// Uint8Array bitmaps (visited / removed) and Int32Array queues instead of
// JS Set<number> and number[] growable arrays.
//
// JS Set for pixel bookkeeping on a 2000×2000 image = up to 4M hash-map
// entries → 100s of MB of allocator pressure and GC pauses that dominate
// total wall time.  Uint8Array with one byte per pixel = 4 MB flat slab,
// zero allocator pressure, cache-friendly sequential scan.  Benchmark
// improvement for the magic-wand click-region path: 10–50× on large inputs.
//
// Math.sqrt in per-pixel distance comparisons is also replaced with
// squared-distance comparisons throughout.

function floodFillEdgeBg(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  bg: BgColor,
  tolerance: number,
  protectSaturation: number
): Uint8Array {
  const pixelCount = width * height;
  const removed  = new Uint8Array(pixelCount);
  const visited  = new Uint8Array(pixelCount);
  const queue    = new Int32Array(pixelCount);
  let qHead = 0, qTail = 0;

  const toleranceSq = tolerance * tolerance;

  // Inlined isEdgeBgPixel — avoids per-pixel function-call + Math.sqrt overhead.
  const tryAdd = (pos: number) => {
    if (visited[pos]) return;
    visited[pos] = 1;
    const idx = pos * 4;
    const a = data[idx + 3];
    if (a < 128) { queue[qTail++] = pos; return; }  // already transparent → propagate
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    // Saturation guard: skip highly-saturated pixels (protects design splashes).
    const maxCh = Math.max(r, g, b);
    if (maxCh > 0 && ((maxCh - Math.min(r, g, b)) / maxCh) * 255 > protectSaturation) return;
    // Squared euclidean distance from sampled background colour.
    const dr = r - bg.r, dg = g - bg.g, db = b - bg.b;
    if (dr * dr + dg * dg + db * db <= toleranceSq) queue[qTail++] = pos;
  };

  for (let x = 0; x < width; x++) { tryAdd(x); tryAdd((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y++) { tryAdd(y * width); tryAdd(y * width + width - 1); }

  while (qHead < qTail) {
    const pos = queue[qHead++];
    if (data[pos * 4 + 3] >= 128) removed[pos] = 1;
    const x = pos % width;
    const y = (pos - x) / width;
    if (y > 0)            tryAdd(pos - width);
    if (y < height - 1)   tryAdd(pos + width);
    if (x > 0)            tryAdd(pos - 1);
    if (x < width - 1)    tryAdd(pos + 1);
  }
  return removed;
}

/**
 * Soft 3×3 box blur of the alpha channel for pixels neighbouring removed
 * regions. `featherPx=1` blurs once, `featherPx=2` twice. Run after the
 * flood fill so opaque interiors stay perfectly opaque.
 *
 * Rewritten from Set<number>+Map<number,number> → typed arrays for the
 * same 10–50× memory/GC improvement as the BFS functions above.
 * `removed` is a Uint8Array pixel-position bitmap (one byte per pixel).
 */
function featherAlphaAtBoundary(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  removed: Uint8Array,
  featherPx: number
): void {
  if (featherPx <= 0) return;

  const pixelCount = width * height;

  // Collect boundary pixels: opaque, at least one 8-neighbour is removed.
  // Upper bound on boundary size = pixelCount (rare; realistically ≪).
  const boundary = new Int32Array(pixelCount);
  let boundaryLen = 0;

  for (let pos = 0; pos < pixelCount; pos++) {
    if (removed[pos] || data[pos * 4 + 3] === 0) continue;
    const x = pos % width;
    const y = (pos - x) / width;
    let hasBorder = false;
    outer: for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        if (removed[ny * width + nx]) { hasBorder = true; break outer; }
      }
    }
    if (hasBorder) boundary[boundaryLen++] = pos;
  }

  if (boundaryLen === 0) return;

  // Each blur pass: 3×3 box-average → write back. Float32Array avoids
  // repeated integer rounding until the final write.
  const newAlphas = new Float32Array(boundaryLen);
  for (let pass = 0; pass < featherPx; pass++) {
    for (let bi = 0; bi < boundaryLen; bi++) {
      const pos = boundary[bi];
      const x = pos % width;
      const y = (pos - x) / width;
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          sum += data[(ny * width + nx) * 4 + 3];
          n++;
        }
      }
      newAlphas[bi] = sum / n;
    }
    for (let bi = 0; bi < boundaryLen; bi++) {
      data[boundary[bi] * 4 + 3] = Math.round(newAlphas[bi]);
    }
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
  // floodFillEdgeBg now returns a Uint8Array pixel-position bitmap.
  const removed = floodFillEdgeBg(data, width, height, bg, tolerance, protectSaturation);
  const pixelCount = width * height;
  let removedCount = 0;
  for (let pos = 0; pos < pixelCount; pos++) {
    if (removed[pos]) { data[pos * 4 + 3] = 0; removedCount++; }
  }
  featherAlphaAtBoundary(data, width, height, removed, featherPx);
  return { bg, removedCount };
}

// ─── Specific-color background removal (user-picked) ──────────────────────
//
// User-picked variant of the edge-connected mode: instead of auto-sampling
// the border colour, the caller passes the exact RGB they want to remove
// (typically picked via the browser EyeDropper API). The flood-fill still
// starts from the image edges so enclosed pixels of the same colour
// (e.g. internal black inside a logo, QR code modules) remain untouched —
// only the connected outer background is cleared.
//
// Rewritten from Set<number>+number[] → Uint8Array+Int32Array for the same
// 10–50× speedup applied to floodFillEdgeBg above.  Math.sqrt replaced with
// squared-distance comparison throughout.

function floodFillPickedColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  picked: { r: number; g: number; b: number },
  tolerance: number
): Uint8Array {
  const pixelCount = width * height;
  const removed  = new Uint8Array(pixelCount);
  const visited  = new Uint8Array(pixelCount);
  const queue    = new Int32Array(pixelCount);
  let qHead = 0, qTail = 0;

  const toleranceSq = tolerance * tolerance;

  const tryAdd = (pos: number) => {
    if (visited[pos]) return;
    visited[pos] = 1;
    const idx = pos * 4;
    const a = data[idx + 3];
    if (a < 128) { queue[qTail++] = pos; return; }
    const dr = data[idx] - picked.r;
    const dg = data[idx + 1] - picked.g;
    const db = data[idx + 2] - picked.b;
    if (dr * dr + dg * dg + db * db <= toleranceSq) queue[qTail++] = pos;
  };

  for (let x = 0; x < width; x++) { tryAdd(x); tryAdd((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y++) { tryAdd(y * width); tryAdd(y * width + width - 1); }

  while (qHead < qTail) {
    const pos = queue[qHead++];
    if (data[pos * 4 + 3] >= 128) removed[pos] = 1;
    const x = pos % width;
    const y = (pos - x) / width;
    if (y > 0)           tryAdd(pos - width);
    if (y < height - 1)  tryAdd(pos + width);
    if (x > 0)           tryAdd(pos - 1);
    if (x < width - 1)   tryAdd(pos + 1);
  }
  return removed;
}

/**
 * Walk every pixel and clear alpha for any opaque pixel within `tolerance`
 * of the picked colour, with no connectivity test. Use this only when the
 * user explicitly opts in (Shift+click in the editor) — it ignores the
 * "preserve enclosed details" guarantee of the flood-fill mode.
 *
 * Returns a Uint8Array pixel-position bitmap (matching the other fill fns).
 */
function globalRemovePickedColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  picked: { r: number; g: number; b: number },
  tolerance: number
): Uint8Array {
  const pixelCount = width * height;
  const removed = new Uint8Array(pixelCount);
  const toleranceSq = tolerance * tolerance;
  for (let pos = 0; pos < pixelCount; pos++) {
    const i = pos * 4;
    if (data[i + 3] < 128) continue;
    const dr = data[i] - picked.r;
    const dg = data[i + 1] - picked.g;
    const db = data[i + 2] - picked.b;
    if (dr * dr + dg * dg + db * db <= toleranceSq) removed[pos] = 1;
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
//
// Rewritten from Set<number>+number[] → Uint8Array+Int32Array (same
// approach as processRemoval).  Math.sqrt replaced with squared-distance
// comparison.  Expected speedup: 10–50× on large images.

function floodFillFromPoint(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  tolerance: number
): { removed: Uint8Array; removedCount: number; seedColor: { r: number; g: number; b: number }; seededOnTransparent: boolean } {
  const pixelCount = width * height;
  const seedPos = seedY * width + seedX;
  const seedIdx = seedPos * 4;
  const seedColor = { r: data[seedIdx], g: data[seedIdx + 1], b: data[seedIdx + 2] };
  const seededOnTransparent = data[seedIdx + 3] < 128;

  const removed = new Uint8Array(pixelCount);
  if (seededOnTransparent) return { removed, removedCount: 0, seedColor, seededOnTransparent };

  const visited  = new Uint8Array(pixelCount);
  const queue    = new Int32Array(pixelCount);
  let qHead = 0, qTail = 0;
  const toleranceSq = tolerance * tolerance;

  visited[seedPos] = 1;
  queue[qTail++] = seedPos;
  let removedCount = 0;

  while (qHead < qTail) {
    const pos = queue[qHead++];
    removed[pos] = 1;
    removedCount++;

    const x = pos % width;
    const y = (pos - x) / width;

    const tryNeighbor = (npos: number) => {
      if (visited[npos]) return;
      visited[npos] = 1;
      const ni = npos * 4;
      if (data[ni + 3] < 128) return;  // transparent → don't expand through it
      const dr = data[ni] - seedColor.r;
      const dg = data[ni + 1] - seedColor.g;
      const db = data[ni + 2] - seedColor.b;
      if (dr * dr + dg * dg + db * db <= toleranceSq) queue[qTail++] = npos;
    };

    if (y > 0)           tryNeighbor(pos - width);
    if (y < height - 1)  tryNeighbor(pos + width);
    if (x > 0)           tryNeighbor(pos - 1);
    if (x < width - 1)   tryNeighbor(pos + 1);
  }
  return { removed, removedCount, seedColor, seededOnTransparent };
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
  const { removed, removedCount, seedColor, seededOnTransparent } = floodFillFromPoint(
    data, width, height, seedX, seedY, tolerance
  );
  // Apply alpha=0 to every removed pixel (bitmap scan — no Set iteration).
  const pixelCount = width * height;
  for (let pos = 0; pos < pixelCount; pos++) {
    if (removed[pos]) data[pos * 4 + 3] = 0;
  }
  featherAlphaAtBoundary(data, width, height, removed, featherPx);
  return { removedCount, seedColor, seededOnTransparent };
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
  const pixelCount = width * height;
  let removedCount = 0;
  for (let pos = 0; pos < pixelCount; pos++) {
    if (removed[pos]) { data[pos * 4 + 3] = 0; removedCount++; }
  }
  featherAlphaAtBoundary(data, width, height, removed, featherPx);
  return { removedCount };
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
