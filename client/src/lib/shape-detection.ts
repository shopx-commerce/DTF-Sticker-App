export type DetectedShape = 'circle' | 'oval' | 'square' | 'rectangle' | 'irregular';

export interface ShapeDetectionResult {
  shape: DetectedShape;
  confidence: number;
  aspectRatio: number;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export function detectShape(image: HTMLImageElement, alphaThreshold: number = 128): ShapeDetectionResult {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { shape: 'irregular', confidence: 0, aspectRatio: 1, boundingBox: { x: 0, y: 0, width: 0, height: 0 } };
  }

  canvas.width = image.width;
  canvas.height = image.height;
  ctx.drawImage(image, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = imageData;

  // ── Auto-classification stage 1: reject anything with visible concavities.
  // The old classifier only checked "do edge pixels sit near the bounding
  // ellipse / rectangle" + bbox aspect ratio. That mis-classifies any logo
  // whose overall silhouette is roughly disc-shaped: fire badges, gears, suns,
  // mandalas, snowflakes, etc. The bbox is square and most of the perimeter
  // lies on the round body, so the edge-match score crosses the 85%
  // threshold even though the design has obvious protrusions.
  //
  // Convexity-defect check: walk the bounding-box border pixels and count
  // how far INSIDE the bbox the silhouette is at each border position. A
  // perfect circle/oval has all border pixels ~tangent to the bbox (low
  // depth). A fire badge has deep "valleys" between the axes/ladders. Any
  // appreciable depth → not a clean primitive → return irregular.
  let _bboxMinX = width, _bboxMaxX = 0, _bboxMinY = height, _bboxMaxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] >= alphaThreshold) {
        if (x < _bboxMinX) _bboxMinX = x;
        if (x > _bboxMaxX) _bboxMaxX = x;
        if (y < _bboxMinY) _bboxMinY = y;
        if (y > _bboxMaxY) _bboxMaxY = y;
      }
    }
  }
  if (_bboxMaxX > _bboxMinX && _bboxMaxY > _bboxMinY) {
    const _bw = _bboxMaxX - _bboxMinX + 1;
    const _bh = _bboxMaxY - _bboxMinY + 1;
    const sample = Math.max(20, Math.min(64, Math.round(Math.min(_bw, _bh) / 8)));
    let maxDepthFrac = 0;
    // For each of the 4 bbox edges, scan inward from the edge until we hit
    // an opaque pixel. Depth = how many pixels we travelled. A clean
    // circle/oval has depth ≈ 0 on horizontal/vertical extremes only and
    // moderate depth at corners. We track the MAXIMUM normalized depth.
    const checkDepth = (depth: number, span: number) => {
      const frac = depth / span;
      if (frac > maxDepthFrac) maxDepthFrac = frac;
    };
    // Top edge: scan downward
    for (let i = 0; i <= sample; i++) {
      const x = _bboxMinX + Math.round((i / sample) * (_bw - 1));
      let d = 0;
      for (let y = _bboxMinY; y <= _bboxMaxY; y++) {
        if (data[(y * width + x) * 4 + 3] >= alphaThreshold) break;
        d++;
      }
      checkDepth(d, _bh);
    }
    // Bottom edge: scan upward
    for (let i = 0; i <= sample; i++) {
      const x = _bboxMinX + Math.round((i / sample) * (_bw - 1));
      let d = 0;
      for (let y = _bboxMaxY; y >= _bboxMinY; y--) {
        if (data[(y * width + x) * 4 + 3] >= alphaThreshold) break;
        d++;
      }
      checkDepth(d, _bh);
    }
    // Left edge: scan rightward
    for (let i = 0; i <= sample; i++) {
      const y = _bboxMinY + Math.round((i / sample) * (_bh - 1));
      let d = 0;
      for (let x = _bboxMinX; x <= _bboxMaxX; x++) {
        if (data[(y * width + x) * 4 + 3] >= alphaThreshold) break;
        d++;
      }
      checkDepth(d, _bw);
    }
    // Right edge: scan leftward
    for (let i = 0; i <= sample; i++) {
      const y = _bboxMinY + Math.round((i / sample) * (_bh - 1));
      let d = 0;
      for (let x = _bboxMaxX; x >= _bboxMinX; x--) {
        if (data[(y * width + x) * 4 + 3] >= alphaThreshold) break;
        d++;
      }
      checkDepth(d, _bw);
    }
    // A perfect ellipse touching all four bbox edges has max-depth ≈ 0
    // on the cardinal axes and progressively higher near corners.
    // For a CIRCLE inscribed in a square, the corner-most edge sample
    // sits at depth = (1 - 1/sqrt(2)) ≈ 0.293 of the bbox dimension
    // due to corner geometry. We allow up to 0.30 for ellipses, which
    // preserves real circles/ovals but rejects anything with deeper
    // valleys (fire badge axes, gear teeth, sun rays, etc).
    const CONVEXITY_DEPTH_LIMIT = 0.30;
    if (maxDepthFrac > CONVEXITY_DEPTH_LIMIT) {
      const aspectRatio = _bw / _bh;
      console.log(
        `[ShapeDetect] rejected as 'irregular' — max edge-depth ${(maxDepthFrac * 100).toFixed(1)}% ` +
        `exceeds ${CONVEXITY_DEPTH_LIMIT * 100}% (convexity defects detected). ` +
        `bbox ${_bw}×${_bh} aspect ${aspectRatio.toFixed(2)}.`
      );
      return {
        shape: 'irregular',
        confidence: 0,
        aspectRatio,
        boundingBox: { x: _bboxMinX, y: _bboxMinY, width: _bw, height: _bh },
      };
    }
  }

  let minX = width, maxX = 0, minY = height, maxY = 0;
  let opaqueCount = 0;
  const edgePixels: { x: number; y: number }[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha >= alphaThreshold) {
        opaqueCount++;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        
        if (isEdgePixel(data, width, height, x, y, alphaThreshold)) {
          edgePixels.push({ x, y });
        }
      }
    }
  }

  if (opaqueCount === 0 || edgePixels.length < 20) {
    return { shape: 'irregular', confidence: 0, aspectRatio: 1, boundingBox: { x: 0, y: 0, width: 0, height: 0 } };
  }

  const boundingBox = {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };

  const aspectRatio = boundingBox.width / boundingBox.height;
  const boundingBoxArea = boundingBox.width * boundingBox.height;
  const fillRatio = opaqueCount / boundingBoxArea;

  const centerX = minX + boundingBox.width / 2;
  const centerY = minY + boundingBox.height / 2;
  const radiusX = boundingBox.width / 2;
  const radiusY = boundingBox.height / 2;

  const isSquareAspect = aspectRatio >= 0.92 && aspectRatio <= 1.08;

  let ellipseMatchCount = 0;
  let rectMatchCount = 0;
  let totalEdgeDeviation = 0;
  let rectEdgeDeviation = 0;

  for (const pixel of edgePixels) {
    const nx = (pixel.x - centerX) / radiusX;
    const ny = (pixel.y - centerY) / radiusY;
    const ellipseDist = Math.abs(Math.sqrt(nx * nx + ny * ny) - 1);
    
    if (ellipseDist < 0.08) {
      ellipseMatchCount++;
    }
    totalEdgeDeviation += ellipseDist;

    const distToLeft = Math.abs(pixel.x - minX);
    const distToRight = Math.abs(pixel.x - maxX);
    const distToTop = Math.abs(pixel.y - minY);
    const distToBottom = Math.abs(pixel.y - maxY);
    const minDistToEdge = Math.min(distToLeft, distToRight, distToTop, distToBottom);
    
    if (minDistToEdge <= 2) {
      rectMatchCount++;
    }
    rectEdgeDeviation += minDistToEdge;
  }

  const ellipseEdgeMatch = ellipseMatchCount / edgePixels.length;
  const rectEdgeMatch = rectMatchCount / edgePixels.length;
  const avgEllipseDeviation = totalEdgeDeviation / edgePixels.length;
  const avgRectDeviation = rectEdgeDeviation / edgePixels.length;

  const expectedEllipseFill = Math.PI / 4;
  const ellipseFillDiff = Math.abs(fillRatio - expectedEllipseFill);
  const rectFillDiff = Math.abs(fillRatio - 1.0);

  const ellipseFillMatch = ellipseFillDiff < 0.08;
  const rectFillMatch = rectFillDiff < 0.05;

  const ellipseScore = ellipseEdgeMatch >= 0.85 && ellipseFillMatch && avgEllipseDeviation < 0.12
    ? ellipseEdgeMatch * 0.7 + (1 - ellipseFillDiff / expectedEllipseFill) * 0.3
    : 0;

  const rectScore = rectEdgeMatch >= 0.90 && rectFillMatch && avgRectDeviation < 3
    ? rectEdgeMatch * 0.7 + fillRatio * 0.3
    : 0;

  const confidenceThreshold = 0.88;

  if (ellipseScore >= confidenceThreshold && ellipseScore > rectScore) {
    if (isSquareAspect) {
      return { shape: 'circle', confidence: ellipseScore, aspectRatio, boundingBox };
    } else {
      return { shape: 'oval', confidence: ellipseScore, aspectRatio, boundingBox };
    }
  }

  if (rectScore >= confidenceThreshold) {
    if (isSquareAspect) {
      return { shape: 'square', confidence: rectScore, aspectRatio, boundingBox };
    } else {
      return { shape: 'rectangle', confidence: rectScore, aspectRatio, boundingBox };
    }
  }

  return { shape: 'irregular', confidence: Math.max(ellipseScore, rectScore), aspectRatio, boundingBox };
}

function isEdgePixel(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  alphaThreshold: number
): boolean {
  const currentAlpha = data[(y * width + x) * 4 + 3];
  if (currentAlpha < alphaThreshold) return false;

  const neighbors = [
    [-1, 0], [1, 0], [0, -1], [0, 1]
  ];

  for (const [dx, dy] of neighbors) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
      return true;
    }
    const neighborAlpha = data[(ny * width + nx) * 4 + 3];
    if (neighborAlpha < alphaThreshold) {
      return true;
    }
  }

  return false;
}

export function mapDetectedShapeToType(shape: DetectedShape): 'square' | 'rectangle' | 'circle' | 'oval' | null {
  switch (shape) {
    case 'circle':
      return 'circle';
    case 'oval':
      return 'oval';
    case 'square':
      return 'square';
    case 'rectangle':
      return 'rectangle';
    default:
      return null;
  }
}
