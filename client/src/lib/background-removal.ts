/**
 * Background removal using a Web Worker for zero UI lag.
 * Flood-fill from edges removes contiguous white background. White areas
 * inside the design are preserved.
 *
 * Pipeline:
 *   1. `workersHealthy()` probes whether `new Worker(...)` can actually run
 *      in the current environment. Real browsers say yes in <10 ms; the
 *      Cursor IDE Electron preview times out at 1500 ms because its
 *      BrowserView swallows worker messages.
 *   2. If healthy, the white-mode/edge-color/specific-color/click-region
 *      jobs all run on the bg-removal-worker so the UI never blocks.
 *   3. If broken, the white-mode flood-fill runs inline on the main thread
 *      (`processRemovalInline` below). The other modes still go through
 *      the worker (they fail gracefully with the same `currentReject`
 *      cancellation) — without the worker they're no-ops, but bg removal
 *      keeps working in degraded environments.
 *
 * Serialized: only one job runs at a time; new requests cancel prior ones.
 */

import BgRemovalWorker from './bg-removal-worker?worker';
import { workersHealthy } from './worker-health';
import {
  computeBgRemovalDiagnostics,
  formatBgRemovalDigest,
  removeSmallComponents,
} from './bg-removal-diagnostics';

let workerInstance: Worker | null = null;
let currentReject: ((reason: Error) => void) | null = null;

function getWorker(): Worker {
  if (!workerInstance) {
    console.log('[BgRemoval-main] creating new BgRemovalWorker instance');
    workerInstance = new BgRemovalWorker();
    workerInstance.addEventListener('message', (e: MessageEvent) => {
      if (e.data && e.data.type === 'log') {
        console.log('[BgRemoval-worker]', ...(e.data.args ?? []));
      }
    });
    workerInstance.addEventListener('error', (err: ErrorEvent) => {
      console.error('[BgRemoval-main] WORKER ERROR EVENT:', err.message, err.filename, err.lineno, err.colno);
    });
    workerInstance.addEventListener('messageerror', (err: any) => {
      console.error('[BgRemoval-main] WORKER MESSAGE ERROR:', err);
    });
  }
  return workerInstance;
}

/**
 * Inline white-flood-fill: the exact algorithm used by the worker, just on
 * the main thread. Typed-array bitmaps keep memory and time well-behaved
 * even at MAX_STORED_DIMENSION (≤4000 px / longest side).
 */
function processRemovalInline(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number,
): void {
  const thresholdValue = (threshold / 100) * 255;
  const pixelCount = width * height;

  const visited = new Uint8Array(pixelCount);
  const removed = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let qHead = 0;
  let qTail = 0;

  const enqueueIfWhite = (pos: number) => {
    if (visited[pos]) return;
    visited[pos] = 1;
    const idx = pos * 4;
    const a = data[idx + 3];
    if (a < 128) { queue[qTail++] = pos; return; }
    const minChannel = Math.min(data[idx], data[idx + 1], data[idx + 2]);
    if (minChannel >= thresholdValue) queue[qTail++] = pos;
  };

  for (let x = 0; x < width; x++) {
    enqueueIfWhite(x);
    enqueueIfWhite((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    enqueueIfWhite(y * width);
    enqueueIfWhite(y * width + width - 1);
  }

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

  // Sample the average colour of the removed (background) pixels BEFORE we
  // zero their alpha. The flood-fill above only writes to the alpha channel
  // — RGB is still intact — so this gives us the actual background colour
  // (which on a low-quality JPEG is rarely a perfect 255/255/255).
  // We use it below to make the halo cleanup adaptive: pixels that are
  // colour-similar to the removed background also get cleaned, regardless
  // of whether they happen to be near pure white.
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

  let floodFillRemoved = 0;
  for (let pos = 0; pos < pixelCount; pos++) {
    if (removed[pos]) {
      data[pos * 4 + 3] = 0;
      floodFillRemoved++;
    }
  }

  // Halo cleanup (off-white / tinted ring around removed regions).
  //
  // BFS only advances through pixels that already pass the gate, so a deep
  // cap can't bleed into coloured design pixels — they stop the BFS at the
  // silhouette edge.
  //
  // Three accept paths through the gate, any one is enough:
  //   • near pure white  (minCh >= 200)
  //   • already partial alpha  (a < 180) — anti-aliased PNG edges
  //   • close to the sampled background colour  (squared RGB distance
  //     <= bgColorToleranceSq) — this is the new path that catches
  //     low-res JPEG halos like rgb(210,195,180) that aren't near-white
  //     in any single channel but are clearly the same kind of pixel as
  //     the bulk background we already removed.
  //
  // The colour-distance tolerance is intentionally moderate (≈ 60 in
  // RGB) so that genuine design colours (reds, blacks, saturated yellows)
  // remain comfortably outside it and stop the BFS at the artwork edge.
  const maxCleanupDepth = 60;
  const alphaCleanupThreshold = 180;
  const whiteCleanupThreshold = 200;
  const bgColorToleranceSq = 60 * 60;
  const cleanupVisited = new Uint8Array(pixelCount);
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

  // Small-component cleanup — strips JPEG-noise specks at the canvas
  // edges that survive the bulk + halo passes. See bg-removal-worker.ts
  // for the full rationale; mirror values here.
  const smallComponentRemoved = removeSmallComponents(
    data, removed, width, height, 50, 0.001,
  );

  const diag = computeBgRemovalDiagnostics(
    data, removed, width, height, bgR, bgG, bgB,
    floodFillRemoved, haloCleanRemoved, smallComponentRemoved,
  );
  console.log('[BG-DIAG]', diag);
  console.log('[BG-DIAG-DIGEST]', formatBgRemovalDigest(diag));
}

export async function removeBackgroundFromImage(
  image: HTMLImageElement,
  threshold: number = 95,
): Promise<HTMLImageElement> {
  if (currentReject) {
    currentReject(new Error('Cancelled: new background removal request'));
    currentReject = null;
  }

  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to get canvas context');
  ctx.drawImage(image, 0, 0);

  const imageData = ctx.getImageData(0, 0, width, height);
  const healthy = await workersHealthy();
  const t0 = performance.now();

  if (healthy) {
    // Worker path — UI stays responsive even on multi-MP inputs.
    const buffer = new Uint8ClampedArray(imageData.data);
    return new Promise<HTMLImageElement>((resolve, reject) => {
      currentReject = reject;
      const worker = getWorker();
      const cleanup = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        if (currentReject === reject) currentReject = null;
      };
      const onMessage = (e: MessageEvent) => {
        if (e.data && e.data.type === 'log') return;
        cleanup();
        if (e.data?.type === 'error') return reject(new Error(e.data.error));
        const resultData = new ImageData(new Uint8ClampedArray(e.data.imageData), e.data.width, e.data.height);
        ctx.putImageData(resultData, 0, 0);
        const img = new Image();
        img.onload = () => {
          console.log('[BgRemoval-main] worker path done in', (performance.now() - t0).toFixed(1), 'ms');
          resolve(img);
        };
        img.onerror = () => reject(new Error('Failed to decode bg-removed PNG'));
        img.src = canvas.toDataURL('image/png');
      };
      const onError = (err: ErrorEvent) => {
        cleanup();
        reject(new Error(err.message || 'Worker error'));
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage(
        { imageData: buffer, width, height, threshold },
        [buffer.buffer],
      );
    });
  }

  // Main-thread fallback for environments where workers are inert (Cursor
  // IDE preview etc.). Same algorithm, just synchronous.
  processRemovalInline(imageData.data, width, height, threshold);
  ctx.putImageData(imageData, 0, 0);
  console.log('[BgRemoval-main] inline path done in', (performance.now() - t0).toFixed(1), 'ms');

  return new Promise<HTMLImageElement>((resolve, reject) => {
    currentReject = reject;
    const img = new Image();
    img.onload = () => {
      if (currentReject === reject) currentReject = null;
      resolve(img);
    };
    img.onerror = () => {
      if (currentReject === reject) currentReject = null;
      reject(new Error('Failed to decode bg-removed PNG'));
    };
    img.src = canvas.toDataURL('image/png');
  });
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
  return `#${h(r)}${h(g)}${h(b)}`;
}

export interface ClickRegionOptions {
  /** Max RGB-distance from the clicked pixel's colour to count as part of the region. Default 40. */
  tolerance?: number;
  /** Soft alpha feather at the cut boundary, 0–2 px. Default 1. */
  featherPx?: number;
}

export interface ClickRegionResult {
  image: HTMLImageElement;
  removedPixels: number;
  /** RGB sampled from the clicked pixel. */
  seedColor: { r: number; g: number; b: number };
  /** Hex form of `seedColor`, suitable for fill / bleed palettes. */
  seedColorHex: string;
  /** True if the click landed on an already-transparent pixel (no-op case). */
  seededOnTransparent: boolean;
}

/**
 * Magic-wand: flood-fill the connected region containing the clicked pixel.
 * Uses image-pixel coordinates (not canvas/screen coords). Removes only the
 * connected region — perfect for cleaning up an interior shape (e.g. the "8"
 * inside an 8-ball) without affecting other pixels of the same colour
 * elsewhere in the design.
 */
export async function removeColorAtPoint(
  image: HTMLImageElement,
  imageX: number,
  imageY: number,
  options: ClickRegionOptions = {}
): Promise<ClickRegionResult> {
  if (currentReject) {
    currentReject(new Error('Cancelled: new background removal request'));
    currentReject = null;
  }

  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const seedX = Math.max(0, Math.min(width - 1, Math.floor(imageX)));
  const seedY = Math.max(0, Math.min(height - 1, Math.floor(imageY)));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to get canvas context');
  ctx.drawImage(image, 0, 0);

  const imageData = ctx.getImageData(0, 0, width, height);
  const buffer = new Uint8ClampedArray(imageData.data);

  return new Promise<ClickRegionResult>((resolve, reject) => {
    currentReject = reject;
    const worker = getWorker();

    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      if (currentReject === reject) currentReject = null;
    };

    const onMessage = (e: MessageEvent) => {
      if (e.data && e.data.type === 'log') return; // worker init/debug logs — not our result
      cleanup();
      if (e.data?.type === 'error') return reject(new Error(e.data.error));

      const resultData = new ImageData(
        new Uint8ClampedArray(e.data.imageData),
        e.data.width,
        e.data.height
      );
      ctx.putImageData(resultData, 0, 0);

      const seedColor = e.data.stats?.seedColor ?? { r: 0, g: 0, b: 0 };
      const seededOnTransparent = !!e.data.stats?.seededOnTransparent;
      const removedPixels = e.data.stats?.removedPixels ?? 0;
      const seedColorHex = rgbToHex(seedColor.r, seedColor.g, seedColor.b);

      const img = new Image();
      img.onload = () => resolve({
        image: img,
        removedPixels,
        seedColor,
        seedColorHex,
        seededOnTransparent,
      });
      img.onerror = () => reject(new Error('Failed to decode region-removed PNG'));
      img.src = canvas.toDataURL('image/png');
    };

    const onError = (err: ErrorEvent) => {
      cleanup();
      reject(new Error(err.message));
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage(
      {
        mode: 'click-region',
        imageData: buffer,
        width,
        height,
        seedX,
        seedY,
        tolerance: options.tolerance ?? 40,
        featherPx: options.featherPx ?? 1,
      },
      [buffer.buffer]
    );
  });
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Invalid hex color: ${hex}`);
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

export interface SpecificColorOptions {
  /** Max RGB-distance from the picked colour to count as bg. Default 40. */
  tolerance?: number;
  /** Soft alpha feather at the cut boundary, 0–2 px. Default 1. */
  featherPx?: number;
  /**
   * `'edges'` (default): flood-fill from the image borders — preserves
   * enclosed pixels of the same colour (logo internals, QR codes, text).
   * `'global'`: clear every matching pixel anywhere in the image — use only
   * when the user explicitly opts in (e.g. Shift-click) and accepts the
   * destructive behaviour.
   */
  scope?: 'edges' | 'global';
}

/**
 * Remove a user-picked colour from the design via flood-fill from the image
 * borders. Same proven algorithm as the white remover, but the predicate is
 * "matches the picked colour within `tolerance`" instead of "is white".
 *
 * Enclosed pixels of the picked colour (e.g. internal black inside a logo,
 * QR code modules, text outlines) are preserved because they're not connected
 * to the outer border.
 *
 * Returns the cleaned PNG plus the resolved RGB so callers can persist it as
 * `imageInfo.removedColor` and offer it as a fill / bleed swatch.
 */
export async function removeSpecificColorFromImage(
  image: HTMLImageElement,
  hexColor: string,
  options: SpecificColorOptions = {}
): Promise<{ image: HTMLImageElement; removedPixels: number; pickedColor: { r: number; g: number; b: number } }> {
  if (currentReject) {
    currentReject(new Error('Cancelled: new background removal request'));
    currentReject = null;
  }

  const picked = hexToRgb(hexColor);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to get canvas context');
  ctx.drawImage(image, 0, 0);

  const imageData = ctx.getImageData(0, 0, width, height);
  const buffer = new Uint8ClampedArray(imageData.data);

  return new Promise((resolve, reject) => {
    currentReject = reject;
    const worker = getWorker();

    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      if (currentReject === reject) currentReject = null;
    };

    const onMessage = (e: MessageEvent) => {
      if (e.data && e.data.type === 'log') return;
      cleanup();
      if (e.data?.type === 'error') return reject(new Error(e.data.error));

      const resultData = new ImageData(
        new Uint8ClampedArray(e.data.imageData),
        e.data.width,
        e.data.height
      );
      ctx.putImageData(resultData, 0, 0);

      const img = new Image();
      img.onload = () => resolve({
        image: img,
        removedPixels: e.data.stats?.removedPixels ?? 0,
        pickedColor: e.data.stats?.pickedColor ?? picked,
      });
      img.onerror = () => reject(new Error('Failed to decode color-removed PNG'));
      img.src = canvas.toDataURL('image/png');
    };

    const onError = (err: ErrorEvent) => {
      cleanup();
      reject(new Error(err.message));
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage(
      {
        mode: 'specific-color',
        imageData: buffer,
        width,
        height,
        pickedColor: picked,
        tolerance: options.tolerance ?? 40,
        featherPx: options.featherPx ?? 1,
        scope: options.scope ?? 'edges',
      },
      [buffer.buffer]
    );
  });
}

export interface EdgeBackgroundOptions {
  /** Max RGB-distance from the auto-sampled border colour to count as bg. Default 50. */
  tolerance?: number;
  /** Pixels with HSV-saturation above this never get removed (protects red splashes, lime, etc). Default 60. */
  protectSaturation?: number;
  /** Soft-feather the alpha at the cut boundary (0–2 px). Default 1. */
  featherPx?: number;
}

export interface EdgeBackgroundResult {
  image: HTMLImageElement;
  /** Mean colour the worker sampled from the input borders (debug / UI hint). */
  sampledBg: { r: number; g: number; b: number };
  /** Stdev of the border colour distribution — large values mean "borders are not uniform". */
  borderStdev: number;
  removedPixels: number;
}

/**
 * Edge-connected background removal — generalisation of the white flood-fill
 * for backgrounds of any colour (dark textured backdrops, gradients sampled
 * from the borders, coloured studio backdrops…).
 *
 * Use this when the design contains lots of the same colour as the background
 * (e.g. a logo with internal black on a black background) — flood-filling
 * from the borders preserves enclosed regions like QR codes, text outlines,
 * and shadows that aren't connected to the outer background.
 */
export async function removeEdgeBackgroundFromImage(
  image: HTMLImageElement,
  options: EdgeBackgroundOptions = {}
): Promise<EdgeBackgroundResult> {
  if (currentReject) {
    currentReject(new Error('Cancelled: new background removal request'));
    currentReject = null;
  }

  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to get canvas context');
  ctx.drawImage(image, 0, 0);

  const imageData = ctx.getImageData(0, 0, width, height);
  const buffer = new Uint8ClampedArray(imageData.data);

  return new Promise<EdgeBackgroundResult>((resolve, reject) => {
    currentReject = reject;
    const worker = getWorker();

    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      if (currentReject === reject) currentReject = null;
    };

    const onMessage = (e: MessageEvent) => {
      if (e.data && e.data.type === 'log') return;
      cleanup();
      if (e.data?.type === 'error') return reject(new Error(e.data.error));

      const resultData = new ImageData(
        new Uint8ClampedArray(e.data.imageData),
        e.data.width,
        e.data.height
      );
      ctx.putImageData(resultData, 0, 0);

      const img = new Image();
      img.onload = () => resolve({
        image: img,
        sampledBg: e.data.stats?.sampledBg ?? { r: 255, g: 255, b: 255 },
        borderStdev: e.data.stats?.borderStdev ?? 0,
        removedPixels: e.data.stats?.removedPixels ?? 0,
      });
      img.onerror = () => reject(new Error('Failed to decode edge bg-removed PNG'));
      img.src = canvas.toDataURL('image/png');
    };

    const onError = (err: ErrorEvent) => {
      cleanup();
      reject(new Error(err.message));
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage(
      {
        mode: 'edge-color',
        imageData: buffer,
        width,
        height,
        tolerance: options.tolerance ?? 50,
        protectSaturation: options.protectSaturation ?? 60,
        featherPx: options.featherPx ?? 1,
      },
      [buffer.buffer]
    );
  });
}

/**
 * AI-powered background removal via the server's `/api/remove-background-ai`
 * endpoint (BiRefNet on Replicate).
 *
 * Use for inputs the local flood-fill remover can't handle: photo backgrounds,
 * gradients, complex artwork, anything non-uniform. The server includes a
 * cheap fast-path that skips the ML call when the input already has alpha.
 */
export async function removeBackgroundFromImageAI(
  image: HTMLImageElement
): Promise<HTMLImageElement> {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

  // Encode to PNG via canvas (the server's multer instance only accepts PNG).
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context for AI bg removal');
  ctx.drawImage(image, 0, 0);

  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Failed to encode PNG for upload'))),
      'image/png'
    );
  });

  const formData = new FormData();
  formData.append('image', blob, 'image.png');

  const response = await fetch('/api/remove-background-ai', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    let serverMsg = `${response.status} ${response.statusText}`;
    try {
      const err = await response.json();
      if (err?.error) serverMsg = err.error + (err.details ? `: ${err.details}` : '');
    } catch {
      // body wasn't JSON; keep the status text
    }
    throw new Error(`AI background removal failed (${serverMsg})`);
  }

  const resultBlob = await response.blob();
  const url = URL.createObjectURL(resultBlob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to decode AI bg-removed PNG'));
      img.src = url;
    });
  } finally {
    // Image already loaded (or failed); free the blob URL on the next tick to
    // be safe — the decoded HTMLImageElement keeps its own pixel data.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function cropImageToContentCanvas(image: HTMLImageElement): HTMLCanvasElement | null {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0);

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return null;

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = cropW;
  cropCanvas.height = cropH;
  const cropCtx = cropCanvas.getContext('2d');
  if (!cropCtx) return null;
  cropCtx.drawImage(canvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
  return cropCanvas;
}
