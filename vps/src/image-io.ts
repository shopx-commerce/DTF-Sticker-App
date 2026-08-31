// PNG <-> ImageData helpers used by the HTTP endpoints — direct @napi-rs/canvas use, independent of canvas-shim's globals.
import { Canvas, ImageData, loadImage } from '@napi-rs/canvas';

export async function pngBase64ToImageData(base64: string): Promise<ImageData> {
  const buf = Buffer.from(base64, 'base64');
  const img = await loadImage(buf);
  const canvas = new Canvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
}

export function pixelsToPngBase64(data: Uint8ClampedArray, width: number, height: number): string {
  const canvas = new Canvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(data, width, height), 0, 0);
  return canvas.toBuffer('image/png').toString('base64');
}

export function base64ToUint8Array(base64?: string): Uint8Array | undefined {
  if (!base64) return undefined;
  return new Uint8Array(Buffer.from(base64, 'base64'));
}
