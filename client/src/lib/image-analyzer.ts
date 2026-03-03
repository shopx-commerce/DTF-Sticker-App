export interface ImageAnalysis {
  type: 'illustration' | 'photo' | 'photo_with_faces';
  hasAlpha: boolean;
  alphaPercent: number;
  colorComplexity: 'low' | 'medium' | 'high';
  uniqueColors: number;
  noiseLevel: 'clean' | 'noisy';
  flatRatio: number;
  edgeDensity: number;
  illustrationScore: number;
  resolution: { width: number; height: number };
  recommendedModel: 'anime' | 'general' | 'general_face';
  recommendedScale: 2 | 4;
  summary: string;
}

const MAX_ANALYSIS_DIM = 256;

function downsample(image: HTMLImageElement): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; data: ImageData } {
  const scale = Math.min(1, MAX_ANALYSIS_DIM / Math.max(image.width, image.height));
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(image, 0, 0, w, h);
  return { canvas, ctx, data: ctx.getImageData(0, 0, w, h) };
}

function analyzeAlpha(data: ImageData): { hasAlpha: boolean; alphaPercent: number } {
  const d = data.data;
  let transparentCount = 0;
  const totalPixels = data.width * data.height;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 250) transparentCount++;
  }
  const pct = (transparentCount / totalPixels) * 100;
  return { hasAlpha: pct > 0.5, alphaPercent: Math.round(pct * 10) / 10 };
}

function countUniqueColors(data: ImageData): number {
  const d = data.data;
  const seen = new Set<number>();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    // Quantize to 32-step buckets (>>5) for cleaner photo vs illustration separation
    const r = (d[i] >> 5) << 5;
    const g = (d[i + 1] >> 5) << 5;
    const b = (d[i + 2] >> 5) << 5;
    seen.add((r << 16) | (g << 8) | b);
  }
  return seen.size;
}

function estimateNoise(data: ImageData): number {
  // Laplacian variance method on luminance
  const { width, height } = data;
  const d = data.data;
  if (width < 3 || height < 3) return 0;

  let sum = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      if (d[idx + 3] < 128) continue;

      const lum = (c: number) => {
        const off = c * 4;
        return 0.299 * d[off] + 0.587 * d[off + 1] + 0.114 * d[off + 2];
      };
      const center = y * width + x;
      const laplacian =
        -4 * lum(center) +
        lum(center - 1) + lum(center + 1) +
        lum(center - width) + lum(center + width);
      sum += laplacian * laplacian;
      count++;
    }
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

function measureEdgeAndFlatness(data: ImageData): { edgeDensity: number; flatRatio: number } {
  const { width, height } = data;
  const d = data.data;
  if (width < 3 || height < 3) return { edgeDensity: 0, flatRatio: 1 };

  const lum = (x: number, y: number) => {
    const off = (y * width + x) * 4;
    return 0.299 * d[off] + 0.587 * d[off + 1] + 0.114 * d[off + 2];
  };

  let edgeCount = 0;
  let flatCount = 0;
  let total = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      if (d[idx + 3] < 128) continue;
      total++;

      const gx =
        -lum(x - 1, y - 1) + lum(x + 1, y - 1) +
        -2 * lum(x - 1, y) + 2 * lum(x + 1, y) +
        -lum(x - 1, y + 1) + lum(x + 1, y + 1);
      const gy =
        -lum(x - 1, y - 1) - 2 * lum(x, y - 1) - lum(x + 1, y - 1) +
        lum(x - 1, y + 1) + 2 * lum(x, y + 1) + lum(x + 1, y + 1);
      const mag = Math.sqrt(gx * gx + gy * gy);
      if (mag > 40) edgeCount++;
      if (mag < 5) flatCount++;
    }
  }
  return {
    edgeDensity: total > 0 ? edgeCount / total : 0,
    flatRatio: total > 0 ? flatCount / total : 1,
  };
}

export function analyzeImage(image: HTMLImageElement): ImageAnalysis {
  const { data } = downsample(image);
  const { hasAlpha, alphaPercent } = analyzeAlpha(data);
  const uniqueColors = countUniqueColors(data);
  const noiseVariance = estimateNoise(data);
  const { edgeDensity, flatRatio } = measureEdgeAndFlatness(data);

  const colorComplexity: ImageAnalysis['colorComplexity'] =
    uniqueColors < 150 ? 'low' : uniqueColors < 800 ? 'medium' : 'high';

  const noiseLevel: ImageAnalysis['noiseLevel'] = noiseVariance > 12 ? 'noisy' : 'clean';

  // Weighted multi-signal scoring — no single signal forces classification
  let illustrationScore = 0;

  // Flat region ratio is the strongest differentiator
  if (flatRatio > 0.50) illustrationScore += 3;
  else if (flatRatio > 0.35) illustrationScore += 1;

  // Unique color count (with coarser quantization)
  if (uniqueColors < 150) illustrationScore += 3;
  else if (uniqueColors < 500) illustrationScore += 1;

  // Edge density — sparse edges suggest illustration, dense edges suggest photo
  if (edgeDensity < 0.08) illustrationScore += 2;
  if (edgeDensity > 0.25) illustrationScore -= 2;

  // Sensor noise is a strong photo indicator
  if (noiseVariance > 12) illustrationScore -= 2;

  // Alpha is a mild bonus — many photo stickers also have alpha
  if (hasAlpha && alphaPercent > 20) illustrationScore += 1;

  const isIllustration = illustrationScore >= 3;
  const type: ImageAnalysis['type'] = isIllustration ? 'illustration' : 'photo';

  const longestSide = Math.max(image.width, image.height);
  const recommendedScale: 2 | 4 = longestSide >= 2000 ? 2 : 4;
  const recommendedModel: ImageAnalysis['recommendedModel'] = isIllustration ? 'anime' : 'general';

  const typeLabel = isIllustration ? 'Illustration' : 'Photo';
  const scaleLabel = `${recommendedScale}x`;
  const summary = `${typeLabel} • ${uniqueColors} colors • flat:${(flatRatio * 100).toFixed(0)}% • edge:${(edgeDensity * 100).toFixed(0)}% • score:${illustrationScore} • ${image.width}×${image.height} → ${scaleLabel}`;

  console.log(`[ImageAnalyzer] flat=${flatRatio.toFixed(3)} edge=${edgeDensity.toFixed(3)} colors=${uniqueColors} noise=${noiseVariance.toFixed(1)} alpha=${alphaPercent}% → score=${illustrationScore} → ${typeLabel}`);

  return {
    type,
    hasAlpha,
    alphaPercent,
    colorComplexity,
    uniqueColors,
    noiseLevel,
    flatRatio,
    edgeDensity,
    illustrationScore,
    resolution: { width: image.width, height: image.height },
    recommendedModel,
    recommendedScale,
    summary,
  };
}
