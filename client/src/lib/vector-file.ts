// Format-sniffing for vector uploads (SVG), kept dependency-free so the upload path can tell an SVG apart from a PNG/PDF without pulling in DOMPurify — only `parseSVG` (svg-parser.ts) needs that.

import type { SvgExpansionReport } from './svg-expansion';

export function isSVGFile(file: File): boolean {
  return file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
}

// Not wired into the upload flow yet — kept for API-shape parity with the reference app's vector-file module.
export function isEPSFile(file: File): boolean {
  const t = file.type.toLowerCase();
  return (
    file.name.toLowerCase().endsWith('.eps') ||
    t === 'application/postscript' ||
    t === 'application/eps' ||
    t === 'application/x-eps'
  );
}

// Thrown by svg-expansion's guard before any renderer sees the file — resolving its references would ask for more primitives than a real design ever contains.
export class SvgTooComplexError extends Error {
  readonly code = 'svg_too_complex';
  constructor(readonly report: SvgExpansionReport) {
    super(
      `SVG expands to ~${report.effectivePrimitives.toLocaleString()} rendered shapes ` +
        `(${report.expansionFactor}x its source of ${report.sourcePrimitives.toLocaleString()}); ` +
        `limit hit: ${report.reason}`
    );
    this.name = 'SvgTooComplexError';
  }
}
