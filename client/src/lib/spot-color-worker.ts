interface Point {
  x: number;
  y: number;
}

interface SpotColorInputWorker {
  hex: string;
  rgb: { r: number; g: number; b: number };
  spotWhite?: boolean;
  spotGloss?: boolean;
  spotWhiteName?: string;
  spotGlossName?: string;
  spotFluorY?: boolean;
  spotFluorM?: boolean;
  spotFluorG?: boolean;
  spotFluorOrange?: boolean;
  spotFluorYName?: string;
  spotFluorMName?: string;
  spotFluorGName?: string;
  spotFluorOrangeName?: string;
}

interface SpotColorRegionWorker {
  name: string;
  paths: Point[][];
  tintCMYK: [number, number, number, number];
}

interface WorkerMessage {
  type: 'trace';
  imageBuffer: ArrayBuffer;
  imageWidth: number;
  imageHeight: number;
  spotColors: SpotColorInputWorker[];
  widthInches: number;
  heightInches: number;
  dpi: number;
  whiteInclusionMask?: ArrayBuffer;
  glossInclusionMask?: ArrayBuffer;
}

interface WorkerResponse {
  type: 'result' | 'error';
  regions?: SpotColorRegionWorker[];
  error?: string;
}

function createClosestColorMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  markedColors: SpotColorInputWorker[],
  allSpotColors: SpotColorInputWorker[],
  colorTolerance: number,
  alphaThreshold: number
): Uint8Array {
  const mask = new Uint8Array(width * height);

  const markedHexSet = new Set(markedColors.map(mc => mc.hex));
  const markedRGBs = markedColors.map(mc => mc.rgb);
  const allColorsIndexed = allSpotColors.map(c => ({
    rgb: c.rgb,
    hex: c.hex
  }));

  const directTolerance = 80;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3];

      if (a < alphaThreshold) continue;

      let closestHex = '';
      let closestDistance = Infinity;

      for (const sc of allColorsIndexed) {
        const dr = r - sc.rgb.r;
        const dg = g - sc.rgb.g;
        const db = b - sc.rgb.b;
        const distance = Math.sqrt(dr * dr + dg * dg + db * db);

        if (distance < closestDistance) {
          closestDistance = distance;
          closestHex = sc.hex;
        }
      }

      if (closestDistance < colorTolerance && markedHexSet.has(closestHex)) {
        let withinDirect = false;
        for (const mrgb of markedRGBs) {
          const dr = r - mrgb.r;
          const dg = g - mrgb.g;
          const db = b - mrgb.b;
          if (Math.sqrt(dr * dr + dg * dg + db * db) < directTolerance) {
            withinDirect = true;
            break;
          }
        }
        if (withinDirect) {
          mask[y * width + x] = 1;
        }
      }
    }
  }

  return mask;
}

/**
 * Morphological dilation with a square structuring element of the given radius.
 * Each output pixel is 1 if any pixel within the radius (Chebyshev distance) is 1.
 * Implemented as two passes (horizontal then vertical) for O(w*h*radius) cost
 * instead of O(w*h*radius²).
 */
function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const tmp = new Uint8Array(width * height);
  // Horizontal pass
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let v = 0;
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      for (let i = x0; i <= x1; i++) {
        if (mask[row + i]) { v = 1; break; }
      }
      tmp[row + x] = v;
    }
  }
  // Vertical pass
  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let v = 0;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height - 1, y + radius);
      for (let j = y0; j <= y1; j++) {
        if (tmp[j * width + x]) { v = 1; break; }
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

/**
 * Morphological erosion (inverse of dilate).
 */
function erode(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const tmp = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let v = 1;
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      for (let i = x0; i <= x1; i++) {
        if (!mask[row + i]) { v = 0; break; }
      }
      tmp[row + x] = v;
    }
  }
  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let v = 1;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height - 1, y + radius);
      for (let j = y0; j <= y1; j++) {
        if (!tmp[j * width + x]) { v = 0; break; }
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

/**
 * Morphological closing: dilate then erode. Bridges sub-pixel gaps caused
 * by anti-aliased boundary pixels failing the closest-color match, so a
 * full "all white" or "all gloss" tag produces one solid coverage region
 * instead of one with random pinhole gaps. Net shape change is ~0; only
 * holes ≤ 2*radius wide get filled.
 */
function morphologicalClose(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  return erode(dilate(mask, width, height, radius), width, height, radius);
}

/**
 * Builds a binary mask of every visible pixel in the input image (alpha >=
 * threshold). Used for the "all colors tagged" case where the user wants
 * the spot separation to cover the entire design silhouette, with no
 * color-boundary gaps possible. Sidesteps closest-color matching entirely.
 */
function buildAlphaSilhouetteMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold: number
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    if (data[p + 3] >= alphaThreshold) mask[i] = 1;
  }
  return mask;
}

function marchingSquaresTrace(mask: Uint8Array, width: number, height: number): Point[][] {
  function getMask(x: number, y: number): number {
    if (x < 0 || x >= width || y < 0 || y >= height) return 0;
    return mask[y * width + x];
  }

  interface Edge {
    fromX: number; fromY: number;
    toX: number; toY: number;
    dx: number; dy: number;
  }

  const edges: Edge[] = [];

  for (let y = 0; y <= height; y++) {
    for (let x = 0; x < width; x++) {
      const above = getMask(x, y - 1);
      const below = getMask(x, y);
      if (above !== below) {
        if (above === 1) {
          edges.push({ fromX: x + 1, fromY: y, toX: x, toY: y, dx: -1, dy: 0 });
        } else {
          edges.push({ fromX: x, fromY: y, toX: x + 1, toY: y, dx: 1, dy: 0 });
        }
      }
    }
  }

  for (let x = 0; x <= width; x++) {
    for (let y = 0; y < height; y++) {
      const left = getMask(x - 1, y);
      const right = getMask(x, y);
      if (left !== right) {
        if (left === 1) {
          edges.push({ fromX: x, fromY: y, toX: x, toY: y + 1, dx: 0, dy: 1 });
        } else {
          edges.push({ fromX: x, fromY: y + 1, toX: x, toY: y, dx: 0, dy: -1 });
        }
      }
    }
  }

  if (edges.length === 0) return [];

  const fromMap = new Map<string, number[]>();
  for (let i = 0; i < edges.length; i++) {
    const key = `${edges[i].fromX},${edges[i].fromY}`;
    if (!fromMap.has(key)) fromMap.set(key, []);
    fromMap.get(key)!.push(i);
  }

  const rightTurnPriority: Record<string, [number, number][]> = {
    '1,0': [[0, 1], [1, 0], [0, -1], [-1, 0]],
    '0,1': [[-1, 0], [0, 1], [1, 0], [0, -1]],
    '-1,0': [[0, -1], [-1, 0], [0, 1], [1, 0]],
    '0,-1': [[1, 0], [0, -1], [-1, 0], [0, 1]],
  };

  const used = new Uint8Array(edges.length);
  const contours: Point[][] = [];

  for (let startIdx = 0; startIdx < edges.length; startIdx++) {
    if (used[startIdx]) continue;

    const contour: Point[] = [];
    let edgeIdx = startIdx;
    const maxSteps = edges.length;
    let steps = 0;

    while (!used[edgeIdx] && steps < maxSteps) {
      used[edgeIdx] = 1;
      const edge = edges[edgeIdx];
      contour.push({ x: edge.fromX, y: edge.fromY });

      const nextKey = `${edge.toX},${edge.toY}`;
      const candidates = fromMap.get(nextKey);
      if (!candidates) break;

      const priority = rightTurnPriority[`${edge.dx},${edge.dy}`];
      let nextIdx = -1;

      if (priority) {
        for (const [pdx, pdy] of priority) {
          for (const ci of candidates) {
            if (!used[ci] && edges[ci].dx === pdx && edges[ci].dy === pdy) {
              nextIdx = ci;
              break;
            }
          }
          if (nextIdx !== -1) break;
        }
      } else {
        for (const ci of candidates) {
          if (!used[ci]) { nextIdx = ci; break; }
        }
      }

      if (nextIdx === -1) break;
      edgeIdx = nextIdx;
      steps++;
    }

    if (contour.length > 2) {
      contours.push(contour);
    }
  }

  return contours;
}

function collapseCollinear(contour: Point[]): Point[] {
  if (contour.length < 3) return contour;

  const result: Point[] = [];

  for (let i = 0; i < contour.length; i++) {
    const prev = contour[(i - 1 + contour.length) % contour.length];
    const curr = contour[i];
    const next = contour[(i + 1) % contour.length];

    const dx1 = curr.x - prev.x;
    const dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x;
    const dy2 = next.y - curr.y;

    const sameDirX = (dx1 > 0 && dx2 > 0) || (dx1 < 0 && dx2 < 0) || (dx1 === 0 && dx2 === 0);
    const sameDirY = (dy1 > 0 && dy2 > 0) || (dy1 < 0 && dy2 < 0) || (dy1 === 0 && dy2 === 0);

    if (!(sameDirX && sameDirY)) {
      result.push(curr);
    }
  }

  return result.length >= 3 ? result : contour;
}

function traceMaskToInchPaths(mask: Uint8Array, width: number, height: number, pixelsPerInch: number): Point[][] {
  const rawPaths = marchingSquaresTrace(mask, width, height);
  return rawPaths.map(rawPath => {
    const collapsed = collapseCollinear(rawPath);
    return collapsed.map(p => ({
      x: p.x / pixelsPerInch,
      y: p.y / pixelsPerInch
    }));
  }).filter(p => p.length >= 3);
}

function processSpotColors(
  pixelData: Uint8ClampedArray,
  width: number,
  height: number,
  spotColors: SpotColorInputWorker[],
  dpi: number,
  whiteInclusionMask?: Uint8Array,
  glossInclusionMask?: Uint8Array
): SpotColorRegionWorker[] {
  const whiteColors = spotColors.filter(c => c.spotWhite);
  const glossColors = spotColors.filter(c => c.spotGloss);
  const whiteName = spotColors.find(c => c.spotWhite)?.spotWhiteName || 'RDG_WHITE';
  const glossName = spotColors.find(c => c.spotGloss)?.spotGlossName || 'RDG_GLOSS';

  const regions: SpotColorRegionWorker[] = [];

  // Morphological closing radius in pixels. At 300 DPI, ~4 pixels ≈ 0.013"
  // (~0.34mm) — still invisible at print scale but enough to bridge wider
  // anti-alias / color-extraction gaps between adjacent colors. Small
  // intentional features (e.g. the gap inside a thin O) are preserved
  // because closing only fills holes ≤ 2*radius wide.
  const closingRadius = Math.max(2, Math.round(dpi / 75));

  // "All tagged" shortcut: if EVERY extracted spot color carries this
  // separation's flag, the user is asking for full design coverage. Skip
  // the per-color closest-color matching (which inevitably has anti-alias
  // misses at color boundaries) and just use the alpha silhouette of the
  // input image. Guarantees one solid region with zero pinholes.
  const allTaggedWhite = spotColors.length > 0 && spotColors.every(c => c.spotWhite);
  const allTaggedGloss = spotColors.length > 0 && spotColors.every(c => c.spotGloss);

  if (whiteColors.length > 0) {
    let mask = allTaggedWhite
      ? buildAlphaSilhouetteMask(pixelData, width, height, 1)
      : createClosestColorMask(pixelData, width, height, whiteColors, spotColors, 60, 240);
    if (whiteInclusionMask) {
      for (let i = 0; i < mask.length; i++) {
        if (!whiteInclusionMask[i]) mask[i] = 0;
      }
    }
    // Skip closing for the alpha silhouette path — it's already gap-free.
    const closed = allTaggedWhite ? mask : morphologicalClose(mask, width, height, closingRadius);
    const paths = traceMaskToInchPaths(closed, width, height, dpi);
    if (paths.length > 0) {
      regions.push({ name: whiteName, paths, tintCMYK: [0, 1, 0, 0] });
    }
  }

  if (glossColors.length > 0) {
    let mask = allTaggedGloss
      ? buildAlphaSilhouetteMask(pixelData, width, height, 1)
      : createClosestColorMask(pixelData, width, height, glossColors, spotColors, 60, 240);
    if (glossInclusionMask) {
      for (let i = 0; i < mask.length; i++) {
        if (!glossInclusionMask[i]) mask[i] = 0;
      }
    }
    const closed = allTaggedGloss ? mask : morphologicalClose(mask, width, height, closingRadius);
    const paths = traceMaskToInchPaths(closed, width, height, dpi);
    if (paths.length > 0) {
      regions.push({ name: glossName, paths, tintCMYK: [0, 1, 0, 0] });
    }
  }

  const fluorTypes = [
    { field: 'spotFluorY' as const, nameField: 'spotFluorYName' as const, defaultName: 'Fluorescent_Y' },
    { field: 'spotFluorM' as const, nameField: 'spotFluorMName' as const, defaultName: 'Fluorescent_M' },
    { field: 'spotFluorG' as const, nameField: 'spotFluorGName' as const, defaultName: 'Fluorescent_G' },
    { field: 'spotFluorOrange' as const, nameField: 'spotFluorOrangeName' as const, defaultName: 'Fluorescent_Orange' },
  ];

  for (const ft of fluorTypes) {
    const matchingColors = spotColors.filter(c => c[ft.field]);
    if (matchingColors.length > 0) {
      const fluorName = matchingColors[0][ft.nameField] || ft.defaultName;
      const mask = createClosestColorMask(pixelData, width, height, matchingColors, spotColors, 60, 240);
      const closed = morphologicalClose(mask, width, height, closingRadius);
      const paths = traceMaskToInchPaths(closed, width, height, dpi);
      if (paths.length > 0) {
        regions.push({ name: fluorName, paths, tintCMYK: [0, 1, 0, 0] });
      }
    }
  }

  return regions;
}

self.onmessage = function(e: MessageEvent<WorkerMessage>) {
  try {
    if (e.data.type === 'trace') {
      const { imageBuffer, imageWidth, imageHeight, spotColors, dpi, whiteInclusionMask, glossInclusionMask } = e.data;
      const pixelData = new Uint8ClampedArray(imageBuffer);
      const whiteMask = whiteInclusionMask ? new Uint8Array(whiteInclusionMask) : undefined;
      const glossMask = glossInclusionMask ? new Uint8Array(glossInclusionMask) : undefined;
      const regions = processSpotColors(pixelData, imageWidth, imageHeight, spotColors, dpi, whiteMask, glossMask);
      const response: WorkerResponse = { type: 'result', regions };
      self.postMessage(response);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: 'error', error: msg } as WorkerResponse);
  }
};
