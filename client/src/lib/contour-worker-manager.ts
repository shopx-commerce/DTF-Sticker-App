import ContourWorker from './contour-worker?worker';
import { workersHealthy } from './worker-health';
import { offloadHealthy } from './offload-health';
import { traceContourViaOffload } from './offload-client';

const MAX_PROCESSING_DIMENSION = 4000;

// Tighter cap for the main-thread fallback. The silhouette-mask /
// gap-bridge / morphology pipeline in `createSilhouetteContour` is O(W*H)
// and runs synchronously, so anything above ~1500 px on the longest side
// freezes the UI for many seconds (or minutes for 3000–4000 px inputs).
// For a preview cutpath, 1500 px is more than enough fidelity to trace
// the silhouette accurately.
const MAX_FALLBACK_DIMENSION = 1500;

function downsampleImage(image: HTMLImageElement): { canvas: HTMLCanvasElement; scale: number } {
  const maxDim = Math.max(image.width, image.height);
  
  if (maxDim <= MAX_PROCESSING_DIMENSION) {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    return { canvas, scale: 1 };
  }
  
  const scale = MAX_PROCESSING_DIMENSION / maxDim;
  const newWidth = Math.round(image.width * scale);
  const newHeight = Math.round(image.height * scale);
  
  console.log(`[ContourWorker] Downsampling from ${image.width}x${image.height} to ${newWidth}x${newHeight} (scale: ${scale.toFixed(3)})`);
  
  const canvas = document.createElement('canvas');
  canvas.width = newWidth;
  canvas.height = newHeight;
  const ctx = canvas.getContext('2d')!;
  
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, newWidth, newHeight);
  
  return { canvas, scale };
}

export type DetectedAlgorithm = 'complex' | 'scattered';
export type ContourMode = 'smooth' | 'scattered';

// ─── Bezier-curve cut-path representation (Zero Hero only) ──────────────────
// Mirrors the shape declared inside the worker. Kept here because the
// download/PDF emit path lives in the main thread and consumes this data via
// `getCachedContourData()`.

export interface BezierLineSegment {
  type: 'line';
  to: { x: number; y: number };
}

export interface BezierCubicSegment {
  type: 'cubic';
  cp1: { x: number; y: number };
  cp2: { x: number; y: number };
  to: { x: number; y: number };
}

export type BezierSegment = BezierLineSegment | BezierCubicSegment;

export interface BezierPath {
  start: { x: number; y: number };
  segments: BezierSegment[];
  closed: true;
}

export interface ContourData {
  pathPoints: Array<{x: number; y: number}>;
  previewPathPoints: Array<{x: number; y: number}>;
  allPathPoints?: Array<Array<{x: number; y: number}>>;
  allPreviewPathPoints?: Array<Array<{x: number; y: number}>>;
  // Smooth-curve cut-path representation. When present (Zero Hero mode), the
  // PDF emitter prefers these over the polyline `allPathPoints` so curves
  // are rendered as cubic Beziers instead of polygonal chords.
  allBezierPaths?: BezierPath[];
  allBezierPathsPreview?: BezierPath[];
  widthInches: number;
  heightInches: number;
  imageOffsetX: number;
  imageOffsetY: number;
  backgroundColor: string;
  useEdgeBleed: boolean;
  effectiveDPI: number;
  minPathX: number;
  minPathY: number;
  bleedInches: number;
  holePathStartIndex?: number;
}

interface WorkerResponse {
  type: 'result' | 'error' | 'progress';
  imageData?: ImageData;
  imageCanvasX?: number;
  imageCanvasY?: number;
  error?: string;
  progress?: number;
  contourData?: ContourData;
  detectedAlgorithm?: DetectedAlgorithm;
}

interface WorkerResult {
  imageData: ImageData;
  imageCanvasX?: number;
  imageCanvasY?: number;
  contourData?: ContourData;
  detectedAlgorithm?: DetectedAlgorithm;
}

interface ResizeSettings {
  widthInches: number;
  heightInches: number;
  maintainAspectRatio: boolean;
  outputDPI: number;
}

export type DetectedShapeType = 'circle' | 'oval' | 'square' | 'rectangle' | null;

export interface DetectedShapeInfo {
  type: 'circle' | 'oval' | 'square' | 'rectangle';
  boundingBox: { x: number; y: number; width: number; height: number };
}

interface ProcessRequest {
  imageData: ImageData;
  strokeSettings: {
    width: number;
    color: string;
    enabled: boolean;
    alphaThreshold: number;
    backgroundColor: string;
    useCustomBackground: boolean;
    autoBridging: boolean;
    autoBridgingThreshold: number;
    contourMode?: ContourMode;
  };
  effectiveDPI: number;
  resizeSettings: ResizeSettings;
  previewMode?: boolean;
  detectedShapeType?: DetectedShapeType;
  detectedShapeInfo?: DetectedShapeInfo | null;
}

type ProgressCallback = (progress: number) => void;

class ContourWorkerManager {
  private worker: Worker | null = null;
  private isProcessing = false;
  private pendingRequest: {
    request: ProcessRequest;
    resolve: (result: WorkerResult) => void;
    reject: (error: Error) => void;
    onProgress?: ProgressCallback;
  } | null = null;
  private currentRequest: {
    resolve: (result: WorkerResult) => void;
    reject: (error: Error) => void;
    onProgress?: ProgressCallback;
  } | null = null;
  
  private cachedContourData: ContourData | null = null;
  private lastProcessKey: string | null = null;
  private lastProcessResult: { canvas: HTMLCanvasElement; downsampleScale: number; imageCanvasX: number; imageCanvasY: number; contourData?: ContourData; detectedAlgorithm?: DetectedAlgorithm } | null = null;

  // Resolves once the health probe finishes. While pending, `process()`
  // routes through the fallback so we never block on a worker that may be
  // dead. After it resolves we either kept `worker !== null` (real
  // browser) or set it to null (Cursor preview / similar).
  private workerHealthReady: Promise<void>;

  constructor() {
    this.workerHealthReady = this.initWorker();
  }
  
  getCachedContourData(): ContourData | null {
    return this.cachedContourData;
  }
  
  clearCache() {
    this.cachedContourData = null;
    this.lastProcessKey = null;
    this.lastProcessResult = null;
  }

  /**
   * Reject anything in flight or queued without tearing the worker down.
   * Cheap counterpart to `recreateWorker()` — call when the design has
   * been swapped/removed and the previous trace is no longer relevant.
   * The worker may still be computing the old image, but its eventual
   * `result` message will hit `handleMessage` with `currentRequest === null`
   * and be ignored.
   */
  cancelInFlight(reason: string = 'Cancelled by caller') {
    if (this.currentRequest) {
      this.currentRequest.reject(new Error(reason));
      this.currentRequest = null;
    }
    if (this.pendingRequest) {
      this.pendingRequest.reject(new Error(reason));
      this.pendingRequest = null;
    }
    this.isProcessing = false;
  }

  private async initWorker(): Promise<void> {
    // Probe whether `new Worker(...)` is actually functional in this
    // environment before instantiating the contour worker. Embedded
    // browsers (notably Cursor IDE's Electron preview) silently swallow
    // postMessage in workers, which previously caused the contour pipeline
    // to hang forever. In real browsers the probe resolves in single-digit
    // ms and we get the full off-thread benefit.
    const healthy = await workersHealthy();
    if (!healthy) {
      console.warn('[ContourWorker] worker probe failed — staying on main-thread fallback');
      this.worker = null;
      return;
    }
    try {
      this.worker = new ContourWorker();
      this.worker.onmessage = this.handleMessage.bind(this);
      this.worker.onerror = this.handleError.bind(this);
      console.log('[ContourWorker] worker thread active');
    } catch (error) {
      console.warn('[ContourWorker] construct threw — falling back to main thread:', error);
      this.worker = null;
    }
  }

  recreateWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.currentRequest) {
      this.currentRequest.reject(new Error('Worker recreated due to code update'));
    }
    if (this.pendingRequest) {
      this.pendingRequest.reject(new Error('Worker recreated due to code update'));
    }
    this.isProcessing = false;
    this.pendingRequest = null;
    this.currentRequest = null;
    // Critical: invalidate the manager-level result cache too. Otherwise the
    // next process() call would short-circuit and return the previous
    // worker's result (computed with the old code), defeating the HMR update.
    this.clearCache();
    this.workerHealthReady = this.initWorker();
    console.log('[ContourWorker] Worker recreated for code update (cache cleared)');
  }

  private handleMessage(e: MessageEvent<WorkerResponse>) {
    const { type, imageData, imageCanvasX, imageCanvasY, error, progress, contourData, detectedAlgorithm } = e.data;

    if (type === 'progress' && this.currentRequest?.onProgress && progress !== undefined) {
      this.currentRequest.onProgress(progress);
      return;
    }

    if (type === 'result' && imageData && this.currentRequest) {
      if (contourData) {
        this.cachedContourData = contourData;
      }
      this.currentRequest.resolve({ imageData, imageCanvasX, imageCanvasY, contourData, detectedAlgorithm });
      this.finishProcessing();
    } else if (type === 'error' && this.currentRequest) {
      this.currentRequest.reject(new Error(error || 'Unknown worker error'));
      this.finishProcessing();
    }
  }

  private handleError(error: ErrorEvent) {
    console.error('Worker error:', error);
    if (this.currentRequest) {
      this.currentRequest.reject(new Error('Worker crashed'));
      this.finishProcessing();
    }
    this.initWorker();
  }

  private finishProcessing() {
    this.currentRequest = null;
    this.isProcessing = false;

    if (this.pendingRequest) {
      const { request, resolve, reject, onProgress } = this.pendingRequest;
      this.pendingRequest = null;
      this.processInWorker(request, onProgress).then(resolve).catch(reject);
    }
  }

  async process(
    image: HTMLImageElement,
    strokeSettings: {
      width: number;
      color: string;
      enabled: boolean;
      alphaThreshold: number;
      backgroundColor: string;
      useCustomBackground: boolean;
      autoBridging: boolean;
      autoBridgingThreshold: number;
      contourMode?: ContourMode;
      cornerMode?: string;
    },
    resizeSettings: ResizeSettings,
    onProgress?: ProgressCallback,
    detectedShapeType?: DetectedShapeType,
    detectedShapeInfo?: DetectedShapeInfo | null
  ): Promise<{ canvas: HTMLCanvasElement; downsampleScale: number; imageCanvasX: number; imageCanvasY: number; contourData?: ContourData; detectedAlgorithm?: DetectedAlgorithm }> {
    const processKey = `${image.src}|${image.width}x${image.height}|${strokeSettings.width}|${strokeSettings.enabled}|${strokeSettings.alphaThreshold}|${strokeSettings.backgroundColor}|${strokeSettings.autoBridging}|${strokeSettings.autoBridgingThreshold}|${strokeSettings.contourMode}|${strokeSettings.cornerMode}|${resizeSettings.widthInches}|${resizeSettings.heightInches}|${detectedShapeType}|${(strokeSettings as any).includeHoles}`;
    if (this.lastProcessKey === processKey && this.lastProcessResult) {
      return this.lastProcessResult;
    }

    // Wait for the worker-health probe to settle so the first call after
    // page load doesn't race-fall-back to the main thread before the
    // worker has even had a chance to be constructed.
    await this.workerHealthReady;

    if (!this.worker) {
      const canvas = await this.processFallback(image, strokeSettings, resizeSettings, onProgress);
      const fallbackResult = { canvas, downsampleScale: 1, imageCanvasX: 0, imageCanvasY: 0 };
      this.lastProcessKey = processKey;
      this.lastProcessResult = fallbackResult;
      return fallbackResult;
    }

    const { canvas, scale } = downsampleImage(image);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    const clonedData = new ImageData(
      new Uint8ClampedArray(imageData.data),
      imageData.width,
      imageData.height
    );

    const dpiFromWidth = canvas.width / resizeSettings.widthInches;
    const dpiFromHeight = canvas.height / resizeSettings.heightInches;
    const effectiveDPI = Math.min(dpiFromWidth, dpiFromHeight);
    
    const scaledShapeInfo = detectedShapeInfo && scale !== 1 ? {
      type: detectedShapeInfo.type,
      boundingBox: {
        x: Math.round(detectedShapeInfo.boundingBox.x * scale),
        y: Math.round(detectedShapeInfo.boundingBox.y * scale),
        width: Math.round(detectedShapeInfo.boundingBox.width * scale),
        height: Math.round(detectedShapeInfo.boundingBox.height * scale),
      }
    } : detectedShapeInfo;
    
    const request: ProcessRequest = {
      imageData: clonedData,
      strokeSettings,
      effectiveDPI: effectiveDPI,
      resizeSettings: { ...resizeSettings, outputDPI: effectiveDPI },
      previewMode: true,
      detectedShapeType,
      detectedShapeInfo: scaledShapeInfo
    };

    const result = await this.processWithOffloadFallback(request, onProgress);

    const resultCanvas = document.createElement('canvas');
    resultCanvas.width = result.imageData.width;
    resultCanvas.height = result.imageData.height;
    const resultCtx = resultCanvas.getContext('2d');
    if (!resultCtx) throw new Error('Could not get result canvas context');

    resultCtx.putImageData(result.imageData, 0, 0);

    const processResult = {
      canvas: resultCanvas,
      downsampleScale: scale,
      imageCanvasX: result.imageCanvasX ?? 0,
      imageCanvasY: result.imageCanvasY ?? 0,
      contourData: result.contourData,
      detectedAlgorithm: result.detectedAlgorithm
    };
    this.lastProcessKey = processKey;
    this.lastProcessResult = processResult;
    return processResult;
  }

  // VPS tier, above the existing worker/main-thread ladder — falls straight through to the worker on any offload failure, so a flaky/unconfigured VPS never blocks tracing.
  private async processWithOffloadFallback(request: ProcessRequest, onProgress?: ProgressCallback): Promise<WorkerResult> {
    if (await offloadHealthy()) {
      try {
        const result = await traceContourViaOffload(request);
        // Mirror handleWorkerMessage's cache write (line ~267) — getCachedContourData() is read
        // later by the download/gang-sheet paths, independently of this call's own return value.
        // Without this, a trace that ran via offload leaves that cache stale or null, and a
        // download can silently embed the wrong (or no) cut path.
        if (result.contourData) {
          this.cachedContourData = result.contourData;
        }
        return result;
      } catch (err) {
        console.warn('[ContourWorkerManager] offload failed, falling back to worker:', err);
      }
    }
    return this.processInWorker(request, onProgress);
  }

  private processInWorker(request: ProcessRequest, onProgress?: ProgressCallback): Promise<WorkerResult> {
    return new Promise((resolve, reject) => {
      if (this.isProcessing) {
        this.pendingRequest = { request, resolve, reject, onProgress };
        return;
      }

      this.isProcessing = true;
      this.currentRequest = { resolve, reject, onProgress };

      this.worker!.postMessage({
        type: 'process',
        imageData: request.imageData,
        strokeSettings: request.strokeSettings,
        effectiveDPI: request.effectiveDPI,
        previewMode: request.previewMode ?? true,
        detectedShapeType: request.detectedShapeType || null,
        detectedShapeBBox: request.detectedShapeInfo?.boundingBox || null
      }, [request.imageData.data.buffer]);
    });
  }

  private async processFallback(
    image: HTMLImageElement,
    strokeSettings: {
      width: number;
      color: string;
      enabled: boolean;
      alphaThreshold: number;
      backgroundColor: string;
      useCustomBackground: boolean;
      autoBridging: boolean;
      autoBridgingThreshold: number;
      contourMode?: ContourMode;
    },
    resizeSettings: ResizeSettings,
    onProgress?: ProgressCallback,
  ): Promise<HTMLCanvasElement> {
    let processImage = image;
    const maxDim = Math.max(image.width, image.height);

    // Main-thread fallback ⇒ much tighter cap than the worker path. The
    // silhouette pipeline is O(W*H) and synchronous; without this, a
    // 3000–4000 px design freezes the UI for minutes.
    if (maxDim > MAX_FALLBACK_DIMENSION) {
      const scale = MAX_FALLBACK_DIMENSION / maxDim;
      const newWidth = Math.round(image.width * scale);
      const newHeight = Math.round(image.height * scale);

      console.log(`[ContourFallback] Downsampling from ${image.width}x${image.height} to ${newWidth}x${newHeight} (scale=${scale.toFixed(3)})`);

      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = newWidth;
      tempCanvas.height = newHeight;
      const tempCtx = tempCanvas.getContext('2d')!;
      tempCtx.imageSmoothingEnabled = true;
      tempCtx.imageSmoothingQuality = 'high';
      tempCtx.drawImage(image, 0, 0, newWidth, newHeight);

      processImage = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to decode downsampled fallback image'));
        img.src = tempCanvas.toDataURL('image/png');
      });
    }

    onProgress?.(0.05);
    // Yield once so React can paint the "Processing... 0%" state and any
    // recent state updates before we hog the main thread inside the
    // synchronous trace.
    await new Promise<void>((r) => setTimeout(r, 0));

    const { createSilhouetteContour } = await import('./contour-outline');
    const fullStrokeSettings = { ...strokeSettings, cornerMode: 'rounded' as const };
    onProgress?.(0.15);
    const t0 = performance.now();
    const result = createSilhouetteContour(processImage, fullStrokeSettings, resizeSettings);
    console.log(`[ContourFallback] createSilhouetteContour finished in ${(performance.now() - t0).toFixed(0)} ms (input ${processImage.width}x${processImage.height})`);
    onProgress?.(1);
    return result;
  }

  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}

let managerInstance: ContourWorkerManager | null = null;

export function getContourWorkerManager(): ContourWorkerManager {
  if (!managerInstance) {
    managerInstance = new ContourWorkerManager();
  }
  return managerInstance;
}

export async function processContourInWorker(
  image: HTMLImageElement,
  strokeSettings: {
    width: number;
    color: string;
    enabled: boolean;
    alphaThreshold: number;
    backgroundColor: string;
    useCustomBackground: boolean;
    autoBridging: boolean;
    autoBridgingThreshold: number;
    contourMode?: ContourMode;
    cornerMode?: string;
  },
  resizeSettings: ResizeSettings,
  onProgress?: ProgressCallback,
  detectedShapeType?: DetectedShapeType,
  detectedShapeInfo?: DetectedShapeInfo | null
): Promise<{ canvas: HTMLCanvasElement; downsampleScale: number; imageCanvasX: number; imageCanvasY: number; contourData?: ContourData; detectedAlgorithm?: DetectedAlgorithm }> {
  const manager = getContourWorkerManager();
  return manager.process(image, strokeSettings, resizeSettings, onProgress, detectedShapeType, detectedShapeInfo);
}

if (import.meta.hot) {
  import.meta.hot.accept('./contour-worker', () => {
    if (managerInstance) {
      managerInstance.recreateWorker();
    }
  });
}
