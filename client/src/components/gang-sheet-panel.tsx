import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  packGangSheet,
  downloadGangSheetPDF,
  GANG_SHEET_PRESETS,
  type GangSheetItem,
  type GangSheetSettings,
  type PackResult,
} from "@/lib/gang-sheet";

interface GangSheetPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: GangSheetItem[];
  onItemsChange: (items: GangSheetItem[]) => void;
  settings: GangSheetSettings;
  onSettingsChange: (settings: GangSheetSettings) => void;
}

export default function GangSheetPanel({
  open,
  onOpenChange,
  items,
  onItemsChange,
  settings,
  onSettingsChange,
}: GangSheetPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [loadedImages, setLoadedImages] = useState<Map<string, HTMLImageElement>>(new Map());
  const [fitWarning, setFitWarning] = useState<{ id: string; maxFit: number } | null>(null);

  const packResult: PackResult = useMemo(
    () => packGangSheet(items, settings),
    [items, settings]
  );

  const totalStickers = items.reduce((s, i) => s + i.quantity, 0);

  // Preload thumbnails as images so they're ready for canvas drawing
  useEffect(() => {
    let cancelled = false;
    const newMap = new Map<string, HTMLImageElement>();
    let pending = items.length;
    if (pending === 0) {
      setLoadedImages(newMap);
      return;
    }

    for (const item of items) {
      const img = new Image();
      img.onload = img.onerror = () => {
        if (cancelled) return;
        newMap.set(item.id, img);
        pending--;
        if (pending === 0) setLoadedImages(new Map(newMap));
      };
      img.src = item.thumbnail;
    }

    return () => { cancelled = true; };
  }, [items]);

  const handleQuantityChange = useCallback(
    (id: string, delta: number) => {
      const current = items.find(i => i.id === id);
      if (!current) return;
      const desired = current.quantity + delta;
      if (desired < 1) {
        onItemsChange(items.filter(i => i.id !== id));
        setFitWarning(null);
        return;
      }
      const candidate = items.map(i => i.id === id ? { ...i, quantity: desired } : i);
      const testPack = packGangSheet(candidate, settings);
      if (testPack.overflow > 0) {
        const maxFit = desired - testPack.overflow;
        if (maxFit <= current.quantity) {
          setFitWarning({ id, maxFit: current.quantity });
          setTimeout(() => setFitWarning(null), 3000);
          return;
        }
        const capped = items.map(i => i.id === id ? { ...i, quantity: Math.max(1, maxFit) } : i);
        onItemsChange(capped);
        setFitWarning({ id, maxFit: Math.max(1, maxFit) });
        setTimeout(() => setFitWarning(null), 3000);
      } else {
        onItemsChange(candidate);
        setFitWarning(null);
      }
    },
    [items, onItemsChange, settings]
  );

  const handleQuantitySet = useCallback(
    (id: string, desired: number) => {
      if (desired < 1) {
        onItemsChange(items.filter((item) => item.id !== id));
        setFitWarning(null);
        return;
      }
      const candidate = items.map((item) =>
        item.id === id ? { ...item, quantity: desired } : item
      );
      const testPack = packGangSheet(candidate, settings);
      if (testPack.overflow > 0) {
        const maxFit = desired - testPack.overflow;
        const capped = items.map((item) =>
          item.id === id ? { ...item, quantity: Math.max(1, maxFit) } : item
        );
        onItemsChange(capped);
        setFitWarning({ id, maxFit: Math.max(1, maxFit) });
        setTimeout(() => setFitWarning(null), 3000);
      } else {
        onItemsChange(candidate);
        setFitWarning(null);
      }
    },
    [items, onItemsChange, settings]
  );

  const handleRemove = useCallback(
    (id: string) => {
      onItemsChange(items.filter((item) => item.id !== id));
    },
    [items, onItemsChange]
  );

  const handleClearAll = useCallback(() => {
    onItemsChange([]);
  }, [onItemsChange]);

  const handlePresetChange = useCallback(
    (value: string) => {
      const preset = GANG_SHEET_PRESETS.find((p) => p.label === value);
      if (preset) {
        onSettingsChange({
          ...settings,
          sheetWidth: preset.width,
          sheetHeight: preset.height,
        });
      }
    },
    [settings, onSettingsChange]
  );

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    try {
      await downloadGangSheetPDF(items, settings, packResult.placements);
    } catch (err) {
      console.error("[GangSheet] PDF export failed:", err);
    } finally {
      setIsExporting(false);
    }
  }, [items, settings, packResult]);

  // Render the preview canvas after images are loaded or panel opens
  useEffect(() => {
    if (!open) return;

    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const containerWidth = canvas.parentElement?.clientWidth || 400;
      if (containerWidth <= 0) return;
      const aspect = settings.sheetWidth / settings.sheetHeight;
      const displayWidth = containerWidth;
      const displayHeight = displayWidth / aspect;

    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;
    canvas.width = Math.round(displayWidth * dpr);
    canvas.height = Math.round(displayHeight * dpr);
    ctx.scale(dpr, dpr);

    const scaleX = displayWidth / settings.sheetWidth;
    const scaleY = displayHeight / settings.sheetHeight;

    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, displayWidth, displayHeight);

    ctx.strokeStyle = "#94a3b8";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0.5, 0.5, displayWidth - 1, displayHeight - 1);

    const px = settings.edgePadding * scaleX;
    const py = settings.edgePadding * scaleY;
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 0.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(px, py, displayWidth - px * 2, displayHeight - py * 2);
    ctx.setLineDash([]);

    for (const placement of packResult.placements) {
      const item = items.find((i) => i.id === placement.itemId);
      if (!item) continue;

      const rx = placement.x * scaleX;
      const ry = placement.y * scaleY;
      const rw = placement.width * scaleX;
      const rh = placement.height * scaleY;

      const fillColor = item.shapeSettings?.fillColor || item.contourData.backgroundColor || "#ffffff";
      const bleedColor = item.shapeSettings?.bleedEnabled ? (item.shapeSettings.bleedColor || "#ffffff") : null;
      const rawPathPts = item.contourData.pathPoints;
      const origW = item.contourData.widthInches;
      const origH = item.contourData.heightInches;
      const isShape = !!item.shapeSettings?.enabled;
      const isRotated = !!placement.rotated;

      const pathPts = isRotated && rawPathPts
        ? rawPathPts.map(pt => ({ x: pt.y, y: isShape ? (origW - pt.x) : pt.x }))
        : rawPathPts;
      const contourW = isRotated ? origH : origW;
      const contourH = isRotated ? origW : origH;

      const mapPt = (pt: { x: number; y: number }, sX: number, sY: number) => ({
        px: rx + pt.x * sX,
        py: isShape ? (ry + pt.y * sY) : (ry + (contourH - pt.y) * sY),
      });

      if (pathPts && pathPts.length >= 3 && contourW > 0 && contourH > 0) {
        const pScaleX = rw / contourW;
        const pScaleY = rh / contourH;

        const tracePath = (sX: number, sY: number) => {
          ctx.beginPath();
          for (let i = 0; i < pathPts.length; i++) {
            const { px, py } = mapPt(pathPts[i], sX, sY);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
        };

        if (bleedColor) {
          const bleed = item.contourData.bleedInches || 0.10;
          ctx.fillStyle = bleedColor;
          ctx.strokeStyle = bleedColor;
          tracePath(pScaleX, pScaleY);
          ctx.lineWidth = bleed * Math.min(pScaleX, pScaleY) * 2;
          ctx.lineJoin = "round";
          ctx.stroke();
          ctx.fill();
        }

        ctx.fillStyle = fillColor;
        tracePath(pScaleX, pScaleY);
        ctx.fill();
      } else {
        ctx.fillStyle = fillColor;
        ctx.fillRect(rx, ry, rw, rh);
      }

      const cachedImg = loadedImages.get(item.id);
      if (cachedImg && cachedImg.complete && cachedImg.naturalWidth > 0) {
        const imgAspect = cachedImg.naturalWidth / cachedImg.naturalHeight;
        let imgW: number, imgH: number;
        if (isRotated) {
          imgH = rh * 0.85;
          imgW = imgH * imgAspect;
          if (imgW > rw * 0.85) {
            imgW = rw * 0.85;
            imgH = imgW / imgAspect;
          }
        } else {
          imgW = rw * 0.85;
          imgH = imgW / imgAspect;
          if (imgH > rh * 0.85) {
            imgH = rh * 0.85;
            imgW = imgH * imgAspect;
          }
        }
        const imgX = rx + (rw - imgW) / 2;
        const imgY = ry + (rh - imgH) / 2;

        if (pathPts && pathPts.length >= 3 && contourW > 0 && contourH > 0) {
          ctx.save();
          const pScaleX = rw / contourW;
          const pScaleY = rh / contourH;
          ctx.beginPath();
          for (let i = 0; i < pathPts.length; i++) {
            const { px, py } = mapPt(pathPts[i], pScaleX, pScaleY);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.clip();
          if (isRotated) {
            ctx.save();
            ctx.translate(rx + rw / 2, ry + rh / 2);
            ctx.rotate(-Math.PI / 2);
            const drawW = imgH;
            const drawH = imgW;
            try { ctx.drawImage(cachedImg, -drawW / 2, -drawH / 2, drawW, drawH); } catch { /* ignore */ }
            ctx.restore();
          } else {
            try { ctx.drawImage(cachedImg, imgX, imgY, imgW, imgH); } catch { /* ignore */ }
          }
          ctx.restore();
        } else {
          if (isRotated) {
            ctx.save();
            ctx.translate(rx + rw / 2, ry + rh / 2);
            ctx.rotate(-Math.PI / 2);
            try { ctx.drawImage(cachedImg, -imgH / 2, -imgW / 2, imgH, imgW); } catch { /* ignore */ }
            ctx.restore();
          } else {
            try { ctx.drawImage(cachedImg, imgX, imgY, imgW, imgH); } catch { /* ignore */ }
          }
        }
      }

      ctx.strokeStyle = "#FF00FF";
      ctx.lineWidth = 1;
      if (pathPts && pathPts.length >= 3 && contourW > 0 && contourH > 0) {
        const pScaleX = rw / contourW;
        const pScaleY = rh / contourH;
        ctx.beginPath();
        for (let i = 0; i < pathPts.length; i++) {
          const { px, py } = mapPt(pathPts[i], pScaleX, pScaleY);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      } else {
        ctx.strokeRect(rx, ry, rw, rh);
      }
    }

    ctx.fillStyle = "#64748b";
    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      `${settings.sheetWidth}" x ${settings.sheetHeight}"`,
      displayWidth / 2,
      displayHeight - 4
    );
    };

    draw();
    // Delayed redraw to handle Sheet open animation where canvas has zero width initially
    const timer = setTimeout(draw, 100);
    return () => clearTimeout(timer);
  }, [packResult, items, settings, loadedImages, open]);

  const currentPreset = GANG_SHEET_PRESETS.find(
    (p) => p.width === settings.sheetWidth && p.height === settings.sheetHeight
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-lg flex flex-col p-0"
      >
        <div className="p-6 pb-3 border-b border-gray-100">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <svg
                className="w-5 h-5 text-emerald-600"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
              </svg>
              Gang Sheet
            </SheetTitle>
            <SheetDescription>
              {totalStickers > 0
                ? `${totalStickers} sticker${totalStickers !== 1 ? "s" : ""} from ${items.length} design${items.length !== 1 ? "s" : ""}`
                : "Add stickers from the editor to build your sheet"}
            </SheetDescription>
          </SheetHeader>

          <div className="mt-3 flex items-center gap-3 flex-wrap">
            <label className="text-xs font-medium text-gray-600 shrink-0">
              Sheet
            </label>
            <Select
              value={currentPreset?.label || "custom"}
              onValueChange={handlePresetChange}
            >
              <SelectTrigger className="h-8 text-xs w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GANG_SHEET_PRESETS.map((p) => (
                  <SelectItem key={p.label} value={p.label}>
                    {p.label}"
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex items-center gap-1 text-xs text-gray-500">
              <span>Gap</span>
              <input
                type="number"
                value={settings.gap}
                onChange={(e) =>
                  onSettingsChange({
                    ...settings,
                    gap: Math.max(0, parseFloat(e.target.value) || 0),
                  })
                }
                className="w-12 h-7 text-xs text-center border border-gray-200 rounded px-1"
                step="0.05"
                min="0"
              />
            </div>

            <div className="flex items-center gap-1 text-xs text-gray-500">
              <span>Pad</span>
              <input
                type="number"
                value={settings.edgePadding}
                onChange={(e) =>
                  onSettingsChange({
                    ...settings,
                    edgePadding: Math.max(0, parseFloat(e.target.value) || 0),
                  })
                }
                className="w-12 h-7 text-xs text-center border border-gray-200 rounded px-1"
                step="0.05"
                min="0"
              />
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-hidden flex flex-col">
          {/* Sheet Preview */}
          <div className="px-6 pt-4 pb-2">
            <canvas ref={canvasRef} className="w-full rounded-lg border border-gray-200" />
          </div>

          {packResult.overflow > 0 && (
            <div className="mx-6 mb-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700 flex items-center gap-2">
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              <span>
                {packResult.overflow} sticker{packResult.overflow !== 1 ? "s" : ""} didn't fit.
                Try a larger sheet or reduce quantities.
              </span>
            </div>
          )}

          {/* Item list header */}
          <div className="px-6 pb-1 flex items-center justify-between">
            <div className="text-xs font-medium text-gray-500">
              {items.length > 0
                ? `${items.length} design${items.length !== 1 ? "s" : ""}, ${totalStickers} total \u2014 ${Math.round(packResult.utilization * 100)}% filled`
                : "No items yet"}
            </div>
            {items.length > 0 && (
              <button
                onClick={handleClearAll}
                className="text-[10px] text-red-400 hover:text-red-600 transition-colors"
              >
                Clear all
              </button>
            )}
          </div>

          <ScrollArea className="flex-1 px-6">
            <div className="space-y-2 pb-4">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-3 p-2 bg-gray-50 rounded-lg border border-gray-100"
                >
                  <img
                    src={item.thumbnail}
                    alt="sticker"
                    className="w-12 h-12 object-contain rounded bg-white border border-gray-200"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-gray-700 truncate">
                      {item.contourData.widthInches.toFixed(1)}" x{" "}
                      {item.contourData.heightInches.toFixed(1)}"
                    </div>
                    <div className="text-[10px] text-gray-400">
                      {item.cutContourLabel} &middot;{" "}
                      {item.strokeSettings.width === 0
                        ? "Zero Hero"
                        : `${item.strokeSettings.width.toFixed(2)}" margin`}
                    </div>
                  </div>

                  <div className="flex flex-col items-end gap-0.5">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleQuantityChange(item.id, -1)}
                        className="w-6 h-6 flex items-center justify-center rounded bg-white border border-gray-200 text-gray-500 hover:bg-gray-100 transition-colors text-sm font-medium"
                      >
                        -
                      </button>
                      <input
                        type="number"
                        min="1"
                        value={item.quantity}
                        onChange={(e) => {
                          const val = parseInt(e.target.value);
                          if (!isNaN(val)) handleQuantitySet(item.id, val);
                        }}
                        onFocus={(e) => e.target.select()}
                        className="w-10 h-6 text-center text-xs font-medium text-gray-700 border border-gray-200 rounded bg-white focus:ring-1 focus:ring-emerald-400 focus:border-emerald-400 appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      />
                      <button
                        onClick={() => handleQuantityChange(item.id, 1)}
                        className="w-6 h-6 flex items-center justify-center rounded bg-white border border-gray-200 text-gray-500 hover:bg-gray-100 transition-colors text-sm font-medium"
                      >
                        +
                      </button>
                    </div>
                    {fitWarning?.id === item.id && (
                      <span className="text-[9px] text-amber-600 font-medium animate-pulse">
                        Only {fitWarning.maxFit} fit
                      </span>
                    )}
                  </div>

                  <button
                    onClick={() => handleRemove(item.id)}
                    className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                    title="Remove"
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ))}

              {items.length === 0 && (
                <div className="text-center py-8">
                  <svg className="w-10 h-10 mx-auto mb-3 text-gray-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                  <div className="text-sm text-gray-400 mb-1">No stickers yet</div>
                  <div className="text-xs text-gray-300">
                    Set up a design with a contour, then click
                    <span className="font-medium text-emerald-500"> "Add to Gang Sheet"</span>
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-100 bg-white">
          <Button
            onClick={handleExport}
            disabled={isExporting || packResult.placements.length === 0}
            className="w-full bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {isExporting ? (
              <>
                <svg className="w-4 h-4 animate-spin mr-2" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                  <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" className="opacity-75" />
                </svg>
                Exporting...
              </>
            ) : (
              <>
                <svg className="w-4 h-4 mr-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                Download Gang Sheet PDF
              </>
            )}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
