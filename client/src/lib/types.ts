export interface PDFCutContourInfo {
  hasCutContour: boolean;
  cutContourPath: Path2D | null;
  cutContourPoints: { x: number; y: number }[][];
  pageWidth: number;
  pageHeight: number;
}

export interface ImageInfo {
  file: File;
  image: HTMLImageElement;
  originalWidth: number;
  originalHeight: number;
  dpi: number;
  isPDF?: boolean;
  pdfCutContourInfo?: PDFCutContourInfo;
  originalPdfData?: ArrayBuffer;
}

export type ContourMode = 'smooth' | 'scattered';

export interface StrokeSettings {
  width: number;
  color: string;
  enabled: boolean;
  alphaThreshold: number;
  backgroundColor: string;
  useCustomBackground: boolean;
  cornerMode: 'rounded';
  autoBridging: boolean;
  autoBridgingThreshold: number;
  contourMode?: ContourMode;
  includeHoles?: boolean;
}

export type StrokeMode = 'none' | 'contour' | 'shape';

export interface ResizeSettings {
  widthInches: number;
  heightInches: number;
  maintainAspectRatio: boolean;
  outputDPI: number;
}

export interface ShapeSettings {
  enabled: boolean;
  type: 'square' | 'rectangle' | 'circle' | 'oval' | 'rounded-square' | 'rounded-rectangle';
  offset: number;
  fillColor: string;
  strokeEnabled: boolean;
  strokeWidth: number;
  strokeColor: string;
  cornerRadius?: number;
  bleedEnabled?: boolean;
  bleedColor?: string;
  imageOffsetX?: number;
  imageOffsetY?: number;
  imageScale?: number;
  shapeWidthOverride?: number;
  shapeHeightOverride?: number;
  lockShapeAspect?: boolean;
}

export type CutlineVisibility = 'thin' | 'normal' | 'bold';

export type StickerSize = 2 | 2.5 | 3 | 3.5 | 4 | 4.5 | 5 | 5.5 | 6;

export const STICKER_SIZES: { value: StickerSize; label: string }[] = [
  { value: 2, label: '2 inch' },
  { value: 2.5, label: '2.5 inch' },
  { value: 3, label: '3 inch' },
  { value: 3.5, label: '3.5 inch' },
  { value: 4, label: '4 inch' },
  { value: 4.5, label: '4.5 inch' },
  { value: 5, label: '5 inch' },
  { value: 5.5, label: '5.5 inch' },
  { value: 6, label: '6 inch' },
];

export interface SpotColorData {
  hex: string;
  rgb: { r: number; g: number; b: number };
  spotWhite: boolean;
  spotGloss: boolean;
}

export interface SegmentLayer {
  id: string;
  label: string;
  maskDataUrl: string;
  color: string;
  visible: boolean;
  area: number;
  boundingBox: { x: number; y: number; width: number; height: number };
  spotWhite: boolean;
  spotGloss: boolean;
}

export interface SegmentationData {
  enabled: boolean;
  layers: SegmentLayer[];
  mode: 'colors' | 'items';
}

export const LAYER_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#BB8FCE', '#85C1E9', '#F0B27A', '#82E0AA',
];

export interface LockedContour {
  label: string;
  pathPoints: Array<{x: number; y: number}>;
  previewPathPoints: Array<{x: number; y: number}>;
  allPathPoints?: Array<Array<{x: number; y: number}>>;
  allPreviewPathPoints?: Array<Array<{x: number; y: number}>>;
  widthInches: number;
  heightInches: number;
  imageOffsetX: number;
  imageOffsetY: number;
  backgroundColor: string;
  effectiveDPI: number;
  minPathX: number;
  minPathY: number;
  bleedInches: number;
  contourCanvasWidth: number;
  contourCanvasHeight: number;
  imageCanvasX: number;
  imageCanvasY: number;
  imageCanvasWidth: number;
  imageCanvasHeight: number;
}
