import { useState, useRef, useCallback, useEffect } from "react";
import UploadSection from "./upload-section";
import PreviewSection from "./preview-section";
import ControlsSection, { SpotPreviewData } from "./controls-section";
import type { ExtractedColor } from "@/lib/color-extractor";
import { calculateImageDimensions, downloadCanvas } from "@/lib/image-utils";
import { cropImageToContent } from "@/lib/image-crop";
import { createVectorStroke, downloadVectorStroke, createVectorPaths, type VectorFormat } from "@/lib/vector-stroke";
import { checkCadCutBounds, type CadCutBounds } from "@/lib/cadcut-bounds";
import { downloadContourPDF, downloadDesignOnlyPDF, type CachedContourData, type SpotColorInput } from "@/lib/contour-outline";
import { getContourWorkerManager, processContourInWorker, type DetectedAlgorithm, type DetectedShapeInfo } from "@/lib/contour-worker-manager";
import { downloadShapePDF, calculateShapeDimensions, generateShapePathPointsInches } from "@/lib/shape-outline";
import { useDebouncedValue } from "@/hooks/use-debounce";
import { removeBackgroundFromImage } from "@/lib/background-removal";
import { magicWandErase } from "@/lib/magic-wand";
import { detectQRsInImage } from "@/lib/qr";
import type { ParsedPDFData } from "@/lib/pdf-parser";
import { detectShape, mapDetectedShapeToType } from "@/lib/shape-detection";
import { useToast } from "@/hooks/use-toast";
import EnhanceWorker from "@/lib/enhance-worker?worker";
import type { GangSheetItem, GangSheetSettings } from "@/lib/gang-sheet";
import { DEFAULT_GANG_SHEET_SETTINGS, clampGangSheetQuantity } from "@/lib/gang-sheet";
import GangSheetPanel from "./gang-sheet-panel";

export type { ImageInfo, StrokeSettings, StrokeMode, ResizeSettings, ShapeSettings, StickerSize, LockedContour, SegmentLayer, SegmentationData } from "@/lib/types";
import type { ImageInfo, StrokeSettings, StrokeMode, ResizeSettings, ShapeSettings, StickerSize, LockedContour, SegmentLayer, SegmentationData } from "@/lib/types";

export default function ImageEditor({ onDesignUploaded }: { onDesignUploaded?: () => void } = {}) {
  const { toast } = useToast();
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  const [cadCutBounds, setCadCutBounds] = useState<CadCutBounds | null>(null);
  const [strokeSettings, setStrokeSettings] = useState<StrokeSettings>({
    width: 0.14, // Default large offset
    color: "#ffffff",
    enabled: false,
    alphaThreshold: 128, // Auto-detected from alpha channel
    backgroundColor: "#ffffff", // Default white background for contour
    useCustomBackground: true, // Default to solid background color
    cornerMode: 'rounded',
    autoBridging: true, // Auto-bridge narrow gaps in contour
    autoBridgingThreshold: 0.02, // Gap threshold in inches
    contourMode: undefined,
    includeHoles: false,
  });
  const [resizeSettings, setResizeSettings] = useState<ResizeSettings>({
    widthInches: 5.0,
    heightInches: 3.8,
    maintainAspectRatio: true,
    outputDPI: 300,
  });
  const [shapeSettings, setShapeSettings] = useState<ShapeSettings>({
    enabled: false,
    type: 'square',
    offset: 0.25, // Default "Big" offset around design
    fillColor: '#FFFFFF',
    strokeEnabled: false,
    strokeWidth: 2,
    strokeColor: '#000000',
    cornerRadius: 0.25, // Default corner radius for rounded shapes (in inches)
    bleedEnabled: false, // Color bleed outside the shape
    bleedColor: '#FFFFFF', // Default bleed color
  });
  const [strokeMode, setStrokeMode] = useState<StrokeMode>('none');
  const [stickerSize, setStickerSize] = useState<StickerSize>(4); // Default 4 inch max dimension
  const [isProcessing, setIsProcessing] = useState(false);
  const [isRemovingBackground, setIsRemovingBackground] = useState(false);
  const [magicWandMode, setMagicWandMode] = useState(false);
  const [magicWandTolerance, setMagicWandTolerance] = useState(0.08); // 0..1
  const [isMagicWandRunning, setIsMagicWandRunning] = useState(false);
  const [spotPreviewData, setSpotPreviewData] = useState<SpotPreviewData>({ enabled: false, colors: [] });
  const [spotColorRestore, setSpotColorRestore] = useState<{ colors: ExtractedColor[]; id: number } | null>(null);
  const [highlightedColor, setHighlightedColor] = useState<{ colorIndex: number; regionId: number | null } | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [detectedAlgorithm, setDetectedAlgorithm] = useState<DetectedAlgorithm | undefined>(undefined);
  const [detectedShapeType, setDetectedShapeType] = useState<'circle' | 'oval' | 'square' | 'rectangle' | null>(null);
  const [detectedShapeInfo, setDetectedShapeInfo] = useState<DetectedShapeInfo | null>(null);
  const [cutContourLabel, setCutContourLabel] = useState<'CutContour' | 'PerfCutContour' | 'KissCut'>('CutContour');
  const [showCutLabelDropdown, setShowCutLabelDropdown] = useState(false);
  const cutLabelRef = useRef<HTMLDivElement>(null);
  const [lockedContour, setLockedContour] = useState<LockedContour | null>(null);
  const [showApplyAddDropdown, setShowApplyAddDropdown] = useState(false);
  const [segmentationData, setSegmentationData] = useState<SegmentationData>({
    enabled: false,
    layers: [],
    mode: 'colors',
  });
  const [isSegmenting, setIsSegmenting] = useState(false);
  const [enhancingMode, setEnhancingMode] = useState<'design' | 'faces' | 'ai' | null>(null);
  const [noCutlinesDialog, setNoCutlinesDialog] = useState<{
    pending: boolean;
    args: { downloadType: string; format: VectorFormat; spotColors?: SpotColorInput[]; singleArtboard: boolean } | null;
  }>({ pending: false, args: null });
  const applyAddRef = useRef<HTMLDivElement>(null);
  const [gangSheetItems, setGangSheetItems] = useState<GangSheetItem[]>([]);
  const [gangSheetOpen, setGangSheetOpen] = useState(false);
  const [gangSheetSettings, setGangSheetSettings] = useState<GangSheetSettings>(DEFAULT_GANG_SHEET_SETTINGS);
  const [spotPaintMode, setSpotPaintMode] = useState<'white' | 'gloss' | 'both' | 'clear' | null>(null);
  const [pendingSpotPaint, setPendingSpotPaint] = useState<{ colorIndex: number; regionId: number | null; mode: string; id: number } | null>(null);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Undo/Redo history
  interface EditorSnapshot {
    strokeSettings: StrokeSettings;
    resizeSettings: ResizeSettings;
    shapeSettings: ShapeSettings;
    spotColors: SpotPreviewData;
    imageInfo: ImageInfo | null;
  }
  const historyRef = useRef<EditorSnapshot[]>([]);
  const historyIndexRef = useRef(-1);
  const isRestoringRef = useRef(false);
  const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const pushSnapshot = useCallback(() => {
    if (isRestoringRef.current) return;
    const snap: EditorSnapshot = {
      strokeSettings: { ...strokeSettings },
      resizeSettings: { ...resizeSettings },
      shapeSettings: { ...shapeSettings },
      spotColors: { ...spotPreviewData, colors: spotPreviewData.colors.map(c => ({ ...c, regions: c.regions?.map(r => ({ ...r })) })) },
      imageInfo: imageInfo ? { ...imageInfo } : null,
    };
    const idx = historyIndexRef.current;
    const prev = idx >= 0 ? historyRef.current[idx] : null;
    if (prev) {
      const sameSpot = prev.spotColors.colors.length === snap.spotColors.colors.length &&
        prev.spotColors.colors.every((pc: any, ci: number) => {
          const nc = snap.spotColors.colors[ci];
          if (pc.spotWhite !== nc.spotWhite || pc.spotGloss !== nc.spotGloss) return false;
          if (!pc.regions && !nc.regions) return true;
          if (!pc.regions || !nc.regions || pc.regions.length !== nc.regions.length) return false;
          return pc.regions.every((pr: any, ri: number) => {
            const nr = nc.regions![ri];
            return pr.spotWhite === nr.spotWhite && pr.spotGloss === nr.spotGloss;
          });
        });
      const sameStroke = prev.strokeSettings.width === snap.strokeSettings.width &&
        prev.strokeSettings.enabled === snap.strokeSettings.enabled;
      if (sameSpot && sameStroke) {
        return;
      }
    }
    historyRef.current = historyRef.current.slice(0, idx + 1);
    historyRef.current.push(snap);
    if (historyRef.current.length > 50) historyRef.current.shift();
    historyIndexRef.current = historyRef.current.length - 1;
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(false);
  }, [strokeSettings, resizeSettings, shapeSettings, spotPreviewData, imageInfo]);

  // Debounced snapshot: batch rapid changes into one history entry
  useEffect(() => {
    if (isRestoringRef.current) return;
    if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = setTimeout(() => {
      pushSnapshot();
    }, 600);
    return () => { if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current); };
  }, [strokeSettings, resizeSettings, shapeSettings, spotPreviewData, imageInfo, pushSnapshot]);

  const restoreSnapshot = useCallback((snap: EditorSnapshot) => {
    setStrokeSettings(snap.strokeSettings);
    setResizeSettings(snap.resizeSettings);
    setShapeSettings(snap.shapeSettings);
    setSpotPreviewData(snap.spotColors);
    setSpotColorRestore({ colors: snap.spotColors.colors, id: Date.now() });
    const imageChanged = snap.imageInfo?.image?.src !== imageInfo?.image?.src;
    if (imageChanged && snap.imageInfo !== undefined) {
      setImageInfo(snap.imageInfo);
      const workerManager = getContourWorkerManager();
      workerManager.clearCache();
      setCadCutBounds(null);
    }
  }, [imageInfo]);

  const handleUndo = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    isRestoringRef.current = true;
    historyIndexRef.current--;
    const snap = historyRef.current[historyIndexRef.current];
    restoreSnapshot(snap);
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(true);
    requestAnimationFrame(() => { isRestoringRef.current = false; });
  }, [restoreSnapshot]);

  const handleRedo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    isRestoringRef.current = true;
    historyIndexRef.current++;
    const snap = historyRef.current[historyIndexRef.current];
    restoreSnapshot(snap);
    setCanUndo(true);
    setCanRedo(historyIndexRef.current < historyRef.current.length - 1);
    requestAnimationFrame(() => { isRestoringRef.current = false; });
  }, [restoreSnapshot]);

  const setHighlightWithTimer = useCallback((color: { colorIndex: number; regionId: number | null } | null) => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedColor(color);
    if (color) {
      highlightTimerRef.current = setTimeout(() => {
        setHighlightedColor(null);
        highlightTimerRef.current = null;
      }, 3000);
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && spotPaintMode) {
        setSpotPaintMode(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [spotPaintMode]);

  // Debounced settings for heavy processing
  const debouncedStrokeSettings = useDebouncedValue(strokeSettings, 100);
  const debouncedResizeSettings = useDebouncedValue(resizeSettings, 250); // Higher debounce for size changes
  const debouncedShapeSettings = useDebouncedValue(shapeSettings, 100);

  // Function to update CadCut bounds checking - accepts shape settings to avoid stale closure
  const updateCadCutBounds = useCallback((
    shapeWidthInches: number, 
    shapeHeightInches: number,
    currentShapeSettings: ShapeSettings
  ) => {
    if (!imageInfo) {
      setCadCutBounds(null);
      return;
    }

    // Convert inches to pixels for bounds checking
    const shapeWidthPixels = shapeWidthInches * imageInfo.dpi;
    const shapeHeightPixels = shapeHeightInches * imageInfo.dpi;

    const bounds = checkCadCutBounds(
      imageInfo.image,
      currentShapeSettings,
      shapeWidthPixels,
      shapeHeightPixels
    );

    setCadCutBounds(bounds);
  }, [imageInfo]);

  useEffect(() => {
    if (imageInfo && onDesignUploaded) {
      onDesignUploaded();
    }
  }, [imageInfo, onDesignUploaded]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (cutLabelRef.current && !cutLabelRef.current.contains(e.target as Node)) {
        setShowCutLabelDropdown(false);
      }
      if (applyAddRef.current && !applyAddRef.current.contains(e.target as Node)) {
        setShowApplyAddDropdown(false);
      }
    };
    if (showCutLabelDropdown || showApplyAddDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showCutLabelDropdown, showApplyAddDropdown]);

  // Keep `strokeSettings.width` aligned with the option list that the Contour
  // Margin dropdown will actually render. The list narrows when
  // `detectedAlgorithm` flips to 'scattered' (smaller margins look cluttered
  // on multi-blob designs, and Zero Hero in particular produces dozens of
  // tiny per-component outlines). If the saved width isn't in the new list,
  // shadcn's <Select> renders an empty box — that's the bug we're fixing.
  // We snap to the closest valid option whenever the algorithm transitions.
  useEffect(() => {
    const validForScattered = [0.07, 0.14, 0.25];
    const validForComplex = [0, 0.02, 0.04, 0.07, 0.14, 0.25];
    const valid = detectedAlgorithm === 'scattered' ? validForScattered : validForComplex;
    if (valid.includes(strokeSettings.width)) return;
    let nearest = valid[0];
    let minDiff = Math.abs(strokeSettings.width - nearest);
    for (const v of valid) {
      const d = Math.abs(strokeSettings.width - v);
      if (d < minDiff) { nearest = v; minDiff = d; }
    }
    console.log(
      `[ContourMargin] width=${strokeSettings.width} not in ${detectedAlgorithm ?? 'complex'} ` +
      `option list — snapping to nearest valid value ${nearest}`
    );
    setStrokeSettings((prev) => ({ ...prev, width: nearest }));
  }, [detectedAlgorithm, strokeSettings.width]);

  const handleApplyAndAdd = useCallback((newLabel: 'CutContour' | 'PerfCutContour' | 'KissCut') => {
    const workerManager = getContourWorkerManager();
    const contourData = workerManager.getCachedContourData();

    if (contourData && contourData.pathPoints && contourData.pathPoints.length >= 3) {
      const previewCanvas = canvasRef.current as any;
      const contourCanvasInfo = previewCanvas?.getContourCanvasInfo?.();
      const cw = contourCanvasInfo?.width ?? 1;
      const ch = contourCanvasInfo?.height ?? 1;
      const icx = contourCanvasInfo?.imageCanvasX ?? 0;
      const icy = contourCanvasInfo?.imageCanvasY ?? 0;
      const ds = contourCanvasInfo?.downsampleScale ?? 1;
      const icw = imageInfo ? Math.round(imageInfo.image.width * ds) : cw;
      const ich = imageInfo ? Math.round(imageInfo.image.height * ds) : ch;

      setLockedContour({
        label: cutContourLabel,
        pathPoints: [...contourData.pathPoints],
        previewPathPoints: [...contourData.previewPathPoints],
        allPathPoints: contourData.allPathPoints ? contourData.allPathPoints.map(p => [...p]) : undefined,
        allPreviewPathPoints: contourData.allPreviewPathPoints ? contourData.allPreviewPathPoints.map(p => [...p]) : undefined,
        widthInches: contourData.widthInches,
        heightInches: contourData.heightInches,
        imageOffsetX: contourData.imageOffsetX,
        imageOffsetY: contourData.imageOffsetY,
        backgroundColor: contourData.backgroundColor,
        effectiveDPI: contourData.effectiveDPI,
        minPathX: contourData.minPathX,
        minPathY: contourData.minPathY,
        bleedInches: contourData.bleedInches,
        contourCanvasWidth: cw,
        contourCanvasHeight: ch,
        imageCanvasX: icx,
        imageCanvasY: icy,
        imageCanvasWidth: icw,
        imageCanvasHeight: ich,
      });
    } else if (shapeSettings.enabled) {
      const shapeData = generateShapePathPointsInches(shapeSettings, resizeSettings);
      setLockedContour({
        label: cutContourLabel,
        pathPoints: shapeData.pathPoints,
        previewPathPoints: shapeData.pathPoints,
        widthInches: shapeData.widthInches,
        heightInches: shapeData.heightInches,
        imageOffsetX: shapeData.imageOffsetX,
        imageOffsetY: shapeData.imageOffsetY,
        backgroundColor: '#ffffff',
        effectiveDPI: 300,
        minPathX: 0,
        minPathY: 0,
        bleedInches: shapeData.bleedInches,
        contourCanvasWidth: 1,
        contourCanvasHeight: 1,
        imageCanvasX: 0,
        imageCanvasY: 0,
        imageCanvasWidth: 1,
        imageCanvasHeight: 1,
      });
    } else {
      console.warn('[AddContour] No contour data available');
      toast({
        title: "No contour available",
        description: "Please wait for the contour to finish generating before adding another.",
        variant: "destructive",
      });
      setShowApplyAddDropdown(false);
      return;
    }

    setCutContourLabel(newLabel);
    setShowApplyAddDropdown(false);
  }, [cutContourLabel, toast, imageInfo, shapeSettings, resizeSettings]);

  const handleAddToGangSheet = useCallback(async () => {
    if (!imageInfo) {
      toast({ title: "No design loaded", description: "Upload a design first.", variant: "destructive" });
      return;
    }

    // Contour cache can lag behind resize (debounced preview). Regenerate for current inches before snapshotting.
    if (!shapeSettings.enabled) {
      try {
        await processContourInWorker(
          imageInfo.image,
          strokeSettings,
          resizeSettings,
          undefined,
          detectedShapeType ?? undefined,
          detectedShapeInfo
        );
      } catch (err) {
        console.error("[GangSheet] contour refresh failed:", err);
        toast({
          title: "Contour not ready",
          description: "Could not refresh the outline for the current size. Wait for the preview to finish, then try again.",
          variant: "destructive",
        });
        return;
      }
    }

    let contourSnapshot: CachedContourData | null = null;

    const workerManager = getContourWorkerManager();
    const cachedData = workerManager.getCachedContourData();

    if (cachedData && cachedData.pathPoints && cachedData.pathPoints.length >= 3) {
      contourSnapshot = {
        pathPoints: [...cachedData.pathPoints],
        previewPathPoints: [...cachedData.previewPathPoints],
        allPathPoints: cachedData.allPathPoints?.map(p => [...p]),
        allPreviewPathPoints: cachedData.allPreviewPathPoints?.map(p => [...p]),
        widthInches: cachedData.widthInches,
        heightInches: cachedData.heightInches,
        imageOffsetX: cachedData.imageOffsetX,
        imageOffsetY: cachedData.imageOffsetY,
        backgroundColor: cachedData.backgroundColor,
        effectiveDPI: cachedData.effectiveDPI,
        minPathX: cachedData.minPathX,
        minPathY: cachedData.minPathY,
        bleedInches: cachedData.bleedInches,
        holePathStartIndex: cachedData.holePathStartIndex,
      };
    } else if (shapeSettings.enabled) {
      const shapeData = generateShapePathPointsInches(shapeSettings, resizeSettings);
      contourSnapshot = {
        pathPoints: shapeData.pathPoints,
        previewPathPoints: shapeData.pathPoints,
        widthInches: shapeData.widthInches,
        heightInches: shapeData.heightInches,
        imageOffsetX: shapeData.imageOffsetX,
        imageOffsetY: shapeData.imageOffsetY,
        backgroundColor: shapeSettings.fillColor || '#ffffff',
        effectiveDPI: 300,
        minPathX: 0,
        minPathY: 0,
        bleedInches: shapeData.bleedInches,
      };
    }

    if (!contourSnapshot) {
      toast({ title: "No contour available", description: "Enable a contour or shape mode before adding to the gang sheet.", variant: "destructive" });
      return;
    }

    const canvas = document.createElement('canvas');
    const thumbSize = 120;
    const aspect = imageInfo.image.width / imageInfo.image.height;
    canvas.width = aspect >= 1 ? thumbSize : Math.round(thumbSize * aspect);
    canvas.height = aspect >= 1 ? Math.round(thumbSize / aspect) : thumbSize;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(imageInfo.image, 0, 0, canvas.width, canvas.height);
    const thumbnail = canvas.toDataURL('image/png');

    // Snapshot the current spot color extraction (white / gloss / fluorescent
    // assignments + per-region selection) so the gang sheet PDF export can
    // emit the same vector spot color separations the single-design export
    // would. We deep-clone to insulate the snapshot from later UI edits.
    const hasAnySpotFlag = spotPreviewData.colors.some(c =>
      c.spotWhite || c.spotGloss ||
      c.spotFluorY || c.spotFluorM || c.spotFluorG || c.spotFluorOrange
    );
    // Apply the user's editable separation names (RDG_WHITE / RDG_GLOSS by
    // default, or whatever they renamed them to in the controls section) so
    // gang sheet separations match what a single-design export would produce.
    const wName = spotPreviewData.spotWhiteName || 'RDG_WHITE';
    const gName = spotPreviewData.spotGlossName || 'RDG_GLOSS';
    const spotColorsSnapshot = hasAnySpotFlag
      ? spotPreviewData.colors.map(c => ({
          hex: c.hex,
          rgb: { ...c.rgb },
          spotWhite: c.spotWhite,
          spotGloss: c.spotGloss,
          spotWhiteName: wName,
          spotGlossName: gName,
          spotFluorY: c.spotFluorY,
          spotFluorM: c.spotFluorM,
          spotFluorG: c.spotFluorG,
          spotFluorOrange: c.spotFluorOrange,
          regions: c.regions?.map(r => ({ ...r })),
          regionMap: c.regionMap, // shared ref OK — never mutated post-extract
        }))
      : undefined;
    const spotPixelMapSnapshot = (hasAnySpotFlag && spotPreviewData.pixelMap && spotPreviewData.mapWidth && spotPreviewData.mapHeight)
      ? { pixelMap: spotPreviewData.pixelMap, mapWidth: spotPreviewData.mapWidth, mapHeight: spotPreviewData.mapHeight }
      : undefined;

    const newItem: GangSheetItem = {
      id: crypto.randomUUID(),
      thumbnail,
      imageElement: imageInfo.image,
      contourData: contourSnapshot,
      resizeSettings: { ...resizeSettings },
      strokeSettings: { ...strokeSettings },
      shapeSettings: shapeSettings.enabled ? { ...shapeSettings } : undefined,
      cutContourLabel,
      quantity: 1,
      qrCodes: imageInfo.qrCodes,
      qrRerenderEnabled: imageInfo.qrRerenderEnabled,
      spotColors: spotColorsSnapshot,
      spotPixelMap: spotPixelMapSnapshot,
    };

    setGangSheetItems(prev => [...prev, newItem]);
    setGangSheetOpen(true);
    toast({ title: "Added to gang sheet", description: `Sticker added. Upload a new design or adjust quantities, then download.` });
  }, [imageInfo, resizeSettings, strokeSettings, shapeSettings, cutContourLabel, toast, detectedShapeType, detectedShapeInfo, spotPreviewData]);

  const canvasToImage = useCallback((canvas: HTMLCanvasElement): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error('toBlob failed')); return; }
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
        img.src = url;
      }, 'image/png');
    });
  }, []);

  const handleClearDesign = useCallback(() => {
    setImageInfo(null);
    setSpotPreviewData({ enabled: false, colors: [] });
    setDetectedAlgorithm(undefined);
    setSpotPaintMode(null);
    setLockedContour(null);
    setCadCutBounds(null);
    setDetectedShapeType(null);
    setDetectedShapeInfo(null);
    const workerManager = getContourWorkerManager();
    // Important: cancel + clear, in that order. Otherwise any in-flight
    // contour trace would resolve into a now-empty cache slot and
    // potentially flash the old design's outline against the new (or no)
    // image after upload.
    workerManager.cancelInFlight('Design cleared');
    workerManager.clearCache();
  }, []);

  /**
   * Re-run shape detection and invalidate every cached cutpath artefact
   * after the underlying pixels have changed (white-bg removal, magic-wand
   * erase, AI enhance, …). Detected shape type + bounding box drive the
   * contour pipeline's primitive-snap pass and the auto-shape (square /
   * circle / rounded-rect) wrap, so they MUST be recomputed against the
   * new pixel data — otherwise the cutline keeps tracing the silhouette of
   * the original image (e.g. wrapping a rectangle around a logo whose
   * white box was just deleted).
   *
   * Caller is responsible for `setImageInfo(newImageInfo)` separately;
   * this helper only refreshes the derived state.
   */
  const refreshDerivedShapeState = useCallback((newImage: HTMLImageElement) => {
    const detectionResult = detectShape(newImage);
    const detectedType = mapDetectedShapeToType(detectionResult.shape);
    setDetectedShapeType(detectedType);
    setDetectedShapeInfo(detectedType ? {
      type: detectedType,
      boundingBox: detectionResult.boundingBox,
    } : null);

    // Drop any pinned outline — it was traced from the previous pixels and
    // would otherwise keep drawing the old cutline in the preview / PDF.
    setLockedContour(null);
    // CadCut bounds were computed from the previous bounding box.
    setCadCutBounds(null);
    // Manager-level + worker-level cache reset so the next preview render
    // re-traces from scratch instead of returning the previous result.
    const workerManager = getContourWorkerManager();
    workerManager.cancelInFlight('Pixels mutated; previous trace stale');
    workerManager.clearCache();

    console.log(
      `[ShapePipeline] Re-detected after pixel mutation: shape=${detectedType ?? 'none'}, bbox=`,
      detectedType ? detectionResult.boundingBox : null,
    );
  }, []);

  // Tracks the last image we ran QR detection on. Used by the
  // image-change effect to decide whether to re-detect.
  const lastQRDetectedImageRef = useRef<HTMLImageElement | null>(null);

  // Off-thread QR detection. Fires after imageInfo is set; merges results
  // back into state via a functional update that bails if the image has
  // since been replaced (avoids clobbering a newer upload's metadata).
  const runQRDetection = useCallback((image: HTMLImageElement, options: { force?: boolean; toastOnEmpty?: boolean } = {}) => {
    // Idempotency guard: skip if we've already detected on this exact image
    // reference. `force: true` bypasses (used by the toolbar "Re-scan" button
    // when the user wants to retry after the upload-time detection missed).
    if (!options.force && lastQRDetectedImageRef.current === image) return;
    lastQRDetectedImageRef.current = image;

    detectQRsInImage(image).then((qrCodes) => {
      setImageInfo((current) => {
        if (!current || current.image !== image) return current;
        return { ...current, qrCodes, qrDetectionRan: true };
      });
      if (qrCodes.length > 0) {
        const payloads = qrCodes.map((q) => q.payload).join(', ');
        console.log(`[QR] Detected ${qrCodes.length} QR code(s): ${payloads}`);
        toast({
          title: `${qrCodes.length} QR code${qrCodes.length === 1 ? '' : 's'} detected`,
          description: `Will be re-rendered as crisp vectors in PDF exports. Payload${qrCodes.length === 1 ? '' : 's'}: ${payloads.length > 60 ? payloads.slice(0, 60) + '…' : payloads}`,
        });
      } else {
        console.log('[QR] No QR codes detected in this design');
        if (options.toastOnEmpty) {
          toast({
            title: 'No QR codes found',
            description: 'Detection ran but found nothing scannable. If your design contains a QR (centre logos, stylised dots, low contrast can defeat detection), the export will still work — just without the crisp vector re-render.',
            variant: 'destructive',
          });
        }
      }
    }).catch((err) => {
      console.warn('[QR] Detection failed:', err);
      // Detection is best-effort — failure is silent. Export still works,
      // QRs just won't get the crisp re-render treatment.
    });
  }, [toast]);

  // Re-run QR detection whenever the underlying image reference changes
  // (uploads, background removal, magic wand, AI enhance — anything that
  // swaps `imageInfo.image`). `runQRDetection` itself bails if it's already
  // run on this image, so this effect is idempotent.
  useEffect(() => {
    if (!imageInfo?.image) return;
    runQRDetection(imageInfo.image);
  }, [imageInfo?.image, runQRDetection]);

  const applyNewImage = useCallback((newImageInfo: ImageInfo, widthInches: number, heightInches: number) => {
    // Drop any in-flight trace from the previous design before we swap.
    // Without this, the old image's contour can resolve into the cache
    // slot for the new image (or worse, leave the "Processing… 0%"
    // overlay frozen because the bumped processingId discards the result).
    const workerManager = getContourWorkerManager();
    workerManager.cancelInFlight('Design swapped');
    workerManager.clearCache();

    setImageInfo(newImageInfo);

    const detectionResult = detectShape(newImageInfo.image);
    const detectedType = mapDetectedShapeToType(detectionResult.shape);

    setStrokeSettings({
      width: 0.14,
      color: "#ffffff",
      enabled: false,
      alphaThreshold: 128,
      backgroundColor: "#ffffff",
      useCustomBackground: true,
      cornerMode: 'rounded',
      autoBridging: true,
      autoBridgingThreshold: 0.02,
      contourMode: undefined,
    });
    setDetectedAlgorithm(undefined);

    const autoType = detectedType || 'square';
    const newShapeSettings: ShapeSettings = {
      enabled: false,
      type: autoType,
      offset: 0.25,
      fillColor: '#FFFFFF',
      strokeEnabled: false,
      strokeWidth: 2,
      strokeColor: '#000000',
      cornerRadius: 0.25,
      bleedEnabled: false,
      bleedColor: '#FFFFFF',
    };
    setShapeSettings(newShapeSettings);

    setDetectedShapeType(detectedType);
    setDetectedShapeInfo(detectedType ? {
      type: detectedType,
      boundingBox: detectionResult.boundingBox
    } : null);

    setStrokeMode('contour');
    setCadCutBounds(null);
    setLockedContour(null);

    setResizeSettings(prev => ({
      ...prev,
      widthInches,
      heightInches,
    }));

    const maxDim = Math.max(widthInches, heightInches);
    const validSizes: StickerSize[] = [2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5];
    const fittingSize = validSizes.find(size => size >= maxDim) || 5.5;
    setStickerSize(fittingSize as StickerSize);

    const shapeDims = calculateShapeDimensions(
      widthInches,
      heightInches,
      newShapeSettings.type,
      newShapeSettings.offset
    );
    updateCadCutBounds(shapeDims.widthInches, shapeDims.heightInches, newShapeSettings);
  }, [updateCadCutBounds]);

  const handleImageUpload = useCallback(async (file: File, image: HTMLImageElement) => {
    try {
      if (image.width <= 0 || image.height <= 0) {
        alert('Invalid image dimensions.');
        return;
      }

      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }

      const dpi = 300;

      // Crop whitespace. For very large images, skip the full-res crop and use directly
      const totalPixels = image.width * image.height;
      let croppedCanvas: HTMLCanvasElement | null = null;
      if (totalPixels <= 16_000_000) {
        croppedCanvas = cropImageToContent(image);
      }

      const sourceCanvas = croppedCanvas || (() => {
        const c = document.createElement('canvas');
        c.width = image.width; c.height = image.height;
        c.getContext('2d')!.drawImage(image, 0, 0);
        return c;
      })();

      const origW = sourceCanvas.width;
      const origH = sourceCanvas.height;

      // Downsample for the in-memory working image (keeps preview fast)
      const MAX_STORED_DIMENSION = 4000;
      const maxDim = Math.max(origW, origH);
      let finalCanvas = sourceCanvas;
      let finalW = origW;
      let finalH = origH;

      if (maxDim > MAX_STORED_DIMENSION) {
        const scale = MAX_STORED_DIMENSION / maxDim;
        finalW = Math.round(origW * scale);
        finalH = Math.round(origH * scale);
        console.log(`[Upload] Downsampling from ${origW}x${origH} to ${finalW}x${finalH}`);
        finalCanvas = document.createElement('canvas');
        finalCanvas.width = finalW;
        finalCanvas.height = finalH;
        const dsCtx = finalCanvas.getContext('2d')!;
        dsCtx.imageSmoothingEnabled = true;
        dsCtx.imageSmoothingQuality = 'high';
        dsCtx.drawImage(sourceCanvas, 0, 0, finalW, finalH);
      }

      const finalImage = await canvasToImage(finalCanvas);

      const newImageInfo: ImageInfo = {
        file,
        image: finalImage,
        originalWidth: finalW,
        originalHeight: finalH,
        dpi,
      };

      const { widthInches, heightInches } = calculateImageDimensions(origW, origH, dpi);

      applyNewImage(newImageInfo, widthInches, heightInches);
    } catch (error) {
      console.error('Error processing uploaded image:', error);
      handleFallbackImage(file, image);
    }
  }, [shapeSettings, stickerSize, updateCadCutBounds, canvasToImage, applyNewImage]);

  const handleFallbackImage = useCallback((file: File, image: HTMLImageElement) => {
    const dpi = 300;
    
    const croppedCanvas = cropImageToContent(image);
    const finalImage = croppedCanvas ? (() => {
      const img = new Image();
      img.src = croppedCanvas.toDataURL();
      return img;
    })() : image;

    const processImage = () => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      
      const { widthInches, heightInches } = calculateImageDimensions(finalImage.width, finalImage.height, dpi);

      const newImageInfo: ImageInfo = {
        file,
        image: finalImage,
        originalWidth: finalImage.width,
        originalHeight: finalImage.height,
        dpi,
      };

      applyNewImage(newImageInfo, widthInches, heightInches);
    };

    if (croppedCanvas) {
      finalImage.onload = processImage;
    } else {
      processImage();
    }
  }, [applyNewImage]);

  const handlePDFUpload = useCallback((file: File, pdfData: ParsedPDFData) => {
    // Close any open dropdowns
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    
    const { image, cutContourInfo, originalPdfData, dpi } = pdfData;
    
    // Create image info with PDF-specific data
    const newImageInfo: ImageInfo = {
      file,
      image,
      originalWidth: image.width,
      originalHeight: image.height,
      dpi,
      isPDF: true,
      pdfCutContourInfo: cutContourInfo,
      originalPdfData,
    };
    
    setImageInfo(newImageInfo);
    
    setStrokeSettings({
      width: 0.14,
      color: "#ffffff",
      enabled: false,
      alphaThreshold: 128,
      backgroundColor: "#ffffff",
      useCustomBackground: true,
      cornerMode: 'rounded',
      autoBridging: true,
      autoBridgingThreshold: 0.02,
      contourMode: undefined,
    });
    setDetectedAlgorithm(undefined);
    setShapeSettings({
      enabled: false,
      type: 'square',
      offset: 0.25,
      fillColor: '#FFFFFF',
      strokeEnabled: false,
      strokeWidth: 2,
      strokeColor: '#000000',
      cornerRadius: 0.25,
      bleedEnabled: false,
      bleedColor: '#FFFFFF',
    });
    
    // If PDF has CutContour, set mode to 'contour' but disable generation
    if (cutContourInfo.hasCutContour) {
      setStrokeMode('none'); // Keep as none since contour is in file
    } else {
      setStrokeMode('none');
    }
    
    setCadCutBounds(null);
    setStickerSize(4);
    
    const { widthInches, heightInches } = calculateImageDimensions(image.width, image.height, dpi);
    
    setResizeSettings(prev => ({
      ...prev,
      widthInches,
      heightInches,
    }));
  }, []);

  const handleResizeChange = useCallback((newSettings: Partial<ResizeSettings>) => {
    setResizeSettings(prev => {
      const updated = { ...prev, ...newSettings };
      
      // Handle aspect ratio maintenance
      if (updated.maintainAspectRatio && imageInfo && newSettings.widthInches !== undefined) {
        const aspectRatio = imageInfo.originalHeight / imageInfo.originalWidth;
        updated.heightInches = parseFloat((newSettings.widthInches * aspectRatio).toFixed(1));
      } else if (updated.maintainAspectRatio && imageInfo && newSettings.heightInches !== undefined) {
        const aspectRatio = imageInfo.originalWidth / imageInfo.originalHeight;
        updated.widthInches = parseFloat((newSettings.heightInches * aspectRatio).toFixed(1));
      }
      
      // Recalculate bounds with auto-sized shape dimensions
      if (shapeSettings.enabled) {
        const shapeDims = calculateShapeDimensions(
          updated.widthInches,
          updated.heightInches,
          shapeSettings.type,
          shapeSettings.offset
        );
        updateCadCutBounds(shapeDims.widthInches, shapeDims.heightInches, shapeSettings);
      }
      
      return updated;
    });
  }, [imageInfo, shapeSettings, updateCadCutBounds]);

  const handleStickerSizeChange = useCallback((newSize: StickerSize) => {
    setStickerSize(newSize);
    
    // Resize the design to fit within the new sticker size
    if (imageInfo) {
      const aspectRatio = imageInfo.originalWidth / imageInfo.originalHeight;
      let newWidth: number;
      let newHeight: number;
      
      if (aspectRatio >= 1) {
        // Wider than tall - width is the constraining dimension
        newWidth = newSize;
        newHeight = parseFloat((newSize / aspectRatio).toFixed(2));
      } else {
        // Taller than wide - height is the constraining dimension
        newHeight = newSize;
        newWidth = parseFloat((newSize * aspectRatio).toFixed(2));
      }
      
      setResizeSettings(prev => ({
        ...prev,
        widthInches: newWidth,
        heightInches: newHeight,
      }));
      
      // Recalculate bounds with auto-sized shape dimensions
      if (shapeSettings.enabled) {
        const shapeDims = calculateShapeDimensions(
          newWidth,
          newHeight,
          shapeSettings.type,
          shapeSettings.offset
        );
        updateCadCutBounds(shapeDims.widthInches, shapeDims.heightInches, shapeSettings);
      }
    }
  }, [imageInfo, shapeSettings, updateCadCutBounds]);

  const handleRemoveBackground = useCallback(async (threshold: number) => {
    console.log('[BgRemoval-handler] handleRemoveBackground invoked, threshold=', threshold, 'hasImage=', !!imageInfo);
    if (!imageInfo) return;

    setIsRemovingBackground(true);
    try {
      console.log('[BgRemoval-handler] awaiting removeBackgroundFromImage...');
      const bgRemovedImage = await removeBackgroundFromImage(imageInfo.image, threshold);
      console.log('[BgRemoval-handler] removeBackgroundFromImage resolved, cropping...');
      
      // Crop to content bounds after background removal so shape fits actual visible content
      const croppedCanvas = cropImageToContent(bgRemovedImage);
      if (!croppedCanvas) {
        console.error('Failed to crop image after background removal');
        setIsRemovingBackground(false);
        return;
      }
      
      // Convert cropped canvas to image
      const finalImage = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = croppedCanvas.toDataURL('image/png');
      });
      
      const newWidth = finalImage.naturalWidth || finalImage.width;
      const newHeight = finalImage.naturalHeight || finalImage.height;
      
      // Create new image info with the processed and cropped image
      const newImageInfo: ImageInfo = {
        ...imageInfo,
        image: finalImage,
        originalWidth: newWidth,
        originalHeight: newHeight,
      };

      // Keep the user's width/height inches — only pixels changed after crop; do not reset to "natural" size at dpi.

      console.log(`[BackgroundRemoval] Complete! Original: ${imageInfo.originalWidth}x${imageInfo.originalHeight}, New: ${newWidth}x${newHeight}`);

      setImageInfo(newImageInfo);
      // Re-run shape detection + reset every cached cutpath artefact so the
      // contour pipeline traces the bg-removed silhouette, not the old one.
      refreshDerivedShapeState(finalImage);
      
      // Show success toast
      toast({
        title: "Background Removed",
        description: "White background removed from edges. Select Contour to see the new outline.",
      });
    } catch (error) {
      console.error('Error removing background:', error);
      toast({
        title: "Error",
        description: "Failed to remove background. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsRemovingBackground(false);
    }
  }, [imageInfo, toast, refreshDerivedShapeState]);

  const handleMagicWandClick = useCallback(async (imageX: number, imageY: number) => {
    if (!imageInfo || isMagicWandRunning) return;

    setIsMagicWandRunning(true);
    try {
      const erased = await magicWandErase(imageInfo.image, imageX, imageY, magicWandTolerance);

      const croppedCanvas = cropImageToContent(erased);
      const finalCanvas = croppedCanvas ?? (() => {
        const c = document.createElement('canvas');
        c.width = erased.naturalWidth || erased.width;
        c.height = erased.naturalHeight || erased.height;
        c.getContext('2d')?.drawImage(erased, 0, 0);
        return c;
      })();

      const finalImage = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = finalCanvas.toDataURL('image/png');
      });

      const newWidth = finalImage.naturalWidth || finalImage.width;
      const newHeight = finalImage.naturalHeight || finalImage.height;

      const newImageInfo: ImageInfo = {
        ...imageInfo,
        image: finalImage,
        originalWidth: newWidth,
        originalHeight: newHeight,
      };

      console.log(`[MagicWand] Erased region around (${imageX.toFixed(0)}, ${imageY.toFixed(0)}) tol=${magicWandTolerance.toFixed(3)}; size: ${imageInfo.originalWidth}x${imageInfo.originalHeight} → ${newWidth}x${newHeight}`);

      setImageInfo(newImageInfo);
      // Pixels just changed — re-detect shape + invalidate every cached
      // cutpath so the next preview retraces the new silhouette.
      refreshDerivedShapeState(finalImage);

      toast({
        title: "Color Erased",
        description: "Click another area to erase more, or click Done.",
      });
    } catch (error) {
      if ((error as Error).message?.includes('Cancelled')) return;
      console.error('Magic wand error:', error);
      toast({
        title: "Error",
        description: "Magic wand failed. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsMagicWandRunning(false);
    }
  }, [imageInfo, magicWandTolerance, isMagicWandRunning, toast, refreshDerivedShapeState]);

  const handleStrokeChange = useCallback((newSettings: Partial<StrokeSettings>) => {
    const updated = { ...strokeSettings, ...newSettings };
    
    // If enabling stroke, disable shape for mutual exclusion
    if (newSettings.enabled === true) {
      setShapeSettings(prev => ({ ...prev, enabled: false }));
    }
    
    setStrokeSettings(updated);
  }, [strokeSettings]);

  const handleSegmentImage = useCallback(async () => {
    if (!imageInfo || isSegmenting) return;

    setIsSegmenting(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = imageInfo.image.width;
      canvas.height = imageInfo.image.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(imageInfo.image, 0, 0);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => b ? resolve(b) : reject(new Error('Failed to create blob')), 'image/png');
      });

      const formData = new FormData();
      formData.append('image', blob, 'image.png');

      const response = await fetch('/api/segment-image', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Server error ${response.status}`);
      }

      const data = await response.json();
      const layers: SegmentLayer[] = (data.layers || []).map((l: any) => ({
        ...l,
        spotWhite: l.spotWhite ?? false,
        spotGloss: l.spotGloss ?? false,
      }));

      setSegmentationData({
        enabled: true,
        layers,
        mode: 'items',
      });

      toast({
        title: "Segmentation Complete",
        description: `Detected ${layers.length} item${layers.length !== 1 ? 's' : ''} in the image.`,
      });
    } catch (error) {
      console.error('Segmentation failed:', error);
      toast({
        title: "Segmentation Failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsSegmenting(false);
    }
  }, [imageInfo, isSegmenting, toast]);

  const [enhanceStage, setEnhanceStage] = useState('');
  const enhanceWorkerRef = useRef<Worker | null>(null);

  const handleEnhanceImage = useCallback(async (mode: 'design' | 'faces' | 'ai') => {
    if (!imageInfo || enhancingMode) return;

    const isAI = mode === 'ai' || mode === 'faces';
    setEnhancingMode(mode);
    setEnhanceStage(isAI ? 'Preparing for AI enhancement…' : 'Preparing…');

    try {
      const bmpCanvas = document.createElement('canvas');
      bmpCanvas.width = imageInfo.image.width;
      bmpCanvas.height = imageInfo.image.height;
      const bmpCtx = bmpCanvas.getContext('2d')!;
      bmpCtx.drawImage(imageInfo.image, 0, 0);
      const bitmap = await createImageBitmap(bmpCanvas);
      bmpCanvas.width = 1;
      bmpCanvas.height = 1;

      const worker = new EnhanceWorker();
      enhanceWorkerRef.current = worker;

      const result = await new Promise<{ blob: Blob; enhancedWidth: number; enhancedHeight: number }>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent) => {
          const msg = e.data;
          if (msg.type === 'progress') {
            setEnhanceStage(msg.stage);
          } else if (msg.type === 'result') {
            resolve({ blob: msg.blob, enhancedWidth: msg.enhancedWidth, enhancedHeight: msg.enhancedHeight });
          } else if (msg.type === 'error') {
            reject(new Error(msg.error));
          }
        };
        worker.onerror = (err) => reject(new Error(err.message || 'Worker crashed'));
        worker.postMessage(
          { type: 'enhance', imageBitmap: bitmap, mode, width: imageInfo.image.width, height: imageInfo.image.height, useAI: isAI },
          [bitmap],
        );
      });

      worker.terminate();
      enhanceWorkerRef.current = null;

      setEnhanceStage('Loading result…');
      const enhancedUrl = URL.createObjectURL(result.blob);
      const enhancedImage = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(enhancedUrl); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(enhancedUrl); reject(new Error('Failed to load enhanced image')); };
        img.src = enhancedUrl;
      });

      const newW = result.enhancedWidth;
      const newH = result.enhancedHeight;
      const origW = imageInfo.originalWidth;
      const origH = imageInfo.originalHeight;
      const scaleUsed = Math.max(1, Math.round(newW / origW));

      const newDpi = Math.round((imageInfo.dpi || 300) * scaleUsed);

      const newImageInfo: ImageInfo = {
        ...imageInfo,
        image: enhancedImage,
        originalWidth: newW,
        originalHeight: newH,
        dpi: newDpi,
      };

      setImageInfo(newImageInfo);
      // Enhanced pixels = different silhouette; rebuild every cached
      // cutpath artefact off the new image.
      refreshDerivedShapeState(enhancedImage);

      const modeLabel = mode === 'ai' ? 'AI Design' : mode === 'faces' ? 'Faces' : 'Design';

      toast({
        title: `${modeLabel} Enhanced`,
        description: `${origW}×${origH} → ${newW}×${newH} (${scaleUsed}x upscale)`,
      });
    } catch (error) {
      console.error('[Enhance] Error:', error);
      if (enhanceWorkerRef.current) {
        enhanceWorkerRef.current.terminate();
        enhanceWorkerRef.current = null;
      }
      toast({
        title: "Enhancement Failed",
        description: error instanceof Error ? error.message : "Unknown error. Please try again.",
        variant: "destructive",
      });
    } finally {
      setEnhancingMode(null);
      setEnhanceStage('');
    }
  }, [imageInfo, enhancingMode, toast, refreshDerivedShapeState]);

  const handleSegmentationChange = useCallback((data: Partial<SegmentationData>) => {
    setSegmentationData(prev => ({ ...prev, ...data }));
  }, []);

  const handleSegmentLayerToggle = useCallback((layerId: string) => {
    setSegmentationData(prev => ({
      ...prev,
      layers: prev.layers.map(l =>
        l.id === layerId ? { ...l, visible: !l.visible } : l
      ),
    }));
  }, []);

  const handleSegmentLayerSpotChange = useCallback((layerId: string, field: 'spotWhite' | 'spotGloss', value: boolean) => {
    setSegmentationData(prev => ({
      ...prev,
      layers: prev.layers.map(l =>
        l.id === layerId ? { ...l, [field]: value } : l
      ),
    }));
  }, []);

  const handleSegmentLayerLabelChange = useCallback((layerId: string, label: string) => {
    setSegmentationData(prev => ({
      ...prev,
      layers: prev.layers.map(l =>
        l.id === layerId ? { ...l, label } : l
      ),
    }));
  }, []);

  const handleShapeChange = useCallback((newSettings: Partial<ShapeSettings>) => {
    let updated = { ...shapeSettings, ...newSettings };
    
    // If enabling shape, disable stroke for mutual exclusion
    if (newSettings.enabled === true) {
      setStrokeSettings(prev => ({ ...prev, enabled: false }));
    }
    
    // Reset dimension overrides when switching shape type so auto-sizing recalculates
    if (newSettings.type !== undefined && newSettings.type !== shapeSettings.type) {
      updated.shapeWidthOverride = 0;
      updated.shapeHeightOverride = 0;
    }
    
    setShapeSettings(updated);
    
    // Recalculate bounds with auto-sized shape dimensions - pass updated settings to avoid stale closure
    if (updated.enabled && imageInfo) {
      const shapeDims = calculateShapeDimensions(
        resizeSettings.widthInches,
        resizeSettings.heightInches,
        updated.type,
        updated.offset
      );
      updateCadCutBounds(shapeDims.widthInches, shapeDims.heightInches, updated);
    }
  }, [shapeSettings, imageInfo, resizeSettings, updateCadCutBounds]);



  const handleDownload = useCallback(async (downloadType: 'standard' | 'highres' | 'vector' | 'cutcontour' | 'design-only' | 'download-package' = 'standard', format: VectorFormat = 'png', spotColors?: SpotColorInput[], singleArtboard: boolean = false) => {
    if (!imageInfo || !canvasRef.current) return;
    
    setIsProcessing(true);
    
    try {
      // Handle PDF with existing CutContour - generate proper vector CutContour PDF
      if (imageInfo.isPDF && imageInfo.pdfCutContourInfo?.hasCutContour && downloadType === 'cutcontour') {
        const { generatePDFWithVectorCutContour } = await import('@/lib/pdf-parser');
        const nameWithoutExt = imageInfo.file.name.replace(/\.[^/.]+$/, '');
        await generatePDFWithVectorCutContour(
          imageInfo.image,
          imageInfo.pdfCutContourInfo.cutContourPoints,
          imageInfo.pdfCutContourInfo.pageWidth,
          imageInfo.pdfCutContourInfo.pageHeight,
          imageInfo.dpi || 300,
          `${nameWithoutExt}_with_cutcontour.pdf`,
          cutContourLabel
        );
        setIsProcessing(false);
        return;
      }
      if (downloadType === 'download-package') {
        // Create zip package with original and cutlines
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Calculate output dimensions using auto-sizing
        const shapeDims = calculateShapeDimensions(
          resizeSettings.widthInches,
          resizeSettings.heightInches,
          shapeSettings.type,
          shapeSettings.offset
        );
        const outputWidth = shapeDims.widthInches * 300;
        const outputHeight = shapeDims.heightInches * 300;
        
        canvas.width = outputWidth;
        canvas.height = outputHeight;

        // Draw shape background
        // Holographic fill downloads as transparent (preview only) - skip fill entirely
        const isHolographicFill = shapeSettings.fillColor === 'holographic';
        ctx.beginPath();
        
        if (shapeSettings.type === 'circle') {
          const radius = Math.min(outputWidth, outputHeight) / 2;
          const centerX = outputWidth / 2;
          const centerY = outputHeight / 2;
          ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        } else if (shapeSettings.type === 'oval') {
          const centerX = outputWidth / 2;
          const centerY = outputHeight / 2;
          ctx.ellipse(centerX, centerY, outputWidth / 2, outputHeight / 2, 0, 0, Math.PI * 2);
        } else if (shapeSettings.type === 'square') {
          const size = Math.min(outputWidth, outputHeight);
          const startX = (outputWidth - size) / 2;
          const startY = (outputHeight - size) / 2;
          ctx.rect(startX, startY, size, size);
        } else {
          ctx.rect(0, 0, outputWidth, outputHeight);
        }
        
        // Only fill if not holographic - holographic downloads as transparent
        if (!isHolographicFill) {
          ctx.fillStyle = shapeSettings.fillColor;
          ctx.fill();
        }

        // Draw cutlines in magenta
        ctx.strokeStyle = '#FF00FF';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Crop image to remove empty space before processing
        const croppedCanvas = cropImageToContent(imageInfo.image);
        const finalImage = croppedCanvas ? (() => {
          const img = new Image();
          img.src = croppedCanvas.toDataURL();
          return img;
        })() : imageInfo.image;

        // Wait for cropped image to load if created
        if (croppedCanvas) {
          await new Promise((resolve) => {
            finalImage.onload = resolve;
          });
        }

        const imageWidth = resizeSettings.widthInches * 300;
        const imageHeight = resizeSettings.heightInches * 300;
        
        const imageX = (outputWidth - imageWidth) / 2;
        const imageY = (outputHeight - imageHeight) / 2;
        
        ctx.save();
        ctx.beginPath();
        if (shapeSettings.type === 'circle') {
          const clipRadius = Math.min(outputWidth, outputHeight) / 2;
          ctx.arc(outputWidth / 2, outputHeight / 2, clipRadius, 0, Math.PI * 2);
        } else if (shapeSettings.type === 'oval') {
          ctx.ellipse(outputWidth / 2, outputHeight / 2, outputWidth / 2, outputHeight / 2, 0, 0, Math.PI * 2);
        } else {
          ctx.rect(0, 0, outputWidth, outputHeight);
        }
        ctx.clip();
        ctx.drawImage(finalImage, imageX, imageY, imageWidth, imageHeight);
        ctx.restore();

        // Download final design only
        const nameWithoutExt = imageInfo.file.name.replace(/\.[^/.]+$/, '');
        canvas.toBlob((blob) => {
          if (blob) {
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${nameWithoutExt}_final_design.png`;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
          }
        }, 'image/png');
        
      } else if (downloadType === 'cutcontour') {
        // Generate magenta vector path along transparent pixel boundaries
        await new Promise(resolve => setTimeout(resolve, 100)); // UI feedback delay
        
        const magentaCutCanvas = createVectorStroke(imageInfo.image, {
          strokeSettings: { ...strokeSettings, color: '#FF00FF', enabled: true }, // Force magenta
          exportCutContour: true, // Enable cut contour mode
          vectorQuality: 'high' // High quality for precise cutting paths
        });
        
        // Download the magenta cut contour
        magentaCutCanvas.toBlob((blob: Blob | null) => {
          if (!blob) return;
          
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = 'magenta_cut_contour.png';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);
        }, 'image/png');
        
        // Also generate vector formats for cutting machines
        const vectorPaths = createVectorPaths(imageInfo.image, {
          ...strokeSettings, 
          color: '#FF00FF', 
          enabled: true
        });
        
        // Download additional vector formats based on requested format
        if (format === 'svg') {
          downloadVectorStroke(magentaCutCanvas, 'cut_contour.svg', 'svg', vectorPaths);
        } else if (format === 'eps') {
          downloadVectorStroke(magentaCutCanvas, 'cut_contour.eps', 'eps', vectorPaths);
        }
      } else {
        // Standard download - shape background or contour outline
        const nameWithoutExt = imageInfo.file.name.replace(/\.[^/.]+$/, '');
        
        // Build spotPixelMap from spotPreviewData so the PDF export uses
        // the same pixel assignments as the preview (no interpolation drift).
        const spotPixelMap = (spotPreviewData.pixelMap && spotPreviewData.mapWidth && spotPreviewData.mapHeight)
          ? { pixelMap: spotPreviewData.pixelMap, mapWidth: spotPreviewData.mapWidth, mapHeight: spotPreviewData.mapHeight }
          : undefined;

        if (strokeSettings.enabled) {
          // Contour mode: Download PDF with raster image + vector contour
          const filename = `${nameWithoutExt}_with_contour.pdf`;
          
          // Get cached contour data from worker manager for fast PDF export
          const workerManager = getContourWorkerManager();
          const cachedData = workerManager.getCachedContourData() as CachedContourData | undefined;
          
          await downloadContourPDF(
            imageInfo.image,
            strokeSettings,
            resizeSettings,
            filename,
            cachedData,
            spotColors,
            singleArtboard,
            cutContourLabel,
            lockedContour ? { label: lockedContour.label, pathPoints: lockedContour.pathPoints, allPathPoints: lockedContour.allPathPoints, widthInches: lockedContour.widthInches, heightInches: lockedContour.heightInches } : null,
            { qrCodes: imageInfo.qrCodes, enabled: imageInfo.qrRerenderEnabled === true },
            spotPixelMap
          );
        } else if (shapeSettings.enabled) {
          // Shape background mode: Download PDF with shape + CutContour spot color
          const filename = `${nameWithoutExt}_with_shape.pdf`;
          await downloadShapePDF(
            imageInfo.image,
            shapeSettings,
            resizeSettings,
            filename,
            spotColors,
            singleArtboard,
            cutContourLabel,
            lockedContour ? { label: lockedContour.label, pathPoints: lockedContour.pathPoints, allPathPoints: lockedContour.allPathPoints, widthInches: lockedContour.widthInches, heightInches: lockedContour.heightInches, imageOffsetX: lockedContour.imageOffsetX, imageOffsetY: lockedContour.imageOffsetY } : null,
            spotPixelMap
          );
        } else {
          setIsProcessing(false);
          setNoCutlinesDialog({
            pending: true,
            args: { downloadType: downloadType || 'standard', format, spotColors, singleArtboard }
          });
          return;
        }
      }
    } catch (error) {
      console.error("Download failed:", error);
      console.error("Error details:", {
        hasImage: !!imageInfo,
        hasCanvas: !!canvasRef.current,
        shapeSettings,
        resizeSettings,
        strokeSettings
      });
      alert(`Download failed: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`);
    } finally {
      setIsProcessing(false);
    }
  }, [imageInfo, strokeSettings, resizeSettings, shapeSettings, cutContourLabel, lockedContour]);

  // Empty state - no image uploaded
  if (!imageInfo) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center">
        <div className="w-full max-w-xl mx-auto transition-all duration-300">
          <UploadSection 
            onImageUpload={handleImageUpload}
            onPDFUpload={handlePDFUpload}
            showCutLineInfo={false}
            imageInfo={null}
            resizeSettings={resizeSettings}
            stickerSize={stickerSize}
          />
        </div>
      </div>
    );
  }

  // Loaded state - image uploaded
  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
      {/* Hidden file input for Change Design */}
      <div className="hidden">
        <UploadSection
          onImageUpload={handleImageUpload}
          onPDFUpload={handlePDFUpload}
          showCutLineInfo={false}
          imageInfo={imageInfo}
          resizeSettings={resizeSettings}
          stickerSize={stickerSize}
        />
      </div>
      {/* Left sidebar - Settings */}
      <div className="lg:col-span-4 xl:col-span-3 space-y-3">
        <ControlsSection
          strokeSettings={strokeSettings}
          resizeSettings={resizeSettings}
          shapeSettings={shapeSettings}
          stickerSize={stickerSize}
          onStrokeChange={handleStrokeChange}
          onResizeChange={handleResizeChange}
          onShapeChange={handleShapeChange}
          onStickerSizeChange={handleStickerSizeChange}
          onDownload={handleDownload}
          isProcessing={isProcessing}
          imageInfo={imageInfo}
          canvasRef={canvasRef}
          onStepChange={() => {}}
          onRemoveBackground={handleRemoveBackground}
          isRemovingBackground={isRemovingBackground}
          onChangeDesign={() => document.getElementById('imageInput')?.click()}
          onClearDesign={imageInfo ? handleClearDesign : undefined}
          onSpotPreviewChange={setSpotPreviewData}
          detectedAlgorithm={detectedAlgorithm}
          segmentationData={segmentationData}
          isSegmenting={isSegmenting}
          onSegmentImage={handleSegmentImage}
          onSegmentationChange={handleSegmentationChange}
          onSegmentLayerToggle={handleSegmentLayerToggle}
          onSegmentLayerLabelChange={handleSegmentLayerLabelChange}
          onSegmentLayerSpotChange={handleSegmentLayerSpotChange}
          highlightedColorIndex={highlightedColor?.colorIndex ?? null}
          highlightedRegionId={highlightedColor?.regionId ?? null}
          onHighlightRegion={(colorIndex, regionId) => {
            setHighlightWithTimer({ colorIndex, regionId });
          }}
          spotPaintMode={spotPaintMode}
          onSpotPaintModeChange={(mode) => {
            setSpotPaintMode(mode);
            if (mode) setMagicWandMode(false);
          }}
          pendingSpotPaint={pendingSpotPaint}
          onSpotPaintApplied={() => setPendingSpotPaint(null)}
          spotColorRestore={spotColorRestore}
        />
      </div>
      
      {/* Right area - Upload, Info, and Preview */}
      <div className="lg:col-span-8 xl:col-span-9">
        <div className="sticky top-4 space-y-3">
          {/* Top row: Actions bar */}
          <div className="flex items-center gap-2 bg-white rounded-lg border border-gray-100 shadow-sm px-3 py-2">
            {imageInfo && (
              <button
                onClick={() => handleRemoveBackground(85)}
                disabled={isRemovingBackground}
                className="group relative flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold whitespace-nowrap text-white shadow-md disabled:opacity-50 overflow-hidden transition-all duration-200 bg-gradient-to-r from-sky-500 to-cyan-500 hover:from-sky-600 hover:to-cyan-600 hover:shadow-lg hover:shadow-sky-200 active:scale-[0.95] active:shadow-sm"
              >
                <span className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-out rounded-lg"></span>
                {isRemovingBackground ? (
                  <svg className="relative w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" /></svg>
                ) : (
                  <svg className="relative w-4 h-4 transition-transform duration-200 group-hover:rotate-12 group-active:rotate-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M3 9h6"/><path d="M3 15h6"/></svg>
                )}
                <span className="relative">{isRemovingBackground ? 'Removing...' : 'Remove White Background'}</span>
              </button>
            )}

            {imageInfo && (
              <button
                onClick={() => {
                  const next = !magicWandMode;
                  setMagicWandMode(next);
                  if (next) setSpotPaintMode(null);
                }}
                disabled={isRemovingBackground || isMagicWandRunning}
                className={`group relative flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold whitespace-nowrap text-white shadow-md disabled:opacity-50 overflow-hidden transition-all duration-200 active:scale-[0.95] active:shadow-sm ${magicWandMode
                  ? 'bg-gradient-to-r from-fuchsia-600 to-pink-600 hover:from-fuchsia-700 hover:to-pink-700 ring-2 ring-fuchsia-300'
                  : 'bg-gradient-to-r from-fuchsia-500 to-pink-500 hover:from-fuchsia-600 hover:to-pink-600 hover:shadow-lg hover:shadow-fuchsia-200'}`}
                title={magicWandMode ? 'Click on the preview to erase a color region' : 'Magic wand: click to erase any color'}
              >
                <span className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-out rounded-lg"></span>
                {isMagicWandRunning ? (
                  <svg className="relative w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" /></svg>
                ) : (
                  <svg className="relative w-4 h-4 transition-transform duration-200 group-hover:rotate-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m14 4 6 6"/><path d="M14 4l-2.5 2.5"/><path d="M11.5 6.5 4 14l6 6 7.5-7.5"/><path d="m18 8 4 4"/></svg>
                )}
                <span className="relative">{magicWandMode ? (isMagicWandRunning ? 'Erasing...' : 'Click to Erase') : 'Magic Wand'}</span>
              </button>
            )}

            {magicWandMode && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-fuchsia-50 border border-fuchsia-100">
                <span className="text-[10px] font-semibold text-fuchsia-700 uppercase tracking-wide">Tolerance</span>
                <input
                  type="range"
                  min={0}
                  max={50}
                  step={1}
                  value={Math.round(magicWandTolerance * 100)}
                  onChange={(e) => setMagicWandTolerance(parseInt(e.target.value, 10) / 100)}
                  className="w-28 accent-fuchsia-500"
                  title="Higher = matches more colors. 5-10% works for most solid backgrounds."
                />
                <span className="text-[10px] font-mono text-fuchsia-700 w-7 text-right">{Math.round(magicWandTolerance * 100)}%</span>
              </div>
            )}

            {imageInfo && (
              /*
                QR badge — three states:
                  1. Detection hasn't completed yet → subtle gray "Scanning…"
                  2. Detection done, 0 codes found    → amber "0 QRs · Re-scan" (clickable, force-rescans)
                  3. Detection done, 1+ codes found   → grey "N QRs · raw · click to fix"
                     (default OFF). Click toggles to green "N QRs · crisp · click to undo".
                Re-render is OPT-IN per user request: detection runs
                automatically, but the QR is only replaced when the user
                clicks the badge. Avoids quietly altering a clean QR.
              */
              imageInfo.qrDetectionRan ? (
                imageInfo.qrCodes && imageInfo.qrCodes.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setImageInfo((cur) => cur ? { ...cur, qrRerenderEnabled: !cur.qrRerenderEnabled } : cur)}
                    title={
                      imageInfo.qrRerenderEnabled
                        ? `Crisp QR re-render is ON for ${imageInfo.qrCodes.length} QR code${imageInfo.qrCodes.length === 1 ? '' : 's'}.\nThe preview and PDF export will replace the source QR pixels with fresh, scanner-optimised vector modules at print resolution. Any centred logo is preserved by carving it out of the wipe.\nClick to undo (use the original QR pixels as-is).\n\nPayload${imageInfo.qrCodes.length === 1 ? '' : 's'}:\n${imageInfo.qrCodes.map((q) => '• ' + q.payload).join('\n')}`
                        : `${imageInfo.qrCodes.length} QR code${imageInfo.qrCodes.length === 1 ? '' : 's'} detected — currently NOT being re-rendered (the source pixels will print as-is and may be blurry at small sizes).\nClick to enable crisp vector re-render: forces square modules + horizontal run-merge for clean ink prints, preserves any centred logo.\n\nPayload${imageInfo.qrCodes.length === 1 ? '' : 's'}:\n${imageInfo.qrCodes.map((q) => '• ' + q.payload).join('\n')}`
                    }
                    className={`group relative flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold whitespace-nowrap text-white shadow-md overflow-hidden transition-all duration-200 active:scale-[0.95] active:shadow-sm ${
                      imageInfo.qrRerenderEnabled
                        ? 'bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 hover:shadow-lg hover:shadow-emerald-200 ring-2 ring-emerald-300'
                        : 'bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 hover:shadow-lg hover:shadow-indigo-200'
                    }`}
                  >
                    <span className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-out rounded-lg"></span>
                    <svg className="relative w-4 h-4 transition-transform duration-200 group-hover:scale-110" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="7" height="7"/>
                      <rect x="14" y="3" width="7" height="7"/>
                      <rect x="3" y="14" width="7" height="7"/>
                      <rect x="14" y="14" width="3" height="3"/>
                      <rect x="18" y="18" width="3" height="3"/>
                    </svg>
                    <span className="relative">
                      {imageInfo.qrCodes.length} QR{imageInfo.qrCodes.length === 1 ? '' : 's'}
                      {imageInfo.qrRerenderEnabled ? ' · Crisp ✓' : ' · Fix QR'}
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => imageInfo.image && runQRDetection(imageInfo.image, { force: true, toastOnEmpty: true })}
                    title="No QR codes found in this design. Click to re-scan — useful if a centre logo, low contrast, or stylised dots defeated the first pass. Vector QR re-render in PDF exports kicks in only when at least one QR is detected."
                    className="group relative flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold whitespace-nowrap text-white shadow-md overflow-hidden transition-all duration-200 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 hover:shadow-lg hover:shadow-amber-200 active:scale-[0.95] active:shadow-sm"
                  >
                    <span className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-out rounded-lg"></span>
                    <svg className="relative w-4 h-4 transition-transform duration-200 group-hover:scale-110" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="7" height="7"/>
                      <rect x="14" y="3" width="7" height="7"/>
                      <rect x="3" y="14" width="7" height="7"/>
                      <line x1="14" y1="14" x2="21" y2="21"/>
                    </svg>
                    <span className="relative">Re-scan QR</span>
                  </button>
                )
              ) : (
                <div
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold whitespace-nowrap text-white/80 shadow-md bg-gradient-to-r from-slate-400 to-slate-500 opacity-70"
                  title="Scanning the design for QR codes…"
                >
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                  </svg>
                  <span>Scanning QRs…</span>
                </div>
              )
            )}

            <div className="flex-1"></div>
            
            {(strokeSettings.enabled || shapeSettings.enabled || (imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour)) && (
              <div className="flex flex-col items-end gap-1">
                {lockedContour && (
                  <div className="flex items-center gap-1.5 px-2 py-1 bg-indigo-50 rounded border border-indigo-200">
                    <div className="w-2 h-2 rounded-full bg-indigo-500"></div>
                    <span className="text-[10px] text-indigo-600 font-medium">{lockedContour.label}</span>
                    <svg className="w-2.5 h-2.5 text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                    <button
                      onClick={() => setLockedContour(null)}
                      className="ml-0.5 text-indigo-400 hover:text-indigo-600 transition-colors"
                      title="Remove locked contour"
                    >
                      <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>
                )}
                <div className="relative" ref={cutLabelRef}>
                  <button
                    onClick={() => setShowCutLabelDropdown(prev => !prev)}
                    className="flex items-center gap-1.5 px-2 py-1 bg-fuchsia-50 rounded border border-fuchsia-100 hover:bg-fuchsia-100 transition-colors cursor-pointer"
                  >
                    <div className="w-2 h-2 rounded-full bg-fuchsia-500"></div>
                    <span className="text-[10px] text-fuchsia-600 font-medium">{cutContourLabel}</span>
                    <svg className="w-2.5 h-2.5 text-fuchsia-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  </button>
                  {showCutLabelDropdown && (
                    <div className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50 min-w-[140px]">
                      {(['CutContour', 'PerfCutContour', 'KissCut'] as const).map((label) => (
                        <button
                          key={label}
                          onClick={() => { setCutContourLabel(label); setShowCutLabelDropdown(false); }}
                          className={`w-full text-left px-3 py-1.5 text-[11px] hover:bg-fuchsia-50 transition-colors ${
                            cutContourLabel === label ? 'text-fuchsia-600 font-medium bg-fuchsia-50' : 'text-gray-600'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="relative" ref={applyAddRef}>
                  <button
                    onClick={() => setShowApplyAddDropdown(prev => !prev)}
                    className="flex items-center gap-1.5 px-2 py-1 bg-indigo-50 rounded border border-indigo-100 hover:bg-indigo-100 transition-colors cursor-pointer"
                  >
                    <div className="w-2 h-2 rounded-full bg-indigo-500"></div>
                    <span className="text-[10px] text-indigo-600 font-medium">Add Contour</span>
                    <svg className="w-2.5 h-2.5 text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  </button>
                  {showApplyAddDropdown && (
                    <div className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50 min-w-[140px]">
                      {(['CutContour', 'PerfCutContour', 'KissCut'] as const).map((label) => (
                        <button
                          key={label}
                          onClick={() => handleApplyAndAdd(label)}
                          className={`w-full text-left px-3 py-1.5 text-[11px] hover:bg-indigo-50 transition-colors text-gray-600`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Gang Sheet - separate from CutContour controls */}
          {imageInfo && (strokeSettings.enabled || shapeSettings.enabled || (imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour)) && (
            <div className="flex items-center gap-2 bg-emerald-50 rounded-lg border border-emerald-200 shadow-sm px-3 py-2">
              <button
                onClick={handleAddToGangSheet}
                className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-[11px] font-semibold hover:bg-emerald-700 transition-colors shadow-sm"
                title="Add current sticker to the gang sheet for batch printing"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
                Add to Gang Sheet
              </button>
              {gangSheetItems.length > 0 && (
                <>
                  <div className="w-px h-5 bg-emerald-300"></div>
                  <button
                    onClick={() => setGangSheetOpen(true)}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5 text-emerald-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                    View Gang Sheet
                    <span className="min-w-[18px] h-[18px] flex items-center justify-center bg-emerald-600 text-white text-[9px] font-bold rounded-full px-1">{gangSheetItems.length}</span>
                    <span className="text-[10px] text-emerald-500">{gangSheetItems.reduce((s, i) => s + clampGangSheetQuantity(i.quantity), 0)} total</span>
                  </button>
                </>
              )}
            </div>
          )}
          
          {/* Preview - Square */}
          <PreviewSection
            ref={canvasRef}
            imageInfo={imageInfo}
            strokeSettings={debouncedStrokeSettings}
            resizeSettings={debouncedResizeSettings}
            shapeSettings={debouncedShapeSettings}
            cadCutBounds={cadCutBounds}
            spotPreviewData={spotPreviewData}
            showCutLineInfo={false}
            onDetectedAlgorithm={setDetectedAlgorithm}
            detectedShapeType={detectedShapeType}
            detectedShapeInfo={detectedShapeInfo}
            detectedAlgorithm={detectedAlgorithm}
            onStrokeChange={handleStrokeChange}
            lockedContour={lockedContour}
            segmentationData={segmentationData}
            fileName={imageInfo?.file?.name}
            onResizeChange={handleResizeChange}
            onUndo={handleUndo}
            onRedo={handleRedo}
            canUndo={canUndo}
            canRedo={canRedo}
            spotPaintMode={spotPaintMode}
            magicWandMode={magicWandMode}
            onMagicWandPick={handleMagicWandClick}
            onSpotColorClick={(colorIndex, regionId) => {
              if (spotPaintMode) {
                if (snapshotTimerRef.current) {
                  clearTimeout(snapshotTimerRef.current);
                  snapshotTimerRef.current = null;
                }
                pushSnapshot();
                setPendingSpotPaint({ colorIndex, regionId, mode: spotPaintMode, id: Date.now() });
              }
              setHighlightWithTimer({ colorIndex, regionId });
            }}
          />
        </div>
      </div>
      
      {noCutlinesDialog.pending && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-xs mx-4 text-center">
            <div className="text-lg font-semibold text-gray-800 mb-2">No cutlines?</div>
            <p className="text-sm text-gray-500 mb-5">Your download won't include cut lines. Continue anyway?</p>
            <div className="flex gap-3">
              <button
                onClick={() => setNoCutlinesDialog({ pending: false, args: null })}
                className="flex-1 px-4 py-2.5 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50 transition-colors"
              >
                No
              </button>
              <button
                onClick={async () => {
                  const args = noCutlinesDialog.args;
                  setNoCutlinesDialog({ pending: false, args: null });
                  if (!imageInfo) return;
                  setIsProcessing(true);
                  try {
                    const nameWithoutExt = imageInfo.file.name.replace(/\.[^/.]+$/, '');
                    if (args?.format === 'pdf') {
                      const noCtlinesSpotPixelMap = (spotPreviewData.pixelMap && spotPreviewData.mapWidth && spotPreviewData.mapHeight)
                        ? { pixelMap: spotPreviewData.pixelMap, mapWidth: spotPreviewData.mapWidth, mapHeight: spotPreviewData.mapHeight }
                        : undefined;
                      await downloadDesignOnlyPDF(
                        imageInfo.image,
                        resizeSettings,
                        `${nameWithoutExt}.pdf`,
                        args.spotColors,
                        args.singleArtboard,
                        { qrCodes: imageInfo.qrCodes, enabled: imageInfo.qrRerenderEnabled === true },
                        noCtlinesSpotPixelMap
                      );
                    } else {
                      const dpi = 300;
                      await downloadCanvas(
                        imageInfo.image,
                        strokeSettings,
                        resizeSettings.widthInches,
                        resizeSettings.heightInches,
                        dpi,
                        `${nameWithoutExt}.png`,
                        undefined
                      );
                    }
                  } catch (error) {
                    console.error("Download failed:", error);
                  } finally {
                    setIsProcessing(false);
                  }
                }}
                className="flex-1 px-4 py-2.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 transition-colors"
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      )}

      {enhancingMode && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-slate-900 border border-slate-700/50 rounded-2xl p-8 max-w-sm mx-4 text-center shadow-2xl">
            <div className="relative w-16 h-16 mx-auto mb-5">
              <div className="absolute inset-0 rounded-full border-4 border-slate-700"></div>
              <div className={`absolute inset-0 rounded-full border-4 border-t-transparent animate-spin ${enhancingMode === 'faces' ? 'border-violet-500' : enhancingMode === 'ai' ? 'border-emerald-500' : 'border-amber-500'}`}></div>
              <div className="absolute inset-0 flex items-center justify-center">
                {enhancingMode === 'faces' ? (
                  <svg className="w-6 h-6 text-violet-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="5" /><path d="M20 21a8 8 0 0 0-16 0" /></svg>
                ) : (
                  <svg className="w-6 h-6 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z" /></svg>
                )}
              </div>
            </div>
            <div className="text-white text-lg font-semibold mb-2">
              {enhancingMode === 'faces' ? 'AI Enhancing Faces (4x)' : enhancingMode === 'ai' ? 'AI Enhancing Design (4x)' : 'Enhancing Design'}
            </div>
            <div className={`text-sm mb-4 ${enhancingMode === 'faces' ? 'text-violet-300' : enhancingMode === 'ai' ? 'text-emerald-300' : 'text-amber-300'}`}>
              {enhanceStage || 'Starting up...'}
            </div>
            {enhancingMode === 'ai' || enhancingMode === 'faces' ? (
              <p className="text-xs text-slate-400">Very slow but very good quality. This can take 1-3 minutes depending on image size. Please be patient.</p>
            ) : (
              <p className="text-xs text-slate-400">This may take up to a minute. Please wait.</p>
            )}
          </div>
        </div>
      )}

      {/* Processing Modal */}
      {isProcessing && !enhancingMode && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-slate-900 border border-slate-700/50 rounded-lg p-6 max-w-sm mx-4">
            <div className="flex items-center space-x-3">
              <div className="animate-spin rounded-full h-5 w-5 border-2 border-indigo-500 border-t-transparent"></div>
              <span className="text-white">Processing...</span>
            </div>
          </div>
        </div>
      )}

      <GangSheetPanel
        open={gangSheetOpen}
        onOpenChange={setGangSheetOpen}
        items={gangSheetItems}
        onItemsChange={setGangSheetItems}
        settings={gangSheetSettings}
        onSettingsChange={setGangSheetSettings}
      />

    </div>
  );
}
