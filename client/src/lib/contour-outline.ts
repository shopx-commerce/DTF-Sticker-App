import type { StrokeSettings, ResizeSettings } from "@/lib/types";
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFPage, PDFRef, rgb, degrees } from 'pdf-lib';
import { removeLoopsWithClipper, ensureClockwise, detectSelfIntersections, gaussianSmoothContour, subsamplePolygon, polygonToSplinePath } from "@/lib/clipper-path";
import { getContourWorkerManager, type BezierPath } from "@/lib/contour-worker-manager";
import { addSpotColorVectorsToPDF, type SpotPixelMapData } from "@/lib/spot-color-vectors";
import { planVectorQROverlays, detectQRAppearance, type DetectedQR, type QRAppearance } from "@/lib/qr";

// ─── Vector QR overlay (source-aware) ────────────────────────────────────
// Paints each detected QR as crisp PDF vector geometry. Modules are forced
// to pure-black squares (max scanner contrast, 100% module fill) and the
// centred-logo region is carved out of the wipe so the user's source logo
// art passes through unchanged at full raster quality. This is the
// highest-quality QR pipeline we have: vectors are crisp at any DPI /
// zoom regardless of how the viewer or printer rasterises the page.
//
// Per-module rendering rules:
//   - In the logo bbox       → skip the module (source raster passes
//                                through, including the logo)
//   - "1" (dark) module      → solid black square inscribed in module bbox
//   - "0" (light) module     → covered by the white pre-wipe; nothing more
//
// Coordinate model:
//   - `imageRect` is the on-page rectangle (PDF points, origin
//     bottom-left) where the design raster was drawn via `page.drawImage`.
//   - `srcImagePixelWidth/Height` are the source-image dimensions whose
//     pixel coords the QR bboxes are in. We scale into the on-page rect.
//   - PDF Y axis points up; QR grid `j` index points down — flip on emit.
function drawVectorQRsOnPage(
  page: PDFPage,
  qrCodes: DetectedQR[] | undefined,
  imageRect: { x: number; y: number; width: number; height: number },
  srcImagePixelWidth: number,
  srcImagePixelHeight: number,
  sourceImage: HTMLImageElement | HTMLCanvasElement | undefined,
  options: {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    /**
     * Quiet-zone halo around the QR, expressed in module widths. Default 1.
     * Spec calls for 4; most modern scanners decode reliably at 1. Lower
     * values reduce visible white border around the rendered QR. Set to 0
     * to disable the halo entirely (risky for scanability).
     */
    quietZoneModules?: number;
    /**
     * Lower bound on the halo expressed as a fraction of the QR bbox.
     * The actual halo is `max(quietZoneModules*moduleSize, quietZoneFraction*bbox)`.
     * Default 0.02 (2%). Was 0.08 before the visible-border fix.
     */
    quietZoneFraction?: number;
  } = {}
): { drawn: number; skipped: number; appearances: Array<{ shape: string; logo: boolean }> } {
  if (!qrCodes || qrCodes.length === 0) return { drawn: 0, skipped: 0, appearances: [] };
  const plans = planVectorQROverlays(qrCodes, options.errorCorrectionLevel ?? 'H');
  if (plans.length === 0) return { drawn: 0, skipped: qrCodes.length, appearances: [] };

  const sx = imageRect.width / srcImagePixelWidth;
  const sy = imageRect.height / srcImagePixelHeight;
  const appearances: Array<{ shape: string; logo: boolean }> = [];

  for (const plan of plans) {
    const { grid, bbox, rotation } = plan;
    const destW = bbox.width * sx;
    const destH = bbox.height * sy;
    const destX = imageRect.x + bbox.x * sx;
    const destY = imageRect.y + (imageRect.height - bbox.y * sy - destH);

    const rotDeg = (rotation * 180) / Math.PI;
    const useRotation = Math.abs(rotDeg) > 0.5;

    // Read the source image for module shape / colour / logo region.
    // If we don't have the source (defensive), fall back to plain
    // square/black/white with no logo preservation.
    const appearance: QRAppearance = sourceImage
      ? detectQRAppearance(sourceImage, bbox, grid)
      : { shape: 'square', dark: { r: 0, g: 0, b: 0 }, light: { r: 255, g: 255, b: 255 }, logoBox: null };
    // We always render squares now (forced for scanner reliability), but
    // log the *detected* shape for diagnostics so we can tell whether the
    // source happens to be circles/squares.
    appearances.push({ shape: `square[detected:${appearance.shape}]`, logo: appearance.logoBox !== null });

    // Force pure-black-on-white modules — every QR scanner is calibrated
    // for max contrast B/W. Sampled colours are kept around for
    // diagnostics but not used for the actual paint.
    const darkColor = rgb(0, 0, 0);
    const lightColor = rgb(1, 1, 1);
    void appearance.dark; void appearance.light;

    const logoOnPage = appearance.logoBox ? {
      x: imageRect.x + appearance.logoBox.x * sx,
      y: imageRect.y + (imageRect.height - appearance.logoBox.y * sy - appearance.logoBox.height * sy),
      width: appearance.logoBox.width * sx,
      height: appearance.logoBox.height * sy,
    } : null;

    const moduleW = destW / grid.size;
    const moduleH = destH / grid.size;

    // SQUARE modules — 100% module fill and best-possible scanner
    // contrast. The non-rotated path below merges horizontal runs into
    // single rectangles (per user request: "thicker lines instead of
    // multiple thin ones — better for printing"). The rotated path
    // emits per-module rectangles since merging across a rotation
    // would require building a rotated polygon.

    const moduleCentreInLogo = (pxLeft: number, pyBottom: number): boolean => {
      if (!logoOnPage) return false;
      const cx = pxLeft + moduleW / 2;
      const cy = pyBottom + moduleH / 2;
      return cx >= logoOnPage.x && cx <= logoOnPage.x + logoOnPage.width &&
             cy >= logoOnPage.y && cy <= logoOnPage.y + logoOnPage.height;
    };

    // ── Pre-wipe pass ─────────────────────────────────────────────────
    // Wipe the QR bbox + halo to white, but CARVE OUT the centred-logo
    // region so the user's source logo art passes through unchanged.
    // Per user request: "we don't need to vectorize the logo... we want
    // to leave the logo they have in the middle there".
    //
    // Skipped in the rotated case — the rotated module loop below uses
    // overlapping rectangles that already cover the bbox. Doing a
    // straight-rect wipe under a rotated QR would leak out the corners.
    if (!useRotation) {
      // Halo size = max(quietZoneModules * moduleSize, quietZoneFraction * bbox).
      // Defaults are tighter than QR spec (4 modules) — most scanners decode
      // fine at 1 module of quiet zone, and a smaller halo keeps the QR from
      // bleeding visible white into the surrounding design.
      const quietZoneModules = options.quietZoneModules ?? 0;
      const quietZoneFraction = options.quietZoneFraction ?? 0;
      const haloPad = Math.max(
        quietZoneModules * Math.min(moduleW, moduleH),
        quietZoneFraction * Math.min(destW, destH),
      );
      const wipeX = destX - haloPad;
      const wipeY = destY - haloPad; // PDF Y-up: bottom edge of wipe
      const wipeW = destW + 2 * haloPad;
      const wipeH = destH + 2 * haloPad;
      if (logoOnPage) {
        const lx = Math.max(wipeX, logoOnPage.x);
        const lyBottom = Math.max(wipeY, logoOnPage.y);
        const lr = Math.min(wipeX + wipeW, logoOnPage.x + logoOnPage.width);
        const lyTop = Math.min(wipeY + wipeH, logoOnPage.y + logoOnPage.height);
        if (lr > lx && lyTop > lyBottom) {
          // Top frame (above logo, in PDF Y-up coords)
          if (lyTop < wipeY + wipeH) {
            page.drawRectangle({
              x: wipeX, y: lyTop, width: wipeW, height: (wipeY + wipeH) - lyTop,
              color: lightColor, borderWidth: 0,
            });
          }
          // Bottom frame (below logo)
          if (lyBottom > wipeY) {
            page.drawRectangle({
              x: wipeX, y: wipeY, width: wipeW, height: lyBottom - wipeY,
              color: lightColor, borderWidth: 0,
            });
          }
          // Left frame
          if (lx > wipeX) {
            page.drawRectangle({
              x: wipeX, y: lyBottom, width: lx - wipeX, height: lyTop - lyBottom,
              color: lightColor, borderWidth: 0,
            });
          }
          // Right frame
          if (lr < wipeX + wipeW) {
            page.drawRectangle({
              x: lr, y: lyBottom, width: (wipeX + wipeW) - lr, height: lyTop - lyBottom,
              color: lightColor, borderWidth: 0,
            });
          }
        } else {
          page.drawRectangle({
            x: wipeX, y: wipeY, width: wipeW, height: wipeH,
            color: lightColor, borderWidth: 0,
          });
        }
      } else {
        page.drawRectangle({
          x: wipeX, y: wipeY, width: wipeW, height: wipeH,
          color: lightColor, borderWidth: 0,
        });
      }
    }

    if (useRotation) {
      // pdf-lib doesn't expose ctx-style transforms; for the small
      // rotation window we allow (≤8°) we approximate by rotating each
      // module around the QR centre.
      const cx = destX + destW / 2;
      const cy = destY + destH / 2;
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      for (let j = 0; j < grid.size; j++) {
        for (let i = 0; i < grid.size; i++) {
          const isDark = grid.modules[j * grid.size + i] === 1;
          const localCx = (i + 0.5) * moduleW - destW / 2;
          const localCy = -((j + 0.5) * moduleH - destH / 2);
          const px = cx + cos * localCx - sin * localCy - moduleW / 2;
          const py = cy + sin * localCx + cos * localCy - moduleH / 2;
          if (moduleCentreInLogo(px, py)) continue;
          // Rotated module: emit as oriented rectangle. We don't draw
          // rotated circles here — if the user has a circle-style QR
          // that's also rotated (rare), we fall back to squares for the
          // rotated case rather than wrestle with rotated circle math.
          page.drawRectangle({
            x: px, y: py, width: moduleW, height: moduleH,
            color: isDark ? darkColor : lightColor,
            borderWidth: 0,
            rotate: degrees(rotDeg),
          });
        }
      }
    } else {
      // ── Horizontal run-merge ──────────────────────────────────────
      // Per user request: "thicker lines instead of multiple thin
      // ones — better for printing". Walk each row and merge
      // consecutive dark modules into a single wider rectangle.
      // Print/cut benefits:
      //   - No seam between adjacent dark modules (no ink-bleed gap)
      //   - Cut machines cope better with longer continuous shapes
      //   - PDF size drops (one rect per run vs one per module)
      // Decoder behaviour is unchanged: a run of N dark modules is
      // geometrically identical whether painted as N squares or 1
      // rectangle — same bit pattern, same coverage.
      //
      // A logo-skip in the middle of a run breaks it into two runs,
      // so the carve-out still passes source pixels through.
      let drawnRunsTotal = 0;
      let drawnModulesTotal = 0;
      let skippedDarkTotal = 0;
      for (let j = 0; j < grid.size; j++) {
        // PDF Y-up: row j (top-down in grid) is at y-coord (size-1-j)*moduleH
        const py = destY + (grid.size - 1 - j) * moduleH;
        let runStart = -1;
        for (let i = 0; i < grid.size; i++) {
          const isDark = grid.modules[j * grid.size + i] === 1;
          let skipForLogo = false;
          if (isDark) {
            const px = destX + i * moduleW;
            if (moduleCentreInLogo(px, py)) {
              skipForLogo = true;
              skippedDarkTotal++;
            }
          }
          if (isDark && !skipForLogo) {
            if (runStart === -1) runStart = i;
          } else if (runStart !== -1) {
            const px = destX + runStart * moduleW;
            const runWidth = (i - runStart) * moduleW;
            page.drawRectangle({
              x: px, y: py, width: runWidth, height: moduleH,
              color: darkColor, borderWidth: 0,
            });
            drawnRunsTotal++;
            drawnModulesTotal += i - runStart;
            runStart = -1;
          }
        }
        if (runStart !== -1) {
          const px = destX + runStart * moduleW;
          const runWidth = (grid.size - runStart) * moduleW;
          page.drawRectangle({
            x: px, y: py, width: runWidth, height: moduleH,
            color: darkColor, borderWidth: 0,
          });
          drawnRunsTotal++;
          drawnModulesTotal += grid.size - runStart;
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `[QR] Render (PDF): ${grid.size}×${grid.size} grid, ` +
        `drew ${drawnModulesTotal} dark modules in ${drawnRunsTotal} runs ` +
        `(${(drawnModulesTotal / Math.max(drawnRunsTotal, 1)).toFixed(1)} mods/run, ` +
        `skipped ${skippedDarkTotal} for logo)`
      );
    }

    // No vector logo pass — per user request, the centred logo is left
    // alone via the carve-out in the pre-wipe above. The user's source
    // logo art passes through unchanged at full raster quality.
  }

  return { drawn: plans.length, skipped: qrCodes.length - plans.length, appearances };
}

export function simplifyPathForPDF(points: Array<{x: number; y: number}>, epsilon: number = 1.0): Array<{x: number; y: number}> {
  if (points.length <= 2) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;

    let maxDist = 0;
    let maxIdx = lo;
    const start = points[lo];
    const end = points[hi];

    for (let i = lo + 1; i < hi; i++) {
      const d = perpendicularDistance(points[i], start, end);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }

    if (maxDist > epsilon) {
      keep[maxIdx] = 1;
      stack.push([lo, maxIdx], [maxIdx, hi]);
    }
  }

  const result: Array<{x: number; y: number}> = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) result.push(points[i]);
  }
  return result;
}

function perpendicularDistance(
  point: {x: number; y: number},
  lineStart: {x: number; y: number},
  lineEnd: {x: number; y: number}
): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = point.x - lineStart.x;
    const ey = point.y - lineStart.y;
    return Math.sqrt(ex * ex + ey * ey);
  }
  const num = Math.abs(dy * point.x - dx * point.y + lineEnd.x * lineStart.y - lineEnd.y * lineStart.x);
  return num / Math.sqrt(lenSq);
}

export function buildSmoothPdfPath(
  pointsInches: Array<{x: number; y: number}>,
  closed: boolean = true
): string {
  if (pointsInches.length < 2) return '';

  const pts = pointsInches.map(p => ({ x: p.x * 72, y: p.y * 72 }));
  const n = pts.length;

  let path = `${pts[0].x.toFixed(4)} ${pts[0].y.toFixed(4)} m\n`;

  if (n < 16) {
    for (let i = 1; i < n; i++) {
      path += `${pts[i].x.toFixed(4)} ${pts[i].y.toFixed(4)} l\n`;
    }
    if (closed) path += 'h\n';
    return path;
  }

  const segCount = closed ? n : n - 1;
  const MAX_CP_RATIO = 0.4;
  const MIN_SEG_LEN = 1.5;

  for (let i = 0; i < segCount; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];

    let p0: typeof p1;
    let p3: typeof p1;

    if (closed) {
      p0 = pts[(i - 1 + n) % n];
      p3 = pts[(i + 2) % n];
    } else {
      p0 = i > 0 ? pts[i - 1] : { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y };
      p3 = i + 2 < n ? pts[i + 2] : { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y };
    }

    const segDx = p2.x - p1.x, segDy = p2.y - p1.y;
    const segLen = Math.sqrt(segDx * segDx + segDy * segDy);

    if (segLen < MIN_SEG_LEN) {
      path += `${p2.x.toFixed(4)} ${p2.y.toFixed(4)} l\n`;
      continue;
    }

    let cp1x = p1.x + (p2.x - p0.x) / 6;
    let cp1y = p1.y + (p2.y - p0.y) / 6;
    let cp2x = p2.x - (p3.x - p1.x) / 6;
    let cp2y = p2.y - (p3.y - p1.y) / 6;

    const maxDisp = segLen * MAX_CP_RATIO;
    const d1x = cp1x - p1.x, d1y = cp1y - p1.y;
    const d1 = Math.sqrt(d1x * d1x + d1y * d1y);
    if (d1 > maxDisp) {
      const s = maxDisp / d1;
      cp1x = p1.x + d1x * s;
      cp1y = p1.y + d1y * s;
    }
    const d2x = cp2x - p2.x, d2y = cp2y - p2.y;
    const d2 = Math.sqrt(d2x * d2x + d2y * d2y);
    if (d2 > maxDisp) {
      const s = maxDisp / d2;
      cp2x = p2.x + d2x * s;
      cp2y = p2.y + d2y * s;
    }

    path += `${cp1x.toFixed(4)} ${cp1y.toFixed(4)} ${cp2x.toFixed(4)} ${cp2y.toFixed(4)} ${p2.x.toFixed(4)} ${p2.y.toFixed(4)} c\n`;
  }

  if (closed) path += 'h\n';

  return path;
}

export function contourPointsToPDFPathOps(
  pathPointsInches: Array<{x: number; y: number}>,
  pageHeightInches: number,
  spotColorName: string = 'CutContour',
  disableSplines: boolean = false
): string {
  console.log(`[PDF ${spotColorName}] Using ${pathPointsInches.length} points${disableSplines ? ' (splines disabled)' : ''}`);
  console.log(`[PDF ${spotColorName}] Page height: ${pageHeightInches.toFixed(3)}in`);

  if (pathPointsInches.length < 2) {
    console.warn(`[PDF ${spotColorName}] Too few points, skipping`);
    return '';
  }

  // Defensive sliver guard: drop degenerate paths that would render as a long straight
  // diagonal cut line (typically an artifact of de-self-intersecting a smoothed ring).
  if (pathPointsInches.length >= 3) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let signedArea2 = 0;
    const n = pathPointsInches.length;
    for (let i = 0; i < n; i++) {
      const p = pathPointsInches[i];
      const q = pathPointsInches[(i + 1) % n];
      signedArea2 += p.x * q.y - q.x * p.y;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const area = Math.abs(signedArea2) / 2; // square inches
    const bw = Math.max(1e-4, maxX - minX);
    const bh = Math.max(1e-4, maxY - minY);
    const density = area / (bw * bh);
    // 0.0004 in² ≈ 0.02"x0.02" — anything under this is noise / sliver.
    // density < 5% means the polygon is essentially a line.
    if (area < 0.0004 || density < 0.05) {
      console.warn(
        `[PDF ${spotColorName}] Skipping sliver path: area=${area.toFixed(5)}in², density=${density.toFixed(3)}, pts=${n}`
      );
      return '';
    }
  }

  let pathOps = 'q\n';
  pathOps += `/${spotColorName} CS 1 SCN\n`;
  pathOps += '0.5 w\n';

  const pts = pathPointsInches.map(p => ({ x: p.x * 72, y: p.y * 72 }));

  // Geometric shape paths (rectangle=4, square=4) have very few points;
  // spline interpolation would curve their straight edges.
  // Only use splines for paths dense enough to benefit from smoothing.
  // Zero Hero paths are pixel-locked, sub-pixel-precise, and already smoothed
  // upstream — splining them re-rounds sharp corners and shifts edges off the
  // tracing the user sees in the preview, so callers can opt out.
  const useSplines = !disableSplines && pts.length >= 16;

  if (useSplines) {
    const n = pts.length;
    const MAX_CP_RATIO = 0.4;
    const MIN_SEG_LEN = 1.5;
    pathOps += `${pts[0].x.toFixed(4)} ${pts[0].y.toFixed(4)} m\n`;
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n];
      const p1 = pts[i];
      const p2 = pts[(i + 1) % n];
      const p3 = pts[(i + 2) % n];
      const segDx = p2.x - p1.x, segDy = p2.y - p1.y;
      const segLen = Math.sqrt(segDx * segDx + segDy * segDy);

      if (segLen < MIN_SEG_LEN) {
        pathOps += `${p2.x.toFixed(4)} ${p2.y.toFixed(4)} l\n`;
        continue;
      }

      let cp1x = p1.x + (p2.x - p0.x) / 12;
      let cp1y = p1.y + (p2.y - p0.y) / 12;
      let cp2x = p2.x - (p3.x - p1.x) / 12;
      let cp2y = p2.y - (p3.y - p1.y) / 12;

      const d1x = cp1x - p1.x, d1y = cp1y - p1.y;
      const d1 = Math.sqrt(d1x * d1x + d1y * d1y);
      const maxDisp = segLen * MAX_CP_RATIO;
      if (d1 > maxDisp) {
        const s = maxDisp / d1;
        cp1x = p1.x + d1x * s;
        cp1y = p1.y + d1y * s;
      }

      const d2x = cp2x - p2.x, d2y = cp2y - p2.y;
      const d2 = Math.sqrt(d2x * d2x + d2y * d2y);
      if (d2 > maxDisp) {
        const s = maxDisp / d2;
        cp2x = p2.x + d2x * s;
        cp2y = p2.y + d2y * s;
      }

      pathOps += `${cp1x.toFixed(4)} ${cp1y.toFixed(4)} ${cp2x.toFixed(4)} ${cp2y.toFixed(4)} ${p2.x.toFixed(4)} ${p2.y.toFixed(4)} c\n`;
    }
  } else {
    pathOps += `${pts[0].x.toFixed(4)} ${pts[0].y.toFixed(4)} m\n`;
    for (let i = 1; i < pts.length; i++) {
      pathOps += `${pts[i].x.toFixed(4)} ${pts[i].y.toFixed(4)} l\n`;
    }
  }

  pathOps += 'h\n';
  pathOps += 'S\n';
  pathOps += 'Q\n';

  return pathOps;
}

// Emit PDF content-stream operators for a single closed BezierPath.
//
// Coordinate space: input path is in INCHES in the PDF coord system (Y already
// flipped). We multiply by 72 to convert to points and emit:
//   m  — moveto
//   l  — lineto      (for `line` segments)
//   c  — cubic curve (for `cubic` segments — control points and endpoint)
//   h  — close
//   S  — stroke
//
// Sliver guard mirrors `contourPointsToPDFPathOps`: we sample the path back
// to a polyline and apply the same area/density check so a degenerate fit
// can't sneak through and render as a long diagonal line.
export function bezierPathToPDFPathOps(
  path: BezierPath,
  pageHeightInches: number,
  spotColorName: string = 'CutContour'
): string {
  if (path.segments.length < 2) {
    console.warn(`[PDF ${spotColorName}] BezierPath too short, skipping`);
    return '';
  }

  // Sliver guard — sample the path to a polyline (cheap; cubic = 6 samples)
  // and apply the same area/density check that `contourPointsToPDFPathOps` uses.
  {
    const samples: Array<{ x: number; y: number }> = [];
    samples.push({ x: path.start.x, y: path.start.y });
    let cur = path.start;
    for (const seg of path.segments) {
      if (seg.type === 'line') {
        samples.push({ x: seg.to.x, y: seg.to.y });
        cur = seg.to;
      } else {
        for (let i = 1; i <= 6; i++) {
          const t = i / 6;
          const u = 1 - t;
          const uu = u * u, tt = t * t;
          const uuu = uu * u, ttt = tt * t;
          samples.push({
            x: uuu * cur.x + 3 * uu * t * seg.cp1.x + 3 * u * tt * seg.cp2.x + ttt * seg.to.x,
            y: uuu * cur.y + 3 * uu * t * seg.cp1.y + 3 * u * tt * seg.cp2.y + ttt * seg.to.y,
          });
        }
        cur = seg.to;
      }
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let signedArea2 = 0;
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      const p = samples[i];
      const q = samples[(i + 1) % n];
      signedArea2 += p.x * q.y - q.x * p.y;
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const area = Math.abs(signedArea2) / 2;
    const bw = Math.max(1e-4, maxX - minX);
    const bh = Math.max(1e-4, maxY - minY);
    const density = area / (bw * bh);
    if (area < 0.0004 || density < 0.05) {
      console.warn(
        `[PDF ${spotColorName}] Skipping sliver bezier path: area=${area.toFixed(5)}in², density=${density.toFixed(3)}, segs=${path.segments.length}`
      );
      return '';
    }
  }

  let pathOps = 'q\n';
  pathOps += `/${spotColorName} CS 1 SCN\n`;
  pathOps += '0.5 w\n';

  const sx = (v: number) => (v * 72).toFixed(4);

  // Move to start.
  pathOps += `${sx(path.start.x)} ${sx(path.start.y)} m\n`;
  let lineCount = 0;
  let cubicCount = 0;
  for (const seg of path.segments) {
    if (seg.type === 'line') {
      pathOps += `${sx(seg.to.x)} ${sx(seg.to.y)} l\n`;
      lineCount++;
    } else {
      pathOps += `${sx(seg.cp1.x)} ${sx(seg.cp1.y)} ${sx(seg.cp2.x)} ${sx(seg.cp2.y)} ${sx(seg.to.x)} ${sx(seg.to.y)} c\n`;
      cubicCount++;
    }
  }
  pathOps += 'h\n';
  pathOps += 'S\n';
  pathOps += 'Q\n';

  console.log(
    `[PDF ${spotColorName}] Emitted bezier path: ${path.segments.length} segments (${lineCount} line + ${cubicCount} cubic)`
  );
  return pathOps;
}

export interface ContourPathResult {
  pathPoints: Array<{ x: number; y: number }>;
  widthInches: number;
  heightInches: number;
  imageOffsetX: number;
  imageOffsetY: number;
  backgroundColor: string;
}

interface Point {
  x: number;
  y: number;
}

function getPolygonSignedAreaInches(path: Array<{ x: number; y: number }>): number {
  let area = 0;
  const n = path.length;
  for (let i = 0; i < n; i++) {
    const curr = path[i];
    const next = path[(i + 1) % n];
    area += (curr.x * next.y) - (next.x * curr.y);
  }
  return area / 2;
}

function expandPathOutwardInches(path: Array<{ x: number; y: number }>, expansionInches: number): Array<{ x: number; y: number }> {
  if (path.length < 3) return path;
  
  // Determine winding direction: positive area = counter-clockwise, negative = clockwise
  // For CCW polygons, the perpendicular normals point INWARD, so we need to negate
  // For CW polygons, the perpendicular normals point OUTWARD, so we keep them
  const signedArea = getPolygonSignedAreaInches(path);
  const windingMultiplier = signedArea >= 0 ? -1 : 1;
  
  const expanded: Array<{ x: number; y: number }> = [];
  const n = path.length;
  
  for (let i = 0; i < n; i++) {
    const prev = path[(i - 1 + n) % n];
    const curr = path[i];
    const next = path[(i + 1) % n];
    
    const e1x = curr.x - prev.x;
    const e1y = curr.y - prev.y;
    const e2x = next.x - curr.x;
    const e2y = next.y - curr.y;
    
    const len1 = Math.sqrt(e1x * e1x + e1y * e1y) || 1;
    const len2 = Math.sqrt(e2x * e2x + e2y * e2y) || 1;
    
    const n1x = -e1y / len1;
    const n1y = e1x / len1;
    const n2x = -e2y / len2;
    const n2y = e2x / len2;
    
    let nx = (n1x + n2x) / 2;
    let ny = (n1y + n2y) / 2;
    const nlen = Math.sqrt(nx * nx + ny * ny) || 1;
    nx /= nlen;
    ny /= nlen;
    
    // Apply winding multiplier to ensure outward expansion
    expanded.push({
      x: curr.x + nx * expansionInches * windingMultiplier,
      y: curr.y + ny * expansionInches * windingMultiplier
    });
  }
  
  return expanded;
}

// Close all gaps for solid bleed fill - uses aggressive gap closing with inch-based paths
function closeGapsForBleedInches(points: Array<{ x: number; y: number }>, maxGapInches: number): Array<{ x: number; y: number }> {
  // Convert to pixel-like format for the gap closing algorithm
  // Use 300 DPI as reference for conversion
  const refDPI = 300;
  const pixelPoints: Array<{ x: number; y: number }> = points.map(p => ({ 
    x: p.x * refDPI, 
    y: p.y * refDPI 
  }));
  const gapThresholdPixels = maxGapInches * refDPI;
  
  // Apply gap closing multiple times with progressively smaller thresholds
  let result = closeGapsWithShapes(pixelPoints, gapThresholdPixels);
  result = closeGapsWithShapes(result, gapThresholdPixels * 0.5);
  result = closeGapsWithShapes(result, gapThresholdPixels * 0.25);
  
  // Convert back to inches
  return result.map(p => ({ x: p.x / refDPI, y: p.y / refDPI }));
}

export function createSilhouetteContour(
  image: HTMLImageElement,
  strokeSettings: StrokeSettings,
  resizeSettings?: ResizeSettings
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const effectiveDPI = resizeSettings 
    ? image.width / resizeSettings.widthInches
    : image.width / 5;
  
  // Base offset keeps cutpath away from design edge - increased significantly to prevent any cutting into design
  const baseOffsetInches = 0.125; // 1/8 inch minimum margin
  const baseOffsetPixels = Math.round(baseOffsetInches * effectiveDPI);
  
  const autoBridgeInches = 0.02;
  const autoBridgePixels = Math.round(autoBridgeInches * effectiveDPI);
  
  let gapClosePixels = 0;
  if (strokeSettings.autoBridging) {
    gapClosePixels = Math.round(strokeSettings.autoBridgingThreshold * effectiveDPI);
  }
  
  const userOffsetPixels = Math.round(strokeSettings.width * effectiveDPI);
  
  const totalOffsetPixels = baseOffsetPixels + userOffsetPixels;
  
  const padding = totalOffsetPixels + 10;
  canvas.width = image.width + (padding * 2);
  canvas.height = image.height + (padding * 2);
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  try {
    const silhouetteMask = createSilhouetteMask(image);
    if (silhouetteMask.length === 0) {
      ctx.drawImage(image, padding, padding);
      return canvas;
    }
    
    let autoBridgedMask = silhouetteMask;
    if (autoBridgePixels > 0) {
      const halfAutoBridge = Math.round(autoBridgePixels / 2);
      const dilatedAuto = dilateSilhouette(silhouetteMask, image.width, image.height, halfAutoBridge);
      const dilatedAutoWidth = image.width + halfAutoBridge * 2;
      const dilatedAutoHeight = image.height + halfAutoBridge * 2;
      const filledAuto = fillSilhouette(dilatedAuto, dilatedAutoWidth, dilatedAutoHeight);
      
      autoBridgedMask = new Uint8Array(image.width * image.height);
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          autoBridgedMask[y * image.width + x] = filledAuto[(y + halfAutoBridge) * dilatedAutoWidth + (x + halfAutoBridge)];
        }
      }
    }
    
    let bridgedMask = autoBridgedMask;
    let bridgedWidth = image.width;
    let bridgedHeight = image.height;
    
    if (gapClosePixels > 0) {
      const halfGapPixels = Math.round(gapClosePixels / 2);
      
      const dilatedMask = dilateSilhouette(autoBridgedMask, image.width, image.height, halfGapPixels);
      const dilatedWidth = image.width + halfGapPixels * 2;
      const dilatedHeight = image.height + halfGapPixels * 2;
      
      const filledDilated = fillSilhouette(dilatedMask, dilatedWidth, dilatedHeight);
      
      bridgedMask = new Uint8Array(image.width * image.height);
      bridgedMask.set(autoBridgedMask);
      
      for (let y = 1; y < image.height - 1; y++) {
        for (let x = 1; x < image.width - 1; x++) {
          if (autoBridgedMask[y * image.width + x] === 0) {
            const srcX = x + halfGapPixels;
            const srcY = y + halfGapPixels;
            if (filledDilated[srcY * dilatedWidth + srcX] === 1) {
              let hasContentTop = false, hasContentBottom = false;
              let hasContentLeft = false, hasContentRight = false;
              
              for (let d = 1; d <= halfGapPixels && !hasContentTop; d++) {
                if (y - d >= 0 && autoBridgedMask[(y - d) * image.width + x] === 1) hasContentTop = true;
              }
              for (let d = 1; d <= halfGapPixels && !hasContentBottom; d++) {
                if (y + d < image.height && autoBridgedMask[(y + d) * image.width + x] === 1) hasContentBottom = true;
              }
              for (let d = 1; d <= halfGapPixels && !hasContentLeft; d++) {
                if (x - d >= 0 && autoBridgedMask[y * image.width + (x - d)] === 1) hasContentLeft = true;
              }
              for (let d = 1; d <= halfGapPixels && !hasContentRight; d++) {
                if (x + d < image.width && autoBridgedMask[y * image.width + (x + d)] === 1) hasContentRight = true;
              }
              
              if ((hasContentTop && hasContentBottom) || (hasContentLeft && hasContentRight)) {
                bridgedMask[y * image.width + x] = 1;
              }
            }
          }
        }
      }
      
      const smoothBridgePixels = Math.round(0.03 * effectiveDPI / 2);
      if (smoothBridgePixels > 0) {
        const distanceMap = new Float32Array(image.width * image.height);
        distanceMap.fill(Infinity);
        
        for (let y = 0; y < image.height; y++) {
          for (let x = 0; x < image.width; x++) {
            if (bridgedMask[y * image.width + x] === 1) {
              distanceMap[y * image.width + x] = 0;
            }
          }
        }
        
        for (let y = 1; y < image.height; y++) {
          for (let x = 1; x < image.width - 1; x++) {
            const idx = y * image.width + x;
            const topLeft = distanceMap[(y - 1) * image.width + (x - 1)] + 1.414;
            const top = distanceMap[(y - 1) * image.width + x] + 1;
            const topRight = distanceMap[(y - 1) * image.width + (x + 1)] + 1.414;
            const left = distanceMap[y * image.width + (x - 1)] + 1;
            distanceMap[idx] = Math.min(distanceMap[idx], topLeft, top, topRight, left);
          }
        }
        
        for (let y = image.height - 2; y >= 0; y--) {
          for (let x = image.width - 2; x >= 1; x--) {
            const idx = y * image.width + x;
            const bottomLeft = distanceMap[(y + 1) * image.width + (x - 1)] + 1.414;
            const bottom = distanceMap[(y + 1) * image.width + x] + 1;
            const bottomRight = distanceMap[(y + 1) * image.width + (x + 1)] + 1.414;
            const right = distanceMap[y * image.width + (x + 1)] + 1;
            distanceMap[idx] = Math.min(distanceMap[idx], bottomLeft, bottom, bottomRight, right);
          }
        }
        
        for (let y = 1; y < image.height - 1; y++) {
          for (let x = 1; x < image.width - 1; x++) {
            const idx = y * image.width + x;
            if (bridgedMask[idx] === 0 && distanceMap[idx] <= smoothBridgePixels) {
              let hasContentTop = false, hasContentBottom = false;
              let hasContentLeft = false, hasContentRight = false;
              
              for (let d = 1; d <= smoothBridgePixels && !hasContentTop; d++) {
                if (y - d >= 0 && bridgedMask[(y - d) * image.width + x] === 1) hasContentTop = true;
              }
              for (let d = 1; d <= smoothBridgePixels && !hasContentBottom; d++) {
                if (y + d < image.height && bridgedMask[(y + d) * image.width + x] === 1) hasContentBottom = true;
              }
              for (let d = 1; d <= smoothBridgePixels && !hasContentLeft; d++) {
                if (x - d >= 0 && bridgedMask[y * image.width + (x - d)] === 1) hasContentLeft = true;
              }
              for (let d = 1; d <= smoothBridgePixels && !hasContentRight; d++) {
                if (x + d < image.width && bridgedMask[y * image.width + (x + d)] === 1) hasContentRight = true;
              }
              
              if ((hasContentTop && hasContentBottom) || (hasContentLeft && hasContentRight)) {
                bridgedMask[idx] = 1;
              }
            }
          }
        }
      }
      
      bridgedWidth = image.width;
      bridgedHeight = image.height;
    }
    
    const baseDilatedMask = dilateSilhouette(bridgedMask, bridgedWidth, bridgedHeight, baseOffsetPixels);
    const baseWidth = bridgedWidth + baseOffsetPixels * 2;
    const baseHeight = bridgedHeight + baseOffsetPixels * 2;
    
    const filledMask = fillSilhouette(baseDilatedMask, baseWidth, baseHeight);
    
    const finalDilatedMask = dilateSilhouette(filledMask, baseWidth, baseHeight, userOffsetPixels);
    const dilatedWidth = baseWidth + userOffsetPixels * 2;
    const dilatedHeight = baseHeight + userOffsetPixels * 2;
    
    const bridgedFinalMask = bridgeTouchingContours(finalDilatedMask, dilatedWidth, dilatedHeight, effectiveDPI);
    
    const boundaryPath = traceBoundary(bridgedFinalMask, dilatedWidth, dilatedHeight);
    
    if (boundaryPath.length < 3) {
      ctx.drawImage(image, padding, padding);
      return canvas;
    }
    
    let smoothedPath = smoothPath(boundaryPath, 2);
    
    // CRITICAL: Fix crossings that occur at sharp corners after offset/dilation
    smoothedPath = fixOffsetCrossings(smoothedPath);
    
    // Apply gap closing using U/N shapes based on settings
    const gapThresholdPixels = strokeSettings.autoBridging 
      ? Math.round(strokeSettings.autoBridgingThreshold * effectiveDPI) 
      : 0;
    
    if (gapThresholdPixels > 0) {
      smoothedPath = closeGapsWithShapes(smoothedPath, gapThresholdPixels);
    }
    
    const offsetX = padding - totalOffsetPixels;
    const offsetY = padding - totalOffsetPixels;
    drawSmoothContour(ctx, smoothedPath, strokeSettings.color || '#FFFFFF', offsetX, offsetY);
    
    ctx.drawImage(image, padding, padding);
    
  } catch (error) {
    console.error('Silhouette contour error:', error);
    ctx.drawImage(image, padding, padding);
  }
  
  return canvas;
}

function fillSilhouette(mask: Uint8Array, width: number, height: number): Uint8Array {
  const filled = new Uint8Array(mask.length);
  filled.set(mask);
  
  const totalPixels = width * height;
  const visited = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  let qHead = 0, qTail = 0;
  
  for (let x = 0; x < width; x++) {
    if (mask[x] === 0 && !visited[x]) { visited[x] = 1; queue[qTail++] = x; }
    const b = (height - 1) * width + x;
    if (mask[b] === 0 && !visited[b]) { visited[b] = 1; queue[qTail++] = b; }
  }
  for (let y = 0; y < height; y++) {
    const l = y * width;
    if (mask[l] === 0 && !visited[l]) { visited[l] = 1; queue[qTail++] = l; }
    const r = y * width + width - 1;
    if (mask[r] === 0 && !visited[r]) { visited[r] = 1; queue[qTail++] = r; }
  }
  
  while (qHead < qTail) {
    const idx = queue[qHead++];
    const x = idx % width;
    const y = (idx / width) | 0;
    if (x > 0)          { const n = idx - 1;     if (!visited[n] && mask[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
    if (x < width - 1)  { const n = idx + 1;     if (!visited[n] && mask[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
    if (y > 0)          { const n = idx - width; if (!visited[n] && mask[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
    if (y < height - 1) { const n = idx + width; if (!visited[n] && mask[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
  }
  
  for (let i = 0; i < filled.length; i++) {
    if (filled[i] === 0 && !visited[i]) {
      filled[i] = 1;
    }
  }
  
  return filled;
}

function bridgeTouchingContours(mask: Uint8Array, width: number, height: number, effectiveDPI: number): Uint8Array {
  const result = new Uint8Array(mask.length);
  result.set(mask);
  
  const bridgeThresholdPixels = Math.max(2, Math.round(0.03 * effectiveDPI));
  
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      
      if (mask[idx] === 0) {
        let contentDirections = 0;
        let hasContentTop = false, hasContentBottom = false;
        let hasContentLeft = false, hasContentRight = false;
        
        for (let d = 1; d <= bridgeThresholdPixels; d++) {
          if (!hasContentTop && y - d >= 0 && mask[(y - d) * width + x] === 1) {
            hasContentTop = true;
          }
          if (!hasContentBottom && y + d < height && mask[(y + d) * width + x] === 1) {
            hasContentBottom = true;
          }
          if (!hasContentLeft && x - d >= 0 && mask[y * width + (x - d)] === 1) {
            hasContentLeft = true;
          }
          if (!hasContentRight && x + d < width && mask[y * width + (x + d)] === 1) {
            hasContentRight = true;
          }
        }
        
        let hasContentTopLeft = false, hasContentTopRight = false;
        let hasContentBottomLeft = false, hasContentBottomRight = false;
        
        for (let d = 1; d <= bridgeThresholdPixels; d++) {
          if (!hasContentTopLeft && y - d >= 0 && x - d >= 0 && mask[(y - d) * width + (x - d)] === 1) {
            hasContentTopLeft = true;
          }
          if (!hasContentTopRight && y - d >= 0 && x + d < width && mask[(y - d) * width + (x + d)] === 1) {
            hasContentTopRight = true;
          }
          if (!hasContentBottomLeft && y + d < height && x - d >= 0 && mask[(y + d) * width + (x - d)] === 1) {
            hasContentBottomLeft = true;
          }
          if (!hasContentBottomRight && y + d < height && x + d < width && mask[(y + d) * width + (x + d)] === 1) {
            hasContentBottomRight = true;
          }
        }
        
        if (hasContentTop) contentDirections++;
        if (hasContentBottom) contentDirections++;
        if (hasContentLeft) contentDirections++;
        if (hasContentRight) contentDirections++;
        
        const hasOpposingSides = (hasContentTop && hasContentBottom) || (hasContentLeft && hasContentRight);
        const hasDiagonalTouch = (hasContentTopLeft && hasContentBottomRight) || 
                                  (hasContentTopRight && hasContentBottomLeft);
        const isCorner = contentDirections >= 3;
        
        if (hasOpposingSides || isCorner || hasDiagonalTouch) {
          result[idx] = 1;
        }
      }
    }
  }
  
  const totalPixels = width * height;
  const visited = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  let qHead = 0, qTail = 0;
  
  for (let x = 0; x < width; x++) {
    if (result[x] === 0 && !visited[x]) { visited[x] = 1; queue[qTail++] = x; }
    const b = (height - 1) * width + x;
    if (result[b] === 0 && !visited[b]) { visited[b] = 1; queue[qTail++] = b; }
  }
  for (let y = 0; y < height; y++) {
    const l = y * width;
    if (result[l] === 0 && !visited[l]) { visited[l] = 1; queue[qTail++] = l; }
    const r = y * width + width - 1;
    if (result[r] === 0 && !visited[r]) { visited[r] = 1; queue[qTail++] = r; }
  }
  
  while (qHead < qTail) {
    const idx = queue[qHead++];
    const x = idx % width;
    const y = (idx / width) | 0;
    if (x > 0)          { const n = idx - 1;     if (!visited[n] && result[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
    if (x < width - 1)  { const n = idx + 1;     if (!visited[n] && result[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
    if (y > 0)          { const n = idx - width; if (!visited[n] && result[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
    if (y < height - 1) { const n = idx + width; if (!visited[n] && result[n] === 0) { visited[n] = 1; queue[qTail++] = n; } }
  }
  
  for (let i = 0; i < result.length; i++) {
    if (result[i] === 0 && !visited[i]) {
      result[i] = 1;
    }
  }
  
  return result;
}

function createSilhouetteMask(image: HTMLImageElement): Uint8Array {
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) return new Uint8Array(0);

  tempCanvas.width = image.width;
  tempCanvas.height = image.height;
  
  tempCtx.drawImage(image, 0, 0);
  const imageData = tempCtx.getImageData(0, 0, image.width, image.height);
  const data = imageData.data;
  
  const mask = new Uint8Array(image.width * image.height);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = data[i * 4 + 3] > 10 ? 1 : 0;
  }
  
  return mask;
}

function dilateSilhouette(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const newWidth = width + radius * 2;
  const newHeight = height + radius * 2;
  const result = new Uint8Array(newWidth * newHeight);
  
  if (radius <= 0) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        result[y * newWidth + x] = mask[y * width + x];
      }
    }
    return result;
  }
  
  // Optimized circular dilation with precomputed offsets
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

function traceBoundary(mask: Uint8Array, width: number, height: number): Point[] {
  // MATCHES WORKER EXACTLY - Simple boundary tracing
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

function smoothPath(points: Point[], windowSize: number): Point[] {
  // MATCHES WORKER EXACTLY - simple moving average smoothing
  if (points.length < windowSize * 2 + 1) return points;
  
  const result: Point[] = [];
  const n = points.length;
  
  for (let i = 0; i < n; i++) {
    let sumX = 0, sumY = 0;
    for (let j = -windowSize; j <= windowSize; j++) {
      const idx = (i + j + n) % n;
      sumX += points[idx].x;
      sumY += points[idx].y;
    }
    result.push({
      x: sumX / (windowSize * 2 + 1),
      y: sumY / (windowSize * 2 + 1)
    });
  }
  
  return result;
}

// Generate U-shaped merge path (for outward curves)
function generateUShapeMerge(start: Point, end: Point, depth: number): Point[] {
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return [start, end];
  
  const perpX = -dy / len;
  const perpY = dx / len;
  
  const quarterX = (start.x + midX) / 2;
  const quarterY = (start.y + midY) / 2;
  const threeQuarterX = (midX + end.x) / 2;
  const threeQuarterY = (midY + end.y) / 2;
  
  return [
    start,
    { x: quarterX + perpX * depth * 0.5, y: quarterY + perpY * depth * 0.5 },
    { x: midX + perpX * depth, y: midY + perpY * depth },
    { x: threeQuarterX + perpX * depth * 0.5, y: threeQuarterY + perpY * depth * 0.5 },
    end
  ];
}

// Generate N-shaped merge path (for inward/concave transitions)
function generateNShapeMerge(start: Point, end: Point, depth: number): Point[] {
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return [start, end];
  
  const perpX = dy / len;
  const perpY = -dx / len;
  
  const quarterX = (start.x + midX) / 2;
  const quarterY = (start.y + midY) / 2;
  const threeQuarterX = (midX + end.x) / 2;
  const threeQuarterY = (midY + end.y) / 2;
  
  return [
    start,
    { x: quarterX + perpX * depth * 0.3, y: quarterY + perpY * depth * 0.3 },
    { x: midX + perpX * depth * 0.5, y: midY + perpY * depth * 0.5 },
    { x: threeQuarterX + perpX * depth * 0.3, y: threeQuarterY + perpY * depth * 0.3 },
    end
  ];
}

// Apply merge curves at ALL direction changes
function applyMergeCurves(points: Point[]): Point[] {
  if (points.length < 6) return points;
  
  const result: Point[] = [];
  const n = points.length;
  
  let i = 0;
  while (i < n) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    
    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    
    const len1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const len2 = Math.sqrt(v2x * v2x + v2y * v2y);
    
    if (len1 > 0.5 && len2 > 0.5) {
      const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
      const cross = v1x * v2y - v1y * v2x;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
      
      // Apply to ANY direction change (more than 15 degrees)
      if (angle > Math.PI / 12) {
        const sharpness = angle / Math.PI;
        const baseDepth = Math.min(len1, len2) * 0.4;
        const depth = Math.max(1, baseDepth * (0.3 + sharpness * 0.7));
        
        if (cross < 0) {
          // Concave turn (inward) - use N shape
          const mergePoints = generateNShapeMerge(prev, next, depth);
          for (let m = 1; m < mergePoints.length - 1; m++) {
            result.push(mergePoints[m]);
          }
          i++;
          continue;
        } else if (cross > 0) {
          // Convex turn (outward) - use U shape
          const mergePoints = generateUShapeMerge(prev, next, depth);
          for (let m = 1; m < mergePoints.length - 1; m++) {
            result.push(mergePoints[m]);
          }
          i++;
          continue;
        }
      }
    }
    
    result.push(curr);
    i++;
  }
  
  return result.length >= 3 ? result : points;
}

// Remove points that overshoot or stick out beyond the smooth path
function removeOvershootingPoints(points: Point[]): Point[] {
  if (points.length < 5) return points;
  
  // First pass: detect and unite crossing junctions
  let result = uniteJunctions(points);
  
  // Second pass: remove remaining spikes
  result = removeSpikesFromPath(result);
  
  return result.length >= 3 ? result : points;
}

// Detect where path segments cross or nearly touch and unite them
function uniteJunctions(points: Point[]): Point[] {
  if (points.length < 8) return points;
  
  // First pass: detect sharp turns that need U/N merge shapes
  let result = detectAndMergeSharpTurns(points);
  
  // Second pass: detect close proximity junctions
  result = detectProximityJunctions(result);
  
  return result;
}

// Detect sharp turns (>45 degrees) and apply U/N merge shapes
function detectAndMergeSharpTurns(points: Point[]): Point[] {
  if (points.length < 6) return points;
  
  const result: Point[] = [];
  const n = points.length;
  
  let i = 0;
  while (i < n) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    
    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    
    const len1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const len2 = Math.sqrt(v2x * v2x + v2y * v2y);
    
    if (len1 > 0.1 && len2 > 0.1) {
      const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
      const cross = v1x * v2y - v1y * v2x;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
      
      // Sharp turn detected (more than 45 degrees) - ALWAYS apply merge
      if (angle > Math.PI / 4) {
        const sharpness = angle / Math.PI;
        // Use larger depth for sharper turns to ensure proper merge
        const depth = Math.max(3, Math.min(len1, len2) * sharpness * 0.6);
        
        if (cross < 0) {
          // Concave (inward) - N shape merge
          const midX = (curr.x + next.x) / 2;
          const midY = (curr.y + next.y) / 2;
          const perpX = (next.y - curr.y) / len2;
          const perpY = -(next.x - curr.x) / len2;
          
          result.push({ x: midX + perpX * depth * 0.4, y: midY + perpY * depth * 0.4 });
          i++;
          continue;
        } else {
          // Convex (outward) - U shape merge
          const midX = (curr.x + next.x) / 2;
          const midY = (curr.y + next.y) / 2;
          const perpX = -(next.y - curr.y) / len2;
          const perpY = (next.x - curr.x) / len2;
          
          result.push({ x: midX + perpX * depth * 0.4, y: midY + perpY * depth * 0.4 });
          i++;
          continue;
        }
      }
    }
    
    result.push(curr);
    i++;
  }
  
  return result.length >= 3 ? result : points;
}

// Detect points that are close in space but far in path order
function detectProximityJunctions(points: Point[]): Point[] {
  if (points.length < 8) return points;
  
  const n = points.length;
  const result: Point[] = [];
  const skipIndices = new Set<number>();
  
  for (let i = 0; i < n; i++) {
    if (skipIndices.has(i)) continue;
    
    const pi = points[i];
    let foundJunction = false;
    
    // Increased search range and decreased distance threshold for tighter detection
    for (let j = i + 4; j < Math.min(i + 60, n); j++) {
      const pathDist = j - i;
      if (pathDist < 4) continue;
      
      const pj = points[j];
      const dist = Math.sqrt((pi.x - pj.x) ** 2 + (pi.y - pj.y) ** 2);
      
      // Much tighter detection - within 12 pixels now
      if (dist < 12) {
        // Skip all points in the loop
        for (let k = i + 1; k < j; k++) {
          skipIndices.add(k);
        }
        
        // Create smooth merge at junction center
        const mergePoint = { x: (pi.x + pj.x) / 2, y: (pi.y + pj.y) / 2 };
        result.push(mergePoint);
        foundJunction = true;
        break;
      }
    }
    
    if (!foundJunction) {
      result.push(pi);
    }
  }
  
  return result;
}

// Remove individual spike points
function removeSpikesFromPath(points: Point[]): Point[] {
  if (points.length < 5) return points;
  
  const result: Point[] = [];
  const n = points.length;
  
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    
    const lineX = next.x - prev.x;
    const lineY = next.y - prev.y;
    const lineLen = Math.sqrt(lineX * lineX + lineY * lineY);
    
    if (lineLen > 0) {
      const toPointX = curr.x - prev.x;
      const toPointY = curr.y - prev.y;
      const cross = Math.abs(lineX * toPointY - lineY * toPointX) / lineLen;
      
      // Skip if point sticks out too far
      if (cross > 12) {
        continue;
      }
    }
    
    result.push(curr);
  }
  
  return result;
}

// Fix crossings that occur in offset contours at sharp corners
// Uses Clipper.js for robust loop removal
function fixOffsetCrossings(points: Point[]): Point[] {
  if (points.length < 6) return points;
  
  console.log('[fixOffsetCrossings] BEFORE cleanup - checking for intersections');
  const beforeCheck = detectSelfIntersections(points);
  
  // Use Clipper.js to remove all self-intersections and loops
  let result = removeLoopsWithClipper(points);
  
  // Ensure consistent winding direction (clockwise for cutting)
  result = ensureClockwise(result);
  
  // Additional cleanup pass with legacy method for any remaining issues
  result = mergeClosePathPoints(result);
  
  console.log('[fixOffsetCrossings] AFTER cleanup - checking for intersections');
  const afterCheck = detectSelfIntersections(result);
  
  if (afterCheck.hasLoops) {
    console.warn('[fixOffsetCrossings] WARNING: Still has', afterCheck.intersections.length, 'self-intersections after cleanup!');
  } else {
    console.log('[fixOffsetCrossings] SUCCESS: No self-intersections remaining');
  }
  
  return result;
}

// Detect where lines actually cross and fix them
function detectAndFixLineCrossings(points: Point[]): Point[] {
  if (points.length < 6) return points;
  
  const n = points.length;
  const result: Point[] = [];
  const skipUntil = new Map<number, number>();
  
  // OPTIMIZATION: Use stride for large paths
  const stride = n > 1000 ? 3 : 1;
  
  for (let i = 0; i < n; i += stride) {
    // Check if we should skip this point
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
    
    // OPTIMIZATION: Limit search range to nearby segments
    const maxSearch = Math.min(n - 1, i + 300);
    for (let j = i + 3; j < maxSearch; j += stride) {
      const p3 = points[j];
      const p4 = points[(j + 1) % n];
      
      const intersection = lineSegmentIntersect(p1, p2, p3, p4);
      if (intersection) {
        // Found a crossing - skip the loop between them and add merge point
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

// Check if two line segments intersect
function lineSegmentIntersect(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 0.0001) return null; // Parallel
  
  const dx = p3.x - p1.x;
  const dy = p3.y - p1.y;
  
  const t = (dx * d2y - dy * d2x) / cross;
  const u = (dx * d1y - dy * d1x) / cross;
  
  // Check if intersection is within both segments
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return {
      x: p1.x + t * d1x,
      y: p1.y + t * d1y
    };
  }
  
  return null;
}

// Close gaps by detecting where paths are close and applying U/N shapes
function closeGapsWithShapes(points: Point[], gapThreshold: number): Point[] {
  if (points.length < 20) return points;
  
  const n = points.length;
  const result: Point[] = [];
  const processed = new Set<number>();
  
  // OPTIMIZATION: Use larger stride for faster processing
  const stride = n > 2000 ? 8 : n > 1000 ? 5 : n > 500 ? 3 : 2;
  
  // Calculate centroid using sampled points for speed
  let centroidX = 0, centroidY = 0;
  let sampleCount = 0;
  for (let i = 0; i < n; i += stride) {
    centroidX += points[i].x;
    centroidY += points[i].y;
    sampleCount++;
  }
  centroidX /= sampleCount;
  centroidY /= sampleCount;
  
  // Calculate average distance from centroid using sampled points
  let totalDist = 0;
  for (let i = 0; i < n; i += stride) {
    totalDist += Math.sqrt((points[i].x - centroidX) ** 2 + (points[i].y - centroidY) ** 2);
  }
  const avgDistFromCentroid = totalDist / sampleCount;
  
  // Find all gap locations where path points are within threshold but far apart in path order
  const gaps: Array<{i: number, j: number, dist: number}> = [];
  
  // Limit how much of path we can skip to avoid deleting entire outline
  const maxSkipPoints = Math.floor(n * 0.20); // Max 20% of path per gap (reduced from 25%)
  const minSkipPoints = Math.max(15, Math.floor(n / 50)); // Scale minimum with path size
  
  const thresholdSq = gapThreshold * gapThreshold;
  
  // OPTIMIZATION: Limit max gaps to prevent excessive processing
  const maxGaps = 20;
  
  for (let i = 0; i < n && gaps.length < maxGaps; i += stride) {
    const pi = points[i];
    
    // Search ahead but limit to maxSkipPoints to avoid false gaps
    const maxSearch = Math.min(n - 5, i + maxSkipPoints);
    // Use larger inner stride for faster search
    const innerStride = stride * 2;
    for (let j = i + minSkipPoints; j < maxSearch; j += innerStride) {
      const pj = points[j];
      const distSq = (pi.x - pj.x) ** 2 + (pi.y - pj.y) ** 2;
      
      if (distSq < thresholdSq) {
        // Quick check if this is a narrow passage (close) vs a protrusion (keep)
        const dist = Math.sqrt(distSq);
        const dx = pj.x - pi.x;
        const dy = pj.y - pi.y;
        const lineLen = dist;
        
        // Sample only ~10 points for speed
        let maxPerpDist = 0;
        const sampleStride = Math.max(1, Math.floor((j - i) / 10));
        for (let k = i + sampleStride; k < j; k += sampleStride) {
          const pk = points[k];
          const perpDist = Math.abs((pk.x - pi.x) * dy - (pk.y - pi.y) * dx) / (lineLen || 1);
          maxPerpDist = Math.max(maxPerpDist, perpDist);
        }
        
        // If path extends more than 3x the gap distance, it's a protrusion - don't close
        if (maxPerpDist > dist * 3) {
          continue;
        }
        
        gaps.push({i, j, dist});
        break;
      }
    }
  }
  
  console.log('[closeGapsWithShapes] Scanned', n, 'points, stride:', stride, ', threshold:', gapThreshold.toFixed(0), 'px, gaps:', gaps.length);
  
  if (gaps.length === 0) {
    console.log('[closeGapsWithShapes] No gaps found');
    return points;
  }
  
  console.log('[closeGapsWithShapes] Found', gaps.length, 'potential gaps');
  
  // Classify gaps into two categories:
  // 1. Inward gaps (original detection) - these point toward the centroid and get priority
  // 2. Geometry gaps (new detection) - J-shaped, hooks, etc. that don't point inward
  const inwardGaps: Array<{i: number, j: number, dist: number, priority: number}> = [];
  const geometryGaps: Array<{i: number, j: number, dist: number, priority: number}> = [];
  
  for (const gap of gaps) {
    // Calculate average distance of the gap section from centroid
    let gapSectionDist = 0;
    let gapSectionCount = 0;
    const sampleStride = Math.max(1, Math.floor((gap.j - gap.i) / 10));
    for (let k = gap.i; k <= gap.j; k += sampleStride) {
      const pk = points[k];
      gapSectionDist += Math.sqrt((pk.x - centroidX) ** 2 + (pk.y - centroidY) ** 2);
      gapSectionCount++;
    }
    const avgGapDist = gapSectionDist / gapSectionCount;
    
    // Inward gap: section average is LESS than shape average (dips toward center)
    if (avgGapDist < avgDistFromCentroid * 0.95) {
      inwardGaps.push({...gap, priority: 1}); // High priority
      console.log('[closeGapsWithShapes] Inward gap at', gap.i, '-', gap.j);
    } else {
      geometryGaps.push({...gap, priority: 2}); // Lower priority
      console.log('[closeGapsWithShapes] Geometry gap at', gap.i, '-', gap.j);
    }
  }
  
  // Filter geometry gaps to exclude any that overlap with inward gaps
  // This ensures inward detection behavior stays exactly as before
  const nonOverlappingGeometryGaps = geometryGaps.filter(geoGap => {
    for (const inwardGap of inwardGaps) {
      // Check if ranges overlap: geoGap[i,j] overlaps with inwardGap[i,j]
      const overlapStart = Math.max(geoGap.i, inwardGap.i);
      const overlapEnd = Math.min(geoGap.j, inwardGap.j);
      if (overlapStart < overlapEnd) {
        return false; // Overlaps with an inward gap, exclude it
      }
    }
    return true; // No overlap, keep it
  });
  
  // Combine: inward gaps (original behavior) + non-overlapping geometry gaps
  const exteriorGaps = [...inwardGaps, ...nonOverlappingGeometryGaps];
  
  console.log('[closeGapsWithShapes] Inward gaps:', inwardGaps.length, 'Non-overlapping geometry gaps:', nonOverlappingGeometryGaps.length);
  
  if (exteriorGaps.length === 0) {
    console.log('[closeGapsWithShapes] No gaps to close');
    return points;
  }
  
  // For each gap, find the NARROWEST point (peak-to-peak) and bridge there
  // This preserves both sides of the gap instead of cutting one off
  
  // Sort gaps by path position
  const sortedGaps = [...exteriorGaps].sort((a, b) => a.i - b.i);
  
  // Find the actual narrowest point for each gap
  const refinedGaps: Array<{i: number, j: number, dist: number}> = [];
  for (const gap of sortedGaps) {
    let minDist = gap.dist;
    let bestI = gap.i;
    let bestJ = gap.j;
    
    // Search around the initial gap points to find the true narrowest crossing
    const searchRange = Math.min(20, Math.floor((gap.j - gap.i) / 4));
    for (let di = -searchRange; di <= searchRange; di++) {
      const testI = gap.i + di;
      if (testI < 0 || testI >= n) continue;
      
      for (let dj = -searchRange; dj <= searchRange; dj++) {
        const testJ = gap.j + dj;
        if (testJ < 0 || testJ >= n || testJ <= testI + 10) continue;
        
        const pi = points[testI];
        const pj = points[testJ];
        const dist = Math.sqrt((pi.x - pj.x) ** 2 + (pi.y - pj.y) ** 2);
        
        if (dist < minDist) {
          minDist = dist;
          bestI = testI;
          bestJ = testJ;
        }
      }
    }
    
    refinedGaps.push({i: bestI, j: bestJ, dist: minDist});
  }
  
  // Process path, bridging at the narrowest point of each gap
  let currentIdx = 0;
  
  for (const gap of refinedGaps) {
    // Skip overlapping gaps
    if (gap.i < currentIdx) continue;
    
    // Add points before the gap bridge point
    for (let k = currentIdx; k <= gap.i; k++) {
      if (!processed.has(k)) {
        result.push(points[k]);
        processed.add(k);
      }
    }
    
    // Create a minimal bridge at the narrowest point
    const p1 = points[gap.i];
    const p2 = points[gap.j];
    const gapDist = gap.dist;
    
    if (gapDist > 0.5) {
      // Add just 3 points for a small smooth bridge (minimal distortion)
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      result.push({ x: midX, y: midY });
    }
    
    // For exterior caves (already filtered above), ALWAYS delete the cave interior
    // Skip all points between i and j (the "top of the P" / cave interior)
    for (let k = gap.i + 1; k < gap.j; k++) {
      processed.add(k);
    }
    
    currentIdx = gap.j;
  }
  
  // Add remaining points
  for (let k = currentIdx; k < n; k++) {
    if (!processed.has(k)) {
      result.push(points[k]);
    }
  }
  
  // Apply smoothing pass to eliminate wave artifacts from gap closing
  // This is especially important for medium/small offsets
  if (result.length >= 10 && refinedGaps.length > 0) {
    return smoothBridgeAreas(result);
  }
  
  return result.length >= 3 ? result : points;
}

// Smooth the path to eliminate wave artifacts, especially around bridge areas
function smoothBridgeAreas(points: Point[]): Point[] {
  if (points.length < 10) return points;
  
  const n = points.length;
  const result: Point[] = [];
  
  // Apply 3-point weighted average smoothing (preserves shape while reducing waves)
  for (let i = 0; i < n; i++) {
    if (i === 0 || i === n - 1) {
      result.push(points[i]);
    } else {
      const prev = points[i - 1];
      const curr = points[i];
      const next = points[i + 1];
      
      // Check if this point creates a sharp angle (wave artifact)
      const dx1 = curr.x - prev.x;
      const dy1 = curr.y - prev.y;
      const dx2 = next.x - curr.x;
      const dy2 = next.y - curr.y;
      
      const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
      const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
      
      if (len1 > 0.1 && len2 > 0.1) {
        // Calculate angle between segments
        const dot = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
        
        // If sharp angle (less than ~120 degrees), smooth it
        if (dot < 0.5) {
          // Weighted average toward neighbors (flatten the wave)
          result.push({
            x: prev.x * 0.25 + curr.x * 0.5 + next.x * 0.25,
            y: prev.y * 0.25 + curr.y * 0.5 + next.y * 0.25
          });
        } else {
          result.push(curr);
        }
      } else {
        result.push(curr);
      }
    }
  }
  
  return result;
}

// Merge points that are very close together (indicating a near-crossing)
function mergeClosePathPoints(points: Point[]): Point[] {
  if (points.length < 6) return points;
  
  const n = points.length;
  const result: Point[] = [];
  const skipIndices = new Set<number>();
  
  // OPTIMIZATION: Use stride for large paths
  const stride = n > 1000 ? 3 : 1;
  
  for (let i = 0; i < n; i += stride) {
    if (skipIndices.has(i)) continue;
    
    const pi = points[i];
    
    // OPTIMIZATION: Limit search range
    const maxSearch = Math.min(n, i + 300);
    for (let j = i + 10; j < maxSearch; j += stride) {
      if (skipIndices.has(j)) continue;
      
      const pj = points[j];
      const distSq = (pi.x - pj.x) ** 2 + (pi.y - pj.y) ** 2;
      
      // Increased threshold to catch all near-crossings (10px = 100 squared)
      if (distSq < 100) {
        // Skip all points between i and j
        for (let k = i + 1; k < j; k++) {
          skipIndices.add(k);
        }
        // Add merge point
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

function removeSpikes(points: Point[], neighborDistance: number, threshold: number): Point[] {
  if (points.length < neighborDistance * 2 + 3) return points;
  
  const result: Point[] = [];
  const isSpike = new Array(points.length).fill(false);
  
  for (let i = 0; i < points.length; i++) {
    const prevIdx = (i - neighborDistance + points.length) % points.length;
    const nextIdx = (i + neighborDistance) % points.length;
    
    const prev = points[prevIdx];
    const curr = points[i];
    const next = points[nextIdx];
    
    const expectedX = (prev.x + next.x) / 2;
    const expectedY = (prev.y + next.y) / 2;
    
    const deviation = Math.sqrt((curr.x - expectedX) ** 2 + (curr.y - expectedY) ** 2);
    
    const spanDistance = Math.sqrt((next.x - prev.x) ** 2 + (next.y - prev.y) ** 2);
    
    if (spanDistance > 0 && deviation / spanDistance > threshold) {
      const v1x = curr.x - prev.x;
      const v1y = curr.y - prev.y;
      const v2x = next.x - curr.x;
      const v2y = next.y - curr.y;
      
      const dot = v1x * v2x + v1y * v2y;
      const mag1 = Math.sqrt(v1x * v1x + v1y * v1y);
      const mag2 = Math.sqrt(v2x * v2x + v2y * v2y);
      
      if (mag1 > 0 && mag2 > 0) {
        const cosAngle = dot / (mag1 * mag2);
        if (cosAngle < 0.3) {
          isSpike[i] = true;
        }
      }
    }
  }
  
  for (let i = 0; i < points.length; i++) {
    if (isSpike[i]) {
      let prevGood = i - 1;
      while (prevGood >= 0 && isSpike[(prevGood + points.length) % points.length]) {
        prevGood--;
      }
      let nextGood = i + 1;
      while (nextGood < points.length * 2 && isSpike[nextGood % points.length]) {
        nextGood++;
      }
      
      const prev = points[(prevGood + points.length) % points.length];
      const next = points[nextGood % points.length];
      
      const t = 0.5;
      result.push({
        x: prev.x + (next.x - prev.x) * t,
        y: prev.y + (next.y - prev.y) * t
      });
    } else {
      result.push(points[i]);
    }
  }
  
  return result;
}

function douglasPeucker(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;

    let maxDist = 0;
    let maxIndex = lo;
    const first = points[lo];
    const last = points[hi];

    for (let i = lo + 1; i < hi; i++) {
      const dist = perpendicularDistance(points[i], first, last);
      if (dist > maxDist) { maxDist = dist; maxIndex = i; }
    }

    if (maxDist > epsilon) {
      keep[maxIndex] = 1;
      stack.push([lo, maxIndex], [maxIndex, hi]);
    }
  }

  const result: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) result.push(points[i]);
  }
  return result;
}

function drawSmoothContour(ctx: CanvasRenderingContext2D, contour: Point[], color: string, offsetX: number, offsetY: number): void {
  if (contour.length < 3) return;

  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
  ctx.shadowBlur = 2;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 1;

  ctx.beginPath();
  
  const start = contour[0];
  ctx.moveTo(start.x + offsetX, start.y + offsetY);
  
  // Use simple lineTo to prevent bezier curves from reintroducing crossings
  for (let i = 1; i < contour.length; i++) {
    const p = contour[i];
    ctx.lineTo(p.x + offsetX, p.y + offsetY);
  }
  
  ctx.closePath();
  ctx.stroke();
  
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
}

export function getContourPath(
  image: HTMLImageElement,
  strokeSettings: StrokeSettings,
  resizeSettings: ResizeSettings
): ContourPathResult | null {
  console.log('[getContourPath] Starting - optimized with downscaling');
  
  // OPTIMIZATION: Downscale large images for faster path computation
  // Use 1200px max to balance speed and accuracy for die-cutting
  // At 1200px for a 4" sticker = 300 DPI effective resolution, sufficient for cut accuracy
  const maxProcessingPixels = 1200;
  const longestSide = Math.max(image.width, image.height);
  const scale = longestSide > maxProcessingPixels ? maxProcessingPixels / longestSide : 1;
  
  const processWidth = Math.round(image.width * scale);
  const processHeight = Math.round(image.height * scale);
  
  // Adjusted DPI for scaled image - maintains inch-based accuracy
  const scaledWidthInches = resizeSettings.widthInches;
  const effectiveDPI = processWidth / scaledWidthInches;
  
  console.log('[getContourPath] Scale:', scale.toFixed(2), 'processSize:', processWidth, 'x', processHeight, 'effectiveDPI:', effectiveDPI.toFixed(0));
  
  // Base offset keeps cutpath away from design edge - increased significantly to prevent any cutting into design
  const baseOffsetInches = 0.125; // 1/8 inch minimum margin
  const baseOffsetPixels = Math.round(baseOffsetInches * effectiveDPI);
  
  const autoBridgeInches = 0.02;
  const autoBridgePixels = Math.round(autoBridgeInches * effectiveDPI);
  
  const userOffsetPixels = Math.round(strokeSettings.width * effectiveDPI);
  const totalOffsetPixels = baseOffsetPixels + userOffsetPixels;
  
  try {
    // Create scaled canvas for faster processing
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');
    if (!tempCtx) return null;
    
    tempCanvas.width = processWidth;
    tempCanvas.height = processHeight;
    // Use high-quality interpolation for downscaling to preserve edge detail
    tempCtx.imageSmoothingEnabled = true;
    tempCtx.imageSmoothingQuality = 'high';
    tempCtx.drawImage(image, 0, 0, processWidth, processHeight);
    const imageData = tempCtx.getImageData(0, 0, processWidth, processHeight);
    const data = imageData.data;
    
    // Create silhouette mask with alpha threshold (matches worker)
    const silhouetteMask = new Uint8Array(processWidth * processHeight);
    const threshold = strokeSettings.alphaThreshold || 10;
    for (let i = 0; i < silhouetteMask.length; i++) {
      silhouetteMask[i] = data[i * 4 + 3] >= threshold ? 1 : 0;
    }
    
    if (silhouetteMask.length === 0) return null;
    
    // Auto bridge step (matches worker) - uses processWidth/Height for speed
    let autoBridgedMask = silhouetteMask;
    if (autoBridgePixels > 0) {
      const halfAutoBridge = Math.round(autoBridgePixels / 2);
      const dilatedAuto = dilateSilhouette(silhouetteMask, processWidth, processHeight, halfAutoBridge);
      const dilatedAutoWidth = processWidth + halfAutoBridge * 2;
      const dilatedAutoHeight = processHeight + halfAutoBridge * 2;
      const filledAuto = fillSilhouette(dilatedAuto, dilatedAutoWidth, dilatedAutoHeight);
      
      autoBridgedMask = new Uint8Array(processWidth * processHeight);
      for (let y = 0; y < processHeight; y++) {
        for (let x = 0; x < processWidth; x++) {
          autoBridgedMask[y * processWidth + x] = filledAuto[(y + halfAutoBridge) * dilatedAutoWidth + (x + halfAutoBridge)];
        }
      }
    }
    
    // Base dilation (matches worker - NO gap closing through mask dilation)
    const baseDilatedMask = dilateSilhouette(autoBridgedMask, processWidth, processHeight, baseOffsetPixels);
    const baseWidth = processWidth + baseOffsetPixels * 2;
    const baseHeight = processHeight + baseOffsetPixels * 2;
    
    // Fill silhouette (matches worker)
    const filledMask = fillSilhouette(baseDilatedMask, baseWidth, baseHeight);
    
    const finalDilatedMask = dilateSilhouette(filledMask, baseWidth, baseHeight, userOffsetPixels);
    const dilatedWidth = baseWidth + userOffsetPixels * 2;
    const dilatedHeight = baseHeight + userOffsetPixels * 2;
    const boundaryPath = traceBoundary(finalDilatedMask, dilatedWidth, dilatedHeight);
    
    if (boundaryPath.length < 3) return null;
    
    // Smooth path (matches worker)
    let smoothedPath = smoothPath(boundaryPath, 2);
    console.log('[getContourPath] After smooth, path points:', smoothedPath.length);
    
    // Fix crossings (matches worker)
    smoothedPath = fixOffsetCrossings(smoothedPath);
    console.log('[getContourPath] After fixOffsetCrossings, path points:', smoothedPath.length);
    
    // OPTIMIZATION: Simplify path BEFORE gap closing to reduce point count
    // This dramatically speeds up gap detection
    if (smoothedPath.length > 500) {
      const targetPoints = 400;
      const step = smoothedPath.length / targetPoints;
      const simplified: Point[] = [];
      for (let i = 0; i < targetPoints; i++) {
        simplified.push(smoothedPath[Math.floor(i * step)]);
      }
      smoothedPath = simplified;
      console.log('[getContourPath] Simplified path to', smoothedPath.length, 'points for gap closing');
    }
    
    // Apply gap closing using U/N shapes based on settings (matches worker)
    const gapThresholdPixels = strokeSettings.autoBridging 
      ? Math.round(strokeSettings.autoBridgingThreshold * effectiveDPI) 
      : 0;
    
    if (gapThresholdPixels > 0) {
      console.log('[getContourPath] Starting gap closing with threshold:', gapThresholdPixels);
      const startTime = performance.now();
      smoothedPath = closeGapsWithShapes(smoothedPath, gapThresholdPixels);
      console.log('[getContourPath] Gap closing took:', (performance.now() - startTime).toFixed(0), 'ms');
      
      // Ensure path is properly closed after gap processing
      if (smoothedPath.length > 2) {
        const first = smoothedPath[0];
        const last = smoothedPath[smoothedPath.length - 1];
        const closeDist = Math.sqrt((first.x - last.x) ** 2 + (first.y - last.y) ** 2);
        if (closeDist > 2) {
          smoothedPath.push({ x: first.x, y: first.y });
        }
      }
    }
    
    // Add bleed to dimensions so expanded background fits within page
    const bleedInches = 0.10;
    const widthInches = dilatedWidth / effectiveDPI + (bleedInches * 2);
    const heightInches = dilatedHeight / effectiveDPI + (bleedInches * 2);
    
    // Path coordinates need to be offset by bleed amount
    const pathInInches = smoothedPath.map(p => ({
      x: (p.x / effectiveDPI) + bleedInches,
      y: heightInches - ((p.y / effectiveDPI) + bleedInches)
    }));
    
    // Image offset includes bleed
    const imageOffsetX = (totalOffsetPixels / effectiveDPI) + bleedInches;
    const imageOffsetY = (totalOffsetPixels / effectiveDPI) + bleedInches;
    
    return {
      pathPoints: pathInInches,
      widthInches,
      heightInches,
      imageOffsetX,
      imageOffsetY,
      backgroundColor: strokeSettings.backgroundColor
    };
  } catch (error) {
    console.error('Error getting contour path:', error);
    return null;
  }
}

export interface CachedContourData {
  pathPoints: Array<{x: number; y: number}>;
  previewPathPoints: Array<{x: number; y: number}>;
  allPathPoints?: Array<Array<{x: number; y: number}>>;
  allPreviewPathPoints?: Array<Array<{x: number; y: number}>>;
  // Smooth-curve cut path (Zero Hero only). When present, the PDF emit path
  // prefers these over `allPathPoints` so curves render as cubic Beziers.
  allBezierPaths?: BezierPath[];
  allBezierPathsPreview?: BezierPath[];
  widthInches: number;
  heightInches: number;
  imageOffsetX: number;
  imageOffsetY: number;
  backgroundColor: string;
  effectiveDPI: number;
  minPathX: number;
  minPathY: number;
  bleedInches: number;
  holePathStartIndex?: number;
}

export interface SpotColorInput {
  hex: string;
  rgb: { r: number; g: number; b: number };
  spotWhite: boolean;
  spotGloss: boolean;
  spotWhiteName?: string;
  spotGlossName?: string;
  spotFluorY: boolean;
  spotFluorM: boolean;
  spotFluorG: boolean;
  spotFluorOrange: boolean;
  spotFluorYName?: string;
  spotFluorMName?: string;
  spotFluorGName?: string;
  spotFluorOrangeName?: string;
  regions?: Array<{ id: number; spotWhite?: boolean; spotGloss?: boolean; selected: boolean }>;
  regionMap?: Int32Array;
}

export interface QRExportOptions {
  qrCodes?: import('./qr').DetectedQR[];
  /**
   * Opt-IN flag for the crisp QR re-render pass. Default false (= leave
   * the source QR pixels as-is). The user enables this from the QR
   * badge in the image editor when they want crisp vector modules in
   * the exported PDF.
   */
  enabled?: boolean;
}

export async function downloadContourPDF(
  image: HTMLImageElement,
  strokeSettings: StrokeSettings,
  resizeSettings: ResizeSettings,
  filename: string,
  cachedContourData?: CachedContourData,
  spotColors?: SpotColorInput[],
  singleArtboard: boolean = false,
  cutContourLabel: string = 'CutContour',
  lockedContour?: { label: string; pathPoints: Array<{x: number; y: number}>; allPathPoints?: Array<Array<{x: number; y: number}>>; widthInches: number; heightInches: number } | null,
  qrOptions?: QRExportOptions,
  spotPixelMap?: SpotPixelMapData
): Promise<void> {
  try {
    console.log('[downloadContourPDF] Starting, cached:', !!cachedContourData);
    const startTime = performance.now();
    
    // Small delay to allow loading indicator to render
    await new Promise(resolve => setTimeout(resolve, 50));
    
    let pathPoints: Array<{x: number; y: number}>;
    let previewPathPoints: Array<{x: number; y: number}>;
    let allPathPoints: Array<Array<{x: number; y: number}>> | undefined;
    let allBezierPaths: BezierPath[] | undefined;
    let widthInches: number;
    let heightInches: number;
    let imageOffsetX: number;
    let imageOffsetY: number;
    let backgroundColor: string;
    let effectiveDPI: number;
    let minPathX: number;
    let minPathY: number;
    let bleedInches: number;
    let holePathStartIndex: number | undefined;
    {
      const workerManager = getContourWorkerManager();
      const contourData = workerManager.getCachedContourData();
      if (contourData) {
        console.log('[downloadContourPDF] Using cached preview contour data (instant)');
        pathPoints = contourData.pathPoints;
        previewPathPoints = contourData.previewPathPoints;
        allPathPoints = contourData.allPathPoints;
        allBezierPaths = contourData.allBezierPaths;
        widthInches = contourData.widthInches;
        heightInches = contourData.heightInches;
        imageOffsetX = contourData.imageOffsetX;
        imageOffsetY = contourData.imageOffsetY;
        backgroundColor = contourData.backgroundColor;
        effectiveDPI = contourData.effectiveDPI;
        minPathX = contourData.minPathX;
        minPathY = contourData.minPathY;
        bleedInches = contourData.bleedInches;
        holePathStartIndex = contourData.holePathStartIndex;
      } else {
        console.error('[downloadContourPDF] No contour data available - generate preview first');
        return;
      }
    }
    
    console.log('[downloadContourPDF] Contour data ready in', (performance.now() - startTime).toFixed(0), 'ms');
    console.log('[downloadContourPDF] Page:', widthInches.toFixed(3), 'x', heightInches.toFixed(3), 'in, DPI:', effectiveDPI, ', pathPts:', pathPoints.length, ', bleed:', bleedInches);
    console.log('[downloadContourPDF] Image offset:', imageOffsetX.toFixed(3), imageOffsetY.toFixed(3), 'in');

    const widthPts = widthInches * 72;
    const heightPts = heightInches * 72;
    
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([widthPts, heightPts]);
    
    // OPTIMIZATION: Create background and design canvases in parallel
    // Background uses lower DPI (150) since it's solid color - doesn't need 300 DPI
    const bgDPI = 150;
    const bgBleedInches = 0.10;
    const bleedPixels = bgBleedInches * bgDPI;
    const fillColor = backgroundColor || '#ffffff';
    const drawPaths = allPathPoints && allPathPoints.length > 0 ? allPathPoints : [pathPoints];
    
    // Create background canvas (lower DPI for speed)
    const createBackgroundBlob = (): Promise<Blob> => {
      return new Promise((resolve, reject) => {
        const bgCanvas = document.createElement('canvas');
        const bgCtx = bgCanvas.getContext('2d');
        if (!bgCtx) {
          reject(new Error('Failed to get background canvas context'));
          return;
        }
        
        bgCanvas.width = Math.round(widthInches * bgDPI);
        bgCanvas.height = Math.round(heightInches * bgDPI);
        
        bgCtx.fillStyle = fillColor;
        bgCtx.strokeStyle = fillColor;
        bgCtx.lineWidth = bleedPixels * 2;
        bgCtx.lineJoin = 'round';
        bgCtx.lineCap = 'round';

        const outerPaths = holePathStartIndex != null
          ? drawPaths.slice(0, holePathStartIndex)
          : drawPaths;
        const holePaths = holePathStartIndex != null
          ? drawPaths.slice(holePathStartIndex)
          : [];
        
        for (const drawPath of outerPaths) {
          if (drawPath.length > 0) {
            bgCtx.beginPath();
            bgCtx.moveTo(drawPath[0].x * bgDPI, drawPath[0].y * bgDPI);
            for (let i = 1; i < drawPath.length; i++) {
              bgCtx.lineTo(drawPath[i].x * bgDPI, drawPath[i].y * bgDPI);
            }
            bgCtx.closePath();
            bgCtx.stroke();
            bgCtx.fill();
          }
        }

        if (holePaths.length > 0) {
          bgCtx.globalCompositeOperation = 'destination-out';
          bgCtx.fillStyle = 'rgba(0,0,0,1)';
          for (const hp of holePaths) {
            if (hp.length > 0) {
              bgCtx.beginPath();
              bgCtx.moveTo(hp[0].x * bgDPI, hp[0].y * bgDPI);
              for (let i = 1; i < hp.length; i++) {
                bgCtx.lineTo(hp[i].x * bgDPI, hp[i].y * bgDPI);
              }
              bgCtx.closePath();
              bgCtx.fill();
            }
          }
          bgCtx.globalCompositeOperation = 'source-over';
        }
        
        // Flip for PDF coordinate system
        const flippedBgCanvas = document.createElement('canvas');
        flippedBgCanvas.width = bgCanvas.width;
        flippedBgCanvas.height = bgCanvas.height;
        const flippedBgCtx = flippedBgCanvas.getContext('2d');
        if (flippedBgCtx) {
          flippedBgCtx.translate(0, bgCanvas.height);
          flippedBgCtx.scale(1, -1);
          flippedBgCtx.drawImage(bgCanvas, 0, 0);
        }
        
        // Use PNG for better quality backgrounds
        flippedBgCanvas.toBlob((b) => {
          if (b) resolve(b);
          else reject(new Error('Failed to create blob from canvas'));
        }, 'image/png');
      });
    };
    
    // Create design canvas. The PDF reader/printer rasterises this PNG to
    // the page's physical pixel size, so it acts as input to their resampler.
    //
    // For QR regions, we no longer mask the raster — the vector overlay
    // (`drawVectorQRsOnPage` after `page.drawImage`) draws each module
    // (light or dark) as a filled shape that overdraws the underlying
    // pixels module-by-module. Modules in a detected logo region are
    // skipped, which is the whole point of *not* pre-masking — the
    // source's logo art passes through to the output instead of getting
    // wiped to white.
    //
    // QR re-render is opt-in. When disabled we just embed the source as
    // a plain raster — no QR processing of any kind, the user's
    // original QR pixels print exactly as they look in the design.
    const useQRFix = qrOptions?.enabled === true && qrOptions?.qrCodes && qrOptions.qrCodes.length > 0;
    const createDesignBlob = async (): Promise<Blob> => {
      let canvas: HTMLCanvasElement;
      {
        // Default path: embed the design as-is. The vector QR overlay
        // module-overdraws each cell (or skips for logo modules).
        canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const tempCtx = canvas.getContext('2d');
        if (!tempCtx) throw new Error('Failed to get design canvas context');
        tempCtx.drawImage(image, 0, 0);
      }
      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => {
          if (b) resolve(b);
          else reject(new Error('Failed to create blob from design canvas'));
        }, 'image/png');
      });
    };
    
    // Run both canvas operations in parallel
    const [bgBlob, designBlob] = await Promise.all([
      createBackgroundBlob(),
      createDesignBlob()
    ]);
    
    // Convert blobs to bytes in parallel
    const [bgPngBytes, pngBytes] = await Promise.all([
      bgBlob.arrayBuffer().then(buf => new Uint8Array(buf)),
      designBlob.arrayBuffer().then(buf => new Uint8Array(buf))
    ]);
    
    // Embed images in PDF as PNG for better quality
    const bgPngImage = await pdfDoc.embedPng(bgPngBytes);
    
    // (The background raster is no longer drawn directly on the page — it is
    // drawn inside the group Form XObject below so the bleed backing, artwork,
    // and cut line all import as ONE selectable Illustrator group.)
  
  const pngImage = await pdfDoc.embedPng(pngBytes);

  // Compute the image size as the contour pipeline sees it.
  // effectiveDPI = min(dpiFromWidth, dpiFromHeight); when the image's natural AR
  // differs from the resize settings AR, one axis will have a larger effective
  // size than resizeSettings specifies. We must draw the image at that size so
  // the contour and image stay aligned.
  const natAR = image.naturalWidth / image.naturalHeight;
  const resAR = resizeSettings.widthInches / resizeSettings.heightInches;
  let contourImageW: number, contourImageH: number;
  if (natAR <= resAR) {
    contourImageW = resizeSettings.widthInches;
    contourImageH = resizeSettings.widthInches / natAR;
  } else {
    contourImageH = resizeSettings.heightInches;
    contourImageW = resizeSettings.heightInches * natAR;
  }

  const imageXPts = imageOffsetX * 72;
  const imageWidthPts = contourImageW * 72;
  const imageHeightPts = contourImageH * 72;
  const imageYPts = heightPts - (imageOffsetY * 72) - imageHeightPts;
  
  // ── Group bleed backing + design image + cut contour(s) into ONE group ──
  // Everything visual is accumulated into a single PDF Form XObject. Adobe
  // Illustrator imports a Form XObject as a Group, so the artwork and the
  // CutContour cut line(s) import selected/moved together. Spot-color
  // white/gloss separations are still added separately afterwards (they are
  // production layers, not part of the art group).
  const context = pdfDoc.context;

  let groupContent = '';
  const groupXObjects: Record<string, PDFRef> = {};
  const groupColorSpaces: Record<string, PDFRef> = {};

  // Bleed background (full page), drawn first so it sits behind the art.
  const bgImgName = 'ImBg';
  groupXObjects[bgImgName] = bgPngImage.ref;
  groupContent +=
    `q\n${widthPts.toFixed(4)} 0 0 ${heightPts.toFixed(4)} 0 0 cm\n/${bgImgName} Do\nQ\n`;

  // Design raster. Matches pdf-lib's drawImage transform:
  //   `width 0 0 height x y cm  /Name Do`.
  const designImgName = 'ImDesign';
  groupXObjects[designImgName] = pngImage.ref;
  groupContent +=
    `q\n${imageWidthPts.toFixed(4)} 0 0 ${imageHeightPts.toFixed(4)} ` +
    `${imageXPts.toFixed(4)} ${imageYPts.toFixed(4)} cm\n/${designImgName} Do\nQ\n`;
  
  if (pathPoints.length > 2) {
    
    const tintFunction = context.obj({
      FunctionType: 2,
      Domain: [0, 1],
      C0: [0, 0, 0, 0],
      C1: [0, 1, 0, 0],
      N: 1,
    });
    const tintFunctionRef = context.register(tintFunction);
    
    const separationColorSpace = context.obj([
      PDFName.of('Separation'),
      PDFName.of(cutContourLabel),
      PDFName.of('DeviceCMYK'),
      tintFunctionRef,
    ]);
    const separationRef = context.register(separationColorSpace);
    groupColorSpaces[cutContourLabel] = separationRef;
    
    // Generate CutContour path operations — multiple paths for zero hero mode.
    // For Zero Hero (strokeSettings.width === 0) the contour is already a
    // sub-pixel-precise, smoothed polyline; bypass the Catmull-Rom spline pass
    // so the PDF cut path matches what the user sees in the preview.
    //
    // PREFERRED Zero Hero emit path: if the worker produced a Bezier
    // reconstruction (`allBezierPaths`), emit those directly as `c` operators.
    // This gives true smooth curves on arcs/circles instead of the polygonal
    // chord look that any polyline emit produces, while still matching the
    // preview pixel-for-pixel (the preview rasterizes the SAME source
    // polyline that we fit Beziers to). Falls back to the polyline emit if
    // bezier data isn't available (older cache, geometric shape, normal mode).
    const isZeroHeroExport = strokeSettings.width === 0;
    let combinedPathOps = '';
    let emitMode: 'bezier' | 'polyline' = 'polyline';
    if (isZeroHeroExport && allBezierPaths && allBezierPaths.length > 0) {
      emitMode = 'bezier';
      for (const bp of allBezierPaths) {
        combinedPathOps += bezierPathToPDFPathOps(bp, heightInches, cutContourLabel);
      }
      console.log('[downloadContourPDF] Emitting', allBezierPaths.length, 'CutContour path(s) (Zero Hero, bezier reconstruction)');
    } else {
      const pathsToEmit = allPathPoints && allPathPoints.length > 0 ? allPathPoints : [pathPoints];
      for (const singlePath of pathsToEmit) {
        combinedPathOps += contourPointsToPDFPathOps(singlePath, heightInches, cutContourLabel, isZeroHeroExport);
      }
      console.log('[downloadContourPDF] Emitting', pathsToEmit.length, 'CutContour path(s)', isZeroHeroExport ? '(Zero Hero, polyline fallback)' : '');
    }
    void emitMode;

    groupContent += combinedPathOps;
  }
  
  if (lockedContour && lockedContour.pathPoints.length > 2) {
    if (!groupColorSpaces[lockedContour.label]) {
      const lockedTintFunction = context.obj({
        FunctionType: 2,
        Domain: [0, 1],
        C0: [0, 0, 0, 0],
        C1: [0, 1, 0, 0],
        N: 1,
      });
      const lockedTintRef = context.register(lockedTintFunction);
      
      const lockedSepCS = context.obj([
        PDFName.of('Separation'),
        PDFName.of(lockedContour.label),
        PDFName.of('DeviceCMYK'),
        lockedTintRef,
      ]);
      groupColorSpaces[lockedContour.label] = context.register(lockedSepCS);
    }
    
    const lockedPathsToEmit = lockedContour.allPathPoints && lockedContour.allPathPoints.length > 0
      ? lockedContour.allPathPoints : [lockedContour.pathPoints];
    let lockedPathOps = '';
    for (const lp of lockedPathsToEmit) {
      lockedPathOps += contourPointsToPDFPathOps(lp, heightInches, lockedContour.label);
    }
    groupContent += lockedPathOps;
  }

  // ── Wrap everything accumulated into a single Form XObject, draw it once ──
  // The Form XObject imports into Illustrator as one selectable group holding
  // the bleed backing, the design raster, and the cut contour(s).
  {
    let pageResources = page.node.Resources();
    if (!pageResources) {
      pageResources = context.obj({}) as PDFDict;
      page.node.set(PDFName.of('Resources'), pageResources);
    }

    const formResources = context.obj({
      XObject: groupXObjects,
      ColorSpace: groupColorSpaces,
    });
    const formXObject = context.stream(groupContent, {
      Type: PDFName.of('XObject'),
      Subtype: PDFName.of('Form'),
      FormType: 1,
      BBox: context.obj([0, 0, widthPts, heightPts]),
      Resources: formResources,
    });
    const formRef = context.register(formXObject);

    let xobjDict = pageResources.lookup(PDFName.of('XObject'), PDFDict) as PDFDict | undefined;
    if (!xobjDict) {
      xobjDict = context.obj({}) as PDFDict;
      pageResources.set(PDFName.of('XObject'), xobjDict);
    }
    xobjDict.set(PDFName.of('ArtCutGroup'), formRef);

    const drawFormStream = context.stream('q\n/ArtCutGroup Do\nQ\n');
    const drawFormRef = context.register(drawFormStream);
    const existingContents = page.node.Contents();
    if (existingContents instanceof PDFArray) {
      existingContents.push(drawFormRef);
    } else if (existingContents) {
      page.node.set(PDFName.of('Contents'), context.obj([existingContents, drawFormRef]));
    } else {
      page.node.set(PDFName.of('Contents'), context.obj([drawFormRef]));
    }
  }

  // Vector QR overlay — drawn on the page ABOVE the group so crisp QR modules
  // sit on top of the design raster. (Same behaviour as before; ordered after
  // the group so the z-order is preserved.)
  if (useQRFix) {
    const result = drawVectorQRsOnPage(
      page,
      qrOptions!.qrCodes,
      { x: imageXPts, y: imageYPts, width: imageWidthPts, height: imageHeightPts },
      image.naturalWidth || image.width,
      image.naturalHeight || image.height,
      image,
      { errorCorrectionLevel: 'H' }
    );
    const styleSummary = result.appearances
      .map((a) => `${a.shape}${a.logo ? '+logo-preserved' : ''}`)
      .join(', ');
    console.log(
      `[downloadContourPDF] Vector QR overlay: drew ${result.drawn} crisp QR(s) [${styleSummary}]` +
        (result.skipped > 0 ? `, skipped ${result.skipped} (rotation/aspect/encoding)` : '')
    );
  }
  
  if (spotColors && spotColors.length > 0) {
    const spotLabels = await addSpotColorVectorsToPDF(
      pdfDoc, page, image, spotColors,
      resizeSettings.widthInches, resizeSettings.heightInches,
      heightInches, imageOffsetX, imageOffsetY,
      singleArtboard, widthPts, heightPts, spotPixelMap
    );
    console.log('[downloadContourPDF] Added spot color vector layers:', spotLabels);
  }
  
  const whiteName = spotColors?.find(c => c.spotWhite)?.spotWhiteName || 'RDG_WHITE';
  const glossName = spotColors?.find(c => c.spotGloss)?.spotGlossName || 'RDG_GLOSS';
  
  pdfDoc.setTitle('Sticker with CutContour and Spot Colors');
  pdfDoc.setSubject(singleArtboard 
    ? `Single artboard with Design + CutContour + ${whiteName} + ${glossName}`
    : `Page 1: Raster + CutContour, Page 2: ${whiteName}, Page 3: ${glossName}`);
  pdfDoc.setKeywords(['CutContour', 'spot color', 'cutting', 'vector', whiteName, glossName]);
  
  const pdfBytes = await pdfDoc.save();
  const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(pdfBlob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  } catch (error) {
    console.error('[downloadContourPDF] Error:', error);
    throw error;
  }
}

export async function downloadDesignOnlyPDF(
  image: HTMLImageElement,
  resizeSettings: ResizeSettings,
  filename: string,
  spotColors?: SpotColorInput[],
  singleArtboard: boolean = false,
  qrOptions?: QRExportOptions,
  spotPixelMap?: SpotPixelMapData
): Promise<void> {
  try {
    console.log('[downloadDesignOnlyPDF] Starting design-only PDF (no cut lines)');
    await new Promise(resolve => setTimeout(resolve, 50));

    const widthInches = resizeSettings.widthInches;
    const heightInches = resizeSettings.heightInches;
    const widthPts = widthInches * 72;
    const heightPts = heightInches * 72;

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([widthPts, heightPts]);

    const useQRFix = qrOptions?.enabled === true && qrOptions?.qrCodes && qrOptions.qrCodes.length > 0;
    // QR re-render is opt-in. When NOT enabled, we just embed the source
    // as a plain raster (no QR processing). When enabled, the source is
    // still embedded as-is and the vector QR overdraw
    // (`drawVectorQRsOnPage` after embedding) handles crispness and the
    // logo carve-out.
    const designCanvas: HTMLCanvasElement = (() => {
      const c = document.createElement('canvas');
      c.width = image.width;
      c.height = image.height;
      const cx = c.getContext('2d');
      if (!cx) throw new Error('Failed to get canvas context');
      cx.drawImage(image, 0, 0);
      return c;
    })();
    const designBlob: Blob = await new Promise((resolve, reject) => {
      designCanvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error('Failed to create blob'));
      }, 'image/png');
    });

    const pngBytes = new Uint8Array(await designBlob.arrayBuffer());
    const pngImage = await pdfDoc.embedPng(pngBytes);

    page.drawImage(pngImage, {
      x: 0,
      y: 0,
      width: widthPts,
      height: heightPts,
    });

    if (useQRFix) {
      const result = drawVectorQRsOnPage(
        page,
        qrOptions!.qrCodes,
        { x: 0, y: 0, width: widthPts, height: heightPts },
        image.naturalWidth || image.width,
        image.naturalHeight || image.height,
        image,
        { errorCorrectionLevel: 'H' }
      );
      const styleSummary = result.appearances
        .map((a) => `${a.shape}${a.logo ? '+logo-preserved' : ''}`)
        .join(', ');
      console.log(
        `[downloadDesignOnlyPDF] Vector QR overlay: drew ${result.drawn} crisp QR(s) [${styleSummary}]` +
          (result.skipped > 0 ? `, skipped ${result.skipped} (rotation/aspect/encoding)` : '')
      );
    }

    if (spotColors && spotColors.length > 0) {
      const spotLabels = await addSpotColorVectorsToPDF(
        pdfDoc, page, image, spotColors,
        widthInches, heightInches,
        heightInches, 0, 0,
        singleArtboard, widthPts, heightPts, spotPixelMap
      );
      console.log('[downloadDesignOnlyPDF] Added spot color vector layers:', spotLabels);
    }

    pdfDoc.setTitle('Design with Spot Colors');
    pdfDoc.setSubject('Design PDF without cut lines');

    const pdfBytes = await pdfDoc.save();
    const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(pdfBlob);

    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('[downloadDesignOnlyPDF] Error:', error);
    throw error;
  }
}

export async function generateContourPDFBase64(
  image: HTMLImageElement,
  strokeSettings: StrokeSettings,
  resizeSettings: ResizeSettings,
  cachedContourData?: CachedContourData,
  cutContourLabel: string = 'CutContour'
): Promise<string | null> {
  let pathPoints: Array<{x: number; y: number}>;
  let previewPathPoints: Array<{x: number; y: number}>;
  let allPathPoints: Array<Array<{x: number; y: number}>> | undefined;
  let allBezierPaths: BezierPath[] | undefined;
  let widthInches: number;
  let heightInches: number;
  let imageOffsetX: number;
  let imageOffsetY: number;
  let backgroundColor: string;
  let effectiveDPI: number;
  let minPathX: number;
  let minPathY: number;
  let bleedInches: number;
  let holePathStartIndex: number | undefined;
  if (cachedContourData && cachedContourData.pathPoints.length > 0) {
    console.log('[generateContourPDFBase64] Using cached contour data for fast export');
    pathPoints = cachedContourData.pathPoints;
    previewPathPoints = cachedContourData.previewPathPoints;
    allPathPoints = cachedContourData.allPathPoints;
    allBezierPaths = cachedContourData.allBezierPaths;
    widthInches = cachedContourData.widthInches;
    heightInches = cachedContourData.heightInches;
    imageOffsetX = cachedContourData.imageOffsetX;
    imageOffsetY = cachedContourData.imageOffsetY;
    backgroundColor = cachedContourData.backgroundColor;
    effectiveDPI = cachedContourData.effectiveDPI;
    minPathX = cachedContourData.minPathX;
    minPathY = cachedContourData.minPathY;
    bleedInches = cachedContourData.bleedInches;
    holePathStartIndex = cachedContourData.holePathStartIndex;
  } else {
    const workerManager = getContourWorkerManager();
    const contourData = workerManager.getCachedContourData();
    if (contourData) {
      pathPoints = contourData.pathPoints;
      previewPathPoints = contourData.previewPathPoints;
      allPathPoints = contourData.allPathPoints;
      allBezierPaths = contourData.allBezierPaths;
      widthInches = contourData.widthInches;
      heightInches = contourData.heightInches;
      imageOffsetX = contourData.imageOffsetX;
      imageOffsetY = contourData.imageOffsetY;
      backgroundColor = contourData.backgroundColor;
      effectiveDPI = contourData.effectiveDPI;
      minPathX = contourData.minPathX;
      minPathY = contourData.minPathY;
      bleedInches = contourData.bleedInches;
      holePathStartIndex = contourData.holePathStartIndex;
    } else {
      console.error('[generateContourPDFBase64] No contour data available - generate preview first');
      return null;
    }
  }
  
  const widthPts = widthInches * 72;
  const heightPts = heightInches * 72;
  
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([widthPts, heightPts]);
  
  // OPTIMIZATION: Create background and design canvases in parallel
  // Background uses lower DPI (150) since it's solid color - doesn't need 300 DPI
  const bgDPI = 150;
  const bgBleedInches = 0.10;
  const bleedPixels = bgBleedInches * bgDPI;
  const fillColor = backgroundColor || '#ffffff';
  const drawPaths2 = allPathPoints && allPathPoints.length > 0 ? allPathPoints : [pathPoints];
  
  // Create background canvas (lower DPI for speed)
  const createBackgroundBlob = (): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const bgCanvas = document.createElement('canvas');
      const bgCtx = bgCanvas.getContext('2d');
      if (!bgCtx) {
        reject(new Error('Failed to get background canvas context'));
        return;
      }
      
      bgCanvas.width = Math.round(widthInches * bgDPI);
      bgCanvas.height = Math.round(heightInches * bgDPI);
      
      bgCtx.fillStyle = fillColor;
      bgCtx.strokeStyle = fillColor;
      bgCtx.lineWidth = bleedPixels * 2;
      bgCtx.lineJoin = 'round';
      bgCtx.lineCap = 'round';

      const outerPaths2 = holePathStartIndex != null
        ? drawPaths2.slice(0, holePathStartIndex)
        : drawPaths2;
      const holePaths2 = holePathStartIndex != null
        ? drawPaths2.slice(holePathStartIndex)
        : [];
      
      for (const drawPath of outerPaths2) {
        if (drawPath.length > 0) {
          bgCtx.beginPath();
          bgCtx.moveTo(drawPath[0].x * bgDPI, drawPath[0].y * bgDPI);
          for (let i = 1; i < drawPath.length; i++) {
            bgCtx.lineTo(drawPath[i].x * bgDPI, drawPath[i].y * bgDPI);
          }
          bgCtx.closePath();
          bgCtx.stroke();
          bgCtx.fill();
        }
      }

      if (holePaths2.length > 0) {
        bgCtx.globalCompositeOperation = 'destination-out';
        bgCtx.fillStyle = 'rgba(0,0,0,1)';
        for (const hp of holePaths2) {
          if (hp.length > 0) {
            bgCtx.beginPath();
            bgCtx.moveTo(hp[0].x * bgDPI, hp[0].y * bgDPI);
            for (let i = 1; i < hp.length; i++) {
              bgCtx.lineTo(hp[i].x * bgDPI, hp[i].y * bgDPI);
            }
            bgCtx.closePath();
            bgCtx.fill();
          }
        }
        bgCtx.globalCompositeOperation = 'source-over';
      }
      
      // Flip for PDF coordinate system
      const flippedBgCanvas = document.createElement('canvas');
      flippedBgCanvas.width = bgCanvas.width;
      flippedBgCanvas.height = bgCanvas.height;
      const flippedBgCtx = flippedBgCanvas.getContext('2d');
      if (flippedBgCtx) {
        flippedBgCtx.translate(0, bgCanvas.height);
        flippedBgCtx.scale(1, -1);
        flippedBgCtx.drawImage(bgCanvas, 0, 0);
      }
      
      // Use PNG for better quality backgrounds
      flippedBgCanvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error('Failed to create blob from canvas'));
      }, 'image/png');
    });
  };
  
  // Create design canvas
  const createDesignBlob = (): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const tempCanvas = document.createElement('canvas');
      const tempCtx = tempCanvas.getContext('2d');
      if (!tempCtx) {
        reject(new Error('Failed to get design canvas context'));
        return;
      }
      
      tempCanvas.width = image.width;
      tempCanvas.height = image.height;
      tempCtx.drawImage(image, 0, 0);
      
      tempCanvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error('Failed to create blob from design canvas'));
      }, 'image/png');
    });
  };
  
  // Run both canvas operations in parallel
  const [bgBlob, designBlob] = await Promise.all([
    createBackgroundBlob(),
    createDesignBlob()
  ]);
  
  // Convert blobs to bytes in parallel
  const [bgPngBytes, pngBytes] = await Promise.all([
    bgBlob.arrayBuffer().then(buf => new Uint8Array(buf)),
    designBlob.arrayBuffer().then(buf => new Uint8Array(buf))
  ]);
  
  // Embed images in PDF as PNG for better quality
  const bgPngImage = await pdfDoc.embedPng(bgPngBytes);
  
  // Draw the background raster image first
  page.drawImage(bgPngImage, {
    x: 0,
    y: 0,
    width: widthPts,
    height: heightPts,
  });
  
  const pngImage = await pdfDoc.embedPng(pngBytes);

  const natAR2 = image.naturalWidth / image.naturalHeight;
  const resAR2 = resizeSettings.widthInches / resizeSettings.heightInches;
  let contourImageW2: number, contourImageH2: number;
  if (natAR2 <= resAR2) {
    contourImageW2 = resizeSettings.widthInches;
    contourImageH2 = resizeSettings.widthInches / natAR2;
  } else {
    contourImageH2 = resizeSettings.heightInches;
    contourImageW2 = resizeSettings.heightInches * natAR2;
  }

  const imageXPts = imageOffsetX * 72;
  const imageWidthPts = contourImageW2 * 72;
  const imageHeightPts = contourImageH2 * 72;
  const imageYPts = heightPts - (imageOffsetY * 72) - imageHeightPts;
  
  page.drawImage(pngImage, {
    x: imageXPts,
    y: imageYPts,
    width: imageWidthPts,
    height: imageHeightPts,
  });
  
  if (pathPoints.length > 2) {
    const context = pdfDoc.context;
    
    const tintFunction = context.obj({
      FunctionType: 2,
      Domain: [0, 1],
      C0: [0, 0, 0, 0],
      C1: [0, 1, 0, 0],
      N: 1,
    });
    const tintFunctionRef = context.register(tintFunction);
    
    const separationColorSpace = context.obj([
      PDFName.of('Separation'),
      PDFName.of(cutContourLabel),
      PDFName.of('DeviceCMYK'),
      tintFunctionRef,
    ]);
    const separationRef = context.register(separationColorSpace);
    
    const resources = page.node.Resources();
    if (resources) {
      let colorSpaceDict = resources.get(PDFName.of('ColorSpace'));
      if (!colorSpaceDict) {
        colorSpaceDict = context.obj({});
        resources.set(PDFName.of('ColorSpace'), colorSpaceDict);
      }
      (colorSpaceDict as PDFDict).set(PDFName.of(cutContourLabel), separationRef);
    }
    
    // For Zero Hero (strokeSettings.width === 0) prefer the bezier
    // reconstruction so curves render as smooth `c` operators in the PDF.
    // Falls back to polyline emit (no spline smoothing) if bezier isn't
    // available; `contourPointsToPDFPathOps` itself bypasses Catmull-Rom
    // when `disableSplines` is set.
    const isZeroHeroExport = strokeSettings.width === 0;
    let combinedPathOps = '';
    if (isZeroHeroExport && allBezierPaths && allBezierPaths.length > 0) {
      for (const bp of allBezierPaths) {
        combinedPathOps += bezierPathToPDFPathOps(bp, heightInches, cutContourLabel);
      }
      console.log('[generateContourPDFBase64] Emitting', allBezierPaths.length, 'CutContour path(s) (Zero Hero, bezier reconstruction)');
    } else {
      const base64PathsToEmit = allPathPoints && allPathPoints.length > 0 ? allPathPoints : [pathPoints];
      for (const singlePath of base64PathsToEmit) {
        combinedPathOps += contourPointsToPDFPathOps(singlePath, heightInches, cutContourLabel, isZeroHeroExport);
      }
    }

    if (combinedPathOps.length > 0) {
      const existingContents = page.node.Contents();
      if (existingContents) {
        const contentStream = context.stream(combinedPathOps);
        const contentStreamRef = context.register(contentStream);
        
        if (existingContents instanceof PDFArray) {
          existingContents.push(contentStreamRef);
        } else {
          const newContents = context.obj([existingContents, contentStreamRef]);
          page.node.set(PDFName.of('Contents'), newContents);
        }
      }
    }
  }
  
  pdfDoc.setTitle('Sticker with CutContour');
  pdfDoc.setSubject(`Contains ${cutContourLabel} spot color for cutting machines`);
  
  const pdfBytes = await pdfDoc.save();
  
  let binary = '';
  for (let i = 0; i < pdfBytes.length; i++) {
    binary += String.fromCharCode(pdfBytes[i]);
  }
  return btoa(binary);
}
