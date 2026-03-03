import { useState, useRef, useCallback, useEffect } from "react";
import UploadSection from "./upload-section";
import PreviewSection from "./preview-section";
import ControlsSection, { SpotPreviewData } from "./controls-section";
import { calculateImageDimensions, downloadCanvas } from "@/lib/image-utils";
import { cropImageToContent } from "@/lib/image-crop";
import { createVectorStroke, downloadVectorStroke, createVectorPaths, type VectorFormat } from "@/lib/vector-stroke";
import { checkCadCutBounds, type CadCutBounds } from "@/lib/cadcut-bounds";
import { downloadContourPDF, downloadDesignOnlyPDF, type CachedContourData, type SpotColorInput } from "@/lib/contour-outline";
import { getContourWorkerManager, type DetectedAlgorithm, type DetectedShapeInfo } from "@/lib/contour-worker-manager";
import { downloadShapePDF, calculateShapeDimensions, generateShapePathPointsInches } from "@/lib/shape-outline";
import { useDebouncedValue } from "@/hooks/use-debounce";
import { removeBackgroundFromImage } from "@/lib/background-removal";
import type { ParsedPDFData } from "@/lib/pdf-parser";
import { detectShape, mapDetectedShapeToType } from "@/lib/shape-detection";
import { useToast } from "@/hooks/use-toast";
import EnhanceWorker from "@/lib/enhance-worker?worker";

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
  const [spotPreviewData, setSpotPreviewData] = useState<SpotPreviewData>({ enabled: false, colors: [] });
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
  const [enhancingMode, setEnhancingMode] = useState<'design' | 'faces' | null>(null);
  const [noCutlinesDialog, setNoCutlinesDialog] = useState<{
    pending: boolean;
    args: { downloadType: string; format: VectorFormat; spotColors?: SpotColorInput[]; singleArtboard: boolean } | null;
  }>({ pending: false, args: null });
  const applyAddRef = useRef<HTMLDivElement>(null);
  
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

  const handleUndo = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    isRestoringRef.current = true;
    historyIndexRef.current--;
    const snap = historyRef.current[historyIndexRef.current];
    setStrokeSettings(snap.strokeSettings);
    setResizeSettings(snap.resizeSettings);
    setShapeSettings(snap.shapeSettings);
    setSpotPreviewData(snap.spotColors);
    if (snap.imageInfo !== undefined) {
      setImageInfo(snap.imageInfo);
      const workerManager = getContourWorkerManager();
      workerManager.clearCache();
      setCadCutBounds(null);
    }
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(true);
    requestAnimationFrame(() => { isRestoringRef.current = false; });
  }, []);

  const handleRedo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    isRestoringRef.current = true;
    historyIndexRef.current++;
    const snap = historyRef.current[historyIndexRef.current];
    setStrokeSettings(snap.strokeSettings);
    setResizeSettings(snap.resizeSettings);
    setShapeSettings(snap.shapeSettings);
    setSpotPreviewData(snap.spotColors);
    if (snap.imageInfo !== undefined) {
      setImageInfo(snap.imageInfo);
      const workerManager = getContourWorkerManager();
      workerManager.clearCache();
      setCadCutBounds(null);
    }
    setCanUndo(true);
    setCanRedo(historyIndexRef.current < historyRef.current.length - 1);
    requestAnimationFrame(() => { isRestoringRef.current = false; });
  }, []);

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

  const applyNewImage = useCallback((newImageInfo: ImageInfo, widthInches: number, heightInches: number) => {
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
    const isCircularType = autoType === 'circle' || autoType === 'oval';
    const newShapeSettings: ShapeSettings = {
      enabled: false,
      type: autoType,
      offset: isCircularType ? 0.05 : 0.25,
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
    if (!imageInfo) return;
    
    setIsRemovingBackground(true);
    try {
      const bgRemovedImage = await removeBackgroundFromImage(imageInfo.image, threshold);
      
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
      
      // Recalculate resize settings based on cropped image dimensions
      const dpi = imageInfo.dpi || 300;
      const { widthInches, heightInches } = calculateImageDimensions(newWidth, newHeight, dpi);
      
      setResizeSettings(prev => ({
        ...prev,
        widthInches,
        heightInches,
      }));
      
      // Clear contour cache to force recomputation with new image
      const workerManager = getContourWorkerManager();
      workerManager.clearCache();
      
      // Reset CadCut bounds
      setCadCutBounds(null);
      
      // Log the change
      console.log(`[BackgroundRemoval] Complete! Original: ${imageInfo.originalWidth}x${imageInfo.originalHeight}, New: ${newWidth}x${newHeight}`);
      
      setImageInfo(newImageInfo);
      
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
  }, [imageInfo, stickerSize]);

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

  const handleEnhanceImage = useCallback(async (mode: 'design' | 'faces') => {
    if (!imageInfo || enhancingMode) return;

    setEnhancingMode(mode);
    setEnhanceStage('Preparing…');

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
          { type: 'enhance', imageBitmap: bitmap, mode, width: imageInfo.image.width, height: imageInfo.image.height },
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

      const workerManager = getContourWorkerManager();
      workerManager.clearCache();
      setCadCutBounds(null);
      setLockedContour(null);

      const modeLabel = mode === 'faces' ? 'Faces' : 'Design';

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
  }, [imageInfo, enhancingMode, toast]);

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
    
    // Auto-reset offset when switching between shape type categories
    if (newSettings.type !== undefined && newSettings.type !== shapeSettings.type) {
      const wasCircular = shapeSettings.type === 'circle' || shapeSettings.type === 'oval';
      const isCircular = newSettings.type === 'circle' || newSettings.type === 'oval';
      
      if (wasCircular !== isCircular) {
        // Switch to appropriate default offset for new shape category
        updated.offset = isCircular ? 0.05 : 0.125; // Tight fit for circular, Small for rectangular
      }
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
            lockedContour ? { label: lockedContour.label, pathPoints: lockedContour.pathPoints, widthInches: lockedContour.widthInches, heightInches: lockedContour.heightInches } : null
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
            lockedContour ? { label: lockedContour.label, pathPoints: lockedContour.pathPoints, widthInches: lockedContour.widthInches, heightInches: lockedContour.heightInches, imageOffsetX: lockedContour.imageOffsetX, imageOffsetY: lockedContour.imageOffsetY } : null
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
        />
      </div>
      
      {/* Right area - Upload, Info, and Preview */}
      <div className="lg:col-span-8 xl:col-span-9">
        <div className="sticky top-4 space-y-3">
          {/* Top row: Actions bar */}
          <div className="flex items-center gap-2 bg-white rounded-lg border border-gray-100 shadow-sm px-3 py-2">
            {/* Remove White Background */}
            {imageInfo && (
              <button
                onClick={() => handleRemoveBackground(85)}
                disabled={isRemovingBackground}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all whitespace-nowrap bg-gradient-to-r from-indigo-500 to-violet-500 text-white hover:from-indigo-400 hover:to-violet-400 shadow-sm hover:shadow-md disabled:opacity-50"
              >
                {isRemovingBackground ? 'Removing...' : 'Remove White Background'}
              </button>
            )}
            
            <div className="flex-1"></div>
            
            <div className="flex items-center gap-1">
              {enhancingMode === 'design' ? (
                <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-amber-100 text-amber-700 cursor-wait whitespace-nowrap">
                  <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" /></svg>
                  {enhanceStage || 'Enhancing Design…'}
                </div>
              ) : enhancingMode === 'faces' ? (
                <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-violet-100 text-violet-700 cursor-wait whitespace-nowrap">
                  <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" /></svg>
                  {enhanceStage || 'Enhancing Faces…'}
                </div>
              ) : (
                <>
                  <button
                    onClick={() => handleEnhanceImage('design')}
                    disabled={!imageInfo}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all whitespace-nowrap bg-gradient-to-r from-amber-500 to-orange-500 text-white hover:from-amber-600 hover:to-orange-600 shadow-sm hover:shadow-md disabled:opacity-50"
                    title="Enhance design quality (best for illustrations, logos, stickers)"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z" /></svg>
                    Enhance Design
                  </button>
                  <button
                    onClick={() => handleEnhanceImage('faces')}
                    disabled={!imageInfo}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all whitespace-nowrap bg-gradient-to-r from-violet-500 to-purple-500 text-white hover:from-violet-600 hover:to-purple-600 shadow-sm hover:shadow-md disabled:opacity-50"
                    title="Enhance faces (best for photo stickers with people)"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="5" /><path d="M20 21a8 8 0 0 0-16 0" /></svg>
                    Enhance Faces
                  </button>
                </>
              )}
            </div>
            
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
            onSpotColorClick={(colorIndex, regionId) => {
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
                      await downloadDesignOnlyPDF(
                        imageInfo.image,
                        resizeSettings,
                        `${nameWithoutExt}.pdf`,
                        args.spotColors,
                        args.singleArtboard
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
              <div className={`absolute inset-0 rounded-full border-4 border-t-transparent animate-spin ${enhancingMode === 'faces' ? 'border-violet-500' : 'border-amber-500'}`}></div>
              <div className="absolute inset-0 flex items-center justify-center">
                {enhancingMode === 'faces' ? (
                  <svg className="w-6 h-6 text-violet-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="5" /><path d="M20 21a8 8 0 0 0-16 0" /></svg>
                ) : (
                  <svg className="w-6 h-6 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z" /></svg>
                )}
              </div>
            </div>
            <div className="text-white text-lg font-semibold mb-2">
              {enhancingMode === 'faces' ? 'Enhancing Faces' : 'Enhancing Design'}
            </div>
            <div className={`text-sm mb-4 ${enhancingMode === 'faces' ? 'text-violet-300' : 'text-amber-300'}`}>
              {enhanceStage || 'Starting up...'}
            </div>
            <p className="text-xs text-slate-400">This may take up to a minute. Please wait.</p>
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

    </div>
  );
}
