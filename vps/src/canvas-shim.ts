// Shims the browser globals contour-trace-core.ts expects (ImageData, OffscreenCanvas) via @napi-rs/canvas — import this before anything else.
import { Canvas, ImageData as NapiImageData } from '@napi-rs/canvas';

(globalThis as any).ImageData = NapiImageData;
(globalThis as any).OffscreenCanvas = Canvas;

// contour-trace-core.ts's postProgress() posts to the Worker's `self` — no-op it here so it doesn't throw outside a Worker.
if (typeof (globalThis as any).self === 'undefined') {
  (globalThis as any).self = { postMessage: (_msg: unknown) => {} };
}

// Merges in the ambient types contour-trace-core.ts relies on — this tsconfig deliberately omits lib.dom, which is where they'd normally come from.
declare global {
  type ImageData = NapiImageData;
  // eslint-disable-next-line no-var
  var ImageData: typeof NapiImageData;
  type OffscreenCanvas = Canvas;
  // eslint-disable-next-line no-var
  var OffscreenCanvas: typeof Canvas;
  // eslint-disable-next-line no-var
  var self: { postMessage(msg: unknown): void };
}

export {};
