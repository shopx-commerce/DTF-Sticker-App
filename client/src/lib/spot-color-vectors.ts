import { PDFDocument, PDFName, PDFArray, PDFDict, PDFPage } from 'pdf-lib';
import { type SpotColorInput } from './contour-outline';
import SpotColorWorker from './spot-color-worker?worker';
import { offloadHealthy } from './offload-health';
import { traceSpotColorsViaOffload } from './offload-client';

export interface SpotPixelMapData {
  pixelMap: Int16Array;
  mapWidth: number;
  mapHeight: number;
}

interface Point {
  x: number;
  y: number;
}

interface SpotColorRegion {
  name: string;
  paths: Point[][];
  tintCMYK: [number, number, number, number];
}

const SPOT_COLOR_DPI = 300;
const MAX_CANVAS_DIM = 16384;
const MAX_CANVAS_PIXELS = 268_435_456;

function buildRegionInclusionMasks(
  spotColors: SpotColorInput[],
  canvasW: number,
  canvasH: number,
  srcW: number,
  srcH: number
): { whiteMask: Uint8Array; glossMask: Uint8Array } | null {
  const colorsWithRegions = spotColors.filter(c =>
    c.regions && c.regions.length > 0 && c.regionMap &&
    c.regions.some(r => r.spotWhite !== undefined || r.spotGloss !== undefined)
  );
  if (colorsWithRegions.length === 0) return null;

  const totalPixels = canvasW * canvasH;
  const whiteMask = new Uint8Array(totalPixels);
  const glossMask = new Uint8Array(totalPixels);
  whiteMask.fill(1);
  glossMask.fill(1);

  for (let y = 0; y < canvasH; y++) {
    const srcY = Math.min(Math.floor(y * srcH / canvasH), srcH - 1);
    for (let x = 0; x < canvasW; x++) {
      const srcX = Math.min(Math.floor(x * srcW / canvasW), srcW - 1);
      const srcIdx = srcY * srcW + srcX;
      const pIdx = y * canvasW + x;

      for (const color of colorsWithRegions) {
        const regionId = color.regionMap![srcIdx];
        if (regionId < 0) {
          // Orphan pixel — not assigned to any region. When per-region selection is
          // active for this color, exclude the pixel rather than defaulting to included.
          whiteMask[pIdx] = 0;
          glossMask[pIdx] = 0;
          break;
        }

        const region = color.regions!.find(r => r.id === regionId);
        if (!region) continue;

        const rWhite = region.spotWhite ?? false;
        const rGloss = region.spotGloss ?? false;
        if (!rWhite) whiteMask[pIdx] = 0;
        if (!rGloss) glossMask[pIdx] = 0;
        break;
      }
    }
  }

  return { whiteMask, glossMask };
}

function traceColorRegionsAsync(
  image: HTMLImageElement,
  spotColors: SpotColorInput[],
  widthInches: number,
  heightInches: number,
  spotPixelMap?: SpotPixelMapData
): Promise<SpotColorRegion[]> {
  return new Promise(async (resolve) => {
    let cW = Math.round(widthInches * SPOT_COLOR_DPI);
    let cH = Math.round(heightInches * SPOT_COLOR_DPI);
    let scale = 1;
    if (cW > MAX_CANVAS_DIM) { scale = MAX_CANVAS_DIM / cW; }
    if (cH * scale > MAX_CANVAS_DIM) { scale = MAX_CANVAS_DIM / cH; }
    cW = Math.round(cW * scale); cH = Math.round(cH * scale);
    if (cW * cH > MAX_CANVAS_PIXELS) {
      const ps = Math.sqrt(MAX_CANVAS_PIXELS / (cW * cH));
      cW = Math.round(cW * ps); cH = Math.round(cH * ps);
    }

    let imageData: ImageData;
    let inclusionMasks: { whiteMask: Uint8Array; glossMask: Uint8Array } | null = null;
    let exactSelection = false;

    // "All tagged" detection: every extracted color (and every region within
    // each color, when regions exist) carries the separation flag. Only then
    // does the user expect full design coverage as one solid silhouette.
    //
    // IMPORTANT: color.spotWhite is set to `anyWhite` by toggleRegionSpot
    // (truthy if even ONE region is tagged), so checking `color.spotWhite`
    // alone would falsely fire for partial per-region selections and export
    // untagged regions. We must check region-level flags directly.
    const isColorAllWhite = (c: SpotColorInput) =>
      c.regions && c.regions.length > 0 ? c.regions.every(r => r.spotWhite) : !!c.spotWhite;
    const isColorAllGloss = (c: SpotColorInput) =>
      c.regions && c.regions.length > 0 ? c.regions.every(r => r.spotGloss) : !!c.spotGloss;
    const allTaggedWhite = spotColors.length > 0 && spotColors.every(isColorAllWhite);
    const allTaggedGloss = spotColors.length > 0 && spotColors.every(isColorAllGloss);
    let fullAlphaMask: Uint8Array | null = null;
    if (allTaggedWhite || allTaggedGloss) {
      // Render the actual image at the trace canvas size and read its true
      // alpha channel. This is the design's complete silhouette — same
      // exact coverage the user sees, with zero closest-color gaps.
      const aCanvas = document.createElement('canvas');
      aCanvas.width = cW;
      aCanvas.height = cH;
      const aCtx = aCanvas.getContext('2d');
      if (aCtx) {
        aCtx.drawImage(image, 0, 0, cW, cH);
        const aImg = aCtx.getImageData(0, 0, cW, cH).data;
        fullAlphaMask = new Uint8Array(cW * cH);
        // Threshold of 1 (any visible pixel) — we don't want to miss soft
        // edges. The PDF spot color is binary so partial alpha still becomes
        // 100% spot coverage at that pixel, matching how a press would lay
        // down white/gloss ink under the design.
        for (let i = 0, p = 0; i < fullAlphaMask.length; i++, p += 4) {
          if (aImg[p + 3] >= 1) fullAlphaMask[i] = 1;
        }
        console.log(`[SpotColor] Built full-alpha mask for all-tagged separation (${cW}x${cH})`);
      }
    }

    // STALENESS GUARD: the pixelMap was captured from the image at tagging
    // time. If the image has since been cropped/resized (different aspect
    // ratio), stretching the old map over the new geometry would misalign
    // every spot region. In that case discard the map and fall back to live
    // color matching on the current image pixels — that path can never drift
    // from the artwork.
    let usablePixelMap = spotPixelMap;
    if (usablePixelMap && usablePixelMap.pixelMap.length > 0) {
      const imgW = image.naturalWidth || image.width;
      const imgH = image.naturalHeight || image.height;
      if (imgW > 0 && imgH > 0) {
        const mapAR = usablePixelMap.mapWidth / usablePixelMap.mapHeight;
        const imgAR = imgW / imgH;
        if (Math.abs(mapAR - imgAR) / imgAR > 0.02) {
          console.warn(
            `[SpotColor] STALE pixelMap discarded: map AR ${mapAR.toFixed(4)} (${usablePixelMap.mapWidth}x${usablePixelMap.mapHeight}) ` +
            `vs image AR ${imgAR.toFixed(4)} (${imgW}x${imgH}). Falling back to live color matching.`
          );
          usablePixelMap = undefined;
        }
      }
    }

    if (usablePixelMap && usablePixelMap.pixelMap.length > 0) {
      // Build the export imageData directly from pixelMap + regionMap + per-region selection
      // flags — the same data the preview uses to draw the orange overlay. This guarantees
      // the exported spot color regions exactly match what the user sees, with no color-
      // tolerance math that can under- or over-include pixels.
      //
      // Selected pixels → painted with exact extracted color RGB (worker distance = 0).
      // Everything else → left transparent (worker skips alpha < 240).
      // No inclusion masks needed: selection is encoded directly in the imageData.
      const { pixelMap, mapWidth, mapHeight } = usablePixelMap;
      const rawData = new Uint8ClampedArray(cW * cH * 4); // all transparent

      for (let y = 0; y < cH; y++) {
        const mapY = Math.min(Math.floor(y * mapHeight / cH), mapHeight - 1);
        for (let x = 0; x < cW; x++) {
          const mapX = Math.min(Math.floor(x * mapWidth / cW), mapWidth - 1);
          const mapIdx = mapY * mapWidth + mapX;
          const colorIdx = pixelMap[mapIdx];
          if (colorIdx < 0 || colorIdx >= spotColors.length) continue;

          const color = spotColors[colorIdx];
          let include = false;

          if (color.regionMap && color.regions && color.regions.length > 0) {
            // Per-region white/gloss selection.
            // Fluorescent is always color-level (no per-region fluor flags exist).
            if (color.spotFluorY || color.spotFluorM || color.spotFluorG || color.spotFluorOrange) {
              include = true;
            } else {
              // regionMap is in the same coordinate space as pixelMap (mapWidth × mapHeight).
              const regionId = color.regionMap[mapIdx];
              if (regionId >= 0) {
                const region = color.regions.find(r => r.id === regionId);
                if (region) {
                  // Mirror the preview overlay's fallback: when NO region of
                  // this color carries explicit flags, the user tagged at the
                  // color level — fall back to color-level flags, exactly as
                  // preview-section.tsx does. Otherwise trust region flags.
                  const anyExplicit = color.regions.some(r => r.spotWhite !== undefined || r.spotGloss !== undefined);
                  include = anyExplicit
                    ? !!(region.spotWhite || region.spotGloss)
                    : !!((region.spotWhite ?? color.spotWhite) || (region.spotGloss ?? color.spotGloss));
                }
              }
              // regionId < 0 = orphan pixel → leave transparent (include stays false)
            }
          } else {
            // No per-region data — use color-level flags directly.
            include = !!(
              color.spotWhite || color.spotGloss ||
              color.spotFluorY || color.spotFluorM || color.spotFluorG || color.spotFluorOrange
            );
          }

          if (include) {
            const di = (y * cW + x) * 4;
            rawData[di]     = color.rgb.r;
            rawData[di + 1] = color.rgb.g;
            rawData[di + 2] = color.rgb.b;
            rawData[di + 3] = 255;
          }
        }
      }

      imageData = new ImageData(rawData, cW, cH);
      exactSelection = true;
      // inclusionMasks stays null — the imageData already encodes the exact selection.
      console.log(`[SpotColor] Built ${cW}x${cH} canvas from pixelMap + region selection (exact preview match)`);
    } else {
      // No pixelMap available — draw actual image and let the worker do color matching.
      const canvas = document.createElement('canvas');
      canvas.width = cW;
      canvas.height = cH;
      const ctx = canvas.getContext('2d');
      if (!ctx) { console.warn('[SpotColor] Canvas context creation failed'); resolve([]); return; }
      ctx.drawImage(image, 0, 0, cW, cH);
      imageData = ctx.getImageData(0, 0, cW, cH);
      // buildRegionInclusionMasks requires pixelMap coordinates which we don't have here,
      // so skip it — color-level selection still works via worker color matching.
      console.log(`[SpotColor] Drew image at ${cW}x${cH} (no pixelMap — fallback mode)`);
    }

    const workerColors = spotColors.map(c => ({
      hex: c.hex,
      rgb: c.rgb,
      spotWhite: c.spotWhite,
      spotGloss: c.spotGloss,
      spotWhiteName: c.spotWhiteName,
      spotGlossName: c.spotGlossName,
      spotFluorY: c.spotFluorY,
      spotFluorM: c.spotFluorM,
      spotFluorG: c.spotFluorG,
      spotFluorOrange: c.spotFluorOrange,
      spotFluorYName: c.spotFluorYName,
      spotFluorMName: c.spotFluorMName,
      spotFluorGName: c.spotFluorGName,
      spotFluorOrangeName: c.spotFluorOrangeName,
    }));

    // VPS tier, above the worker — falls straight through to the worker on any offload failure.
    if (await offloadHealthy()) {
      try {
        const regions = await traceSpotColorsViaOffload({
          imageData,
          spotColors: workerColors,
          dpi: SPOT_COLOR_DPI,
          fullAlphaMask: fullAlphaMask ?? undefined,
          allTaggedWhite,
          allTaggedGloss,
          exactSelection,
        });
        resolve(regions);
        return;
      } catch (err) {
        console.warn('[SpotColor] offload failed, falling back to worker:', err);
      }
    }

    let worker: Worker;
    try {
      worker = new SpotColorWorker();
    } catch (err) {
      console.warn('[SpotColor] Worker creation failed, skipping spot colors:', err);
      resolve([]);
      return;
    }

    const pixelCount = cW * cH;
    const timeoutMs = Math.max(30000, Math.round(pixelCount / 50000) * 1000);

    const timeout = setTimeout(() => {
      worker.terminate();
      console.warn(`[SpotColor] Worker timed out after ${timeoutMs}ms`);
      resolve([]);
    }, timeoutMs);

    worker.onmessage = (e: MessageEvent) => {
      clearTimeout(timeout);
      worker.terminate();
      if (e.data.type === 'result') {
        const regions: SpotColorRegion[] = e.data.regions;
        console.log(`[SpotColor] Worker returned ${regions.length} regions at ${SPOT_COLOR_DPI} DPI`);
        for (const r of regions) {
          console.log(`[SpotColor]   ${r.name}: ${r.paths.length} contours`);
        }
        resolve(regions);
      } else {
        resolve([]);
      }
    };

    worker.onerror = (err) => {
      clearTimeout(timeout);
      worker.terminate();
      console.warn('[SpotColor] Worker error, skipping spot colors:', err);
      resolve([]);
    };

    console.log(`[SpotColor] Sending to worker: ${cW}x${cH} at ${SPOT_COLOR_DPI} DPI`);
    const buffer = imageData.data.buffer;
    const transferables: Transferable[] = [buffer];
    const msg: any = {
      type: 'trace',
      imageBuffer: buffer,
      imageWidth: cW,
      imageHeight: cH,
      spotColors: workerColors,
      widthInches,
      heightInches,
      dpi: SPOT_COLOR_DPI,
      exactSelection,
    };

    if (inclusionMasks) {
      msg.whiteInclusionMask = inclusionMasks.whiteMask.buffer;
      msg.glossInclusionMask = inclusionMasks.glossMask.buffer;
      transferables.push(inclusionMasks.whiteMask.buffer, inclusionMasks.glossMask.buffer);
    }

    if (fullAlphaMask) {
      msg.fullAlphaMask = fullAlphaMask.buffer;
      msg.allTaggedWhite = allTaggedWhite;
      msg.allTaggedGloss = allTaggedGloss;
      transferables.push(fullAlphaMask.buffer);
    }

    worker.postMessage(msg, transferables);
  });
}

function spotColorPathsToPDFOps(
  pathsInches: Point[][],
  spotColorName: string
): string {
  if (pathsInches.length === 0) return '';

  const validPaths = pathsInches.filter(p => p.length >= 3);
  if (validPaths.length === 0) return '';

  let compoundPath = 'q\n';
  compoundPath += `/${spotColorName} cs 1 scn\n`;

  for (const path of validPaths) {
    const pts = path.map(p => ({ x: p.x * 72, y: p.y * 72 }));
    compoundPath += `${pts[0].x.toFixed(4)} ${pts[0].y.toFixed(4)} m\n`;
    for (let j = 1; j < pts.length; j++) {
      compoundPath += `${pts[j].x.toFixed(4)} ${pts[j].y.toFixed(4)} l\n`;
    }
    compoundPath += 'h\n';
  }

  compoundPath += 'f*\n';
  compoundPath += 'Q\n';

  return compoundPath;
}

function appendContentStream(
  page: PDFPage,
  context: PDFDocument['context'],
  ops: string
): void {
  if (!ops || ops.length === 0) return;

  const contentStream = context.stream(ops);
  const contentStreamRef = context.register(contentStream);

  const existingContents = page.node.Contents();
  if (existingContents) {
    if (existingContents instanceof PDFArray) {
      existingContents.push(contentStreamRef);
    } else {
      const newContents = context.obj([existingContents, contentStreamRef]);
      page.node.set(PDFName.of('Contents'), newContents);
    }
  } else {
    page.node.set(PDFName.of('Contents'), contentStreamRef);
  }
}

function addSpotColorRegionToPage(
  pdfDoc: PDFDocument,
  page: PDFPage,
  region: SpotColorRegion,
  offsetPaths: Point[][]
): void {
  const context = pdfDoc.context;

  const tintFunction = context.obj({
    FunctionType: 2,
    Domain: [0, 1],
    C0: [0, 0, 0, 0],
    C1: region.tintCMYK,
    N: 1,
  });
  const tintFunctionRef = context.register(tintFunction);

  const separationColorSpace = context.obj([
    PDFName.of('Separation'),
    PDFName.of(region.name),
    PDFName.of('DeviceCMYK'),
    tintFunctionRef,
  ]);
  const separationRef = context.register(separationColorSpace);

  let pageResources = page.node.Resources();
  if (!pageResources) {
    pageResources = context.obj({});
    page.node.set(PDFName.of('Resources'), pageResources);
  }

  let colorSpaceDict = pageResources.get(PDFName.of('ColorSpace'));
  if (!colorSpaceDict) {
    colorSpaceDict = context.obj({});
    (pageResources as PDFDict).set(PDFName.of('ColorSpace'), colorSpaceDict);
  }
  (colorSpaceDict as PDFDict).set(PDFName.of(region.name), separationRef);

  const pathOps = spotColorPathsToPDFOps(offsetPaths, region.name);
  console.log(`[SpotColor PDF] ${region.name}: ${region.paths.length} contours, ${pathOps.length} chars ops`);

  if (pathOps.length > 0) {
    appendContentStream(page, context, pathOps);
  }
}

// ─── Gang sheet spot color export ───
//
// For each unique gang-sheet item, we trace its spot color regions ONCE in
// design-local inch coords (Y-DOWN, origin at top-left of the design), then
// for every placement of that item we remap the paths to sheet coords
// (handling rotation) and emit them all to the same page using shared
// separation color spaces (deduped by spot color name).
//
// This keeps the heavy marching-squares trace from running per-placement, and
// guarantees that the gang sheet PDF contains the same vector spot color
// layers a single-design export would produce — just tiled across the sheet.

export interface GangSheetSpotItem {
  imageElement: HTMLImageElement;
  spotColors: SpotColorInput[];
  spotPixelMap?: SpotPixelMapData;
  /**
   * The IMAGE's draw width in inches on the sheet (NOT the contour bounds).
   * For shape mode this is `resizeSettings.widthInches`; for contour mode
   * this is the aspect-corrected image width that was used in the design
   * draw section of `downloadGangSheetPDF`.
   */
  imageWidthInches: number;
  /** Image's draw height in inches on the sheet (matches the design draw). */
  imageHeightInches: number;
  /**
   * Image-to-contour offset (inches) — same value used by the design draw
   * loop (`contourData.imageOffsetX/Y`). Added to placement.x/y to land at
   * the image's top-left on the sheet.
   */
  imageOffsetX: number;
  imageOffsetY: number;
  /** All placements for this item on the sheet. */
  placements: Array<{ x: number; y: number; rotated: boolean }>;
}

/**
 * Remaps a spot-color path (image-local inches, Y-DOWN, top-left origin)
 * to PDF sheet coords (Y-UP, bottom-left origin). Mirrors the offset/rotation
 * math in the gang-sheet design draw loop so the spot color paths land
 * exactly on top of the rendered image — same image origin, same dims,
 * same rotation.
 */
function remapSpotPathToSheet(
  localPath: Point[],
  imageWidthInches: number,
  imageHeightInches: number,
  placementX: number,
  placementY: number,
  sheetHeightInches: number,
  rotated: boolean,
  imageOffsetX: number,
  imageOffsetY: number
): Point[] {
  return localPath.map(p => {
    if (rotated) {
      // CCW 90° rotation: image dims swap on the sheet, and the X/Y
      // image offsets also swap (matches `imgXPts` / `imgYPts` formula
      // in the gang sheet design draw loop).
      return {
        x: placementX + imageOffsetY + p.y,
        y: sheetHeightInches - (placementY + imageOffsetX + (imageWidthInches - p.x)),
      };
    }
    return {
      x: placementX + imageOffsetX + p.x,
      y: sheetHeightInches - (placementY + imageOffsetY + p.y),
    };
  });
}

/**
 * Adds spot color separation layers to a gang sheet PDF.
 *
 * - `multiPage = false` (single-page mode): emits all separations onto
 *   the supplied `page`, sharing the page with the raster design + cuts.
 *   Color spaces deduped by name.
 * - `multiPage = true` (default for gang sheets with spot colors): adds
 *   one NEW page per unique separation label (sheetWidth × sheetHeight),
 *   each containing only that separation's tiled paths. Cutter / RIP
 *   workflows that expect one separation per page (the standard
 *   single-design export convention) get matching gang sheet output.
 */
export async function addGangSheetSpotColorsToPDF(
  pdfDoc: PDFDocument,
  page: PDFPage,
  items: GangSheetSpotItem[],
  sheetWidthInches: number,
  sheetHeightInches: number,
  multiPage: boolean = false
): Promise<string[]> {
  // Filter to items that actually have any spot color flag set.
  const activeItems = items.filter(item =>
    item.spotColors.some(c =>
      c.spotWhite || c.spotGloss ||
      c.spotFluorY || c.spotFluorM || c.spotFluorG || c.spotFluorOrange
    )
  );
  if (activeItems.length === 0) return [];

  // Trace each item's regions ONCE. Tracing is heavy (worker + marching
  // squares); we cache results so multiple placements of the same item
  // and multi-page emission both reuse one trace.
  const itemRegions: Array<{
    item: GangSheetSpotItem;
    regions: SpotColorRegion[];
  }> = [];
  for (const item of activeItems) {
    const regions = await traceColorRegionsAsync(
      item.imageElement,
      item.spotColors,
      item.imageWidthInches,
      item.imageHeightInches,
      item.spotPixelMap
    );
    if (regions.length > 0) itemRegions.push({ item, regions });
  }
  if (itemRegions.length === 0) return [];

  // Group regions by separation name (white / gloss / fluor labels).
  const tintByName = new Map<string, [number, number, number, number]>();
  for (const { regions } of itemRegions) {
    for (const r of regions) {
      if (!tintByName.has(r.name)) tintByName.set(r.name, r.tintCMYK);
    }
  }

  const context = pdfDoc.context;
  const sheetWidthPts = sheetWidthInches * 72;
  const sheetHeightPts = sheetHeightInches * 72;

  // Helper: register a single separation color space in a page's resource
  // dict. Returns nothing — the caller emits ops that reference it by name.
  const registerSeparationOnPage = (
    targetPage: PDFPage,
    name: string,
    tint: [number, number, number, number]
  ) => {
    const tintFunction = context.obj({
      FunctionType: 2,
      Domain: [0, 1],
      C0: [0, 0, 0, 0],
      C1: tint,
      N: 1,
    });
    const tintFnRef = context.register(tintFunction);
    const sepCS = context.obj([
      PDFName.of('Separation'),
      PDFName.of(name),
      PDFName.of('DeviceCMYK'),
      tintFnRef,
    ]);
    const sepRef = context.register(sepCS);

    let pageResources = targetPage.node.Resources();
    if (!pageResources) {
      pageResources = context.obj({});
      targetPage.node.set(PDFName.of('Resources'), pageResources);
    }
    let colorSpaceDict = pageResources.get(PDFName.of('ColorSpace'));
    if (!colorSpaceDict) {
      colorSpaceDict = context.obj({});
      (pageResources as PDFDict).set(PDFName.of('ColorSpace'), colorSpaceDict);
    }
    (colorSpaceDict as PDFDict).set(PDFName.of(name), sepRef);
  };

  // Build the path-ops for ONE separation name across every item &
  // placement. Used by both single-page and multi-page modes.
  const buildOpsForName = (targetName: string): string => {
    let ops = '';
    for (const { item, regions } of itemRegions) {
      const matching = regions.filter(r => r.name === targetName);
      if (matching.length === 0) continue;
      for (const placement of item.placements) {
        for (const region of matching) {
          const remapped = region.paths.map(path =>
            remapSpotPathToSheet(
              path,
              item.imageWidthInches,
              item.imageHeightInches,
              placement.x,
              placement.y,
              sheetHeightInches,
              placement.rotated,
              item.imageOffsetX,
              item.imageOffsetY
            )
          );
          ops += spotColorPathsToPDFOps(remapped, region.name);
        }
      }
    }
    return ops;
  };

  const addedLabels: string[] = [];

  if (multiPage) {
    // One new page per separation label. Each page contains only that
    // separation's tiled paths — matches single-design `singleArtboard=false`
    // convention so cutter/RIP software sees the same layout per separation.
    for (const [name, tint] of tintByName.entries()) {
      const ops = buildOpsForName(name);
      if (ops.length === 0) continue;
      const sepPage = pdfDoc.addPage([sheetWidthPts, sheetHeightPts]);
      registerSeparationOnPage(sepPage, name, tint);
      appendContentStream(sepPage, context, ops);
      addedLabels.push(name);
    }
  } else {
    // Single-page mode: register every separation on the supplied page
    // and emit all tiled ops into one combined content stream.
    for (const [name, tint] of tintByName.entries()) {
      registerSeparationOnPage(page, name, tint);
      addedLabels.push(name);
    }
    let allOps = '';
    for (const name of tintByName.keys()) {
      allOps += buildOpsForName(name);
    }
    if (allOps.length > 0) {
      appendContentStream(page, context, allOps);
    }
  }

  console.log(`[GangSheet SpotColor] Emitted ${addedLabels.length} separations${multiPage ? ' (one page each)' : ''}: ${addedLabels.join(', ')}`);
  return addedLabels;
}

export async function addSpotColorVectorsToPDF(
  pdfDoc: PDFDocument,
  page: PDFPage,
  image: HTMLImageElement,
  spotColors: SpotColorInput[],
  widthInches: number,
  heightInches: number,
  pageHeightInches: number,
  imageOffsetXInches: number,
  imageOffsetYInches: number,
  singleArtboard: boolean = false,
  pageWidthPts?: number,
  pageHeightPts?: number,
  spotPixelMap?: SpotPixelMapData
): Promise<string[]> {
  if (!spotColors || spotColors.length === 0) return [];

  const hasWhite = spotColors.some(c => c.spotWhite);
  const hasGloss = spotColors.some(c => c.spotGloss);
  const hasFluor = spotColors.some(c => c.spotFluorY || c.spotFluorM || c.spotFluorG || c.spotFluorOrange);
  if (!hasWhite && !hasGloss && !hasFluor) return [];

  const regions = await traceColorRegionsAsync(image, spotColors, widthInches, heightInches, spotPixelMap);
  if (regions.length === 0) return [];

  const addedLabels: string[] = [];

  for (const region of regions) {
    const offsetPaths = region.paths.map(path =>
      path.map(p => ({
        x: p.x + imageOffsetXInches,
        y: pageHeightInches - (p.y + imageOffsetYInches)
      }))
    );

    if (singleArtboard) {
      addSpotColorRegionToPage(pdfDoc, page, region, offsetPaths);
      addedLabels.push(region.name);
    } else {
      const wPts = pageWidthPts || (widthInches + imageOffsetXInches * 2) * 72;
      const hPts = pageHeightPts || pageHeightInches * 72;
      const newPage = pdfDoc.addPage([wPts, hPts]);
      addSpotColorRegionToPage(pdfDoc, newPage, region, offsetPaths);
      addedLabels.push(region.name);
    }
  }

  return addedLabels;
}
