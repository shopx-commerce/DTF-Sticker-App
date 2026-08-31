// Shared contour-tracing algorithm, extracted from contour-worker.ts so both the browser worker and a future Node.js service can use the same code.
import ClipperLib from 'js-clipper';
import { fitCompositeShape } from './composite-shape-fit';

export interface Point {
  x: number;
  y: number;
}

// Duplicated from clipper-constants.ts (Web Workers can't import ES modules) — keep CLIPPER_SCALE in sync with that file.
export const CLIPPER_SCALE = 100000;

export interface WorkerMessage {
  type: 'process';
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
    contourMode?: 'smooth' | 'scattered';
    includeHoles?: boolean;
  };
  effectiveDPI: number;
  previewMode?: boolean;
  detectedShapeType?: 'circle' | 'oval' | 'square' | 'rectangle' | null;
  detectedShapeBBox?: { x: number; y: number; width: number; height: number } | null;
}

export interface WorkerResponse {
  type: 'result' | 'error' | 'progress';
  imageData?: ImageData;
  imageCanvasX?: number;
  imageCanvasY?: number;
  error?: string;
  progress?: number;
  contourData?: {
    pathPoints: Array<{x: number; y: number}>;
    previewPathPoints: Array<{x: number; y: number}>;
    allPathPoints?: Array<Array<{x: number; y: number}>>;
    allPreviewPathPoints?: Array<Array<{x: number; y: number}>>;
    // Bezier-curve cut path (Zero Hero only): PDF emit uses these for smooth arcs/circles instead of polygonal chords; allBezierPathsPreview is in worker pixel coords (matches allPreviewPathPoints), allBezierPaths is in inches in PDF coords (matches allPathPoints).
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
  };
  detectedAlgorithm?: 'complex' | 'scattered';
}

// Max processing dimension to prevent browser crashes — 4000px is safe for most browsers while maintaining quality.
export const MAX_SAFE_DIMENSION = 4000;

export function downscaleImageData(imageData: ImageData, newWidth: number, newHeight: number): ImageData {
  const { width, height, data } = imageData;
  const newData = new Uint8ClampedArray(newWidth * newHeight * 4);
  
  const xRatio = width / newWidth;
  const yRatio = height / newHeight;
  
  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      const srcX = Math.floor(x * xRatio);
      const srcY = Math.floor(y * yRatio);
      const srcIdx = (srcY * width + srcX) * 4;
      const dstIdx = (y * newWidth + x) * 4;
      
      newData[dstIdx] = data[srcIdx];
      newData[dstIdx + 1] = data[srcIdx + 1];
      newData[dstIdx + 2] = data[srcIdx + 2];
      newData[dstIdx + 3] = data[srcIdx + 3];
    }
  }
  
  return new ImageData(newData, newWidth, newHeight);
}

export function upscaleImageData(imageData: ImageData, newWidth: number, newHeight: number): ImageData {
  const { width, height, data } = imageData;
  const newData = new Uint8ClampedArray(newWidth * newHeight * 4);
  
  const xRatio = width / newWidth;
  const yRatio = height / newHeight;
  
  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      // Bilinear interpolation for smoother upscaling
      const srcX = x * xRatio;
      const srcY = y * yRatio;
      const x0 = Math.floor(srcX);
      const y0 = Math.floor(srcY);
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);
      
      const xWeight = srcX - x0;
      const yWeight = srcY - y0;
      
      const idx00 = (y0 * width + x0) * 4;
      const idx10 = (y0 * width + x1) * 4;
      const idx01 = (y1 * width + x0) * 4;
      const idx11 = (y1 * width + x1) * 4;
      const dstIdx = (y * newWidth + x) * 4;
      
      for (let c = 0; c < 4; c++) {
        const top = data[idx00 + c] * (1 - xWeight) + data[idx10 + c] * xWeight;
        const bottom = data[idx01 + c] * (1 - xWeight) + data[idx11 + c] * xWeight;
        newData[dstIdx + c] = Math.round(top * (1 - yWeight) + bottom * yWeight);
      }
    }
  }
  
  return new ImageData(newData, newWidth, newHeight);
}

export function postProgress(percent: number) {
  const response: WorkerResponse = { type: 'progress', progress: percent };
  self.postMessage(response);
}

export interface ContourResult {
  imageData: ImageData;
  imageCanvasX: number;
  imageCanvasY: number;
  contourData: {
    pathPoints: Array<{x: number; y: number}>;
    previewPathPoints: Array<{x: number; y: number}>;
    allPathPoints?: Array<Array<{x: number; y: number}>>;
    allPreviewPathPoints?: Array<Array<{x: number; y: number}>>;
    // See WorkerResponse.contourData comment.
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
  };
  detectedAlgorithm: 'complex' | 'scattered';
}

export function generateGeometricPath(
  shapeType: 'circle' | 'oval' | 'square' | 'rectangle',
  imageWidth: number,
  imageHeight: number,
  totalOffsetPixels: number,
  bbox?: { x: number; y: number; width: number; height: number } | null
): Array<{x: number; y: number}> {
  const bx = bbox?.x ?? 0;
  const by = bbox?.y ?? 0;
  const bw = bbox?.width ?? imageWidth;
  const bh = bbox?.height ?? imageHeight;
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  const points: Array<{x: number; y: number}> = [];

  const NUM_CURVE_POINTS = 256;

  if (shapeType === 'circle') {
    const radius = Math.max(bw, bh) / 2 + totalOffsetPixels;
    for (let i = 0; i < NUM_CURVE_POINTS; i++) {
      const angle = (i / NUM_CURVE_POINTS) * Math.PI * 2;
      points.push({
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle)
      });
    }
  } else if (shapeType === 'oval') {
    const rx = bw / 2 + totalOffsetPixels;
    const ry = bh / 2 + totalOffsetPixels;
    for (let i = 0; i < NUM_CURVE_POINTS; i++) {
      const angle = (i / NUM_CURVE_POINTS) * Math.PI * 2;
      points.push({
        x: cx + rx * Math.cos(angle),
        y: cy + ry * Math.sin(angle)
      });
    }
  } else if (shapeType === 'square') {
    const halfSize = Math.max(bw, bh) / 2 + totalOffsetPixels;
    points.push({ x: cx - halfSize, y: cy - halfSize });
    points.push({ x: cx + halfSize, y: cy - halfSize });
    points.push({ x: cx + halfSize, y: cy + halfSize });
    points.push({ x: cx - halfSize, y: cy + halfSize });
  } else {
    const halfW = bw / 2 + totalOffsetPixels;
    const halfH = bh / 2 + totalOffsetPixels;
    points.push({ x: cx - halfW, y: cy - halfH });
    points.push({ x: cx + halfW, y: cy - halfH });
    points.push({ x: cx + halfW, y: cy + halfH });
    points.push({ x: cx - halfW, y: cy + halfH });
  }

  return points;
}

export function processGeometricContour(
  imageData: ImageData,
  strokeSettings: {
    width: number;
    color: string;
    enabled: boolean;
    alphaThreshold: number;
    backgroundColor: string;
    useCustomBackground: boolean;
    autoBridging: boolean;
    autoBridgingThreshold: number;
    contourMode?: 'smooth' | 'scattered';
  },
  effectiveDPI: number,
  shapeType: 'circle' | 'oval' | 'square' | 'rectangle',
  width: number,
  height: number,
  totalOffsetPixels: number,
  bleedInches: number,
  bleedPixels: number,
  padding: number,
  canvasWidth: number,
  canvasHeight: number,
  effectiveBackgroundColor: string,
  isHolographic: boolean,
  shapeBBox?: { x: number; y: number; width: number; height: number } | null,
  previewMode?: boolean
): ContourResult {
  console.log('[Worker] Using geometric contour for detected shape:', shapeType, 'bbox:', shapeBBox ? `${shapeBBox.x},${shapeBBox.y} ${shapeBBox.width}x${shapeBBox.height}` : 'full image');
  postProgress(20);

  const smoothedPath = generateGeometricPath(shapeType, width, height, totalOffsetPixels, shapeBBox);

  postProgress(60);

  const previewPathXs = smoothedPath.map(p => p.x);
  const previewPathYs = smoothedPath.map(p => p.y);
  const previewMinX = Math.min(...previewPathXs);
  const previewMinY = Math.min(...previewPathYs);

  const offsetX = bleedPixels - previewMinX;
  const offsetY = bleedPixels - previewMinY;

  const output = new Uint8ClampedArray(canvasWidth * canvasHeight * 4);

  const useEdgeBleed = !strokeSettings.useCustomBackground;

  if (useEdgeBleed) {
    const extendRadius = totalOffsetPixels + bleedPixels;
    const extendedImage = createEdgeExtendedImage(imageData, extendRadius);
    const extendedImageOffsetX = padding - extendRadius;
    const extendedImageOffsetY = padding - extendRadius;
    drawContourToDataWithExtendedEdge(output, canvasWidth, canvasHeight, smoothedPath, strokeSettings.color, offsetX, offsetY, effectiveDPI, extendedImage, extendedImageOffsetX, extendedImageOffsetY, previewMode);
  } else {
    drawContourToData(output, canvasWidth, canvasHeight, smoothedPath, strokeSettings.color, effectiveBackgroundColor, offsetX, offsetY, effectiveDPI, previewMode);
  }

  const imageCanvasX = 0 + offsetX;
  const imageCanvasY = 0 + offsetY;
  const geoMask = previewMode ? buildContourMask(canvasWidth, canvasHeight, [smoothedPath], offsetX, offsetY, bleedPixels) : undefined;
  drawImageToData(output, canvasWidth, canvasHeight, imageData, Math.round(imageCanvasX), Math.round(imageCanvasY), geoMask);

  if (previewMode && geoMask) {
    applyMaskToOutput(output, canvasWidth, canvasHeight, geoMask);
  }

  // Re-stroke cut line on top of the design image so it's visible in the preview instead of being obscured.
  strokeCutLineOnTop(output, canvasWidth, canvasHeight, [smoothedPath], strokeSettings.color, offsetX, offsetY, effectiveDPI);

  postProgress(90);

  const pathXs = smoothedPath.map(p => p.x);
  const pathYs = smoothedPath.map(p => p.y);
  const minPathX = Math.min(...pathXs);
  const minPathY = Math.min(...pathYs);
  const maxPathX = Math.max(...pathXs);
  const maxPathY = Math.max(...pathYs);

  const pathWidthPixels = maxPathX - minPathX;
  const pathHeightPixels = maxPathY - minPathY;
  const pathWidthInches = pathWidthPixels / effectiveDPI;
  const pathHeightInches = pathHeightPixels / effectiveDPI;
  const pageWidthInches = pathWidthInches + (bleedInches * 2);
  const pageHeightInches = pathHeightInches + (bleedInches * 2);

  const pathInInches = smoothedPath.map(p => ({
    x: ((p.x - minPathX) / effectiveDPI) + bleedInches,
    y: pageHeightInches - (((p.y - minPathY) / effectiveDPI) + bleedInches)
  }));

  const imageOffsetXCalc = ((0 - minPathX) / effectiveDPI) + bleedInches;
  const imageOffsetYCalc = ((0 - minPathY) / effectiveDPI) + bleedInches;

  console.log('[Worker] Geometric contour:', smoothedPath.length, 'points, page:', pageWidthInches.toFixed(3), 'x', pageHeightInches.toFixed(3), 'in');

  postProgress(100);

  return {
    imageData: new ImageData(output, canvasWidth, canvasHeight),
    imageCanvasX: Math.round(imageCanvasX),
    imageCanvasY: Math.round(imageCanvasY),
    contourData: {
      pathPoints: pathInInches,
      previewPathPoints: smoothedPath.map(p => ({
        x: p.x + offsetX,
        y: p.y + offsetY
      })),
      widthInches: pageWidthInches,
      heightInches: pageHeightInches,
      imageOffsetX: imageOffsetXCalc,
      imageOffsetY: imageOffsetYCalc,
      backgroundColor: isHolographic ? 'holographic' : effectiveBackgroundColor,
      useEdgeBleed: useEdgeBleed,
      effectiveDPI,
      minPathX,
      minPathY,
      bleedInches
    },
    detectedAlgorithm: 'complex'
  };
}

export function processContour(
  imageData: ImageData,
  strokeSettings: {
    width: number;
    color: string;
    enabled: boolean;
    alphaThreshold: number;
    backgroundColor: string;
    useCustomBackground: boolean;
    autoBridging: boolean;
    autoBridgingThreshold: number;
    contourMode?: 'smooth' | 'scattered';
    includeHoles?: boolean;
  },
  effectiveDPI: number,
  previewMode?: boolean,
  detectedShapeType?: 'circle' | 'oval' | 'square' | 'rectangle' | null,
  detectedShapeBBox?: { x: number; y: number; width: number; height: number } | null
): ContourResult {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;
  
  // Adaptive super-sampling: high-res inputs already have sub-pixel detail, so 2x suffices and avoids 256M+ pixel buffers that can OOM the worker.
  const maxInputDim = Math.max(width, height);
  const SUPER_SAMPLE = previewMode ? 2 : (maxInputDim > 2000 ? 2 : 4);
  
  // Holographic uses white as a preview placeholder (replaced with gradient in UI); export functions treat it as transparent separately.
  const isHolographic = strokeSettings.backgroundColor === 'holographic';
  const effectiveBackgroundColor = isHolographic 
    ? '#FFFFFF' 
    : strokeSettings.backgroundColor;
  
  const baseOffsetInches = 0.015;
  const baseOffsetPixels = detectedShapeType
    ? 0
    : Math.round(baseOffsetInches * effectiveDPI);
  
  // Auto-bridging: close narrow gaps/caves using configurable threshold
  const autoBridgeInches = strokeSettings.autoBridging ? strokeSettings.autoBridgingThreshold : 0;
  const autoBridgePixels = Math.round(autoBridgeInches * effectiveDPI);
  
  const userOffsetPixels = Math.round(strokeSettings.width * effectiveDPI);
  const totalOffsetPixels = baseOffsetPixels + userOffsetPixels;
  
  // Full bleed for PDF export, minimal for preview (reduces visible padding around contour)
  const bleedInches = previewMode ? 0.02 : 0.10;
  const bleedPixels = Math.round(bleedInches * effectiveDPI);
  let padding = totalOffsetPixels + bleedPixels + 4;

  // For circles the contour uses max(w,h) radius which can extend beyond the shorter axis
  if (detectedShapeType === 'circle') {
    const bw = detectedShapeBBox?.width ?? width;
    const bh = detectedShapeBBox?.height ?? height;
    const radius = Math.max(bw, bh) / 2 + totalOffsetPixels;
    const extraH = Math.max(0, radius - width / 2);
    const extraV = Math.max(0, radius - height / 2);
    padding = Math.max(padding, Math.ceil(Math.max(extraH, extraV)) + bleedPixels + 4);
  }

  const canvasWidth = width + (padding * 2);
  const canvasHeight = height + (padding * 2);
  
  if (detectedShapeType) {
    return processGeometricContour(
      imageData, strokeSettings, effectiveDPI, detectedShapeType,
      width, height, totalOffsetPixels, bleedInches, bleedPixels,
      padding, canvasWidth, canvasHeight, effectiveBackgroundColor, isHolographic,
      detectedShapeBBox, previewMode
    );
  }
  
  postProgress(20);
  
  const isZeroHero = strokeSettings.width === 0;

  // 4x upscaled alpha buffer via bilinear interpolation converts pixel-locked edges into smooth sub-pixel boundaries.
  const hiResWidth = width * SUPER_SAMPLE;
  const hiResHeight = height * SUPER_SAMPLE;
  const hiResAlpha = upscaleAlphaChannel(data, width, height, SUPER_SAMPLE);
  
  // Zero Hero skips blur entirely for max edge accuracy; normal mode blurs at radius 2 at super-sampled resolution (~0.5px original).
  const blurRadius = isZeroHero ? 0 : 2;
  const smoothedAlpha = blurRadius > 0
    ? boxBlurAlpha(hiResAlpha, hiResWidth, hiResHeight, blurRadius)
    : hiResAlpha;
  console.log('[Worker] Applied alpha blur radius:', blurRadius, 'px', isZeroHero ? '(zero hero: no blur)' : '');
  
  const cropAlphaThreshold = 1;
  if (cropAlphaThreshold > 0) {
    for (let i = 0; i < smoothedAlpha.length; i++) {
      if (smoothedAlpha[i] < cropAlphaThreshold) smoothedAlpha[i] = 0;
    }
  }
  
  let hiResMask: Uint8Array;
  let faintArtMode = false;

  // Zero Hero threshold, stored at function scope so the sub-pixel tracer uses the same value the mask was built at — otherwise topology and edge-crossings disagree, causing holes/phantom paths.
  let zhAlphaThreshold = 24;

  // Zero Hero source field is either the alpha buffer (transparent-bg images) or a color-saliency field (solid-bg JPEGs/flattened PNGs); same threshold semantics either way (0=background, 255=design).
  let zhField: Uint8Array = smoothedAlpha;
  let zhMode: 'alpha' | 'color-bg' = 'alpha';
  let zhBgColor: { r: number; g: number; b: number } | null = null;

  if (isZeroHero) {
    // [ZH:0] SESSION START
    console.log(
      '%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      'color:#a855f7;font-weight:bold'
    );
    console.log(
      '%c[ZH:0] ZERO HERO SESSION START',
      'color:#a855f7;font-weight:bold;font-size:14px',
      `\n  input: ${width}×${height} px (${(width * height).toLocaleString()} pixels)` +
      `\n  hi-res: ${hiResWidth}×${hiResHeight} (×${SUPER_SAMPLE} super-sample)` +
      `\n  effective DPI: ${effectiveDPI} → hi-res DPI: ${effectiveDPI * SUPER_SAMPLE}` +
      `\n  alpha threshold setting: ${strokeSettings.alphaThreshold}` +
      `\n  include holes: ${strokeSettings.includeHoles}`
    );

    // Detect whether the input has meaningful transparency; if virtually all pixels are opaque, the design boundary is defined by COLOR not alpha, so switch to color-saliency tracing.
    let translucentPx = 0;
    const totalPx = width * height;
    for (let i = 0; i < totalPx; i++) {
      if (data[i * 4 + 3] < 250) translucentPx++;
    }
    const translucentRatio = translucentPx / totalPx;

    if (translucentRatio < 0.02) {
      console.log('[Worker] Zero hero: image is ' + ((1 - translucentRatio) * 100).toFixed(1) +
        '% opaque — checking for solid background color...');
      const bg = detectBorderBackgroundColor(data, width, height);
      if (bg) {
        zhBgColor = bg;
        zhField = buildSaliencyFieldHiRes(data, width, height, SUPER_SAMPLE, bg);
        zhMode = 'color-bg';
      }
    } else {
      console.log('[Worker] Zero hero: image has ' + (translucentRatio * 100).toFixed(1) +
        '% translucent pixels — using alpha-based tracing');
    }

    // Adaptive low threshold catches the outermost AA pixel of the design (incl. bright/white outlines) instead of slicing through the AA band like the old `>= 128`; works for both alpha and color-saliency fields (both 0..255).
    zhAlphaThreshold = chooseZeroHeroAlphaThreshold(zhField, strokeSettings.alphaThreshold);
    hiResMask = new Uint8Array(hiResWidth * hiResHeight);
    for (let i = 0; i < zhField.length; i++) {
      if (zhField[i] >= zhAlphaThreshold) hiResMask[i] = 1;
    }
    // [ZH:1] HI-RES MASK BUILT
    let maskOnPx = 0;
    for (let i = 0; i < hiResMask.length; i++) if (hiResMask[i] === 1) maskOnPx++;
    const maskCoverage = (maskOnPx / hiResMask.length) * 100;
    console.log(
      '%c[ZH:1] hi-res mask built',
      'color:#a855f7;font-weight:bold',
      `\n  source field: ${zhMode}` +
      (zhBgColor ? ` (bg color rgb(${zhBgColor.r},${zhBgColor.g},${zhBgColor.b}))` : '') +
      `\n  threshold: ${zhAlphaThreshold} / 255` +
      `\n  opaque hi-res pixels: ${maskOnPx.toLocaleString()} (${maskCoverage.toFixed(2)}% coverage)` +
      `\n  translucent ratio in source: ${(translucentRatio * 100).toFixed(1)}%`
    );
  } else {
    const loThreshold = 20;
    let hiThreshold = Math.max(strokeSettings.alphaThreshold, 128);
    let hysteresisResult = buildHysteresisMaskWithRGBRescue(
      smoothedAlpha, data, hiResWidth, hiResHeight, width, height,
      hiThreshold, loThreshold, SUPER_SAMPLE
    );
    hiResMask = hysteresisResult.mask;
    faintArtMode = hysteresisResult.faintArtMode;
    
    let hasMaskPixels = false;
    for (let i = 0; i < hiResMask.length; i++) {
      if (hiResMask[i] === 1) { hasMaskPixels = true; break; }
    }
    if (!hasMaskPixels) {
      hiThreshold = strokeSettings.alphaThreshold;
      hysteresisResult = buildHysteresisMaskWithRGBRescue(
        smoothedAlpha, data, hiResWidth, hiResHeight, width, height,
        hiThreshold, Math.min(loThreshold, hiThreshold - 1), SUPER_SAMPLE
      );
      hiResMask = hysteresisResult.mask;
      faintArtMode = hysteresisResult.faintArtMode;
    }
  }

  let hasMaskPixels = false;
  for (let i = 0; i < hiResMask.length; i++) {
    if (hiResMask[i] === 1) { hasMaskPixels = true; break; }
  }
  
  if (!hasMaskPixels) {
    return createOutputWithImage(imageData, canvasWidth, canvasHeight, padding, effectiveDPI, effectiveBackgroundColor);
  }
  
  postProgress(30);
  
  const hiResDPI = effectiveDPI * SUPER_SAMPLE;
  const minComponentAreaPx = 50;
  const keepNearMainDistInches = 0.25;
  const bladeWidthInches = 0.02;

  const prelimComps = labelComponents(hiResMask, hiResWidth, hiResHeight);
  const prelimDynMin = Math.max(minComponentAreaPx, 40);
  const prelimSignificant = prelimComps.filter(c => c.area >= prelimDynMin);
  const prelimCompositeDetected = prelimSignificant.length >= 5;

  if (prelimCompositeDetected) {
    const compositeHi = Math.max(Math.min(strokeSettings.alphaThreshold, 64), 32);
    const compositeLo = 10;
    console.log('[Worker] Composite design detected (' + prelimSignificant.length + ' significant components). Re-running mask with hiThreshold=' + compositeHi + ', loThreshold=' + compositeLo);
    const compositeResult = buildHysteresisMaskWithRGBRescue(
      smoothedAlpha, data, hiResWidth, hiResHeight, width, height,
      compositeHi, compositeLo, SUPER_SAMPLE
    );
    let mergedCount = 0;
    for (let i = 0; i < hiResMask.length; i++) {
      if (compositeResult.mask[i] === 1 && hiResMask[i] === 0) {
        hiResMask[i] = 1;
        mergedCount++;
      }
    }
    if (compositeResult.faintArtMode) {
      faintArtMode = true;
    }
    console.log('[Worker] Composite re-mask merged', mergedCount, 'new pixels into mask, faintArtMode=', faintArtMode);
  }

  // [ZH:2] PRELIMINARY COMPONENTS
  if (isZeroHero) {
    const totalPx = hiResWidth * hiResHeight;
    const sortedComps = [...prelimComps].sort((a, b) => b.area - a.area);
    const top = sortedComps.slice(0, 8).map((c, i) => {
      const bw = c.bounds.maxX - c.bounds.minX;
      const bh = c.bounds.maxY - c.bounds.minY;
      const pct = (c.area / totalPx * 100).toFixed(2);
      return `    #${i}: id=${c.id} area=${c.area.toLocaleString()} (${pct}%) bbox=${bw}×${bh} @(${c.bounds.minX},${c.bounds.minY})`;
    }).join('\n');
    console.log(
      '%c[ZH:2] preliminary component labeling',
      'color:#a855f7;font-weight:bold',
      `\n  total components: ${prelimComps.length}` +
      `\n  significant (area ≥ ${prelimDynMin}): ${prelimSignificant.length}` +
      `\n  composite mode triggered: ${prelimCompositeDetected}` +
      `\n  top components by area:\n${top}`
    );
  }

  const mainComponentMask = selectMainComponentWithOrphans(
    hiResMask, hiResWidth, hiResHeight, hiResDPI,
    minComponentAreaPx, keepNearMainDistInches, bladeWidthInches, faintArtMode,
    isZeroHero
  );

  const filledMainMask = fillSilhouette(mainComponentMask, hiResWidth, hiResHeight);

  // [ZH:3] AFTER MAIN-COMPONENT SELECTION + FILL
  if (isZeroHero) {
    let mainOnPx = 0, filledOnPx = 0;
    for (let i = 0; i < mainComponentMask.length; i++) {
      if (mainComponentMask[i] === 1) mainOnPx++;
      if (filledMainMask[i] === 1) filledOnPx++;
    }
    console.log(
      '%c[ZH:3] main-component selection + fillSilhouette',
      'color:#a855f7;font-weight:bold',
      `\n  pixels after main+orphans selection: ${mainOnPx.toLocaleString()}` +
      `\n  pixels after fillSilhouette (holes filled): ${filledOnPx.toLocaleString()}` +
      `\n  delta from fill: ${(filledOnPx - mainOnPx).toLocaleString()} pixels (interior holes)` +
      `\n  ► Components dropped here will NOT appear in the final contour.` +
      `\n  ► If the design has detail elements that are missing in the preview,` +
      `\n    look at [ZH:Component] log lines for "DROPPED" decisions above.`
    );
  }

  // Detect interior holes before they get filled (for Include Holes feature)
  const includeHoles = !!strokeSettings.includeHoles;
  let holeMasks: Uint8Array[] = [];
  if (includeHoles) {
    holeMasks = detectHoles(mainComponentMask, hiResWidth, hiResHeight);
    console.log('[Worker] Include holes: detected', holeMasks.length, 'interior hole(s)');
  }
  
  postProgress(40);
  
  // Analyze complexity on the original mask for algorithm detection label
  const allContoursForAnalysis = traceAllContours(hiResMask, hiResWidth, hiResHeight);
  const scaledContoursForAnalysis = allContoursForAnalysis.map(contour => 
    contour.map(p => ({
      x: p.x / SUPER_SAMPLE,
      y: p.y / SUPER_SAMPLE
    }))
  );
  const complexity = scaledContoursForAnalysis.length > 0 
    ? analyzeMultiContourComplexity(scaledContoursForAnalysis, effectiveDPI)
    : { needsComplexProcessing: false, needsSmoothCorners: false, perimeterAreaRatio: 0, concavityScore: 0, narrowGapCount: 0 };
  const scatteredAnalysis = scaledContoursForAnalysis.length > 0
    ? detectScatteredDesign(scaledContoursForAnalysis, effectiveDPI)
    : { isScattered: false, maxGapPixels: 0 };
  
  let detectedAlgorithm: 'complex' | 'scattered' = 
    prelimCompositeDetected ? 'scattered' :
    scatteredAnalysis.isScattered ? 'scattered' : 
    complexity.needsComplexProcessing ? 'complex' : 'complex';

  // Resolve effective contour mode
  type EffectiveMode = 'smooth' | 'scattered';
  let effectiveMode: EffectiveMode;
  if (strokeSettings.contourMode) {
    effectiveMode = strokeSettings.contourMode;
    console.log('[Worker] ContourMode override:', effectiveMode, '(auto-detected was:', detectedAlgorithm + ')');
  } else {
    effectiveMode = detectedAlgorithm === 'scattered' ? 'scattered' : 'smooth';
  }

  console.log('[Worker] Effective mode:', effectiveMode, '| Detected algorithm:', detectedAlgorithm, prelimCompositeDetected ? '(forced by composite detection)' : '');

  // ─── ZERO HERO MODE ───
  if (isZeroHero) {
    console.log('[Worker] ZERO HERO MODE: tracing exact design edges, no dilation');

    // Re-label connected components in the filled mask
    const zeroComps = labelComponents(filledMainMask, hiResWidth, hiResHeight);
    // [ZH:4] FINAL COMPONENTS GOING INTO BOUNDARY TRACE
    const _zhCompsSorted = [...zeroComps].sort((a, b) => b.area - a.area);
    const _zhCompList = _zhCompsSorted.map((c, i) => {
      const bw = c.bounds.maxX - c.bounds.minX;
      const bh = c.bounds.maxY - c.bounds.minY;
      return `    #${i}: id=${c.id} area=${c.area.toLocaleString()} bbox=${bw}×${bh} @(${c.bounds.minX},${c.bounds.minY})`;
    }).join('\n');
    console.log(
      '%c[ZH:4] components going into boundary trace',
      'color:#a855f7;font-weight:bold',
      `\n  count: ${zeroComps.length}` +
      `\n  ► One contour will be emitted per component (each gets its own polyline + Bezier path).` +
      `\n  ► If you expect more contours than shown here, the missing ones were dropped at [ZH:Component] above.\n${_zhCompList}`
    );

    if (zeroComps.length === 0) {
      return createOutputWithImage(imageData, canvasWidth, canvasHeight, padding, effectiveDPI, effectiveBackgroundColor);
    }

    postProgress(50);

    // Trace each component with sub-pixel Marching Squares (interpolates the alpha buffer at the mask's threshold), then analytical shape snapping for known primitives or straight-line snapping for freeform polygons; no Chaikin — MS-subpixel is already smooth and Chaikin reintroduces self-intersections.
    const allZeroPaths: Point[][] = [];
    for (const comp of zeroComps) {
      const compMask = new Uint8Array(hiResWidth * hiResHeight);
      for (const idx of comp.pixels) compMask[idx] = 1;

      let boundary = traceBoundaryMarchingSquaresSubPixel(
        compMask,
        zhField,
        zhAlphaThreshold,
        hiResWidth,
        hiResHeight
      );
      if (boundary.length < 3) continue;

      // Closure validation + Moore-neighbor fallback: a clean MS trace closes within √2 hires-px of its start; larger gaps mean MS terminated mid-trace (open path → diagonal ctx.closePath artifact), so retry MS at a higher threshold, then fall back to Moore-neighbor pixel-tracing (guaranteed closed, pixel-locked vertices cleaned up downstream by RDP/straightening/shape-snapping).
      const measureClosureGap = (pts: Point[]): number => {
        if (pts.length < 2) return Infinity;
        const dx = pts[0].x - pts[pts.length - 1].x;
        const dy = pts[0].y - pts[pts.length - 1].y;
        return Math.sqrt(dx * dx + dy * dy);
      };

      const CLOSURE_GAP_LIMIT = SUPER_SAMPLE * 3;
      let initialGap = measureClosureGap(boundary);

      if (initialGap > CLOSURE_GAP_LIMIT) {
        // Retry threshold: 4x current (96 floor / 200 ceiling) for both alpha and color-saliency fields — collapses thin saddle bridges that confuse MS topology.
        const retryThreshold = Math.min(200, Math.max(96, zhAlphaThreshold * 4));
        console.warn('[Worker] Zero hero: MS open at threshold=' + zhAlphaThreshold +
          ' (gap=' + initialGap.toFixed(2) + ' hires-px). Retrying at threshold=' + retryThreshold + '.');
        const fallbackMask = new Uint8Array(hiResWidth * hiResHeight);
        for (const idx of comp.pixels) {
          if (zhField[idx] >= retryThreshold) fallbackMask[idx] = 1;
        }
        const filledFallback = fillSilhouette(fallbackMask, hiResWidth, hiResHeight);
        const retry = traceBoundaryMarchingSquaresSubPixel(
          filledFallback,
          zhField,
          retryThreshold,
          hiResWidth,
          hiResHeight
        );
        const retryGap = measureClosureGap(retry);

        if (retry.length >= 3 && retryGap <= CLOSURE_GAP_LIMIT) {
          console.log('[Worker] Zero hero: retry MS closed cleanly (gap=' + retryGap.toFixed(2) +
            ', ' + retry.length + ' pts)');
          boundary = retry;
        } else {
          // Both MS attempts left the path open — fall back to Moore-neighbor pixel-tracing on the original mask, starting from the topmost-leftmost foreground pixel.
          let startX = -1, startY = -1;
          for (let py = 0; py < hiResHeight && startX === -1; py++) {
            const rowOff = py * hiResWidth;
            for (let px = 0; px < hiResWidth; px++) {
              if (compMask[rowOff + px] === 1) { startX = px; startY = py; break; }
            }
          }
          if (startX !== -1) {
            const moore = traceBoundaryForComponent(compMask, hiResWidth, hiResHeight, startX, startY);
            if (moore.length >= 3) {
              console.warn('[Worker] Zero hero: both MS attempts left path open — falling back to Moore-neighbor (guaranteed closed). Got ' +
                moore.length + ' pixel-locked vertices.');
              boundary = moore;
            } else {
              console.error('[Worker] Zero hero: Moore-neighbor also failed (got ' + moore.length +
                ' pts) — dropping component (area=' + comp.area + ').');
              continue;
            }
          } else {
            console.error('[Worker] Zero hero: could not find Moore start pixel — dropping component.');
            continue;
          }
        }
      }

      // Downscale from hi-res to original resolution (no dilation offset)
      let scaled = boundary.map(p => ({
        x: p.x / SUPER_SAMPLE,
        y: p.y / SUPER_SAMPLE
      }));

      // Light RDP simplification (epsilon 0.0003, was 0.0015) keeps ~5x more vertices than before so the Bezier fitter has enough sub-pixel curvature data to fit — at 0.0015 anchors landed 5+ px apart and Schneider's LS solver fell back to near-linear chord/3 cubics; denser output is visually identical and downstream Clipper/straightening handle it fine.
      scaled = approxPolyDP(scaled, 0.0003);
      scaled = removeNearDuplicatePoints(scaled, 0.01);

      if (scaled.length < 3) continue;

      // Try analytical primitives first — mathematically perfect paths (no wobble), no sliver/self-intersection cleanup needed.
      let parts: Point[][];
      const snappedRR = detectAndSnapRoundedRect(scaled);
      if (snappedRR) {
        parts = [snappedRR];
      } else {
        // Freeform: snap straight stretches to perfect lines (kills 1px wobble on rectangle/polygon edges) before splitting self-intersections.
        const straightened = straightenNoisyLines(scaled, 25, 0.6);
        parts = simplifyClosedPathToSimpleParts(straightened);
      }

      // Per-component bbox (original coords), used by the spans-the-design diagonal-slash guard.
      const compW = (comp.bounds.maxX - comp.bounds.minX) / SUPER_SAMPLE;
      const compH = (comp.bounds.maxY - comp.bounds.minY) / SUPER_SAMPLE;

      for (const part of parts) {
        if (part.length < 3) continue;
        const partArea = Math.abs(polygonArea(part));
        if (partArea < Math.max(8, comp.area * 0.005 / (SUPER_SAMPLE * SUPER_SAMPLE))) {
          console.log('[Worker] Zero hero: dropping sliver part, area=', partArea.toFixed(2));
          continue;
        }

        // Diagonal-slash guard (defense in depth): a bow-tie split remnant that escaped the upstream guard is recognizable by a bbox spanning most of the parent component while being super thin perpendicularly.
        let pMinX = Infinity, pMinY = Infinity, pMaxX = -Infinity, pMaxY = -Infinity;
        for (const p of part) {
          if (p.x < pMinX) pMinX = p.x;
          if (p.x > pMaxX) pMaxX = p.x;
          if (p.y < pMinY) pMinY = p.y;
          if (p.y > pMaxY) pMaxY = p.y;
        }
        const partW = pMaxX - pMinX;
        const partH = pMaxY - pMinY;
        const partLong = Math.max(partW, partH);
        const partShort = Math.max(0.5, Math.min(partW, partH));
        const elongation = partLong / partShort;
        const spansComp = Math.max(partW / Math.max(1, compW), partH / Math.max(1, compH));
        // Skip the largest part (which IS the cut path); only flag the splits.
        const isProbablyMain = parts.length === 1 ||
          partArea >= 0.5 * parts.reduce((m, q) => Math.max(m, Math.abs(polygonArea(q))), 0);
        if (!isProbablyMain && elongation > 8 && spansComp > 0.4) {
          console.log('[Worker] Zero hero: dropping diagonal-slash part — elongation=' +
            elongation.toFixed(1) + ', spansComp=' + spansComp.toFixed(2) +
            ', area=' + partArea.toFixed(0));
          continue;
        }

        allZeroPaths.push(part);
        console.log(
          '[Worker] Zero hero component:',
          part.length,
          'pts',
          snappedRR ? '[rounded-rect snap]' : (parts.length > 1 ? ' (' + parts.length + ' polys after de-self-intersect)' : ''),
          ', area:',
          comp.area
        );
      }
    }

    const outerPathCount = allZeroPaths.length;

    // Trace hole boundaries for zero-hero when includeHoles is enabled
    if (includeHoles && holeMasks.length > 0) {
      for (const holeMask of holeMasks) {
        // Holes use the same source field and threshold so the cut sits on the design-side edge of the hole.
        const boundary = traceBoundaryMarchingSquaresSubPixel(
          holeMask,
          zhField,
          zhAlphaThreshold,
          hiResWidth,
          hiResHeight
        );
        if (boundary.length < 3) continue;

        let scaled = boundary.map(p => ({
          x: p.x / SUPER_SAMPLE,
          y: p.y / SUPER_SAMPLE
        }));
        // Same denser RDP epsilon as the outer-component branch above — keeps curvature data for the Bezier fit.
        scaled = approxPolyDP(scaled, 0.0003);
        scaled = removeNearDuplicatePoints(scaled, 0.01);

        if (scaled.length < 3) continue;

        let parts: Point[][];
        const snappedRR = detectAndSnapRoundedRect(scaled);
        if (snappedRR) {
          parts = [snappedRR];
        } else {
          const straightened = straightenNoisyLines(scaled, 25, 0.6);
          parts = simplifyClosedPathToSimpleParts(straightened);
        }

        const largestHoleArea = parts.reduce(
          (m, q) => Math.max(m, Math.abs(polygonArea(q))), 0
        );
        for (const part of parts) {
          if (part.length < 3) continue;
          const partArea = Math.abs(polygonArea(part));
          if (partArea < 8) continue;

          // Same diagonal-slash guard for hole contours.
          let pMinX = Infinity, pMinY = Infinity, pMaxX = -Infinity, pMaxY = -Infinity;
          for (const p of part) {
            if (p.x < pMinX) pMinX = p.x;
            if (p.x > pMaxX) pMaxX = p.x;
            if (p.y < pMinY) pMinY = p.y;
            if (p.y > pMaxY) pMaxY = p.y;
          }
          const partW = pMaxX - pMinX;
          const partH = pMaxY - pMinY;
          const elongation = Math.max(partW, partH) / Math.max(0.5, Math.min(partW, partH));
          const isProbablyMain = parts.length === 1 || partArea >= 0.5 * largestHoleArea;
          if (!isProbablyMain && elongation > 8) {
            console.log('[Worker] Zero hero hole: dropping diagonal-slash part — elongation=' + elongation.toFixed(1));
            continue;
          }

          allZeroPaths.push(part);
          console.log('[Worker] Zero hero hole contour:', part.length, 'pts', snappedRR ? '[rounded-rect snap]' : '');
        }
      }
    }

    if (allZeroPaths.length === 0) {
      console.log('[Worker] Zero hero: no valid contours traced');
      return createOutputWithImage(imageData, canvasWidth, canvasHeight, padding, effectiveDPI, effectiveBackgroundColor);
    }

    console.log('[Worker] Zero hero: traced', allZeroPaths.length, 'independent contours (incl. holes)');

    postProgress(60);

    // Use the largest path (by area) as the primary smoothedPath
    let largestIdx = 0;
    let largestArea = 0;
    for (let i = 0; i < allZeroPaths.length; i++) {
      const a = Math.abs(polygonArea(allZeroPaths[i]));
      if (a > largestArea) { largestArea = a; largestIdx = i; }
    }
    const smoothedPath = allZeroPaths[largestIdx];

    postProgress(70);

    // Compute bounding box across ALL paths for canvas sizing and coordinate mapping
    let globalMinX = Infinity, globalMinY = Infinity;
    let globalMaxX = -Infinity, globalMaxY = -Infinity;
    for (const path of allZeroPaths) {
      for (const p of path) {
        if (p.x < globalMinX) globalMinX = p.x;
        if (p.y < globalMinY) globalMinY = p.y;
        if (p.x > globalMaxX) globalMaxX = p.x;
        if (p.y > globalMaxY) globalMaxY = p.y;
      }
    }

    const offsetX = bleedPixels - globalMinX;
    const offsetY = bleedPixels - globalMinY;

    const output = new Uint8ClampedArray(canvasWidth * canvasHeight * 4);
    const useEdgeBleed = !strokeSettings.useCustomBackground;

    // Draw each contour path onto the same output buffer — outer paths get background fill, hole paths get cutout treatment.
    for (let pi = 0; pi < allZeroPaths.length; pi++) {
      const path = allZeroPaths[pi];
      const isHolePath = pi >= outerPathCount;

      if (isHolePath) {
        drawHoleCutout(output, canvasWidth, canvasHeight, path, strokeSettings.color, offsetX, offsetY, effectiveDPI);
      } else if (useEdgeBleed) {
        const extendRadius = bleedPixels;
        const extendedImage = createEdgeExtendedImage(imageData, extendRadius);
        const extendedImageOffsetX = padding - extendRadius;
        const extendedImageOffsetY = padding - extendRadius;
        drawContourToDataWithExtendedEdge(output, canvasWidth, canvasHeight, path, strokeSettings.color, offsetX, offsetY, effectiveDPI, extendedImage, extendedImageOffsetX, extendedImageOffsetY, previewMode);
      } else {
        drawContourToData(output, canvasWidth, canvasHeight, path, strokeSettings.color, effectiveBackgroundColor, offsetX, offsetY, effectiveDPI, previewMode);
      }
    }

    const imageCanvasX = 0 + offsetX;
    const imageCanvasY = 0 + offsetY;
    // Preview wipe mask: raster from silhouette (vector mask self-intersects after Chaikin → diagonal clips).
    const zhMask = previewMode
      ? includeHoles && holeMasks.length > 0
        ? buildContourMask(canvasWidth, canvasHeight, allZeroPaths, offsetX, offsetY, bleedPixels)
        : buildZeroHeroPreviewMaskFromFilledSilhouette(
            filledMainMask,
            hiResWidth,
            hiResHeight,
            SUPER_SAMPLE,
            width,
            height,
            canvasWidth,
            canvasHeight,
            offsetX,
            offsetY,
            bleedPixels
          )
      : undefined;
    drawImageToData(output, canvasWidth, canvasHeight, imageData, Math.round(imageCanvasX), Math.round(imageCanvasY), zhMask);

    if (previewMode && zhMask) {
      applyMaskToOutput(output, canvasWidth, canvasHeight, zhMask);
    }

    // Cut line is restroked AFTER bezier reconstruction below so the preview renders the same bezier curves the PDF emits (see strokeCutLineOnTop further down) — true preview-≡-PDF parity.

    postProgress(80);

    // PDF coordinate conversion for all paths
    const minPathX = globalMinX;
    const minPathY = globalMinY;
    const pathWidthPixels = globalMaxX - globalMinX;
    const pathHeightPixels = globalMaxY - globalMinY;
    const pathWidthInches = pathWidthPixels / effectiveDPI;
    const pathHeightInches = pathHeightPixels / effectiveDPI;
    const pageWidthInches = pathWidthInches + (bleedInches * 2);
    const pageHeightInches = pathHeightInches + (bleedInches * 2);

    const convertPathToInches = (path: Point[]) => path.map(p => ({
      x: ((p.x - minPathX) / effectiveDPI) + bleedInches,
      y: pageHeightInches - (((p.y - minPathY) / effectiveDPI) + bleedInches)
    }));

    const primaryPathInInches = convertPathToInches(smoothedPath);
    const allPathsInInches = allZeroPaths.map(convertPathToInches);

    const imageOffsetXCalc = ((0 - minPathX) / effectiveDPI) + bleedInches;
    const imageOffsetYCalc = ((0 - minPathY) / effectiveDPI) + bleedInches;

    // Bezier reconstruction (Zero Hero only): convert each closed polyline into a corner-aware Bezier path so PDF emits smooth `c` curves instead of polygonal `l` chords; tolerance is in original-image px (1.0px ≈ 0.0033" at 300 DPI, below visible threshold) — deliberately looser than 0.4px so the LS solver can fit ~20-50px arcs per cubic instead of fragmenting into near-linear chord/3 fallbacks.
    const bezierTolerancePx = 1.0;
    const bezierStraightTolPx = 0.7;
    const allBezierPathsPreview: BezierPath[] = [];
    const allBezierPaths: BezierPath[] = [];
    let totalBezierSegs = 0;
    let totalBezierLines = 0;
    let totalBezierCubics = 0;
    type PathFate = {
      idx: number; pts: number; bw: number; bh: number;
      cubicSegs: number; lineSegs: number;
      fate: 'CIRCLE/ELLIPSE-SNAP' | 'BEZIER-FITTED' | 'STRAIGHT-LINES' | 'MIXED';
    };
    const _pathFates: PathFate[] = [];
    for (let pathIdx = 0; pathIdx < allZeroPaths.length; pathIdx++) {
      const path = allZeroPaths[pathIdx];
      // Per-path bbox so console diagnostics can be correlated to which component is which when a design has multiple shapes.
      let _pMinX = Infinity, _pMinY = Infinity, _pMaxX = -Infinity, _pMaxY = -Infinity;
      for (const p of path) {
        if (p.x < _pMinX) _pMinX = p.x;
        if (p.y < _pMinY) _pMinY = p.y;
        if (p.x > _pMaxX) _pMaxX = p.x;
        if (p.y > _pMaxY) _pMaxY = p.y;
      }
      const _pBw = Math.round(_pMaxX - _pMinX);
      const _pBh = Math.round(_pMaxY - _pMinY);
      console.log(
        `%c[ZH:Path #${pathIdx}] starting Bezier reconstruction`,
        'color:#06b6d4;font-weight:bold',
        `\n  ${path.length} polyline pts, bbox ${_pBw}×${_pBh} at (${Math.round(_pMinX)},${Math.round(_pMinY)})`
      );
      const bp = polylineToBezierPath(path, bezierTolerancePx, bezierStraightTolPx);

      // Classify what happened to this path.
      let _cubicCount = 0, _lineCount = 0;
      for (const s of bp.segments) {
        if (s.type === 'cubic') _cubicCount++;
        else _lineCount++;
      }
      let _fate: PathFate['fate'];
      if (bp.segments.length === 4 && _cubicCount === 4) {
        _fate = 'CIRCLE/ELLIPSE-SNAP';
      } else if (_cubicCount > 0 && _lineCount === 0) {
        _fate = 'BEZIER-FITTED';
      } else if (_cubicCount === 0 && _lineCount > 0) {
        _fate = 'STRAIGHT-LINES';
      } else {
        _fate = 'MIXED';
      }
      _pathFates.push({
        idx: pathIdx, pts: path.length, bw: _pBw, bh: _pBh,
        cubicSegs: _cubicCount, lineSegs: _lineCount, fate: _fate,
      });
      console.log(
        `%c[ZH:Path #${pathIdx}] → ${_fate}`,
        'color:#06b6d4',
        `(${bp.segments.length} segs: ${_cubicCount} cubic, ${_lineCount} line)`
      );
      // Preview-coord version (matches allPreviewPathPoints).
      const bpPreview: BezierPath = {
        start: { x: bp.start.x + offsetX, y: bp.start.y + offsetY },
        segments: bp.segments.map(seg =>
          seg.type === 'line'
            ? { type: 'line', to: { x: seg.to.x + offsetX, y: seg.to.y + offsetY } }
            : {
                type: 'cubic',
                cp1: { x: seg.cp1.x + offsetX, y: seg.cp1.y + offsetY },
                cp2: { x: seg.cp2.x + offsetX, y: seg.cp2.y + offsetY },
                to: { x: seg.to.x + offsetX, y: seg.to.y + offsetY },
              }
        ),
        closed: true,
      };
      allBezierPathsPreview.push(bpPreview);

      // PDF inches version (matches allPathPoints).
      allBezierPaths.push(
        bezierPathPxToInches(bp, minPathX, minPathY, effectiveDPI, bleedInches, pageHeightInches)
      );

      totalBezierSegs += bp.segments.length;
      for (const s of bp.segments) {
        if (s.type === 'line') totalBezierLines++;
        else totalBezierCubics++;
      }
    }
    console.log(
      '[Worker] Zero hero bezier reconstruction:', allBezierPaths.length, 'path(s),',
      totalBezierSegs, 'segments (', totalBezierLines, 'line +', totalBezierCubics, 'cubic) — was',
      allZeroPaths.reduce((s, p) => s + p.length, 0), 'polyline vertices'
    );

    // [ZH:5] FINAL PATH FATE SUMMARY
    const _circleCount = _pathFates.filter(f => f.fate === 'CIRCLE/ELLIPSE-SNAP').length;
    const _bezierCount = _pathFates.filter(f => f.fate === 'BEZIER-FITTED').length;
    const _straightCount = _pathFates.filter(f => f.fate === 'STRAIGHT-LINES').length;
    const _mixedCount = _pathFates.filter(f => f.fate === 'MIXED').length;
    console.log(
      '%c[ZH:5] FINAL path fate summary',
      'color:#a855f7;font-weight:bold;font-size:14px',
      `\n  ${allBezierPaths.length} contour path(s) emitted → PDF/preview` +
      `\n  ► circle/ellipse-snapped: ${_circleCount}` +
      `\n  ► bezier-fitted curves:   ${_bezierCount}` +
      `\n  ► straight-line only:     ${_straightCount}` +
      `\n  ► mixed:                  ${_mixedCount}`
    );
    if (typeof console.table === 'function') {
      console.table(_pathFates.map(f => ({
        path: `#${f.idx}`, pts: f.pts,
        bbox: `${f.bw}×${f.bh}`,
        fate: f.fate,
        cubic: f.cubicSegs, line: f.lineSegs,
      })));
    }
    if (_circleCount > 0 && _pathFates.length === 1) {
      console.warn(
        '%c[ZH:5] ⚠  Only ONE path emitted and it was snapped to a circle.\n' +
        '   If your design has features that should appear OUTSIDE that circle\n' +
        '   (axes, poles, sun-rays, etc), they were filtered earlier in the\n' +
        '   pipeline. Check [ZH:Component] decisions above for "DROPPED" lines.',
        'color:#dc2626;font-weight:bold'
      );
    }
    console.log(
      '%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      'color:#a855f7;font-weight:bold'
    );

    console.log('[Worker] Zero hero page size (inches):', pageWidthInches.toFixed(4), 'x', pageHeightInches.toFixed(4));
    console.log('[Worker] Zero hero paths:', allZeroPaths.length, ', primary:', smoothedPath.length, 'pts');

    // Re-stroke cut line(s) on top of the design image using bezier preview paths so on-screen matches PDF geometry (preview ≡ PDF); polylines passed only as fallback since strokeCutLineOnTop prefers bezier when present.
    strokeCutLineOnTop(
      output,
      canvasWidth,
      canvasHeight,
      allZeroPaths,
      strokeSettings.color,
      offsetX,
      offsetY,
      effectiveDPI,
      allBezierPathsPreview
    );

    postProgress(90);

    return {
      imageData: new ImageData(output, canvasWidth, canvasHeight),
      imageCanvasX: Math.round(imageCanvasX),
      imageCanvasY: Math.round(imageCanvasY),
      contourData: {
        pathPoints: primaryPathInInches,
        previewPathPoints: smoothedPath.map(p => ({ x: p.x + offsetX, y: p.y + offsetY })),
        allPathPoints: allPathsInInches,
        allPreviewPathPoints: allZeroPaths.map(path =>
          path.map(p => ({ x: p.x + offsetX, y: p.y + offsetY }))
        ),
        allBezierPaths,
        allBezierPathsPreview,
        widthInches: pageWidthInches,
        heightInches: pageHeightInches,
        imageOffsetX: imageOffsetXCalc,
        imageOffsetY: imageOffsetYCalc,
        backgroundColor: isHolographic ? 'holographic' : effectiveBackgroundColor,
        useEdgeBleed: useEdgeBleed,
        effectiveDPI,
        minPathX,
        minPathY,
        bleedInches,
        holePathStartIndex: includeHoles && holeMasks.length > 0 ? outerPathCount : undefined
      },
      detectedAlgorithm
    };
  }

  // ─── NORMAL MODE (non-zero stroke width) ───

  let dilateRadiusHiRes = totalOffsetPixels * SUPER_SAMPLE;
  
  // Size guard: limit dilated mask to ~16M pixels to avoid memory blowups
  const maxDilatedPixels = 16_000_000;
  let actualDilateRadius = dilateRadiusHiRes;
  const projectedWidth = hiResWidth + dilateRadiusHiRes * 2;
  const projectedHeight = hiResHeight + dilateRadiusHiRes * 2;
  if (projectedWidth * projectedHeight > maxDilatedPixels) {
    const scale = Math.sqrt(maxDilatedPixels / (projectedWidth * projectedHeight));
    actualDilateRadius = Math.max(1, Math.round(dilateRadiusHiRes * scale));
    console.log('[Worker] Dilation radius clamped from', dilateRadiusHiRes, 'to', actualDilateRadius, 'to stay within memory limit');
    dilateRadiusHiRes = actualDilateRadius;
  }
  
  console.log('[Worker] Dilating main component by', totalOffsetPixels, 'px (', dilateRadiusHiRes, 'px at', SUPER_SAMPLE, 'x)');
  const dilatedMask = dilateSilhouette(filledMainMask, hiResWidth, hiResHeight, dilateRadiusHiRes);
  const dilatedWidth = hiResWidth + dilateRadiusHiRes * 2;
  const dilatedHeight = hiResHeight + dilateRadiusHiRes * 2;
  
  postProgress(50);

  // Trace ALL boundaries of the dilated mask (not just the first found) so disconnected orphan shapes that survived dilation aren't dropped.
  const allDilatedContours = traceAllContours(dilatedMask, dilatedWidth, dilatedHeight);

  const validDilatedContours = allDilatedContours.filter(c => c.length >= 3);

  if (validDilatedContours.length === 0) {
    console.log('[Worker] No valid dilated contours found, returning empty');
    return createOutputWithImage(imageData, canvasWidth, canvasHeight, padding, effectiveDPI, effectiveBackgroundColor);
  }

  // Downscale all contour points from hi-res to original resolution
  const scaledContours = validDilatedContours.map(contour =>
    contour.map(p => ({
      x: (p.x - dilateRadiusHiRes) / SUPER_SAMPLE,
      y: (p.y - dilateRadiusHiRes) / SUPER_SAMPLE
    }))
  );

  let smoothedPath: Point[];

  if (scaledContours.length === 1) {
    smoothedPath = scaledContours[0];
    console.log('[Worker] Single dilated contour:', smoothedPath.length, 'points');
  } else {
    // Multiple disconnected contours: merge into a single outline by computing the actual minimum distance between the closest pair, expanding only as much as needed to bridge the gap.
    let maxMinDist = 0;
    for (let i = 0; i < scaledContours.length; i++) {
      let closestToAny = Infinity;
      for (let j = 0; j < scaledContours.length; j++) {
        if (i === j) continue;
        const d = minDistanceBetweenContours(scaledContours[i], scaledContours[j]);
        if (d < closestToAny) closestToAny = d;
      }
      if (closestToAny > maxMinDist && closestToAny < Infinity) maxMinDist = closestToAny;
    }

    const mergeGap = Math.ceil(maxMinDist / 2) + 4;
    console.log('[Worker] Multiple dilated contours:', scaledContours.length,
      '- max nearest-neighbor gap:', maxMinDist.toFixed(1), 'px, merge gap:', mergeGap, 'px');

    smoothedPath = multiPathVectorMerge(scaledContours, mergeGap);

    if (smoothedPath.length < 3) {
      console.log('[Worker] Merge failed, falling back to largest contour');
      smoothedPath = scaledContours.reduce((best, c) =>
        c.length > best.length ? c : best, scaledContours[0]);
    }
  }

  // Vector weld: expand then shrink by small amount to merge nearby path segments
  const weldPx = previewMode ? 1.0 : 3.0;
  smoothedPath = vectorWeld(smoothedPath, weldPx);
  
  // Simplify the path to reduce point count while preserving shape
  const tightEpsilon = 0.0005;
  smoothedPath = approxPolyDP(smoothedPath, tightEpsilon);
  smoothedPath = removeNearDuplicatePoints(smoothedPath, 0.01);

  console.log('[Worker] Dilated contour traced, welded, and simplified:', smoothedPath.length, 'points');

  const minGapPx = Math.max(2, Math.round(bladeWidthInches * effectiveDPI));
  smoothedPath = enforceMinGap(smoothedPath, minGapPx);

  if (effectiveMode === 'smooth') {
    const compositeResult = fitCompositeShape(smoothedPath, effectiveDPI);
    if (compositeResult.fitted) {
      smoothedPath = compositeResult.path;
      console.log('[Worker] Sharp mode: composite shape fitted, using geometric outline:', smoothedPath.length, 'points');
    } else {
      console.log('[Worker] Sharp mode: no composite shape detected, using traced contour');
    }
  }

  if (effectiveMode === 'scattered') {
    const iterations = 3;
    for (let iter = 0; iter < iterations; iter++) {
      const result: Array<{x: number; y: number}> = [];
      const n = smoothedPath.length;
      for (let i = 0; i < n; i++) {
        const p0 = smoothedPath[i];
        const p1 = smoothedPath[(i + 1) % n];
        result.push({ x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y });
        result.push({ x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y });
      }
      smoothedPath = result;
    }
    console.log('[Worker] Chaikin smoothing applied for scattered mode:', smoothedPath.length, 'points');
  }

  postProgress(60);
  
  postProgress(70);
  
  // Effective page dimensions: the offset contour extends beyond the original by totalOffsetPixels on each side.
  const effectiveDilatedWidth = width + totalOffsetPixels * 2;
  const effectiveDilatedHeight = height + totalOffsetPixels * 2;
  
  console.log('[Worker] Final contour:', smoothedPath.length, 'points');
  
  postProgress(80);
  
  postProgress(90);
  
  // CRITICAL: Clipper vector offset can push coordinates negative, so shift the path so its minimum point sits at the bleed margin (bleedPixels from canvas edge) — first find the path's actual minimum bounds.
  const previewPathXs = smoothedPath.map(p => p.x);
  const previewPathYs = smoothedPath.map(p => p.y);
  const previewMinX = Math.min(...previewPathXs);
  const previewMinY = Math.min(...previewPathYs);
  
  // Shift so the contour's left/top edge is at bleedPixels from canvas edge
  const offsetX = bleedPixels - previewMinX;
  const offsetY = bleedPixels - previewMinY;
  
  const output = new Uint8ClampedArray(canvasWidth * canvasHeight * 4);
  
  // Use custom background color if enabled, otherwise use edge-aware bleed
  const useEdgeBleed = !strokeSettings.useCustomBackground;
  
  if (useEdgeBleed) {
    // Edge-aware bleed: extends edge colors outward
    const extendRadius = totalOffsetPixels + bleedPixels;
    const extendedImage = createEdgeExtendedImage(imageData, extendRadius);
    
    // Draw contour with edge-extended background
    const extendedImageOffsetX = padding - extendRadius;
    const extendedImageOffsetY = padding - extendRadius;
    drawContourToDataWithExtendedEdge(output, canvasWidth, canvasHeight, smoothedPath, strokeSettings.color, offsetX, offsetY, effectiveDPI, extendedImage, extendedImageOffsetX, extendedImageOffsetY, previewMode);
  } else {
    drawContourToData(output, canvasWidth, canvasHeight, smoothedPath, strokeSettings.color, effectiveBackgroundColor, offsetX, offsetY, effectiveDPI, previewMode);
  }
  
  const imageCanvasX = 0 + offsetX;
  const imageCanvasY = 0 + offsetY;
  const ctrMask = previewMode ? buildContourMask(canvasWidth, canvasHeight, [smoothedPath], offsetX, offsetY, bleedPixels) : undefined;
  drawImageToData(output, canvasWidth, canvasHeight, imageData, Math.round(imageCanvasX), Math.round(imageCanvasY), ctrMask);

  if (previewMode && ctrMask) {
    applyMaskToOutput(output, canvasWidth, canvasHeight, ctrMask);
  }

  // Re-stroke cut line on top of the design image so it's visible in the preview instead of being obscured.
  strokeCutLineOnTop(output, canvasWidth, canvasHeight, [smoothedPath], strokeSettings.color, offsetX, offsetY, effectiveDPI);

  // Contour data for PDF export: store raw pixel coordinates and let PDF export handle conversion, so preview and PDF use the exact same path data.
  
  // Get actual path bounds
  const pathXs = smoothedPath.map(p => p.x);
  const pathYs = smoothedPath.map(p => p.y);
  const minPathX = Math.min(...pathXs);
  const minPathY = Math.min(...pathYs);
  const maxPathX = Math.max(...pathXs);
  const maxPathY = Math.max(...pathYs);
  
  console.log('[Worker] Path bounds (pixels): X:', minPathX.toFixed(1), 'to', maxPathX.toFixed(1),
              'Y:', minPathY.toFixed(1), 'to', maxPathY.toFixed(1));
  console.log('[Worker] Canvas offset used:', offsetX.toFixed(1), offsetY.toFixed(1));
  console.log('[Worker] Image canvas position:', imageCanvasX.toFixed(1), imageCanvasY.toFixed(1));
  
  // Calculate page dimensions based on actual path bounds
  const pathWidthPixels = maxPathX - minPathX;
  const pathHeightPixels = maxPathY - minPathY;
  const pathWidthInches = pathWidthPixels / effectiveDPI;
  const pathHeightInches = pathHeightPixels / effectiveDPI;
  const pageWidthInches = pathWidthInches + (bleedInches * 2);
  const pageHeightInches = pathHeightInches + (bleedInches * 2);
  
  // Convert path to inches for PDF matching preview exactly: preview draws at canvas(px+offsetX, py+offsetY); PDF maps contour left edge to bleedInches from page left, top edge to bleedInches from page top (Y-flipped).
  const pathInInches = smoothedPath.map(p => ({
    // X: shift so minPathX maps to bleedInches
    x: ((p.x - minPathX) / effectiveDPI) + bleedInches,
    // Y: shift and flip (PDF Y=0 is at bottom)
    y: pageHeightInches - (((p.y - minPathY) / effectiveDPI) + bleedInches)
  }));
  
  // Image offset in PDF coords: original image's inner edge sits near (0,0) in pixel space, ≈(minPathX+totalOffsetPixels, minPathY+totalOffsetPixels) after Clipper offset; since minPathX ≈ -totalOffsetPixels, image left edge in PDF ≈ totalOffsetInches + bleedInches.
  const imageOffsetXCalc = ((0 - minPathX) / effectiveDPI) + bleedInches;
  const imageOffsetYCalc = ((0 - minPathY) / effectiveDPI) + bleedInches;
  
  console.log('[Worker] Page size (inches):', pageWidthInches.toFixed(4), 'x', pageHeightInches.toFixed(4));
  console.log('[Worker] Image offset (inches):', imageOffsetXCalc.toFixed(4), 'x', imageOffsetYCalc.toFixed(4));
  
  // Debug: verify path bounds in inches
  const pathXsInches = pathInInches.map(p => p.x);
  const pathYsInches = pathInInches.map(p => p.y);
  console.log('[Worker] Path bounds (inches): X:', Math.min(...pathXsInches).toFixed(4), 'to', Math.max(...pathXsInches).toFixed(4),
              'Y:', Math.min(...pathYsInches).toFixed(4), 'to', Math.max(...pathYsInches).toFixed(4));

  // ─── HOLE TRACING (normal mode) ───
  let allPathsInInches: Array<Array<{x: number; y: number}>> | undefined;
  let allPreviewPaths: Array<Array<{x: number; y: number}>> | undefined;

  if (includeHoles && holeMasks.length > 0) {
    const holePaths: Point[][] = [];

    for (const holeMask of holeMasks) {
      const boundary = traceBoundaryMarchingSquares(holeMask, hiResWidth, hiResHeight);
      if (boundary.length < 3) continue;

      let scaled = boundary.map(p => ({
        x: p.x / SUPER_SAMPLE,
        y: p.y / SUPER_SAMPLE
      }));

      // Shrink the hole polygon inward (negative Clipper offset) by the stroke offset so the cut doesn't eat into the design.
      if (totalOffsetPixels > 0) {
        const shrinkDist = totalOffsetPixels;
        const co = new ClipperLib.ClipperOffset();
        co.ArcTolerance = CLIPPER_SCALE * 0.25;
        co.MiterLimit = 2.0;
        const clipperPath = scaled.map(p => ({
          X: Math.round(p.x * CLIPPER_SCALE),
          Y: Math.round(p.y * CLIPPER_SCALE)
        }));
        co.AddPath(clipperPath, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
        const shrunk: Array<Array<{X: number; Y: number}>> = [];
        co.Execute(shrunk, -shrinkDist * CLIPPER_SCALE);
        if (shrunk.length > 0 && shrunk[0].length >= 3) {
          scaled = shrunk[0].map(p => ({
            x: p.X / CLIPPER_SCALE,
            y: p.Y / CLIPPER_SCALE
          }));
        } else {
          continue;
        }
      }

      scaled = approxPolyDP(scaled, 0.001);
      scaled = removeNearDuplicatePoints(scaled, 0.01);
      scaled = smoothPolyChaikin(scaled, 1, 45);

      if (scaled.length >= 3) {
        holePaths.push(scaled);
        console.log('[Worker] Hole contour (normal):', scaled.length, 'pts');
      }
    }

    if (holePaths.length > 0) {
      allPathsInInches = [pathInInches];
      allPreviewPaths = [smoothedPath.map(p => ({ x: p.x + offsetX, y: p.y + offsetY }))];

      for (const hp of holePaths) {
        drawHoleCutout(output, canvasWidth, canvasHeight, hp, strokeSettings.color, offsetX, offsetY, effectiveDPI);

        const holeInInches = hp.map(p => ({
          x: ((p.x - minPathX) / effectiveDPI) + bleedInches,
          y: pageHeightInches - (((p.y - minPathY) / effectiveDPI) + bleedInches)
        }));
        allPathsInInches.push(holeInInches);
        allPreviewPaths.push(hp.map(p => ({ x: p.x + offsetX, y: p.y + offsetY })));
      }

      drawImageToData(output, canvasWidth, canvasHeight, imageData, Math.round(imageCanvasX), Math.round(imageCanvasY), ctrMask);

      // Re-stroke ALL cut lines (outer + holes) on top of the design image so they stay visible in the preview after the image is drawn over.
      const allNormalPaths: Point[][] = [smoothedPath, ...holePaths];
      strokeCutLineOnTop(output, canvasWidth, canvasHeight, allNormalPaths, strokeSettings.color, offsetX, offsetY, effectiveDPI);

      console.log('[Worker] Include holes: total paths =', allPathsInInches.length, '(1 outer +', holePaths.length, 'holes)');
    }
  }
  
  return {
    imageData: new ImageData(output, canvasWidth, canvasHeight),
    imageCanvasX: Math.round(imageCanvasX),
    imageCanvasY: Math.round(imageCanvasY),
    contourData: {
      pathPoints: pathInInches,
      previewPathPoints: smoothedPath.map(p => ({
        x: p.x + offsetX,
        y: p.y + offsetY
      })),
      allPathPoints: allPathsInInches,
      allPreviewPathPoints: allPreviewPaths,
      widthInches: pageWidthInches,
      heightInches: pageHeightInches,
      imageOffsetX: imageOffsetXCalc,
      imageOffsetY: imageOffsetYCalc,
      backgroundColor: isHolographic ? 'holographic' : effectiveBackgroundColor,
      useEdgeBleed: useEdgeBleed,
      effectiveDPI,
      minPathX,
      minPathY,
      bleedInches,
      holePathStartIndex: allPathsInInches && allPathsInInches.length > 1 ? 1 : undefined
    },
    detectedAlgorithm
  };
}

// Detect if the design is "solid" (few internal gaps) vs many gaps; returns true when solid enough to use edge-aware bleed.
export function isSolidDesign(data: Uint8ClampedArray, width: number, height: number, alphaThreshold: number): boolean {
  // Count opaque pixels and edge pixels
  let opaqueCount = 0;
  let edgeCount = 0;
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (data[idx + 3] >= alphaThreshold) {
        opaqueCount++;
        
        // Check if this is an edge pixel (has transparent neighbor)
        let isEdge = false;
        for (let dy = -1; dy <= 1 && !isEdge; dy++) {
          for (let dx = -1; dx <= 1 && !isEdge; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
              isEdge = true;
            } else {
              const nidx = (ny * width + nx) * 4;
              if (data[nidx + 3] < alphaThreshold) isEdge = true;
            }
          }
        }
        if (isEdge) edgeCount++;
      }
    }
  }
  
  if (opaqueCount === 0) return false;
  
  // Edge-to-area ratio: solid shapes have a lower ratio (few edges relative to area), gappy designs have a higher ratio (many internal edges).
  const edgeRatio = edgeCount / opaqueCount;
  
  // Threshold: solid shapes typically have ratio < 0.15; designs with lots of gaps/lines have ratio > 0.3.
  return edgeRatio < 0.25;
}

export function createSilhouetteMaskFromData(data: Uint8ClampedArray, width: number, height: number, threshold: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      mask[y * width + x] = data[idx + 3] >= threshold ? 1 : 0;
    }
  }
  
  return mask;
}

// Upscale alpha channel via bilinear interpolation for 4x super-sampling, filling gaps between pixels with smooth gradients.
export function upscaleAlphaChannel(data: Uint8ClampedArray, width: number, height: number, scale: number): Uint8Array {
  const newWidth = width * scale;
  const newHeight = height * scale;
  const result = new Uint8Array(newWidth * newHeight);
  
  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      // Map back to source coordinates (with sub-pixel precision)
      const srcX = x / scale;
      const srcY = y / scale;
      
      // Get the four surrounding source pixels
      const x0 = Math.floor(srcX);
      const y0 = Math.floor(srcY);
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);
      
      // Calculate interpolation weights
      const xWeight = srcX - x0;
      const yWeight = srcY - y0;
      
      // Get alpha values from the 4 corners
      const a00 = data[(y0 * width + x0) * 4 + 3];
      const a10 = data[(y0 * width + x1) * 4 + 3];
      const a01 = data[(y1 * width + x0) * 4 + 3];
      const a11 = data[(y1 * width + x1) * 4 + 3];
      
      // Bilinear interpolation
      const top = a00 * (1 - xWeight) + a10 * xWeight;
      const bottom = a01 * (1 - xWeight) + a11 * xWeight;
      const alpha = top * (1 - yWeight) + bottom * yWeight;
      
      result[y * newWidth + x] = Math.round(alpha);
    }
  }
  
  return result;
}

// Separable box blur on alpha channel (horizontal then vertical pass) — O(1) per pixel instead of O(r^2), and smooths straight edges with slight transparency variations.
export function boxBlurAlpha(alpha: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return alpha;
  
  const temp = new Uint8Array(alpha.length);
  const result = new Uint8Array(alpha.length);
  
  // Horizontal pass
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      const left = Math.max(0, x - radius);
      const right = Math.min(width - 1, x + radius);
      
      for (let i = left; i <= right; i++) {
        sum += alpha[rowOffset + i];
        count++;
      }
      temp[rowOffset + x] = Math.round(sum / count);
    }
  }
  
  // Vertical pass
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let sum = 0;
      let count = 0;
      const top = Math.max(0, y - radius);
      const bottom = Math.min(height - 1, y + radius);
      
      for (let j = top; j <= bottom; j++) {
        sum += temp[j * width + x];
        count++;
      }
      result[y * width + x] = Math.round(sum / count);
    }
  }
  
  return result;
}

// Create silhouette mask from pre-extracted alpha buffer (for super-sampled data)
export function createSilhouetteMaskFromAlpha(alpha: Uint8Array, width: number, height: number, threshold: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  
  for (let i = 0; i < alpha.length; i++) {
    mask[i] = alpha[i] >= threshold ? 1 : 0;
  }
  
  return mask;
}

export type LabeledComponent = { id: number; area: number; bounds: BoundingBox; pixels: number[] };

export function labelComponents(mask: Uint8Array, w: number, h: number): LabeledComponent[] {
  const labels = new Int32Array(w * h).fill(-1);
  const comps: LabeledComponent[] = [];
  const q = new Int32Array(w * h);
  let qh = 0, qt = 0;
  let id = 0;

  for (let i = 0; i < w * h; i++) {
    if (mask[i] === 0 || labels[i] !== -1) continue;

    let area = 0;
    let b: BoundingBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const pixels: number[] = [];

    labels[i] = id;
    qh = 0; qt = 0;
    q[qt++] = i;

    while (qh < qt) {
      const idx = q[qh++];
      area++;
      pixels.push(idx);

      const x = idx % w;
      const y = (idx / w) | 0;

      if (x < b.minX) b.minX = x;
      if (y < b.minY) b.minY = y;
      if (x > b.maxX) b.maxX = x;
      if (y > b.maxY) b.maxY = y;

      if (x > 0) { const ni = idx - 1; if (mask[ni] && labels[ni] === -1) { labels[ni] = id; q[qt++] = ni; } }
      if (x + 1 < w) { const ni = idx + 1; if (mask[ni] && labels[ni] === -1) { labels[ni] = id; q[qt++] = ni; } }
      if (y > 0) { const ni = idx - w; if (mask[ni] && labels[ni] === -1) { labels[ni] = id; q[qt++] = ni; } }
      if (y + 1 < h) { const ni = idx + w; if (mask[ni] && labels[ni] === -1) { labels[ni] = id; q[qt++] = ni; } }
      if (x > 0 && y > 0) { const ni = idx - w - 1; if (mask[ni] && labels[ni] === -1) { labels[ni] = id; q[qt++] = ni; } }
      if (x + 1 < w && y > 0) { const ni = idx - w + 1; if (mask[ni] && labels[ni] === -1) { labels[ni] = id; q[qt++] = ni; } }
      if (x > 0 && y + 1 < h) { const ni = idx + w - 1; if (mask[ni] && labels[ni] === -1) { labels[ni] = id; q[qt++] = ni; } }
      if (x + 1 < w && y + 1 < h) { const ni = idx + w + 1; if (mask[ni] && labels[ni] === -1) { labels[ni] = id; q[qt++] = ni; } }
    }

    comps.push({ id, area, bounds: b, pixels });
    id++;
  }

  return comps;
}

export function intersectionArea(a: BoundingBox, b: BoundingBox): number {
  const minX = Math.max(a.minX, b.minX);
  const minY = Math.max(a.minY, b.minY);
  const maxX = Math.min(a.maxX, b.maxX);
  const maxY = Math.min(a.maxY, b.maxY);
  if (maxX < minX || maxY < minY) return 0;
  return (maxX - minX + 1) * (maxY - minY + 1);
}

export function distBounds(a: BoundingBox, b: BoundingBox): number {
  const dx = (a.maxX < b.minX) ? (b.minX - a.maxX) : (b.maxX < a.minX) ? (a.minX - b.maxX) : 0;
  const dy = (a.maxY < b.minY) ? (b.minY - a.maxY) : (b.maxY < a.minY) ? (a.minY - b.maxY) : 0;
  return Math.hypot(dx, dy);
}

export function pickMainComponent(comps: LabeledComponent[]): LabeledComponent {
  const global = comps.reduce((acc, c) => unionBounds(acc, c.bounds), comps[0].bounds);

  let totalArea = 0;
  let weightedCX = 0;
  let weightedCY = 0;
  for (const c of comps) {
    const cx = (c.bounds.minX + c.bounds.maxX) / 2;
    const cy = (c.bounds.minY + c.bounds.maxY) / 2;
    weightedCX += cx * c.area;
    weightedCY += cy * c.area;
    totalArea += c.area;
  }
  const gcx = totalArea > 0 ? weightedCX / totalArea : (global.minX + global.maxX) / 2;
  const gcy = totalArea > 0 ? weightedCY / totalArea : (global.minY + global.maxY) / 2;

  let best = comps[0];
  let bestScore = -Infinity;

  for (const c of comps) {
    const b = c.bounds;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;

    const overlap = intersectionArea(b, global) / Math.max(1, boundsArea(b));
    const dist = Math.hypot(cx - gcx, cy - gcy);

    const score = (c.area) * (0.6 + 0.8 * overlap) - dist * 5.0;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return best;
}

export function selectMainComponentWithOrphans(
  mask: Uint8Array, w: number, h: number, effectiveDPI: number,
  minComponentAreaPx: number, keepNearMainDistInches: number, bladeWidthInches: number,
  faintArtMode: boolean = false,
  skipMorphClose: boolean = false
): Uint8Array {
  const comps = labelComponents(mask, w, h);
  if (comps.length === 0) return new Uint8Array(w * h);

  const main = pickMainComponent(comps);
  const outMask = new Uint8Array(w * h);

  for (const idx of main.pixels) outMask[idx] = 1;

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  const expandBounds = (b: BoundingBox, padPx: number) => ({
    minX: clamp(b.minX - padPx, 0, w - 1),
    minY: clamp(b.minY - padPx, 0, h - 1),
    maxX: clamp(b.maxX + padPx, 0, w - 1),
    maxY: clamp(b.maxY + padPx, 0, h - 1),
  });

  const boundsIntersect = (a: BoundingBox, b: BoundingBox) =>
    !(b.maxX < a.minX || b.minX > a.maxX || b.maxY < a.minY || b.minY > a.maxY);

  const xOverlapRatio = (a: BoundingBox, b: BoundingBox) => {
    const left = Math.max(a.minX, b.minX);
    const right = Math.min(a.maxX, b.maxX);
    const overlap = Math.max(0, right - left);
    const bw = Math.max(1, (b.maxX - b.minX));
    return overlap / bw;
  };

  const mainBounds = main.bounds;
  const mainW = (mainBounds.maxX - mainBounds.minX);
  const mainH = (mainBounds.maxY - mainBounds.minY);

  const relMin = Math.round(main.area * 0.0015);
  const dynamicMinArea = Math.max(minComponentAreaPx, 40, relMin);

  const significantComps = comps.filter(c => c.id !== main.id && c.area >= dynamicMinArea);
  const compositeMode = significantComps.length >= 5;

  const densityThreshold = compositeMode ? 0.005 : 0.015;
  const baseExpandIn = compositeMode
    ? Math.max(keepNearMainDistInches, 1.0)
    : Math.max(keepNearMainDistInches, 0.5);
  const extraExpandIn = compositeMode ? 0.30 : 0.15;
  const maxExtraAreaRatio = compositeMode ? 1.0 : 0.65;

  const keepNearMainDistPx = Math.max(8, Math.round(keepNearMainDistInches * effectiveDPI));

  const expandPx = Math.max(8, Math.round((baseExpandIn + extraExpandIn) * effectiveDPI));
  const expandedMain = expandBounds(mainBounds, expandPx);

  const totalSignificantArea = compositeMode
    ? significantComps.reduce((sum, c) => sum + c.area, 0) + main.area
    : main.area;
  const maxExtraArea = compositeMode
    ? Math.round(totalSignificantArea * maxExtraAreaRatio)
    : Math.round(main.area * maxExtraAreaRatio);
  let extraAreaKept = 0;

  const captionGapPx = Math.max(
    Math.round(0.75 * effectiveDPI),
    Math.round(0.90 * mainH)
  );

  const isCaptionLike = (b: BoundingBox) => {
    const gap = b.minY - mainBounds.maxY;
    if (gap < 0) return false;
    if (compositeMode) {
      if (gap > captionGapPx * 3) return false;
    } else {
      if (gap > captionGapPx) return false;
    }

    const overlap = xOverlapRatio(mainBounds, b);
    if (overlap < 0.25) return false;

    const bw = (b.maxX - b.minX);
    const bh = (b.maxY - b.minY);

    if (bw > mainW * (compositeMode ? 2.0 : 1.25)) return false;

    if (bh > 0 && (bw / bh) > 12) return false;

    if (!compositeMode && b.maxY > h - Math.max(2, Math.round(0.02 * h))) return false;

    return true;
  };

  const passesDensity = (c: LabeledComponent) => {
    const b = c.bounds;
    const bw = (b.maxX - b.minX + 1);
    const bh = (b.maxY - b.minY + 1);
    const bboxArea = Math.max(1, bw * bh);
    const density = (c.pixels.length / bboxArea);
    return density >= densityThreshold;
  };

  let kept = 1;
  let removed = 0;

  const unionBoundsOf = (a: BoundingBox, b: BoundingBox): BoundingBox => ({
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  });

  const isNearAny = (c: LabeledComponent, includedComps: LabeledComponent[], chainDistPx: number) => {
    for (const inc of includedComps) {
      if (distBounds(inc.bounds, c.bounds) <= chainDistPx) return true;
    }
    return false;
  };

  if (compositeMode) {
    const areaThreshold = dynamicMinArea;
    const candidates = comps
      .filter(c => c.id !== main.id && c.area >= areaThreshold)
      .sort((a, b) => b.area - a.area);

    const belowAreaThreshold = comps
      .filter(c => c.id !== main.id && c.area < areaThreshold);

    type CompDecision = {
      id: number; area: number;
      bw: number; bh: number; minX: number; minY: number;
      verdict: 'KEPT (main)' | 'KEPT' | 'DROPPED';
      reason: string; pass: number;
    };
    const decisions: CompDecision[] = [{
      id: main.id, area: main.area,
      bw: mainBounds.maxX - mainBounds.minX,
      bh: mainBounds.maxY - mainBounds.minY,
      minX: mainBounds.minX, minY: mainBounds.minY,
      verdict: 'KEPT (main)', reason: 'largest component', pass: 0,
    }];
    for (const c of belowAreaThreshold) {
      decisions.push({
        id: c.id, area: c.area,
        bw: c.bounds.maxX - c.bounds.minX,
        bh: c.bounds.maxY - c.bounds.minY,
        minX: c.bounds.minX, minY: c.bounds.minY,
        verdict: 'DROPPED',
        reason: `area ${c.area} < dynamicMinArea ${dynamicMinArea}`,
        pass: 0,
      });
      removed++;
    }

    const maxKeep = 50;
    const chainDistPx = expandPx;
    const included: LabeledComponent[] = [main];
    let unionIncluded: BoundingBox = { ...mainBounds };
    const added = new Set<number>([main.id]);
    const dropReasonByCandidate = new Map<number, string>();

    let changed = true;
    let passes = 0;
    const maxPasses = 10;

    while (changed && passes < maxPasses) {
      changed = false;
      passes++;

      for (const c of candidates) {
        if (added.has(c.id)) continue;
        if (kept >= maxKeep) break;

        const expandedUnion = expandBounds(unionIncluded, expandPx);
        const okIntersect = boundsIntersect(expandedUnion, c.bounds);
        const okNear = isNearAny(c, included, chainDistPx);
        const okCaption = isCaptionLike(c.bounds);

        if (!okIntersect && !okNear && !okCaption) {
          const distToUnion = distBounds(unionIncluded, c.bounds);
          dropReasonByCandidate.set(c.id, `not near union: dist-to-union ${distToUnion}px > chain ${chainDistPx}px, not in expanded union bbox, not caption-like`);
          continue;
        }
        if (!passesDensity(c)) {
          const bw = c.bounds.maxX - c.bounds.minX;
          const bh = c.bounds.maxY - c.bounds.minY;
          const bboxArea = Math.max(1, (bw + 1) * (bh + 1));
          const density = c.pixels.length / bboxArea;
          dropReasonByCandidate.set(c.id, `density ${density.toFixed(4)} < threshold ${densityThreshold} (sparse/spread-out)`);
          continue;
        }
        if (extraAreaKept + c.area > maxExtraArea) {
          dropReasonByCandidate.set(c.id, `would exceed maxExtraArea (${extraAreaKept + c.area} > ${maxExtraArea})`);
          continue;
        }

        for (const idx of c.pixels) outMask[idx] = 1;
        kept++;
        extraAreaKept += c.area;
        included.push(c);
        added.add(c.id);
        unionIncluded = unionBoundsOf(unionIncluded, c.bounds);
        changed = true;
        dropReasonByCandidate.delete(c.id);

        decisions.push({
          id: c.id, area: c.area,
          bw: c.bounds.maxX - c.bounds.minX,
          bh: c.bounds.maxY - c.bounds.minY,
          minX: c.bounds.minX, minY: c.bounds.minY,
          verdict: 'KEPT',
          reason: [
            okIntersect ? 'inside expanded union bbox' : null,
            okNear ? `near a kept comp ≤ ${chainDistPx}px` : null,
            okCaption ? 'caption-like' : null,
          ].filter(Boolean).join(' + '),
          pass: passes,
        });
      }
    }

    for (const c of candidates) {
      if (added.has(c.id)) continue;
      decisions.push({
        id: c.id, area: c.area,
        bw: c.bounds.maxX - c.bounds.minX,
        bh: c.bounds.maxY - c.bounds.minY,
        minX: c.bounds.minX, minY: c.bounds.minY,
        verdict: 'DROPPED',
        reason: dropReasonByCandidate.get(c.id) || 'never reached (loop exited or maxKeep hit)',
        pass: passes,
      });
      removed++;
    }

    removed = comps.length - kept;
    console.log('[Worker] Composite flood-fill: passes=', passes, 'chain dist=', chainDistPx, 'px');

    // console.table inside a Web Worker can hang DevTools when the panel is open and the table has many rows, so emit plain log lines instead.
    console.log('%c[ZH:Component] selection verdict (composite mode) — ' + decisions.length + ' rows',
      'color:#a855f7;font-weight:bold');
    for (const d of decisions) {
      console.log(`[ZH:Component] id=${d.id} area=${d.area} bbox=${d.bw}×${d.bh} @(${d.minX},${d.minY}) pass=${d.pass} → ${d.verdict}: ${d.reason}`);
    }
  } else if (faintArtMode) {
    const faintAreaThreshold = Math.max(dynamicMinArea, 80);
    const sortedComps = comps
      .filter(c => c.id !== main.id && c.area >= faintAreaThreshold)
      .sort((a, b) => b.area - a.area);

    const maxKeep = 30;

    for (let i = 0; i < sortedComps.length && i < maxKeep; i++) {
      const c = sortedComps[i];

      const ok =
        boundsIntersect(expandedMain, c.bounds) ||
        (distBounds(mainBounds, c.bounds) <= keepNearMainDistPx) ||
        isCaptionLike(c.bounds);

      if (!ok) continue;
      if (!passesDensity(c)) { removed++; continue; }
      if (extraAreaKept + c.area > maxExtraArea) continue;

      for (const idx of c.pixels) outMask[idx] = 1;
      kept++;
      extraAreaKept += c.area;
    }

    removed = comps.length - kept;
  } else {
    // Per-component decision trace: records keep/drop verdict + reason for every non-main component so it's clear why detail elements (axes, poles, small accents) survive or get filtered.
    type CompDecision = {
      id: number; area: number;
      bw: number; bh: number; minX: number; minY: number;
      verdict: 'KEPT (main)' | 'KEPT' | 'DROPPED';
      reason: string;
    };
    const decisions: CompDecision[] = [{
      id: main.id, area: main.area,
      bw: mainBounds.maxX - mainBounds.minX,
      bh: mainBounds.maxY - mainBounds.minY,
      minX: mainBounds.minX, minY: mainBounds.minY,
      verdict: 'KEPT (main)', reason: 'largest component',
    }];

    for (const c of comps) {
      if (c.id === main.id) continue;
      const bw = c.bounds.maxX - c.bounds.minX;
      const bh = c.bounds.maxY - c.bounds.minY;
      const dist = distBounds(mainBounds, c.bounds);
      const decision: CompDecision = {
        id: c.id, area: c.area, bw, bh, minX: c.bounds.minX, minY: c.bounds.minY,
        verdict: 'DROPPED', reason: '',
      };

      if (c.area < dynamicMinArea) {
        decision.reason = `area ${c.area} < dynamicMinArea ${dynamicMinArea}`;
        decisions.push(decision); removed++; continue;
      }

      const okIntersect = boundsIntersect(expandedMain, c.bounds);
      const okDist = dist <= keepNearMainDistPx;
      const okCaption = isCaptionLike(c.bounds);
      if (!okIntersect && !okDist && !okCaption) {
        decision.reason = `not near main: dist ${dist}px > limit ${keepNearMainDistPx}px, not in expanded bbox, not caption-like`;
        decisions.push(decision); removed++; continue;
      }

      if (!passesDensity(c)) {
        const bboxArea = Math.max(1, (bw + 1) * (bh + 1));
        const density = c.pixels.length / bboxArea;
        decision.reason = `density ${density.toFixed(4)} < threshold ${densityThreshold} (sparse/spread-out)`;
        decisions.push(decision); removed++; continue;
      }

      // Peer-component exemption: a component with area ≥50% of the main one is a co-equal part of the design (e.g. a logo split into two halves by a gap), not an orphan speck — applying the maxExtraArea debris budget to it would amputate half the artwork, so near-main dense peers are always kept and don't consume the orphan budget.
      const isPeer = c.area >= 0.5 * main.area;

      if (!isPeer && extraAreaKept + c.area > maxExtraArea) {
        decision.reason = `would exceed maxExtraArea (${extraAreaKept + c.area} > ${maxExtraArea})`;
        decisions.push(decision); removed++; continue;
      }

      for (const idx of c.pixels) outMask[idx] = 1;
      kept++;
      if (!isPeer) extraAreaKept += c.area;
      decision.verdict = 'KEPT';
      const reasons: string[] = [];
      if (isPeer) reasons.push(`peer component (area ${(100 * c.area / main.area).toFixed(0)}% of main)`);
      if (okIntersect) reasons.push('inside expanded main bbox');
      if (okDist) reasons.push(`dist ${dist}px ≤ ${keepNearMainDistPx}px`);
      if (okCaption) reasons.push('caption-like');
      decision.reason = reasons.join(' + ');
      decisions.push(decision);
    }

    // Plain log lines (console.table inside a Web Worker can hang DevTools).
    console.log('%c[ZH:Component] selection verdict (normal mode) — ' + decisions.length + ' rows',
      'color:#a855f7;font-weight:bold');
    for (const d of decisions) {
      console.log(`[ZH:Component] id=${d.id} area=${d.area} bbox=${d.bw}×${d.bh} @(${d.minX},${d.minY}) → ${d.verdict}: ${d.reason}`);
    }
  }

  console.log(
    '[Worker] Component selection:',
    'mode=', compositeMode ? 'composite' : (faintArtMode ? 'faint-art' : 'normal'),
    'total=', comps.length,
    'significant=', significantComps.length,
    'main area=', main.area,
    'dynamicMinArea=', dynamicMinArea,
    'expandPx=', expandPx,
    'captionGapPx=', captionGapPx,
    'densityThreshold=', densityThreshold,
    'kept=', kept,
    'removed=', removed
  );

  if (skipMorphClose) {
    console.log('[Worker] Morphological close skipped (zero hero mode)');
    return outMask;
  }

  const bladeWidthPx = Math.max(0, bladeWidthInches * effectiveDPI);
  let closingRadiusPx = Math.round(bladeWidthPx / 2);

  if (effectiveDPI < 180) closingRadiusPx = Math.max(1, closingRadiusPx);
  else closingRadiusPx = Math.max(2, closingRadiusPx);

  closingRadiusPx = Math.min(closingRadiusPx, 4);

  if (kept > 1) closingRadiusPx = Math.min(closingRadiusPx, 1);

  if (closingRadiusPx > 0) {
    console.log('[Worker] Blade-safe closing radius:', closingRadiusPx, 'px (DPI:', effectiveDPI, ')');
    return morphologicalClose(outMask, w, h, closingRadiusPx);
  }

  return outMask;
}

export function buildHysteresisMask(
  alpha: Uint8Array, width: number, height: number,
  hiThreshold: number, loThreshold: number
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const maybe = new Uint8Array(width * height);
  const queue: number[] = [];

  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] >= hiThreshold) {
      mask[i] = 1;
      queue.push(i);
    } else if (alpha[i] >= loThreshold) {
      maybe[i] = 1;
    }
  }

  while (queue.length > 0) {
    const idx = queue.pop()!;
    const x = idx % width;
    const y = (idx - x) / width;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (maybe[nIdx] === 1 && mask[nIdx] === 0) {
          mask[nIdx] = 1;
          queue.push(nIdx);
        }
      }
    }
  }

  return mask;
}

export type HysteresisResult = { mask: Uint8Array; faintArtMode: boolean };

export function buildHysteresisMaskWithRGBRescue(
  alpha: Uint8Array, originalData: Uint8ClampedArray,
  hiResWidth: number, hiResHeight: number,
  origWidth: number, origHeight: number,
  hiThreshold: number, loThreshold: number,
  scale: number
): HysteresisResult {
  const mask = new Uint8Array(hiResWidth * hiResHeight);
  const maybe = new Uint8Array(hiResWidth * hiResHeight);
  const queue: number[] = [];
  let seedCount = 0;
  let maybeCount = 0;

  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] >= hiThreshold) {
      mask[i] = 1;
      queue.push(i);
      seedCount++;
    } else if (alpha[i] >= loThreshold) {
      maybe[i] = 1;
      maybeCount++;
    } else {
      const hx = i % hiResWidth;
      const hy = (i - hx) / hiResWidth;
      const sx = Math.min(Math.floor(hx / scale), origWidth - 1);
      const sy = Math.min(Math.floor(hy / scale), origHeight - 1);
      const srcIdx = (sy * origWidth + sx) * 4;
      const r = originalData[srcIdx];
      const g = originalData[srcIdx + 1];
      const b = originalData[srcIdx + 2];
      const srcAlpha = originalData[srcIdx + 3];
      if (srcAlpha >= 2) {
        const lum = r * 0.299 + g * 0.587 + b * 0.114;
        const isNearWhite = r > 240 && g > 240 && b > 240;
        const isNearBlack = r < 15 && g < 15 && b < 15;
        if (!isNearWhite && !isNearBlack && lum > 10 && lum < 245) {
          maybe[i] = 1;
          maybeCount++;
        }
      }
    }
  }

  while (queue.length > 0) {
    const idx = queue.pop()!;
    const x = idx % hiResWidth;
    const y = (idx - x) / hiResWidth;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= hiResWidth || ny < 0 || ny >= hiResHeight) continue;
        const nIdx = ny * hiResWidth + nx;
        if (maybe[nIdx] === 1 && mask[nIdx] === 0) {
          mask[nIdx] = 1;
          queue.push(nIdx);
        }
      }
    }
  }

  let solidCount = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 1) solidCount++;
  }

  const totalPixels = hiResWidth * hiResHeight;
  const solidRatio = solidCount / totalPixels;
  const seedRatio = seedCount / totalPixels;
  const minMaybeComponentArea = Math.max(100, Math.round(totalPixels * 0.00005));
  let faintArtMode = false;

  if (seedRatio < 0.001 && solidRatio < 0.005 && maybeCount > 0) {
    faintArtMode = true;
    console.log('[Worker] Seedless promotion fallback: seedCount=', seedCount,
      'seedRatio=', seedRatio.toFixed(6), 'solidCount=', solidCount,
      'solidRatio=', solidRatio.toFixed(6), 'maybeCount=', maybeCount);

    const remainingMaybe = new Uint8Array(hiResWidth * hiResHeight);
    for (let i = 0; i < mask.length; i++) {
      if (maybe[i] === 1 && mask[i] === 0) remainingMaybe[i] = 1;
    }

    const maybeComps = labelComponents(remainingMaybe, hiResWidth, hiResHeight);
    let promoted = 0;
    let promotedArea = 0;
    const maxPromotedAreaRatio = 0.3;
    const sortedMaybeComps = maybeComps
      .filter(c => c.area >= minMaybeComponentArea)
      .sort((a, b) => b.area - a.area);
    for (const comp of sortedMaybeComps) {
      if (promotedArea + comp.area > totalPixels * maxPromotedAreaRatio) break;
      for (const idx of comp.pixels) mask[idx] = 1;
      promotedArea += comp.area;
      promoted++;
    }
    if (promoted === 0) {
      faintArtMode = false;
    }
    console.log('[Worker] Promoted', promoted, 'maybe components (of', maybeComps.length,
      'total, min area:', minMaybeComponentArea, ', promotedArea:', promotedArea, ')');
  }

  return { mask, faintArtMode };
}

export function morphologicalClose(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const radiusSq = radius * radius;
  const offsets: Array<{dx: number; dy: number}> = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radiusSq) {
        offsets.push({dx, dy});
      }
    }
  }

  const dilated = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] !== 1) continue;
      for (const {dx, dy} of offsets) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          dilated[ny * width + nx] = 1;
        }
      }
    }
  }

  const closed = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (dilated[y * width + x] !== 1) continue;
      let allSet = true;
      for (const {dx, dy} of offsets) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || dilated[ny * width + nx] !== 1) {
          allSet = false;
          break;
        }
      }
      if (allSet) closed[y * width + x] = 1;
    }
  }

  return closed;
}

export function countExternalComponents(mask: Uint8Array, width: number, height: number): number {
  const visited = new Uint8Array(width * height);
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx] !== 1 || visited[idx] === 1) continue;
      count++;
      visited[idx] = 1;
      const stack = [idx];
      while (stack.length > 0) {
        const ci = stack.pop()!;
        const cx = ci % width;
        const cy = (ci - cx) / width;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const ni = ny * width + nx;
            if (mask[ni] === 1 && visited[ni] === 0) {
              visited[ni] = 1;
              stack.push(ni);
            }
          }
        }
      }
    }
  }
  return count;
}

export function dilateSilhouette(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const newWidth = width + radius * 2;
  const newHeight = height + radius * 2;
  const result = new Uint8Array(newWidth * newHeight);
  
  // Optimized circular dilation with early-exit and precomputed offsets
  const radiusSq = radius * radius;
  
  // Precompute circle offsets once
  const offsets: number[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radiusSq) {
        offsets.push(dy * newWidth + dx);
      }
    }
  }
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 1) {
        const centerIdx = (y + radius) * newWidth + (x + radius);
        for (let i = 0; i < offsets.length; i++) {
          result[centerIdx + offsets[i]] = 1;
        }
      }
    }
  }
  
  return result;
}

export function fillSilhouette(mask: Uint8Array, width: number, height: number): Uint8Array {
  const filled = new Uint8Array(mask.length);
  filled.set(mask);
  
  const totalPixels = width * height;
  const visited = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  let qHead = 0, qTail = 0;
  
  for (let x = 0; x < width; x++) {
    if (mask[x] === 0 && visited[x] === 0) {
      visited[x] = 1;
      queue[qTail++] = x;
    }
    const bottomIdx = (height - 1) * width + x;
    if (mask[bottomIdx] === 0 && visited[bottomIdx] === 0) {
      visited[bottomIdx] = 1;
      queue[qTail++] = bottomIdx;
    }
  }
  
  for (let y = 0; y < height; y++) {
    const leftIdx = y * width;
    if (mask[leftIdx] === 0 && visited[leftIdx] === 0) {
      visited[leftIdx] = 1;
      queue[qTail++] = leftIdx;
    }
    const rightIdx = y * width + (width - 1);
    if (mask[rightIdx] === 0 && visited[rightIdx] === 0) {
      visited[rightIdx] = 1;
      queue[qTail++] = rightIdx;
    }
  }
  
  while (qHead < qTail) {
    const idx = queue[qHead++];
    const x = idx % width;
    const y = (idx / width) | 0;
    
    if (y > 0)          { const n = idx - width; if (visited[n] === 0 && mask[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
    if (y < height - 1) { const n = idx + width; if (visited[n] === 0 && mask[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
    if (x > 0)          { const n = idx - 1;     if (visited[n] === 0 && mask[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
    if (x < width - 1)  { const n = idx + 1;     if (visited[n] === 0 && mask[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
  }
  
  for (let i = 0; i < filled.length; i++) {
    if (visited[i] === 0) {
      filled[i] = 1;
    }
  }
  
  return filled;
}

// Detect interior holes in a binary mask — a hole is a connected background region (0) not connected to the image border; returns one mask per hole.
export function detectHoles(mask: Uint8Array, width: number, height: number): Uint8Array[] {
  const totalPixels = width * height;
  const visited = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  let qHead = 0, qTail = 0;

  for (let x = 0; x < width; x++) {
    if (mask[x] === 0 && visited[x] === 0) { visited[x] = 1; queue[qTail++] = x; }
    const b = (height - 1) * width + x;
    if (mask[b] === 0 && visited[b] === 0) { visited[b] = 1; queue[qTail++] = b; }
  }
  for (let y = 0; y < height; y++) {
    const l = y * width;
    if (mask[l] === 0 && visited[l] === 0) { visited[l] = 1; queue[qTail++] = l; }
    const r = y * width + (width - 1);
    if (mask[r] === 0 && visited[r] === 0) { visited[r] = 1; queue[qTail++] = r; }
  }
  while (qHead < qTail) {
    const idx = queue[qHead++];
    const x = idx % width;
    const y = (idx / width) | 0;
    if (y > 0)          { const n = idx - width; if (visited[n] === 0 && mask[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
    if (y < height - 1) { const n = idx + width; if (visited[n] === 0 && mask[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
    if (x > 0)          { const n = idx - 1;     if (visited[n] === 0 && mask[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
    if (x < width - 1)  { const n = idx + 1;     if (visited[n] === 0 && mask[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
  }

  const holeLabel = new Int32Array(totalPixels);
  const holes: Uint8Array[] = [];
  let nextLabel = 1;

  const holeQueue = new Int32Array(totalPixels);

  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0 && visited[i] === 0 && holeLabel[i] === 0) {
      const holeMask = new Uint8Array(totalPixels);
      let hqHead = 0, hqTail = 0;
      holeLabel[i] = nextLabel;
      holeQueue[hqTail++] = i;
      let pixelCount = 0;
      while (hqHead < hqTail) {
        const idx = holeQueue[hqHead++];
        holeMask[idx] = 1;
        pixelCount++;
        const x = idx % width;
        const y = (idx / width) | 0;
        if (y > 0)          { const n = idx - width; if (mask[n] === 0 && visited[n] === 0 && holeLabel[n] === 0) { holeLabel[n] = nextLabel; holeQueue[hqTail++] = n; } }
        if (y < height - 1) { const n = idx + width; if (mask[n] === 0 && visited[n] === 0 && holeLabel[n] === 0) { holeLabel[n] = nextLabel; holeQueue[hqTail++] = n; } }
        if (x > 0)          { const n = idx - 1;     if (mask[n] === 0 && visited[n] === 0 && holeLabel[n] === 0) { holeLabel[n] = nextLabel; holeQueue[hqTail++] = n; } }
        if (x < width - 1)  { const n = idx + 1;     if (mask[n] === 0 && visited[n] === 0 && holeLabel[n] === 0) { holeLabel[n] = nextLabel; holeQueue[hqTail++] = n; } }
      }
      if (pixelCount >= 20) {
        holes.push(holeMask);
      }
      nextLabel++;
    }
  }

  return holes;
}

// Standard marching squares: processes the mask in 2x2 cells producing edge midpoint crossings (sharper axis-aligned edges than pixel-by-pixel tracing), tracking entry edge to determine exit edge via lookup table, with saddle cases handled by entry direction.
export function traceBoundaryMarchingSquares(mask: Uint8Array, width: number, height: number): Point[] {
  // Find the starting cell: scan from top-left for the first cell whose code crosses the boundary (1-14, not 0 or 15).
  let startCellX = -1, startCellY = -1;
  let startEdge = -1; // Which edge we start from (0=top, 1=right, 2=bottom, 3=left)
  
  outer: for (let cy = 0; cy < height - 1; cy++) {
    for (let cx = 0; cx < width - 1; cx++) {
      const code = getCellCode(mask, width, height, cx, cy);
      if (code > 0 && code < 15) {
        startCellX = cx;
        startCellY = cy;
        // Determine starting edge based on code
        startEdge = getStartEdge(code);
        break outer;
      }
    }
  }
  
  if (startCellX === -1) {
    return traceBoundarySimple(mask, width, height);
  }
  
  const path: Point[] = [];
  const visited = new Set<string>();
  
  let cx = startCellX;
  let cy = startCellY;
  let entryEdge = startEdge;
  
  const maxSteps = width * height * 2;
  let steps = 0;
  
  do {
    const key = `${cx},${cy},${entryEdge}`;
    if (visited.has(key)) break;
    visited.add(key);
    
    const code = getCellCode(mask, width, height, cx, cy);
    if (code === 0 || code === 15) break; // No boundary
    
    // Get exit edge based on code and entry edge
    const exitEdge = getExitEdge(code, entryEdge);
    if (exitEdge === -1) break;
    
    // Add the crossing point on the exit edge
    const point = getEdgeMidpoint(cx, cy, exitEdge);
    
    // Avoid duplicate consecutive points
    if (path.length === 0 || 
        Math.abs(path[path.length - 1].x - point.x) > 0.001 || 
        Math.abs(path[path.length - 1].y - point.y) > 0.001) {
      path.push(point);
    }
    
    // Move to the adjacent cell through the exit edge — the exit edge becomes the entry edge of the new cell (opposite side).
    switch (exitEdge) {
      case 0: cy--; entryEdge = 2; break; // Exit top -> enter from bottom
      case 1: cx++; entryEdge = 3; break; // Exit right -> enter from left
      case 2: cy++; entryEdge = 0; break; // Exit bottom -> enter from top
      case 3: cx--; entryEdge = 1; break; // Exit left -> enter from right
    }
    
    // Bounds check
    if (cx < 0 || cx >= width - 1 || cy < 0 || cy >= height - 1) break;
    
    steps++;
  } while ((cx !== startCellX || cy !== startCellY || entryEdge !== startEdge) && steps < maxSteps);
  
  console.log('[MarchingSquares] Traced', path.length, 'points in', steps, 'steps');
  
  return path.length >= 3 ? path : traceBoundarySimple(mask, width, height);
}

// Get the 4-bit cell code for marching squares (standard corner layout: TL=bit0, TR=bit1, BR=bit2, BL=bit3).
export function getCellCode(mask: Uint8Array, width: number, height: number, cx: number, cy: number): number {
  // Bounds check
  if (cx < 0 || cx >= width - 1 || cy < 0 || cy >= height - 1) return 0;
  
  const tl = mask[cy * width + cx] === 1 ? 1 : 0;
  const tr = mask[cy * width + (cx + 1)] === 1 ? 2 : 0;
  const br = mask[(cy + 1) * width + (cx + 1)] === 1 ? 4 : 0;
  const bl = mask[(cy + 1) * width + cx] === 1 ? 8 : 0;
  
  return tl | tr | br | bl;
}

// Determine the initial entry edge for a cell code (must be one of the code's valid edges; edges: 0=top, 1=right, 2=bottom, 3=left).
export function getStartEdge(code: number): number {
  // For each code, pick the first valid edge from the edge pair — must match the edge pairs used in getExitEdge.
  const startEdges: Record<number, number> = {
    1: 3,   // LEFT <-> TOP: start from LEFT
    2: 0,   // TOP <-> RIGHT: start from TOP
    3: 3,   // LEFT <-> RIGHT: start from LEFT
    4: 1,   // RIGHT <-> BOTTOM: start from RIGHT
    5: 3,   // Saddle LEFT<->BOTTOM: start from LEFT
    6: 0,   // TOP <-> BOTTOM: start from TOP
    7: 3,   // LEFT <-> BOTTOM: start from LEFT
    8: 2,   // BOTTOM <-> LEFT: start from BOTTOM
    9: 0,   // TOP <-> BOTTOM: start from TOP
    10: 0,  // Saddle TOP<->LEFT: start from TOP
    11: 1,  // RIGHT <-> BOTTOM: start from RIGHT
    12: 1,  // RIGHT <-> LEFT: start from RIGHT
    13: 0,  // TOP <-> RIGHT: start from TOP
    14: 0,  // TOP <-> LEFT: start from TOP
  };
  return startEdges[code] ?? 0;
}

// Standard marching-squares exit-edge lookup: given a cell code and entry edge, returns the exit edge (edges: 0=top,1=right,2=bottom,3=left); each code 1-14 has exactly two boundary-crossing edges (enter A, exit B), with codes 5 and 10 as saddles having two disjoint interpretations resolved by entry direction.
export function getExitEdge(code: number, entryEdge: number): number {
  // Edge pairs per code: [edgeA, edgeB] — entering from edgeA exits edgeB and vice versa.
  const edgePairs: Record<number, [number, number]> = {
    1:  [3, 0],  // LEFT <-> TOP
    2:  [0, 1],  // TOP <-> RIGHT  
    3:  [3, 1],  // LEFT <-> RIGHT
    4:  [1, 2],  // RIGHT <-> BOTTOM
    6:  [0, 2],  // TOP <-> BOTTOM
    7:  [3, 2],  // LEFT <-> BOTTOM
    8:  [2, 3],  // BOTTOM <-> LEFT
    9:  [0, 2],  // TOP <-> BOTTOM
    11: [1, 2],  // RIGHT <-> BOTTOM
    12: [1, 3],  // RIGHT <-> LEFT
    13: [0, 1],  // TOP <-> RIGHT
    14: [0, 3],  // TOP <-> LEFT
  };
  
  // Saddle cases (code 5: TL+BR, code 10: TR+BL) have two disjoint boundary interpretations, resolved by entry direction.
  if (code === 5) {
    // TL+BR saddle: LEFT<->BOTTOM or TOP<->RIGHT
    if (entryEdge === 3) return 2;  // LEFT -> BOTTOM
    if (entryEdge === 2) return 3;  // BOTTOM -> LEFT
    if (entryEdge === 0) return 1;  // TOP -> RIGHT
    if (entryEdge === 1) return 0;  // RIGHT -> TOP
    return -1;
  }
  
  if (code === 10) {
    // TR+BL saddle: TOP<->LEFT or RIGHT<->BOTTOM
    if (entryEdge === 0) return 3;  // TOP -> LEFT
    if (entryEdge === 3) return 0;  // LEFT -> TOP
    if (entryEdge === 1) return 2;  // RIGHT -> BOTTOM
    if (entryEdge === 2) return 1;  // BOTTOM -> RIGHT
    return -1;
  }
  
  const pair = edgePairs[code];
  if (!pair) return -1;
  
  const [edgeA, edgeB] = pair;
  if (entryEdge === edgeA) return edgeB;
  if (entryEdge === edgeB) return edgeA;
  
  return -1; // Invalid entry edge for this code
}

// Get the midpoint of a cell edge (edges: 0=top, 1=right, 2=bottom, 3=left).
export function getEdgeMidpoint(cx: number, cy: number, edge: number): Point {
  switch (edge) {
    case 0: return { x: cx + 0.5, y: cy };       // top edge midpoint
    case 1: return { x: cx + 1, y: cy + 0.5 };   // right edge midpoint
    case 2: return { x: cx + 0.5, y: cy + 1 };   // bottom edge midpoint
    case 3: return { x: cx, y: cy + 0.5 };       // left edge midpoint
    default: return { x: cx + 0.5, y: cy + 0.5 }; // center fallback
  }
}

// Sub-pixel edge crossing: interpolate along the cell edge to find the exact `t` where alpha equals `threshold`, instead of the pixel midpoint — makes straight edges actually straight (no 1px stairsteps) and gives smooth curves on rounded shapes.
export function getSubPixelEdgeCrossing(
  alpha: Uint8Array,
  width: number,
  cx: number,
  cy: number,
  edge: number,
  threshold: number
): Point {
  let a1: number, a2: number;
  let p1x: number, p1y: number, p2x: number, p2y: number;

  switch (edge) {
    case 0: // top: TL → TR
      a1 = alpha[cy * width + cx];
      a2 = alpha[cy * width + (cx + 1)];
      p1x = cx; p1y = cy;
      p2x = cx + 1; p2y = cy;
      break;
    case 1: // right: TR → BR
      a1 = alpha[cy * width + (cx + 1)];
      a2 = alpha[(cy + 1) * width + (cx + 1)];
      p1x = cx + 1; p1y = cy;
      p2x = cx + 1; p2y = cy + 1;
      break;
    case 2: // bottom: BL → BR
      a1 = alpha[(cy + 1) * width + cx];
      a2 = alpha[(cy + 1) * width + (cx + 1)];
      p1x = cx; p1y = cy + 1;
      p2x = cx + 1; p2y = cy + 1;
      break;
    case 3: // left: TL → BL
      a1 = alpha[cy * width + cx];
      a2 = alpha[(cy + 1) * width + cx];
      p1x = cx; p1y = cy;
      p2x = cx; p2y = cy + 1;
      break;
    default:
      return { x: cx + 0.5, y: cy + 0.5 };
  }

  let t = 0.5;
  const denom = a2 - a1;
  if (Math.abs(denom) > 0.5) {
    t = (threshold - a1) / denom;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
  }

  return {
    x: p1x + t * (p2x - p1x),
    y: p1y + t * (p2y - p1y),
  };
}

// Sub-pixel marching squares: topology comes from the binary `mask` (one closed loop per component), vertex positions from interpolating the continuous `alpha` buffer against `threshold` — gives Zero Hero perfectly straight rectangle edges and smooth arcs, which pixel-snapped midpoints would destroy.
export function traceBoundaryMarchingSquaresSubPixel(
  mask: Uint8Array,
  alpha: Uint8Array,
  threshold: number,
  width: number,
  height: number
): Point[] {
  let startCellX = -1, startCellY = -1;
  let startEdge = -1;

  outer: for (let cy = 0; cy < height - 1; cy++) {
    for (let cx = 0; cx < width - 1; cx++) {
      const code = getCellCode(mask, width, height, cx, cy);
      if (code > 0 && code < 15) {
        startCellX = cx;
        startCellY = cy;
        startEdge = getStartEdge(code);
        break outer;
      }
    }
  }

  if (startCellX === -1) {
    return traceBoundarySimple(mask, width, height);
  }

  const path: Point[] = [];
  const visited = new Set<string>();

  let cx = startCellX;
  let cy = startCellY;
  let entryEdge = startEdge;

  const maxSteps = width * height * 2;
  let steps = 0;

  do {
    const key = cx + ',' + cy + ',' + entryEdge;
    if (visited.has(key)) break;
    visited.add(key);

    const code = getCellCode(mask, width, height, cx, cy);
    if (code === 0 || code === 15) break;

    const exitEdge = getExitEdge(code, entryEdge);
    if (exitEdge === -1) break;

    const point = getSubPixelEdgeCrossing(alpha, width, cx, cy, exitEdge, threshold);

    if (path.length === 0 ||
        Math.abs(path[path.length - 1].x - point.x) > 0.001 ||
        Math.abs(path[path.length - 1].y - point.y) > 0.001) {
      path.push(point);
    }

    switch (exitEdge) {
      case 0: cy--; entryEdge = 2; break;
      case 1: cx++; entryEdge = 3; break;
      case 2: cy++; entryEdge = 0; break;
      case 3: cx--; entryEdge = 1; break;
    }

    if (cx < 0 || cx >= width - 1 || cy < 0 || cy >= height - 1) break;
    steps++;
  } while ((cx !== startCellX || cy !== startCellY || entryEdge !== startEdge) && steps < maxSteps);

  if (path.length < 3) return traceBoundarySimple(mask, width, height);
  console.log('[MarchingSquares-SubPixel] Traced', path.length, 'points (threshold=' + threshold + ')');
  return path;
}

// Adaptive alpha threshold for Zero Hero: defaults much lower than the old max(setting,128) (which sliced through AA edges, pulling cuts inside bright outlines) so the trace follows the outermost AA pixel; bumps to 64 if the histogram shows a soft-glow/drop-shadow tail, and always respects an explicit non-default user threshold.
export function chooseZeroHeroAlphaThreshold(alpha: Uint8Array, userOverride?: number): number {
  if (typeof userOverride === 'number' && userOverride !== 128 && userOverride > 0) {
    return Math.max(2, Math.min(254, userOverride));
  }

  let lowCount = 0;   // 1..23 (faint halo / shadow band)
  let midCount = 0;   // 24..199 (real AA band)
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i];
    if (a >= 1 && a < 24) lowCount++;
    else if (a >= 24 && a < 200) midCount++;
  }

  if (lowCount > midCount * 4 && lowCount > 200) {
    console.log('[Worker] Zero hero adaptive threshold: faint halo detected (low=' + lowCount + ', mid=' + midCount + ') → 64');
    return 64;
  }

  return 24;
}

// Detect a uniform background color by sampling a 2px border ring (skipping transparent samples, averaging opaque color, requiring ≥75% agreement within Chebyshev distance 16) — needed because solid-bg images (JPEGs, flattened PNGs) have alpha=255 everywhere so the boundary must come from color difference instead; returns null (fall back to alpha-based tracing) if the border isn't a clear solid color.
export function detectBorderBackgroundColor(
  data: Uint8ClampedArray,
  width: number,
  height: number
): { r: number; g: number; b: number } | null {
  const ringThickness = Math.max(2, Math.floor(Math.min(width, height) * 0.01));
  const sampleStride = Math.max(1, Math.floor(Math.min(width, height) / 200));

  type Sample = { r: number; g: number; b: number };
  const samples: Sample[] = [];

  const collect = (x: number, y: number): void => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const idx = (y * width + x) * 4;
    if (data[idx + 3] < 200) return; // skip mostly-transparent pixels
    samples.push({ r: data[idx], g: data[idx + 1], b: data[idx + 2] });
  };

  for (let r = 0; r < ringThickness; r++) {
    for (let x = 0; x < width; x += sampleStride) {
      collect(x, r);
      collect(x, height - 1 - r);
    }
    for (let y = 0; y < height; y += sampleStride) {
      collect(r, y);
      collect(width - 1 - r, y);
    }
  }

  if (samples.length < 40) {
    console.log('[Worker] detectBorderBackgroundColor: too few opaque border samples (' +
      samples.length + ') — assuming transparent/alpha-keyed image');
    return null;
  }

  let sumR = 0, sumG = 0, sumB = 0;
  for (const s of samples) { sumR += s.r; sumG += s.g; sumB += s.b; }
  const avgR = sumR / samples.length;
  const avgG = sumG / samples.length;
  const avgB = sumB / samples.length;

  let agree = 0;
  for (const s of samples) {
    const d = Math.max(
      Math.abs(s.r - avgR),
      Math.abs(s.g - avgG),
      Math.abs(s.b - avgB)
    );
    if (d <= 16) agree++;
  }

  const agreeRatio = agree / samples.length;
  if (agreeRatio < 0.75) {
    console.log('[Worker] detectBorderBackgroundColor: border not uniform enough (agree=' +
      (agreeRatio * 100).toFixed(0) + '%) — falling back to alpha-based tracing');
    return null;
  }

  const bg = { r: Math.round(avgR), g: Math.round(avgG), b: Math.round(avgB) };

  // Sanity check: a real canvas background is near-achromatic (white/cream/gray/off-black); a highly saturated detected color almost certainly means border samples came from foreground pixels touching the edge (common after Remove-Background + crop, where only foreground tips reach the bbox).
  const maxC = Math.max(bg.r, bg.g, bg.b);
  const minC = Math.min(bg.r, bg.g, bg.b);
  const saturation = maxC === 0 ? 0 : (maxC - minC) / maxC;
  const SATURATION_LIMIT = 0.25;
  if (saturation > SATURATION_LIMIT) {
    console.log('[Worker] detectBorderBackgroundColor: rejected rgb(' +
      bg.r + ',' + bg.g + ',' + bg.b + ') — saturation ' +
      (saturation * 100).toFixed(0) + '% > ' + (SATURATION_LIMIT * 100) +
      '% (likely a foreground color, not the canvas). Falling back to alpha-based tracing.');
    return null;
  }

  console.log('[Worker] detectBorderBackgroundColor: solid bg detected rgb(' +
    bg.r + ',' + bg.g + ',' + bg.b + ') with ' + (agreeRatio * 100).toFixed(0) +
    '% border agreement, saturation ' + (saturation * 100).toFixed(0) + '%');
  return bg;
}

// Build a 0..255 saliency field (Chebyshev color distance from bg, clamped) at super-sampled resolution to replace the alpha buffer for marching squares on solid-bg images; translucent pixels are composited over bg first so transparency and color difference cooperate smoothly, and RGB is bilinearly upscaled so AA edges still produce smooth sub-pixel transitions.
export function buildSaliencyFieldHiRes(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  scale: number,
  bg: { r: number; g: number; b: number }
): Uint8Array {
  const hiW = width * scale;
  const hiH = height * scale;
  const out = new Uint8Array(hiW * hiH);

  for (let y = 0; y < hiH; y++) {
    const srcY = y / scale;
    const y0 = Math.floor(srcY);
    const y1 = Math.min(y0 + 1, height - 1);
    const wy = srcY - y0;

    for (let x = 0; x < hiW; x++) {
      const srcX = x / scale;
      const x0 = Math.floor(srcX);
      const x1 = Math.min(x0 + 1, width - 1);
      const wx = srcX - x0;

      const i00 = (y0 * width + x0) * 4;
      const i10 = (y0 * width + x1) * 4;
      const i01 = (y1 * width + x0) * 4;
      const i11 = (y1 * width + x1) * 4;

      const lerp = (a: number, b: number, t: number) => a * (1 - t) + b * t;
      const r = lerp(lerp(data[i00],     data[i10],     wx), lerp(data[i01],     data[i11],     wx), wy);
      const g = lerp(lerp(data[i00 + 1], data[i10 + 1], wx), lerp(data[i01 + 1], data[i11 + 1], wx), wy);
      const b = lerp(lerp(data[i00 + 2], data[i10 + 2], wx), lerp(data[i01 + 2], data[i11 + 2], wx), wy);
      const a = lerp(lerp(data[i00 + 3], data[i10 + 3], wx), lerp(data[i01 + 3], data[i11 + 3], wx), wy);

      // Composite onto bg by alpha: visible color = source over bg.
      const aN = a / 255;
      const visR = r * aN + bg.r * (1 - aN);
      const visG = g * aN + bg.g * (1 - aN);
      const visB = b * aN + bg.b * (1 - aN);

      // Chebyshev distance is fast and gives 0..255 without weighting.
      const d = Math.max(
        Math.abs(visR - bg.r),
        Math.abs(visG - bg.g),
        Math.abs(visB - bg.b)
      );

      out[y * hiW + x] = Math.min(255, Math.round(d));
    }
  }

  return out;
}

// Rounded-rectangle detector & analytical snap: a hand-traced rounded rect has 1px wobble and bumpy corners, so detect the canonical pattern and replace it with an analytical polygon (4 sides + 4 densely-sampled quarter-arcs); conservative — returns null (falls back to freeform polygon) if sides aren't axis-aligned, corners aren't circular, or the four radii disagree.
export function detectAndSnapRoundedRect(path: Point[]): Point[] | null {
  if (path.length < 24) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of path) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const W = maxX - minX;
  const H = maxY - minY;
  if (W < 8 || H < 8) return null;

  const minDim = Math.min(W, H);
  // Edge tolerance (2% of shorter side, min 0.5px) is how close to the bbox edge a point must be to count as "on the edge".
  const edgeTol = Math.max(0.5, minDim * 0.025);

  const topPts: Point[] = [];
  const bottomPts: Point[] = [];
  const leftPts: Point[] = [];
  const rightPts: Point[] = [];
  const tlPts: Point[] = [];
  const trPts: Point[] = [];
  const brPts: Point[] = [];
  const blPts: Point[] = [];

  for (const p of path) {
    const onTop = p.y - minY <= edgeTol;
    const onBottom = maxY - p.y <= edgeTol;
    const onLeft = p.x - minX <= edgeTol;
    const onRight = maxX - p.x <= edgeTol;

    if (onTop && !onLeft && !onRight) topPts.push(p);
    else if (onBottom && !onLeft && !onRight) bottomPts.push(p);
    else if (onLeft && !onTop && !onBottom) leftPts.push(p);
    else if (onRight && !onTop && !onBottom) rightPts.push(p);
    else {
      const dTL = (p.x - minX) ** 2 + (p.y - minY) ** 2;
      const dTR = (p.x - maxX) ** 2 + (p.y - minY) ** 2;
      const dBR = (p.x - maxX) ** 2 + (p.y - maxY) ** 2;
      const dBL = (p.x - minX) ** 2 + (p.y - maxY) ** 2;
      const m = Math.min(dTL, dTR, dBR, dBL);
      if (m === dTL) tlPts.push(p);
      else if (m === dTR) trPts.push(p);
      else if (m === dBR) brPts.push(p);
      else blPts.push(p);
    }
  }

  // Need real edges (not just corners) and all 4 corners populated.
  const minEdge = Math.max(2, Math.floor(path.length * 0.04));
  if (topPts.length < minEdge || bottomPts.length < minEdge ||
      leftPts.length < minEdge || rightPts.length < minEdge) {
    return null;
  }
  if (tlPts.length < 2 || trPts.length < 2 || brPts.length < 2 || blPts.length < 2) {
    return null;
  }

  // Each axis-aligned edge must be flat in the perpendicular direction.
  const checkAxisFlatness = (pts: Point[], axis: 'x' | 'y'): boolean => {
    let sum = 0;
    for (const p of pts) sum += p[axis];
    const mean = sum / pts.length;
    let maxDev = 0;
    for (const p of pts) {
      const d = Math.abs(p[axis] - mean);
      if (d > maxDev) maxDev = d;
    }
    return maxDev <= edgeTol * 1.2;
  };
  if (!checkAxisFlatness(topPts, 'y')) return null;
  if (!checkAxisFlatness(bottomPts, 'y')) return null;
  if (!checkAxisFlatness(leftPts, 'x')) return null;
  if (!checkAxisFlatness(rightPts, 'x')) return null;

  // Fit each corner to a quarter-circle constrained to the bbox corner (arc center = (cx+r*sx, cy+r*sy) for inward signs sx,sy), solving for r that minimizes radial residual sum via bisection + ternary search.
  type Corner = { cx: number; cy: number; sx: number; sy: number; pts: Point[] };
  const cornersList: Corner[] = [
    { cx: minX, cy: minY, sx: 1, sy: 1, pts: tlPts },
    { cx: maxX, cy: minY, sx: -1, sy: 1, pts: trPts },
    { cx: maxX, cy: maxY, sx: -1, sy: -1, pts: brPts },
    { cx: minX, cy: maxY, sx: 1, sy: -1, pts: blPts },
  ];

  const radii: number[] = [];
  for (const c of cornersList) {
    let maxInset = 0;
    for (const p of c.pts) {
      const ix = (p.x - c.cx) * c.sx;
      const iy = (p.y - c.cy) * c.sy;
      if (ix > maxInset) maxInset = ix;
      if (iy > maxInset) maxInset = iy;
    }
    if (maxInset <= 0) return null;

    const evalLoss = (r: number): number => {
      const acx = c.cx + r * c.sx;
      const acy = c.cy + r * c.sy;
      let loss = 0;
      for (const p of c.pts) {
        const d = Math.sqrt((p.x - acx) ** 2 + (p.y - acy) ** 2);
        loss += (d - r) * (d - r);
      }
      return loss;
    };

    let rLo = maxInset;
    let rHi = Math.max(maxInset * 2, minDim / 2);
    for (let iter = 0; iter < 50; iter++) {
      const r1 = rLo + (rHi - rLo) / 3;
      const r2 = rHi - (rHi - rLo) / 3;
      if (evalLoss(r1) < evalLoss(r2)) rHi = r2;
      else rLo = r1;
    }
    const r = (rLo + rHi) / 2;

    const acx = c.cx + r * c.sx;
    const acy = c.cy + r * c.sy;
    let rmse = 0;
    let maxResidual = 0;
    for (const p of c.pts) {
      const d = Math.sqrt((p.x - acx) ** 2 + (p.y - acy) ** 2);
      rmse += (d - r) ** 2;
      const ar = Math.abs(d - r);
      if (ar > maxResidual) maxResidual = ar;
    }
    rmse = Math.sqrt(rmse / c.pts.length);

    const rmseThresh = Math.max(0.5, r * 0.06);
    const maxResidualThresh = Math.max(1.5, r * 0.15);
    if (rmse > rmseThresh || maxResidual > maxResidualThresh) {
      console.log('[RoundedRect] Corner reject: rmse=' + rmse.toFixed(2) + '/' + rmseThresh.toFixed(2) +
        ', maxRes=' + maxResidual.toFixed(2) + '/' + maxResidualThresh.toFixed(2) + ', r=' + r.toFixed(2));
      return null;
    }
    radii.push(r);
  }

  const rAvg = (radii[0] + radii[1] + radii[2] + radii[3]) / 4;
  for (const r of radii) {
    if (Math.abs(r - rAvg) > Math.max(1.0, rAvg * 0.18)) {
      console.log('[RoundedRect] Radii not uniform: ' + radii.map(rr => rr.toFixed(2)).join(', '));
      return null;
    }
  }

  if (rAvg < 1 || rAvg > minDim / 2 + 1) return null;
  const r = Math.min(rAvg, minDim / 2);

  // Build the analytical polygon with 12 segments per arc (~1° resolution) — smooth on any reasonable canvas/PDF, no aliasing artifacts.
  const ARC_POINTS = 12;
  const result: Point[] = [];
  const addArc = (acx: number, acy: number, startAngle: number, endAngle: number) => {
    for (let i = 0; i <= ARC_POINTS; i++) {
      const t = i / ARC_POINTS;
      const a = startAngle + (endAngle - startAngle) * t;
      result.push({ x: acx + r * Math.cos(a), y: acy + r * Math.sin(a) });
    }
  };

  // y is down in image/canvas coords: TL(minX+r,minY+r) spans 180°→270°, TR(maxX-r,minY+r) 270°→360°, BR(maxX-r,maxY-r) 0°→90°, BL(minX+r,maxY-r) 90°→180°.
  const PI = Math.PI;
  addArc(minX + r, minY + r, PI, 1.5 * PI);
  addArc(maxX - r, minY + r, 1.5 * PI, 2 * PI);
  addArc(maxX - r, maxY - r, 0, 0.5 * PI);
  addArc(minX + r, maxY - r, 0.5 * PI, PI);

  console.log('[RoundedRect] SNAPPED: bbox=' + W.toFixed(2) + 'x' + H.toFixed(2) + ', r=' + r.toFixed(2));
  return result;
}

// Simple Moore-neighbor tracing (fallback).
export function traceBoundarySimple(mask: Uint8Array, width: number, height: number): Point[] {
  let startX = -1, startY = -1;
  outer: for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 1) {
        startX = x;
        startY = y;
        break outer;
      }
    }
  }
  
  if (startX === -1) return [];
  
  const path: Point[] = [];
  const directions = [
    { dx: 1, dy: 0 },
    { dx: 1, dy: 1 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 1 },
    { dx: -1, dy: 0 },
    { dx: -1, dy: -1 },
    { dx: 0, dy: -1 },
    { dx: 1, dy: -1 }
  ];
  
  let x = startX, y = startY;
  let dir = 0;
  const maxSteps = width * height * 2;
  let steps = 0;
  
  do {
    path.push({ x, y });
    
    let found = false;
    for (let i = 0; i < 8; i++) {
      const checkDir = (dir + 6 + i) % 8;
      const nx = x + directions[checkDir].dx;
      const ny = y + directions[checkDir].dy;
      
      if (nx >= 0 && nx < width && ny >= 0 && ny < height && mask[ny * width + nx] === 1) {
        x = nx;
        y = ny;
        dir = checkDir;
        found = true;
        break;
      }
    }
    
    if (!found) break;
    steps++;
  } while ((x !== startX || y !== startY) && steps < maxSteps);
  
  return path;
}

// Main boundary tracing function: uses Moore-neighbor tracing, which works reliably on 4x upscaled masks (upscaling gives enough sub-pixel accuracy for smooth contours).
export function traceBoundary(mask: Uint8Array, width: number, height: number): Point[] {
  // Use simple Moore neighbor tracing - reliable and works well with 4x upscaling
  return traceBoundarySimple(mask, width, height);
}

// Result of contour complexity analysis.
export interface ComplexityAnalysis {
  perimeterAreaRatio: number;
  concavityScore: number;
  narrowGapCount: number;
  contourCount: number;
  needsComplexProcessing: boolean;
  needsSmoothCorners: boolean;
}

// Analyze complexity across multiple contours (critical for multi-letter text, one contour per letter): few contours (1-3) with high individual complexity → Complex algorithm (script font); many contours (4+) with low complexity → Shapes algorithm (block text); single contour with deep indentations → Complex algorithm.
export function analyzeMultiContourComplexity(contours: Point[][], effectiveDPI: number): ComplexityAnalysis {
  if (contours.length === 0) {
    return { perimeterAreaRatio: 0, concavityScore: 0, narrowGapCount: 0, contourCount: 0, needsComplexProcessing: false, needsSmoothCorners: false };
  }
  
  // Filter out very small contours (letter holes like O, R) — they can have high perimeter-to-area ratios and shouldn't trigger complex processing.
  const minContourArea = (0.02 * effectiveDPI) ** 2; // Minimum 0.02" x 0.02" = 0.0004 sq inches
  
  const significantContours = contours.filter(c => {
    if (c.length < 10) return false;
    let signedArea = 0;
    for (let i = 0; i < c.length; i++) {
      const j = (i + 1) % c.length;
      signedArea += c[i].x * c[j].y - c[j].x * c[i].y;
    }
    const area = Math.abs(signedArea / 2);
    return area >= minContourArea;
  });
  
  // If no significant contours, use original contours
  const contoursToAnalyze = significantContours.length > 0 ? significantContours : contours;
  const contourCount = contoursToAnalyze.length;
  
  console.log('[Worker] Contour filtering:', contours.length, 'total,', significantContours.length, 'significant (min area:', minContourArea.toFixed(0), 'px²)');
  
  // Analyze each significant contour individually
  const individualAnalyses = contoursToAnalyze.map(c => analyzeContourComplexity(c, effectiveDPI));
  
  // Aggregate metrics (weighted average by contour size)
  let totalPerimeter = 0;
  let totalArea = 0;
  let weightedConcavity = 0;
  let totalNarrowGaps = 0;
  
  for (let i = 0; i < contoursToAnalyze.length; i++) {
    const points = contoursToAnalyze[i];
    const analysis = individualAnalyses[i];
    
    // Calculate perimeter and area for weighting
    let perimeter = 0;
    for (let j = 0; j < points.length; j++) {
      const p1 = points[j];
      const p2 = points[(j + 1) % points.length];
      perimeter += Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
    }
    
    let signedArea = 0;
    for (let j = 0; j < points.length; j++) {
      const k = (j + 1) % points.length;
      signedArea += points[j].x * points[k].y - points[k].x * points[j].y;
    }
    const area = Math.abs(signedArea / 2);
    
    totalPerimeter += perimeter;
    totalArea += area;
    weightedConcavity += analysis.concavityScore * area;
    totalNarrowGaps += analysis.narrowGapCount;
  }
  
  // Calculate aggregate metrics
  const perimeterAreaRatio = totalArea > 0 ? totalPerimeter / Math.sqrt(totalArea) : 0;
  const concavityScore = totalArea > 0 ? weightedConcavity / totalArea : 0;
  
  // Key insight: multi-letter block text has many simple contours, while script fonts typically trace as 1-2 connected contours with deep indentations.
  
  // Check if individual contours show script font characteristics
  const hasComplexContour = individualAnalyses.some(a => 
    a.perimeterAreaRatio > 20 ||  // Very complex individual shape
    a.concavityScore > 0.8 ||     // Many sharp turns in single shape
    a.narrowGapCount > 3          // Narrow gaps within single shape
  );
  
  // Multi-letter block text detection: many (4+) separate, simple contours = block text like "TERCOS".
  const isMultiLetterBlockText = contourCount >= 4 && 
    individualAnalyses.every(a => 
      a.perimeterAreaRatio < 12 &&  // Each letter is relatively simple
      a.concavityScore < 0.6        // No excessive sharp turns
    );
  
  // Multi-component organic design detection: 3+ separate elements with transparent gaps (logos, illustrations) need smooth/rounded corners because bridging creates artificial corners that look unnatural with sharp miter joins; block text is excluded since it works best with sharp corners.
  const isMultiComponentOrganic = contourCount >= 3 && !isMultiLetterBlockText;
  
  // Script font detection: few contours (1-2), or any single contour showing high complexity.
  const needsComplexProcessing = hasComplexContour && !isMultiLetterBlockText;
  
  // Smooth corners are used when the design needs complex processing (script fonts, intricate shapes) or has multiple organic components with gaps (logos); sharp corners are reserved for block text with simple letter shapes.
  const needsSmoothCorners = needsComplexProcessing || isMultiComponentOrganic;
  
  console.log('[Worker] Multi-contour analysis:', {
    contourCount,
    hasComplexContour,
    isMultiLetterBlockText,
    isMultiComponentOrganic,
    needsSmoothCorners,
    individualRatios: individualAnalyses.map(a => a.perimeterAreaRatio.toFixed(2))
  });
  
  return {
    perimeterAreaRatio,
    concavityScore,
    narrowGapCount: totalNarrowGaps,
    contourCount,
    needsComplexProcessing,
    needsSmoothCorners
  };
}

// Analyze contour complexity to auto-detect if the Complex algorithm is needed, using perimeter-to-area ratio, sharp-angle count, and narrow-gap detection (all typical of script fonts).
export function analyzeContourComplexity(points: Point[], effectiveDPI: number): ComplexityAnalysis {
  if (points.length < 10) {
    return { perimeterAreaRatio: 0, concavityScore: 0, narrowGapCount: 0, contourCount: 1, needsComplexProcessing: false, needsSmoothCorners: false };
  }
  
  // Calculate perimeter
  let perimeter = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    perimeter += Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
  }
  
  // Calculate area using shoelace formula
  let signedArea = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    signedArea += points[i].x * points[j].y - points[j].x * points[i].y;
  }
  const area = Math.abs(signedArea / 2);
  
  // Determine winding direction (positive = CCW, negative = CW in canvas coords)
  const isCCW = signedArea < 0; // Canvas Y is inverted
  
  // Perimeter-to-area ratio (normalized by sqrt(area) for scale independence): higher = more complex/jagged; circle ~3.54, square ~4.0, script fonts typically > 8.
  const perimeterAreaRatio = area > 0 ? perimeter / Math.sqrt(area) : 0;
  
  // Analyze sharp turns (orientation-independent): count vertices with angle change < 120°.
  let sharpTurnCount = 0;
  let totalSharpness = 0;
  
  for (let i = 0; i < points.length; i++) {
    const prev = points[(i - 1 + points.length) % points.length];
    const curr = points[i];
    const next = points[(i + 1) % points.length];
    
    // Vector from prev to curr
    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    // Vector from curr to next
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    
    const len1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const len2 = Math.sqrt(v2x * v2x + v2y * v2y);
    
    if (len1 > 0.001 && len2 > 0.001) {
      // Angle between vectors (orientation-independent)
      const dot = v1x * v2x + v1y * v2y;
      const cosAngle = Math.max(-1, Math.min(1, dot / (len1 * len2)));
      const angleDeg = Math.acos(cosAngle) * 180 / Math.PI;
      
      // A sharp turn is an angle between segments < 120° (a significant direction change).
      if (angleDeg < 120) {
        sharpTurnCount++;
        // Weight sharper turns more heavily
        totalSharpness += (120 - angleDeg) / 120;
      }
    }
  }
  
  // Concavity score: ratio of sharp turns weighted by sharpness, normalized by point count for scale independence.
  const concavityScore = points.length > 0 ? (totalSharpness / points.length) * 10 : 0;
  
  // Detect narrow gaps: sequences of points forming deep indentations where two parts of the contour come close together.
  const gapThresholdPixels = 0.12 * effectiveDPI; // 0.12" gap threshold
  let narrowGapCount = 0;
  
  // Sample every nth point to check for nearby non-adjacent points
  const sampleStep = Math.max(1, Math.floor(points.length / 150));
  const minIndexDistance = Math.floor(points.length / 8); // Points must be far apart in sequence
  
  for (let i = 0; i < points.length; i += sampleStep) {
    const p1 = points[i];
    
    // Check for nearby points that are far apart in the sequence (indicating a narrow gap)
    for (let j = i + minIndexDistance; j < points.length - minIndexDistance; j += sampleStep) {
      const p2 = points[j];
      const dist = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
      
      if (dist < gapThresholdPixels) {
        narrowGapCount++;
      }
    }
  }
  
  // Decision thresholds tuned for script vs block fonts: script fonts have perimeter-to-area ratio > 15 (circle=3.54, square=4), concavity/sharpness > 0.5, and > 5 narrow gaps — block text like "Tercos" should not trigger complex processing.
  const needsComplexProcessing = 
    perimeterAreaRatio > 15 ||      // Very complex outline (script fonts are typically > 15)
    concavityScore > 0.5 ||         // Many sharp turns (raised threshold)
    narrowGapCount > 5;             // Multiple narrow gaps detected (raised threshold)
  
  return {
    perimeterAreaRatio,
    concavityScore,
    narrowGapCount,
    contourCount: 1,
    needsComplexProcessing,
    needsSmoothCorners: needsComplexProcessing
  };
}

export interface ScatteredDesignAnalysis {
  isScattered: boolean;
  significantContours: Point[][];
  maxGapPixels: number;
  totalBoundsArea: number;
  contentAreaRatio: number;
}

export function detectScatteredDesign(
  contours: Point[][],
  effectiveDPI: number
): ScatteredDesignAnalysis {
  const noResult: ScatteredDesignAnalysis = {
    isScattered: false,
    significantContours: [],
    maxGapPixels: 0,
    totalBoundsArea: 0,
    contentAreaRatio: 1
  };

  if (contours.length < 2) return noResult;

  const minSignificantArea = (0.05 * effectiveDPI) ** 2;

  const significant: { points: Point[]; bounds: BoundingBox; area: number }[] = [];
  for (const c of contours) {
    if (c.length < 10) continue;
    const area = computePolygonArea(c);
    if (area >= minSignificantArea) {
      significant.push({ points: c, bounds: computeBounds(c), area });
    }
  }

  if (significant.length < 2) return noResult;

  let globalMinX = Infinity, globalMinY = Infinity;
  let globalMaxX = -Infinity, globalMaxY = -Infinity;
  let totalContentArea = 0;

  for (const s of significant) {
    if (s.bounds.minX < globalMinX) globalMinX = s.bounds.minX;
    if (s.bounds.minY < globalMinY) globalMinY = s.bounds.minY;
    if (s.bounds.maxX > globalMaxX) globalMaxX = s.bounds.maxX;
    if (s.bounds.maxY > globalMaxY) globalMaxY = s.bounds.maxY;
    totalContentArea += s.area;
  }

  const totalBoundsWidth = globalMaxX - globalMinX;
  const totalBoundsHeight = globalMaxY - globalMinY;
  const totalBoundsArea = totalBoundsWidth * totalBoundsHeight;

  if (totalBoundsArea <= 0) return noResult;

  const contentAreaRatio = totalContentArea / totalBoundsArea;

  let maxGap = 0;
  for (let i = 0; i < significant.length; i++) {
    let minDistToAny = Infinity;
    for (let j = 0; j < significant.length; j++) {
      if (i === j) continue;
      const a = significant[i].bounds;
      const b = significant[j].bounds;
      const gapX = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
      const gapY = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
      const dist = Math.sqrt(gapX * gapX + gapY * gapY);
      if (dist < minDistToAny) minDistToAny = dist;
    }
    if (minDistToAny > maxGap) maxGap = minDistToAny;
  }

  const minAbsoluteGapInches = 0.25;
  const minAbsoluteGapPixels = minAbsoluteGapInches * effectiveDPI;
  const hasDistantElements = maxGap > minAbsoluteGapPixels;
  const hasLowDensity = contentAreaRatio < 0.35;
  const hasMultipleSignificant = significant.length >= 2;
  const smallestSignificantArea = Math.min(...significant.map(s => s.area));
  const noTinySpecks = smallestSignificantArea >= minSignificantArea;

  const isBlockText = significant.length >= 4 && significant.every(s => {
    const w = s.bounds.maxX - s.bounds.minX;
    const h = s.bounds.maxY - s.bounds.minY;
    const aspectRatio = w > 0 && h > 0 ? Math.max(w, h) / Math.min(w, h) : 1;
    return aspectRatio < 5;
  });

  const isFewLargeComponents = significant.length <= 5;

  const isScattered = hasDistantElements && hasLowDensity && hasMultipleSignificant && noTinySpecks && !isBlockText && isFewLargeComponents;

  console.log('[Worker] Scattered design detection:', {
    significantContours: significant.length,
    maxGapPixels: maxGap.toFixed(1),
    maxGapInches: (maxGap / effectiveDPI).toFixed(3),
    contentAreaRatio: contentAreaRatio.toFixed(3),
    hasDistantElements,
    hasLowDensity,
    isBlockText,
    isScattered
  });

  return {
    isScattered,
    significantContours: significant.map(s => s.points),
    maxGapPixels: maxGap,
    totalBoundsArea,
    contentAreaRatio
  };
}

export function processScatteredContours(
  contours: Point[][],
  maxGapPixels: number,
  effectiveDPI: number
): Point[] {
  if (contours.length === 0) return [];
  if (contours.length === 1) return contours[0];

  const expandDistance = Math.ceil(maxGapPixels / 2) + Math.round(0.023 * effectiveDPI);

  console.log('[Worker] processScatteredContours: bridging', contours.length,
    'contours with expand distance:', expandDistance, 'px (',
    (expandDistance / effectiveDPI).toFixed(3), 'in)');

  const scaledExpand = expandDistance * CLIPPER_SCALE;

  const coExpand = new ClipperLib.ClipperOffset();
  coExpand.ArcTolerance = CLIPPER_SCALE * 0.25;
  coExpand.MiterLimit = 2.0;

  for (const contour of contours) {
    if (contour.length < 3) continue;
    const clipperPath = contour.map(p => ({
      X: Math.round(p.x * CLIPPER_SCALE),
      Y: Math.round(p.y * CLIPPER_SCALE)
    }));
    coExpand.AddPath(clipperPath, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  }

  const expandedPaths: Array<Array<{X: number; Y: number}>> = [];
  coExpand.Execute(expandedPaths, scaledExpand);

  if (expandedPaths.length === 0) {
    console.log('[Worker] processScatteredContours: expand failed, fallback to largest');
    let best = contours[0];
    let bestArea = computePolygonArea(contours[0]);
    for (let i = 1; i < contours.length; i++) {
      const a = computePolygonArea(contours[i]);
      if (a > bestArea) { bestArea = a; best = contours[i]; }
    }
    return best;
  }

  console.log('[Worker] processScatteredContours: expanded to', expandedPaths.length, 'paths');

  const clipper = new ClipperLib.Clipper();
  for (const path of expandedPaths) {
    clipper.AddPath(path, ClipperLib.PolyType.ptSubject, true);
  }

  const unionResult: Array<Array<{X: number; Y: number}>> = [];
  clipper.Execute(ClipperLib.ClipType.ctUnion, unionResult,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);

  if (unionResult.length === 0) {
    console.log('[Worker] processScatteredContours: union failed');
    return expandedPaths[0].map(p => ({ x: p.X / CLIPPER_SCALE, y: p.Y / CLIPPER_SCALE }));
  }

  console.log('[Worker] processScatteredContours: union produced', unionResult.length, 'paths');

  const coShrink = new ClipperLib.ClipperOffset();
  coShrink.ArcTolerance = CLIPPER_SCALE * 0.25;
  coShrink.MiterLimit = 2.0;

  for (const path of unionResult) {
    coShrink.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  }

  const shrunkPaths: Array<Array<{X: number; Y: number}>> = [];
  coShrink.Execute(shrunkPaths, -scaledExpand);

  let finalPaths = shrunkPaths.length > 0 ? shrunkPaths : unionResult;

  console.log('[Worker] processScatteredContours: shrink produced', finalPaths.length, 'paths');

  let resultPath = finalPaths[0];
  let largestArea = Math.abs(ClipperLib.Clipper.Area(finalPaths[0]));

  for (let i = 1; i < finalPaths.length; i++) {
    const area = Math.abs(ClipperLib.Clipper.Area(finalPaths[i]));
    if (area > largestArea) {
      largestArea = area;
      resultPath = finalPaths[i];
    }
  }

  ClipperLib.Clipper.CleanPolygon(resultPath, CLIPPER_SCALE * 0.107);

  const result = resultPath.map(p => ({
    x: p.X / CLIPPER_SCALE,
    y: p.Y / CLIPPER_SCALE
  }));

  console.log('[Worker] processScatteredContours: final contour', result.length, 'points');
  return result;
}

// Bounding box for a contour.
export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// A contour with its bounding box, for clustering.
export interface ContourWithBounds {
  points: Point[];
  bounds: BoundingBox;
  area: number;
}

// Compute the bounding box for a set of points.
export function computeBounds(points: Point[]): BoundingBox {
  if (points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  
  let minX = points[0].x, maxX = points[0].x;
  let minY = points[0].y, maxY = points[0].y;
  
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  
  return { minX, minY, maxX, maxY };
}

// Compute signed polygon area via the shoelace formula.
export function computePolygonArea(points: Point[]): number {
  if (points.length < 3) return 0;
  
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y - points[j].x * points[i].y;
  }
  return Math.abs(area / 2);
}

// Check if two bounding boxes are within a threshold distance via expanded-bbox intersection test.
export function boundsWithinDistance(a: BoundingBox, b: BoundingBox, distance: number): boolean {
  // Expand box A by distance on all sides
  const expandedA = {
    minX: a.minX - distance,
    minY: a.minY - distance,
    maxX: a.maxX + distance,
    maxY: a.maxY + distance
  };
  
  // Check if expanded A intersects B
  return !(expandedA.maxX < b.minX || b.maxX < expandedA.minX ||
           expandedA.maxY < b.minY || b.maxY < expandedA.minY);
}

export function unionBounds(a: BoundingBox, b: BoundingBox): BoundingBox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY)
  };
}

export function boundsArea(b: BoundingBox): number {
  return (b.maxX - b.minX) * (b.maxY - b.minY);
}

export function boundsIntersectionArea(a: BoundingBox, b: BoundingBox): number {
  const overlapX = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const overlapY = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  return overlapX * overlapY;
}

// Trace all separate contours from a mask via connected-component labeling: flood-fill each component then trace its boundary once, returning one closed polygon per contour.
export function traceAllContours(mask: Uint8Array, width: number, height: number): Point[][] {
  const componentLabel = new Int32Array(width * height); // 0 = unlabeled, >0 = component ID
  const contours: Point[][] = [];
  let currentLabel = 0;
  
  // Flood fill helper using iterative approach (avoids stack overflow)
  function floodFillComponent(startX: number, startY: number, label: number): void {
    const stack: Array<{x: number, y: number}> = [{x: startX, y: startY}];
    
    while (stack.length > 0) {
      const {x, y} = stack.pop()!;
      const idx = y * width + x;
      
      // Skip if out of bounds, not foreground, or already labeled
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      if (mask[idx] !== 1 || componentLabel[idx] !== 0) continue;
      
      // Label this pixel
      componentLabel[idx] = label;
      
      // Add 4-connected neighbors (8-connected would work too)
      stack.push({x: x + 1, y: y});
      stack.push({x: x - 1, y: y});
      stack.push({x: x, y: y + 1});
      stack.push({x: x, y: y - 1});
    }
  }
  
  // First pass: label all connected components using flood fill
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx] === 1 && componentLabel[idx] === 0) {
        currentLabel++;
        floodFillComponent(x, y, currentLabel);
      }
    }
  }
  
  console.log('[Worker] traceAllContours: found', currentLabel, 'connected components');
  
  // Second pass: for each component, find a boundary pixel and trace the contour
  const componentTraced = new Set<number>();
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const label = componentLabel[idx];
      
      if (label <= 0 || componentTraced.has(label)) continue;
      
      // Check if this is a boundary pixel (has at least one background neighbor)
      let isBoundary = false;
      for (let dy = -1; dy <= 1 && !isBoundary; dy++) {
        for (let dx = -1; dx <= 1 && !isBoundary; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
            isBoundary = true;
          } else if (mask[ny * width + nx] !== 1) {
            isBoundary = true;
          }
        }
      }
      
      if (!isBoundary) continue;
      
      // Trace the contour for this component
      const contour = traceBoundaryForComponent(mask, width, height, x, y);
      
      if (contour.length >= 3) {
        contours.push(contour);
        componentTraced.add(label);
      }
    }
  }
  
  console.log('[Worker] traceAllContours: traced', contours.length, 'contours from', currentLabel, 'components');
  return contours;
}

// Trace the boundary of a single component using Moore-neighbor tracing.
export function traceBoundaryForComponent(
  mask: Uint8Array, 
  width: number, 
  height: number, 
  startX: number, 
  startY: number
): Point[] {
  const path: Point[] = [];
  const directions = [
    { dx: 1, dy: 0 },
    { dx: 1, dy: 1 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 1 },
    { dx: -1, dy: 0 },
    { dx: -1, dy: -1 },
    { dx: 0, dy: -1 },
    { dx: 1, dy: -1 }
  ];
  
  let x = startX, y = startY;
  let dir = 0;
  const maxSteps = width * height;
  let steps = 0;
  
  do {
    path.push({ x, y });
    
    let found = false;
    for (let i = 0; i < 8; i++) {
      const checkDir = (dir + 6 + i) % 8;
      const nx = x + directions[checkDir].dx;
      const ny = y + directions[checkDir].dy;
      
      if (nx >= 0 && nx < width && ny >= 0 && ny < height && mask[ny * width + nx] === 1) {
        x = nx;
        y = ny;
        dir = checkDir;
        found = true;
        break;
      }
    }
    
    if (!found) break;
    steps++;
  } while ((x !== startX || y !== startY) && steps < maxSteps);
  
  return path;
}

// Compute minimum distance between two polygons via point-to-point sampling (every Nth point on larger polygons, for efficiency).
export function minDistanceBetweenContours(a: Point[], b: Point[]): number {
  let minDist = Infinity;
  const stepA = a.length > 200 ? Math.ceil(a.length / 200) : 1;
  const stepB = b.length > 200 ? Math.ceil(b.length / 200) : 1;

  for (let i = 0; i < a.length; i += stepA) {
    for (let j = 0; j < b.length; j += stepB) {
      const dx = a[i].x - b[j].x;
      const dy = a[i].y - b[j].y;
      const d = dx * dx + dy * dy;
      if (d < minDist) minDist = d;
    }
  }
  return Math.sqrt(minDist);
}

export function orphanAttach(contours: Point[][], attachDistPixels: number): Point[][] {
  if (contours.length <= 1 || attachDistPixels <= 0) return contours;

  const enriched = contours.map((pts, idx) => {
    const area = computePolygonArea(pts);
    const absArea = Math.abs(area);
    const bounds = computeBounds(pts);
    return { points: pts, area, absArea, bounds, idx };
  });

  const globalBounds = enriched.reduce((acc, c) => unionBounds(acc, c.bounds), enriched[0].bounds);
  const gcx = (globalBounds.minX + globalBounds.maxX) / 2;
  const gcy = (globalBounds.minY + globalBounds.maxY) / 2;

  enriched.sort((a, b) => b.absArea - a.absArea);

  const TOP_N = Math.min(12, enriched.length);
  let mainIdx = 0;
  let bestScore = -Infinity;

  for (let i = 0; i < TOP_N; i++) {
    const b = enriched[i].bounds;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;

    const distToCenter = Math.hypot(cx - gcx, cy - gcy);
    const overlap = boundsIntersectionArea(b, globalBounds) / Math.max(1, boundsArea(b));
    const score = (enriched[i].absArea) * (0.6 + 0.8 * overlap) - distToCenter * 5.0;

    if (score > bestScore) {
      bestScore = score;
      mainIdx = i;
    }
  }

  const chosenMain = enriched.splice(mainIdx, 1)[0];
  enriched.unshift(chosenMain);

  let mainContour = chosenMain.points;
  let mainBounds = chosenMain.bounds;

  const remaining: Point[][] = [];
  const candidates: Point[][] = [];

  for (let i = 1; i < enriched.length; i++) {
    const c = enriched[i];

    if (c.absArea < chosenMain.absArea * 0.01 && !boundsWithinDistance(mainBounds, c.bounds, attachDistPixels)) {
      continue;
    }

    if (boundsWithinDistance(mainBounds, c.bounds, attachDistPixels)) {
      const dist = minDistanceBetweenContours(mainContour, c.points);
      if (dist <= attachDistPixels) {
        candidates.push(c.points);
        continue;
      }
    }
    remaining.push(c.points);
  }

  console.log('[Worker] orphanAttach:',
    'main absArea:', Math.round(chosenMain.absArea),
    'signedArea:', Math.round(chosenMain.area),
    'candidates:', candidates.length,
    'remaining:', remaining.length,
    'attachDist:', attachDistPixels.toFixed(1), 'px'
  );

  if (candidates.length === 0) return [mainContour, ...remaining];

  const merged = multiPathVectorMerge([mainContour, ...candidates], attachDistPixels);
  if (merged.length >= 3) {
    mainContour = merged;
    console.log('[Worker] orphanAttach: merged', candidates.length, 'orphans');
    return [mainContour, ...remaining];
  }

  console.log('[Worker] orphanAttach: merge degenerate, returning unmerged');
  return [chosenMain.points, ...remaining];
}

// Cluster contours by proximity using Union-Find; returns arrays of contour indices, one array per cluster.
export function clusterContoursByProximity(
  contours: ContourWithBounds[],
  thresholdPixels: number,
  smallThresholdPixels?: number
): number[][] {
  const n = contours.length;
  if (n <= 1) return n === 1 ? [[0]] : [];

  const absAreas = contours.map(c => Math.abs(c.area));
  const maxAbsArea = Math.max(...absAreas);
  const smallAreaCutoff = maxAbsArea * 0.25;

  const hasSmallThreshold =
    smallThresholdPixels !== undefined &&
    smallThresholdPixels > 0;

  const parent = Array.from({ length: n }, (_, i) => i);
  const rank = new Array(n).fill(0);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  function union(x: number, y: number): void {
    let px = find(x), py = find(y);
    if (px === py) return;
    if (rank[px] < rank[py]) parent[px] = py;
    else if (rank[px] > rank[py]) parent[py] = px;
    else { parent[py] = px; rank[px]++; }
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const eitherSmall = hasSmallThreshold &&
        (absAreas[i] < smallAreaCutoff || absAreas[j] < smallAreaCutoff);

      const pairThreshold = eitherSmall ? smallThresholdPixels! : thresholdPixels;

      if (boundsWithinDistance(contours[i].bounds, contours[j].bounds, pairThreshold)) {
        const d = minDistanceBetweenContours(contours[i].points, contours[j].points);
        if (d <= pairThreshold) union(i, j);
      }
    }
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const arr = clusters.get(root);
    if (arr) arr.push(i);
    else clusters.set(root, [i]);
  }

  return Array.from(clusters.values());
}

// Process clusters with cluster-based bridging: dense clusters (multiple contours nearby) use union + vectorCloseMerge, isolated contours use standard offset only; returns contours ready for final offset.
export function processContoursWithClustering(
  rawContours: Point[][],
  clusterThresholdPixels: number,
  gapClosePixels: number,
  effectiveDPI: number,
  smallClusterThresholdPixels?: number
): Point[] {
  if (rawContours.length === 0) return [];
  
  // Build contours with bounds and area
  const contours: ContourWithBounds[] = rawContours.map(points => ({
    points,
    bounds: computeBounds(points),
    area: computePolygonArea(points)
  }));
  
  // Even with only one contour, apply gap closing to fill narrow indentations — handles script fonts where letters connect via background but have deep "dips" between them that need smoothing.
  if (contours.length === 1) {
    console.log('[Worker] Single contour detected, applying gap closing to fill indentations');
    
    if (gapClosePixels > 0) {
      // Apply vectorCloseMerge to close narrow indentations/gaps within the contour
      const bridgedPath = vectorCloseMerge(contours[0].points, gapClosePixels);
      console.log('[Worker] vectorCloseMerge: input', contours[0].points.length, 'pts -> output', bridgedPath.length, 'pts');
      return bridgedPath;
    }
    
    return contours[0].points;
  }
  
  // Cluster by proximity
  const clusters = clusterContoursByProximity(contours, clusterThresholdPixels, smallClusterThresholdPixels);
  console.log('[Worker] Clustered', contours.length, 'contours into', clusters.length, 'groups');
  
  const processedContours: Point[][] = [];
  
  for (let ci = 0; ci < clusters.length; ci++) {
    const clusterIndices = clusters[ci];
    const clusterContours = clusterIndices.map(i => contours[i]);
    
    if (clusterIndices.length === 1) {
      // Group B: Isolated/Solid - skip bridging, use standard processing
      console.log('[Worker] Cluster', ci, ': ISOLATED (1 contour, area:', Math.round(clusterContours[0].area), 'px²)');
      processedContours.push(clusterContours[0].points);
    } else {
      // Group A (Dense/Script): expand-then-shrink on ALL contours together merges non-overlapping nearby shapes into a single outline.
      console.log('[Worker] Cluster', ci, ': DENSE (', clusterIndices.length, 'contours) - applying multi-path Buffer&Shrink');
      
      if (gapClosePixels > 0) {
        // multiPathVectorMerge (expand all contours, union, then shrink) properly merges separate letters that don't physically overlap.
        const bridgedPath = multiPathVectorMerge(
          clusterContours.map(c => c.points),
          gapClosePixels
        );
        processedContours.push(bridgedPath);
      } else {
        // No gap closing - just union (for non-overlapping, picks largest)
        const unionedPath = unionClusterContours(clusterContours.map(c => c.points));
        processedContours.push(unionedPath);
      }
    }
  }
  
  // If multiple processed contours, union them all into final result
  if (processedContours.length === 0) return [];
  if (processedContours.length === 1) return processedContours[0];
  
  // Final merge: bridge remaining separate clusters with expand-then-shrink, using the larger of gapClosePixels/clusterThreshold/smallClusterThreshold so isolated small contours (decorative stars, dots) get absorbed.
  const finalGap = Math.max(
    gapClosePixels,
    clusterThresholdPixels,
    smallClusterThresholdPixels || 0
  );
  console.log('[Worker] Final merge of', processedContours.length, 'processed clusters with gap:', finalGap, 'px');
  return multiPathVectorMerge(processedContours, finalGap);
}

// Multi-path Vector Merge: expand all contours by +gapPixels (now overlapping), union them, then shrink by -gapPixels — properly merges script-font letters that are close but don't physically touch.
export function multiPathVectorMerge(contours: Point[][], gapPixels: number): Point[] {
  if (contours.length === 0) return [];
  if (contours.length === 1) return contours[0];
  if (gapPixels <= 0) return unionClusterContours(contours);
  
  console.log('[Worker] multiPathVectorMerge: input', contours.length, 'contours, gap:', gapPixels, 'px');
  
  const scaledGap = gapPixels * CLIPPER_SCALE;
  
  // Step 1: Expand ALL contours by +gapPixels using ClipperOffset
  const coExpand = new ClipperLib.ClipperOffset();
  coExpand.ArcTolerance = CLIPPER_SCALE * 0.25;
  coExpand.MiterLimit = 2.0;
  
  for (const contour of contours) {
    if (contour.length < 3) continue;
    const clipperPath = contour.map(p => ({
      X: Math.round(p.x * CLIPPER_SCALE),
      Y: Math.round(p.y * CLIPPER_SCALE)
    }));
    coExpand.AddPath(clipperPath, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  }
  
  const expandedPaths: Array<Array<{X: number; Y: number}>> = [];
  coExpand.Execute(expandedPaths, scaledGap);
  
  if (expandedPaths.length === 0) {
    console.log('[Worker] multiPathVectorMerge: expand failed, returning first contour');
    return contours[0];
  }
  
  console.log('[Worker] multiPathVectorMerge: after expand (+', gapPixels, 'px):', expandedPaths.length, 'paths');
  
  // Step 2: Union all expanded paths (they should now overlap where gaps were small)
  const clipper = new ClipperLib.Clipper();
  for (const path of expandedPaths) {
    clipper.AddPath(path, ClipperLib.PolyType.ptSubject, true);
  }
  
  const unionResult: Array<Array<{X: number; Y: number}>> = [];
  clipper.Execute(ClipperLib.ClipType.ctUnion, unionResult,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  
  if (unionResult.length === 0) {
    console.log('[Worker] multiPathVectorMerge: union failed, using expanded');
    // Fall back to largest expanded path
    let largest = expandedPaths[0];
    let largestArea = Math.abs(ClipperLib.Clipper.Area(expandedPaths[0]));
    for (let i = 1; i < expandedPaths.length; i++) {
      const area = Math.abs(ClipperLib.Clipper.Area(expandedPaths[i]));
      if (area > largestArea) {
        largestArea = area;
        largest = expandedPaths[i];
      }
    }
    return largest.map(p => ({ x: p.X / CLIPPER_SCALE, y: p.Y / CLIPPER_SCALE }));
  }
  
  console.log('[Worker] multiPathVectorMerge: after union:', unionResult.length, 'paths');
  
  // Step 3: Shrink all unioned paths by -gapPixels
  const coShrink = new ClipperLib.ClipperOffset();
  coShrink.ArcTolerance = CLIPPER_SCALE * 0.25;
  coShrink.MiterLimit = 2.0;
  
  for (const path of unionResult) {
    coShrink.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  }
  
  const shrunkPaths: Array<Array<{X: number; Y: number}>> = [];
  coShrink.Execute(shrunkPaths, -scaledGap);
  
  if (shrunkPaths.length === 0) {
    console.log('[Worker] multiPathVectorMerge: shrink failed, using union result');
    // Fall back to largest union result
    let largest = unionResult[0];
    let largestArea = Math.abs(ClipperLib.Clipper.Area(unionResult[0]));
    for (let i = 1; i < unionResult.length; i++) {
      const area = Math.abs(ClipperLib.Clipper.Area(unionResult[i]));
      if (area > largestArea) {
        largestArea = area;
        largest = unionResult[i];
      }
    }
    return largest.map(p => ({ x: p.X / CLIPPER_SCALE, y: p.Y / CLIPPER_SCALE }));
  }
  
  console.log('[Worker] multiPathVectorMerge: after shrink (-', gapPixels, 'px):', shrunkPaths.length, 'paths');
  
  let workingPaths = shrunkPaths;
  
  if (workingPaths.length > 1) {
    const retryGap = scaledGap * 2;
    console.log('[Worker] multiPathVectorMerge: still', workingPaths.length, 'separate paths, retrying with 2x gap');
    
    const coExpand2 = new ClipperLib.ClipperOffset();
    coExpand2.ArcTolerance = CLIPPER_SCALE * 0.25;
    coExpand2.MiterLimit = 2.0;
    for (const path of workingPaths) {
      coExpand2.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    }
    const expanded2: Array<Array<{X: number; Y: number}>> = [];
    coExpand2.Execute(expanded2, retryGap);
    
    if (expanded2.length > 0) {
      const clipper2 = new ClipperLib.Clipper();
      for (const path of expanded2) {
        clipper2.AddPath(path, ClipperLib.PolyType.ptSubject, true);
      }
      const union2: Array<Array<{X: number; Y: number}>> = [];
      clipper2.Execute(ClipperLib.ClipType.ctUnion, union2,
        ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
      
      if (union2.length > 0) {
        const coShrink2 = new ClipperLib.ClipperOffset();
        coShrink2.ArcTolerance = CLIPPER_SCALE * 0.25;
        coShrink2.MiterLimit = 2.0;
        for (const path of union2) {
          coShrink2.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
        }
        const shrunk2: Array<Array<{X: number; Y: number}>> = [];
        coShrink2.Execute(shrunk2, -retryGap);
        
        if (shrunk2.length > 0 && shrunk2.length <= workingPaths.length) {
          console.log('[Worker] multiPathVectorMerge: 2x retry reduced to', shrunk2.length, 'paths');
          workingPaths = shrunk2;
        }
      }
    }
  }
  
  // Find the largest path (this is the main merged outline)
  let resultPath = workingPaths[0];
  let largestArea = Math.abs(ClipperLib.Clipper.Area(workingPaths[0]));
  
  for (let i = 1; i < workingPaths.length; i++) {
    const area = Math.abs(ClipperLib.Clipper.Area(workingPaths[i]));
    if (area > largestArea) {
      largestArea = area;
      resultPath = workingPaths[i];
    }
  }
  
  // Simplify to remove redundant collinear points
  const simplifiedPaths = ClipperLib.Clipper.SimplifyPolygon(resultPath, ClipperLib.PolyFillType.pftNonZero);
  let finalPath = resultPath;
  if (simplifiedPaths.length > 0) {
    finalPath = simplifiedPaths[0];
    let bestArea = Math.abs(ClipperLib.Clipper.Area(simplifiedPaths[0]));
    for (let i = 1; i < simplifiedPaths.length; i++) {
      const area = Math.abs(ClipperLib.Clipper.Area(simplifiedPaths[i]));
      if (area > bestArea) {
        bestArea = area;
        finalPath = simplifiedPaths[i];
      }
    }
  }
  
  const result = finalPath.map((p: {X: number; Y: number}) => ({
    x: p.X / CLIPPER_SCALE,
    y: p.Y / CLIPPER_SCALE
  }));
  
  console.log('[Worker] multiPathVectorMerge: final result:', result.length, 'pts');
  
  return result;
}

// Union multiple contours into a single polygon using Clipper.
export function unionClusterContours(contours: Point[][]): Point[] {
  if (contours.length === 0) return [];
  if (contours.length === 1) return contours[0];
  
  const clipper = new ClipperLib.Clipper();
  
  for (const contour of contours) {
    if (contour.length < 3) continue;
    
    const clipperPath = contour.map(p => ({
      X: Math.round(p.x * CLIPPER_SCALE),
      Y: Math.round(p.y * CLIPPER_SCALE)
    }));
    
    clipper.AddPath(clipperPath, ClipperLib.PolyType.ptSubject, true);
  }
  
  const result: Array<Array<{X: number; Y: number}>> = [];
  clipper.Execute(ClipperLib.ClipType.ctUnion, result,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  
  if (result.length === 0) {
    console.log('[Worker] unionClusterContours: Union produced empty result');
    return contours[0]; // Fallback to first contour
  }
  
  // Find largest polygon
  let largestPath = result[0];
  let largestArea = Math.abs(ClipperLib.Clipper.Area(result[0]));
  
  for (let i = 1; i < result.length; i++) {
    const area = Math.abs(ClipperLib.Clipper.Area(result[i]));
    if (area > largestArea) {
      largestArea = area;
      largestPath = result[i];
    }
  }
  
  const points = largestPath.map(p => ({
    x: p.X / CLIPPER_SCALE,
    y: p.Y / CLIPPER_SCALE
  }));
  
  console.log('[Worker] unionClusterContours:', contours.length, 'inputs ->', points.length, 'points');
  return points;
}

// Final re-extract: rasterize the processed contour to a binary mask, trace external contours (like findContours RETR_EXTERNAL), and keep the largest by area — guarantees the cut path always wraps the entire sticker.
export function extractLargestOuterContour(contour: Point[], imageWidth: number, imageHeight: number, dpi: number): Point[] {
  if (contour.length < 3) return contour;
  
  try {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of contour) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }

    const contourW = maxX - minX;
    const contourH = maxY - minY;
    if (contourW < 1 || contourH < 1) {
      console.log('[Worker] re-extract: contour too small, skipping');
      return contour;
    }

    const pad = 4;
    const maskW = Math.ceil(contourW) + pad * 2 + 2;
    const maskH = Math.ceil(contourH) + pad * 2 + 2;
    
    if (maskW * maskH > 4000000) {
      console.log('[Worker] re-extract: mask too large (' + maskW + 'x' + maskH + '), skipping');
      return contour;
    }
    
    const ofsX = -minX + pad;
    const ofsY = -minY + pad;

    console.log('[Worker] re-extract: mask ' + maskW + 'x' + maskH + ', offset (' + ofsX.toFixed(1) + ',' + ofsY.toFixed(1) + '), contour ' + contour.length + ' pts');

    const translated = contour.map(p => ({
      x: Math.max(0, Math.min(maskW - 1, Math.round(p.x + ofsX))),
      y: Math.max(0, Math.min(maskH - 1, Math.round(p.y + ofsY)))
    }));

    const mask = new Uint8Array(maskW * maskH);
    scanlineFillPolygon(mask, maskW, maskH, translated);

    let fgCount = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] === 1) fgCount++;
    console.log('[Worker] re-extract: rasterized ' + fgCount + ' foreground pixels (' + (fgCount / mask.length * 100).toFixed(1) + '%)');
    
    if (fgCount === 0) {
      console.log('[Worker] re-extract: empty mask, keeping original');
      return contour;
    }

    const traced = traceAllContours(mask, maskW, maskH);
    if (traced.length === 0) {
      console.log('[Worker] re-extract: no contours found, keeping original');
      return contour;
    }

    const withArea = traced.map(c => {
      let a2 = 0;
      for (let i = 0; i < c.length; i++) {
        const j = (i + 1) % c.length;
        a2 += c[i].x * c[j].y - c[j].x * c[i].y;
      }
      return { contour: c, area: Math.abs(a2 / 2) };
    });

    withArea.sort((a, b) => b.area - a.area);
    const largestArea = withArea[0].area;

    const minAreaRatio = 0.05;
    const minAbsAreaPx = 25;
    const kept = withArea.filter(c => c.area >= largestArea * minAreaRatio && c.area >= minAbsAreaPx);

    console.log('[Worker] re-extract: traced', traced.length, 'contours, kept', kept.length, '(largest area:', Math.round(largestArea), 'px²)');

    const outer = kept[0].contour;
    const simplified = approxPolyDP(outer.map(p => ({
      x: p.x - ofsX,
      y: p.y - ofsY
    })), 0.0005);
    
    return sanitizePolygonForOffset(simplified);
  } catch (err) {
    console.log('[Worker] re-extract error, keeping original:', err);
    return contour;
  }
}

export function scanlineFillPolygon(mask: Uint8Array, width: number, height: number, polygon: Point[]): void {
  const n = polygon.length;
  if (n < 3) return;

  let polyMinY = height, polyMaxY = 0;
  for (const p of polygon) {
    if (p.y < polyMinY) polyMinY = p.y;
    if (p.y > polyMaxY) polyMaxY = p.y;
  }
  polyMinY = Math.max(0, polyMinY);
  polyMaxY = Math.min(height - 1, polyMaxY);

  for (let y = polyMinY; y <= polyMaxY; y++) {
    const intersections: number[] = [];

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const y0 = polygon[i].y, y1 = polygon[j].y;
      const x0 = polygon[i].x, x1 = polygon[j].x;

      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
        const t = (y - y0) / (y1 - y0);
        intersections.push(Math.round(x0 + t * (x1 - x0)));
      }
    }

    intersections.sort((a, b) => a - b);

    for (let k = 0; k < intersections.length - 1; k += 2) {
      const xStart = Math.max(0, intersections[k]);
      const xEnd = Math.min(width - 1, intersections[k + 1]);
      for (let x = xStart; x <= xEnd; x++) {
        mask[y * width + x] = 1;
      }
    }
  }
}

export function weldNarrowGaps(points: Point[], gapWidthPixels: number = 1.5): Point[] {
  if (points.length < 3 || gapWidthPixels <= 0) return points;
  
  // Convert to Clipper format
  const clipperPath: Array<{X: number; Y: number}> = points.map(p => ({
    X: Math.round(p.x * CLIPPER_SCALE),
    Y: Math.round(p.y * CLIPPER_SCALE)
  }));
  
  // Scale the gap width for Clipper's integer coordinates
  const scaledGapWidth = gapWidthPixels * CLIPPER_SCALE;
  
  // Step 1: Expand (positive offset) - this will cause narrow caves to collide
  const expandOffset = new ClipperLib.ClipperOffset();
  expandOffset.ArcTolerance = CLIPPER_SCALE * 0.25;
  expandOffset.MiterLimit = 2.0;
  expandOffset.AddPath(clipperPath, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const expandedPaths: Array<Array<{X: number; Y: number}>> = [];
  expandOffset.Execute(expandedPaths, scaledGapWidth);
  
  if (expandedPaths.length === 0 || expandedPaths[0].length === 0) {
    console.log('[Worker] weldNarrowGaps: Expansion produced no result, returning original');
    return points;
  }
  
  // Find largest expanded path if multiple were created
  let expandedPath = expandedPaths[0];
  let largestArea = Math.abs(ClipperLib.Clipper.Area(expandedPaths[0]));
  for (let i = 1; i < expandedPaths.length; i++) {
    const area = Math.abs(ClipperLib.Clipper.Area(expandedPaths[i]));
    if (area > largestArea) {
      largestArea = area;
      expandedPath = expandedPaths[i];
    }
  }
  
  ClipperLib.Clipper.CleanPolygon(expandedPath, CLIPPER_SCALE * 0.107);
  
  // Step 2: Shrink (negative offset) - restore to original size with caves welded
  const shrinkOffset = new ClipperLib.ClipperOffset();
  shrinkOffset.ArcTolerance = CLIPPER_SCALE * 0.25;
  shrinkOffset.MiterLimit = 2.0;
  shrinkOffset.AddPath(expandedPath, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const shrunkPaths: Array<Array<{X: number; Y: number}>> = [];
  shrinkOffset.Execute(shrunkPaths, -scaledGapWidth);
  
  if (shrunkPaths.length === 0 || shrunkPaths[0].length === 0) {
    console.log('[Worker] weldNarrowGaps: Shrinking produced no result, returning expanded');
    // Fall back to expanded result converted back
    return expandedPath.map(p => ({
      x: p.X / CLIPPER_SCALE,
      y: p.Y / CLIPPER_SCALE
    }));
  }
  
  // Find largest shrunk path
  let shrunkPath = shrunkPaths[0];
  largestArea = Math.abs(ClipperLib.Clipper.Area(shrunkPaths[0]));
  for (let i = 1; i < shrunkPaths.length; i++) {
    const area = Math.abs(ClipperLib.Clipper.Area(shrunkPaths[i]));
    if (area > largestArea) {
      largestArea = area;
      shrunkPath = shrunkPaths[i];
    }
  }
  
  ClipperLib.Clipper.CleanPolygon(shrunkPath, CLIPPER_SCALE * 0.107);
  
  // Convert back to Point format
  const result = shrunkPath.map(p => ({
    x: p.X / CLIPPER_SCALE,
    y: p.Y / CLIPPER_SCALE
  }));
  
  console.log('[Worker] weldNarrowGaps: Welded narrow gaps:', points.length, '→', result.length, 'points (gap width:', gapWidthPixels, 'px)');
  
  return result;
}

export function removeNearDuplicatePoints(points: Point[], minDist: number): Point[] {
  if (points.length < 3) return points;
  const minDistSq = minDist * minDist;
  const result: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = result[result.length - 1];
    const dx = points[i].x - prev.x;
    const dy = points[i].y - prev.y;
    if (dx * dx + dy * dy > minDistSq) {
      result.push(points[i]);
    }
  }
  if (result.length >= 3) {
    const first = result[0];
    const last = result[result.length - 1];
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    if (dx * dx + dy * dy <= minDistSq) {
      result.pop();
    }
  }
  return result.length >= 3 ? result : points;
}

export function clipperVectorOffset(points: Point[], offsetPixels: number, useSharpCorners: boolean = false): Point[] {
  if (points.length < 3 || offsetPixels <= 0) return points;
  
  // Convert to Clipper format with scaling
  const clipperPath: Array<{X: number; Y: number}> = points.map(p => ({
    X: Math.round(p.x * CLIPPER_SCALE),
    Y: Math.round(p.y * CLIPPER_SCALE)
  }));
  
  const scaledOffset = offsetPixels * CLIPPER_SCALE;
  
  // Create ClipperOffset object
  const co = new ClipperLib.ClipperOffset();
  
  // Arc tolerance for round corners: lower = smoother curves (more points), higher = more angular; 0.25px gives smooth arcs without excessive points.
  co.ArcTolerance = CLIPPER_SCALE * 0.25;
  
  // MiterLimit controls how far sharp corners extend before beveling; 10.0 allows very sharp corners so acute angles don't get beveled into a "distorted" look.
  co.MiterLimit = 10.0;
  
  // Choose join type based on corner style
  const joinType = useSharpCorners ? ClipperLib.JoinType.jtMiter : ClipperLib.JoinType.jtRound;
  
  // Add path with the chosen join type; ET_CLOSEDPOLYGON for a closed contour.
  co.AddPath(clipperPath, joinType, ClipperLib.EndType.etClosedPolygon);
  
  // Execute the offset
  const offsetPaths: Array<Array<{X: number; Y: number}>> = [];
  co.Execute(offsetPaths, scaledOffset);
  
  if (offsetPaths.length === 0 || offsetPaths[0].length < 3) {
    console.log('[Worker] clipperVectorOffset: offset failed, returning original');
    return points;
  }
  
  // Find the largest polygon if multiple were created
  let resultPath = offsetPaths[0];
  let largestArea = Math.abs(ClipperLib.Clipper.Area(offsetPaths[0]));
  
  for (let i = 1; i < offsetPaths.length; i++) {
    const area = Math.abs(ClipperLib.Clipper.Area(offsetPaths[i]));
    if (area > largestArea) {
      largestArea = area;
      resultPath = offsetPaths[i];
    }
  }
  
  ClipperLib.Clipper.CleanPolygon(resultPath, CLIPPER_SCALE * 0.107);
  
  // Convert back to Point format
  const result = resultPath.map(p => ({
    x: p.X / CLIPPER_SCALE,
    y: p.Y / CLIPPER_SCALE
  }));
  
  console.log('[Worker] clipperVectorOffset: input', points.length, 'pts, output', result.length, 'pts');
  
  return result;
}

// Vector Closing Merge: offset OUT by +X (merges separated objects), offset IN by -X (restores straight lines), then PreserveCollinear strips redundant points — bridges gaps in script fonts/separated characters while keeping blocky designs' straight lines perfect.
export function vectorCloseMerge(points: Point[], gapPixels: number): Point[] {
  if (points.length < 3 || gapPixels <= 0) return points;
  
  console.log('[Worker] vectorCloseMerge: input', points.length, 'pts, gap:', gapPixels, 'px');
  
  // Convert to Clipper format with scaling
  const clipperPath: Array<{X: number; Y: number}> = points.map(p => ({
    X: Math.round(p.x * CLIPPER_SCALE),
    Y: Math.round(p.y * CLIPPER_SCALE)
  }));
  
  const scaledGap = gapPixels * CLIPPER_SCALE;
  
  // Step 1: Offset OUT (expand) to merge separated objects
  const coExpand = new ClipperLib.ClipperOffset();
  coExpand.ArcTolerance = CLIPPER_SCALE * 0.25;
  coExpand.MiterLimit = 2.0;
  coExpand.AddPath(clipperPath, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  
  const expandedPaths: Array<Array<{X: number; Y: number}>> = [];
  coExpand.Execute(expandedPaths, scaledGap);
  
  if (expandedPaths.length === 0 || expandedPaths[0].length < 3) {
    console.log('[Worker] vectorCloseMerge: expand failed, returning original');
    return points;
  }
  
  console.log('[Worker] vectorCloseMerge: after expand (+', gapPixels, 'px):', expandedPaths[0].length, 'pts');
  
  // Step 2: Offset IN (shrink) to restore original size
  const coShrink = new ClipperLib.ClipperOffset();
  coShrink.ArcTolerance = CLIPPER_SCALE * 0.25;
  coShrink.MiterLimit = 2.0;
  
  // Add all expanded paths (handles multiple islands if any)
  for (const path of expandedPaths) {
    coShrink.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  }
  
  const restoredPaths: Array<Array<{X: number; Y: number}>> = [];
  coShrink.Execute(restoredPaths, -scaledGap); // Negative offset = shrink
  
  if (restoredPaths.length === 0 || restoredPaths[0].length < 3) {
    console.log('[Worker] vectorCloseMerge: shrink failed, using expanded');
    // If shrink fails, at least return the expanded version
    const result = expandedPaths[0].map(p => ({
      x: p.X / CLIPPER_SCALE,
      y: p.Y / CLIPPER_SCALE
    }));
    return result;
  }
  
  console.log('[Worker] vectorCloseMerge: after shrink (-', gapPixels, 'px):', restoredPaths[0].length, 'pts');
  
  // Step 3: union all restored paths so separated objects that got merged stay as one polygon.
  const clipper = new ClipperLib.Clipper();
  for (const path of restoredPaths) {
    clipper.AddPath(path, ClipperLib.PolyType.ptSubject, true);
  }
  
  const unionResult: Array<Array<{X: number; Y: number}>> = [];
  clipper.Execute(ClipperLib.ClipType.ctUnion, unionResult, 
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  
  // Find the largest polygon from union result
  let resultPath = unionResult.length > 0 ? unionResult[0] : restoredPaths[0];
  let largestArea = Math.abs(ClipperLib.Clipper.Area(resultPath));
  
  for (let i = 1; i < unionResult.length; i++) {
    const area = Math.abs(ClipperLib.Clipper.Area(unionResult[i]));
    if (area > largestArea) {
      largestArea = area;
      resultPath = unionResult[i];
    }
  }
  
  // Step 4: SimplifyPolygon removes redundant collinear points (ClipperLib's equivalent of PreserveCollinear).
  const simplifiedPaths = ClipperLib.Clipper.SimplifyPolygon(resultPath, ClipperLib.PolyFillType.pftNonZero);
  const finalPath = simplifiedPaths.length > 0 ? simplifiedPaths[0] : resultPath;
  
  // Convert back to Point format
  const result = finalPath.map((p: {X: number; Y: number}) => ({
    x: p.X / CLIPPER_SCALE,
    y: p.Y / CLIPPER_SCALE
  }));
  
  console.log('[Worker] vectorCloseMerge: final after simplify:', result.length, 'pts');
  
  return result;
}

// Round sharp corners via "buffer and shrink": offset outward by radius with JT_ROUND (rounds outer corners), then inward (rounds inner corners, restores size) — keeps straight edges perfectly straight.
export function roundCorners(points: Point[], radius: number): Point[] {
  if (points.length < 3 || radius <= 0) return points;
  
  // Convert to Clipper format with scaling
  const clipperPath: Array<{X: number; Y: number}> = points.map(p => ({
    X: Math.round(p.x * CLIPPER_SCALE),
    Y: Math.round(p.y * CLIPPER_SCALE)
  }));
  
  const scaledRadius = radius * CLIPPER_SCALE;
  
  // Create ClipperOffset object
  const co = new ClipperLib.ClipperOffset();
  
  // Arc tolerance for smooth round corners: lower = smoother curves, higher = more angular.
  co.ArcTolerance = CLIPPER_SCALE * 0.25; // 0.25px tolerance for smooth arcs
  co.MiterLimit = 2.0;
  
  // Step 1: Offset OUT by radius with JT_ROUND
  co.Clear();
  co.AddPath(clipperPath, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  
  const expandedPaths: Array<Array<{X: number; Y: number}>> = [];
  co.Execute(expandedPaths, scaledRadius);
  
  if (expandedPaths.length === 0 || expandedPaths[0].length < 3) {
    console.log('[Worker] roundCorners: expand step failed, returning original');
    return points;
  }
  
  // Step 2: Offset IN by radius with JT_ROUND (shrink back)
  co.Clear();
  co.AddPath(expandedPaths[0], ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  
  const shrunkPaths: Array<Array<{X: number; Y: number}>> = [];
  co.Execute(shrunkPaths, -scaledRadius);
  
  if (shrunkPaths.length === 0 || shrunkPaths[0].length < 3) {
    console.log('[Worker] roundCorners: shrink step failed, returning expanded');
    // Return expanded result if shrink fails
    return expandedPaths[0].map(p => ({
      x: p.X / CLIPPER_SCALE,
      y: p.Y / CLIPPER_SCALE
    }));
  }
  
  // Find the largest polygon if multiple were created
  let resultPath = shrunkPaths[0];
  let largestArea = Math.abs(ClipperLib.Clipper.Area(shrunkPaths[0]));
  
  for (let i = 1; i < shrunkPaths.length; i++) {
    const area = Math.abs(ClipperLib.Clipper.Area(shrunkPaths[i]));
    if (area > largestArea) {
      largestArea = area;
      resultPath = shrunkPaths[i];
    }
  }
  
  // Convert back to Point format
  const result = resultPath.map(p => ({
    x: p.X / CLIPPER_SCALE,
    y: p.Y / CLIPPER_SCALE
  }));
  
  console.log('[Worker] roundCorners: radius =', radius.toFixed(2), 'px, points:', points.length, '->', result.length);
  
  return result;
}

// Signed area of a closed polygon (shoelace formula).
export function polygonArea(points: Point[]): number {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return area / 2;
}

// Calculate the perimeter (arc length) of a closed polygon.
export function calculatePerimeter(points: Point[]): number {
  if (points.length < 2) return 0;
  
  let perimeter = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    perimeter += Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
  }
  return perimeter;
}

// cv2.approxPolyDP equivalent: Douglas-Peucker simplification with epsilon auto-scaled by perimeter (epsilonFactor default 0.001 = "rope tension").
export function vectorWeld(path: Point[], radiusPx: number): Point[] {
  if (path.length < 3 || radiusPx <= 0) return path;

  const clipperPath = path.map(p => ({
    X: Math.round(p.x * CLIPPER_SCALE),
    Y: Math.round(p.y * CLIPPER_SCALE)
  }));

  const offsetDelta = Math.round(radiusPx * CLIPPER_SCALE);

  const co1 = new ClipperLib.ClipperOffset();
  co1.ArcTolerance = 0.25 * CLIPPER_SCALE;
  co1.AddPath(clipperPath, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const expanded: Array<Array<{X: number; Y: number}>> = [];
  co1.Execute(expanded, offsetDelta);

  if (expanded.length === 0) return path;

  const co2 = new ClipperLib.ClipperOffset();
  co2.ArcTolerance = 0.25 * CLIPPER_SCALE;
  co2.AddPath(expanded[0], ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const shrunk: Array<Array<{X: number; Y: number}>> = [];
  co2.Execute(shrunk, -offsetDelta);

  if (shrunk.length === 0) return path;

  let longest = shrunk[0];
  for (let i = 1; i < shrunk.length; i++) {
    if (shrunk[i].length > longest.length) longest = shrunk[i];
  }

  return longest.map(p => ({ x: p.X / CLIPPER_SCALE, y: p.Y / CLIPPER_SCALE }));
}

export function enforceMinGap(path: Point[], minGapPx: number): Point[] {
  if (path.length < 3 || minGapPx <= 0) return path;

  const clipperPath = path.map(p => ({
    X: Math.round(p.x * CLIPPER_SCALE),
    Y: Math.round(p.y * CLIPPER_SCALE)
  }));

  const halfGap = Math.round((minGapPx / 2) * CLIPPER_SCALE);

  const co1 = new ClipperLib.ClipperOffset();
  co1.ArcTolerance = 0.25 * CLIPPER_SCALE;
  co1.AddPath(clipperPath, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const shrunk: Array<Array<{X: number; Y: number}>> = [];
  co1.Execute(shrunk, -halfGap);

  if (shrunk.length === 0) return path;

  const co2 = new ClipperLib.ClipperOffset();
  co2.ArcTolerance = 0.25 * CLIPPER_SCALE;
  for (const p of shrunk) {
    co2.AddPath(p, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  }
  const restored: Array<Array<{X: number; Y: number}>> = [];
  co2.Execute(restored, halfGap);

  if (restored.length === 0) return path;

  let largest = restored[0];
  let largestArea = Math.abs(ClipperLib.Clipper.Area(restored[0]));
  for (let i = 1; i < restored.length; i++) {
    const area = Math.abs(ClipperLib.Clipper.Area(restored[i]));
    if (area > largestArea) {
      largestArea = area;
      largest = restored[i];
    }
  }

  const result = largest.map(p => ({ x: p.X / CLIPPER_SCALE, y: p.Y / CLIPPER_SCALE }));
  if (result.length < 3) return path;

  console.log('[Worker] enforceMinGap: minGap', minGapPx.toFixed(1), 'px, input', path.length, 'pts -> output', result.length, 'pts');
  return result;
}

export function approxPolyDP(points: Point[], epsilonFactor: number = 0.001): Point[] {
  if (points.length < 3) return points;
  
  const perimeter = calculatePerimeter(points);
  const epsilon = epsilonFactor * perimeter;
  
  console.log('[Worker] approxPolyDP: perimeter =', perimeter.toFixed(2), 'px, epsilon =', epsilon.toFixed(3), 'px (factor:', epsilonFactor, ')');
  
  return rdpSimplifyPolygon(points, epsilon);
}

// Bezier curve reconstruction (Schneider 1990, Graphics Gems I): detectCornersByCurvature marks real corners as anchors, each corner-to-corner segment is emitted as a line (if straight) or fit via fitBeziersRecursive (cubics within tolerancePx), and loops with no real corners get 4 synthetic "soft corners" at the bbox extremes so they fit as 4 quarter-arc Beziers like conventional circle representations.

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

// Vector helpers (kept local; existing helpers don't follow the same convention).
export function _vSub(a: Point, b: Point): Point { return { x: a.x - b.x, y: a.y - b.y }; }
export function _vAdd(a: Point, b: Point): Point { return { x: a.x + b.x, y: a.y + b.y }; }
export function _vMul(a: Point, s: number): Point { return { x: a.x * s, y: a.y * s }; }
export function _vLen(a: Point): number { return Math.sqrt(a.x * a.x + a.y * a.y); }
export function _vDot(a: Point, b: Point): number { return a.x * b.x + a.y * b.y; }
export function _vNorm(a: Point): Point {
  const l = _vLen(a);
  if (l < 1e-12) return { x: 0, y: 0 };
  return { x: a.x / l, y: a.y / l };
}

export function _evalBezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const uu = u * u;
  const tt = t * t;
  const uuu = uu * u;
  const ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

export function _evalBezierD1(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: 3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
    y: 3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
  };
}

export function _evalBezierD2(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: 6 * u * (p2.x - 2 * p1.x + p0.x) + 6 * t * (p3.x - 2 * p2.x + p1.x),
    y: 6 * u * (p2.y - 2 * p1.y + p0.y) + 6 * t * (p3.y - 2 * p2.y + p1.y),
  };
}

// Initial parameter assignment via chord-length parameterization.
export function _chordLengthParameterize(points: Point[]): number[] {
  const n = points.length;
  const u: number[] = new Array(n);
  u[0] = 0;
  for (let i = 1; i < n; i++) {
    u[i] = u[i - 1] + _vLen(_vSub(points[i], points[i - 1]));
  }
  const total = u[n - 1];
  if (total < 1e-12) {
    for (let i = 0; i < n; i++) u[i] = i / Math.max(1, n - 1);
  } else {
    for (let i = 0; i < n; i++) u[i] /= total;
  }
  return u;
}

// Solve the 2×2 normal-equation least-squares problem for the two control-point distances (α1 along leftTangent at P0, α2 along rightTangent at P3), returning the four cubic Bezier control points [P0,P1,P2,P3].
export function _generateBezier(
  points: Point[],
  params: number[],
  leftTangent: Point,
  rightTangent: Point
): [Point, Point, Point, Point] {
  const n = points.length;
  const p0 = points[0];
  const p3 = points[n - 1];

  let C00 = 0, C01 = 0, C11 = 0;
  let X0 = 0, X1 = 0;

  for (let i = 0; i < n; i++) {
    const t = params[i];
    const u = 1 - t;
    // A0 = 3u²t · L,  A1 = 3ut² · R
    const a0s = 3 * u * u * t;
    const a1s = 3 * u * t * t;
    const A0x = a0s * leftTangent.x;
    const A0y = a0s * leftTangent.y;
    const A1x = a1s * rightTangent.x;
    const A1y = a1s * rightTangent.y;

    C00 += A0x * A0x + A0y * A0y;
    C01 += A0x * A1x + A0y * A1y;
    C11 += A1x * A1x + A1y * A1y;

    // S(t) = (u³ + 3u²t)·P0 + (t³ + 3ut²)·P3 (the part with no α dependency)
    const b03 = u * u * u + 3 * u * u * t;
    const b30 = t * t * t + 3 * u * t * t;
    const tmpX = points[i].x - (b03 * p0.x + b30 * p3.x);
    const tmpY = points[i].y - (b03 * p0.y + b30 * p3.y);

    X0 += A0x * tmpX + A0y * tmpY;
    X1 += A1x * tmpX + A1y * tmpY;
  }

  const det = C00 * C11 - C01 * C01;
  let alpha1: number;
  let alpha2: number;

  if (Math.abs(det) < 1e-12) {
    // Degenerate — fall back to Schneider's heuristic (chord/3 along each tangent).
    const chord = _vLen(_vSub(p3, p0)) / 3;
    alpha1 = chord;
    alpha2 = chord;
  } else {
    alpha1 = (C11 * X0 - C01 * X1) / det;
    alpha2 = (C00 * X1 - C01 * X0) / det;
  }

  // Reject negative or absurdly large tangent magnitudes (over-fit / wrong direction) and fall back to the chord/3 heuristic; cap tightened from 4x to 1.5x chord since the looser cap let control points overshoot and produce cubics that visually "shortcut" through the design interior in the PDF (hidden by the preview, which just rasterizes the input).
  const chordLen = _vLen(_vSub(p3, p0));
  const segLenEst = Math.max(chordLen, 1e-6);
  if (alpha1 < segLenEst * 1e-6 || alpha2 < segLenEst * 1e-6 ||
      alpha1 > segLenEst * 1.5 || alpha2 > segLenEst * 1.5) {
    alpha1 = chordLen / 3;
    alpha2 = chordLen / 3;
  }

  const p1 = _vAdd(p0, _vMul(leftTangent, alpha1));
  const p2 = _vAdd(p3, _vMul(rightTangent, alpha2));
  return [p0, p1, p2, p3];
}

// Newton-Raphson refinement of the parameter assignment, one point at a time, returning the new parameter vector.
export function _reparameterize(
  points: Point[],
  params: number[],
  bezier: [Point, Point, Point, Point]
): number[] {
  const out = params.slice();
  for (let i = 0; i < points.length; i++) {
    let t = params[i];
    if (t <= 0 || t >= 1) continue;
    const Q = _evalBezier(bezier[0], bezier[1], bezier[2], bezier[3], t);
    const Q1 = _evalBezierD1(bezier[0], bezier[1], bezier[2], bezier[3], t);
    const Q2 = _evalBezierD2(bezier[0], bezier[1], bezier[2], bezier[3], t);
    const diff = _vSub(Q, points[i]);
    const num = _vDot(diff, Q1);
    const den = _vDot(Q1, Q1) + _vDot(diff, Q2);
    if (Math.abs(den) < 1e-12) continue;
    const tNew = t - num / den;
    if (tNew > 0 && tNew < 1) out[i] = tNew;
  }
  return out;
}

// Find the parameter/index of the polyline point with max squared residual to the fitted curve — used as the split point on a bad fit and as the reported max error.
export function _findMaxError(
  points: Point[],
  params: number[],
  bezier: [Point, Point, Point, Point]
): { maxErrorSq: number; splitIndex: number } {
  let maxErrSq = 0;
  let splitIndex = Math.floor(points.length / 2);
  for (let i = 1; i < points.length - 1; i++) {
    const Q = _evalBezier(bezier[0], bezier[1], bezier[2], bezier[3], params[i]);
    const dx = Q.x - points[i].x;
    const dy = Q.y - points[i].y;
    const errSq = dx * dx + dy * dy;
    if (errSq > maxErrSq) {
      maxErrSq = errSq;
      splitIndex = i;
    }
  }
  return { maxErrorSq: maxErrSq, splitIndex };
}

// Tangent estimation via small finite-difference window: returns a unit vector pointing into the curve (endpoint toward next interior sample) — reasonable at true corners, and smooth joins inherit tangent continuity by construction.
export function _estimateTangent(points: Point[], atIndex: number, dir: 'forward' | 'backward'): Point {
  const n = points.length;
  if (n < 2) return { x: 1, y: 0 };
  // Average over up to 3 neighbors for stability against single-pixel jitter.
  const window = Math.min(3, n - 1);
  let acc = { x: 0, y: 0 };
  for (let k = 1; k <= window; k++) {
    const j = dir === 'forward' ? Math.min(n - 1, atIndex + k) : Math.max(0, atIndex - k);
    const v = _vSub(points[j], points[atIndex]);
    acc = _vAdd(acc, v);
  }
  return _vNorm(acc);
}

// Emit the input polyline as a chain of `line` segments — safe fallback when the cubic fit fails, since the PDF then matches the preview-rasterized polyline exactly (same vertices via `lineTo`).
export function _polylineAsLineSegments(points: Point[]): BezierSegment[] {
  const out: BezierSegment[] = [];
  for (let i = 1; i < points.length; i++) {
    out.push({ type: 'line', to: { x: points[i].x, y: points[i].y } });
  }
  return out;
}

// Schneider's recursive fitter: given an open polyline + endpoint tangents, produces BezierSegment[] (cubics or lines, not just cubics) within tol — falls back to line segments at the recursion depth cap instead of a potentially-degenerate cubic, per the user-reported "stray lines in PDF" failure from a wild cubic shortcutting the design interior.
export function _fitBeziersRecursive(
  points: Point[],
  leftTangent: Point,
  rightTangent: Point,
  tolerancePx: number,
  depth: number = 0
): BezierSegment[] {
  if (points.length < 2) return [];
  if (points.length === 2) {
    const p0 = points[0];
    const p3 = points[1];
    const chord = _vLen(_vSub(p3, p0));
    const cp1 = _vAdd(p0, _vMul(leftTangent, chord / 3));
    const cp2 = _vAdd(p3, _vMul(rightTangent, chord / 3));
    return [{ type: 'cubic', cp1, cp2, to: p3 }];
  }

  let params = _chordLengthParameterize(points);
  let bezier = _generateBezier(points, params, leftTangent, rightTangent);
  const tolSq = tolerancePx * tolerancePx;

  let result = _findMaxError(points, params, bezier);
  if (result.maxErrorSq < tolSq) {
    return [{ type: 'cubic', cp1: bezier[1], cp2: bezier[2], to: bezier[3] }];
  }

  // Try a few reparameterization passes if the error is "close".
  const ITERS = 4;
  if (result.maxErrorSq < tolSq * 16) {
    for (let i = 0; i < ITERS; i++) {
      params = _reparameterize(points, params, bezier);
      bezier = _generateBezier(points, params, leftTangent, rightTangent);
      result = _findMaxError(points, params, bezier);
      if (result.maxErrorSq < tolSq) {
        return [{ type: 'cubic', cp1: bezier[1], cp2: bezier[2], to: bezier[3] }];
      }
    }
  }

  // Recursion-depth cap: fall back to line segments connecting consecutive input points rather than emit a degenerate, wildly-overshooting cubic — polyline emit is always faithful to the preview.
  if (depth > 10) {
    return _polylineAsLineSegments(points);
  }

  const splitIndex = Math.max(1, Math.min(points.length - 2, result.splitIndex));
  const leftPts = points.slice(0, splitIndex + 1);
  const rightPts = points.slice(splitIndex);
  const splitTangentForward = _estimateTangent(points, splitIndex, 'forward');
  const splitTangentBackward = _estimateTangent(points, splitIndex, 'backward');

  const leftFits = _fitBeziersRecursive(leftPts, leftTangent, splitTangentBackward, tolerancePx, depth + 1);
  const rightFits = _fitBeziersRecursive(rightPts, splitTangentForward, rightTangent, tolerancePx, depth + 1);
  return leftFits.concat(rightFits);
}

// Distance from point `p` to the line segment `a..b`.
export function _distPointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const segLenSq = dx * dx + dy * dy;
  if (segLenSq < 1e-12) {
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return Math.sqrt(ex * ex + ey * ey);
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / segLenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  const ex = p.x - cx;
  const ey = p.y - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

// Validate fitted segments against the source sub-polyline: densely sample each cubic and check every sample is within `validationTolPx`, and reject cubics whose control points lie wildly outside the source bbox (sentinel for an overshooting Schneider fit); returns true if all segments pass.
export function _validateBezierSegments(
  source: Point[],
  segments: BezierSegment[],
  startPt: Point,
  validationTolPx: number
): boolean {
  if (segments.length === 0) return false;

  // Source bbox + slack for control-point envelope check.
  let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
  for (const p of source) {
    if (p.x < sMinX) sMinX = p.x;
    if (p.x > sMaxX) sMaxX = p.x;
    if (p.y < sMinY) sMinY = p.y;
    if (p.y > sMaxY) sMaxY = p.y;
  }
  const bw = Math.max(1, sMaxX - sMinX);
  const bh = Math.max(1, sMaxY - sMinY);
  // Allow control points to extend up to 50% of bbox size beyond the bbox — cubics legitimately place control points outside the polyline envelope.
  const envSlack = Math.max(bw, bh) * 0.5;
  const eMinX = sMinX - envSlack;
  const eMinY = sMinY - envSlack;
  const eMaxX = sMaxX + envSlack;
  const eMaxY = sMaxY + envSlack;

  let cur: Point = startPt;
  const SAMPLES_PER_CUBIC = 12;
  for (const seg of segments) {
    if (seg.type === 'line') {
      // Lines are always faithful — they're segments connecting source vertices.
      cur = seg.to;
      continue;
    }
    // Control-point envelope check: if either control point is outside the generous envelope, the cubic will overshoot dramatically.
    if (
      seg.cp1.x < eMinX || seg.cp1.x > eMaxX || seg.cp1.y < eMinY || seg.cp1.y > eMaxY ||
      seg.cp2.x < eMinX || seg.cp2.x > eMaxX || seg.cp2.y < eMinY || seg.cp2.y > eMaxY
    ) {
      return false;
    }
    // Sample the cubic and check distance to nearest source segment.
    for (let s = 1; s <= SAMPLES_PER_CUBIC; s++) {
      const t = s / SAMPLES_PER_CUBIC;
      const samplePt = _evalBezier(cur, seg.cp1, seg.cp2, seg.to, t);
      let minDist = Infinity;
      for (let i = 0; i < source.length - 1; i++) {
        const d = _distPointToSegment(samplePt, source[i], source[i + 1]);
        if (d < minDist) {
          minDist = d;
          if (minDist <= validationTolPx) break;
        }
      }
      if (minDist > validationTolPx) return false;
    }
    cur = seg.to;
  }
  return true;
}

// Ellipse detection + analytical 4-arc Bezier emission: fit an algebraic ellipse via PCA on boundary points, refine semi-axes via 1D bisection to minimize radial residual, and emit 4 perfect cubic-Bezier quarter-arcs (κ ≈ 0.5523) if residual is below `acceptanceRadialFraction`; PCA is used instead of full Fitzgibbon DLS (a heavyweight 6×6 eigenvalue problem) since it gives the correct centroid/orientation directly and converges to the same answer for clean silhouettes — invoked after detectAndSnapRoundedRect so rounded rects aren't false-positived as ellipses.

export interface EllipseFit {
  cx: number;
  cy: number;
  rx: number;     // major semi-axis
  ry: number;     // minor semi-axis
  theta: number;  // rotation angle (radians) of the major axis from +X
  rmsResidualPx: number;
  maxResidualPx: number;
}

// Distance from `p` to the axis-aligned ellipse boundary via parametric-angle approximation (project to parametric angle, evaluate ellipse, take Euclidean distance) — not the true closest-point distance for very elongated ellipses but accurate to <0.1% for aspect ratios ≤5:1, covering realistic logo/design ellipses.
export function _ellipseRadialDist(px: number, py: number, rx: number, ry: number): number {
  if (rx < 1e-9 || ry < 1e-9) {
    return Math.sqrt(px * px + py * py);
  }
  const angle = Math.atan2(py / ry, px / rx);
  const ex = rx * Math.cos(angle);
  const ey = ry * Math.sin(angle);
  const dx = px - ex;
  const dy = py - ey;
  return Math.sqrt(dx * dx + dy * dy);
}

// Compute residual statistics (rms, max) for a candidate ellipse against a closed polyline, operating on points already in ellipse-local (axis-aligned, centered) coords.
export function _ellipseResiduals(
  localPts: Point[],
  rx: number,
  ry: number
): { rms: number; max: number } {
  let sumSq = 0;
  let maxD = 0;
  for (const p of localPts) {
    const d = _ellipseRadialDist(p.x, p.y, rx, ry);
    sumSq += d * d;
    if (d > maxD) maxD = d;
  }
  return { rms: Math.sqrt(sumSq / localPts.length), max: maxD };
}

export function detectAndSnapEllipse(
  polyline: Point[],
  acceptanceRadialFraction: number = 0.015
): EllipseFit | null {
  const n = polyline.length;
  if (n < 24) return null;

  // 1) Centroid = arithmetic mean of vertices; for uniformly arc-length-sampled boundary points (as sub-pixel marching squares produces) this is the ellipse center.
  let cx = 0, cy = 0;
  for (const p of polyline) { cx += p.x; cy += p.y; }
  cx /= n; cy /= n;

  // 2) Centered covariance matrix → eigenvalues/vectors give principal axes.
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of polyline) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  sxx /= n; sxy /= n; syy /= n;

  // 2×2 closed-form eigendecomposition.
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const lambda1 = tr / 2 + disc;  // larger eigenvalue → major axis
  const lambda2 = tr / 2 - disc;  // smaller eigenvalue → minor axis
  if (lambda1 <= 0 || lambda2 <= 0) return null;

  // Eigenvector for lambda1 (major-axis direction).
  let evx: number, evy: number;
  if (Math.abs(sxy) > 1e-9) {
    evx = lambda1 - syy;
    evy = sxy;
    const len = Math.sqrt(evx * evx + evy * evy);
    if (len < 1e-9) { evx = 1; evy = 0; }
    else { evx /= len; evy /= len; }
  } else {
    if (sxx >= syy) { evx = 1; evy = 0; }
    else { evx = 0; evy = 1; }
  }
  const theta = Math.atan2(evy, evx);

  // 3) Initial semi-axes: covariance eigenvalue ≈ semi-axis²/2 for a uniformly-sampled boundary (exact for circles, close enough for moderate aspect ratios), then refined.
  let rxInit = Math.sqrt(2 * lambda1);
  let ryInit = Math.sqrt(2 * lambda2);
  if (rxInit < 3 || ryInit < 3) return null;
  if (rxInit / ryInit > 4) return null; // implausibly elongated → skip ellipse fit

  // 4) Transform polyline into ellipse-local coords (centered, axis-aligned).
  const cosT = Math.cos(-theta);
  const sinT = Math.sin(-theta);
  const localPts: Point[] = polyline.map(p => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    return {
      x: dx * cosT - dy * sinT,
      y: dx * sinT + dy * cosT,
    };
  });

  // 5) Refine rx, ry via coordinate-descent bisection (alternately minimizing squared radial residuals over rx then ry) — converges in 4-6 iterations in practice.
  let rx = rxInit;
  let ry = ryInit;
  const refineAxis = (current: number, isRx: boolean): number => {
    const lo = current * 0.7;
    const hi = current * 1.4;
    let best = current;
    let bestSqSum = Infinity;
    const STEPS = 12;
    for (let s = 0; s <= STEPS; s++) {
      const t = lo + (hi - lo) * (s / STEPS);
      const tryRx = isRx ? t : rx;
      const tryRy = isRx ? ry : t;
      let sqSum = 0;
      for (const p of localPts) {
        const d = _ellipseRadialDist(p.x, p.y, tryRx, tryRy);
        sqSum += d * d;
        if (sqSum > bestSqSum) break;
      }
      if (sqSum < bestSqSum) { bestSqSum = sqSum; best = t; }
    }
    return best;
  };
  for (let it = 0; it < 5; it++) {
    const newRx = refineAxis(rx, true);
    const newRy = refineAxis(ry, false);
    const delta = Math.abs(newRx - rx) + Math.abs(newRy - ry);
    rx = newRx;
    ry = newRy;
    if (delta < 0.01) break;
  }

  // 6) Final residuals and acceptance check.
  const { rms, max } = _ellipseResiduals(localPts, rx, ry);
  const minorAxis = Math.min(rx, ry);
  // Both RMS and max gates: RMS measures average fit, max guards against a few way-off vertices that would visibly deviate from the smooth ellipse.
  const rmsOk = rms <= minorAxis * acceptanceRadialFraction;
  const maxOk = max <= minorAxis * (acceptanceRadialFraction * 2.5);

  // Convexity-defect gate: a true ellipse has only tracer-noise-level inward deviation, while a rounded blob with protrusions has many points sitting significantly inside the fit at each protrusion's base concavity — even if no single deviation trips the `max` gate; count points with radius < ellipseRadius - threshold as concavity votes and reject if they exceed 8% of the polyline.
  let concavityVotes = 0;
  let maxInwardDev = 0;
  const concavityThreshold = minorAxis * 0.01; // 1% of minor axis
  for (const p of localPts) {
    const angle = Math.atan2(p.y / ry, p.x / rx);
    const ex = rx * Math.cos(angle);
    const ey = ry * Math.sin(angle);
    const ellipseR = Math.sqrt(ex * ex + ey * ey);
    const pointR = Math.sqrt(p.x * p.x + p.y * p.y);
    const inwardDev = ellipseR - pointR; // positive = point is INSIDE ellipse
    if (inwardDev > concavityThreshold) {
      concavityVotes++;
      if (inwardDev > maxInwardDev) maxInwardDev = inwardDev;
    }
  }
  const concavityFrac = concavityVotes / localPts.length;
  const concavityOk = concavityFrac <= 0.08; // ≤8% of points sit inward → still ellipse-like

  // Always log what the snap tried (cheap, one log per closed polyline) — helps debug both "why did this snap" and "why didn't this snap" cases.
  console.log(
    '[Worker] Ellipse fit attempt: n=' + localPts.length +
    ' rx=' + rx.toFixed(1) + ' ry=' + ry.toFixed(1) +
    ' rms=' + rms.toFixed(2) + 'px (limit ' + (minorAxis * acceptanceRadialFraction).toFixed(2) + ')' +
    ' max=' + max.toFixed(2) + 'px (limit ' + (minorAxis * acceptanceRadialFraction * 2.5).toFixed(2) + ')' +
    ' concavity=' + (concavityFrac * 100).toFixed(1) + '%' +
    ' (' + concavityVotes + '/' + localPts.length + ', maxInward=' + maxInwardDev.toFixed(2) + 'px)' +
    ' → rmsOk=' + rmsOk + ' maxOk=' + maxOk + ' concavityOk=' + concavityOk
  );

  if (!rmsOk || !maxOk || !concavityOk) return null;

  return { cx, cy, rx, ry, theta, rmsResidualPx: rms, maxResidualPx: max };
}

// Build a closed BezierPath of 4 cubic-Bezier quarter-arcs approximating the ellipse to ~0.027% error (the standard κ approximation).
export function ellipseToBezierPath(e: EllipseFit): BezierPath {
  const KAPPA = 0.5522847498307933; // 4 * (sqrt(2) - 1) / 3
  const cosT = Math.cos(e.theta);
  const sinT = Math.sin(e.theta);
  const xform = (lx: number, ly: number): Point => ({
    x: e.cx + lx * cosT - ly * sinT,
    y: e.cy + lx * sinT + ly * cosT,
  });
  const rx = e.rx;
  const ry = e.ry;
  const k_rx = KAPPA * rx;
  const k_ry = KAPPA * ry;

  const start = xform(rx, 0);
  const segments: BezierSegment[] = [
    // Q1: (rx, 0) → (0, ry)
    { type: 'cubic', cp1: xform(rx,  k_ry), cp2: xform(k_rx,  ry),  to: xform(0,  ry) },
    // Q2: (0, ry) → (-rx, 0)
    { type: 'cubic', cp1: xform(-k_rx, ry), cp2: xform(-rx,  k_ry), to: xform(-rx, 0) },
    // Q3: (-rx, 0) → (0, -ry)
    { type: 'cubic', cp1: xform(-rx, -k_ry), cp2: xform(-k_rx, -ry), to: xform(0, -ry) },
    // Q4: (0, -ry) → (rx, 0)
    { type: 'cubic', cp1: xform(k_rx, -ry), cp2: xform(rx,  -k_ry), to: xform(rx,  0) },
  ];
  return { start, segments, closed: true };
}

// Curvature-based corner detection: a corner is a vertex where cumulative turning angle within a small window crosses `cornerThresholdDeg` and is the local max of turning within an arc-length neighborhood — windowed turn groups sub-pixel turns spread over 3-5 vertices at a real corner, arc-length NMS (`nmsArcPx`) keeps smooth curves from fragmenting into micro-arcs, and the strict threshold together match what the eye perceives as real corners; returns boolean[] aligned with `points` (closed-loop semantics).
export function detectCornersByCurvature(
  points: Point[],
  windowArcPx: number = 3,
  cornerThresholdDeg: number = 70,
  nmsArcPx: number = 12
): boolean[] {
  const n = points.length;
  const isCorner = new Array(n).fill(false);
  if (n < 5) return isCorner;

  // Compute perimeter and average vertex spacing for arc-length scaling.
  let perim = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    perim += Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
  }
  const avgSpacing = Math.max(0.05, perim / n);
  const windowK = Math.max(2, Math.min(Math.floor(n / 4), Math.round(windowArcPx / avgSpacing)));
  const nmsHalf = Math.max(windowK + 1, Math.min(Math.floor(n / 4), Math.round(nmsArcPx / avgSpacing)));
  const thresh = cornerThresholdDeg * Math.PI / 180;

  // Per-vertex windowed turning angle = "corner score": a real corner concentrates its turn in the small window (high score), a smooth arc spreads the same total turn over many vertices (low score).
  const score = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let totalTurn = 0;
    for (let off = -windowK + 1; off <= windowK - 1; off++) {
      const ia = (i + off - 1 + n) % n;
      const ib = (i + off + n) % n;
      const ic = (i + off + 1 + n) % n;
      const v1x = points[ib].x - points[ia].x;
      const v1y = points[ib].y - points[ia].y;
      const v2x = points[ic].x - points[ib].x;
      const v2y = points[ic].y - points[ib].y;
      const l1 = Math.sqrt(v1x * v1x + v1y * v1y);
      const l2 = Math.sqrt(v2x * v2x + v2y * v2y);
      if (l1 < 1e-9 || l2 < 1e-9) continue;
      const cross = v1x * v2y - v1y * v2x;
      const dot = v1x * v2x + v1y * v2y;
      totalTurn += Math.abs(Math.atan2(cross, dot));
    }
    score[i] = totalTurn;
  }

  // Mark above-threshold vertices then NMS the score field (only the strongest vertex within ±nmsHalf survives) so adjacent "soft" features don't all become corners.
  for (let i = 0; i < n; i++) {
    if (score[i] <= thresh) continue;
    let isMax = true;
    for (let off = -nmsHalf; off <= nmsHalf; off++) {
      if (off === 0) continue;
      const j = (i + off + n) % n;
      if (score[j] > score[i]) { isMax = false; break; }
    }
    if (isMax) isCorner[i] = true;
  }

  return isCorner;
}

// Max perpendicular distance from any interior point to the chord (start..end), used to decide if a sub-polyline is "straight enough" to emit as a single line instead of curve-fitting.
export function _maxChordDeviation(points: Point[]): number {
  if (points.length < 3) return 0;
  const a = points[0];
  const b = points[points.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-9) return 0;
  let maxDev = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const px = points[i].x - a.x;
    const py = points[i].y - a.y;
    // perp dist = |cross(d, p)| / |d|
    const dev = Math.abs(dx * py - dy * px) / len;
    if (dev > maxDev) maxDev = dev;
  }
  return maxDev;
}

// Top-level: convert a closed polyline into a BezierPath; `tolerancePx` controls fit tightness (0.4px ≈ 0.001" at 300 DPI in our SUPER_SAMPLE-downscaled space, well below visible threshold), `straightTolPx` controls when a sub-segment qualifies as a single straight line.
export function polylineToBezierPath(
  closedPolyline: Point[],
  tolerancePx: number = 1.0,
  straightTolPx: number = 0.7
): BezierPath {
  const n = closedPolyline.length;
  if (n < 3) {
    return {
      start: closedPolyline[0] || { x: 0, y: 0 },
      segments: [],
      closed: true,
    };
  }

  // 1) Detect real corners first (threshold 50°, dropped from 70° so the ellipse snap below refuses to fire on shapes with even moderate protrusions like fire badges/gears/sun-rays; narrow ~3px detection window + wide ~12px NMS distinguishes actual corners from soft bends — without strict NMS the dense post-RDP polyline fragments into micro-corners → degenerate near-linear cubics → rough PDF); computed up front so the ellipse snap can refuse shapes with real sharp corners instead of replacing them with a perfect circle on low average residual.
  let corners = detectCornersByCurvature(closedPolyline, 3, 50, 12);
  let cornerCount = 0;
  for (let i = 0; i < n; i++) if (corners[i]) cornerCount++;

  // 0) Analytical ellipse snap — disabled by default: it used to replace smooth closed loops (cornerCount<2) fitting an ellipse within ~1.5% residual with 4 perfect quarter-arcs, but false-positived on near-circular badges with thin protrusions (fire-dept seals, ham-radio logos), overwriting the real outline; user has repeatedly asked for it removed, so it's gated behind ENABLE_ANALYTICAL_ELLIPSE_SNAP rather than deleted (still useful as a diagnostic / future "auto-ellipse" option) — set the flag true to re-enable, or also remove `detectAndSnapEllipse`/`ellipseToBezierPath` to delete entirely.
  const ENABLE_ANALYTICAL_ELLIPSE_SNAP = false;
  if (ENABLE_ANALYTICAL_ELLIPSE_SNAP && cornerCount < 2) {
    const ellipse = detectAndSnapEllipse(closedPolyline, 0.015);
    if (ellipse) {
      console.log(
        '[Worker] Ellipse snap accepted: cx=' + ellipse.cx.toFixed(2) +
        ', cy=' + ellipse.cy.toFixed(2) +
        ', rx=' + ellipse.rx.toFixed(2) +
        ', ry=' + ellipse.ry.toFixed(2) +
        ', theta=' + (ellipse.theta * 180 / Math.PI).toFixed(1) + '°' +
        ', rms=' + ellipse.rmsResidualPx.toFixed(3) + 'px' +
        ', max=' + ellipse.maxResidualPx.toFixed(3) + 'px' +
        ' → emitting 4 quarter-arc cubics'
      );
      return ellipseToBezierPath(ellipse);
    }
  }

  // 2) If no real corners exist (ellipse/blob), synthesize 4 soft corners at the bbox extremes (top/right/bottom/left) to break the loop into 4 manageable arcs.
  let cornerIndices: number[] = [];
  for (let i = 0; i < n; i++) if (corners[i]) cornerIndices.push(i);
  if (cornerIndices.length < 2) {
    let topI = 0, rightI = 0, bottomI = 0, leftI = 0;
    let topY = closedPolyline[0].y, bottomY = closedPolyline[0].y;
    let rightX = closedPolyline[0].x, leftX = closedPolyline[0].x;
    for (let i = 1; i < n; i++) {
      const p = closedPolyline[i];
      if (p.y < topY) { topY = p.y; topI = i; }
      if (p.y > bottomY) { bottomY = p.y; bottomI = i; }
      if (p.x > rightX) { rightX = p.x; rightI = i; }
      if (p.x < leftX) { leftX = p.x; leftI = i; }
    }
    cornerIndices = Array.from(new Set([topI, rightI, bottomI, leftI])).sort((a, b) => a - b);
    corners = new Array(n).fill(false);
    for (const i of cornerIndices) corners[i] = true;
  }

  // 3) Walk corner-to-corner segments around the closed loop and fit each.
  const start = closedPolyline[cornerIndices[0]];
  const segments: BezierSegment[] = [];

  for (let ci = 0; ci < cornerIndices.length; ci++) {
    const startIdx = cornerIndices[ci];
    const endIdx = cornerIndices[(ci + 1) % cornerIndices.length];

    // Extract sub-polyline [startIdx ... endIdx] (cyclic).
    const sub: Point[] = [];
    if (endIdx > startIdx) {
      for (let i = startIdx; i <= endIdx; i++) sub.push(closedPolyline[i]);
    } else {
      for (let i = startIdx; i < n; i++) sub.push(closedPolyline[i]);
      for (let i = 0; i <= endIdx; i++) sub.push(closedPolyline[i]);
    }

    if (sub.length < 2) continue;

    // Straight-segment shortcut: emit a line if every interior point is within straightTolPx of the chord.
    if (sub.length === 2 || _maxChordDeviation(sub) <= straightTolPx) {
      segments.push({ type: 'line', to: sub[sub.length - 1] });
      continue;
    }

    // Curved segment — estimate tangents and fit cubics.
    const leftTangent = _estimateTangent(sub, 0, 'forward');
    const rightTangent = _estimateTangent(sub, sub.length - 1, 'backward');
    const fittedSegs = _fitBeziersRecursive(sub, leftTangent, rightTangent, tolerancePx, 0);

    // Validation gate (prevents "stray pink lines in PDF"): Schneider fit residual at vertices can be OK while control points still overshoot into the design interior, invisibly to the preview (which just rasterizes the source polyline) — sample the fitted cubics and fall back to line segments (pixel-matching the preview) if any sample exceeds `validationTolPx`, intentionally looser than the 0.4px fit target (1.5px) since we only reject visibly-diverging fits.
    const validationTolPx = Math.max(1.5, tolerancePx * 2.5);
    const valid = _validateBezierSegments(sub, fittedSegs, sub[0], validationTolPx);
    if (valid) {
      for (const c of fittedSegs) segments.push(c);
    } else {
      // Fallback: don't emit every dense polyline vertex as a separate line (the "rough chains of micro-segments" pattern reported by the user) — RDP-simplify the sub-polyline first (epsilon ≤ validationTolPx keeps it pixel-faithful) so emitted lines are as smooth as the simplified polygon allows.
      const fallbackEps = Math.max(0.8, tolerancePx);
      const subPerim = Math.max(1, calculatePerimeter(sub));
      const simplifiedSub = approxPolyDP(sub, fallbackEps / subPerim);
      const useSub = simplifiedSub.length >= 2 ? simplifiedSub : sub;
      console.warn(
        '[Worker] Bezier fit failed validation for sub-polyline (n=' + sub.length + ', segs=' +
        fittedSegs.length + ') — falling back to ' + (useSub.length - 1) + ' line segments (RDP-simplified)'
      );
      for (const lineSeg of _polylineAsLineSegments(useSub)) segments.push(lineSeg);
    }
  }

  return { start, segments, closed: true };
}

// Sample a BezierPath back into a dense polyline (for raster preview rendering, sliver guards, area calculations) — lines emit 2 points, cubics are sampled at `samplesPerCubic` intermediate parameters.
export function sampleBezierPathToPolyline(path: BezierPath, samplesPerCubic: number = 16): Point[] {
  const out: Point[] = [];
  if (path.segments.length === 0) return out;
  out.push({ x: path.start.x, y: path.start.y });
  let cur: Point = path.start;
  for (const seg of path.segments) {
    if (seg.type === 'line') {
      out.push({ x: seg.to.x, y: seg.to.y });
      cur = seg.to;
    } else {
      for (let i = 1; i <= samplesPerCubic; i++) {
        const t = i / samplesPerCubic;
        out.push(_evalBezier(cur, seg.cp1, seg.cp2, seg.to, t));
      }
      cur = seg.to;
    }
  }
  return out;
}

// Convert a BezierPath from pixel coordinates to inches in the PDF coordinate system (Y-flipped, offset by minPath/bleed).
export function bezierPathPxToInches(
  path: BezierPath,
  minPathX: number,
  minPathY: number,
  effectiveDPI: number,
  bleedInches: number,
  pageHeightInches: number
): BezierPath {
  const cvt = (p: { x: number; y: number }) => ({
    x: ((p.x - minPathX) / effectiveDPI) + bleedInches,
    y: pageHeightInches - (((p.y - minPathY) / effectiveDPI) + bleedInches),
  });
  return {
    start: cvt(path.start),
    segments: path.segments.map(seg =>
      seg.type === 'line'
        ? { type: 'line', to: cvt(seg.to) }
        : { type: 'cubic', cp1: cvt(seg.cp1), cp2: cvt(seg.cp2), to: cvt(seg.to) }
    ),
    closed: true,
  };
}

// Multiply every point in a BezierPath by `scale`, used by the worker dispatcher's downscale-rescale path to remap bezier paths from scaled DPI back to original-image pixel coordinates.
export function bezierPathScale(path: BezierPath, scale: number): BezierPath {
  const sm = (p: { x: number; y: number }) => ({ x: p.x * scale, y: p.y * scale });
  return {
    start: sm(path.start),
    segments: path.segments.map(seg =>
      seg.type === 'line'
        ? { type: 'line', to: sm(seg.to) }
        : { type: 'cubic', cp1: sm(seg.cp1), cp2: sm(seg.cp2), to: sm(seg.to) }
    ),
    closed: true,
  };
}

// Ramer-Douglas-Peucker path simplification — "pulls the line tight" instead of creating waves like a moving average.
export function douglasPeucker(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;
  
  let maxDist = 0;
  let maxIndex = 0;
  
  const first = points[0];
  const last = points[points.length - 1];
  
  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistanceRDP(points[i], first, last);
    if (dist > maxDist) {
      maxDist = dist;
      maxIndex = i;
    }
  }
  
  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, maxIndex + 1), epsilon);
    const right = douglasPeucker(points.slice(maxIndex), epsilon);
    return left.slice(0, -1).concat(right);
  } else {
    return [first, last];
  }
}

export function perpendicularDistanceRDP(point: Point, lineStart: Point, lineEnd: Point): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  
  if (dx === 0 && dy === 0) {
    return Math.sqrt((point.x - lineStart.x) ** 2 + (point.y - lineStart.y) ** 2);
  }
  
  const t = Math.max(0, Math.min(1,
    ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / (dx * dx + dy * dy)
  ));
  
  const nearestX = lineStart.x + t * dx;
  const nearestY = lineStart.y + t * dy;
  
  return Math.sqrt((point.x - nearestX) ** 2 + (point.y - nearestY) ** 2);
}

// RDP for closed polygons - handles wrap-around at endpoints
export function rdpSimplifyPolygon(points: Point[], tolerance: number): Point[] {
  if (points.length < 4) return points;
  
  // Find point furthest from centroid as split point
  const centroidX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const centroidY = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  
  let maxDist = 0;
  let splitIndex = 0;
  for (let i = 0; i < points.length; i++) {
    const dist = Math.sqrt((points[i].x - centroidX) ** 2 + (points[i].y - centroidY) ** 2);
    if (dist > maxDist) {
      maxDist = dist;
      splitIndex = i;
    }
  }
  
  // Rotate array so split point is at start/end
  const rotated = [...points.slice(splitIndex), ...points.slice(0, splitIndex)];
  rotated.push({ ...rotated[0] });
  
  // Simplify the open path using Douglas-Peucker
  const simplified = douglasPeucker(rotated, tolerance);
  
  // Remove the duplicate closing point
  if (simplified.length > 1) {
    simplified.pop();
  }
  
  return simplified;
}

// Prune short segments that create tiny "jogs" on flat edges — only removes them when the angle change is shallow, preserving sharp corners.
export function pruneShortSegments(points: Point[], minLength: number = 4, maxAngleDegrees: number = 30): Point[] {
  if (points.length < 4) return points;
  
  const result: Point[] = [];
  const n = points.length;
  
  for (let i = 0; i < n; i++) {
    const prev = result.length > 0 ? result[result.length - 1] : points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    
    // Calculate segment length from prev to curr
    const segmentLength = Math.sqrt((curr.x - prev.x) ** 2 + (curr.y - prev.y) ** 2);
    
    // If segment is short, check if we can skip this point
    if (segmentLength < minLength && result.length > 0) {
      // Vector from prev to curr
      const v1x = curr.x - prev.x;
      const v1y = curr.y - prev.y;
      // Vector from curr to next
      const v2x = next.x - curr.x;
      const v2y = next.y - curr.y;
      
      const len1 = Math.sqrt(v1x * v1x + v1y * v1y);
      const len2 = Math.sqrt(v2x * v2x + v2y * v2y);
      
      if (len1 > 0.001 && len2 > 0.001) {
        // Angle at the current point (between incoming and outgoing vectors)
        const dot = v1x * v2x + v1y * v2y;
        const cosAngle = dot / (len1 * len2);
        const angleDegrees = Math.acos(Math.max(-1, Math.min(1, cosAngle))) * 180 / Math.PI;
        
        // If the angle is shallow (close to 180 = straight line), skip this point
        if (angleDegrees > (180 - maxAngleDegrees)) {
          continue;
        }
      }
    }
    
    result.push(curr);
  }
  
  return result.length >= 3 ? result : points;
}

// Sanitize polygon to fix self-intersections (bow-ties) before offset via Clipper's SimplifyPolygon (a Boolean Union that unties crossings), and ensure correct CCW winding for outer contours.
export function sanitizePolygonForOffset(points: Point[]): Point[] {
  if (points.length < 3) return points;
  
  // Convert to Clipper format with scaling
  const clipperPath: Array<{X: number; Y: number}> = points.map(p => ({
    X: Math.round(p.x * CLIPPER_SCALE),
    Y: Math.round(p.y * CLIPPER_SCALE)
  }));
  
  // Step 1: SimplifyPolygon (a Boolean Union) resolves all crossing edges, fixing self-intersections.
  const simplified = ClipperLib.Clipper.SimplifyPolygon(clipperPath, ClipperLib.PolyFillType.pftNonZero);
  
  if (!simplified || simplified.length === 0) {
    console.log('[Worker] SimplifyPolygon returned empty, keeping original');
    return points;
  }
  
  // Find the largest polygon (by area) if there are multiple
  let largestPath = simplified[0];
  let largestArea = Math.abs(ClipperLib.Clipper.Area(simplified[0]));
  
  for (let i = 1; i < simplified.length; i++) {
    const area = Math.abs(ClipperLib.Clipper.Area(simplified[i]));
    if (area > largestArea) {
      largestArea = area;
      largestPath = simplified[i];
    }
  }
  
  if (!largestPath || largestPath.length < 3) {
    console.log('[Worker] No valid polygon after simplify, keeping original');
    return points;
  }
  
  // Step 2: force CCW winding for outer shapes via shoelace formula (positive area = CCW in Y-up coords; canvas is Y-down so signs invert — positive = CW, negative = CCW).
  let signedArea = 0;
  let wasReversed = false;
  for (let i = 0; i < largestPath.length; i++) {
    const j = (i + 1) % largestPath.length;
    signedArea += largestPath[i].X * largestPath[j].Y - largestPath[j].X * largestPath[i].Y;
  }
  // In Y-down canvas coords: negative area = CCW (what we want), positive = CW (needs reverse)
  if (signedArea > 0) {
    // Path is clockwise, reverse it to make counter-clockwise
    largestPath.reverse();
    wasReversed = true;
    console.log('[Worker] Reversed path to counter-clockwise orientation');
  }
  
  // Step 3: Clean up any tiny artifacts
  ClipperLib.Clipper.CleanPolygon(largestPath, CLIPPER_SCALE * 0.107);
  
  // Convert back to Point format
  const result: Point[] = largestPath.map(p => ({
    x: p.X / CLIPPER_SCALE,
    y: p.Y / CLIPPER_SCALE
  }));
  
  if (result.length < 3) {
    console.log('[Worker] Sanitized path too short, keeping original');
    return points;
  }
  
  console.log('[Worker] Sanitized:', points.length, '->', result.length, 'points');
  
  return result;
}

// Zero Hero / preview: Chaikin + approxPolyDP can produce self-intersecting rings that canvas nonzero-fill "cancels" into diagonal clips, so Clipper SimplifyPolygon splits bow-ties into simple polygons, and slivers/degenerate parts are dropped (area < MIN_AREA_PX2, very low density, or < 0.5% of the largest part — artifacts of de-self-intersecting a ring) since RDP would otherwise render them as a long diagonal line in the PDF.
export function simplifyClosedPathToSimpleParts(points: Point[]): Point[][] {
  if (points.length < 3) return [];
  const clipperPath = points.map((p) => ({
    X: Math.round(p.x * CLIPPER_SCALE),
    Y: Math.round(p.y * CLIPPER_SCALE),
  }));
  const simplified = ClipperLib.Clipper.SimplifyPolygon(
    clipperPath,
    ClipperLib.PolyFillType.pftNonZero
  );
  if (!simplified || simplified.length === 0) return [points];

  type Candidate = { pts: Point[]; area: number; density: number };
  const candidates: Candidate[] = [];
  for (const poly of simplified) {
    if (!poly || poly.length < 3) continue;
    ClipperLib.Clipper.CleanPolygon(poly, CLIPPER_SCALE * 0.107);
    if (poly.length < 3) continue;
    const pts = poly.map((p) => ({ x: p.X / CLIPPER_SCALE, y: p.Y / CLIPPER_SCALE }));
    const area = Math.abs(polygonArea(pts));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const bw = Math.max(1e-3, maxX - minX);
    const bh = Math.max(1e-3, maxY - minY);
    const density = area / (bw * bh);
    candidates.push({ pts, area, density });
  }
  if (candidates.length === 0) return [points];

  const MIN_AREA_PX2 = 4; // anything tinier is rounding noise
  const MIN_DENSITY = 0.02; // < 2% area-to-bbox is a sliver/line
  const REL_TO_LARGEST = 0.005; // <0.5% of the largest part is bow-tie shrapnel
  const MAX_ASPECT_VS_LARGEST = 8; // long thin polygons whose long axis spans the largest part

  // Largest part by area + its bbox, used as the parent reference frame for detecting "spans-the-whole-design" diagonal slashes.
  const largest = candidates.reduce((best, c) => (c.area > best.area ? c : best), candidates[0]);
  const largestArea = largest.area;
  let lMinX = Infinity, lMinY = Infinity, lMaxX = -Infinity, lMaxY = -Infinity;
  for (const p of largest.pts) {
    if (p.x < lMinX) lMinX = p.x;
    if (p.x > lMaxX) lMaxX = p.x;
    if (p.y < lMinY) lMinY = p.y;
    if (p.y > lMaxY) lMaxY = p.y;
  }
  const lW = Math.max(1, lMaxX - lMinX);
  const lH = Math.max(1, lMaxY - lMinY);

  const filtered = candidates.filter((c) => {
    if (c.area < MIN_AREA_PX2) return false;
    if (c.density < MIN_DENSITY) return false;
    if (largestArea > 0 && c.area / largestArea < REL_TO_LARGEST) return false;

    // Skip the largest itself for the aspect/spans check (it IS the cut path).
    if (c === largest) return true;

    // Diagonal-slash guard: bow-tie split remnants are extremely elongated and their long axis covers most of the parent bbox, unlike real detail (eyes, small islands) which is locally compact and doesn't span.
    let pMinX = Infinity, pMinY = Infinity, pMaxX = -Infinity, pMaxY = -Infinity;
    for (const p of c.pts) {
      if (p.x < pMinX) pMinX = p.x;
      if (p.x > pMaxX) pMaxX = p.x;
      if (p.y < pMinY) pMinY = p.y;
      if (p.y > pMaxY) pMaxY = p.y;
    }
    const pW = pMaxX - pMinX;
    const pH = pMaxY - pMinY;
    const pLong = Math.max(pW, pH);
    const pShort = Math.max(0.5, Math.min(pW, pH));
    const elongation = pLong / pShort;
    const spansLargest = Math.max(pW / lW, pH / lH);
    if (elongation > MAX_ASPECT_VS_LARGEST && spansLargest > 0.4) {
      console.log(
        '[Worker] simplifyClosedPathToSimpleParts: dropping diagonal-slash sliver — elongation=' +
          elongation.toFixed(1) + ', spans=' + spansLargest.toFixed(2) + ', area=' + c.area.toFixed(1)
      );
      return false;
    }
    return true;
  });

  const kept = filtered.length > 0 ? filtered : [largest];
  if (kept.length !== candidates.length) {
    console.log(
      '[Worker] simplifyClosedPathToSimpleParts: dropped',
      candidates.length - kept.length,
      'sliver/degenerate part(s); kept',
      kept.length
    );
  }
  return kept.map((c) => c.pts);
}

// Chaikin's corner-cutting to smooth pixel-step jaggies: replaces each shallow-angle corner with Q (75% toward next) and R (25% toward next), preserving sharp corners (>sharpAngleThreshold) to keep diamond tips.
export function smoothPolyChaikin(points: Point[], iterations: number = 2, sharpAngleThreshold: number = 60): Point[] {
  if (points.length < 3) return points;
  
  let result = [...points];
  
  for (let iter = 0; iter < iterations; iter++) {
    const newPoints: Point[] = [];
    const n = result.length;
    
    for (let i = 0; i < n; i++) {
      const prev = result[(i - 1 + n) % n];
      const curr = result[i];
      const next = result[(i + 1) % n];
      
      // Calculate angle at current point
      const v1x = curr.x - prev.x;
      const v1y = curr.y - prev.y;
      const v2x = next.x - curr.x;
      const v2y = next.y - curr.y;
      
      const len1 = Math.sqrt(v1x * v1x + v1y * v1y);
      const len2 = Math.sqrt(v2x * v2x + v2y * v2y);
      
      // Calculate angle between vectors (0° = same direction, 180° = opposite)
      let angleDegrees = 180; // default to straight line
      if (len1 > 0.0001 && len2 > 0.0001) {
        const dot = v1x * v2x + v1y * v2y;
        const cosAngle = Math.max(-1, Math.min(1, dot / (len1 * len2)));
        angleDegrees = Math.acos(cosAngle) * 180 / Math.PI;
      }
      
      // Deviation from straight line (0° = straight, 180° = U-turn)
      const deviation = 180 - angleDegrees;
      
      // If sharp corner (deviation > threshold), preserve the original point
      if (deviation > sharpAngleThreshold) {
        newPoints.push(curr);
      } else {
        // Chaikin corner cutting for shallow angles: Q = 0.75*P_i + 0.25*P_{i+1} (cut 25% toward next point).
        const qx = 0.75 * curr.x + 0.25 * next.x;
        const qy = 0.75 * curr.y + 0.25 * next.y;
        
        // R = 0.25 * P_i + 0.75 * P_{i+1} (cut 75% from this point toward next)
        const rx = 0.25 * curr.x + 0.75 * next.x;
        const ry = 0.25 * curr.y + 0.75 * next.y;
        
        newPoints.push({ x: qx, y: qy });
        newPoints.push({ x: rx, y: ry });
      }
    }
    
    result = newPoints;
  }
  
  return result;
}

// Straighten noisy lines: detect nearly-collinear point sequences and snap them straight to fix zigzag pixel noise; cornerAngleThreshold preserves angles above it as corners, maxDeviation is the max perpendicular distance to count as collinear.
export function straightenNoisyLines(points: Point[], cornerAngleThreshold: number = 25, maxDeviation: number = 1.5): Point[] {
  if (points.length < 4) return points;
  
  const n = points.length;

  // Cap how far a single straight segment can extend so the algorithm can't collapse a long curved stretch into a shortcut chord (a known cause of downstream bow-tie self-intersections); the cap is anchored to the polygon's short bbox dimension rather than perimeter (which balloons uselessly for detailed boundaries like a fluffy cloud) since bbox short side is the largest a legitimate edge could ever be — any chord over ~25% of it is suspiciously a shortcut.
  let bbMinX = Infinity, bbMinY = Infinity, bbMaxX = -Infinity, bbMaxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    if (p.x < bbMinX) bbMinX = p.x;
    if (p.x > bbMaxX) bbMaxX = p.x;
    if (p.y < bbMinY) bbMinY = p.y;
    if (p.y > bbMaxY) bbMaxY = p.y;
  }
  const bbShort = Math.max(1, Math.min(bbMaxX - bbMinX, bbMaxY - bbMinY));
  const bbLong = Math.max(1, Math.max(bbMaxX - bbMinX, bbMaxY - bbMinY));
  // Cap chords at 1.0×bbShort to allow legitimate long edges (a square's or tall rectangle's short-axis side) as one segment; a tall rectangle's long side just gets traced as multiple sub-segments instead, losing the "fewer points" optimization but not correctness.
  const maxChordLen = Math.max(8, bbShort);
  // For very elongated bboxes, also clamp at a fraction of the long side (defense-in-depth against weird geometries).
  const maxChordLenFinal = Math.min(maxChordLen, bbLong * 0.5);
  
  // First, identify corner points that must be preserved
  const isCorner: boolean[] = new Array(n).fill(false);
  
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    
    // Calculate angle at current point
    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    
    const len1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const len2 = Math.sqrt(v2x * v2x + v2y * v2y);
    
    if (len1 > 0.0001 && len2 > 0.0001) {
      const dot = v1x * v2x + v1y * v2y;
      const cosAngle = Math.max(-1, Math.min(1, dot / (len1 * len2)));
      const angleDegrees = Math.acos(cosAngle) * 180 / Math.PI;
      const deviation = 180 - angleDegrees;
      
      // Mark as corner if angle deviation exceeds threshold
      if (deviation > cornerAngleThreshold) {
        isCorner[i] = true;
      }
    }
  }
  
  // Simple greedy algorithm: process points linearly, extending straight segments while points remain collinear.
  const result: Point[] = [];
  let segmentStart = 0;
  
  while (segmentStart < n) {
    // Always add the segment start point
    result.push(points[segmentStart]);
    
    // If this is a corner, just move to next point
    if (isCorner[segmentStart]) {
      segmentStart++;
      continue;
    }
    
    // Try to extend the straight line as far as possible
    let segmentEnd = segmentStart + 1;
    
    while (segmentEnd < n) {
      // Stop at corners - they break the segment
      if (isCorner[segmentEnd]) {
        break;
      }
      
      // Check if all points from segmentStart to segmentEnd+1 are collinear
      const nextEnd = segmentEnd + 1;
      if (nextEnd > n) break;
      
      const startPt = points[segmentStart];
      const endPt = points[Math.min(nextEnd, n - 1)];
      const dx = endPt.x - startPt.x;
      const dy = endPt.y - startPt.y;
      const lineLen = Math.sqrt(dx * dx + dy * dy);
      
      if (lineLen < 0.0001) {
        segmentEnd++;
        continue;
      }

      // Hard cap on chord length prevents the greedy extension from creating a long shortcut across other parts of the polygon — the root cause of bow-tie self-intersections that downstream code splits into a "diagonal slash" sliver.
      if (lineLen > maxChordLenFinal) {
        break;
      }
      
      // Check if the segment is near-axis-aligned (stair-step prone) and use a more generous tolerance for horizontal/vertical segments.
      const angleRad = Math.atan2(Math.abs(dy), Math.abs(dx));
      const angleDeg = angleRad * 180 / Math.PI;
      const isAxisAligned = angleDeg < 15 || angleDeg > 75; // Within 15° of horizontal or vertical
      const effectiveDeviation = isAxisAligned ? maxDeviation * 1.5 : maxDeviation;
      
      // Check all intermediate points for collinearity
      let allCollinear = true;
      for (let checkIdx = segmentStart + 1; checkIdx <= segmentEnd; checkIdx++) {
        const pt = points[checkIdx];
        // Calculate perpendicular distance from point to line
        const t = Math.max(0, Math.min(1, 
          ((pt.x - startPt.x) * dx + (pt.y - startPt.y) * dy) / (lineLen * lineLen)
        ));
        const projX = startPt.x + t * dx;
        const projY = startPt.y + t * dy;
        const dist = Math.sqrt((pt.x - projX) ** 2 + (pt.y - projY) ** 2);
        
        if (dist > effectiveDeviation) {
          allCollinear = false;
          break;
        }
      }
      
      if (allCollinear) {
        segmentEnd++;
      } else {
        break;
      }
    }
    
    // Move to the end of the collinear segment (skip intermediate points)
    segmentStart = segmentEnd;
  }
  
  // Remove duplicate consecutive points
  const cleaned: Point[] = [];
  for (let i = 0; i < result.length; i++) {
    const prev = i > 0 ? result[i - 1] : result[result.length - 1];
    const curr = result[i];
    const dist = Math.sqrt((curr.x - prev.x) ** 2 + (curr.y - prev.y) ** 2);
    if (dist > 0.5 || cleaned.length === 0) {
      cleaned.push(curr);
    }
  }
  
  console.log('[Worker] Straightened noisy lines:', points.length, '->', cleaned.length, 'points');
  return cleaned.length >= 3 ? cleaned : points;
}

// Moving average smoothing reduces stair-step pixel noise via a weighted average over neighboring points (windowSize, default 3), preserving corners above cornerThreshold (default 30°).
export function movingAverageSmooth(points: Point[], windowSize: number = 3, cornerThreshold: number = 30): Point[] {
  if (points.length < 5) return points;
  
  const n = points.length;
  const halfWindow = Math.floor(windowSize / 2);
  
  // First, identify corners that should not be smoothed
  const isCorner: boolean[] = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    
    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    
    const len1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const len2 = Math.sqrt(v2x * v2x + v2y * v2y);
    
    if (len1 > 0.0001 && len2 > 0.0001) {
      const dot = v1x * v2x + v1y * v2y;
      const cosAngle = Math.max(-1, Math.min(1, dot / (len1 * len2)));
      const angleDegrees = Math.acos(cosAngle) * 180 / Math.PI;
      const deviation = 180 - angleDegrees;
      
      if (deviation > cornerThreshold) {
        isCorner[i] = true;
      }
    }
  }
  
  // Apply weighted moving average, preserving corners
  const result: Point[] = [];
  for (let i = 0; i < n; i++) {
    // Preserve corners exactly
    if (isCorner[i]) {
      result.push(points[i]);
      continue;
    }
    
    // Calculate weighted average of neighboring points
    let sumX = 0, sumY = 0, weightSum = 0;
    
    for (let j = -halfWindow; j <= halfWindow; j++) {
      const idx = (i + j + n) % n;
      // Don't average across corners
      if (j !== 0 && isCorner[idx]) continue;
      
      // Weight: center point has highest weight, decreases with distance
      const weight = 1 - Math.abs(j) / (halfWindow + 1);
      sumX += points[idx].x * weight;
      sumY += points[idx].y * weight;
      weightSum += weight;
    }
    
    if (weightSum > 0) {
      result.push({ x: sumX / weightSum, y: sumY / weightSum });
    } else {
      result.push(points[i]);
    }
  }
  
  console.log('[Worker] Moving average smooth:', points.length, '->', result.length, 'points');
  return result;
}

export function fixOffsetCrossings(points: Point[]): Point[] {
  if (points.length < 6) return points;
  
  let result = [...points];
  
  // Multiple passes to catch all crossings and loops
  for (let pass = 0; pass < 3; pass++) {
    result = detectAndFixLineCrossings(result);
    result = mergeClosePathPoints(result);
  }
  
  // Remove backtracking points (sharp reversals that create tiny loops)
  result = removeBacktrackingPoints(result);
  
  // Ensure consistent winding direction
  result = ensureClockwiseWinding(result);
  
  return result;
}

// Remove points that cause the path to backtrack (sharp >160 degree turns)
export function removeBacktrackingPoints(points: Point[]): Point[] {
  if (points.length < 5) return points;
  
  const result: Point[] = [];
  const n = points.length;
  
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    
    // Calculate vectors
    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    
    const len1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const len2 = Math.sqrt(v2x * v2x + v2y * v2y);
    
    // Skip degenerate cases
    if (len1 < 0.0001 || len2 < 0.0001) {
      continue;
    }
    
    // Calculate dot product for angle between vectors
    const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
    
    // If angle is greater than ~160 degrees (dot < -0.94), this is a backtrack/loop
    if (dot < -0.94) {
      continue; // Skip this point
    }
    
    result.push(curr);
  }
  
  return result.length >= 3 ? result : points;
}

// Ensure path goes clockwise (for proper cutting direction)
export function ensureClockwiseWinding(points: Point[]): Point[] {
  if (points.length < 3) return points;
  
  // Calculate signed area (shoelace formula)
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const curr = points[i];
    const next = points[(i + 1) % n];
    area += (curr.x * next.y) - (next.x * curr.y);
  }
  
  // Positive area = counter-clockwise, reverse to make clockwise
  if (area > 0) {
    return [...points].reverse();
  }
  
  return points;
}

export function detectAndFixLineCrossings(points: Point[]): Point[] {
  if (points.length < 6) return points;
  
  const n = points.length;
  const result: Point[] = [];
  const skipUntil = new Map<number, number>();
  
  const stride = n > 1000 ? 3 : 1;
  
  for (let i = 0; i < n; i += stride) {
    let shouldSkip = false;
    const entries = Array.from(skipUntil.entries());
    for (let e = 0; e < entries.length; e++) {
      const [start, end] = entries[e];
      if (i > start && i < end) {
        shouldSkip = true;
        break;
      }
    }
    if (shouldSkip) continue;
    
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    
    const maxSearch = Math.min(n - 1, i + 300);
    for (let j = i + 3; j < maxSearch; j += stride) {
      const p3 = points[j];
      const p4 = points[(j + 1) % n];
      
      const intersection = lineSegmentIntersect(p1, p2, p3, p4);
      if (intersection) {
        skipUntil.set(i, j);
        result.push(intersection);
        break;
      }
    }
    
    if (!skipUntil.has(i)) {
      result.push(p1);
    }
  }
  
  return result.length >= 3 ? result : points;
}

export function lineSegmentIntersect(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 0.0001) return null;
  
  const dx = p3.x - p1.x;
  const dy = p3.y - p1.y;
  
  const t = (dx * d2y - dy * d2x) / cross;
  const u = (dx * d1y - dy * d1x) / cross;
  
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return {
      x: p1.x + t * d1x,
      y: p1.y + t * d1y
    };
  }
  
  return null;
}

export function mergeClosePathPoints(points: Point[]): Point[] {
  if (points.length < 6) return points;
  
  const n = points.length;
  const result: Point[] = [];
  const skipIndices = new Set<number>();
  
  const stride = n > 1000 ? 3 : 1;
  
  for (let i = 0; i < n; i += stride) {
    if (skipIndices.has(i)) continue;
    
    const pi = points[i];
    
    const maxSearch = Math.min(n, i + 300);
    for (let j = i + 10; j < maxSearch; j += stride) {
      if (skipIndices.has(j)) continue;
      
      const pj = points[j];
      const distSq = (pi.x - pj.x) ** 2 + (pi.y - pj.y) ** 2;
      
      if (distSq < 100) {
        for (let k = i + 1; k < j; k++) {
          skipIndices.add(k);
        }
        result.push({ x: (pi.x + pj.x) / 2, y: (pi.y + pj.y) / 2 });
        skipIndices.add(j);
        break;
      }
    }
    
    if (!skipIndices.has(i)) {
      result.push(pi);
    }
  }
  
  return result.length >= 3 ? result : points;
}

export function getPolygonSignedArea(path: Point[]): number {
  let area = 0;
  const n = path.length;
  for (let i = 0; i < n; i++) {
    const curr = path[i];
    const next = path[(i + 1) % n];
    area += (curr.x * next.y) - (next.x * curr.y);
  }
  return area / 2;
}

export function expandPathOutward(path: Point[], expansionPixels: number): Point[] {
  if (path.length < 3) return path;
  
  // Winding direction (positive area = CCW, negative = CW) determines normal sign: CCW polygons' perpendicular normals point inward (negate), CW polygons' point outward (keep).
  const signedArea = getPolygonSignedArea(path);
  const windingMultiplier = signedArea >= 0 ? -1 : 1;
  
  const expanded: Point[] = [];
  const n = path.length;
  
  for (let i = 0; i < n; i++) {
    const prev = path[(i - 1 + n) % n];
    const curr = path[i];
    const next = path[(i + 1) % n];
    
    // Calculate edge vectors
    const e1x = curr.x - prev.x;
    const e1y = curr.y - prev.y;
    const e2x = next.x - curr.x;
    const e2y = next.y - curr.y;
    
    // Calculate perpendicular normals
    const len1 = Math.sqrt(e1x * e1x + e1y * e1y) || 1;
    const len2 = Math.sqrt(e2x * e2x + e2y * e2y) || 1;
    
    const n1x = -e1y / len1;
    const n1y = e1x / len1;
    const n2x = -e2y / len2;
    const n2y = e2x / len2;
    
    // Average the normals for smooth expansion
    let nx = (n1x + n2x) / 2;
    let ny = (n1y + n2y) / 2;
    const nlen = Math.sqrt(nx * nx + ny * ny) || 1;
    nx /= nlen;
    ny /= nlen;
    
    // Apply winding multiplier to ensure outward expansion
    expanded.push({
      x: curr.x + nx * expansionPixels * windingMultiplier,
      y: curr.y + ny * expansionPixels * windingMultiplier
    });
  }
  
  return expanded;
}

export function fillContourToMask(
  mask: Uint8Array,
  width: number,
  height: number,
  path: Point[],
  offsetX: number,
  offsetY: number
): void {
  if (path.length < 3) return;
  
  // Use scanline fill algorithm
  const edges: Array<{ yMin: number; yMax: number; xAtYMin: number; slope: number }> = [];
  
  for (let i = 0; i < path.length; i++) {
    const p1 = path[i];
    const p2 = path[(i + 1) % path.length];
    
    const x1 = Math.round(p1.x + offsetX);
    const y1 = Math.round(p1.y + offsetY);
    const x2 = Math.round(p2.x + offsetX);
    const y2 = Math.round(p2.y + offsetY);
    
    if (y1 === y2) continue; // Skip horizontal edges
    
    const yMin = Math.min(y1, y2);
    const yMax = Math.max(y1, y2);
    const xAtYMin = y1 < y2 ? x1 : x2;
    const slope = (x2 - x1) / (y2 - y1);
    
    edges.push({ yMin, yMax, xAtYMin, slope });
  }
  
  // Find y range
  let minY = height, maxY = 0;
  for (const edge of edges) {
    minY = Math.min(minY, edge.yMin);
    maxY = Math.max(maxY, edge.yMax);
  }
  minY = Math.max(0, minY);
  maxY = Math.min(height - 1, maxY);
  
  // Scanline fill
  for (let y = minY; y <= maxY; y++) {
    const intersections: number[] = [];
    
    for (const edge of edges) {
      if (y >= edge.yMin && y < edge.yMax) {
        const x = edge.xAtYMin + (y - edge.yMin) * edge.slope;
        intersections.push(x);
      }
    }
    
    intersections.sort((a, b) => a - b);
    
    for (let i = 0; i < intersections.length - 1; i += 2) {
      const xStart = Math.max(0, Math.round(intersections[i]));
      const xEnd = Math.min(width - 1, Math.round(intersections[i + 1]));
      
      for (let x = xStart; x <= xEnd; x++) {
        mask[y * width + x] = 1;
      }
    }
  }
}

export function dilateMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number
): Uint8Array {
  const result = new Uint8Array(width * height);
  
  // Pre-compute circle offsets for the dilation radius
  const offsets: Array<{ dx: number; dy: number }> = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) {
        offsets.push({ dx, dy });
      }
    }
  }
  
  // For each pixel in the mask, if it's set, set all pixels within radius
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        for (const { dx, dy } of offsets) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            result[ny * width + nx] = 1;
          }
        }
      }
    }
  }
  
  return result;
}

export function drawContourToData(
  output: Uint8ClampedArray, 
  width: number, 
  height: number, 
  path: Point[], 
  strokeColorHex: string,
  backgroundColorHex: string, 
  offsetX: number, 
  offsetY: number,
  effectiveDPI: number,
  isPreview?: boolean
): void {
  const bgColorHex = backgroundColorHex || '#ffffff';
  
  const bleedInches = isPreview ? 0.02 : 0.10;
  const bleedPixels = Math.round(bleedInches * effectiveDPI);
  
  // Use the same path for bleed that PDF uses (no gap-closing modification) — PDF export applies the smoothed path directly.
  const bleedPath = path;
  
  // Use OffscreenCanvas for proper canvas stroke rendering (matches PDF exactly)
  const offscreen = new OffscreenCanvas(width, height);
  const ctx = offscreen.getContext('2d');
  
  if (ctx) {
    // Draw bleed the same way PDF export does: lineWidth = bleedPixels*2 (stroke centered on path + interior fill) extends bleedPixels on each side, giving a visible bleed of 0.10 inches.
    ctx.fillStyle = bgColorHex;
    ctx.strokeStyle = bgColorHex;
    ctx.lineWidth = bleedPixels * 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    
    if (bleedPath.length > 0) {
      ctx.beginPath();
      ctx.moveTo(bleedPath[0].x + offsetX, bleedPath[0].y + offsetY);
      for (let i = 1; i < bleedPath.length; i++) {
        ctx.lineTo(bleedPath[i].x + offsetX, bleedPath[i].y + offsetY);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.fill('evenodd');
    }
    
    // Draw cut line (magenta) - make it visible at any DPI
    const cutLineWidth = Math.max(2, Math.round(0.01 * effectiveDPI));
    ctx.strokeStyle = strokeColorHex;
    ctx.lineWidth = cutLineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    
    if (path.length > 0) {
      ctx.beginPath();
      ctx.moveTo(path[0].x + offsetX, path[0].y + offsetY);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x + offsetX, path[i].y + offsetY);
      }
      ctx.closePath();
      ctx.stroke();
    }
    
    // Composite canvas data onto output (preserve previously drawn paths)
    const imageData = ctx.getImageData(0, 0, width, height);
    for (let i = 0; i < imageData.data.length; i += 4) {
      if (imageData.data[i + 3] > 0) {
        output[i]     = imageData.data[i];
        output[i + 1] = imageData.data[i + 1];
        output[i + 2] = imageData.data[i + 2];
        output[i + 3] = imageData.data[i + 3];
      }
    }
  } else {
    // Fallback to manual rendering if OffscreenCanvas not available
    const bgR = parseInt(bgColorHex.slice(1, 3), 16);
    const bgG = parseInt(bgColorHex.slice(3, 5), 16);
    const bgB = parseInt(bgColorHex.slice(5, 7), 16);
    const r = parseInt(strokeColorHex.slice(1, 3), 16);
    const g = parseInt(strokeColorHex.slice(3, 5), 16);
    const b = parseInt(strokeColorHex.slice(5, 7), 16);
    
    strokePathThick(output, width, height, bleedPath, offsetX, offsetY, bgR, bgG, bgB, bleedPixels);
    fillContourDirect(output, width, height, bleedPath, offsetX, offsetY, bgR, bgG, bgB);
    
    for (let i = 0; i < path.length; i++) {
      const p1 = path[i];
      const p2 = path[(i + 1) % path.length];
      const x1 = Math.round(p1.x + offsetX);
      const y1 = Math.round(p1.y + offsetY);
      const x2 = Math.round(p2.x + offsetX);
      const y2 = Math.round(p2.y + offsetY);
      drawLine(output, width, height, x1, y1, x2, y2, r, g, b);
      drawLine(output, width, height, x1 + 1, y1, x2 + 1, y2, r, g, b);
      drawLine(output, width, height, x1 - 1, y1, x2 - 1, y2, r, g, b);
      drawLine(output, width, height, x1, y1 + 1, x2, y2 + 1, r, g, b);
      drawLine(output, width, height, x1, y1 - 1, x2, y2 - 1, r, g, b);
    }
  }
}

// Draw a hole cutout: erase the hole interior (transparent) and draw the cut line, using OffscreenCanvas destination-out composite to punch through the background.
export function drawHoleCutout(
  output: Uint8ClampedArray,
  width: number,
  height: number,
  path: Point[],
  strokeColorHex: string,
  offsetX: number,
  offsetY: number,
  effectiveDPI: number
): void {
  if (path.length < 3) return;

  const offscreen = new OffscreenCanvas(width, height);
  const ctx = offscreen.getContext('2d');
  if (!ctx) return;

  // Copy current output to the offscreen canvas
  const existingData = new ImageData(new Uint8ClampedArray(output), width, height);
  ctx.putImageData(existingData, 0, 0);

  // Erase the hole interior using destination-out
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = 'rgba(0,0,0,1)';
  ctx.beginPath();
  ctx.moveTo(path[0].x + offsetX, path[0].y + offsetY);
  for (let i = 1; i < path.length; i++) {
    ctx.lineTo(path[i].x + offsetX, path[i].y + offsetY);
  }
  ctx.closePath();
  ctx.fill('evenodd');

  // Draw cut line on top
  ctx.globalCompositeOperation = 'source-over';
  const cutLineWidth = Math.max(2, Math.round(0.01 * effectiveDPI));
  ctx.strokeStyle = strokeColorHex;
  ctx.lineWidth = cutLineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(path[0].x + offsetX, path[0].y + offsetY);
  for (let i = 1; i < path.length; i++) {
    ctx.lineTo(path[i].x + offsetX, path[i].y + offsetY);
  }
  ctx.closePath();
  ctx.stroke();

  // Copy back to output
  const result = ctx.getImageData(0, 0, width, height);
  output.set(result.data);
}

// Stroke only the cut line(s) on top of an already-rendered output buffer (design image over the contour) so the magenta cut path stays visible instead of being obscured.
export function strokeCutLineOnTop(
  output: Uint8ClampedArray,
  width: number,
  height: number,
  paths: Point[][],
  strokeColorHex: string,
  offsetX: number,
  offsetY: number,
  effectiveDPI: number,
  // Optional Bezier representation: when provided and non-empty, the preview strokes with `bezierCurveTo` so on-screen matches the PDF exactly (preview ≡ download); polyline `paths` are used only as a fallback when the Bezier list is missing/empty (non-ZeroHero modes).
  bezierPaths?: BezierPath[]
): void {
  const useBezier = !!(bezierPaths && bezierPaths.length > 0);
  if (!useBezier && paths.length === 0) return;

  const offscreen = new OffscreenCanvas(width, height);
  const ctx = offscreen.getContext('2d');
  if (!ctx) return;

  // Start with the existing pixels so compositing back doesn't lose the alpha-correct image content underneath.
  const existingData = new ImageData(new Uint8ClampedArray(output), width, height);
  ctx.putImageData(existingData, 0, 0);

  const cutLineWidth = Math.max(2, Math.round(0.01 * effectiveDPI));
  ctx.strokeStyle = strokeColorHex;
  ctx.lineWidth = cutLineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.globalCompositeOperation = 'source-over';

  if (useBezier) {
    // Preview-coord Bezier paths already include offsetX/offsetY (same shift as `allPreviewPathPoints`), so don't add offset again here.
    for (const bp of bezierPaths!) {
      if (bp.segments.length === 0) continue;
      ctx.beginPath();
      ctx.moveTo(bp.start.x, bp.start.y);
      for (const seg of bp.segments) {
        if (seg.type === 'line') {
          ctx.lineTo(seg.to.x, seg.to.y);
        } else {
          ctx.bezierCurveTo(seg.cp1.x, seg.cp1.y, seg.cp2.x, seg.cp2.y, seg.to.x, seg.to.y);
        }
      }
      if (bp.closed) ctx.closePath();
      ctx.stroke();
    }
  } else {
    for (const path of paths) {
      if (path.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(path[0].x + offsetX, path[0].y + offsetY);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x + offsetX, path[i].y + offsetY);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }

  const result = ctx.getImageData(0, 0, width, height);
  output.set(result.data);
}

// Draw contour with edge-extended background (uses nearest edge colors for bleed)
export function drawContourToDataWithExtendedEdge(
  output: Uint8ClampedArray, 
  width: number, 
  height: number, 
  path: Point[], 
  strokeColorHex: string,
  offsetX: number, 
  offsetY: number,
  effectiveDPI: number,
  extendedImage: ImageData,
  extendedImageOffsetX: number,
  extendedImageOffsetY: number,
  isPreview?: boolean
): void {
  const bleedInches = isPreview ? 0.02 : 0.10;
  const bleedPixels = Math.round(bleedInches * effectiveDPI);
  
  const offscreen = new OffscreenCanvas(width, height);
  const ctx = offscreen.getContext('2d');
  
  if (ctx) {
    // Create a clip path from the contour (with bleed)
    if (path.length > 0) {
      ctx.beginPath();
      ctx.moveTo(path[0].x + offsetX, path[0].y + offsetY);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x + offsetX, path[i].y + offsetY);
      }
      ctx.closePath();
      
      // Stroke with bleed width to expand the fill area
      ctx.lineWidth = bleedPixels * 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'white';
      ctx.stroke();
      ctx.fillStyle = 'white';
      ctx.fill('evenodd');
    }
    
    // Use composite to draw extended image only where we stroked/filled
    ctx.globalCompositeOperation = 'source-in';
    
    // Draw the extended image at the correct position (using separate X and Y offsets)
    const tempCanvas = new OffscreenCanvas(extendedImage.width, extendedImage.height);
    const tempCtx = tempCanvas.getContext('2d');
    if (tempCtx) {
      tempCtx.putImageData(extendedImage, 0, 0);
      ctx.drawImage(tempCanvas, extendedImageOffsetX, extendedImageOffsetY);
    }
    
    // Reset composite mode and draw cut line
    ctx.globalCompositeOperation = 'source-over';
    const cutLineWidth = Math.max(2, Math.round(0.01 * effectiveDPI));
    ctx.strokeStyle = strokeColorHex;
    ctx.lineWidth = cutLineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    
    if (path.length > 0) {
      ctx.beginPath();
      ctx.moveTo(path[0].x + offsetX, path[0].y + offsetY);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x + offsetX, path[i].y + offsetY);
      }
      ctx.closePath();
      ctx.stroke();
    }
    
    // Composite canvas data onto output (preserve previously drawn paths)
    const imageData = ctx.getImageData(0, 0, width, height);
    for (let i = 0; i < imageData.data.length; i += 4) {
      if (imageData.data[i + 3] > 0) {
        output[i]     = imageData.data[i];
        output[i + 1] = imageData.data[i + 1];
        output[i + 2] = imageData.data[i + 2];
        output[i + 3] = imageData.data[i + 3];
      }
    }
  }
}

// Stroke path with a thick line for the bleed effect — draws circles at each vertex plus thick connecting lines, like a round-join stroke.
export function strokePathThick(
  output: Uint8ClampedArray,
  width: number,
  height: number,
  path: Point[],
  offsetX: number,
  offsetY: number,
  r: number,
  g: number,
  b: number,
  lineWidth: number
): void {
  if (path.length < 2) return;
  
  // Canvas stroke normally uses lineWidth/2 as radius from path center, but we want the full bleed width extending outward, so use the full lineWidth — matches PDF export's lineWidth*2 stroke.
  const radius = lineWidth;
  const radiusSq = radius * radius;
  
  // Draw circles at each vertex (round caps/joins)
  for (const p of path) {
    const cx = Math.round(p.x + offsetX);
    const cy = Math.round(p.y + offsetY);
    
    const minX = Math.max(0, cx - radius);
    const maxX = Math.min(width - 1, cx + radius);
    const minY = Math.max(0, cy - radius);
    const maxY = Math.min(height - 1, cy + radius);
    
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= radiusSq) {
          const idx = (y * width + x) * 4;
          output[idx] = r;
          output[idx + 1] = g;
          output[idx + 2] = b;
          output[idx + 3] = 255;
        }
      }
    }
  }
  
  // Draw thick lines between vertices
  for (let i = 0; i < path.length; i++) {
    const p1 = path[i];
    const p2 = path[(i + 1) % path.length];
    
    const x1 = p1.x + offsetX;
    const y1 = p1.y + offsetY;
    const x2 = p2.x + offsetX;
    const y2 = p2.y + offsetY;
    
    // Draw thick line by filling rectangle along the line
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) continue;
    
    // Normal perpendicular to line
    const nx = -dy / len;
    const ny = dx / len;
    
    // Sample along the line length
    const steps = Math.ceil(len);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = x1 + dx * t;
      const cy = y1 + dy * t;
      
      // Fill a circle at this point
      const minX = Math.max(0, Math.floor(cx - radius));
      const maxX = Math.min(width - 1, Math.ceil(cx + radius));
      const minY = Math.max(0, Math.floor(cy - radius));
      const maxY = Math.min(height - 1, Math.ceil(cy + radius));
      
      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const ddx = px - cx;
          const ddy = py - cy;
          if (ddx * ddx + ddy * ddy <= radiusSq) {
            const idx = (py * width + px) * 4;
            output[idx] = r;
            output[idx + 1] = g;
            output[idx + 2] = b;
            output[idx + 3] = 255;
          }
        }
      }
    }
  }
}

// Offset path outward by a given amount (expands the path) using a miter-join approach for consistent offset at corners.
export function offsetPathOutward(path: Point[], offsetPixels: number): Point[] {
  if (path.length < 3 || offsetPixels <= 0) return path;
  
  const result: Point[] = [];
  const n = path.length;
  
  // Determine winding direction (positive area = CCW, negative = CW)
  let signedArea = 0;
  for (let i = 0; i < n; i++) {
    const curr = path[i];
    const next = path[(i + 1) % n];
    signedArea += (curr.x * next.y) - (next.x * curr.y);
  }
  signedArea /= 2;
  
  // For outward offset: CCW paths need positive direction, CW paths need negative
  const direction = signedArea >= 0 ? -1 : 1;
  
  for (let i = 0; i < n; i++) {
    const prev = path[(i - 1 + n) % n];
    const curr = path[i];
    const next = path[(i + 1) % n];
    
    // Edge vectors
    const e1x = curr.x - prev.x;
    const e1y = curr.y - prev.y;
    const e2x = next.x - curr.x;
    const e2y = next.y - curr.y;
    
    // Normalize
    const len1 = Math.sqrt(e1x * e1x + e1y * e1y) || 1;
    const len2 = Math.sqrt(e2x * e2x + e2y * e2y) || 1;
    
    // Perpendicular normals (pointing outward based on winding)
    const n1x = -e1y / len1 * direction;
    const n1y = e1x / len1 * direction;
    const n2x = -e2y / len2 * direction;
    const n2y = e2x / len2 * direction;
    
    // Average normal at corner
    let nx = (n1x + n2x) / 2;
    let ny = (n1y + n2y) / 2;
    const nlen = Math.sqrt(nx * nx + ny * ny) || 1;
    nx /= nlen;
    ny /= nlen;
    
    // Limit offset at sharp corners to avoid extreme spikes
    const dot = n1x * n2x + n1y * n2y;
    const miterLimit = Math.max(1, 1 / Math.sqrt((1 + dot) / 2 + 0.001));
    const limitedOffset = Math.min(offsetPixels * miterLimit, offsetPixels * 3);
    
    result.push({
      x: curr.x + nx * limitedOffset,
      y: curr.y + ny * limitedOffset
    });
  }
  
  return result;
}

// Fill contour directly using scanline algorithm - fills exactly to the path edge
export function fillContourDirect(
  output: Uint8ClampedArray,
  width: number,
  height: number,
  path: Point[],
  offsetX: number,
  offsetY: number,
  r: number,
  g: number,
  b: number
): void {
  if (path.length < 3) return;
  
  let minY = Infinity, maxY = -Infinity;
  for (const p of path) {
    const py = Math.round(p.y + offsetY);
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  
  minY = Math.max(0, minY);
  maxY = Math.min(height - 1, maxY);
  
  for (let y = minY; y <= maxY; y++) {
    const intersections: number[] = [];
    
    for (let i = 0; i < path.length; i++) {
      const p1 = path[i];
      const p2 = path[(i + 1) % path.length];
      
      const y1 = p1.y + offsetY;
      const y2 = p2.y + offsetY;
      
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        const x = p1.x + offsetX + (y - y1) / (y2 - y1) * (p2.x - p1.x);
        intersections.push(x);
      }
    }
    
    intersections.sort((a, b) => a - b);
    
    for (let i = 0; i < intersections.length - 1; i += 2) {
      const xStart = Math.max(0, Math.round(intersections[i]));
      const xEnd = Math.min(width - 1, Math.round(intersections[i + 1]));
      
      for (let x = xStart; x <= xEnd; x++) {
        const idx = (y * width + x) * 4;
        output[idx] = r;
        output[idx + 1] = g;
        output[idx + 2] = b;
        output[idx + 3] = 255;
      }
    }
  }
}

export function drawLine(
  output: Uint8ClampedArray,
  width: number,
  height: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  r: number,
  g: number,
  b: number
): void {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const sx = x1 < x2 ? 1 : -1;
  const sy = y1 < y2 ? 1 : -1;
  let err = dx - dy;
  
  let x = x1, y = y1;
  
  while (true) {
    if (x >= 0 && x < width && y >= 0 && y < height) {
      const idx = (y * width + x) * 4;
      output[idx] = r;
      output[idx + 1] = g;
      output[idx + 2] = b;
      output[idx + 3] = 255;
    }
    
    if (x === x2 && y === y2) break;
    
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

export function fillContour(
  output: Uint8ClampedArray,
  width: number,
  height: number,
  path: Point[],
  offsetX: number,
  offsetY: number,
  r: number,
  g: number,
  b: number
): void {
  let minY = Infinity, maxY = -Infinity;
  for (const p of path) {
    const py = Math.round(p.y + offsetY);
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  
  minY = Math.max(0, minY);
  maxY = Math.min(height - 1, maxY);
  
  for (let y = minY; y <= maxY; y++) {
    const intersections: number[] = [];
    
    for (let i = 0; i < path.length; i++) {
      const p1 = path[i];
      const p2 = path[(i + 1) % path.length];
      
      const y1 = p1.y + offsetY;
      const y2 = p2.y + offsetY;
      
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        const x = p1.x + offsetX + (y - y1) / (y2 - y1) * (p2.x - p1.x);
        intersections.push(x);
      }
    }
    
    intersections.sort((a, b) => a - b);
    
    for (let i = 0; i < intersections.length - 1; i += 2) {
      const xStart = Math.max(0, Math.round(intersections[i]));
      const xEnd = Math.min(width - 1, Math.round(intersections[i + 1]));
      
      for (let x = xStart; x <= xEnd; x++) {
        const idx = (y * width + x) * 4;
        output[idx] = r;
        output[idx + 1] = g;
        output[idx + 2] = b;
        output[idx + 3] = 255;
      }
    }
  }
}

// Extend edge colors outward via BFS propagation (O(W*H)) to fill the bleed area — intentionally fills internal holes too, since the original image (transparency preserved) is drawn on top in the final render.
export function createEdgeExtendedImage(
  imageData: ImageData,
  extendRadius: number
): ImageData {
  const { width, height, data } = imageData;
  const newWidth = width + extendRadius * 2;
  const newHeight = height + extendRadius * 2;
  const newData = new Uint8ClampedArray(newWidth * newHeight * 4);
  
  // Track which output pixels have been assigned colors
  const assigned = new Uint8Array(newWidth * newHeight);
  
  // BFS queue for propagation: [x, y, sourceR, sourceG, sourceB]
  const queue: Array<[number, number, number, number, number]> = [];
  
  // First pass: copy original opaque pixels and find edge pixels for BFS seeds
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      if (data[srcIdx + 3] > 128) {
        // Copy to output at offset position
        const outX = x + extendRadius;
        const outY = y + extendRadius;
        const outIdx = (outY * newWidth + outX) * 4;
        newData[outIdx] = data[srcIdx];
        newData[outIdx + 1] = data[srcIdx + 1];
        newData[outIdx + 2] = data[srcIdx + 2];
        newData[outIdx + 3] = data[srcIdx + 3];
        assigned[outY * newWidth + outX] = 1;
        
        // Check if this is an edge pixel (has transparent neighbor)
        let isEdge = false;
        for (let dy = -1; dy <= 1 && !isEdge; dy++) {
          for (let dx = -1; dx <= 1 && !isEdge; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
              isEdge = true;
            } else {
              const nidx = (ny * width + nx) * 4;
              if (data[nidx + 3] < 128) isEdge = true;
            }
          }
        }
        
        // Add edge pixels to BFS queue - they will propagate their color outward
        if (isEdge) {
          queue.push([outX, outY, data[srcIdx], data[srcIdx + 1], data[srcIdx + 2]]);
        }
      }
    }
  }
  
  // BFS propagation: spread edge colors outward
  const directions = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
  let queueIdx = 0;
  
  while (queueIdx < queue.length) {
    const [cx, cy, r, g, b] = queue[queueIdx++];
    
    for (const [dx, dy] of directions) {
      const nx = cx + dx;
      const ny = cy + dy;
      
      // Check bounds
      if (nx < 0 || nx >= newWidth || ny < 0 || ny >= newHeight) continue;
      
      // Skip if already assigned
      if (assigned[ny * newWidth + nx]) continue;
      
      // Mark as assigned and set color
      assigned[ny * newWidth + nx] = 1;
      const outIdx = (ny * newWidth + nx) * 4;
      newData[outIdx] = r;
      newData[outIdx + 1] = g;
      newData[outIdx + 2] = b;
      newData[outIdx + 3] = 255;
      
      // Add to queue for further propagation
      queue.push([nx, ny, r, g, b]);
    }
  }
  
  return new ImageData(newData, newWidth, newHeight);
}

/** Hi-res binary mask → original image resolution (any hi pixel set in block → 1). */
export function downsampleHiResBinaryMaskToOriginal(
  hi: Uint8Array,
  hiW: number,
  hiH: number,
  superSample: number,
  w: number,
  h: number
): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let sy = 0; sy < superSample && !v; sy++) {
        const hy = y * superSample + sy;
        if (hy >= hiH) continue;
        const row = hy * hiW;
        for (let sx = 0; sx < superSample; sx++) {
          const hx = x * superSample + sx;
          if (hx < hiW && hi[row + hx]) {
            v = 1;
            break;
          }
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

export function dilateBinaryMaskRect(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const R = Math.ceil(radius);
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let dy = -R; dy <= R && !v; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        const row = yy * w;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (mask[row + xx]) {
            v = 1;
            break;
          }
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

// Zero Hero preview: never trust canvas fills for the alpha wipe mask (smoothed vectors can self-intersect and nonzero winding deletes arbitrary diagonal wedges) — build it from the same filled silhouette raster used for tracing, plus dilation to cover preview bleed (~vector stroke+fill extent).
export function buildZeroHeroPreviewMaskFromFilledSilhouette(
  filledMainMask: Uint8Array,
  hiResWidth: number,
  hiResHeight: number,
  superSample: number,
  origWidth: number,
  origHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  offsetX: number,
  offsetY: number,
  bleedPixels: number
): Uint8Array {
  const inner = downsampleHiResBinaryMaskToOriginal(
    filledMainMask,
    hiResWidth,
    hiResHeight,
    superSample,
    origWidth,
    origHeight
  );
  const dilR = Math.max(1, Math.ceil(bleedPixels * 2));
  const dil = dilateBinaryMaskRect(inner, origWidth, origHeight, dilR);
  const mask = new Uint8Array(canvasWidth * canvasHeight);
  for (let y = 0; y < origHeight; y++) {
    for (let x = 0; x < origWidth; x++) {
      if (!dil[y * origWidth + x]) continue;
      const cx = Math.round(offsetX + x);
      const cy = Math.round(offsetY + y);
      if (cx >= 0 && cx < canvasWidth && cy >= 0 && cy < canvasHeight) {
        mask[cy * canvasWidth + cx] = 1;
      }
    }
  }
  return mask;
}

export function buildContourMask(
  width: number,
  height: number,
  paths: Point[][],
  offsetX: number,
  offsetY: number,
  bleedPixels: number
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const offscreen = new OffscreenCanvas(width, height);
  const ctx = offscreen.getContext('2d');
  if (!ctx) return mask;
  ctx.fillStyle = 'white';
  ctx.strokeStyle = 'white';
  ctx.lineWidth = bleedPixels * 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const path of paths) {
    if (path.length < 3) continue;
    ctx.beginPath();
    ctx.moveTo(path[0].x + offsetX, path[0].y + offsetY);
    for (let i = 1; i < path.length; i++) {
      ctx.lineTo(path[i].x + offsetX, path[i].y + offsetY);
    }
    ctx.closePath();
    ctx.stroke();
    // evenodd: safe if a contour is still self-intersecting (avoids nonzero "wedge" wipes)
    ctx.fill('evenodd');
  }
  const id = ctx.getImageData(0, 0, width, height);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = id.data[i * 4 + 3] > 0 ? 1 : 0;
  }
  return mask;
}

export function applyMaskToOutput(
  output: Uint8ClampedArray,
  width: number,
  height: number,
  mask: Uint8Array
): void {
  const len = width * height;
  for (let i = 0; i < len; i++) {
    if (mask[i] === 0) {
      const idx = i * 4;
      output[idx] = 0;
      output[idx + 1] = 0;
      output[idx + 2] = 0;
      output[idx + 3] = 0;
    }
  }
}

export function drawImageToData(
  output: Uint8ClampedArray,
  outputWidth: number,
  outputHeight: number,
  imageData: ImageData,
  offsetX: number,
  offsetY: number,
  contourMask?: Uint8Array
): void {
  const srcData = imageData.data;
  const srcWidth = imageData.width;
  const srcHeight = imageData.height;
  
  for (let y = 0; y < srcHeight; y++) {
    for (let x = 0; x < srcWidth; x++) {
      const srcIdx = (y * srcWidth + x) * 4;
      const alpha = srcData[srcIdx + 3];
      
      if (alpha > 0) {
        const destX = x + offsetX;
        const destY = y + offsetY;
        
        if (destX >= 0 && destX < outputWidth && destY >= 0 && destY < outputHeight) {
          if (contourMask && contourMask[destY * outputWidth + destX] === 0) continue;
          const destIdx = (destY * outputWidth + destX) * 4;
          
          if (alpha === 255) {
            output[destIdx] = srcData[srcIdx];
            output[destIdx + 1] = srcData[srcIdx + 1];
            output[destIdx + 2] = srcData[srcIdx + 2];
            output[destIdx + 3] = 255;
          } else {
            const srcAlpha = alpha / 255;
            const destAlpha = output[destIdx + 3] / 255;
            const outAlpha = srcAlpha + destAlpha * (1 - srcAlpha);
            
            if (outAlpha > 0) {
              output[destIdx] = (srcData[srcIdx] * srcAlpha + output[destIdx] * destAlpha * (1 - srcAlpha)) / outAlpha;
              output[destIdx + 1] = (srcData[srcIdx + 1] * srcAlpha + output[destIdx + 1] * destAlpha * (1 - srcAlpha)) / outAlpha;
              output[destIdx + 2] = (srcData[srcIdx + 2] * srcAlpha + output[destIdx + 2] * destAlpha * (1 - srcAlpha)) / outAlpha;
              output[destIdx + 3] = outAlpha * 255;
            }
          }
        }
      }
    }
  }
}

export function createOutputWithImage(
  imageData: ImageData,
  canvasWidth: number,
  canvasHeight: number,
  padding: number,
  effectiveDPI: number,
  backgroundColor: string
): ContourResult {
  const output = new Uint8ClampedArray(canvasWidth * canvasHeight * 4);
  drawImageToData(output, canvasWidth, canvasHeight, imageData, padding, padding);
  
  const widthInches = canvasWidth / effectiveDPI;
  const heightInches = canvasHeight / effectiveDPI;
  
  return {
    imageData: new ImageData(output, canvasWidth, canvasHeight),
    imageCanvasX: padding,
    imageCanvasY: padding,
    contourData: {
      pathPoints: [],
      previewPathPoints: [],
      widthInches,
      heightInches,
      imageOffsetX: padding / effectiveDPI,
      imageOffsetY: padding / effectiveDPI,
      backgroundColor,
      useEdgeBleed: false,
      effectiveDPI,
      minPathX: 0,
      minPathY: 0,
      bleedInches: 0
    },
    detectedAlgorithm: 'complex'
  };
}
