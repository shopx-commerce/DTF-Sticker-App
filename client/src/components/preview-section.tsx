import { useEffect, useLayoutEffect, useRef, forwardRef, useImperativeHandle, useState, useCallback } from "react";
import { ZoomIn, ZoomOut, RotateCcw, ImageIcon, Loader2, Scan, Link2, Unlink2, Undo2, Redo2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

import { ImageInfo, StrokeSettings, ResizeSettings, ShapeSettings, type LockedContour, type SegmentationData } from "./image-editor";
import { SpotPreviewData } from "./controls-section";
import { CadCutBounds } from "@/lib/cadcut-bounds";
import { processContourInWorker, type DetectedAlgorithm, type DetectedShapeInfo } from "@/lib/contour-worker-manager";
import { calculateShapeDimensions } from "@/lib/shape-outline";
import { cropImageToContent, getImageBounds } from "@/lib/image-crop";
import { convertPolygonToCurves, gaussianSmoothContour } from "@/lib/clipper-path";

interface PreviewSectionProps {
  imageInfo: ImageInfo | null;
  strokeSettings: StrokeSettings;
  resizeSettings: ResizeSettings;
  shapeSettings: ShapeSettings;
  cadCutBounds?: CadCutBounds | null;
  spotPreviewData?: SpotPreviewData;
  showCutLineInfo?: boolean;
  onDetectedAlgorithm?: (algo: DetectedAlgorithm) => void;
  detectedShapeType?: 'circle' | 'oval' | 'square' | 'rectangle' | null;
  detectedShapeInfo?: DetectedShapeInfo | null;
  detectedAlgorithm?: DetectedAlgorithm;
  onStrokeChange?: (settings: Partial<StrokeSettings>) => void;
  lockedContour?: LockedContour | null;
  segmentationData?: SegmentationData;
  onSpotColorClick?: (colorIndex: number, regionId: number | null) => void;
  spotPaintMode?: 'white' | 'gloss' | 'both' | 'clear' | null;
  fileName?: string;
  onResizeChange?: (settings: Partial<ResizeSettings>) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
}

function InchInput({ value, onCommit, min = 0.5, max = 50, className }: {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  className?: string;
}) {
  const [localValue, setLocalValue] = useState(value.toFixed(2));
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) setLocalValue(value.toFixed(2));
  }, [value, isFocused]);

  const commit = () => {
    const parsed = parseFloat(localValue);
    if (!isNaN(parsed) && parsed >= min && parsed <= max) {
      onCommit(parsed);
    } else {
      setLocalValue(value.toFixed(2));
    }
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={localValue}
      onChange={(e) => {
        const raw = e.target.value;
        if (/^[0-9]*\.?[0-9]*$/.test(raw)) setLocalValue(raw);
      }}
      onFocus={() => setIsFocused(true)}
      onBlur={() => { setIsFocused(false); commit(); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); } }}
      className={className}
    />
  );
}

const PreviewSection = forwardRef<HTMLCanvasElement, PreviewSectionProps>(
  ({ imageInfo, strokeSettings, resizeSettings, shapeSettings, cadCutBounds, spotPreviewData, showCutLineInfo, onDetectedAlgorithm, detectedShapeType, detectedShapeInfo, detectedAlgorithm, onStrokeChange, lockedContour, segmentationData, onSpotColorClick, spotPaintMode, fileName, onResizeChange, onUndo, onRedo, canUndo, canRedo }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [zoom, setZoom] = useState(1);
    const [panX, setPanX] = useState(0);
    const [panY, setPanY] = useState(0);
    const zoomRef = useRef(1);
    const panXRef = useRef(0);
    const panYRef = useRef(0);
    const [backgroundColor, setBackgroundColor] = useState("#9ca3af");
    const lastImageRef = useRef<string | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [processingProgress, setProcessingProgress] = useState(0);
    const contourCacheRef = useRef<{key: string; canvas: HTMLCanvasElement; downsampleScale: number; imageCanvasX: number; imageCanvasY: number} | null>(null);
    const processingIdRef = useRef(0);
    const [showHighlight, setShowHighlight] = useState(false);
    const lastSettingsRef = useRef<string>('');
    const contourDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastImageRenderRef = useRef<{x: number; y: number; width: number; height: number} | null>(null);
    const [previewDims, setPreviewDims] = useState({ width: 360, height: 360 });
    const spotPulseRef = useRef(1);
    const spotAnimFrameRef = useRef<number | null>(null);
    const renderRef = useRef<(() => void) | null>(null);
    
    const renderRafRef = useRef<number | null>(null);
    const spotOverlayCacheRef = useRef<{key: string; canvas: HTMLCanvasElement} | null>(null);
    const segmentOverlayCacheRef = useRef<{key: string; canvas: HTMLCanvasElement} | null>(null);
    const segmentMaskImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
    const croppedImageCacheRef = useRef<{src: string; canvas: HTMLCanvasElement | HTMLImageElement} | null>(null);
    const previewImageCacheRef = useRef<{src: string; w: number; h: number; canvas: HTMLCanvasElement} | null>(null);
    const holographicCacheRef = useRef<{contourKey: string; canvas: HTMLCanvasElement} | null>(null);
    const contourTransformRef = useRef<{x: number; y: number; width: number; height: number; canvasW: number; canvasH: number} | null>(null);
    const lastCanvasDimsRef = useRef<{width: number; height: number}>({width: 0, height: 0});
    
    // Resize animation state
    const prevResizeDimsRef = useRef<{w: number; h: number} | null>(null);
    const resizeAnimRafRef = useRef<number | null>(null);
    const resizeAnimTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [resizeAnimState, setResizeAnimState] = useState<{scale: number; opacity: number; transitioning: boolean} | null>(null);
    
    // Drag-to-pan state
    const [isDragging, setIsDragging] = useState(false);
    const dragStartRef = useRef<{x: number; y: number; panX: number; panY: number} | null>(null);
    const mouseDownPosRef = useRef<{x: number; y: number} | null>(null);
    
    // Select-to-zoom state
    const [selectZoomMode, setSelectZoomMode] = useState(false);
    const [selectionRect, setSelectionRect] = useState<{x: number; y: number; w: number; h: number} | null>(null);
    const selectionStartRef = useRef<{x: number; y: number} | null>(null);
    const isSelectingRef = useRef(false);
    
    const applyTransformToDOM = useCallback(() => {
      const el = canvasRef.current;
      if (!el) return;
      el.style.transform = `translate(${panXRef.current}%, ${panYRef.current}%) scale(${zoomRef.current})`;
      el.style.transition = 'none';
    }, []);

    const syncRefsToState = useCallback(() => {
      setZoom(zoomRef.current);
      setPanX(panXRef.current);
      setPanY(panYRef.current);
    }, []);

    const maxPanXY = useCallback((z?: number) => {
      const effectiveZoom = z ?? zoomRef.current;
      const limit = 25 + Math.max(0, (effectiveZoom - 1) * 50);
      return { x: limit, y: limit };
    }, []);
    
    const clampPan = useCallback((px: number, py: number, z?: number) => {
      const limit = maxPanXY(z);
      return {
        x: Math.max(-limit.x, Math.min(limit.x, px)),
        y: Math.max(-limit.y, Math.min(limit.y, py)),
      };
    }, [maxPanXY]);
    
    const pxToPanXY = useCallback((dxPx: number, dyPx: number) => {
      const el = canvasRef.current;
      if (!el) return { dx: 0, dy: 0 };
      const w = Math.max(el.clientWidth, 1);
      const h = Math.max(el.clientHeight, 1);
      return { dx: (dxPx / w) * 100, dy: (dyPx / h) * 100 };
    }, []);
    
    const applySelectionZoom = useCallback((selX: number, selY: number, selW: number, selH: number) => {
      const container = containerRef.current;
      if (!container || selW < 20 || selH < 20) return;
      
      const containerRect = container.getBoundingClientRect();
      const elemW = containerRect.width;
      const elemH = containerRect.height;
      if (elemW === 0 || elemH === 0) return;

      const scxPct = ((selX + selW / 2) / elemW - 0.5) * 100;
      const scyPct = ((selY + selH / 2) / elemH - 0.5) * 100;

      const contentCxPct = (scxPct - panXRef.current) / zoomRef.current;
      const contentCyPct = (scyPct - panYRef.current) / zoomRef.current;

      const contentWPct = (selW / elemW * 100) / zoomRef.current;
      const contentHPct = (selH / elemH * 100) / zoomRef.current;

      const newZoom = Math.min(100 / contentWPct, 100 / contentHPct);
      const clampedZoom = Math.min(Math.max(newZoom, 1), 5);

      const newPanX = -clampedZoom * contentCxPct;
      const newPanY = -clampedZoom * contentCyPct;
      
      const clamped = clampPan(newPanX, newPanY, clampedZoom);
      zoomRef.current = clampedZoom;
      panXRef.current = clamped.x;
      panYRef.current = clamped.y;
      setZoom(clampedZoom);
      setPanX(clamped.x);
      setPanY(clamped.y);
    }, [clampPan]);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      
      if (selectZoomMode && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        selectionStartRef.current = { x, y };
        isSelectingRef.current = true;
        setSelectionRect({ x, y, w: 0, h: 0 });
        return;
      }
      
      setIsDragging(true);
      dragStartRef.current = { x: e.clientX, y: e.clientY, panX: panXRef.current, panY: panYRef.current };
      mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
    }, [selectZoomMode]);
    
    const handleMouseMove = useCallback((e: React.MouseEvent) => {
      if (isSelectingRef.current && selectionStartRef.current && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const curX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const curY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
        const sx = selectionStartRef.current.x;
        const sy = selectionStartRef.current.y;
        setSelectionRect({
          x: Math.min(sx, curX),
          y: Math.min(sy, curY),
          w: Math.abs(curX - sx),
          h: Math.abs(curY - sy),
        });
        return;
      }
      
      if (!isDragging || !dragStartRef.current || zoomRef.current <= 1) return;
      const d = pxToPanXY(e.clientX - dragStartRef.current.x, e.clientY - dragStartRef.current.y);
      const clamped = clampPan(dragStartRef.current.panX + d.dx, dragStartRef.current.panY + d.dy);
      panXRef.current = clamped.x;
      panYRef.current = clamped.y;
      applyTransformToDOM();
    }, [isDragging, pxToPanXY, clampPan, applyTransformToDOM]);
    
    const handleMouseUp = useCallback((e: React.MouseEvent) => {
      if (isSelectingRef.current && selectionRect) {
        isSelectingRef.current = false;
        selectionStartRef.current = null;
        if (selectionRect.w >= 20 && selectionRect.h >= 20) {
          applySelectionZoom(selectionRect.x, selectionRect.y, selectionRect.w, selectionRect.h);
          setSelectZoomMode(false);
        }
        setSelectionRect(null);
        return;
      }
      
      const downPos = mouseDownPosRef.current;
      setIsDragging(false);
      dragStartRef.current = null;
      mouseDownPosRef.current = null;
      syncRefsToState();

      if (downPos && onSpotColorClick && spotPreviewData?.pixelMap && imageInfo) {
        const dx = e.clientX - downPos.x;
        const dy = e.clientY - downPos.y;
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) {
          handleCanvasClick(e);
        }
      }
    }, [onSpotColorClick, spotPreviewData, imageInfo, selectionRect, applySelectionZoom, syncRefsToState]);
    
    const handleCanvasClick = useCallback((e: React.MouseEvent) => {
      if (!imageInfo || !spotPreviewData?.pixelMap || !onSpotColorClick || !canvasRef.current) return;

      const canvas = canvasRef.current;
      const rect = canvas.getBoundingClientRect();
      
      // Convert client coordinates to canvas coordinates
      const canvasX = (e.clientX - rect.left) * (canvas.width / rect.width);
      const canvasY = (e.clientY - rect.top) * (canvas.height / rect.height);

      // Determine where the image is drawn on the canvas using lastImageRenderRef
      const imgRect = lastImageRenderRef.current;
      if (!imgRect) return;

      const pixelMap = spotPreviewData.pixelMap;
      const mapW = spotPreviewData.mapWidth ?? imageInfo.image.width;
      const mapH = spotPreviewData.mapHeight ?? imageInfo.image.height;

      const mapX = Math.floor((canvasX - imgRect.x) / imgRect.width * mapW);
      const mapY = Math.floor((canvasY - imgRect.y) / imgRect.height * mapH);

      if (mapX < 0 || mapX >= mapW || mapY < 0 || mapY >= mapH) return;

      const pixelIndex = mapY * mapW + mapX;
      if (pixelIndex < 0 || pixelIndex >= pixelMap.length) return;

      const colorIndex = pixelMap[pixelIndex];
      if (colorIndex < 0) return;

      const color = spotPreviewData.colors[colorIndex];
      if (!color) return;

      let regionId: number | null = null;
      if (color.regionMap) {
        const rid = color.regionMap[pixelIndex];
        if (rid >= 0) regionId = rid;
      }

      onSpotColorClick(colorIndex, regionId);
    }, [imageInfo, spotPreviewData, onSpotColorClick]);

    const handleMouseLeave = useCallback(() => {
      if (isSelectingRef.current) {
        isSelectingRef.current = false;
        selectionStartRef.current = null;
        setSelectionRect(null);
      }
      if (isDragging) {
        setIsDragging(false);
        dragStartRef.current = null;
        syncRefsToState();
      }
    }, [isDragging, syncRefsToState]);
    
    const pinchRef = useRef<{ dist: number; zoom: number } | null>(null);

    const getTouchDist = (a: React.Touch, b: React.Touch) =>
      Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

    const handleTouchStart = useCallback((e: React.TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 2) {
        pinchRef.current = { dist: getTouchDist(e.touches[0], e.touches[1]), zoom: zoomRef.current };
        setIsDragging(false);
        dragStartRef.current = null;
        return;
      }
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      setIsDragging(true);
      dragStartRef.current = { x: t.clientX, y: t.clientY, panX: panXRef.current, panY: panYRef.current };
    }, []);
    
    const handleTouchMove = useCallback((e: React.TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 2 && pinchRef.current) {
        const newDist = getTouchDist(e.touches[0], e.touches[1]);
        const scale = newDist / pinchRef.current.dist;
        const newZoom = Math.min(Math.max(pinchRef.current.zoom * scale, 0.5), 5);
        zoomRef.current = newZoom;
        if (newZoom <= 1) { panXRef.current = 0; panYRef.current = 0; }
        applyTransformToDOM();
        return;
      }
      if (!isDragging || !dragStartRef.current || e.touches.length !== 1 || zoomRef.current <= 1) return;
      const t = e.touches[0];
      const d = pxToPanXY(t.clientX - dragStartRef.current.x, t.clientY - dragStartRef.current.y);
      const clamped = clampPan(dragStartRef.current.panX + d.dx, dragStartRef.current.panY + d.dy);
      panXRef.current = clamped.x;
      panYRef.current = clamped.y;
      applyTransformToDOM();
    }, [isDragging, pxToPanXY, clampPan, applyTransformToDOM]);
    
    const handleTouchEnd = useCallback(() => {
      pinchRef.current = null;
      setIsDragging(false);
      dragStartRef.current = null;
      syncRefsToState();
    }, [syncRefsToState]);
    
    const resetView = useCallback(() => {
      zoomRef.current = 1; panXRef.current = 0; panYRef.current = 0;
      setZoom(1);
      setPanX(0);
      setPanY(0);
      setSelectZoomMode(false);
      setSelectionRect(null);
      isSelectingRef.current = false;
      selectionStartRef.current = null;
    }, []);
    
    useEffect(() => {
      if (!selectZoomMode) return;
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          setSelectZoomMode(false);
          setSelectionRect(null);
          isSelectingRef.current = false;
          selectionStartRef.current = null;
        }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, [selectZoomMode]);
    
    const wheelSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleWheel = useCallback((e: React.WheelEvent) => {
      e.preventDefault();
      if (e.deltaY < 0) {
        zoomRef.current = Math.min(zoomRef.current + 0.15, 5);
      } else {
        zoomRef.current = Math.max(zoomRef.current - 0.15, 1);
        if (zoomRef.current <= 1) { panXRef.current = 0; panYRef.current = 0; }
      }
      applyTransformToDOM();
      if (wheelSyncRef.current) clearTimeout(wheelSyncRef.current);
      wheelSyncRef.current = setTimeout(() => { wheelSyncRef.current = null; syncRefsToState(); }, 150);
    }, [applyTransformToDOM, syncRefsToState]);
    
    useEffect(() => { zoomRef.current = zoom; }, [zoom]);
    useEffect(() => { panXRef.current = panX; }, [panX]);
    useEffect(() => { panYRef.current = panY; }, [panY]);

    useEffect(() => {
      if (!imageInfo) {
        lastImageRef.current = null;
        spotOverlayCacheRef.current = null;
        segmentOverlayCacheRef.current = null;
        croppedImageCacheRef.current = null;
        previewImageCacheRef.current = null;
        holographicCacheRef.current = null;
        return;
      }
      
      const imageKey = `${imageInfo.image.src}-${imageInfo.image.width}-${imageInfo.image.height}`;
      if (lastImageRef.current === imageKey) return;
      
      // Detect if this is an enhanced version of the same image (same aspect ratio)
      // by checking if the previous image key exists and the file is the same
      const prevKey = lastImageRef.current;
      lastImageRef.current = imageKey;
      spotOverlayCacheRef.current = null;
      segmentOverlayCacheRef.current = null;
      croppedImageCacheRef.current = null;
      previewImageCacheRef.current = null;
      holographicCacheRef.current = null;
      
      // Skip zoom reset for enhancement (same file, different resolution)
      if (prevKey) {
        const prevParts = prevKey.split('-');
        const prevW = parseInt(prevParts[prevParts.length - 2]);
        const prevH = parseInt(prevParts[prevParts.length - 1]);
        if (!isNaN(prevW) && !isNaN(prevH) && prevW > 0 && prevH > 0) {
          const prevRatio = prevW / prevH;
          const newRatio = imageInfo.image.width / imageInfo.image.height;
          if (Math.abs(prevRatio - newRatio) < 0.01) return;
        }
      }
      
      const hasMinimalEmptySpace = checkImageHasMinimalEmptySpace(imageInfo.image);
      if (hasMinimalEmptySpace) {
        setZoom(0.75);
      } else {
        setZoom(1);
      }
    }, [imageInfo]);

    useEffect(() => {
      if (!containerRef.current) return;
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const updateSize = () => {
        const width = containerRef.current?.clientWidth || 0;
        const height = containerRef.current?.clientHeight || 0;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const safeWidth = Math.max(220, Math.round(width * dpr));
        const safeHeight = Math.max(220, Math.round(height * dpr));
        setPreviewDims({
          width: safeWidth || 360,
          height: safeHeight || 360
        });
      };
      updateSize();
      const observer = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(updateSize, 150);
      });
      observer.observe(containerRef.current);
      return () => { observer.disconnect(); if (resizeTimer) clearTimeout(resizeTimer); };
    }, []);
    
    // Check edges using a tiny downsampled version (max 200px) to avoid OOM on large images
    const checkImageHasMinimalEmptySpace = (image: HTMLImageElement): boolean => {
      try {
        const MAX_CHECK_DIM = 200;
        const scale = Math.min(1, MAX_CHECK_DIM / Math.max(image.width, image.height));
        const w = Math.max(1, Math.round(image.width * scale));
        const h = Math.max(1, Math.round(image.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return false;
        ctx.drawImage(image, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;

        const margin = Math.max(2, Math.floor(Math.min(w, h) * 0.05));
        let edges = 0;

        // Top
        outer: for (let y = 0; y < margin; y++) for (let x = 0; x < w; x += 2) { if (data[((y * w + x) * 4) + 3] > 128) { edges++; break outer; } }
        // Bottom
        outer2: for (let y = h - margin; y < h; y++) for (let x = 0; x < w; x += 2) { if (data[((y * w + x) * 4) + 3] > 128) { edges++; break outer2; } }
        // Left
        outer3: for (let x = 0; x < margin; x++) for (let y = 0; y < h; y += 2) { if (data[((y * w + x) * 4) + 3] > 128) { edges++; break outer3; } }
        // Right
        outer4: for (let x = w - margin; x < w; x++) for (let y = 0; y < h; y += 2) { if (data[((y * w + x) * 4) + 3] > 128) { edges++; break outer4; } }

        return edges >= 3;
      } catch {
        return false;
      }
    };
    
    useImperativeHandle(ref, () => {
      const canvas = canvasRef.current!;
      (canvas as any).getContourCanvasInfo = () => {
        if (contourCacheRef.current?.canvas) {
          return {
            width: contourCacheRef.current.canvas.width,
            height: contourCacheRef.current.canvas.height,
            imageCanvasX: contourCacheRef.current.imageCanvasX,
            imageCanvasY: contourCacheRef.current.imageCanvasY,
            downsampleScale: contourCacheRef.current.downsampleScale,
          };
        }
        return null;
      };
      return canvas;
    }, []);

    const getCachedCroppedImage = (): HTMLCanvasElement | HTMLImageElement => {
      if (!imageInfo) return document.createElement('canvas');
      const src = imageInfo.image.src;
      if (croppedImageCacheRef.current?.src === src) {
        return croppedImageCacheRef.current.canvas;
      }
      const totalPx = imageInfo.image.width * imageInfo.image.height;
      const cropped = totalPx <= 4_000_000 ? cropImageToContent(imageInfo.image) : null;
      const result = cropped || imageInfo.image;
      croppedImageCacheRef.current = { src, canvas: result };
      return result;
    };

    const getPreviewImage = (): HTMLCanvasElement | HTMLImageElement => {
      if (!imageInfo) return document.createElement('canvas');
      const img = imageInfo.image;
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const targetDim = Math.max(800, Math.round(Math.max(previewDims.width, previewDims.height) * zoom));
      if (w <= targetDim && h <= targetDim) return img;
      const src = img.src;
      const scale = Math.min(targetDim / w, targetDim / h);
      const pw = Math.round(w * scale);
      const ph = Math.round(h * scale);
      if (previewImageCacheRef.current?.src === src && previewImageCacheRef.current.w === pw && previewImageCacheRef.current.h === ph) {
        return previewImageCacheRef.current.canvas;
      }
      const c = document.createElement('canvas');
      c.width = pw;
      c.height = ph;
      const cx = c.getContext('2d');
      if (cx) {
        cx.imageSmoothingEnabled = true;
        cx.imageSmoothingQuality = 'high';
        cx.drawImage(img, 0, 0, pw, ph);
      }
      previewImageCacheRef.current = { src, w: pw, h: ph, canvas: c };
      return c;
    };

    // Version bump forces cache invalidation when worker code changes
    const CONTOUR_CACHE_VERSION = 18;
    const generateContourCacheKey = useCallback(() => {
      if (!imageInfo) return '';
      const bboxKey = detectedShapeInfo ? `${detectedShapeInfo.boundingBox.x},${detectedShapeInfo.boundingBox.y},${detectedShapeInfo.boundingBox.width},${detectedShapeInfo.boundingBox.height}` : 'none';
      return `v${CONTOUR_CACHE_VERSION}-${imageInfo.image.src}-${imageInfo.originalWidth}x${imageInfo.originalHeight}-${strokeSettings.width}-${strokeSettings.alphaThreshold}-${strokeSettings.backgroundColor}-${strokeSettings.useCustomBackground}-${strokeSettings.contourMode}-${strokeSettings.autoBridging}-${strokeSettings.autoBridgingThreshold}-${strokeSettings.includeHoles}-${resizeSettings.widthInches}-${resizeSettings.heightInches}-shape:${detectedShapeType || 'none'}-bbox:${bboxKey}`;
    }, [imageInfo, strokeSettings.width, strokeSettings.alphaThreshold, strokeSettings.backgroundColor, strokeSettings.useCustomBackground, strokeSettings.contourMode, strokeSettings.autoBridging, strokeSettings.autoBridgingThreshold, strokeSettings.includeHoles, resizeSettings.widthInches, resizeSettings.heightInches, detectedShapeType, detectedShapeInfo]);

    useEffect(() => {
      // Clear any pending debounce
      if (contourDebounceRef.current) {
        clearTimeout(contourDebounceRef.current);
        contourDebounceRef.current = null;
      }
      
      if (!imageInfo || !strokeSettings.enabled || shapeSettings.enabled) {
        contourCacheRef.current = null;
        contourTransformRef.current = null;
        return;
      }

      const cacheKey = generateContourCacheKey();
      if (contourCacheRef.current?.key === cacheKey) return;

      contourCacheRef.current = null;
      contourTransformRef.current = null;

      // Invalidate any in-flight processing results immediately so stale
      // worker responses (e.g. after image enhancement) are discarded.
      ++processingIdRef.current;

      // Debounce processing to avoid rapid re-renders during slider drags
      contourDebounceRef.current = setTimeout(() => {
        const currentId = ++processingIdRef.current;
        setIsProcessing(true);
        setProcessingProgress(0);

        const previewStrokeSettings = { ...strokeSettings, color: '#FF00FF' };
        const workerResizeSettings = {
          widthInches: resizeSettings.widthInches,
          heightInches: resizeSettings.heightInches,
          maintainAspectRatio: resizeSettings.maintainAspectRatio,
          outputDPI: 100
        };

        processContourInWorker(
          imageInfo.image,
          previewStrokeSettings,
          workerResizeSettings,
          (progress) => {
            if (processingIdRef.current === currentId) {
              setProcessingProgress(progress);
            }
          },
          detectedShapeType,
          detectedShapeInfo
        ).then((result) => {
          if (processingIdRef.current === currentId) {
            contourCacheRef.current = { key: cacheKey, canvas: result.canvas, downsampleScale: result.downsampleScale, imageCanvasX: result.imageCanvasX, imageCanvasY: result.imageCanvasY };
            setIsProcessing(false);
            if (result.detectedAlgorithm && onDetectedAlgorithm) {
              onDetectedAlgorithm(result.detectedAlgorithm);
            }
          }
        }).catch((error) => {
          console.error('Contour processing error:', error);
          if (processingIdRef.current === currentId) {
            setIsProcessing(false);
          }
        });
      }, 100); // 100ms debounce for smoother slider interaction
      
      return () => {
        if (contourDebounceRef.current) {
          clearTimeout(contourDebounceRef.current);
        }
      };
    }, [imageInfo, strokeSettings, resizeSettings, shapeSettings.enabled, generateContourCacheKey, detectedShapeType, detectedShapeInfo]);

    // Smooth resize animation: detects dimension changes and animates the canvas
    useLayoutEffect(() => {
      if (!imageInfo) {
        prevResizeDimsRef.current = null;
        return;
      }

      const cur = { w: resizeSettings.widthInches, h: resizeSettings.heightInches };
      const prev = prevResizeDimsRef.current;
      prevResizeDimsRef.current = cur;

      if (!prev) return;
      if (prev.w === cur.w && prev.h === cur.h) return;

      // Scale ratio based on longest dimension change for natural visual scaling
      const oldMax = Math.max(prev.w, prev.h);
      const newMax = Math.max(cur.w, cur.h);
      const scaleRatio = oldMax / newMax;
      const startScale = Math.max(0.82, Math.min(1.18, scaleRatio));

      // Immediately set the "from" state (no CSS transition yet)
      setResizeAnimState({ scale: startScale, opacity: 0.55, transitioning: false });

      // After the browser paints the "from" state, enable the CSS transition to animate to the final state
      if (resizeAnimRafRef.current) cancelAnimationFrame(resizeAnimRafRef.current);
      resizeAnimRafRef.current = requestAnimationFrame(() => {
        resizeAnimRafRef.current = requestAnimationFrame(() => {
          setResizeAnimState({ scale: 1, opacity: 1, transitioning: true });
          resizeAnimRafRef.current = null;
        });
      });

      // Clear animation state after transition completes
      if (resizeAnimTimeoutRef.current) clearTimeout(resizeAnimTimeoutRef.current);
      resizeAnimTimeoutRef.current = setTimeout(() => {
        setResizeAnimState(null);
      }, 420);

      return () => {
        if (resizeAnimRafRef.current) {
          cancelAnimationFrame(resizeAnimRafRef.current);
          resizeAnimRafRef.current = null;
        }
        if (resizeAnimTimeoutRef.current) {
          clearTimeout(resizeAnimTimeoutRef.current);
          resizeAnimTimeoutRef.current = null;
        }
      };
    }, [resizeSettings.widthInches, resizeSettings.heightInches, imageInfo]);

    useEffect(() => {
      if (!canvasRef.current || !imageInfo) return;

      const doRender = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const canvasWidth = previewDims.width;
      const canvasHeight = previewDims.height;
      if (lastCanvasDimsRef.current.width !== canvasWidth || lastCanvasDimsRef.current.height !== canvasHeight) {
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        lastCanvasDimsRef.current = { width: canvasWidth, height: canvasHeight };
      } else {
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      }

      // Determine which background color to use:
      // - For PDFs with CutContour, use strokeSettings.backgroundColor
      // - For regular images, use local backgroundColor state
      const hasPdfCutContour = imageInfo.isPDF && imageInfo.pdfCutContourInfo?.hasCutContour;
      const effectiveBackgroundColor = hasPdfCutContour 
        ? strokeSettings.backgroundColor 
        : backgroundColor;

      // For PDFs with CutContour, we need special rendering to clip background to the cut path
      if (hasPdfCutContour && imageInfo.pdfCutContourInfo) {
        const cutContourInfo = imageInfo.pdfCutContourInfo;
        const hasExtractedPaths = cutContourInfo.cutContourPoints && cutContourInfo.cutContourPoints.length > 0;
        const viewPadding = 0;
        const availableWidth = canvas.width;
        const availableHeight = canvas.height;
        
        // Get actual content bounds of the rendered PDF (removes empty space and white background)
        const contentBounds = getImageBounds(imageInfo.image);
        
        // Use content bounds for sizing, not full PDF page size
        const contentWidth = contentBounds.width;
        const contentHeight = contentBounds.height;
        const scaleX = availableWidth / contentWidth;
        const scaleY = availableHeight / contentHeight;
        const scale = Math.min(scaleX, scaleY);
        
        const scaledWidth = contentWidth * scale;
        const scaledHeight = contentHeight * scale;
        const offsetX = viewPadding + (availableWidth - scaledWidth) / 2;
        const offsetY = viewPadding + (availableHeight - scaledHeight) / 2;
        
        // Store content bounds offset for image drawing
        const contentOffsetX = contentBounds.x;
        const contentOffsetY = contentBounds.y;
        
        // Bleed offset based on content scale (0.10 inches at render DPI)
        const bleedInches = 0.10;
        const renderDPI = imageInfo.pdfCutContourInfo.pageWidth ? 
          (imageInfo.image.naturalWidth / (imageInfo.pdfCutContourInfo.pageWidth / 72 * 72)) : 300;
        const bleedPixelsAtRender = bleedInches * renderDPI;
        const bleedPixels = bleedPixelsAtRender * scale;
        
        // Create clipping path - use extracted paths if available, otherwise use image bounds
        ctx.save();
        ctx.beginPath();
        
        if (hasExtractedPaths) {
          // Use extracted CutContour paths with bleed expansion
          for (const path of cutContourInfo.cutContourPoints) {
            if (path.length < 2) continue;
            
            // Calculate centroid of path for offset direction
            let cx = 0, cy = 0;
            for (const pt of path) {
              cx += offsetX + pt.x * scale;
              cy += offsetY + pt.y * scale;
            }
            cx /= path.length;
            cy /= path.length;
            
            // Draw path with bleed expansion (offset away from centroid)
            const firstX = offsetX + path[0].x * scale;
            const firstY = offsetY + path[0].y * scale;
            const firstDist = Math.sqrt((firstX - cx) ** 2 + (firstY - cy) ** 2);
            const firstExpandX = firstDist > 0 ? (firstX - cx) / firstDist * bleedPixels : 0;
            const firstExpandY = firstDist > 0 ? (firstY - cy) / firstDist * bleedPixels : 0;
            
            ctx.moveTo(firstX + firstExpandX, firstY + firstExpandY);
            
            for (let i = 1; i < path.length; i++) {
              const px = offsetX + path[i].x * scale;
              const py = offsetY + path[i].y * scale;
              const dist = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
              const expandX = dist > 0 ? (px - cx) / dist * bleedPixels : 0;
              const expandY = dist > 0 ? (py - cy) / dist * bleedPixels : 0;
              ctx.lineTo(px + expandX, py + expandY);
            }
            ctx.closePath();
          }
        } else {
          // Fallback: use image bounds with bleed for clipping
          const clipX = offsetX - bleedPixels;
          const clipY = offsetY - bleedPixels;
          const clipW = scaledWidth + bleedPixels * 2;
          const clipH = scaledHeight + bleedPixels * 2;
          ctx.rect(clipX, clipY, clipW, clipH);
          ctx.closePath();
          
          // Fill background color for the fallback rect area directly
          if (effectiveBackgroundColor !== "transparent") {
            if (effectiveBackgroundColor === "holographic") {
              const gradient = ctx.createLinearGradient(clipX, clipY, clipX + clipW, clipY + clipH);
              gradient.addColorStop(0, '#C8C8D0');
              gradient.addColorStop(0.17, '#E8B8B8');
              gradient.addColorStop(0.34, '#B8D8E8');
              gradient.addColorStop(0.51, '#E8D0F0');
              gradient.addColorStop(0.68, '#B0C8E0');
              gradient.addColorStop(0.85, '#C0B0D8');
              gradient.addColorStop(1, '#C8C8D0');
              ctx.fillStyle = gradient;
            } else {
              ctx.fillStyle = effectiveBackgroundColor;
            }
            ctx.fillRect(clipX, clipY, clipW, clipH);
          }
          
          // Clip and draw only the content portion of the image
          ctx.clip();
          ctx.drawImage(
            imageInfo.image,
            contentOffsetX, contentOffsetY, contentWidth, contentHeight,
            offsetX, offsetY, scaledWidth, scaledHeight
          );
          ctx.restore();
          
          // Draw image bounds as cut indicator
          ctx.save();
          ctx.strokeStyle = '#FF00FF';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          ctx.strokeRect(offsetX, offsetY, scaledWidth, scaledHeight);
          ctx.restore();
          return; // Early return for fallback case
        }
        
        // For extracted paths: fill the path, then clip for the image
        if (effectiveBackgroundColor !== "transparent") {
          if (effectiveBackgroundColor === "holographic") {
            const bounds = ctx.getTransform();
            const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
            gradient.addColorStop(0, '#C8C8D0');
            gradient.addColorStop(0.17, '#E8B8B8');
            gradient.addColorStop(0.34, '#B8D8E8');
            gradient.addColorStop(0.51, '#E8D0F0');
            gradient.addColorStop(0.68, '#B0C8E0');
            gradient.addColorStop(0.85, '#C0B0D8');
            gradient.addColorStop(1, '#C8C8D0');
            ctx.fillStyle = gradient;
          } else {
            ctx.fillStyle = effectiveBackgroundColor;
          }
          ctx.fill();
        }
        
        ctx.clip();
        
        // Draw only the content portion of the image inside the clipped region
        ctx.drawImage(
          imageInfo.image,
          contentOffsetX, contentOffsetY, contentWidth, contentHeight,
          offsetX, offsetY, scaledWidth, scaledHeight
        );
        
        ctx.restore();
        
        // Draw the CutContour path indicator (magenta dashed line) with curve detection
        if (hasExtractedPaths) {
          ctx.save();
          ctx.strokeStyle = '#FF00FF';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          
          for (const path of cutContourInfo.cutContourPoints) {
            if (path.length < 2) continue;
            ctx.beginPath();
            
            // Smooth the contour first to reduce jagged edges from alpha tracing
            const smoothedPath = gaussianSmoothContour(path, 2);
            
            // Convert path to curves for smooth rendering (60+ point curves)
            const segments = convertPolygonToCurves(smoothedPath, 70);
            
            for (const seg of segments) {
              if (seg.type === 'move' && seg.point) {
                ctx.moveTo(offsetX + seg.point.x * scale, offsetY + seg.point.y * scale);
              } else if (seg.type === 'line' && seg.point) {
                ctx.lineTo(offsetX + seg.point.x * scale, offsetY + seg.point.y * scale);
              } else if (seg.type === 'curve' && seg.cp1 && seg.cp2 && seg.end) {
                ctx.bezierCurveTo(
                  offsetX + seg.cp1.x * scale, offsetY + seg.cp1.y * scale,
                  offsetX + seg.cp2.x * scale, offsetY + seg.cp2.y * scale,
                  offsetX + seg.end.x * scale, offsetY + seg.end.y * scale
                );
              }
            }
            
            ctx.closePath();
            ctx.stroke();
          }
          
          ctx.restore();
        } else {
          // Draw image bounds as cut indicator when no paths extracted
          ctx.save();
          ctx.strokeStyle = '#FF00FF';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          ctx.strokeRect(offsetX, offsetY, scaledWidth, scaledHeight);
          ctx.restore();
        }
      } else {
        if (shapeSettings.enabled) {
          drawShapePreview(ctx, canvas.width, canvas.height);
        } else if (effectiveBackgroundColor === "transparent") {
          drawImageWithResizePreview(ctx, canvas.width, canvas.height);
        } else {
          if (effectiveBackgroundColor === "holographic") {
            const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
            gradient.addColorStop(0, '#C8C8D0');
            gradient.addColorStop(0.17, '#E8B8B8');
            gradient.addColorStop(0.34, '#B8D8E8');
            gradient.addColorStop(0.51, '#E8D0F0');
            gradient.addColorStop(0.68, '#B0C8E0');
            gradient.addColorStop(0.85, '#C0B0D8');
            gradient.addColorStop(1, '#C8C8D0');
            ctx.fillStyle = gradient;
          } else {
            ctx.fillStyle = effectiveBackgroundColor;
          }
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          drawImageWithResizePreview(ctx, canvas.width, canvas.height);
        }

      }
      
      if (lockedContour && lockedContour.previewPathPoints.length > 2 && canvas) {
        // Collect all path arrays to draw (multi-path for zero hero, single for normal)
        const pathArrays: Array<Array<{x: number; y: number}>> =
          lockedContour.allPreviewPathPoints && lockedContour.allPreviewPathPoints.length > 0
            ? lockedContour.allPreviewPathPoints
            : [lockedContour.previewPathPoints];

        // Compute transform parameters once
        let transformPts: (pts: Array<{x: number; y: number}>) => Array<{x: number; y: number}>;

        if (shapeSettings.enabled && imageInfo) {
          let shapeDims = calculateShapeDimensions(
            resizeSettings.widthInches, resizeSettings.heightInches, shapeSettings.type, shapeSettings.offset
          );
          if (shapeSettings.shapeWidthOverride && shapeSettings.shapeWidthOverride > 0) shapeDims = { widthInches: shapeSettings.shapeWidthOverride, heightInches: shapeDims.heightInches };
          if (shapeSettings.shapeHeightOverride && shapeSettings.shapeHeightOverride > 0) shapeDims = { widthInches: shapeDims.widthInches, heightInches: shapeSettings.shapeHeightOverride };
          const viewPad = Math.max(4, Math.round(Math.min(canvas.width, canvas.height) * 0.03));
          const availW = canvas.width - (viewPad * 2);
          const availH = canvas.height - (viewPad * 2);
          const shapeAspect = shapeDims.widthInches / shapeDims.heightInches;
          let shapeW: number, shapeH: number;
          if (shapeAspect > (availW / availH)) {
            shapeW = availW;
            shapeH = availW / shapeAspect;
          } else {
            shapeH = availH;
            shapeW = availH * shapeAspect;
          }
          const shapeX = (canvas.width - shapeW) / 2;
          const shapeY = (canvas.height - shapeH) / 2;
          const ppi = Math.min(shapeW / shapeDims.widthInches, shapeH / shapeDims.heightInches);
          const imgW = resizeSettings.widthInches * ppi;
          const imgH = resizeSettings.heightInches * ppi;
          const imgX = shapeX + (shapeW - imgW) / 2;
          const imgY = shapeY + (shapeH - imgH) / 2;

          const icx = lockedContour.imageCanvasX;
          const icy = lockedContour.imageCanvasY;
          const icw = lockedContour.imageCanvasWidth;
          const ich = lockedContour.imageCanvasHeight;
          const sxScale = imgW / icw;
          const syScale = imgH / ich;
          
          transformPts = (pts) => pts.map(p => ({
            x: imgX + (p.x - icx) * sxScale,
            y: imgY + (p.y - icy) * syScale,
          }));
        } else if (contourTransformRef.current) {
          const ct = contourTransformRef.current;
          const sxScale = ct.width / lockedContour.contourCanvasWidth;
          const syScale = ct.height / lockedContour.contourCanvasHeight;
          transformPts = (pts) => pts.map(p => ({
            x: ct.x + p.x * sxScale,
            y: ct.y + p.y * syScale,
          }));
        } else {
          const availW = canvas.width;
          const availH = canvas.height;
          const lcAspect = lockedContour.contourCanvasWidth / lockedContour.contourCanvasHeight;
          let lcW: number, lcH: number;
          if (lcAspect > (availW / availH)) {
            lcW = availW;
            lcH = availW / lcAspect;
          } else {
            lcH = availH;
            lcW = availH * lcAspect;
          }
          const lcX = (canvas.width - lcW) / 2;
          const lcY = (canvas.height - lcH) / 2;
          const sxScale = lcW / lockedContour.contourCanvasWidth;
          const syScale = lcH / lockedContour.contourCanvasHeight;
          transformPts = (pts) => pts.map(p => ({
            x: lcX + p.x * sxScale,
            y: lcY + p.y * syScale,
          }));
        }

        // Draw each contour path
        for (const pathPts of pathArrays) {
          if (pathPts.length < 3) continue;
          const screenPts = transformPts(pathPts);
          if (screenPts.length > 2) {
            ctx.save();
            ctx.strokeStyle = '#3B82F6';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            ctx.moveTo(screenPts[0].x, screenPts[0].y);
            for (let i = 1; i < screenPts.length; i++) {
              ctx.lineTo(screenPts[i].x, screenPts[i].y);
            }
            ctx.closePath();
            ctx.stroke();
            ctx.restore();
          }
        }
      }
      };
      renderRef.current = doRender;
      if (renderRafRef.current) cancelAnimationFrame(renderRafRef.current);
      renderRafRef.current = requestAnimationFrame(() => {
        renderRafRef.current = null;
        doRender();
      });
      return () => {
        if (renderRafRef.current) { cancelAnimationFrame(renderRafRef.current); renderRafRef.current = null; }
      };
    }, [imageInfo, strokeSettings, resizeSettings, shapeSettings, cadCutBounds, backgroundColor, isProcessing, spotPreviewData, previewDims.height, previewDims.width, lockedContour, segmentationData]);

    useEffect(() => {
      if (!spotPreviewData?.enabled) {
        spotPulseRef.current = 1;
        if (spotAnimFrameRef.current !== null) {
          cancelAnimationFrame(spotAnimFrameRef.current);
          spotAnimFrameRef.current = null;
        }
        return;
      }
      
      spotPulseRef.current = 1;
      if (spotAnimFrameRef.current !== null) {
        cancelAnimationFrame(spotAnimFrameRef.current);
        spotAnimFrameRef.current = null;
      }
      if (renderRef.current) renderRef.current();
    }, [spotPreviewData]);

    useEffect(() => {
      segmentOverlayCacheRef.current = null;
      if (segmentationData?.enabled && segmentationData.layers.length > 0) {
        for (const layer of segmentationData.layers) {
          if (!segmentMaskImagesRef.current.has(layer.id)) {
            const img = new Image();
            img.src = layer.maskDataUrl;
            img.onload = () => {
              if (renderRef.current) renderRef.current();
            };
            segmentMaskImagesRef.current.set(layer.id, img);
          }
        }
      }
      if (renderRef.current) renderRef.current();
    }, [segmentationData]);

    const createSpotOverlayCanvas = (source?: HTMLImageElement | HTMLCanvasElement): HTMLCanvasElement | null => {
      if (!imageInfo || !spotPreviewData?.enabled) return null;
      
      const colors = spotPreviewData.colors;
      const hasAny = colors.some(c => c.spotWhite || c.spotGloss);
      if (!hasAny) return null;
      
      const regionKey = (c: typeof colors[0]) =>
        c.hex + (c.regions ? ':' + c.regions.map(r => `${r.spotWhite ? 'w' : ''}${r.spotGloss ? 'g' : ''}`).join('') : '');
      const cacheKey = `pm-${colors.map(c => `${regionKey(c)}:${c.spotWhite}:${c.spotGloss}`).join(',')}`;
      
      if (spotOverlayCacheRef.current?.key === cacheKey) {
        return spotOverlayCacheRef.current.canvas;
      }

      const pixelMap = spotPreviewData.pixelMap;
      const mapW = spotPreviewData.mapWidth ?? 0;
      const mapH = spotPreviewData.mapHeight ?? 0;

      const w = mapW || imageInfo.image.width;
      const h = mapH || imageInfo.image.height;
      
      const overlayCanvas = document.createElement('canvas');
      overlayCanvas.width = w;
      overlayCanvas.height = h;
      const overlayCtx = overlayCanvas.getContext('2d');
      if (!overlayCtx) return null;
      
      const overlayData = overlayCtx.createImageData(w, h);
      const out = overlayData.data;

      // Build per-color overlay info with per-region spot support
      const colorOverlay: Array<{
        colorR: number; colorG: number; colorB: number;
        regionMap?: Int32Array;
        regionSpot?: Array<{ oR: number; oG: number; oB: number } | null>;
        hasPerRegionSpot: boolean;
      } | null> = colors.map(c => {
        const hasRegions = c.regions && c.regions.length > 0;
        const hasPerRegionSpot = hasRegions ? c.regions!.some(r => r.spotWhite || r.spotGloss) : false;

        if (!c.spotWhite && !c.spotGloss && !hasPerRegionSpot) return null;

        let cR = 0, cG = 0, cB = 0;
        if (c.spotWhite && c.spotGloss) { cR = 234; cG = 179; cB = 8; }
        else if (c.spotWhite) { cR = 249; cG = 115; cB = 22; }
        else if (c.spotGloss) { cR = 20; cG = 184; cB = 166; }

        let regionSpot: Array<{ oR: number; oG: number; oB: number } | null> | undefined;

        if (hasRegions) {
          const maxId = Math.max(...c.regions!.map(rg => rg.id));
          regionSpot = new Array(maxId + 1).fill(null);
          const anyRegionHasExplicitSpot = c.regions!.some(rg => rg.spotWhite !== undefined || rg.spotGloss !== undefined);
          for (const rg of c.regions!) {
            const rw = anyRegionHasExplicitSpot ? (rg.spotWhite ?? false) : (rg.spotWhite ?? c.spotWhite);
            const rg2 = anyRegionHasExplicitSpot ? (rg.spotGloss ?? false) : (rg.spotGloss ?? c.spotGloss);
            if (rw && rg2) regionSpot[rg.id] = { oR: 234, oG: 179, oB: 8 };
            else if (rw) regionSpot[rg.id] = { oR: 249, oG: 115, oB: 22 };
            else if (rg2) regionSpot[rg.id] = { oR: 20, oG: 184, oB: 166 };
            else regionSpot[rg.id] = null;
          }
        }

        return { colorR: cR, colorG: cG, colorB: cB, regionMap: c.regionMap, regionSpot, hasPerRegionSpot };
      });

      if (pixelMap && pixelMap.length === w * h) {
        const totalPixels = w * h;
        for (let i = 0; i < totalPixels; i++) {
          const ci = pixelMap[i];
          if (ci < 0) continue;
          const info = colorOverlay[ci];
          if (!info) continue;

          let oR = info.colorR, oG = info.colorG, oB = info.colorB;
          let show = true;

          if (info.regionMap) {
            const regionId = info.regionMap[i];
            if (regionId < 0) { show = false; }
            else if (info.regionSpot) {
              const rs = info.regionSpot[regionId];
              if (!rs) { show = false; } else { oR = rs.oR; oG = rs.oG; oB = rs.oB; }
            }
          }

          if (!show) continue;
          const off = i * 4;
          out[off] = oR;
          out[off + 1] = oG;
          out[off + 2] = oB;
          out[off + 3] = 255;
        }
      } else {
        // Fallback: tolerance-based matching (for when pixelMap isn't available)
        const img = source || imageInfo.image;
        const srcCanvas = document.createElement('canvas');
        const srcCtx = srcCanvas.getContext('2d');
        if (!srcCtx) return null;
        srcCanvas.width = w;
        srcCanvas.height = h;
        srcCtx.drawImage(img, 0, 0);
        const srcData = srcCtx.getImageData(0, 0, w, h);
        const pixels = srcData.data;
        const tol = 30;
        const len = pixels.length;
        for (let idx = 0; idx < len; idx += 4) {
          if (pixels[idx + 3] < 128) continue;
          const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
          for (let ci = 0; ci < colors.length; ci++) {
            const info = colorOverlay[ci];
            if (!info) continue;
            const c = colors[ci].rgb;
            if (Math.abs(r - c.r) <= tol && Math.abs(g - c.g) <= tol && Math.abs(b - c.b) <= tol) {
              const pixelIndex = idx / 4;
              let fR = info.colorR, fG = info.colorG, fB = info.colorB;
              let skip = false;
              if (info.regionMap) {
                const regionId = info.regionMap[pixelIndex];
                if (regionId < 0) { skip = true; }
                else if (info.regionSpot) {
                  const rs = info.regionSpot[regionId];
                  if (!rs) { skip = true; } else { fR = rs.oR; fG = rs.oG; fB = rs.oB; }
                }
              }
              if (skip) break;
              out[idx] = fR; out[idx + 1] = fG; out[idx + 2] = fB; out[idx + 3] = 255;
              break;
            }
          }
        }
      }
      
      overlayCtx.putImageData(overlayData, 0, 0);
      spotOverlayCacheRef.current = { key: cacheKey, canvas: overlayCanvas };
      return overlayCanvas;
    };

    const createSegmentOverlayCanvas = (): HTMLCanvasElement | null => {
      if (!imageInfo || !segmentationData?.enabled || segmentationData.mode !== 'items') return null;

      const visibleLayers = segmentationData.layers.filter(l => l.visible);
      if (visibleLayers.length === 0) return null;

      const cacheKey = `seg-${visibleLayers.map(l => `${l.id}:${l.spotWhite}:${l.spotGloss}:${l.visible}`).join(',')}`;
      if (segmentOverlayCacheRef.current?.key === cacheKey) {
        return segmentOverlayCacheRef.current.canvas;
      }

      const w = imageInfo.image.width;
      const h = imageInfo.image.height;

      const overlayCanvas = document.createElement('canvas');
      overlayCanvas.width = w;
      overlayCanvas.height = h;
      const overlayCtx = overlayCanvas.getContext('2d');
      if (!overlayCtx) return null;

      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = w;
      tempCanvas.height = h;
      const tempCtx = tempCanvas.getContext('2d');
      if (!tempCtx) return null;

      for (const layer of visibleLayers) {
        if (!layer.spotWhite && !layer.spotGloss) continue;

        let maskImg = segmentMaskImagesRef.current.get(layer.id);
        if (!maskImg || maskImg.src !== layer.maskDataUrl) {
          maskImg = new Image();
          maskImg.src = layer.maskDataUrl;
          segmentMaskImagesRef.current.set(layer.id, maskImg);
        }

        if (!maskImg.complete || maskImg.naturalWidth === 0) continue;

        tempCtx.clearRect(0, 0, w, h);
        tempCtx.drawImage(maskImg, 0, 0, w, h);
        const maskData = tempCtx.getImageData(0, 0, w, h);
        const pixels = maskData.data;

        for (let i = 0; i < pixels.length; i += 4) {
          const brightness = pixels[i] + pixels[i + 1] + pixels[i + 2];
          if (brightness > 128 * 3 && pixels[i + 3] > 128) {
            if (layer.spotWhite) {
              pixels[i] = 255;
              pixels[i + 1] = 0;
              pixels[i + 2] = 255;
              pixels[i + 3] = 200;
            } else if (layer.spotGloss) {
              pixels[i] = 57;
              pixels[i + 1] = 255;
              pixels[i + 2] = 20;
              pixels[i + 3] = 200;
            }
          } else {
            pixels[i + 3] = 0;
          }
        }

        tempCtx.putImageData(maskData, 0, 0);
        overlayCtx.drawImage(tempCanvas, 0, 0);
      }

      segmentOverlayCacheRef.current = { key: cacheKey, canvas: overlayCanvas };
      return overlayCanvas;
    };

    useEffect(() => {
      if (!imageInfo) return;
      const settingsKey = `${strokeSettings.enabled}-${strokeSettings.width}-${shapeSettings.enabled}-${shapeSettings.type}-${resizeSettings.widthInches}`;
      if (lastSettingsRef.current && lastSettingsRef.current !== settingsKey) {
        setShowHighlight(true);
        const timer = setTimeout(() => setShowHighlight(false), 500);
        return () => clearTimeout(timer);
      }
      lastSettingsRef.current = settingsKey;
    }, [imageInfo, strokeSettings.enabled, strokeSettings.width, shapeSettings.enabled, shapeSettings.type, resizeSettings.widthInches]);

    const drawShapePreview = (ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number) => {
      if (!imageInfo) return;

      let shapeDims = calculateShapeDimensions(
        resizeSettings.widthInches, resizeSettings.heightInches, shapeSettings.type, shapeSettings.offset
      );
      if (shapeSettings.shapeWidthOverride && shapeSettings.shapeWidthOverride > 0) {
        shapeDims = { widthInches: shapeSettings.shapeWidthOverride, heightInches: shapeDims.heightInches };
      }
      if (shapeSettings.shapeHeightOverride && shapeSettings.shapeHeightOverride > 0) {
        shapeDims = { widthInches: shapeDims.widthInches, heightInches: shapeSettings.shapeHeightOverride };
      }

      const bleedInches = 0.10;
      const shapeAspect = shapeDims.widthInches / shapeDims.heightInches;
      const availableWidth = canvasWidth;
      const availableHeight = canvasHeight;

      let shapeWidth: number, shapeHeight: number;
      if (shapeAspect > (availableWidth / availableHeight)) {
        shapeWidth = availableWidth;
        shapeHeight = availableWidth / shapeAspect;
      } else {
        shapeHeight = availableHeight;
        shapeWidth = availableHeight * shapeAspect;
      }

      const shapeX = (canvasWidth - shapeWidth) / 2;
      const shapeY = (canvasHeight - shapeHeight) / 2;
      const ppi = Math.min(shapeWidth / shapeDims.widthInches, shapeHeight / shapeDims.heightInches);
      const bleedPx = shapeSettings.bleedEnabled ? bleedInches * ppi : 0;
      const cornerRadiusPx = (shapeSettings.cornerRadius || 0.25) * ppi;
      const rotation = shapeSettings.rotation || 0;
      const centerX = shapeX + shapeWidth / 2;
      const centerY = shapeY + shapeHeight / 2;

      const sourceImage = getPreviewImage();
      const imgScale = shapeSettings.imageScale || 1;
      let imageWidth = resizeSettings.widthInches * ppi * imgScale;
      let imageHeight = resizeSettings.heightInches * ppi * imgScale;
      const imageX = shapeX + (shapeWidth - imageWidth) / 2 + (shapeSettings.imageOffsetX || 0) * ppi;
      const imageY = shapeY + (shapeHeight - imageHeight) / 2 + (shapeSettings.imageOffsetY || 0) * ppi;

      const buildPath = (ctx: CanvasRenderingContext2D, sw: number, sh: number, sx: number, sy: number, cr: number) => {
        const type = shapeSettings.type;
        ctx.beginPath();
        if (type === 'circle') {
          const r = Math.min(sw, sh) / 2;
          ctx.arc(sx + sw / 2, sy + sh / 2, r, 0, Math.PI * 2);
        } else if (type === 'oval') {
          ctx.ellipse(sx + sw / 2, sy + sh / 2, sw / 2, sh / 2, 0, 0, Math.PI * 2);
        } else if (type === 'square') {
          const size = Math.min(sw, sh);
          ctx.rect(sx + (sw - size) / 2, sy + (sh - size) / 2, size, size);
        } else if (type === 'rounded-square') {
          const size = Math.min(sw, sh);
          ctx.roundRect(sx + (sw - size) / 2, sy + (sh - size) / 2, size, size, cr);
        } else if (type === 'rounded-rectangle') {
          ctx.roundRect(sx, sy, sw, sh, cr);
        } else {
          ctx.rect(sx, sy, sw, sh);
        }
      };

      const applyRotation = () => {
        if (rotation !== 0) {
          ctx.translate(centerX, centerY);
          ctx.rotate(rotation * Math.PI / 180);
          ctx.translate(-centerX, -centerY);
        }
      };

      // Bleed fill
      if (shapeSettings.bleedEnabled) {
        ctx.save();
        applyRotation();
        ctx.fillStyle = shapeSettings.bleedColor || '#FFFFFF';
        buildPath(ctx, shapeWidth + bleedPx * 2, shapeHeight + bleedPx * 2, shapeX - bleedPx, shapeY - bleedPx, cornerRadiusPx);
        ctx.fill();
        ctx.restore();
      }

      // Inner fill
      ctx.save();
      applyRotation();
      if (shapeSettings.fillColor === 'holographic') {
        const gradient = ctx.createLinearGradient(shapeX, shapeY, shapeX + shapeWidth, shapeY + shapeHeight);
        gradient.addColorStop(0, '#C8C8D0'); gradient.addColorStop(0.17, '#E8B8B8');
        gradient.addColorStop(0.34, '#B8D8E8'); gradient.addColorStop(0.51, '#E8D0F0');
        gradient.addColorStop(0.68, '#B0C8E0'); gradient.addColorStop(0.85, '#C0B0D8');
        gradient.addColorStop(1, '#C8C8D0');
        ctx.fillStyle = gradient;
      } else {
        ctx.fillStyle = shapeSettings.fillColor;
      }
      buildPath(ctx, shapeWidth, shapeHeight, shapeX, shapeY, cornerRadiusPx);
      ctx.fill();
      ctx.restore();

      // Border/stroke (visible printed border)
      if (shapeSettings.strokeEnabled) {
        ctx.save();
        applyRotation();
        ctx.strokeStyle = shapeSettings.strokeColor || '#000000';
        ctx.lineWidth = (shapeSettings.strokeWidth || 1) * (ppi / 72);
        buildPath(ctx, shapeWidth, shapeHeight, shapeX, shapeY, cornerRadiusPx);
        ctx.stroke();
        ctx.restore();
      }

      // CutContour outline
      ctx.save();
      applyRotation();
      ctx.strokeStyle = '#FF00FF';
      ctx.lineWidth = 2;
      buildPath(ctx, shapeWidth, shapeHeight, shapeX, shapeY, cornerRadiusPx);
      ctx.stroke();
      ctx.restore();

      // Clipped image
      ctx.save();
      applyRotation();
      buildPath(ctx, shapeWidth, shapeHeight, shapeX, shapeY, cornerRadiusPx);
      ctx.clip();
      ctx.drawImage(sourceImage, imageX, imageY, imageWidth, imageHeight);
      lastImageRenderRef.current = { x: imageX, y: imageY, width: imageWidth, height: imageHeight };

      if (segmentationData?.mode === 'items') {
        const segOverlay = createSegmentOverlayCanvas();
        if (segOverlay) {
          ctx.save();
          ctx.globalAlpha = spotPulseRef.current;
          ctx.drawImage(segOverlay, imageX, imageY, imageWidth, imageHeight);
          ctx.restore();
        }
      } else {
        const spotOverlay = createSpotOverlayCanvas(sourceImage);
        if (spotOverlay) {
          ctx.save();
          ctx.globalAlpha = spotPulseRef.current;
          ctx.drawImage(spotOverlay, imageX, imageY, imageWidth, imageHeight);
          ctx.restore();
        }
      }
      ctx.restore();
    };

    const drawImageWithResizePreview = (ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number) => {
      if (!imageInfo) return;

      const viewPadding = 0;
      const availableWidth = canvasWidth;
      const availableHeight = canvasHeight;
      
      if (strokeSettings.enabled && contourCacheRef.current?.canvas && !isProcessing) {
        const contourCanvas = contourCacheRef.current.canvas;
        
        const contourAspectRatio = contourCanvas.width / contourCanvas.height;
        
        let contourWidth, contourHeight;
        if (contourAspectRatio > (availableWidth / availableHeight)) {
          contourWidth = availableWidth;
          contourHeight = availableWidth / contourAspectRatio;
        } else {
          contourHeight = availableHeight;
          contourWidth = availableHeight * contourAspectRatio;
        }
        
        const contourX = (canvasWidth - contourWidth) / 2;
        const contourY = (canvasHeight - contourHeight) / 2;
        
        contourTransformRef.current = {
          x: contourX, y: contourY,
          width: contourWidth, height: contourHeight,
          canvasW: contourCanvas.width, canvasH: contourCanvas.height
        };
        
        if (strokeSettings.backgroundColor === 'holographic') {
          const holoKey = `${contourCacheRef.current?.key || ''}-${contourCanvas.width}x${contourCanvas.height}`;
          let holoCanvas = holographicCacheRef.current?.contourKey === holoKey ? holographicCacheRef.current.canvas : null;
          
          if (!holoCanvas) {
            holoCanvas = document.createElement('canvas');
            holoCanvas.width = contourCanvas.width;
            holoCanvas.height = contourCanvas.height;
            const tempCtx = holoCanvas.getContext('2d')!;
            tempCtx.drawImage(contourCanvas, 0, 0);
            
            const imageData = tempCtx.getImageData(0, 0, holoCanvas.width, holoCanvas.height);
            const pixels = imageData.data;
            
            const gradientCanvas = document.createElement('canvas');
            gradientCanvas.width = holoCanvas.width;
            gradientCanvas.height = holoCanvas.height;
            const gradCtx = gradientCanvas.getContext('2d')!;
            const gradient = gradCtx.createLinearGradient(0, 0, gradientCanvas.width, gradientCanvas.height);
            gradient.addColorStop(0, '#C8C8D0');
            gradient.addColorStop(0.17, '#E8B8B8');
            gradient.addColorStop(0.34, '#B8D8E8');
            gradient.addColorStop(0.51, '#E8D0F0');
            gradient.addColorStop(0.68, '#B0C8E0');
            gradient.addColorStop(0.85, '#C0B0D8');
            gradient.addColorStop(1, '#C8C8D0');
            gradCtx.fillStyle = gradient;
            gradCtx.fillRect(0, 0, gradientCanvas.width, gradientCanvas.height);
            const gradientData = gradCtx.getImageData(0, 0, gradientCanvas.width, gradientCanvas.height);
            const gradPixels = gradientData.data;
            
            for (let i = 0; i < pixels.length; i += 4) {
              if (pixels[i + 3] > 200 && pixels[i] > 240 && pixels[i + 1] > 240 && pixels[i + 2] > 240) {
                pixels[i] = gradPixels[i];
                pixels[i + 1] = gradPixels[i + 1];
                pixels[i + 2] = gradPixels[i + 2];
              }
            }
            
            tempCtx.putImageData(imageData, 0, 0);
            holographicCacheRef.current = { contourKey: holoKey, canvas: holoCanvas };
          }
          
          ctx.drawImage(holoCanvas, contourX, contourY, contourWidth, contourHeight);
        } else {
          ctx.drawImage(contourCanvas, contourX, contourY, contourWidth, contourHeight);
        }

        {
          const dsScale = contourCacheRef.current?.downsampleScale ?? 1;
          const dsWidth = Math.round(imageInfo.image.width * dsScale);
          const dsHeight = Math.round(imageInfo.image.height * dsScale);
          const _imgX = contourCacheRef.current?.imageCanvasX ?? 0;
          const _imgY = contourCacheRef.current?.imageCanvasY ?? 0;
          const _scaleX = contourWidth / contourCanvas.width;
          const _scaleY = contourHeight / contourCanvas.height;
          lastImageRenderRef.current = {
            x: contourX + (_imgX * _scaleX),
            y: contourY + (_imgY * _scaleY),
            width: dsWidth * _scaleX,
            height: dsHeight * _scaleY,
          };
        }
        
        if (segmentationData?.mode === 'items') {
          const segOverlay = createSegmentOverlayCanvas();
          if (segOverlay) {
            const dsScale = contourCacheRef.current?.downsampleScale ?? 1;
            const dsWidth = Math.round(imageInfo.image.width * dsScale);
            const dsHeight = Math.round(imageInfo.image.height * dsScale);
            const imgX = contourCacheRef.current?.imageCanvasX ?? 0;
            const imgY = contourCacheRef.current?.imageCanvasY ?? 0;
            const scaleX = contourWidth / contourCanvas.width;
            const scaleY = contourHeight / contourCanvas.height;
            const segX = contourX + (imgX * scaleX);
            const segY = contourY + (imgY * scaleY);
            const segW = dsWidth * scaleX;
            const segH = dsHeight * scaleY;
            ctx.save();
            ctx.globalAlpha = spotPulseRef.current;
            ctx.drawImage(segOverlay, segX, segY, segW, segH);
            ctx.restore();
          }
        } else {
          const spotOverlay = createSpotOverlayCanvas();
          if (spotOverlay) {
            const dsScale = contourCacheRef.current?.downsampleScale ?? 1;
            const dsWidth = Math.round(imageInfo.image.width * dsScale);
            const dsHeight = Math.round(imageInfo.image.height * dsScale);
            const imgX = contourCacheRef.current?.imageCanvasX ?? 0;
            const imgY = contourCacheRef.current?.imageCanvasY ?? 0;
            const scaleX = contourWidth / contourCanvas.width;
            const scaleY = contourHeight / contourCanvas.height;
            const spotX = contourX + (imgX * scaleX);
            const spotY = contourY + (imgY * scaleY);
            const spotWidth = dsWidth * scaleX;
            const spotHeight = dsHeight * scaleY;
            ctx.save();
            ctx.globalAlpha = spotPulseRef.current;
            ctx.drawImage(spotOverlay, spotX, spotY, spotWidth, spotHeight);
            ctx.restore();
          }
        }
      } else {
        const aspectRatio = imageInfo.image.width / imageInfo.image.height;
        let displayWidth, displayHeight;
        if (aspectRatio > (availableWidth / availableHeight)) {
          displayWidth = availableWidth;
          displayHeight = availableWidth / aspectRatio;
        } else {
          displayHeight = availableHeight;
          displayWidth = availableHeight * aspectRatio;
        }
        
        const displayX = (canvasWidth - displayWidth) / 2;
        const displayY = (canvasHeight - displayHeight) / 2;
        
        const previewImg = getPreviewImage();
        ctx.drawImage(previewImg, displayX, displayY, displayWidth, displayHeight);
        lastImageRenderRef.current = { x: displayX, y: displayY, width: displayWidth, height: displayHeight };

        if (segmentationData?.mode === 'items') {
          const segOverlay = createSegmentOverlayCanvas();
          if (segOverlay) {
            ctx.save();
            ctx.globalAlpha = spotPulseRef.current;
            ctx.drawImage(segOverlay, displayX, displayY, displayWidth, displayHeight);
            ctx.restore();
          }
        } else {
          const spotOverlay = createSpotOverlayCanvas();
          if (spotOverlay) {
            ctx.save();
            ctx.globalAlpha = spotPulseRef.current;
            ctx.drawImage(spotOverlay, displayX, displayY, displayWidth, displayHeight);
            ctx.restore();
          }
        }
      }
    };

    const effectiveBackground = (() => {
      const hasPdfCutContour = imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour;
      return hasPdfCutContour ? strokeSettings.backgroundColor : backgroundColor;
    })();
    const isTransparentBg = effectiveBackground === "transparent";

    return (
      <div className="w-full">
        <Card className="bg-white border-gray-100 shadow-sm rounded-2xl overflow-hidden">
          <CardContent className="p-0">
            {/* Design info + preview background swatches */}
            <div className="mx-2 mt-2 mb-0 flex items-center gap-1.5 p-1.5">
              {imageInfo && (
                <div className="flex items-center gap-1 min-w-0 flex-shrink-0">
                  <span className="text-[10px] text-gray-400 font-medium">W</span>
                  <InchInput
                    value={resizeSettings.widthInches}
                    onCommit={(v) => onResizeChange?.({ widthInches: v })}
                    min={0.5}
                    max={50}
                    className="w-[52px] text-[11px] font-semibold text-gray-700 text-center bg-gray-50 border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-300 focus:border-indigo-300"
                  />
                  <span className="text-[10px] text-gray-400">"</span>
                  <button
                    onClick={() => onResizeChange?.({ maintainAspectRatio: !resizeSettings.maintainAspectRatio })}
                    className={`p-0.5 rounded transition-colors ${resizeSettings.maintainAspectRatio ? 'text-indigo-500 hover:text-indigo-600' : 'text-gray-300 hover:text-gray-400'}`}
                    title={resizeSettings.maintainAspectRatio ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                  >
                    {resizeSettings.maintainAspectRatio ? <Link2 size={12} /> : <Unlink2 size={12} />}
                  </button>
                  <span className="text-[10px] text-gray-400 font-medium">H</span>
                  <InchInput
                    value={resizeSettings.heightInches}
                    onCommit={(v) => onResizeChange?.({ heightInches: v })}
                    min={0.5}
                    max={50}
                    className="w-[52px] text-[11px] font-semibold text-gray-700 text-center bg-gray-50 border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-300 focus:border-indigo-300"
                  />
                  <span className="text-[10px] text-gray-400">"</span>
                  <div className="relative ml-1">
                    <select
                      className="appearance-none text-[11px] font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-500 rounded-md pl-2 pr-5 py-1 cursor-pointer hover:from-indigo-400 hover:to-violet-400 transition-all focus:outline-none focus:ring-2 focus:ring-indigo-300 shadow-sm"
                      value=""
                      onChange={(e) => {
                        const longest = parseFloat(e.target.value);
                        if (!longest || !onResizeChange || !imageInfo) return;
                        const isWider = imageInfo.originalWidth >= imageInfo.originalHeight;
                        if (isWider) {
                          onResizeChange({ widthInches: longest });
                        } else {
                          onResizeChange({ heightInches: longest });
                        }
                      }}
                    >
                      <option value="" disabled className="text-gray-700 bg-white">Size</option>
                      {[2, 3, 4, 5, 6, 8, 10].map(size => (
                        <option key={size} value={size} className="text-gray-700 bg-white">{size}" sticker</option>
                      ))}
                    </select>
                    <svg className="absolute right-1 top-1/2 -translate-y-1/2 w-3 h-3 text-white/70 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-0.5 flex-shrink-0">
                <button
                  onClick={onUndo}
                  disabled={!canUndo}
                  className={`p-1 rounded transition-colors ${canUndo ? 'text-gray-500 hover:text-indigo-600 hover:bg-indigo-50' : 'text-gray-200 cursor-default'}`}
                  title="Undo"
                >
                  <Undo2 size={13} />
                </button>
                <button
                  onClick={onRedo}
                  disabled={!canRedo}
                  className={`p-1 rounded transition-colors ${canRedo ? 'text-gray-500 hover:text-indigo-600 hover:bg-indigo-50' : 'text-gray-200 cursor-default'}`}
                  title="Redo"
                >
                  <Redo2 size={13} />
                </button>
              </div>
              {!(imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour) && (
                <div className="flex items-center gap-1.5 ml-auto flex-shrink-0">
                  {[
                    { value: 'transparent', bg: 'transparent', label: 'Transparent' },
                    { value: '#ffffff', bg: '#ffffff', label: 'White' },
                    { value: '#f3f4f6', bg: '#f3f4f6', label: 'Light Gray' },
                    { value: '#9ca3af', bg: '#9ca3af', label: 'Gray' },
                    { value: '#1f2937', bg: '#1f2937', label: 'Dark Gray' },
                    { value: '#000000', bg: '#000000', label: 'Black' },
                  ].map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setBackgroundColor(opt.value)}
                      title={opt.label}
                      className={`w-6 h-6 rounded-full border-2 transition-all flex-shrink-0 ${
                        backgroundColor === opt.value
                          ? 'border-cyan-400 scale-110 shadow-sm'
                          : 'border-gray-200 hover:border-gray-300'
                      } ${opt.value === 'transparent' ? 'checkerboard' : ''}`}
                      style={opt.value !== 'transparent' ? { backgroundColor: opt.bg } : undefined}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col items-start">
              <div className="flex w-full">
                <div 
                  ref={containerRef}
                  onWheel={handleWheel}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseLeave}
                  onTouchStart={handleTouchStart}
                  onTouchMove={handleTouchMove}
                  onTouchEnd={handleTouchEnd}
                  className={`relative w-full flex items-center justify-center ${isTransparentBg ? 'checkerboard' : ''} ${spotPaintMode ? 'cursor-cell' : selectZoomMode ? 'cursor-crosshair' : zoom > 1 ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-crosshair'} ${showHighlight ? 'ring-4 ring-indigo-400 ring-opacity-75 transition-shadow duration-300' : ''}`}
                  style={{ 
                    width: '100%',
                    height: '100%',
                    aspectRatio: imageInfo ? `${imageInfo.image.width} / ${imageInfo.image.height}` : '1 / 1',
                    maxHeight: '70vh',
                    backgroundColor: isTransparentBg ? 'transparent' : effectiveBackground,
                    overflow: 'hidden',
                    userSelect: 'none',
                    touchAction: 'none'
                  }}
                >
                <canvas 
                  ref={canvasRef}
                  className="relative z-10 block"
                  style={{ 
                    maxWidth: '100%',
                    maxHeight: '100%',
                    transform: `translate(${panX}%, ${panY}%) scale(${zoom * (resizeAnimState?.scale ?? 1)})`,
                    transformOrigin: 'center',
                    transition: resizeAnimState
                      ? (resizeAnimState.transitioning
                        ? 'transform 0.38s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease-out'
                        : 'none')
                      : (isDragging || isSelectingRef.current) ? 'none' : 'transform 0.3s ease-out',
                    opacity: resizeAnimState?.opacity ?? 1,
                  }}
                />
                
                {selectionRect && selectionRect.w > 0 && selectionRect.h > 0 && (
                  <div
                    className="absolute z-30 pointer-events-none"
                    style={{
                      left: selectionRect.x,
                      top: selectionRect.y,
                      width: selectionRect.w,
                      height: selectionRect.h,
                      border: '2px dashed rgba(99, 102, 241, 0.9)',
                      backgroundColor: 'rgba(99, 102, 241, 0.08)',
                      boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.15)',
                    }}
                  />
                )}
                
                {!imageInfo && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="text-center">
                      <ImageIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                      <p className="text-gray-500">Upload an image to see preview</p>
                    </div>
                  </div>
                )}
                
                {detectedAlgorithm && strokeSettings.enabled && onStrokeChange && (() => {
                  const autoMode = detectedAlgorithm === 'scattered' ? 'scattered' as const : 'smooth' as const;
                  const effectiveMode = strokeSettings.contourMode ?? autoMode;
                  const isOverridden = strokeSettings.contourMode !== undefined;
                  const modes = [
                    { key: 'smooth' as const, label: 'Sharp' },
                    { key: 'scattered' as const, label: 'Smooth' },
                  ];
                  return (
                    <div className="absolute bottom-2 right-2 z-20 bg-white/90 backdrop-blur-sm rounded-md px-2 py-1 border border-gray-200 shadow-sm flex items-center gap-1.5">
                      <span className="text-[9px] text-gray-400">
                        {detectedAlgorithm === 'complex' ? 'Std' : detectedAlgorithm === 'scattered' ? 'Multi' : '...'}
                      </span>
                      {modes.map((mode, i) => (
                        <button
                          key={mode.key}
                          className={`text-[9px] px-1.5 py-0.5 border transition-colors ${
                            i === 0 ? 'rounded-l' : 'rounded-r'
                          } ${i > 0 ? 'border-l-0' : ''} ${
                            effectiveMode === mode.key
                              ? 'bg-indigo-500 text-white border-indigo-500'
                              : 'bg-white text-gray-500 border-gray-300 hover:bg-gray-100'
                          }`}
                          onClick={() => onStrokeChange({ contourMode: mode.key })}
                        >
                          {mode.label}
                        </button>
                      ))}
                      {isOverridden && (
                        <button
                          className="text-[9px] px-1 py-0.5 text-gray-400 hover:text-gray-600 transition-colors"
                          onClick={() => onStrokeChange({ contourMode: undefined })}
                          title="Reset to auto-detected"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  );
                })()}

                {isProcessing && imageInfo && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30 z-20">
                    <div className="text-center">
                      <Loader2 className="w-8 h-8 text-white mx-auto mb-2 animate-spin" />
                      <p className="text-white text-sm">Processing... {processingProgress}%</p>
                    </div>
                  </div>
                )}
                </div>
                
              </div>
            </div>

            <div className="mx-2 my-2">
              <div className="flex items-center justify-center gap-1.5 bg-gray-50/50 rounded-lg p-1.5 border border-gray-100">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setZoom(prev => Math.min(prev + 0.25, 5))}
                  className="h-7 w-7 p-0 hover:bg-gray-100 rounded-md"
                  title="Zoom In"
                >
                  <ZoomIn className="h-3.5 w-3.5 text-gray-500" />
                </Button>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setZoom(prev => Math.max(prev - 0.25, 0.25))}
                  className="h-7 w-7 p-0 hover:bg-gray-100 rounded-md"
                  title="Zoom Out"
                >
                  <ZoomOut className="h-3.5 w-3.5 text-gray-500" />
                </Button>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectZoomMode(prev => !prev)}
                  className={`h-7 px-2 rounded-md text-xs transition-colors ${
                    selectZoomMode
                      ? 'bg-indigo-500 text-white hover:bg-indigo-600'
                      : 'hover:bg-gray-100 text-gray-500'
                  }`}
                  title="Select area to zoom into"
                >
                  <Scan className="h-3.5 w-3.5 mr-1" />
                  Select Zoom
                </Button>
                
                <span className="text-xs text-gray-500 min-w-[42px] text-center font-medium">
                  {Math.round(zoom * 100)}%
                </span>
                
                {zoom > 1 && (
                  <Button 
                    variant="ghost"
                    size="sm"
                    onClick={resetView}
                    className="h-7 px-2 hover:bg-gray-100 rounded-md text-gray-500 text-xs"
                    title="Reset to 100%"
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />
                    Reset
                  </Button>
                )}
              </div>
            </div>

          </CardContent>
        </Card>
      </div>
    );
  }
);

PreviewSection.displayName = 'PreviewSection';

export default PreviewSection;
