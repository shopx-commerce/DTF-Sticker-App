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
  maxQuantityForItem,
  clampGangSheetQuantity,
  downloadGangSheetPDF,
  GANG_SHEET_PRESETS,
  type GangSheetItem,
  type GangSheetSettings,
  type PackResult,
} from "@/lib/gang-sheet";
import type { BezierPath } from "@/lib/contour-worker-manager";

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
  const previewWrapperRef = useRef<HTMLDivElement>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [loadedImages, setLoadedImages] = useState<Map<string, HTMLImageElement>>(new Map());
  const [fitWarning, setFitWarning] = useState<{ id: string; maxFit: number } | null>(null);

  const packResult: PackResult = useMemo(
    () => packGangSheet(items, settings),
    [items, settings]
  );

  const totalStickers = items.reduce((s, i) => s + clampGangSheetQuantity(i.quantity), 0);
  const placedStickers = packResult.placements.length;

  // Per-item "fits-on-current-sheet" status. A design is TOO BIG when its
  // bounding box exceeds the usable sheet area in BOTH orientations (the
  // packer also auto-rotates, so we mirror that check here). Recomputed on
  // every settings change so the badge follows the sheet size.
  const fitInfo = useMemo(() => {
    const usableW = settings.sheetWidth - settings.edgePadding * 2;
    const usableH = settings.sheetHeight - settings.edgePadding * 2;
    const tooBigIds = new Set<string>();
    if (usableW <= 0 || usableH <= 0) {
      // Pathological sheet — every design is "too big" for it.
      for (const i of items) tooBigIds.add(i.id);
      return { tooBigIds, usableW, usableH };
    }
    for (const item of items) {
      const w = item.contourData.widthInches;
      const h = item.contourData.heightInches;
      if (!(w > 0) || !(h > 0)) continue;
      const fitsNormal = w <= usableW && h <= usableH;
      const fitsRotated = h <= usableW && w <= usableH;
      if (!fitsNormal && !fitsRotated) tooBigIds.add(item.id);
    }
    return { tooBigIds, usableW, usableH };
  }, [items, settings.sheetWidth, settings.sheetHeight, settings.edgePadding]);

  const tooBigCount = fitInfo.tooBigIds.size;
  const tooBigList = items.filter((i) => fitInfo.tooBigIds.has(i.id));

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
      const rawNext = (Number(current.quantity) || 0) + delta;
      if (rawNext < 1) {
        onItemsChange(items.filter(i => i.id !== id));
        setFitWarning(null);
        return;
      }
      const desired = clampGangSheetQuantity(rawNext);
      const candidate = items.map(i => i.id === id ? { ...i, quantity: desired } : i);
      const testPack = packGangSheet(candidate, settings);
      if (testPack.overflow > 0) {
        const maxFit = maxQuantityForItem(items, settings, id);
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
      const safeDesired = clampGangSheetQuantity(desired);
      if (!Number.isFinite(desired) || desired < 1) {
        onItemsChange(items.filter((item) => item.id !== id));
        setFitWarning(null);
        return;
      }
      const candidate = items.map((item) =>
        item.id === id ? { ...item, quantity: safeDesired } : item
      );
      const testPack = packGangSheet(candidate, settings);
      if (testPack.overflow > 0) {
        const maxFit = maxQuantityForItem(items, settings, id);
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

  // Render the preview canvas after images are loaded or panel opens.
  //
  // Coordinate convention notes (must match `gang-sheet.ts` / PDF export):
  //   • contourData.pathPoints / allPathPoints are in PDF inches Y-up,
  //     anchored at the bottom-left of the item's local page (which already
  //     includes bleed). For Shape mode they are top-down instead.
  //   • The PDF `remapPathToSheet` for a NON-rotated, non-shape point gives
  //         canvas_x = rx + p.x * scaleX
  //         canvas_y = ry + (origH - p.y) * scaleY
  //   • The PDF `remapPathToSheet` for a ROTATED, non-shape point gives
  //         canvas_x = rx + (origH - p.y) * scaleX
  //         canvas_y = ry + p.x * scaleY
  //   The previous version of this preview implemented the rotated case as
  //   `(p.y, origW-p.x)` which is 180° off from the PDF — silent but
  //   dangerous; users would see a cut path that doesn't match the printer
  //   output for any rotated placement. The transforms below now match the
  //   PDF exactly.
  useEffect(() => {
    if (!open) return;

    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const wrapper = previewWrapperRef.current;
      const wrapperClient = wrapper?.clientWidth ?? canvas.parentElement?.clientWidth ?? 400;
      if (wrapperClient <= 0) return;

      // `clientWidth` includes the wrapper's horizontal padding (px-6 = 24px
      // each side). Strip it so the canvas sits inside the content area
      // rather than overflowing it.
      const wrapperStyle = wrapper ? window.getComputedStyle(wrapper) : null;
      const padLeft = wrapperStyle ? parseFloat(wrapperStyle.paddingLeft) || 0 : 24;
      const padRight = wrapperStyle ? parseFloat(wrapperStyle.paddingRight) || 0 : 24;
      const padTop = wrapperStyle ? parseFloat(wrapperStyle.paddingTop) || 0 : 16;
      const padBottom = wrapperStyle ? parseFloat(wrapperStyle.paddingBottom) || 0 : 8;
      const containerWidth = Math.max(40, wrapperClient - padLeft - padRight);

      // Available height for the canvas: the wrapper's max-height minus the
      // wrapper's padding. The wrapper itself is capped by CSS so this is a
      // hard ceiling that prevents the canvas from pushing the item list
      // off-screen for tall sheets.
      const viewportCap = Math.max(160, Math.min(window.innerHeight * 0.5, 480));
      const availableHeight = Math.max(120, viewportCap - padTop - padBottom);

      const aspect = settings.sheetWidth / settings.sheetHeight;
      // Aspect-fit inside (containerWidth × availableHeight): for tall sheets
      // we narrow the canvas instead of overflowing the panel.
      let displayWidth = containerWidth;
      let displayHeight = displayWidth / aspect;
      if (displayHeight > availableHeight) {
        displayHeight = availableHeight;
        displayWidth = displayHeight * aspect;
      }
      // CSS pixel rounding to avoid sub-pixel canvas blur.
      displayWidth = Math.max(40, Math.floor(displayWidth));
      displayHeight = Math.max(40, Math.floor(displayHeight));

      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = `${displayHeight}px`;
      canvas.width = Math.round(displayWidth * dpr);
      canvas.height = Math.round(displayHeight * dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0); // reset any prior dpr scale
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
        const origW = item.contourData.widthInches;
        const origH = item.contourData.heightInches;
        const isShape = !!item.shapeSettings?.enabled;
        const isRotated = !!placement.rotated;

        // Per-axis scale from item-local PDF inches to canvas pixels.
        // After rotation the placement bbox is (origH × origW), so
        // pScaleX maps p.y_pdf-range and pScaleY maps p.x_pdf-range.
        const pScaleX = isRotated ? rw / origH : rw / origW;
        const pScaleY = isRotated ? rh / origW : rh / origH;

        // Single source of truth for path-point → canvas. Mirrors
        // `remapPathToSheet` in gang-sheet.ts (sheet-relative, then expressed
        // in canvas pixels relative to the placement top-left at (rx, ry)).
        const mapPt = (pt: { x: number; y: number }) => {
          let dx: number, dy: number;
          if (isRotated) {
            if (isShape) {
              dx = pt.y * pScaleX;
              dy = (origW - pt.x) * pScaleY;
            } else {
              dx = (origH - pt.y) * pScaleX;
              dy = pt.x * pScaleY;
            }
          } else {
            dx = pt.x * pScaleX;
            dy = (isShape ? pt.y : (origH - pt.y)) * pScaleY;
          }
          return { px: rx + dx, py: ry + dy };
        };

        // Same transform applied to a Bezier path's anchors and control
        // points so that smooth curves remain accurate after rotation.
        // Returns a new BezierPath in canvas-pixel coords.
        const mapBezierPath = (bp: BezierPath) => {
          const tx = (p: { x: number; y: number }) => mapPt(p);
          const start = tx(bp.start);
          const segs = bp.segments.map((seg) =>
            seg.type === "line"
              ? { type: "line" as const, to: tx(seg.to) }
              : { type: "cubic" as const, cp1: tx(seg.cp1), cp2: tx(seg.cp2), to: tx(seg.to) }
          );
          return { start, segs };
        };

        // -- Resolve the geometry to draw -------------------------------------
        // Zero Hero items now carry `allBezierPaths` (corner-aware Schneider
        // fits + ellipse snap). Use them so the gang-sheet preview matches
        // the main preview *and* the PDF cut path. Falls back to the
        // polyline list when bezier data isn't present.
        const isZeroHero = item.strokeSettings.width === 0;
        const bezierPaths = isZeroHero ? item.contourData.allBezierPaths : undefined;
        const hasBezier = !!(bezierPaths && bezierPaths.length > 0);

        // Polyline view of the geometry — used as a fallback and for fill.
        // Honors `allPathPoints` (multi-component + holes) instead of just
        // the primary contour the previous code rendered.
        const allPaths = item.contourData.allPathPoints && item.contourData.allPathPoints.length > 0
          ? item.contourData.allPathPoints
          : (item.contourData.pathPoints ? [item.contourData.pathPoints] : []);
        const holeStart = item.contourData.holePathStartIndex;
        const outerPolylines = holeStart != null ? allPaths.slice(0, holeStart) : allPaths;
        const holePolylines = holeStart != null ? allPaths.slice(holeStart) : [];

        const hasOuterGeom =
          (hasBezier && bezierPaths!.length > 0) ||
          (outerPolylines.length > 0 && outerPolylines[0].length >= 3);

        // -- Helpers to trace the geometry to ctx -----------------------------
        const traceBezierPath = (bp: BezierPath) => {
          const { start, segs } = mapBezierPath(bp);
          ctx.moveTo(start.px, start.py);
          for (const seg of segs) {
            if (seg.type === "line") {
              ctx.lineTo(seg.to.px, seg.to.py);
            } else {
              ctx.bezierCurveTo(
                seg.cp1.px, seg.cp1.py,
                seg.cp2.px, seg.cp2.py,
                seg.to.px, seg.to.py
              );
            }
          }
          ctx.closePath();
        };

        const tracePolyline = (path: Array<{ x: number; y: number }>) => {
          if (path.length < 2) return;
          for (let i = 0; i < path.length; i++) {
            const { px, py } = mapPt(path[i]);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
        };

        // Build a Path2D-like sequence for fill. With holes we need
        // even-odd so interior cutouts are not filled.
        const traceAllForFill = () => {
          ctx.beginPath();
          if (hasBezier) {
            for (const bp of bezierPaths!) traceBezierPath(bp);
          } else {
            for (const p of outerPolylines) tracePolyline(p);
          }
          // Holes are only available as polylines today; render them
          // alongside outer Béziers so the even-odd fill rule punches them
          // out of the fill.
          for (const hp of holePolylines) tracePolyline(hp);
        };

        if (hasOuterGeom && origW > 0 && origH > 0) {
          if (bleedColor) {
            const bleed = item.contourData.bleedInches || 0.10;
            ctx.fillStyle = bleedColor;
            ctx.strokeStyle = bleedColor;
            ctx.lineWidth = bleed * Math.min(pScaleX, pScaleY) * 2;
            ctx.lineJoin = "round";
            traceAllForFill();
            ctx.stroke();
            ctx.fill("evenodd");
          }

          ctx.fillStyle = fillColor;
          traceAllForFill();
          ctx.fill("evenodd");
        } else {
          ctx.fillStyle = fillColor;
          ctx.fillRect(rx, ry, rw, rh);
        }

        // -- Design image (clipped to outer cut path) -------------------------
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

          if (hasOuterGeom && origW > 0 && origH > 0) {
            ctx.save();
            ctx.beginPath();
            if (hasBezier) {
              for (const bp of bezierPaths!) traceBezierPath(bp);
            } else {
              for (const p of outerPolylines) tracePolyline(p);
            }
            for (const hp of holePolylines) tracePolyline(hp);
            // `clip()` defaults to nonzero. Use evenodd so holes are
            // properly excluded from the clip region.
            ctx.clip("evenodd");
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

        // -- Magenta cut-line stroke (matches PDF spot color visually) -------
        ctx.strokeStyle = "#FF00FF";
        ctx.lineWidth = 1;
        ctx.lineJoin = "round";
        if (hasOuterGeom && origW > 0 && origH > 0) {
          if (hasBezier) {
            for (const bp of bezierPaths!) {
              ctx.beginPath();
              traceBezierPath(bp);
              ctx.stroke();
            }
          } else {
            for (const p of outerPolylines) {
              ctx.beginPath();
              tracePolyline(p);
              ctx.stroke();
            }
          }
          for (const hp of holePolylines) {
            ctx.beginPath();
            tracePolyline(hp);
            ctx.stroke();
          }
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

    // Re-draw on viewport resize so the canvas re-fits when the user resizes
    // the window (otherwise a desktop-sized canvas stays huge after shrink).
    const onResize = () => draw();
    window.addEventListener("resize", onResize);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
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
          {/* Sheet Preview — capped to a viewport-relative max height so
              tall sheets (4×6, 22×22, 48×48) can never push the item list
              off-screen. The drawing effect computes displayWidth so that
              displayWidth/aspect stays within the wrapper's available
              height; horizontal centering uses `mx-auto` on the canvas
              when it ends up narrower than the wrapper. */}
          <div
            ref={previewWrapperRef}
            className="px-6 pt-4 pb-2 flex-shrink-0 overflow-auto"
            style={{ maxHeight: "min(50vh, 480px)" }}
          >
            {/* `width:fit-content` shrinks this wrapper to the canvas's
                rendered CSS size so the absolutely-positioned badge below
                anchors to the *canvas's* top-right corner (not the panel's).
                `mx-auto` then centers it horizontally inside the scroll
                wrapper. */}
            <div
              className="relative mx-auto"
              style={{ width: "fit-content" }}
            >
              <canvas
                ref={canvasRef}
                className="block rounded-lg border border-gray-200"
              />
              {/* Live sticker-count badge overlaid on the top-right of the
                  sheet. Reflects how many stickers actually fit on the
                  CURRENT sheet — updates automatically whenever the user
                  changes the sheet preset, gap, padding, or quantities,
                  because `placedStickers` is derived from `packResult`. */}
              {items.length > 0 && (
                <div
                  className="absolute top-2 right-2 pointer-events-none flex items-center gap-1.5 px-2 py-1 rounded-md bg-white/90 backdrop-blur-sm border border-gray-200 shadow-sm"
                  title={
                    placedStickers === totalStickers
                      ? `${placedStickers} sticker${placedStickers !== 1 ? "s" : ""} on this sheet`
                      : `${placedStickers} fit / ${totalStickers} requested`
                  }
                >
                  <svg
                    className="w-3 h-3 text-emerald-600"
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
                  <span className="text-xs font-semibold text-gray-800 leading-none">
                    {placedStickers}
                    {placedStickers !== totalStickers && (
                      <span className="text-gray-400 font-normal"> / {totalStickers}</span>
                    )}
                  </span>
                  <span className="text-[10px] text-gray-500 leading-none">
                    qty
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Always-visible summary block. Reflects the CURRENT sheet, so
              numbers update live whenever the user picks a different preset
              or tweaks gap/padding. */}
          <div className="mx-6 mb-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-xs flex items-center justify-between gap-2">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-medium text-gray-700">
                {items.length} design{items.length !== 1 ? "s" : ""}
              </span>
              <span className="text-gray-400">·</span>
              <span className="text-gray-600">
                {placedStickers}
                {placedStickers !== totalStickers && (
                  <span className="text-gray-400"> / {totalStickers}</span>
                )}
                <span className="text-gray-400"> sticker{totalStickers !== 1 ? "s" : ""}</span>
              </span>
              <span className="text-gray-400">·</span>
              <span className="text-gray-600">
                {Math.round(packResult.utilization * 100)}% filled
              </span>
            </div>
            <span className="text-[10px] text-gray-400 shrink-0">
              {settings.sheetWidth}" × {settings.sheetHeight}"
            </span>
          </div>

          {/* TOO BIG banner — design exceeds usable sheet area in BOTH
              orientations. Distinct from the "ran out of space" warning
              below; users need to either pick a larger sheet preset or
              resize the design itself. */}
          {tooBigCount > 0 && (
            <div className="mx-6 mb-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 flex items-start gap-2">
              <svg className="w-4 h-4 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">
                  {tooBigCount === 1
                    ? "Design is TOO BIG for this sheet"
                    : `${tooBigCount} designs are TOO BIG for this sheet`}
                </div>
                <ul className="mt-1 space-y-0.5">
                  {tooBigList.slice(0, 4).map((item) => (
                    <li key={item.id} className="font-mono text-[11px]">
                      {item.contourData.widthInches.toFixed(1)}" × {item.contourData.heightInches.toFixed(1)}"
                      <span className="text-red-500/70">
                        {" "}(max {fitInfo.usableW.toFixed(1)}" × {fitInfo.usableH.toFixed(1)}")
                      </span>
                    </li>
                  ))}
                  {tooBigList.length > 4 && (
                    <li className="text-red-500/70">…and {tooBigList.length - 4} more</li>
                  )}
                </ul>
                <div className="mt-1 text-red-600/80">
                  Pick a larger sheet preset or resize the design before adding.
                </div>
              </div>
            </div>
          )}

          {/* "Didn't fit due to space" — only show for overflow that ISN'T
              caused by oversized designs (those are explained above). */}
          {packResult.overflow > 0 && tooBigCount === 0 && (
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
              {items.length > 0 ? "In gang sheet" : "No items yet"}
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
              {items.map((item) => {
                const isTooBig = fitInfo.tooBigIds.has(item.id);
                return (
                <div
                  key={item.id}
                  className={`flex items-center gap-3 p-2 rounded-lg border ${
                    isTooBig
                      ? "bg-red-50 border-red-200"
                      : "bg-gray-50 border-gray-100"
                  }`}
                >
                  <img
                    src={item.thumbnail}
                    alt="sticker"
                    className="w-12 h-12 object-contain rounded bg-white border border-gray-200"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-gray-700 truncate flex items-center gap-1.5">
                      <span>
                        {item.resizeSettings.widthInches.toFixed(1)}" x{" "}
                        {item.resizeSettings.heightInches.toFixed(1)}"
                      </span>
                      {isTooBig && (
                        <span className="px-1.5 py-0.5 rounded bg-red-600 text-white text-[9px] font-bold tracking-wide leading-none">
                          TOO BIG
                        </span>
                      )}
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
                );
              })}

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
