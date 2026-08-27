import type { PDFCutContourInfo } from './pdf-parser';

export interface ImageInfo {
  file: File;
  image: HTMLImageElement;
  originalWidth: number;
  originalHeight: number;
  dpi: number;
  isPDF?: boolean;
  pdfCutContourInfo?: PDFCutContourInfo;
  originalPdfData?: ArrayBuffer;
  /** Set for SVG uploads — the sanitized source string, retained only to re-rasterise at export/placement size. */
  svgSource?: string;
  /** Set when a PDF/SVG's page was auto-trimmed to its artwork on import — the trimmed box, as a fraction of the full page, so export can reapply it to a render of any size. */
  vectorInkBox?: import('./vector-trim').VectorInkBox;
  /**
   * Hex colours removed by the "Remove Color" tool, most-recent first.
   * Surfaced as the first swatches in fill / bleed pickers so the user can
   * put the original background colour back behind the cut contour after the
   * cutline has been traced against the transparent design — and can pick
   * any of the previously-removed colours, not only the latest one.
   */
  removedColors?: string[];
  /**
   * QR codes detected in the source image (run on upload, off-thread).
   * Each entry includes the decoded payload + the source-pixel bbox so the
   * export pipelines can replace the (potentially blurred-by-resize) source
   * pixels with a freshly-rendered crisp QR at the target print resolution.
   * Empty / undefined = no QRs in this design.
   */
  qrCodes?: import('./qr').DetectedQR[];
  /**
   * `true` once the off-thread QR detection pass has completed for this
   * image (regardless of how many codes were found). Lets the UI tell apart
   * "haven't tried yet" (show spinner) from "tried, found nothing" (show a
   * neutral badge with a re-scan affordance).
   */
  qrDetectionRan?: boolean;
  /**
   * User opt-IN for the QR re-render pass. Default false (= leave the
   * source QR pixels as-is). Detection still runs automatically so we
   * know a QR is present; the re-render (force-square modules, white
   * wipe + halo, logo carve-out, horizontal run-merge) only kicks in
   * after the user clicks the QR badge to enable it.
   *
   * Made opt-in because the re-render visually changes the QR (forces
   * pure-black squares regardless of any custom dot styling, redraws
   * the modules around any centre logo) — a user with a clean,
   * reliable original QR may not want any of that, while a user with
   * a blurry / low-DPI source QR can opt in for crisp prints.
   */
  qrRerenderEnabled?: boolean;
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
