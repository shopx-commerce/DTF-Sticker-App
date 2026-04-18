import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { StrokeSettings, ResizeSettings, ImageInfo, ShapeSettings, StickerSize, type SegmentationData } from "./image-editor";
import { STICKER_SIZES } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";
import { generateContourPDFBase64 } from "@/lib/contour-outline";
import { generateShapePDFBase64, calculateShapeDimensions } from "@/lib/shape-outline";
import { getContourWorkerManager, type DetectedAlgorithm } from "@/lib/contour-worker-manager";
import { extractColorsFromImage, detectColorRegionsAsync, ExtractedColor, type ColorExtractionResult } from "@/lib/color-extractor";
import { Download, ChevronDown, ChevronUp, Eye, EyeOff, Pencil, Check, X, Layers, Palette, Pipette, Trash2, Link, Unlink, Settings2, Spline, Shapes } from "lucide-react";

export interface SpotPreviewData {
  enabled: boolean;
  colors: ExtractedColor[];
  pixelMap?: Int16Array;
  mapWidth?: number;
  mapHeight?: number;
}

interface ControlsSectionProps {
  strokeSettings: StrokeSettings;
  resizeSettings: ResizeSettings;
  shapeSettings: ShapeSettings;
  stickerSize: StickerSize;
  onStrokeChange: (settings: Partial<StrokeSettings>) => void;
  onResizeChange: (settings: Partial<ResizeSettings>) => void;
  onShapeChange: (settings: Partial<ShapeSettings>) => void;
  onStickerSizeChange: (size: StickerSize) => void;
  onDownload: (downloadType?: 'standard' | 'highres' | 'vector' | 'cutcontour' | 'design-only' | 'download-package', format?: 'png' | 'pdf' | 'eps' | 'svg', spotColors?: Array<{hex: string; rgb: {r: number; g: number; b: number}; spotWhite: boolean; spotGloss: boolean; spotWhiteName?: string; spotGlossName?: string; spotFluorY: boolean; spotFluorM: boolean; spotFluorG: boolean; spotFluorOrange: boolean; spotFluorYName?: string; spotFluorMName?: string; spotFluorGName?: string; spotFluorOrangeName?: string}>, singleArtboard?: boolean) => void;
  isProcessing: boolean;
  imageInfo: ImageInfo | null;
  canvasRef?: React.RefObject<HTMLCanvasElement>;
  onStepChange?: (step: number) => void;
  onRemoveBackground?: (threshold: number) => void;
  isRemovingBackground?: boolean;
  onSpotPreviewChange?: (data: SpotPreviewData) => void;
  detectedAlgorithm?: DetectedAlgorithm;
  segmentationData?: SegmentationData;
  isSegmenting?: boolean;
  onSegmentImage?: () => void;
  onSegmentationChange?: (data: Partial<SegmentationData>) => void;
  onSegmentLayerToggle?: (layerId: string) => void;
  onSegmentLayerLabelChange?: (layerId: string, label: string) => void;
  onSegmentLayerSpotChange?: (layerId: string, field: 'spotWhite' | 'spotGloss', value: boolean) => void;
  highlightedColorIndex?: number | null;
  highlightedRegionId?: number | null;
  onHighlightRegion?: (colorIndex: number, regionId: number | null) => void;
  onChangeDesign?: () => void;
  onClearDesign?: () => void;
  spotPaintMode?: 'white' | 'gloss' | 'both' | 'clear' | null;
  onSpotPaintModeChange?: (mode: 'white' | 'gloss' | 'both' | 'clear' | null) => void;
  pendingSpotPaint?: { colorIndex: number; regionId: number | null; mode: string; id: number } | null;
  onSpotPaintApplied?: () => void;
  spotColorRestore?: { colors: ExtractedColor[]; id: number } | null;
}

function InchInput({ value, onCommit, min = 0.5, max = 24, className }: {
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

export default function ControlsSection({
  strokeSettings,
  resizeSettings,
  shapeSettings,
  stickerSize,
  onStrokeChange,
  onResizeChange,
  onShapeChange,
  onStickerSizeChange,
  onDownload,
  isProcessing,
  imageInfo,
  canvasRef,
  onStepChange,
  onRemoveBackground,
  isRemovingBackground,
  onSpotPreviewChange,
  detectedAlgorithm,
  segmentationData,
  isSegmenting,
  onSegmentImage,
  onSegmentationChange,
  onSegmentLayerToggle,
  onSegmentLayerLabelChange,
  onSegmentLayerSpotChange,
  highlightedColorIndex,
  highlightedRegionId,
  onHighlightRegion,
  onChangeDesign,
  onClearDesign,
  spotPaintMode,
  onSpotPaintModeChange,
  pendingSpotPaint,
  onSpotPaintApplied,
  spotColorRestore,
}: ControlsSectionProps) {
  const { toast } = useToast();
  const [showSpotColors, setShowSpotColors] = useState(false);
  const [extractedColors, setExtractedColors] = useState<ExtractedColor[]>([]);
  const [spotPreviewEnabled, setSpotPreviewEnabled] = useState(true);
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerNotes, setCustomerNotes] = useState("");
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [showSendForm, setShowSendForm] = useState(false);
  const [showSizeSection, setShowSizeSection] = useState(false);
  const [spotWhiteName, setSpotWhiteName] = useState("RDG_WHITE");
  const [spotGlossName, setSpotGlossName] = useState("RDG_GLOSS");
  const [editingWhiteName, setEditingWhiteName] = useState(false);
  const [editingGlossName, setEditingGlossName] = useState(false);
  const [tempWhiteName, setTempWhiteName] = useState("");
  const [tempGlossName, setTempGlossName] = useState("");
  const [expandedColorIndex, setExpandedColorIndex] = useState<number | null>(null);
  const [showOutlineType, setShowOutlineType] = useState(true);
  const [showShapeAdvanced, setShowShapeAdvanced] = useState(false);
  const [contourPanelOpen, setContourPanelOpen] = useState(true);
  const [shapePanelOpen, setShapePanelOpen] = useState(true);
  const colorListRef = useRef<HTMLDivElement>(null);

  const canDownload = !!imageInfo;
  const extractionRef = useRef<ColorExtractionResult | null>(null);

  const fillPalette = (() => {
    const base = ['#FFFFFF', '#000000', '#FF0000', '#0066FF', '#00AA00'];
    const designHexes = extractedColors.slice(0, 3).map(c => c.hex.toUpperCase());
    const merged = new Set([...base, ...designHexes]);
    return Array.from(merged).slice(0, 5);
  })();

  const spotRestoreIdRef = useRef<number>(0);
  useEffect(() => {
    if (!spotColorRestore || spotColorRestore.id === spotRestoreIdRef.current) return;
    spotRestoreIdRef.current = spotColorRestore.id;
    setExtractedColors(prev => {
      if (prev.length === 0 && spotColorRestore.colors.length === 0) return prev;
      return spotColorRestore.colors.map((restored, i) => {
        const existing = prev[i];
        if (!existing) return restored;
        return {
          ...existing,
          spotWhite: restored.spotWhite,
          spotGloss: restored.spotGloss,
          regions: existing.regions?.map(r => {
            const restoredRegion = restored.regions?.find(rr => rr.id === r.id);
            if (!restoredRegion) return r;
            return { ...r, spotWhite: restoredRegion.spotWhite, spotGloss: restoredRegion.spotGloss };
          }),
        };
      });
    });
  }, [spotColorRestore]);

  useEffect(() => {
    if (imageInfo?.image) {
      const rafId = requestAnimationFrame(() => {
        const result = extractColorsFromImage(imageInfo.image, 999);
        extractionRef.current = result;

        const canvas = document.createElement('canvas');
        canvas.width = result.width;
        canvas.height = result.height;
        const ctx = canvas.getContext('2d');
        let imgData: ImageData | undefined;
        if (ctx) {
          ctx.drawImage(imageInfo.image, 0, 0, result.width, result.height);
          imgData = ctx.getImageData(0, 0, result.width, result.height);
        }

        detectColorRegionsAsync(result.pixelMap, result.width, result.height, result.colors, imgData)
          .then(() => setExtractedColors([...result.colors]));
        setExtractedColors(result.colors);
      });
      return () => cancelAnimationFrame(rafId);
    } else {
      extractionRef.current = null;
      setExtractedColors([]);
    }
  }, [imageInfo]);

  // Auto-expand color and scroll to it when user clicks on canvas
  useEffect(() => {
    if (highlightedColorIndex != null && highlightedColorIndex >= 0) {
      setShowSpotColors(true);
      const color = extractedColors[highlightedColorIndex];
      if (color?.regions && color.regions.length > 1) {
        setExpandedColorIndex(highlightedColorIndex);
      }
      // Scroll the highlighted color into view
      setTimeout(() => {
        const el = colorListRef.current?.querySelector(`[data-color-index="${highlightedColorIndex}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 100);
    }
  }, [highlightedColorIndex, highlightedRegionId]);

  const handleSpotColorsToggle = () => {
    setShowSpotColors(prev => !prev);
  };

  const updateSpotColor = (index: number, field: 'spotWhite' | 'spotGloss', value: boolean) => {
    if (value) setSpotPreviewEnabled(true);

    setExtractedColors(prev => prev.map((color, i) => {
      if (i !== index) return color;
      const updated = { ...color, [field]: value };
      if (updated.regions) {
        updated.regions = updated.regions.map(r => ({ ...r, [field]: value }));
      }
      return updated;
    }));
  };

  const cycleSpotAssignment = (index: number) => {
    const color = extractedColors[index];
    const { spotWhite, spotGloss } = color;
    setSpotPreviewEnabled(true);
    if (!spotWhite && !spotGloss) {
      updateSpotColor(index, 'spotWhite', true);
    } else if (spotWhite && !spotGloss) {
      setExtractedColors(prev => prev.map((c, i) => {
        if (i !== index) return c;
        const updated = { ...c, spotWhite: false, spotGloss: true };
        if (updated.regions) {
          updated.regions = updated.regions.map(r => ({ ...r, spotWhite: false, spotGloss: true }));
        }
        return updated;
      }));
    } else if (!spotWhite && spotGloss) {
      updateSpotColor(index, 'spotWhite', true);
    } else {
      setExtractedColors(prev => prev.map((c, i) => {
        if (i !== index) return c;
        const updated = { ...c, spotWhite: false, spotGloss: false };
        if (updated.regions) {
          updated.regions = updated.regions.map(r => ({ ...r, spotWhite: false, spotGloss: false }));
        }
        return updated;
      }));
    }
  };

  const swatchClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSwatchClick = useCallback((index: number) => {
    if (swatchClickTimer.current) {
      clearTimeout(swatchClickTimer.current);
      swatchClickTimer.current = null;
      onHighlightRegion?.(index, null);
      return;
    }
    swatchClickTimer.current = setTimeout(() => {
      swatchClickTimer.current = null;
      onHighlightRegion?.(index, null);
    }, 250);
  }, [onHighlightRegion]);

  useEffect(() => {
    if (!pendingSpotPaint) return;
    const { colorIndex, regionId, mode } = pendingSpotPaint;
    if (colorIndex < 0 || colorIndex >= extractedColors.length) {
      onSpotPaintApplied?.();
      return;
    }
    setSpotPreviewEnabled(true);
    const color = extractedColors[colorIndex];
    const hasRegions = color.regions && color.regions.length > 0;

    if (hasRegions && regionId != null) {
      // Per-shape: toggle spot on the specific region only
      setExtractedColors(prev => prev.map((c, i) => {
        if (i !== colorIndex || !c.regions) return c;
        const updatedRegions = c.regions.map(r => {
          // Initialize undefined spots to false so they don't inherit color-level values
          const baseWhite = r.spotWhite ?? false;
          const baseGloss = r.spotGloss ?? false;
          if (r.id !== regionId) return { ...r, spotWhite: baseWhite, spotGloss: baseGloss };
          if (mode === 'white') return { ...r, spotWhite: !baseWhite, spotGloss: baseGloss };
          if (mode === 'gloss') return { ...r, spotWhite: baseWhite, spotGloss: !baseGloss };
          if (mode === 'both') {
            const allSet = baseWhite && baseGloss;
            return { ...r, spotWhite: !allSet, spotGloss: !allSet };
          }
          if (mode === 'clear') return { ...r, spotWhite: false, spotGloss: false };
          return { ...r, spotWhite: baseWhite, spotGloss: baseGloss };
        });
        // Derive color-level flags: true if ANY region has the assignment
        const anyWhite = updatedRegions.some(r => r.spotWhite);
        const anyGloss = updatedRegions.some(r => r.spotGloss);
        return { ...c, regions: updatedRegions, spotWhite: anyWhite, spotGloss: anyGloss };
      }));
    } else {
      // No regions or no regionId: color-level toggle (legacy behavior)
      if (mode === 'white') {
        updateSpotColor(colorIndex, 'spotWhite', !color.spotWhite);
      } else if (mode === 'gloss') {
        updateSpotColor(colorIndex, 'spotGloss', !color.spotGloss);
      } else if (mode === 'both') {
        const allSet = color.spotWhite && color.spotGloss;
        setExtractedColors(prev => prev.map((c, i) =>
          i === colorIndex ? { ...c, spotWhite: !allSet, spotGloss: !allSet } : c
        ));
      } else if (mode === 'clear') {
        setExtractedColors(prev => prev.map((c, i) =>
          i === colorIndex ? { ...c, spotWhite: false, spotGloss: false } : c
        ));
      }
    }
    onSpotPaintApplied?.();
  }, [pendingSpotPaint]);

  const toggleRegionSpot = (colorIndex: number, regionId: number, field: 'spotWhite' | 'spotGloss') => {
    setSpotPreviewEnabled(true);
    setExtractedColors(prev => prev.map((color, i) => {
      if (i !== colorIndex || !color.regions) return color;
      const updatedRegions = color.regions.map(r =>
        r.id === regionId ? { ...r, [field]: !r[field] } : r
      );
      const anyWhite = updatedRegions.some(r => r.spotWhite);
      const anyGloss = updatedRegions.some(r => r.spotGloss);
      return { ...color, regions: updatedRegions, spotWhite: anyWhite, spotGloss: anyGloss };
    }));
  };

  // Notify parent of spot preview changes (includes pixelMap for fast overlay rendering)
  useEffect(() => {
    const ext = extractionRef.current;
    onSpotPreviewChange?.({
      enabled: spotPreviewEnabled,
      colors: extractedColors,
      pixelMap: ext?.pixelMap,
      mapWidth: ext?.width,
      mapHeight: ext?.height,
    });
  }, [spotPreviewEnabled, extractedColors, onSpotPreviewChange]);

  const handleSendDesign = async () => {
    if (!customerName.trim() || !customerEmail.trim()) {
      toast({
        title: "Missing Information",
        description: "Please enter your full name and email address.",
        variant: "destructive",
      });
      return;
    }
    setShowConfirmDialog(true);
  };

  const confirmAndSend = async () => {
    setShowConfirmDialog(false);
    setIsSending(true);

    try {
      let pdfBase64 = "";
      
      if (imageInfo?.image) {
        if (strokeSettings.enabled) {
          const workerManager = getContourWorkerManager();
          const cachedData = workerManager.getCachedContourData();
          const result = await generateContourPDFBase64(imageInfo.image, strokeSettings, resizeSettings, cachedData || undefined);
          pdfBase64 = result || "";
        } else if (shapeSettings.enabled) {
          const result = await generateShapePDFBase64(imageInfo.image, shapeSettings, resizeSettings);
          pdfBase64 = result || "";
        }
      }

      if (!pdfBase64) {
        throw new Error("Failed to generate PDF. Please try again.");
      }

      const formData = new FormData();
      formData.append('customerName', customerName.trim());
      formData.append('customerEmail', customerEmail.trim());
      formData.append('customerNotes', customerNotes.trim());
      formData.append('pdfData', pdfBase64);
      formData.append('stickerSize', stickerSize.toString());
      formData.append('outlineType', strokeSettings.enabled ? 'contour' : 'shape');

      const response = await fetch('/api/send-design', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to send design');
      }

      toast({
        title: "Design Sent Successfully!",
        description: "We've received your design. Check your email for confirmation.",
      });

      setCustomerName("");
      setCustomerEmail("");
      setCustomerNotes("");
      setShowSendForm(false);
    } catch (error) {
      console.error('Error sending design:', error);
      toast({
        title: "Error Sending Design",
        description: error instanceof Error ? error.message : "Please try again later.",
        variant: "destructive",
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* All Design Options Card */}
      {/* Add/Change Design button + Clear Design */}
      {onChangeDesign && (
        <div className="flex items-center gap-2">
          <button
            onClick={onChangeDesign}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-400 hover:to-violet-400 text-white rounded-xl shadow-md shadow-indigo-500/30 hover:shadow-indigo-400/40 transition-all"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Add/Change Design
          </button>
          {onClearDesign && (
            <button
              onClick={onClearDesign}
              className="p-2.5 rounded-xl border border-red-200 text-red-400 hover:bg-red-50 hover:text-red-500 hover:border-red-300 transition-all"
              title="Remove current design (keeps gang sheet)"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        {/* Size Selection - Collapsible */}
        <div className="border-b border-gray-100">
          <button
            onClick={() => setShowSizeSection(!showSizeSection)}
            className="flex items-center justify-between w-full px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center">
                <span className="text-indigo-600 font-bold text-xs">{Math.max(resizeSettings.widthInches, resizeSettings.heightInches).toFixed(1)}"</span>
              </div>
              <span>Size</span>
            </div>
            {showSizeSection ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
          </button>
          
          {showSizeSection && (
            <div className="px-4 pb-3 space-y-3">
              <Select
                value={stickerSize.toString()}
                onValueChange={(value) => onStickerSizeChange(parseFloat(value) as StickerSize)}
              >
                <SelectTrigger className="w-full bg-gray-50 border-gray-200 text-gray-900">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STICKER_SIZES.map((size) => (
                    <SelectItem key={size.value} value={size.value.toString()}>
                      {size.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              
              {/* Compact Width/Height Resize Controls */}
              <div className="bg-gray-50 rounded-lg p-2.5 border border-gray-200">
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <label className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">Width</label>
                    <div className="flex items-center mt-0.5">
                      <InchInput
                        value={resizeSettings.widthInches}
                        onCommit={(newWidth) => {
                          if (resizeSettings.maintainAspectRatio && imageInfo) {
                            const aspectRatio = resizeSettings.heightInches / resizeSettings.widthInches;
                            onResizeChange({ widthInches: newWidth, heightInches: newWidth * aspectRatio });
                          } else {
                            onResizeChange({ widthInches: newWidth });
                          }
                        }}
                        min={0.5}
                        max={24}
                        className="w-full h-7 px-2 text-sm bg-white border border-gray-300 rounded text-gray-900 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                      />
                      <span className="ml-1 text-xs text-gray-500">"</span>
                    </div>
                  </div>
                  
                  <button
                    onClick={() => onResizeChange({ maintainAspectRatio: !resizeSettings.maintainAspectRatio })}
                    className={`mt-4 p-1.5 rounded transition-colors ${resizeSettings.maintainAspectRatio ? 'bg-indigo-100 text-indigo-600' : 'bg-gray-200 text-gray-400'}`}
                    title={resizeSettings.maintainAspectRatio ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {resizeSettings.maintainAspectRatio ? (
                        <>
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                        </>
                      ) : (
                        <>
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                          <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
                        </>
                      )}
                    </svg>
                  </button>
                  
                  <div className="flex-1">
                    <label className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">Height</label>
                    <div className="flex items-center mt-0.5">
                      <InchInput
                        value={resizeSettings.heightInches}
                        onCommit={(newHeight) => {
                          if (resizeSettings.maintainAspectRatio && imageInfo) {
                            const aspectRatio = resizeSettings.widthInches / resizeSettings.heightInches;
                            onResizeChange({ heightInches: newHeight, widthInches: newHeight * aspectRatio });
                          } else {
                            onResizeChange({ heightInches: newHeight });
                          }
                        }}
                        min={0.5}
                        max={24}
                        className="w-full h-7 px-2 text-sm bg-white border border-gray-300 rounded text-gray-900 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                      />
                      <span className="ml-1 text-xs text-gray-500">"</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Outline Type - Collapsible Dropdown */}
        {imageInfo && <div className="border-b border-gray-100">
          <button
            onClick={() => setShowOutlineType(!showOutlineType)}
            className={`flex items-center justify-between w-full px-4 py-3 text-left transition-colors ${showOutlineType ? 'bg-indigo-50 hover:bg-indigo-100' : 'hover:bg-gray-50'}`}
          >
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-indigo-500" />
              <span className="text-sm font-medium text-gray-700">Outline Type</span>
              {(strokeSettings.enabled || shapeSettings.enabled) && (
                <span className="text-xs text-gray-400">
                  ({strokeSettings.enabled ? 'Contour' : 'Shape'})
                </span>
              )}
            </div>
            <div className={`p-1 rounded-md transition-all ${showOutlineType ? 'bg-indigo-200' : 'bg-gray-200 hover:bg-gray-300'}`}>
              <ChevronDown className={`w-4 h-4 transition-transform ${showOutlineType ? 'rotate-180 text-indigo-700' : 'text-gray-600'}`} />
            </div>
          </button>

          {showOutlineType && (
            <div className="px-4 pb-3 space-y-3">
              {imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour ? (
                <div className="p-2.5 bg-emerald-50 border border-emerald-100 rounded-lg">
                  <p className="text-sm font-medium text-emerald-700">Cutline already in file</p>
                  <p className="text-xs text-emerald-600 mt-0.5">CutContour detected</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => {
                      if (strokeSettings.enabled) {
                        onStrokeChange({ enabled: false });
                        setContourPanelOpen(false);
                      } else {
                        onShapeChange({ enabled: false });
                        onStrokeChange({ enabled: true });
                        setContourPanelOpen(true);
                      }
                    }}
                    className={`flex items-center gap-2 py-2 px-3 rounded-lg transition-all font-semibold text-sm border-2 ${
                      strokeSettings.enabled
                        ? 'bg-indigo-600 text-white border-indigo-500 shadow-lg shadow-indigo-600/40 ring-2 ring-indigo-300'
                        : 'bg-indigo-100 text-indigo-900 border-indigo-200 hover:bg-indigo-200 hover:border-indigo-300'
                    }`}
                  >
                    <Spline className={`w-4 h-4 ${strokeSettings.enabled ? 'text-white' : 'text-indigo-600'}`} />
                    Contour
                  </button>
                  <button
                    onClick={() => {
                      if (shapeSettings.enabled) {
                        onShapeChange({ enabled: false });
                        setShapePanelOpen(false);
                      } else {
                        onStrokeChange({ enabled: false });
                        onShapeChange({ enabled: true });
                        setShapePanelOpen(true);
                      }
                    }}
                    className={`flex items-center gap-2 py-2 px-3 rounded-lg transition-all font-semibold text-sm border-2 ${
                      shapeSettings.enabled
                        ? 'bg-emerald-600 text-white border-emerald-500 shadow-lg shadow-emerald-600/40 ring-2 ring-emerald-300'
                        : 'bg-emerald-100 text-emerald-900 border-emerald-200 hover:bg-emerald-200 hover:border-emerald-300'
                    }`}
                  >
                    <Shapes className={`w-4 h-4 ${shapeSettings.enabled ? 'text-white' : 'text-emerald-600'}`} />
                    Shape
                  </button>
                </div>
              )}

              {/* Contour Settings */}
              {strokeSettings.enabled && contourPanelOpen && !(imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour) && (
                <div className="space-y-3 pt-2 border-t border-gray-100">
                  <div>
                    <Label className="text-xs text-gray-500 font-medium">Contour Margin</Label>
                    <Select
                      value={strokeSettings.width.toString()}
                      onValueChange={(value) => onStrokeChange({ width: parseFloat(value) })}
                    >
                      <SelectTrigger className="mt-2 bg-gray-50 border-gray-200 text-gray-900 text-sm rounded-lg">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {detectedAlgorithm === 'scattered' ? (
                          <>
                            <SelectItem value="0.07">Small</SelectItem>
                            <SelectItem value="0.14">Medium</SelectItem>
                            <SelectItem value="0.25">Large</SelectItem>
                          </>
                        ) : (
                          <>
                            <SelectItem value="0">Zero Hero</SelectItem>
                            <SelectItem value="0.02">Small</SelectItem>
                            <SelectItem value="0.04">Medium</SelectItem>
                            <SelectItem value="0.07">Large</SelectItem>
                            <SelectItem value="0.14">Extra Large</SelectItem>
                            <SelectItem value="0.25">Huge</SelectItem>
                          </>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div>
                    <Label className="text-xs text-gray-500 font-medium">Fill Color</Label>
                    <div className="flex items-center gap-3 mt-2">
                      <input
                        type="color"
                        value={strokeSettings.backgroundColor === 'transparent' || strokeSettings.backgroundColor === 'holographic' ? '#FFFFFF' : strokeSettings.backgroundColor}
                        onChange={(e) => onStrokeChange({ backgroundColor: e.target.value })}
                        className="w-8 h-8 rounded-lg cursor-pointer border border-gray-200"
                        disabled={strokeSettings.backgroundColor === 'holographic'}
                      />
                      <div className="flex gap-1.5 flex-wrap">
                        <button
                          onClick={() => onStrokeChange({ backgroundColor: 'transparent' })}
                          className={`w-6 h-6 rounded-lg border relative overflow-hidden transition-all ${strokeSettings.backgroundColor === 'transparent' ? 'ring-2 ring-indigo-500 ring-offset-1' : 'border-gray-200 hover:border-gray-300'}`}
                          style={{ backgroundColor: '#fff' }}
                          title="Transparent"
                        >
                          <div 
                            className="absolute inset-0" 
                            style={{
                              background: 'linear-gradient(to top right, transparent calc(50% - 1px), #ef4444 calc(50% - 1px), #ef4444 calc(50% + 1px), transparent calc(50% + 1px))'
                            }}
                          />
                        </button>
                        {fillPalette.map((color) => (
                          <button
                            key={color}
                            onClick={() => onStrokeChange({ backgroundColor: color })}
                            className={`w-6 h-6 rounded-lg border transition-all ${strokeSettings.backgroundColor === color && strokeSettings.backgroundColor !== 'holographic' ? 'ring-2 ring-indigo-500 ring-offset-1' : 'border-gray-200 hover:border-gray-300'}`}
                            style={{ backgroundColor: color }}
                            title={color}
                          />
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="include-holes"
                      checked={strokeSettings.includeHoles ?? false}
                      onCheckedChange={(checked) => onStrokeChange({ includeHoles: !!checked })}
                    />
                    <Label htmlFor="include-holes" className="text-xs text-gray-500 font-medium cursor-pointer">
                      Include Holes
                    </Label>
                  </div>
                </div>
              )}

              {/* PDF CutContour Options */}
              {imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour && (
                <div className="space-y-3 pt-2 border-t border-gray-100">
                  <div className="text-sm font-medium text-gray-700">PDF Options</div>
                  <div>
                    <Label className="text-xs text-gray-600">Fill Color</Label>
                    <div className="flex items-center gap-2 mt-1">
                      <input
                        type="color"
                        value={strokeSettings.backgroundColor === 'transparent' || strokeSettings.backgroundColor === 'holographic' ? '#FFFFFF' : strokeSettings.backgroundColor}
                        onChange={(e) => onStrokeChange({ backgroundColor: e.target.value })}
                        className="w-8 h-8 rounded cursor-pointer border border-gray-300"
                        disabled={strokeSettings.backgroundColor === 'holographic'}
                      />
                      <div className="flex gap-1 flex-wrap">
                        <button
                          onClick={() => onStrokeChange({ backgroundColor: 'transparent' })}
                          className={`w-5 h-5 rounded border relative overflow-hidden ${strokeSettings.backgroundColor === 'transparent' ? 'ring-2 ring-indigo-500' : 'border-gray-300'}`}
                          style={{ backgroundColor: '#fff' }}
                          title="Transparent / None"
                        >
                          <div 
                            className="absolute inset-0" 
                            style={{
                              background: 'linear-gradient(to top right, transparent calc(50% - 1px), #ef4444 calc(50% - 1px), #ef4444 calc(50% + 1px), transparent calc(50% + 1px))'
                            }}
                          />
                        </button>
                        {fillPalette.map((color) => (
                          <button
                            key={color}
                            onClick={() => onStrokeChange({ backgroundColor: color })}
                            className={`w-5 h-5 rounded border ${strokeSettings.backgroundColor === color && strokeSettings.backgroundColor !== 'holographic' ? 'ring-2 ring-indigo-500' : 'border-gray-300'}`}
                            style={{ backgroundColor: color }}
                            title={color}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Shape Settings - Redesigned UX */}
              {shapeSettings.enabled && shapePanelOpen && !(imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour) && (
                <div className="pt-2 border-t border-gray-100">
                  {/* ── Visual Shape Picker Grid ── */}
                  <div className="grid grid-cols-3 gap-1.5 px-0.5">
                    {([
                      { type: 'circle' as const, label: 'Circle', svg: <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeWidth="2" /> },
                      { type: 'oval' as const, label: 'Oval', svg: <ellipse cx="16" cy="16" rx="15" ry="11" fill="none" stroke="currentColor" strokeWidth="2" /> },
                      { type: 'rounded-rectangle' as const, label: 'Rounded', svg: <rect x="3" y="6" width="26" height="20" rx="5" fill="none" stroke="currentColor" strokeWidth="2" /> },
                      { type: 'square' as const, label: 'Square', svg: <rect x="5" y="5" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" /> },
                      { type: 'rectangle' as const, label: 'Rectangle', svg: <rect x="2" y="7" width="28" height="18" fill="none" stroke="currentColor" strokeWidth="2" /> },
                      { type: 'rounded-square' as const, label: 'Rounded Sq', svg: <rect x="5" y="5" width="22" height="22" rx="5" fill="none" stroke="currentColor" strokeWidth="2" /> },
                    ]).map(s => (
                      <button
                        key={s.type}
                        onClick={() => onShapeChange({ type: s.type })}
                        className={`flex flex-col items-center gap-0.5 py-2 px-1 rounded-lg transition-all ${
                          shapeSettings.type === s.type
                            ? 'bg-emerald-50 ring-2 ring-emerald-400 text-emerald-700 shadow-sm'
                            : 'bg-gray-50 text-gray-500 hover:bg-gray-100 hover:text-gray-700'
                        }`}
                      >
                        <svg width="32" height="32" viewBox="0 0 32 32">{s.svg}</svg>
                        <span className="text-[9px] font-medium leading-tight">{s.label}</span>
                      </button>
                    ))}
                  </div>

                  {/* ── Corner Radius (rounded shapes only) ── */}
                  {(shapeSettings.type === 'rounded-square' || shapeSettings.type === 'rounded-rectangle') && (
                    <div className="mt-2 px-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-gray-400 w-12">Corners</span>
                        <input
                          type="range" min="0.05" max="1.00" step="0.01"
                          value={shapeSettings.cornerRadius || 0.25}
                          onChange={(e) => onShapeChange({ cornerRadius: parseFloat(e.target.value) })}
                          className="flex-1 h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                        />
                        <span className="text-[10px] text-gray-400 w-8 text-right">{(shapeSettings.cornerRadius || 0.25).toFixed(2)}"</span>
                      </div>
                    </div>
                  )}

                  {/* ── Die Size Badge ── */}
                  {(() => {
                    const autoDims = calculateShapeDimensions(resizeSettings.widthInches, resizeSettings.heightInches, shapeSettings.type, shapeSettings.offset);
                    const wVal = shapeSettings.shapeWidthOverride && shapeSettings.shapeWidthOverride > 0 ? shapeSettings.shapeWidthOverride : autoDims.widthInches;
                    const hVal = shapeSettings.shapeHeightOverride && shapeSettings.shapeHeightOverride > 0 ? shapeSettings.shapeHeightOverride : autoDims.heightInches;
                    return (
                      <div className="mt-3 mx-0.5 p-2 bg-gradient-to-r from-emerald-50 to-teal-50 rounded-lg border border-emerald-100">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-semibold text-emerald-700 uppercase tracking-wider">Cut Size</span>
                          <span className="text-sm font-bold text-emerald-800">{wVal.toFixed(2)}" × {hVal.toFixed(2)}"</span>
                        </div>
                      </div>
                    );
                  })()}

                  {/* ── Margin + Fill (Essential Controls) ── */}
                  <div className="mt-3 space-y-2.5 px-0.5">
                    {/* Margin */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <Label className="text-xs text-gray-600 font-medium">Margin</Label>
                        <span className="text-[10px] text-emerald-600 font-mono bg-emerald-50 px-1.5 py-0.5 rounded">{shapeSettings.offset.toFixed(3)}"</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="number" min="0" max="2" step="0.0125"
                          value={shapeSettings.offset}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            if (!isNaN(v) && v >= 0) onShapeChange({ offset: Math.min(2, v) });
                          }}
                          className="w-16 h-7 text-xs text-center border border-gray-300 rounded-lg px-1 bg-white focus:ring-1 focus:ring-emerald-400 focus:border-emerald-400"
                        />
                        <div className="flex gap-1 flex-1">
                          {[{v:0,l:'Zero'},{v:0.0625,l:'Small'},{v:0.125,l:'Medium'},{v:0.25,l:'Large'},{v:0.40,l:'X-Large'}].map(p => (
                            <button
                              key={p.v}
                              onClick={() => onShapeChange({ offset: p.v })}
                              className={`flex-1 py-1 text-[10px] rounded-md font-medium transition-all ${
                                Math.abs(shapeSettings.offset - p.v) < 0.001
                                  ? 'bg-emerald-500 text-white shadow-sm'
                                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                              }`}
                            >
                              {p.l}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Fill Color */}
                    <div>
                      <Label className="text-xs text-gray-600 font-medium">Fill</Label>
                      <div className="flex items-center gap-2 mt-1.5">
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => onShapeChange({ fillColor: 'transparent' })}
                            className={`w-7 h-7 rounded-lg border-2 relative overflow-hidden transition-all ${shapeSettings.fillColor === 'transparent' ? 'ring-2 ring-emerald-500 ring-offset-1' : 'border-gray-200 hover:border-gray-400'}`}
                            style={{ backgroundColor: '#fff' }}
                            title="Transparent"
                          >
                            <div className="absolute inset-0" style={{ background: 'linear-gradient(to top right, transparent calc(50% - 1px), #ef4444 calc(50% - 1px), #ef4444 calc(50% + 1px), transparent calc(50% + 1px))' }} />
                          </button>
                          {fillPalette.map((color) => (
                            <button
                              key={color}
                              onClick={() => onShapeChange({ fillColor: color })}
                              className={`w-7 h-7 rounded-lg border-2 transition-all ${shapeSettings.fillColor === color && shapeSettings.fillColor !== 'holographic' ? 'ring-2 ring-emerald-500 ring-offset-1' : 'border-gray-200 hover:border-gray-400'}`}
                              style={{ backgroundColor: color }}
                              title={color}
                            />
                          ))}
                        </div>
                        <label
                          className="relative flex items-center gap-1 px-2 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg cursor-pointer transition-colors border border-gray-300 shadow-sm"
                          title="Pick custom color"
                        >
                          <Palette className="w-3.5 h-3.5 text-gray-600" />
                          <span className="text-[10px] font-medium text-gray-600">Custom</span>
                          <input
                            type="color"
                            value={shapeSettings.fillColor === 'transparent' || shapeSettings.fillColor === 'holographic' ? '#FFFFFF' : shapeSettings.fillColor}
                            onChange={(e) => onShapeChange({ fillColor: e.target.value })}
                            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                            disabled={shapeSettings.fillColor === 'holographic'}
                          />
                        </label>
                      </div>
                    </div>
                  </div>

                  {/* ── Advanced Settings Toggle ── */}
                  <button
                    onClick={() => setShowShapeAdvanced(!showShapeAdvanced)}
                    className="mt-3 flex items-center gap-1.5 w-full px-1 py-1.5 text-[11px] text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    <Settings2 className="w-3 h-3" />
                    <span>Advanced</span>
                    <ChevronDown className={`w-3 h-3 ml-auto transition-transform ${showShapeAdvanced ? '' : '-rotate-90'}`} />
                  </button>

                  {/* ── Advanced Settings ── */}
                  {showShapeAdvanced && (
                    <div className="space-y-3 px-0.5 pb-1 border-t border-dashed border-gray-100 pt-2">
                      {/* Cut Size Override */}
                      {(() => {
                        const autoDims = calculateShapeDimensions(resizeSettings.widthInches, resizeSettings.heightInches, shapeSettings.type, shapeSettings.offset);
                        const hasOverride = (shapeSettings.shapeWidthOverride && shapeSettings.shapeWidthOverride > 0) || (shapeSettings.shapeHeightOverride && shapeSettings.shapeHeightOverride > 0);
                        const wVal = shapeSettings.shapeWidthOverride && shapeSettings.shapeWidthOverride > 0 ? shapeSettings.shapeWidthOverride : autoDims.widthInches;
                        const hVal = shapeSettings.shapeHeightOverride && shapeSettings.shapeHeightOverride > 0 ? shapeSettings.shapeHeightOverride : autoDims.heightInches;
                        return (
                          <div>
                            <Label className="text-xs text-gray-500">Custom Cut Size</Label>
                            <div className="flex items-center gap-1.5 mt-1">
                              <div className="flex-1">
                                <span className="text-[10px] text-gray-400">W"</span>
                                <input
                                  type="number" min="0.5" max="20" step="0.1"
                                  value={parseFloat(wVal.toFixed(2))}
                                  onChange={(e) => {
                                    const v = parseFloat(e.target.value);
                                    if (!isNaN(v) && v >= 0.5) {
                                      const changes: Partial<ShapeSettings> = { shapeWidthOverride: v };
                                      if (shapeSettings.lockShapeAspect !== false) {
                                        const ratio = autoDims.heightInches / autoDims.widthInches;
                                        changes.shapeHeightOverride = parseFloat((v * ratio).toFixed(3));
                                      }
                                      onShapeChange(changes);
                                    }
                                  }}
                                  className="w-full h-7 text-xs text-center border border-gray-300 rounded px-1 bg-white"
                                />
                              </div>
                              <button
                                onClick={() => onShapeChange({ lockShapeAspect: !(shapeSettings.lockShapeAspect !== false) })}
                                className="mt-3 p-1 rounded hover:bg-gray-100 transition-colors"
                                title={shapeSettings.lockShapeAspect !== false ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                              >
                                {shapeSettings.lockShapeAspect !== false
                                  ? <Link className="w-3.5 h-3.5 text-emerald-500" />
                                  : <Unlink className="w-3.5 h-3.5 text-gray-400" />}
                              </button>
                              <div className="flex-1">
                                <span className="text-[10px] text-gray-400">H"</span>
                                <input
                                  type="number" min="0.5" max="20" step="0.1"
                                  value={parseFloat(hVal.toFixed(2))}
                                  onChange={(e) => {
                                    const v = parseFloat(e.target.value);
                                    if (!isNaN(v) && v >= 0.5) {
                                      const changes: Partial<ShapeSettings> = { shapeHeightOverride: v };
                                      if (shapeSettings.lockShapeAspect !== false) {
                                        const ratio = autoDims.widthInches / autoDims.heightInches;
                                        changes.shapeWidthOverride = parseFloat((v * ratio).toFixed(3));
                                      }
                                      onShapeChange(changes);
                                    }
                                  }}
                                  className="w-full h-7 text-xs text-center border border-gray-300 rounded px-1 bg-white"
                                />
                              </div>
                            </div>
                            {hasOverride && (
                              <button
                                onClick={() => onShapeChange({ shapeWidthOverride: 0, shapeHeightOverride: 0 })}
                                className="mt-1 text-[10px] text-emerald-500 hover:text-emerald-700 font-medium"
                              >
                                Reset to Auto
                              </button>
                            )}
                          </div>
                        );
                      })()}

                      {/* Border */}
                      <div>
                        <div className="flex items-center justify-between">
                          <Label className="text-xs text-gray-500">Printed Border</Label>
                          <input
                            type="checkbox"
                            checked={shapeSettings.strokeEnabled || false}
                            onChange={(e) => onShapeChange({ strokeEnabled: e.target.checked })}
                            className="w-3.5 h-3.5 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                          />
                        </div>
                        {shapeSettings.strokeEnabled && (
                          <div className="flex items-center gap-2 mt-1">
                            <input
                              type="color"
                              value={shapeSettings.strokeColor || '#000000'}
                              onChange={(e) => onShapeChange({ strokeColor: e.target.value })}
                              className="w-6 h-6 rounded cursor-pointer border border-gray-300"
                            />
                            <input
                              type="range" min="0.5" max="4" step="0.25"
                              value={shapeSettings.strokeWidth || 1}
                              onChange={(e) => onShapeChange({ strokeWidth: parseFloat(e.target.value) })}
                              className="flex-1 h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                            />
                            <span className="text-[10px] text-gray-400 w-8 text-right">{(shapeSettings.strokeWidth || 1).toFixed(1)}pt</span>
                          </div>
                        )}
                      </div>

                      {/* Image Position */}
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <Label className="text-xs text-gray-500">Image Position</Label>
                          {(shapeSettings.imageOffsetX || shapeSettings.imageOffsetY || (shapeSettings.imageScale && shapeSettings.imageScale !== 1)) ? (
                            <button
                              onClick={() => onShapeChange({ imageOffsetX: 0, imageOffsetY: 0, imageScale: 1 })}
                              className="text-[9px] text-emerald-500 hover:text-emerald-700 font-medium"
                            >
                              Reset
                            </button>
                          ) : null}
                        </div>
                        <div className="grid grid-cols-3 gap-1.5">
                          <div>
                            <span className="text-[9px] text-gray-400">X offset</span>
                            <input
                              type="number" step="0.01"
                              value={shapeSettings.imageOffsetX || 0}
                              onChange={(e) => onShapeChange({ imageOffsetX: parseFloat(e.target.value) || 0 })}
                              className="w-full h-6 text-[10px] text-center border border-gray-300 rounded px-1 bg-white"
                            />
                          </div>
                          <div>
                            <span className="text-[9px] text-gray-400">Y offset</span>
                            <input
                              type="number" step="0.01"
                              value={shapeSettings.imageOffsetY || 0}
                              onChange={(e) => onShapeChange({ imageOffsetY: parseFloat(e.target.value) || 0 })}
                              className="w-full h-6 text-[10px] text-center border border-gray-300 rounded px-1 bg-white"
                            />
                          </div>
                          <div>
                            <span className="text-[9px] text-gray-400">Scale %</span>
                            <input
                              type="number" min="50" max="200" step="5"
                              value={Math.round((shapeSettings.imageScale || 1) * 100)}
                              onChange={(e) => {
                                const pct = parseInt(e.target.value);
                                if (!isNaN(pct) && pct >= 50 && pct <= 200) onShapeChange({ imageScale: pct / 100 });
                              }}
                              className="w-full h-6 text-[10px] text-center border border-gray-300 rounded px-1 bg-white"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>}

        {/* Spot Colors Button & Panel - Always visible when image is loaded */}
        {imageInfo && (
          <div className="border-b border-gray-100">
            <button
              onClick={handleSpotColorsToggle}
              className={`flex items-center justify-between w-full px-4 py-3 text-left hover:bg-gray-50 transition-colors ${showSpotColors ? 'bg-amber-50' : ''}`}
            >
              <div className="flex items-center gap-2">
                <Palette className="w-4 h-4 text-amber-600" />
                <span className="text-sm font-medium text-gray-700">Enable Spot Colors <span className="text-gray-400 font-normal">(Advanced)</span></span>
              </div>
              <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${showSpotColors ? 'rotate-180' : ''}`} />
            </button>

            {showSpotColors && (
              <div className="px-4 pb-3 space-y-3">
              <div className="flex items-center justify-end mb-2">
                <button
                  onClick={() => setSpotPreviewEnabled(!spotPreviewEnabled)}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors ${
                    spotPreviewEnabled 
                      ? 'bg-amber-100 text-amber-700 border border-amber-300' 
                      : 'bg-gray-100 text-gray-500 border border-gray-300 hover:bg-gray-200'
                  }`}
                  title={spotPreviewEnabled ? "Hide spot preview" : "Show spot preview"}
                >
                  {spotPreviewEnabled ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                  Preview
                </button>
              </div>

              {extractedColors.some(c => c.percentage >= 1) && (() => {
                const bulkAllWhite = extractedColors.every(c => {
                  if (c.regions && c.regions.length > 0) return c.regions.every(r => r.spotWhite);
                  return c.spotWhite;
                });
                const bulkAllGloss = extractedColors.every(c => {
                  if (c.regions && c.regions.length > 0) return c.regions.every(r => r.spotGloss);
                  return c.spotGloss;
                });
                const bulkAllBoth = bulkAllWhite && bulkAllGloss;
                const applyToAll = (white: boolean, gloss: boolean) => {
                  setSpotPreviewEnabled(true);
                  setExtractedColors(prev => prev.map(c => ({
                    ...c,
                    spotWhite: white,
                    spotGloss: gloss,
                    regions: c.regions?.map(r => ({ ...r, spotWhite: white, spotGloss: gloss }))
                  })));
                };
                return (
                <div className="flex items-center gap-1.5 mb-2">
                  <button
                    onClick={() => applyToAll(!bulkAllWhite, bulkAllGloss)}
                    className={`flex-1 px-2 py-1.5 rounded text-[10px] font-bold transition-all border-2 ${
                      bulkAllWhite
                        ? 'bg-orange-500 text-white border-orange-600 shadow-md ring-2 ring-orange-300'
                        : 'bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100'
                    }`}
                  >
                    All White
                  </button>
                  <button
                    onClick={() => applyToAll(bulkAllWhite, !bulkAllGloss)}
                    className={`flex-1 px-2 py-1.5 rounded text-[10px] font-bold transition-all border-2 ${
                      bulkAllGloss
                        ? 'bg-teal-500 text-white border-teal-600 shadow-md ring-2 ring-teal-300'
                        : 'bg-teal-50 text-teal-700 border-teal-200 hover:bg-teal-100'
                    }`}
                  >
                    All Gloss
                  </button>
                  <button
                    onClick={() => bulkAllBoth ? applyToAll(false, false) : applyToAll(true, true)}
                    className={`flex-1 px-2 py-1.5 rounded text-[10px] font-bold transition-all border-2 ${
                      bulkAllBoth
                        ? 'bg-gradient-to-r from-orange-500 to-teal-500 text-white border-orange-400 shadow-md ring-2 ring-purple-300'
                        : 'bg-gradient-to-r from-orange-50 to-teal-50 text-gray-700 border-gray-200 hover:from-orange-100 hover:to-teal-100'
                    }`}
                  >
                    All W+G
                  </button>
                  <button
                    onClick={() => applyToAll(false, false)}
                    className="flex-1 px-2 py-1.5 rounded text-[10px] font-bold transition-all border-2 bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100"
                  >
                    Clear
                  </button>
                </div>
                );
              })()}

              {extractedColors.some(c => c.percentage >= 1) && (
                <div className={`flex items-center gap-1.5 mb-2 rounded-lg border transition-all ${spotPaintMode ? 'px-2 py-1.5 bg-indigo-50 border-indigo-200' : 'border-transparent'}`}>
                  {!spotPaintMode ? (
                    <button
                      onClick={() => onSpotPaintModeChange?.('white')}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium bg-indigo-50 text-indigo-600 border border-indigo-200 hover:bg-indigo-100 hover:border-indigo-300 hover:shadow-sm transition-all cursor-pointer"
                      title="Activate paint tool to select shapes on the preview"
                    >
                      <Pipette className="w-3.5 h-3.5" />
                      Click & Select From Preview
                    </button>
                  ) : (
                    <button
                      onClick={() => onSpotPaintModeChange?.(null)}
                      className="p-1.5 rounded bg-indigo-500 text-white shadow-sm transition-all"
                      title="Deactivate paint tool"
                    >
                      <Pipette className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {spotPaintMode && (
                    <>
                      <div className="w-px h-5 bg-gray-200" />
                      <button
                        onClick={() => onSpotPaintModeChange?.('white')}
                        className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${spotPaintMode === 'white' ? 'bg-orange-400 text-white shadow-sm' : 'text-orange-600 hover:bg-orange-50 border border-orange-200'}`}
                        title="Toggle White on click"
                      >White</button>
                      <button
                        onClick={() => onSpotPaintModeChange?.('gloss')}
                        className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${spotPaintMode === 'gloss' ? 'bg-teal-400 text-white shadow-sm' : 'text-teal-600 hover:bg-teal-50 border border-teal-200'}`}
                        title="Toggle Gloss on click"
                      >Gloss</button>
                      <button
                        onClick={() => onSpotPaintModeChange?.('both')}
                        className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${spotPaintMode === 'both' ? 'bg-gradient-to-r from-orange-400 to-teal-400 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100 border border-gray-200'}`}
                        title="Toggle White + Gloss on click"
                      >W+G</button>
                      <button
                        onClick={() => onSpotPaintModeChange?.('clear')}
                        className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${spotPaintMode === 'clear' ? 'bg-gray-500 text-white shadow-sm' : 'text-gray-500 hover:bg-gray-100 border border-gray-200'}`}
                        title="Clear spot assignment on click"
                      ><X className="w-3 h-3 inline" /></button>
                    </>
                  )}
                </div>
              )}
              
              {!extractedColors.some(c => c.percentage >= 1) ? (
                <div className="text-xs text-gray-500 italic">No colors detected</div>
              ) : (
                <>
                <div ref={colorListRef} className="space-y-2 max-h-[400px] overflow-y-auto">
                  {extractedColors.map((color, index) => ({ color, index })).filter(({ color }) => color.percentage >= 1).map(({ color, index }) => {
                    const hasRegions = color.regions && color.regions.length > 1;
                    const isExpanded = expandedColorIndex === index;
                    const isHighlighted = highlightedColorIndex === index;

                    const allWhite = hasRegions ? color.regions!.every(r => r.spotWhite) : color.spotWhite;
                    const someWhite = hasRegions ? color.regions!.some(r => r.spotWhite) : color.spotWhite;
                    const allGloss = hasRegions ? color.regions!.every(r => r.spotGloss) : color.spotGloss;
                    const someGloss = hasRegions ? color.regions!.some(r => r.spotGloss) : color.spotGloss;
                    const mixedWhite = someWhite && !allWhite;
                    const mixedGloss = someGloss && !allGloss;

                    return (
                      <div key={index} data-color-index={index} className={`bg-white rounded border transition-all ${isHighlighted ? 'border-indigo-400 ring-2 ring-indigo-200' : 'border-gray-200'}`}>
                        <div className="flex items-center gap-3 p-2">
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {hasRegions && (
                              <button
                                onClick={() => setExpandedColorIndex(isExpanded ? null : index)}
                                className="p-0.5 hover:bg-gray-100 rounded"
                                title={`${color.regions!.length} shapes`}
                              >
                                {isExpanded ? <ChevronUp className="w-3 h-3 text-gray-400" /> : <ChevronDown className="w-3 h-3 text-gray-400" />}
                              </button>
                            )}
                            <div
                              className="w-8 h-8 rounded-lg cursor-pointer transition-all border border-gray-300 hover:border-gray-400"
                              style={{ backgroundColor: color.hex }}
                              title="Click to highlight on canvas"
                              onClick={() => handleSwatchClick(index)}
                            />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-mono text-gray-700 truncate">{color.name || color.hex}</div>
                            <div className="text-[10px] text-gray-400">
                              {color.hex} - {color.percentage.toFixed(1)}%
                              {hasRegions && <span className="ml-1 text-indigo-500">({color.regions!.length} shapes)</span>}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              onClick={(e) => { e.stopPropagation(); updateSpotColor(index, 'spotWhite', !color.spotWhite); }}
                              className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${
                                allWhite
                                  ? 'bg-orange-400 text-white shadow-sm'
                                  : someWhite
                                  ? 'bg-orange-200 text-orange-700 border border-orange-300'
                                  : 'text-orange-400 hover:bg-orange-50 border border-orange-200'
                              }`}
                              title={allWhite ? 'Remove White from all shapes' : someWhite ? `White on some shapes (${color.regions?.filter(r => r.spotWhite).length}/${color.regions?.length})` : 'Apply White to all shapes'}
                            >White</button>
                            <button
                              onClick={(e) => { e.stopPropagation(); updateSpotColor(index, 'spotGloss', !color.spotGloss); }}
                              className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${
                                allGloss
                                  ? 'bg-teal-400 text-white shadow-sm'
                                  : someGloss
                                  ? 'bg-teal-200 text-teal-700 border border-teal-300'
                                  : 'text-teal-400 hover:bg-teal-50 border border-teal-200'
                              }`}
                              title={allGloss ? 'Remove Gloss from all shapes' : someGloss ? `Gloss on some shapes (${color.regions?.filter(r => r.spotGloss).length}/${color.regions?.length})` : 'Apply Gloss to all shapes'}
                            >Gloss</button>
                          </div>
                        </div>
                        {hasRegions && isExpanded && (
                          <div className="border-t border-gray-100 px-2 pb-2 pt-1 space-y-1">
                            <span className="text-[10px] text-gray-400 font-medium">Shapes:</span>
                            {color.regions!.map((region) => {
                              const isRegionHighlighted = isHighlighted && highlightedRegionId === region.id;
                              return (
                              <div
                                key={region.id}
                                className={`flex items-center gap-2 px-1 py-0.5 rounded cursor-pointer transition-all ${isRegionHighlighted ? 'bg-blue-50 ring-2 ring-blue-400' : 'hover:bg-gray-50'}`}
                                onClick={() => onHighlightRegion?.(index, region.id)}
                              >
                                {region.thumbnailUrl ? (
                                  <img src={region.thumbnailUrl} alt={`Shape ${region.id + 1}`} className="w-7 h-7 rounded border border-gray-200 object-contain bg-gray-50 flex-shrink-0" />
                                ) : (
                                  <div className="w-5 h-5 rounded border border-gray-300 flex-shrink-0" style={{ backgroundColor: color.hex }} />
                                )}
                                <span className="text-[10px] text-gray-600 flex-1">Shape {region.id + 1}</span>
                                <div className="flex items-center gap-0.5 ml-auto">
                                  <button
                                    onClick={(e) => { e.stopPropagation(); toggleRegionSpot(index, region.id, 'spotWhite'); }}
                                    className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition-all ${region.spotWhite ? 'bg-orange-400 text-white shadow-sm' : 'text-orange-400 hover:bg-orange-50 border border-orange-200'}`}
                                    title={region.spotWhite ? 'Remove White' : 'Add White'}
                                  >White</button>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); toggleRegionSpot(index, region.id, 'spotGloss'); }}
                                    className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition-all ${region.spotGloss ? 'bg-teal-400 text-white shadow-sm' : 'text-teal-400 hover:bg-teal-50 border border-teal-200'}`}
                                    title={region.spotGloss ? 'Remove Gloss' : 'Add Gloss'}
                                  >Gloss</button>
                                </div>
                                <span className="text-[10px] text-gray-400 w-8 text-right">{region.percentage}%</span>
                              </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                </>
              )}

              {extractedColors.some(c => c.spotWhite || c.spotGloss) && (
              <div className="text-[10px] text-gray-400 pt-2 border-t border-gray-200 space-y-1">
                {extractedColors.some(c => c.spotWhite) && <div className="flex items-center gap-1">
                  <span>White →</span>
                  {editingWhiteName ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={tempWhiteName}
                        onChange={(e) => setTempWhiteName(e.target.value)}
                        className="w-24 px-1 py-0.5 text-[10px] border border-gray-300 rounded bg-white text-gray-700"
                        autoFocus
                        onBlur={() => {
                          setSpotWhiteName(tempWhiteName || "RDG_WHITE");
                          setEditingWhiteName(false);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            setSpotWhiteName(tempWhiteName || "RDG_WHITE");
                            setEditingWhiteName(false);
                          } else if (e.key === 'Escape') {
                            setEditingWhiteName(false);
                          }
                        }}
                      />
                      <button
                        onClick={() => {
                          setSpotWhiteName(tempWhiteName || "RDG_WHITE");
                          setEditingWhiteName(false);
                        }}
                        className="p-0.5 hover:bg-amber-100 rounded"
                        title="Save"
                      >
                        <Check className="w-3 h-3 text-emerald-600" />
                      </button>
                      <button
                        onClick={() => setEditingWhiteName(false)}
                        className="p-0.5 hover:bg-red-100 rounded"
                        title="Cancel"
                      >
                        <X className="w-3 h-3 text-red-500" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <span className="font-medium text-gray-600">{spotWhiteName}</span>
                      <button
                        onClick={() => {
                          setTempWhiteName(spotWhiteName);
                          setEditingWhiteName(true);
                        }}
                        className="p-0.5 hover:bg-gray-200 rounded"
                        title="Edit name"
                      >
                        <Pencil className="w-3 h-3 text-gray-500" />
                      </button>
                    </div>
                  )}
                </div>}
                {extractedColors.some(c => c.spotGloss) && <div className="flex items-center gap-1">
                  <span>Gloss →</span>
                  {editingGlossName ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={tempGlossName}
                        onChange={(e) => setTempGlossName(e.target.value)}
                        className="w-24 px-1 py-0.5 text-[10px] border border-gray-300 rounded bg-white text-gray-700"
                        autoFocus
                        onBlur={() => {
                          setSpotGlossName(tempGlossName || "RDG_GLOSS");
                          setEditingGlossName(false);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            setSpotGlossName(tempGlossName || "RDG_GLOSS");
                            setEditingGlossName(false);
                          } else if (e.key === 'Escape') {
                            setEditingGlossName(false);
                          }
                        }}
                      />
                      <button
                        onClick={() => {
                          setSpotGlossName(tempGlossName || "RDG_GLOSS");
                          setEditingGlossName(false);
                        }}
                        className="p-0.5 hover:bg-amber-100 rounded"
                        title="Save"
                      >
                        <Check className="w-3 h-3 text-emerald-600" />
                      </button>
                      <button
                        onClick={() => setEditingGlossName(false)}
                        className="p-0.5 hover:bg-red-100 rounded"
                        title="Cancel"
                      >
                        <X className="w-3 h-3 text-red-500" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <span className="font-medium text-gray-600">{spotGlossName}</span>
                      <button
                        onClick={() => {
                          setTempGlossName(spotGlossName);
                          setEditingGlossName(true);
                        }}
                        className="p-0.5 hover:bg-gray-200 rounded"
                        title="Edit name"
                      >
                        <Pencil className="w-3 h-3 text-gray-500" />
                      </button>
                    </div>
                  )}
                </div>}
              </div>
              )}
              </div>
            )}
          </div>
        )}

        {/* Download Buttons */}
        <div className="px-4 py-3 space-y-2">
          <Button
            onClick={() => onDownload('standard', 'pdf', extractedColors.map(c => ({
              ...c,
              spotWhiteName,
              spotGlossName,
              spotFluorY: false,
              spotFluorM: false,
              spotFluorG: false,
              spotFluorOrange: false,
            })))}
            disabled={isProcessing || !canDownload}
            className="w-full h-11 bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white rounded-lg shadow-lg shadow-indigo-500/25 font-medium"
          >
            {isProcessing ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                Processing...
              </>
            ) : (
              <>
                <Download className="w-5 h-5 mr-2" />
                Download PDF
              </>
            )}
          </Button>

          {canDownload && imageInfo && (
            <Button
              variant="outline"
              onClick={() => onDownload('standard', 'pdf', extractedColors.map(c => ({
                ...c,
                spotWhiteName,
                spotGlossName,
                spotFluorY: false,
                spotFluorM: false,
                spotFluorG: false,
                spotFluorOrange: false,
              })), true)}
              disabled={isProcessing}
              className="w-full h-9 border-gray-200 text-gray-600 hover:bg-gray-50 rounded-lg text-sm"
            >
              <Download className="w-4 h-4 mr-2" />
              All Layers in 1 PDF
            </Button>
          )}
        </div>
      </div>

      {/* Confirm Dialog */}
      <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <DialogContent className="bg-white border-gray-200">
          <DialogHeader>
            <DialogTitle className="text-gray-900">Confirm Send</DialogTitle>
            <DialogDescription className="text-gray-500">
              Send your design to {customerEmail}?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowConfirmDialog(false)}>Cancel</Button>
            <Button onClick={confirmAndSend} className="bg-emerald-600 hover:bg-emerald-700 text-white">Send</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
