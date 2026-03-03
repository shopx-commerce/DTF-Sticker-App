import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { StrokeSettings, ResizeSettings, ImageInfo, ShapeSettings, StickerSize, type SegmentationData } from "./image-editor";
import { STICKER_SIZES } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";
import { generateContourPDFBase64 } from "@/lib/contour-outline";
import { generateShapePDFBase64 } from "@/lib/shape-outline";
import { getContourWorkerManager, type DetectedAlgorithm } from "@/lib/contour-worker-manager";
import { extractColorsFromImage, detectColorRegionsAsync, ExtractedColor, type ColorExtractionResult } from "@/lib/color-extractor";
import { Download, ChevronDown, ChevronUp, Eye, EyeOff, Pencil, Check, X, Layers, Palette } from "lucide-react";

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
  const colorListRef = useRef<HTMLDivElement>(null);

  const canDownload = !!imageInfo;
  const extractionRef = useRef<ColorExtractionResult | null>(null);

  const fillPalette = (() => {
    const designHexes = extractedColors.slice(0, 8).map(c => c.hex.toUpperCase());
    const palette = [...designHexes];
    if (!palette.includes('#FFFFFF')) palette.push('#FFFFFF');
    if (!palette.includes('#000000')) palette.push('#000000');
    return palette;
  })();

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
      return { ...color, [field]: value };
    }));
  };

  const toggleColorRegion = (colorIndex: number, regionId: number, selected: boolean) => {
    setExtractedColors(prev => prev.map((color, i) => {
      if (i !== colorIndex || !color.regions) return color;
      return {
        ...color,
        regions: color.regions.map(r =>
          r.id === regionId ? { ...r, selected } : r
        ),
      };
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
      {/* Change Design button */}
      {onChangeDesign && (
        <button
          onClick={onChangeDesign}
          className="w-full flex items-center justify-center gap-2 py-2.5 text-sm font-medium bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-400 hover:to-violet-400 text-white rounded-xl shadow-md shadow-indigo-500/30 hover:shadow-indigo-400/40 transition-all"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Change Design
        </button>
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
                      <input
                        type="number"
                        value={Math.round(resizeSettings.widthInches * 100) / 100}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === '' || val === '.') return;
                          const newWidth = Math.max(0.5, Math.min(24, parseFloat(val) || 0.5));
                          if (resizeSettings.maintainAspectRatio && imageInfo) {
                            const aspectRatio = resizeSettings.heightInches / resizeSettings.widthInches;
                            onResizeChange({ widthInches: newWidth, heightInches: newWidth * aspectRatio });
                          } else {
                            onResizeChange({ widthInches: newWidth });
                          }
                        }}
                        min="0.5"
                        max="24"
                        step="0.25"
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
                      <input
                        type="number"
                        value={Math.round(resizeSettings.heightInches * 100) / 100}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === '' || val === '.') return;
                          const newHeight = Math.max(0.5, Math.min(24, parseFloat(val) || 0.5));
                          if (resizeSettings.maintainAspectRatio && imageInfo) {
                            const aspectRatio = resizeSettings.widthInches / resizeSettings.heightInches;
                            onResizeChange({ heightInches: newHeight, widthInches: newHeight * aspectRatio });
                          } else {
                            onResizeChange({ heightInches: newHeight });
                          }
                        }}
                        min="0.5"
                        max="24"
                        step="0.25"
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
            className={`flex items-center justify-between w-full px-4 py-3 text-left hover:bg-gray-50 transition-colors ${showOutlineType ? 'bg-indigo-50' : ''}`}
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
            <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${showOutlineType ? 'rotate-180' : ''}`} />
          </button>

          {showOutlineType && (
            <div className="px-4 pb-3 space-y-3">
              {imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour ? (
                <div className="p-2.5 bg-emerald-50 border border-emerald-100 rounded-lg">
                  <p className="text-sm font-medium text-emerald-700">Cutline already in file</p>
                  <p className="text-xs text-emerald-600 mt-0.5">CutContour detected</p>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => {
                      if (!strokeSettings.enabled && !shapeSettings.enabled) return;
                      onStrokeChange({ enabled: false });
                      onShapeChange({ enabled: false });
                    }}
                    className={`py-2.5 px-3 rounded-lg text-center transition-all font-medium text-sm ${
                      !strokeSettings.enabled && !shapeSettings.enabled
                        ? 'bg-gray-700 text-white shadow-md shadow-gray-700/20'
                        : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    None
                  </button>
                  <button
                    onClick={() => {
                      if (strokeSettings.enabled) {
                        onStrokeChange({ enabled: false });
                      } else {
                        onShapeChange({ enabled: false });
                        onStrokeChange({ enabled: true });
                      }
                    }}
                    className={`py-2.5 px-3 rounded-lg text-center transition-all font-medium text-sm ${
                      strokeSettings.enabled 
                        ? 'bg-indigo-500 text-white shadow-md shadow-indigo-500/20' 
                        : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    Contour
                  </button>
                  <button
                    onClick={() => {
                      if (shapeSettings.enabled) {
                        onShapeChange({ enabled: false });
                      } else {
                        onStrokeChange({ enabled: false });
                        onShapeChange({ enabled: true });
                      }
                    }}
                    className={`py-2.5 px-3 rounded-lg text-center transition-all font-medium text-sm ${
                      shapeSettings.enabled 
                        ? 'bg-emerald-500 text-white shadow-md shadow-emerald-500/20' 
                        : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    Shape
                  </button>
                </div>
              )}

              {/* Contour Settings */}
              {strokeSettings.enabled && !(imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour) && (
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

              {/* Shape Settings */}
              {shapeSettings.enabled && !(imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour) && (
                <div className="space-y-3 pt-2 border-t border-gray-100">
                  <div>
                    <Label className="text-xs text-gray-600">Shape</Label>
                    <Select
                      value={shapeSettings.type}
                      onValueChange={(value) => onShapeChange({ type: value as ShapeSettings['type'] })}
                    >
                      <SelectTrigger className="mt-1 bg-white border-gray-300 text-gray-900 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="square">Square</SelectItem>
                        <SelectItem value="rectangle">Rectangle</SelectItem>
                        <SelectItem value="circle">Circle</SelectItem>
                        <SelectItem value="oval">Oval</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label className="text-xs text-gray-600">Inner Padding</Label>
                    <Select
                      value={shapeSettings.offset.toString()}
                      onValueChange={(value) => onShapeChange({ offset: parseFloat(value) })}
                    >
                      <SelectTrigger className="mt-1 bg-white border-gray-300 text-gray-900 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">Zero Hero</SelectItem>
                        <SelectItem value="0.0625">Small</SelectItem>
                        <SelectItem value="0.125">Medium</SelectItem>
                        <SelectItem value="0.25">Large</SelectItem>
                        <SelectItem value="0.40">Extra Large</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label className="text-xs text-gray-600">Fill Color</Label>
                    <div className="flex items-center gap-2 mt-1">
                      <input
                        type="color"
                        value={shapeSettings.fillColor === 'transparent' || shapeSettings.fillColor === 'holographic' ? '#FFFFFF' : shapeSettings.fillColor}
                        onChange={(e) => onShapeChange({ fillColor: e.target.value })}
                        className="w-8 h-8 rounded cursor-pointer border border-gray-300"
                        disabled={shapeSettings.fillColor === 'holographic'}
                      />
                      <div className="flex gap-1 flex-wrap">
                        <button
                          onClick={() => onShapeChange({ fillColor: 'transparent' })}
                          className={`w-5 h-5 rounded border relative overflow-hidden ${shapeSettings.fillColor === 'transparent' ? 'ring-2 ring-indigo-500' : 'border-gray-300'}`}
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
                            onClick={() => onShapeChange({ fillColor: color })}
                            className={`w-5 h-5 rounded border ${shapeSettings.fillColor === color && shapeSettings.fillColor !== 'holographic' ? 'ring-2 ring-indigo-500' : 'border-gray-300'}`}
                            style={{ backgroundColor: color }}
                            title={color}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                  
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <Label className="text-xs text-gray-600">Bleed</Label>
                      <input
                        type="checkbox"
                        checked={shapeSettings.bleedEnabled || false}
                        onChange={(e) => onShapeChange({ bleedEnabled: e.target.checked })}
                        className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                      />
                    </div>
                    {shapeSettings.bleedEnabled && (
                      <div className="flex items-center gap-2 mt-1">
                        <input
                          type="color"
                          value={shapeSettings.bleedColor || '#FFFFFF'}
                          onChange={(e) => onShapeChange({ bleedColor: e.target.value })}
                          className="w-8 h-8 rounded cursor-pointer border border-gray-300"
                        />
                        <div className="flex gap-1">
                          {fillPalette.map((color) => (
                            <button
                              key={color}
                              onClick={() => onShapeChange({ bleedColor: color })}
                              className={`w-5 h-5 rounded border ${(shapeSettings.bleedColor || '#FFFFFF') === color ? 'ring-2 ring-indigo-500' : 'border-gray-300'}`}
                              style={{ backgroundColor: color }}
                              title={color}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
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
                <span className="text-sm font-medium text-gray-700">Spot Colors & Layers</span>
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

              {extractedColors.some(c => c.percentage >= 1) && (
                <div className="flex items-center gap-1.5 mb-2">
                  <button
                    onClick={() => {
                      setSpotPreviewEnabled(true);
                      setExtractedColors(prev => prev.map(c => ({ ...c, spotWhite: true })));
                    }}
                    className="flex-1 px-2 py-1 rounded text-[10px] font-medium transition-colors bg-orange-50 text-orange-700 border border-orange-200 hover:bg-orange-100"
                  >
                    All White
                  </button>
                  <button
                    onClick={() => {
                      setSpotPreviewEnabled(true);
                      setExtractedColors(prev => prev.map(c => ({ ...c, spotGloss: true })));
                    }}
                    className="flex-1 px-2 py-1 rounded text-[10px] font-medium transition-colors bg-teal-50 text-teal-700 border border-teal-200 hover:bg-teal-100"
                  >
                    All Gloss
                  </button>
                  <button
                    onClick={() => {
                      setExtractedColors(prev => prev.map(c => ({ ...c, spotWhite: false, spotGloss: false })));
                    }}
                    className="flex-1 px-2 py-1 rounded text-[10px] font-medium transition-colors bg-gray-50 text-gray-500 border border-gray-200 hover:bg-gray-100"
                  >
                    Clear All
                  </button>
                </div>
              )}
              
              {!extractedColors.some(c => c.percentage >= 1) ? (
                <div className="text-xs text-gray-500 italic">No colors detected</div>
              ) : (
                <div ref={colorListRef} className="space-y-2 max-h-[400px] overflow-y-auto">
                  {extractedColors.map((color, index) => ({ color, index })).filter(({ color }) => color.percentage >= 1).map(({ color, index }) => {
                    const hasRegions = color.regions && color.regions.length > 1;
                    const isExpanded = expandedColorIndex === index;
                    const isHighlighted = highlightedColorIndex === index;
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
                            <div className="relative">
                              <div
                                className="w-8 h-8 rounded border border-gray-300 cursor-pointer hover:ring-2 hover:ring-blue-300 transition-all"
                                style={{ backgroundColor: color.hex }}
                                title={`Click to highlight ${color.name || color.hex}`}
                                onClick={() => onHighlightRegion?.(index, null)}
                              />
                              {(color.spotWhite || color.spotGloss) && (
                                <div className="absolute -top-1.5 -right-1.5 flex gap-px">
                                  {color.spotWhite && <div className="w-2.5 h-2.5 rounded-full border border-white" style={{ backgroundColor: '#F97316' }} title="White" />}
                                  {color.spotGloss && <div className="w-2.5 h-2.5 rounded-full border border-white" style={{ backgroundColor: '#14B8A6' }} title="Gloss" />}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-mono text-gray-700 truncate">{color.name || color.hex}</div>
                            <div className="text-[10px] text-gray-400">
                              {color.hex} - {color.percentage.toFixed(1)}%
                              {hasRegions && <span className="ml-1 text-indigo-500">({color.regions!.length} shapes)</span>}
                            </div>
                          </div>
                          <div className="flex gap-3">
                                <label className="flex items-center gap-1 cursor-pointer">
                                  <Checkbox
                                    checked={color.spotWhite}
                                    onCheckedChange={(checked) => updateSpotColor(index, 'spotWhite', checked as boolean)}
                                  />
                                  <span className="text-xs text-gray-600">White</span>
                                </label>
                                <label className="flex items-center gap-1 cursor-pointer">
                                  <Checkbox
                                    checked={color.spotGloss}
                                    onCheckedChange={(checked) => updateSpotColor(index, 'spotGloss', checked as boolean)}
                                  />
                                  <span className="text-xs text-gray-600">Gloss</span>
                                </label>
                          </div>
                        </div>
                        {hasRegions && isExpanded && (
                          <div className="border-t border-gray-100 px-2 pb-2 pt-1 space-y-1">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-[10px] text-gray-400 font-medium">Select shapes to include:</span>
                              <button
                                onClick={() => {
                                  const regions = color.regions!;
                                  const allDeselected = regions.every(r => !r.selected);
                                  regions.forEach(r => toggleColorRegion(index, r.id, allDeselected));
                                }}
                                className="text-[9px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors"
                              >
                                {color.regions!.every(r => !r.selected) ? 'Select All' : 'Unselect All'}
                              </button>
                            </div>
                            {color.regions!.map((region) => {
                              const isRegionHighlighted = isHighlighted && highlightedRegionId === region.id;
                              return (
                              <div
                                key={region.id}
                                className={`flex items-center gap-2 px-1 py-0.5 rounded cursor-pointer transition-all ${isRegionHighlighted ? 'bg-blue-50 ring-2 ring-blue-400' : 'hover:bg-gray-50'}`}
                                onClick={() => onHighlightRegion?.(index, region.id)}
                              >
                                <Checkbox
                                  checked={region.selected}
                                  onCheckedChange={(checked) => toggleColorRegion(index, region.id, checked as boolean)}
                                />
                                {region.thumbnailUrl ? (
                                  <img src={region.thumbnailUrl} alt={`Shape ${region.id + 1}`} className="w-7 h-7 rounded border border-gray-200 object-contain bg-gray-50 flex-shrink-0" />
                                ) : (
                                  <div className="w-5 h-5 rounded border border-gray-300 flex-shrink-0" style={{ backgroundColor: color.hex }} />
                                )}
                                <span className="text-[10px] text-gray-600">Shape {region.id + 1}</span>
                                <span className="text-[10px] text-gray-400 ml-auto">{region.percentage}%</span>
                              </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
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
