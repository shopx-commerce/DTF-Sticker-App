import { z } from "zod";

// ─── Serializable design document ─── JSON-safe editor state; derived data (pixelMap, etc.) is excluded, recomputed on load.

export const pointSchema = z.object({ x: z.number(), y: z.number() });

export const strokeSettingsSchema = z.object({
  width: z.number(),
  color: z.string(),
  enabled: z.boolean(),
  alphaThreshold: z.number(),
  backgroundColor: z.string(),
  useCustomBackground: z.boolean(),
  cornerMode: z.literal("rounded"),
  autoBridging: z.boolean(),
  autoBridgingThreshold: z.number(),
  contourMode: z.enum(["smooth", "scattered"]).optional(),
  includeHoles: z.boolean().optional(),
});

export const resizeSettingsSchema = z.object({
  widthInches: z.number(),
  heightInches: z.number(),
  maintainAspectRatio: z.boolean(),
  outputDPI: z.number(),
});

export const shapeSettingsSchema = z.object({
  enabled: z.boolean(),
  type: z.enum(["square", "rectangle", "circle", "oval", "rounded-square", "rounded-rectangle"]),
  offset: z.number(),
  fillColor: z.string(),
  strokeEnabled: z.boolean(),
  strokeWidth: z.number(),
  strokeColor: z.string(),
  cornerRadius: z.number().optional(),
  bleedEnabled: z.boolean().optional(),
  bleedColor: z.string().optional(),
  imageOffsetX: z.number().optional(),
  imageOffsetY: z.number().optional(),
  imageScale: z.number().optional(),
  shapeWidthOverride: z.number().optional(),
  shapeHeightOverride: z.number().optional(),
  lockShapeAspect: z.boolean().optional(),
});

export const lockedContourSchema = z.object({
  label: z.string(),
  pathPoints: z.array(pointSchema),
  previewPathPoints: z.array(pointSchema),
  allPathPoints: z.array(z.array(pointSchema)).optional(),
  allPreviewPathPoints: z.array(z.array(pointSchema)).optional(),
  widthInches: z.number(),
  heightInches: z.number(),
  imageOffsetX: z.number(),
  imageOffsetY: z.number(),
  backgroundColor: z.string(),
  effectiveDPI: z.number(),
  minPathX: z.number(),
  minPathY: z.number(),
  bleedInches: z.number(),
  contourCanvasWidth: z.number(),
  contourCanvasHeight: z.number(),
  imageCanvasX: z.number(),
  imageCanvasY: z.number(),
  imageCanvasWidth: z.number(),
  imageCanvasHeight: z.number(),
});

// Matched back to freshly extracted colors by `hex` on load — never by array index.
export const spotColorTagSchema = z.object({
  hex: z.string(),
  spotWhite: z.boolean(),
  spotGloss: z.boolean(),
  spotFluorY: z.boolean().optional(),
  spotFluorM: z.boolean().optional(),
  spotFluorG: z.boolean().optional(),
  spotFluorOrange: z.boolean().optional(),
  regions: z.array(z.object({ regionId: z.number(), spotWhite: z.boolean().optional(), spotGloss: z.boolean().optional() })).optional(),
});

export const spotColorsSchema = z.object({
  enabled: z.boolean(),
  spotWhiteName: z.string().optional(),
  spotGlossName: z.string().optional(),
  tags: z.array(spotColorTagSchema),
});

export const segmentLayerTagSchema = z.object({
  id: z.string(),
  label: z.string(),
  color: z.string(),
  visible: z.boolean(),
  spotWhite: z.boolean(),
  spotGloss: z.boolean(),
});

export const segmentationSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["colors", "items"]),
  layers: z.array(segmentLayerTagSchema),
});

export const pdfContourSchema = z.object({
  label: z.string(),
  points: z.array(z.array(pointSchema)),
});

export const designSourceSchema = z.object({
  assetId: z.number().int(),
  kind: z.enum(["image", "pdf"]),
  originalWidth: z.number(),
  originalHeight: z.number(),
  dpi: z.number(),
});

export const serializedDesignSchemaV1 = z.object({
  version: z.literal(1),
  source: designSourceSchema,
  strokeSettings: strokeSettingsSchema,
  resizeSettings: resizeSettingsSchema,
  shapeSettings: shapeSettingsSchema,
  strokeMode: z.enum(["none", "contour", "shape"]),
  stickerSize: z.number(),
  cutContourLabel: z.enum(["CutContour", "PerfCutContour", "KissCut"]),
  lockedContour: lockedContourSchema.nullable().optional(),
  spotColors: spotColorsSchema,
  segmentation: segmentationSchema,
  removedColors: z.array(z.string()).optional(),
  qrRerenderEnabled: z.boolean().optional(),
  pdfContours: z.array(pdfContourSchema).optional(),
});

// Union of all versions — currently just v1; add v2 + a migration step when the shape changes.
export const serializedDesignSchema = serializedDesignSchemaV1;

export type SerializedDesign = z.infer<typeof serializedDesignSchema>;
