import ClipperLib from 'js-clipper';
import { CLIPPER_SCALE, calculateClipperTolerances } from './clipper-constants';

interface Point {
  x: number;
  y: number;
}

// Both smoothing functions below index circularly by modulo — drop malformed entries first so a bad point can't crash the render.
function cleanPoints(points: Point[]): Point[] {
  return points.filter(p => p && typeof p.x === 'number' && typeof p.y === 'number' && !isNaN(p.x) && !isNaN(p.y));
}

// Moving average smoothing to reduce jagged edges from alpha tracing
export function smoothContourPoints(rawPoints: Point[], windowSize: number = 5): Point[] {
  const points = cleanPoints(rawPoints);
  if (points.length < windowSize * 2) return points;
  
  const halfWindow = Math.floor(windowSize / 2);
  const smoothed: Point[] = [];
  
  for (let i = 0; i < points.length; i++) {
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    
    // Double-modulo: JS's % keeps the sign of its left operand, so a small point count can still go negative.
    for (let j = -halfWindow; j <= halfWindow; j++) {
      const idx = ((i + j) % points.length + points.length) % points.length;
      sumX += points[idx].x;
      sumY += points[idx].y;
      count++;
    }
    
    smoothed.push({
      x: sumX / count,
      y: sumY / count
    });
  }
  
  return smoothed;
}

// Gaussian-weighted smoothing for even smoother curves
export function gaussianSmoothContour(rawPoints: Point[], sigma: number = 2): Point[] {
  const points = cleanPoints(rawPoints);
  if (points.length < 5) return points;
  
  // Calculate kernel size based on sigma (3-sigma rule)
  const kernelRadius = Math.ceil(sigma * 3);
  const kernelSize = kernelRadius * 2 + 1;
  
  // Generate Gaussian kernel
  const kernel: number[] = [];
  let kernelSum = 0;
  for (let i = -kernelRadius; i <= kernelRadius; i++) {
    const weight = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(weight);
    kernelSum += weight;
  }
  // Normalize kernel
  for (let i = 0; i < kernel.length; i++) {
    kernel[i] /= kernelSum;
  }
  
  const smoothed: Point[] = [];
  
  for (let i = 0; i < points.length; i++) {
    let sumX = 0;
    let sumY = 0;
    
    for (let k = 0; k < kernelSize; k++) {
      const offset = k - kernelRadius;
      // Same double-modulo as smoothContourPoints above — the kernel radius can exceed a short path's point count.
      const idx = ((i + offset) % points.length + points.length) % points.length;
      sumX += points[idx].x * kernel[k];
      sumY += points[idx].y * kernel[k];
    }
    
    smoothed.push({ x: sumX, y: sumY });
  }
  
  return smoothed;
}

function pointsToClipperPath(points: Point[]): ClipperLib.Path {
  return points.map(p => ({
    X: Math.round(p.x * CLIPPER_SCALE),
    Y: Math.round(p.y * CLIPPER_SCALE)
  }));
}

function clipperPathToPoints(path: ClipperLib.Path): Point[] {
  return path.map((p: { X: number; Y: number }) => ({
    x: p.X / CLIPPER_SCALE,
    y: p.Y / CLIPPER_SCALE
  }));
}

export function cleanPathWithClipper(points: Point[], offsetWidth: number = 0, dpi: number = 300): Point[] {
  if (points.length < 3) return points;
  
  console.log('[cleanPathWithClipper] Input points:', points.length);
  
  const clipperPath = pointsToClipperPath(points);
  
  // Use SimplifyPolygon which specifically removes self-intersections
  const simplified = ClipperLib.Clipper.SimplifyPolygon(clipperPath, ClipperLib.PolyFillType.pftNonZero);
  
  console.log('[cleanPathWithClipper] SimplifyPolygon returned', simplified?.length || 0, 'polygons');
  
  if (!simplified || simplified.length === 0) {
    console.log('[cleanPathWithClipper] SimplifyPolygon failed, returning original');
    return points;
  }
  
  // Find the largest polygon by area (main outline, not tiny loop fragments)
  let largestArea = 0;
  let largestPath = simplified[0];
  
  for (const path of simplified) {
    const area = Math.abs(ClipperLib.Clipper.Area(path));
    if (area > largestArea) {
      largestArea = area;
      largestPath = path;
    }
  }
  
  console.log('[cleanPathWithClipper] Largest polygon has', largestPath.length, 'points, area:', largestArea);
  
  // Use shared tolerance calculation based on DPI and offset
  const tolerances = calculateClipperTolerances(dpi, offsetWidth);
  
  // Also clean up any micro-vertices that are very close together
  const cleaned = ClipperLib.Clipper.CleanPolygon(largestPath, tolerances.simplifyTolerance * CLIPPER_SCALE);
  
  if (!cleaned || cleaned.length < 3) {
    console.log('[cleanPathWithClipper] CleanPolygon failed, returning largest');
    return clipperPathToPoints(largestPath);
  }
  
  console.log('[cleanPathWithClipper] Final cleaned points:', cleaned.length);
  return clipperPathToPoints(cleaned);
}

export function offsetPathWithClipper(points: Point[], offsetAmount: number, dpi: number = 300): Point[] {
  if (points.length < 3) return points;
  
  const clipperPath = pointsToClipperPath(points);
  
  // Calculate tolerances based on DPI and offset size
  const tolerances = calculateClipperTolerances(dpi, offsetAmount);
  
  const co = new ClipperLib.ClipperOffset();
  co.ArcTolerance = tolerances.arcTolerance;
  co.MiterLimit = tolerances.miterLimit;
  
  co.AddPath(clipperPath, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  
  const solution: ClipperLib.Path[] = [];
  co.Execute(solution, offsetAmount * CLIPPER_SCALE);
  
  if (solution.length === 0) return points;
  
  let largestArea = 0;
  let largestPath = solution[0];
  
  for (const path of solution) {
    const area = Math.abs(ClipperLib.Clipper.Area(path));
    if (area > largestArea) {
      largestArea = area;
      largestPath = path;
    }
  }
  
  return clipperPathToPoints(largestPath);
}

export function simplifyPathWithClipper(points: Point[], tolerance: number, offsetWidth: number = 0, dpi: number = 300): Point[] {
  if (points.length < 3) return points;
  
  const clipperPath = pointsToClipperPath(points);
  
  // Use shared tolerance calculation, then apply the user-specified tolerance as a multiplier
  const tolerances = calculateClipperTolerances(dpi, offsetWidth);
  const effectiveTolerance = Math.max(tolerance, tolerances.simplifyTolerance);
  
  // CleanPolygon removes vertices closer than tolerance distance
  const simplified = ClipperLib.Clipper.CleanPolygon(clipperPath, effectiveTolerance * CLIPPER_SCALE);
  
  if (!simplified || simplified.length < 3) return points;
  
  // Also run SimplifyPolygon to ensure no self-intersections after cleaning
  const noIntersections = ClipperLib.Clipper.SimplifyPolygon(simplified, ClipperLib.PolyFillType.pftNonZero);
  
  if (!noIntersections || noIntersections.length === 0) {
    return clipperPathToPoints(simplified);
  }
  
  // Return the largest polygon
  let largest = noIntersections[0];
  let largestArea = Math.abs(ClipperLib.Clipper.Area(largest));
  
  for (let i = 1; i < noIntersections.length; i++) {
    const area = Math.abs(ClipperLib.Clipper.Area(noIntersections[i]));
    if (area > largestArea) {
      largestArea = area;
      largest = noIntersections[i];
    }
  }
  
  return clipperPathToPoints(largest);
}

/**
 * Welds narrow 'caves' or 'necks' in a contour using Minkowski Closing.
 * Expands the polygon by gapWidthPixels, then shrinks by the same amount.
 * This causes narrow indentations (too tight for cutting blades) to collide and seal shut.
 * 
 * @param points - Input contour points
 * @param gapWidthPixels - Width of gaps to close (default 1.5 pixels)
 * @returns Contour with narrow gaps welded shut
 */
export function weldNarrowGaps(points: Point[], gapWidthPixels: number = 1.5): Point[] {
  if (points.length < 3 || gapWidthPixels <= 0) return points;
  
  // Convert to Clipper format
  const clipperPath = points.map(p => ({
    X: Math.round(p.x * CLIPPER_SCALE),
    Y: Math.round(p.y * CLIPPER_SCALE)
  }));
  
  // Scale the gap width for Clipper's integer coordinates
  const scaledGapWidth = gapWidthPixels * CLIPPER_SCALE;
  
  // Step 1: Expand (positive offset) - this will cause narrow caves to collide
  const expandOffset = new ClipperLib.ClipperOffset();
  expandOffset.AddPath(clipperPath, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const expandedPaths: ClipperLib.Paths = [];
  expandOffset.Execute(expandedPaths, scaledGapWidth);
  
  if (expandedPaths.length === 0 || expandedPaths[0].length === 0) {
    console.log('[weldNarrowGaps] Expansion produced no result, returning original');
    return points;
  }
  
  // Step 2: Shrink (negative offset) - restore to original size with caves welded
  const shrinkOffset = new ClipperLib.ClipperOffset();
  shrinkOffset.AddPath(expandedPaths[0], ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const shrunkPaths: ClipperLib.Paths = [];
  shrinkOffset.Execute(shrunkPaths, -scaledGapWidth);
  
  if (shrunkPaths.length === 0 || shrunkPaths[0].length === 0) {
    console.log('[weldNarrowGaps] Shrinking produced no result, returning expanded');
    // Fall back to expanded result converted back
    return expandedPaths[0].map((p: { X: number; Y: number }) => ({
      x: p.X / CLIPPER_SCALE,
      y: p.Y / CLIPPER_SCALE
    }));
  }
  
  // Convert back to Point format
  const result = shrunkPaths[0].map((p: { X: number; Y: number }) => ({
    x: p.X / CLIPPER_SCALE,
    y: p.Y / CLIPPER_SCALE
  }));
  
  console.log('[weldNarrowGaps] Welded narrow gaps:', points.length, '→', result.length, 'points (gap width:', gapWidthPixels, 'px)');
  
  return result;
}

export function removeLoopsWithClipper(points: Point[]): Point[] {
  if (points.length < 3) return points;
  
  // Step 0: Weld narrow gaps using Minkowski Closing (expand + shrink)
  // This seals 'caves' too tight for cutting blades
  let result = weldNarrowGaps(points, 1.5);
  
  // First pass: Use Clipper to remove self-intersections
  result = cleanPathWithClipper(result);
  
  // Second pass: Clean up closely spaced vertices
  result = simplifyPathWithClipper(result, 0.5);
  
  // Third pass: Remove any remaining backtracking
  result = removeBacktracking(result);
  
  // Fourth pass: Run SimplifyPolygon again to catch any loops created by backtracking removal
  result = cleanPathWithClipper(result);
  
  // Fifth pass: Final cleanup
  result = removeBacktracking(result);
  
  // Sixth pass: Aggressive simplification to flatten zigzags for die cutting
  result = simplifyForDieCutting(result, 2.0); // 2 pixel tolerance for smooth curves
  
  // Seventh pass: Round sharp corners surgically (only acute angles)
  result = roundSharpCorners(result, 8.0); // 8 pixel rounding radius for flatter curves
  
  // Eighth pass: Final Clipper cleanup
  result = cleanPathWithClipper(result);
  
  console.log('[removeLoopsWithClipper] Final path points:', result.length);
  
  return result;
}

// Surgical angle-based corner rounding - only modifies acute angles
// Replaces sharp V-shaped vertices with small arc segments
export function roundSharpCorners(points: Point[], radiusPixels: number): Point[] {
  if (points.length < 3 || radiusPixels <= 0) return points;
  
  const result: Point[] = [];
  const n = points.length;
  const minAngleDegrees = 30; // Angles sharper than this get rounded
  const minAngleCos = Math.cos((180 - minAngleDegrees) * Math.PI / 180); // cos(150°) ≈ -0.866
  
  let sharpCornersFound = 0;
  
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    
    // Calculate vectors
    const v1x = prev.x - curr.x;
    const v1y = prev.y - curr.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    
    const len1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const len2 = Math.sqrt(v2x * v2x + v2y * v2y);
    
    if (len1 < 0.0001 || len2 < 0.0001) {
      result.push(curr);
      continue;
    }
    
    // Normalize
    const n1x = v1x / len1;
    const n1y = v1y / len1;
    const n2x = v2x / len2;
    const n2y = v2y / len2;
    
    // Calculate dot product (cos of angle)
    const dot = n1x * n2x + n1y * n2y;
    
    // Check if this is a sharp angle (V-shape)
    // dot > minAngleCos means angle is less than minAngleDegrees
    if (dot > minAngleCos) {
      sharpCornersFound++;
      
      // Simple chamfer: cut the corner by connecting points along each edge
      const chamferDist = Math.min(radiusPixels, len1 * 0.3, len2 * 0.3);
      
      // Point along edge toward prev
      const p1x = curr.x + n1x * chamferDist;
      const p1y = curr.y + n1y * chamferDist;
      
      // Point along edge toward next
      const p2x = curr.x + n2x * chamferDist;
      const p2y = curr.y + n2y * chamferDist;
      
      // Add the two chamfer points (simple bevel cut)
      result.push({ x: p1x, y: p1y });
      result.push({ x: p2x, y: p2y });
    } else {
      // Normal angle, keep the point
      result.push(curr);
    }
  }
  
  console.log('[roundSharpCorners] Found', sharpCornersFound, 'sharp corners, path:', points.length, '→', result.length, 'points');
  
  return result.length >= 3 ? result : points;
}

function removeBacktracking(points: Point[]): Point[] {
  if (points.length < 5) return points;
  
  const result: Point[] = [];
  const n = points.length;
  
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
    
    if (len1 < 0.0001 || len2 < 0.0001) {
      continue;
    }
    
    const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
    
    // More aggressive: remove points with turns > 140 degrees (dot < -0.766)
    // This catches smaller loops that might slip through
    if (dot < -0.766) {
      continue;
    }
    
    result.push(curr);
  }
  
  return result.length >= 3 ? result : points;
}

// Aggressive path simplification for die cutting - flattens zigzags into smooth curves
function simplifyForDieCutting(points: Point[], tolerance: number): Point[] {
  if (points.length < 5) return points;
  
  // Use Douglas-Peucker algorithm to simplify the path
  const simplified = douglasPeucker(points, tolerance);
  
  // Then apply Chaikin's corner cutting for smoother curves
  let smoothed = simplified;
  for (let pass = 0; pass < 2; pass++) {
    smoothed = chaikinSmooth(smoothed);
  }
  
  console.log('[simplifyForDieCutting] Path:', points.length, '→', smoothed.length, 'points');
  
  return smoothed.length >= 3 ? smoothed : points;
}

// Douglas-Peucker line simplification algorithm
function douglasPeucker(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;
  
  // Find the point with the maximum distance from the line between first and last
  let maxDist = 0;
  let maxIdx = 0;
  
  const first = points[0];
  const last = points[points.length - 1];
  
  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(points[i], first, last);
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }
  
  // If max distance is greater than epsilon, recursively simplify
  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, maxIdx + 1), epsilon);
    const right = douglasPeucker(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  } else {
    return [first, last];
  }
}

function perpendicularDistance(point: Point, lineStart: Point, lineEnd: Point): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  
  if (len < 0.0001) {
    return Math.sqrt((point.x - lineStart.x) ** 2 + (point.y - lineStart.y) ** 2);
  }
  
  const t = Math.max(0, Math.min(1, ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / (len * len)));
  const projX = lineStart.x + t * dx;
  const projY = lineStart.y + t * dy;
  
  return Math.sqrt((point.x - projX) ** 2 + (point.y - projY) ** 2);
}

// Chaikin's corner cutting algorithm for smooth curves
function chaikinSmooth(points: Point[]): Point[] {
  if (points.length < 3) return points;
  
  const result: Point[] = [];
  const n = points.length;
  
  for (let i = 0; i < n; i++) {
    const curr = points[i];
    const next = points[(i + 1) % n];
    
    // Add point at 1/4 along segment
    result.push({
      x: curr.x * 0.75 + next.x * 0.25,
      y: curr.y * 0.75 + next.y * 0.25
    });
    
    // Add point at 3/4 along segment
    result.push({
      x: curr.x * 0.25 + next.x * 0.75,
      y: curr.y * 0.25 + next.y * 0.75
    });
  }
  
  return result;
}

// Remove zigzag patterns - sequences of points with alternating sharp turns
function removeZigzags(points: Point[], maxZigzagSpacing: number): Point[] {
  if (points.length < 5) return points;
  
  const result: Point[] = [];
  const n = points.length;
  let zigzagsRemoved = 0;
  
  // First, mark points that are part of a zigzag
  const isZigzagPoint: boolean[] = new Array(n).fill(false);
  
  for (let i = 1; i < n - 1; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    
    // Check segment lengths
    const len1 = Math.sqrt((curr.x - prev.x) ** 2 + (curr.y - prev.y) ** 2);
    const len2 = Math.sqrt((next.x - curr.x) ** 2 + (next.y - curr.y) ** 2);
    
    // If both segments are short, check for sharp turn
    if (len1 < maxZigzagSpacing && len2 < maxZigzagSpacing) {
      const v1x = curr.x - prev.x;
      const v1y = curr.y - prev.y;
      const v2x = next.x - curr.x;
      const v2y = next.y - curr.y;
      
      if (len1 > 0.0001 && len2 > 0.0001) {
        const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
        // Sharp turn (angle > 60 degrees from straight = dot < 0.5)
        if (dot < 0.5) {
          isZigzagPoint[i] = true;
        }
      }
    }
  }
  
  // Now build result, skipping consecutive zigzag points
  let i = 0;
  while (i < n) {
    if (!isZigzagPoint[i]) {
      result.push(points[i]);
      i++;
    } else {
      // Found start of zigzag, find end
      const zigzagStart = i;
      while (i < n && isZigzagPoint[i]) {
        i++;
      }
      // Add midpoint of zigzag segment
      if (i < n) {
        const midIdx = Math.floor((zigzagStart + i) / 2);
        result.push(points[midIdx]);
        zigzagsRemoved++;
      }
    }
  }
  
  if (zigzagsRemoved > 0) {
    console.log('[removeZigzags] Collapsed', zigzagsRemoved, 'zigzag sequences, path:', n, '→', result.length, 'points');
  }
  
  return result.length >= 3 ? result : points;
}

export function ensureClockwise(points: Point[]): Point[] {
  if (points.length < 3) return points;
  
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const curr = points[i];
    const next = points[(i + 1) % n];
    area += (curr.x * next.y) - (next.x * curr.y);
  }
  
  if (area > 0) {
    return [...points].reverse();
  }
  
  return points;
}

// Debug function to detect self-intersections in a path
export function detectSelfIntersections(points: Point[]): { hasLoops: boolean; intersections: Array<{i: number; j: number; point: Point}> } {
  const intersections: Array<{i: number; j: number; point: Point}> = [];
  const n = points.length;
  
  for (let i = 0; i < n; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    
    // Check against all non-adjacent segments
    for (let j = i + 2; j < n; j++) {
      // Skip adjacent segments
      if (j === (i + n - 1) % n) continue;
      if (i === 0 && j === n - 1) continue;
      
      const p3 = points[j];
      const p4 = points[(j + 1) % n];
      
      const intersection = lineIntersection(p1, p2, p3, p4);
      if (intersection) {
        intersections.push({ i, j, point: intersection });
      }
    }
  }
  
  console.log(`[detectSelfIntersections] Found ${intersections.length} self-intersections in path with ${n} points`);
  if (intersections.length > 0) {
    console.log('[detectSelfIntersections] First 5 intersections:', intersections.slice(0, 5));
  }
  
  return { hasLoops: intersections.length > 0, intersections };
}

function lineIntersection(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 0.0000001) return null;
  
  const dx = p3.x - p1.x;
  const dy = p3.y - p1.y;
  
  const t = (dx * d2y - dy * d2x) / cross;
  const u = (dx * d1y - dy * d1x) / cross;
  
  // Check if intersection is strictly within both segments (not at endpoints)
  if (t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999) {
    return {
      x: p1.x + t * d1x,
      y: p1.y + t * d1y
    };
  }
  
  return null;
}

// Detect curved segments where start-to-end DISTANCE is 60+ pts and convert to single Bezier curves
// Returns an array of path segments: either {type: 'line', point} or {type: 'curve', cp1, cp2, end}
export interface PathSegment {
  type: 'move' | 'line' | 'curve';
  point?: Point;
  cp1?: Point;
  cp2?: Point;
  end?: Point;
}

function pointDistance(p1: Point, p2: Point): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Check if points form a curve (deviate from straight line)
function isCurvedPath(points: Point[], minDeviation: number = 3): boolean {
  if (points.length < 3) return false;
  
  const start = points[0];
  const end = points[points.length - 1];
  
  // Find maximum deviation from straight line
  let maxDeviation = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const dev = perpendicularDistance(points[i], start, end);
    if (dev > maxDeviation) maxDeviation = dev;
  }
  
  // Also check if angle changes are consistent (one direction)
  let positiveChanges = 0;
  let negativeChanges = 0;
  
  for (let i = 1; i < points.length - 1; i++) {
    const angle1 = Math.atan2(points[i].y - points[i-1].y, points[i].x - points[i-1].x);
    const angle2 = Math.atan2(points[i+1].y - points[i].y, points[i+1].x - points[i].x);
    let diff = angle2 - angle1;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    
    if (diff > 0.005) positiveChanges++;
    else if (diff < -0.005) negativeChanges++;
  }
  
  const total = positiveChanges + negativeChanges;
  const isConsistentDirection = total > 0 && Math.max(positiveChanges, negativeChanges) / total > 0.6;
  
  return maxDeviation >= minDeviation && isConsistentDirection;
}

// Fit a cubic Bezier curve to a set of points with adaptive control points
function fitBezierCurve(points: Point[]): { cp1: Point; cp2: Point; end: Point } | null {
  if (points.length < 3) return null;
  
  const start = points[0];
  const end = points[points.length - 1];
  
  // Guard against zero distance (coincident points)
  const dist = pointDistance(start, end);
  if (dist < 0.001) {
    return null;
  }
  
  // Find the point of maximum deviation - this guides control point placement
  let maxDev = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const dev = perpendicularDistance(points[i], start, end);
    if (dev > maxDev) {
      maxDev = dev;
    }
  }
  
  // Use points at 1/3 and 2/3 of the path for control point estimation
  const t1Idx = Math.max(1, Math.floor(points.length / 3));
  const t2Idx = Math.min(points.length - 2, Math.floor((2 * points.length) / 3));
  const p1 = points[t1Idx];
  const p2 = points[t2Idx];
  
  // Control points extend outward from the curve path
  // Scale factor based on deviation ratio - more deviation = more control point offset
  const deviationRatio = Math.min(maxDev / dist, 1.0); // Cap at 1.0 to prevent extreme scaling
  const scaleFactor = 1.5 + deviationRatio * 0.5;
  
  const cp1: Point = {
    x: start.x + (p1.x - start.x) * scaleFactor,
    y: start.y + (p1.y - start.y) * scaleFactor
  };
  
  const cp2: Point = {
    x: end.x + (p2.x - end.x) * scaleFactor,
    y: end.y + (p2.y - end.y) * scaleFactor
  };
  
  return { cp1, cp2, end };
}

// Check if a segment is a valid arc with consistent curvature
function isValidArc(points: Point[], minDevRatio: number = 0.03, minChord: number = 10): boolean {
  if (points.length < 5) return false;
  
  const start = points[0];
  const end = points[points.length - 1];
  const chordDist = pointDistance(start, end);
  if (chordDist < minChord) return false; // Minimum chord length (units depend on coordinate system)
  
  // Find max deviation from chord
  let maxDev = 0;
  let maxDevIdx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const dev = perpendicularDistance(points[i], start, end);
    if (dev > maxDev) {
      maxDev = dev;
      maxDevIdx = i;
    }
  }
  
  // Must have significant deviation (not a straight line)
  const devRatio = maxDev / chordDist;
  if (devRatio < minDevRatio) return false;
  
  // For large arcs (high deviation), be more lenient with consistency
  // Half circles have deviation ~= 0.5 * chord length
  const isLargeArc = devRatio > 0.25;
  
  // Check curvature sign consistency (all angles should bend the same way)
  let positiveCount = 0;
  let negativeCount = 0;
  let straightCount = 0;
  
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];
    
    // Cross product gives curvature sign
    const cross = (curr.x - prev.x) * (next.y - curr.y) - (curr.y - prev.y) * (next.x - curr.x);
    
    if (Math.abs(cross) < 0.5) straightCount++;
    else if (cross > 0) positiveCount++;
    else negativeCount++;
  }
  
  const total = positiveCount + negativeCount + straightCount;
  if (total === 0) return false;
  
  // For large arcs (half circles), use lower consistency threshold (50%)
  // For smaller arcs, use stricter threshold (60%)
  const dominantCount = Math.max(positiveCount, negativeCount);
  const consistency = dominantCount / (positiveCount + negativeCount + 0.001);
  const threshold = isLargeArc ? 0.50 : 0.60;
  
  // Also check that the max deviation is roughly in the middle (arc-like shape)
  const relPeakPos = maxDevIdx / (points.length - 1);
  const peakInMiddle = relPeakPos > 0.15 && relPeakPos < 0.85;
  
  return consistency > threshold && peakInMiddle;
}

// minDistance is the minimum distance (in pixels/points) between curve start and end
export function convertPolygonToCurves(polygon: Point[], minDistance: number = 70, minChord: number = 10): PathSegment[] {
  if (polygon.length < 3) return [];
  
  const segments: PathSegment[] = [];
  segments.push({ type: 'move', point: polygon[0] });
  
  let curveCount = 0;
  let lineCount = 0;
  
  // Maximum arc span limit - increased to 400 to capture half-circles on larger shapes
  const maxArcSpan = 400;
  
  let i = 1;
  while (i < polygon.length) {
    // Search for the LONGEST valid arc segment starting from current position
    let bestEnd = -1;
    let bestSegment: Point[] | null = null;
    
    const startPt = polygon[i - 1];
    const maxWindow = Math.min(polygon.length, i + maxArcSpan);
    
    // Start from farthest (within limit) and work backwards to find longest valid arc
    for (let j = maxWindow - 1; j >= i + 4; j--) {
      const endPt = polygon[j];
      const dist = pointDistance(startPt, endPt);
      
      if (dist >= minDistance) {
        const segment = polygon.slice(i - 1, j + 1);
        
        // Pass minChord for coordinate-system-aware arc validation
        if (isValidArc(segment, 0.03, minChord)) {
          bestEnd = j;
          bestSegment = segment;
          break; // Found longest valid arc, use it
        }
      }
    }
    
    if (bestEnd > 0 && bestSegment) {
      // Fit a single Bezier curve to the entire arc
      const bezier = fitBezierCurve(bestSegment);
      if (bezier) {
        segments.push({
          type: 'curve',
          cp1: bezier.cp1,
          cp2: bezier.cp2,
          end: bezier.end
        });
        
        curveCount++;
        i = bestEnd + 1;
        continue;
      }
    }
    
    // No valid arc found, add as line segment
    segments.push({ type: 'line', point: polygon[i] });
    lineCount++;
    i++;
  }
  
  console.log(`[CurveDetection] Polygon ${polygon.length} pts -> ${curveCount} curves, ${lineCount} lines`);
  
  return segments;
}

/**
 * Convert a polygon to smooth bezier curves using Catmull-Rom spline interpolation.
 * This creates smooth curves that pass through the original points.
 * tension: 0 = straight lines, 0.5 = smooth curves (default), 1 = very smooth
 */
export function polygonToSplinePath(polygon: Point[], tension: number = 0.5): PathSegment[] {
  if (polygon.length < 3) return [];
  
  const segments: PathSegment[] = [];
  const n = polygon.length;
  
  // First point is a moveTo
  segments.push({ type: 'move', point: polygon[0] });
  
  // For closed polygon, we need to wrap around
  for (let i = 0; i < n; i++) {
    const p0 = polygon[(i - 1 + n) % n];
    const p1 = polygon[i];
    const p2 = polygon[(i + 1) % n];
    const p3 = polygon[(i + 2) % n];
    
    // Catmull-Rom to Bezier conversion
    // Control points are calculated from neighboring points
    const cp1 = {
      x: p1.x + (p2.x - p0.x) * tension / 6,
      y: p1.y + (p2.y - p0.y) * tension / 6
    };
    
    const cp2 = {
      x: p2.x - (p3.x - p1.x) * tension / 6,
      y: p2.y - (p3.y - p1.y) * tension / 6
    };
    
    segments.push({
      type: 'curve',
      cp1: cp1,
      cp2: cp2,
      end: p2
    });
  }
  
  console.log(`[polygonToSplinePath] Converted ${polygon.length} points to ${segments.length - 1} bezier curves`);
  
  return segments;
}

/**
 * Simplify polygon by keeping only every Nth point, preserving corners.
 * This reduces jaggedness while maintaining shape.
 */
export function subsamplePolygon(polygon: Point[], targetPoints: number = 200): Point[] {
  if (polygon.length <= targetPoints) return polygon;
  
  const step = polygon.length / targetPoints;
  const result: Point[] = [];
  
  for (let i = 0; i < targetPoints; i++) {
    const idx = Math.floor(i * step);
    result.push(polygon[idx]);
  }
  
  console.log(`[subsamplePolygon] Reduced ${polygon.length} points to ${result.length}`);
  return result;
}

export function unionRectangles(rectangles: Array<{x1: number; y1: number; x2: number; y2: number}>): Point[][] {
  if (rectangles.length === 0) return [];
  
  const clipper = new ClipperLib.Clipper();
  
  for (const rect of rectangles) {
    const rectPath: ClipperLib.Path = [
      { X: Math.round(rect.x1 * CLIPPER_SCALE), Y: Math.round(rect.y1 * CLIPPER_SCALE) },
      { X: Math.round(rect.x2 * CLIPPER_SCALE), Y: Math.round(rect.y1 * CLIPPER_SCALE) },
      { X: Math.round(rect.x2 * CLIPPER_SCALE), Y: Math.round(rect.y2 * CLIPPER_SCALE) },
      { X: Math.round(rect.x1 * CLIPPER_SCALE), Y: Math.round(rect.y2 * CLIPPER_SCALE) }
    ];
    clipper.AddPath(rectPath, ClipperLib.PolyType.ptSubject, true);
  }
  
  const solution: ClipperLib.Path[] = [];
  clipper.Execute(ClipperLib.ClipType.ctUnion, solution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  
  if (solution.length === 0) return [];
  
  // Return the union result directly without aggressive simplification to preserve shape accuracy
  const result: Point[][] = solution.map(path => {
    return path.map((p: { X: number; Y: number }) => ({
      x: p.X / CLIPPER_SCALE,
      y: p.Y / CLIPPER_SCALE
    }));
  });
  
  console.log(`[unionRectangles] United ${rectangles.length} rectangles into ${result.length} polygons`);
  
  return result;
}

/**
 * Optimize contour path for vinyl cutting machines.
 * 
 * 1. Curve Fitting: Convert short line segments into cubic beziers, preserve sharp corners (>30°)
 * 2. De-Speckle: Remove tiny holes (area < minHoleArea)
 * 3. Sanitize Precision: Round coordinates to 2 decimal places
 * 
 * @param paths - Array of contour paths (outer contour + holes)
 * @param minHoleArea - Minimum hole area to keep (default 100 square units)
 * @param sharpAngleThreshold - Angle in degrees above which corners are kept sharp (default 30)
 * @returns SVG path string with C commands for curves and L for sharp edges
 */
export interface CuttingOptimizedResult {
  svgPath: string;
  outerPath: Point[];
  holes: Point[][];
  stats: {
    originalPoints: number;
    curveSegments: number;
    lineSegments: number;
    holesRemoved: number;
  };
}

export function optimizeForCutting(
  outerPath: Point[],
  holes: Point[][] = [],
  minHoleArea: number = 100,
  sharpAngleThreshold: number = 30
): CuttingOptimizedResult {
  const stats = {
    originalPoints: outerPath.length + holes.reduce((sum, h) => sum + h.length, 0),
    curveSegments: 0,
    lineSegments: 0,
    holesRemoved: 0
  };

  // Step 1: De-Speckle - Remove tiny holes
  const filteredHoles = holes.filter(hole => {
    const area = Math.abs(polygonArea(hole));
    if (area < minHoleArea) {
      stats.holesRemoved++;
      return false;
    }
    return true;
  });

  console.log(`[optimizeForCutting] Removed ${stats.holesRemoved} tiny holes (area < ${minHoleArea})`);

  // Step 2: Curve Fitting + Precision Sanitization for outer path
  const outerResult = fitCurvesAndSanitize(outerPath, sharpAngleThreshold);
  stats.curveSegments += outerResult.curveCount;
  stats.lineSegments += outerResult.lineCount;

  // Step 3: Process remaining holes
  const holeResults = filteredHoles.map(hole => fitCurvesAndSanitize(hole, sharpAngleThreshold));
  holeResults.forEach(r => {
    stats.curveSegments += r.curveCount;
    stats.lineSegments += r.lineCount;
  });

  // Build SVG path string
  let svgPath = outerResult.svgPath;
  holeResults.forEach(r => {
    svgPath += ' ' + r.svgPath;
  });

  console.log(`[optimizeForCutting] Result: ${stats.curveSegments} curves, ${stats.lineSegments} lines`);

  return {
    svgPath,
    outerPath: outerResult.points,
    holes: holeResults.map(r => r.points),
    stats
  };
}

function polygonArea(points: Point[]): number {
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return area / 2;
}

function angleBetweenVectors(v1: Point, v2: Point): number {
  const dot = v1.x * v2.x + v1.y * v2.y;
  const mag1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
  const mag2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
  if (mag1 === 0 || mag2 === 0) return 0;
  const cos = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
  return Math.acos(cos) * (180 / Math.PI);
}

function roundTo2Decimals(n: number): number {
  return Math.round(n * 100) / 100;
}

interface FitResult {
  svgPath: string;
  points: Point[];
  curveCount: number;
  lineCount: number;
}

/**
 * Smart polygon-to-bezier conversion using Catmull-Rom splines.
 * - Sharp corners (angle > threshold): Use LineTo commands
 * - Smooth curves (angle <= threshold): Use Catmull-Rom interpolated cubic beziers
 * 
 * This preserves diamond tips while smoothing bubble letter curves.
 */
function fitCurvesAndSanitize(points: Point[], sharpAngleThreshold: number): FitResult {
  if (points.length < 3) {
    return { svgPath: '', points: [], curveCount: 0, lineCount: 0 };
  }

  // Step 1: Sanitize precision
  const sanitized = points.map(p => ({
    x: roundTo2Decimals(p.x),
    y: roundTo2Decimals(p.y)
  }));

  // Step 2: Calculate vertex angles and mark sharp corners
  const vertexAngles: number[] = [];
  const isSharpCorner: boolean[] = [];
  
  for (let i = 0; i < sanitized.length; i++) {
    const prev = sanitized[(i - 1 + sanitized.length) % sanitized.length];
    const curr = sanitized[i];
    const next = sanitized[(i + 1) % sanitized.length];
    
    const v1 = { x: curr.x - prev.x, y: curr.y - prev.y };
    const v2 = { x: next.x - curr.x, y: next.y - curr.y };
    
    const angle = angleBetweenVectors(v1, v2);
    vertexAngles.push(angle);
    isSharpCorner.push(angle > sharpAngleThreshold);
  }

  // Step 3: Find runs of smooth points between sharp corners
  const runs: { start: number; end: number; isSmooth: boolean }[] = [];
  let runStart = 0;
  
  for (let i = 0; i < sanitized.length; i++) {
    if (isSharpCorner[i]) {
      // End current smooth run (if any)
      if (i > runStart) {
        runs.push({ start: runStart, end: i - 1, isSmooth: true });
      }
      // Add sharp corner as single-point run
      runs.push({ start: i, end: i, isSmooth: false });
      runStart = i + 1;
    }
  }
  
  // Handle wrap-around for closed polygon
  if (runStart < sanitized.length) {
    // Check if this run connects to the first run
    if (runs.length > 0 && runs[0].isSmooth && !isSharpCorner[0]) {
      // Merge with first run (they're connected)
      runs[0].start = runStart;
    } else {
      runs.push({ start: runStart, end: sanitized.length - 1, isSmooth: true });
    }
  }

  // Step 4: Build SVG path
  let svgPath = `M ${sanitized[0].x} ${sanitized[0].y}`;
  let curveCount = 0;
  let lineCount = 0;
  let currentIdx = 0;

  // Process each point in order
  for (let i = 1; i < sanitized.length; i++) {
    const prev = sanitized[i - 1];
    const curr = sanitized[i];
    
    if (isSharpCorner[i]) {
      // Sharp corner: use LineTo
      svgPath += ` L ${curr.x} ${curr.y}`;
      lineCount++;
    } else {
      // Smooth section: use Catmull-Rom to cubic bezier conversion
      // Get the 4 points needed for Catmull-Rom: p0, p1, p2, p3
      const p0 = sanitized[(i - 2 + sanitized.length) % sanitized.length];
      const p1 = prev;
      const p2 = curr;
      const p3 = sanitized[(i + 1) % sanitized.length];
      
      // Convert Catmull-Rom segment to cubic bezier
      // Catmull-Rom to Bezier conversion factor (tension = 0.5 for standard CR)
      const tension = 0.5;
      
      const cp1 = {
        x: roundTo2Decimals(p1.x + (p2.x - p0.x) * tension / 3),
        y: roundTo2Decimals(p1.y + (p2.y - p0.y) * tension / 3)
      };
      
      const cp2 = {
        x: roundTo2Decimals(p2.x - (p3.x - p1.x) * tension / 3),
        y: roundTo2Decimals(p2.y - (p3.y - p1.y) * tension / 3)
      };
      
      svgPath += ` C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${p2.x} ${p2.y}`;
      curveCount++;
    }
  }
  
  // Close the path - handle last segment to first point
  const lastPt = sanitized[sanitized.length - 1];
  const firstPt = sanitized[0];
  
  if (isSharpCorner[0]) {
    // First point is sharp: close with line
    svgPath += ' Z';
  } else {
    // First point is smooth: use Catmull-Rom for closing segment
    const p0 = sanitized[sanitized.length - 2];
    const p1 = lastPt;
    const p2 = firstPt;
    const p3 = sanitized[1];
    
    const tension = 0.5;
    
    const cp1 = {
      x: roundTo2Decimals(p1.x + (p2.x - p0.x) * tension / 3),
      y: roundTo2Decimals(p1.y + (p2.y - p0.y) * tension / 3)
    };
    
    const cp2 = {
      x: roundTo2Decimals(p2.x - (p3.x - p1.x) * tension / 3),
      y: roundTo2Decimals(p2.y - (p3.y - p1.y) * tension / 3)
    };
    
    svgPath += ` C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${p2.x} ${p2.y} Z`;
    curveCount++;
  }

  console.log(`[polygonToBeziers] ${sanitized.length} pts → ${curveCount} curves, ${lineCount} lines (${isSharpCorner.filter(x => x).length} sharp corners)`);

  return {
    svgPath,
    points: sanitized,
    curveCount,
    lineCount
  };
}

/**
 * Exported function for direct polygon-to-bezier conversion.
 * @param points - Polygon vertices
 * @param sharpAngleThreshold - Angle in degrees above which corners are kept sharp (default 30)
 * @returns SVG path string with C commands for curves and L for sharp edges
 */
export function polygonToBeziers(
  points: Point[],
  sharpAngleThreshold: number = 30
): string {
  const result = fitCurvesAndSanitize(points, sharpAngleThreshold);
  return result.svgPath;
}
