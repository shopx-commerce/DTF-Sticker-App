import type { SerializedDesign } from "@shared/design-document";
import type { ExtractedColor } from "@/lib/color-extractor";
import type {
  StrokeSettings,
  ResizeSettings,
  ShapeSettings,
  StrokeMode,
  StickerSize,
  LockedContour,
  SegmentationData,
  ImageInfo,
} from "@/lib/types";
import type { SpotPreviewData } from "@/components/controls-section";
import { apiRequest } from "@/lib/queryClient";

// ─── Serialize: live editor state -> persistable document (already plain JSON-safe data at save time) ───

export interface SerializeDesignParams {
  sourceAssetId: number;
  imageInfo: ImageInfo;
  strokeSettings: StrokeSettings;
  resizeSettings: ResizeSettings;
  shapeSettings: ShapeSettings;
  strokeMode: StrokeMode;
  stickerSize: StickerSize;
  cutContourLabel: "CutContour" | "PerfCutContour" | "KissCut";
  lockedContour: LockedContour | null;
  spotPreviewData: SpotPreviewData;
  segmentationData: SegmentationData;
}

export function serializeDesign(params: SerializeDesignParams): SerializedDesign {
  const {
    sourceAssetId,
    imageInfo,
    strokeSettings,
    resizeSettings,
    shapeSettings,
    strokeMode,
    stickerSize,
    cutContourLabel,
    lockedContour,
    spotPreviewData,
    segmentationData,
  } = params;

  return {
    version: 1,
    source: {
      assetId: sourceAssetId,
      kind: imageInfo.isPDF ? "pdf" : "image",
      originalWidth: imageInfo.originalWidth,
      originalHeight: imageInfo.originalHeight,
      dpi: imageInfo.dpi,
    },
    strokeSettings,
    resizeSettings,
    shapeSettings,
    strokeMode,
    stickerSize,
    cutContourLabel,
    lockedContour: lockedContour ?? undefined,
    spotColors: {
      enabled: spotPreviewData.enabled,
      spotWhiteName: spotPreviewData.spotWhiteName,
      spotGlossName: spotPreviewData.spotGlossName,
      tags: spotPreviewData.colors.map((c) => ({
        hex: c.hex,
        spotWhite: c.spotWhite,
        spotGloss: c.spotGloss,
        spotFluorY: c.spotFluorY,
        spotFluorM: c.spotFluorM,
        spotFluorG: c.spotFluorG,
        spotFluorOrange: c.spotFluorOrange,
        regions: c.regions?.map((r) => ({
          regionId: r.id,
          spotWhite: r.spotWhite,
          spotGloss: r.spotGloss,
        })),
      })),
    },
    segmentation: {
      enabled: segmentationData.enabled,
      mode: segmentationData.mode,
      layers: segmentationData.layers.map((l) => ({
        id: l.id,
        label: l.label,
        color: l.color,
        visible: l.visible,
        spotWhite: l.spotWhite,
        spotGloss: l.spotGloss,
      })),
    },
    removedColors: imageInfo.removedColors,
    qrRerenderEnabled: imageInfo.qrRerenderEnabled,
  };
}

// ─── Restore: reattach tags to fresh colors, matched by hex/regionId, never by array index ───
export function matchSpotTagsToColors(
  tags: SerializedDesign["spotColors"]["tags"],
  freshColors: ExtractedColor[]
): ExtractedColor[] {
  if (tags.length === 0) return freshColors;
  const byHex = new Map(tags.map((t) => [t.hex.toUpperCase(), t]));

  return freshColors.map((color) => {
    const tag = byHex.get(color.hex.toUpperCase());
    if (!tag) return color;
    return {
      ...color,
      spotWhite: tag.spotWhite,
      spotGloss: tag.spotGloss,
      spotFluorY: tag.spotFluorY ?? color.spotFluorY,
      spotFluorM: tag.spotFluorM ?? color.spotFluorM,
      spotFluorG: tag.spotFluorG ?? color.spotFluorG,
      spotFluorOrange: tag.spotFluorOrange ?? color.spotFluorOrange,
      regions: color.regions?.map((region) => {
        const regionTag = tag.regions?.find((r) => r.regionId === region.id);
        if (!regionTag) return region;
        return {
          ...region,
          spotWhite: regionTag.spotWhite ?? region.spotWhite,
          spotGloss: regionTag.spotGloss ?? region.spotGloss,
        };
      }),
    };
  });
}

// ─── Asset upload / fetch ────────────────────────────────────────────────

export interface UploadedAsset {
  id: number;
  kind: string;
  r2Key: string;
}

export async function uploadAsset(
  file: File | Blob,
  filename: string,
  kind: "source_image" | "source_pdf" | "thumbnail",
  dims?: { width: number; height: number }
): Promise<UploadedAsset> {
  const form = new FormData();
  form.append("file", file, filename);
  form.append("kind", kind);
  if (dims) {
    form.append("width", String(dims.width));
    form.append("height", String(dims.height));
  }
  const res = await apiRequest("POST", "/api/assets", form);
  const data = await res.json();
  return data.asset as UploadedAsset;
}

export async function getAssetUrl(assetId: number): Promise<string> {
  const res = await apiRequest("GET", `/api/assets/${assetId}/url`);
  const data = await res.json();
  return data.url as string;
}

export async function fetchAssetAsFile(assetId: number, filename: string, mime: string): Promise<File> {
  // Same-origin proxy, not R2's URL directly — R2 doesn't send CORS headers, so fetch() to it fails.
  const res = await apiRequest("GET", `/api/assets/${assetId}/file`);
  const blob = await res.blob();
  return new File([blob], filename, { type: mime });
}
