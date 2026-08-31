// Single point of import for the shared trace algorithms — kept in client/src/lib so there's exactly one copy in the repo; canvas-shim must be imported first, by index.ts.
export { processContour } from '../../client/src/lib/contour-trace-core';
export type { ContourResult } from '../../client/src/lib/contour-trace-core';
export { processSpotColors } from '../../client/src/lib/spot-color-trace-core';
export type { SpotColorInputWorker, SpotColorRegionWorker } from '../../client/src/lib/spot-color-trace-core';
