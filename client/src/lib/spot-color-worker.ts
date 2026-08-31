// Thin message-handling wrapper; the spot-color-tracing algorithm itself lives in ./spot-color-trace-core.
import {
  WorkerMessage,
  WorkerResponse,
  processSpotColors,
} from './spot-color-trace-core';

self.onmessage = function(e: MessageEvent<WorkerMessage>) {
  try {
    if (e.data.type === 'trace') {
      const { imageBuffer, imageWidth, imageHeight, spotColors, dpi, whiteInclusionMask, glossInclusionMask, fullAlphaMask, allTaggedWhite, allTaggedGloss, exactSelection } = e.data;
      const pixelData = new Uint8ClampedArray(imageBuffer);
      const whiteMask = whiteInclusionMask ? new Uint8Array(whiteInclusionMask) : undefined;
      const glossMask = glossInclusionMask ? new Uint8Array(glossInclusionMask) : undefined;
      const alphaMask = fullAlphaMask ? new Uint8Array(fullAlphaMask) : undefined;
      const regions = processSpotColors(pixelData, imageWidth, imageHeight, spotColors, dpi, whiteMask, glossMask, alphaMask, allTaggedWhite, allTaggedGloss, exactSelection);
      const response: WorkerResponse = { type: 'result', regions };
      self.postMessage(response);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: 'error', error: msg } as WorkerResponse);
  }
};
