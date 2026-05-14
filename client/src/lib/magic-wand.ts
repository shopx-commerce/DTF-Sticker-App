/**
 * Magic-wand thin wrapper around `removeColorAtPoint` from background-removal.ts.
 *
 * Caller passes a tolerance in 0..1 (UI slider range); this maps it to the
 * absolute RGB-distance the worker expects (0..255 covers from "exact match"
 * to "very loose colour matching"). Returns just the cleaned image so callers
 * can drop it straight into `setImageInfo`.
 */
import { removeColorAtPoint } from './background-removal';

export async function magicWandErase(
  image: HTMLImageElement,
  imageX: number,
  imageY: number,
  tolerance: number,
): Promise<HTMLImageElement> {
  const tol01 = Math.max(0, Math.min(1, Number.isFinite(tolerance) ? tolerance : 0.08));
  const rgbTolerance = Math.max(1, Math.round(tol01 * 255));
  const result = await removeColorAtPoint(image, imageX, imageY, {
    tolerance: rgbTolerance,
    featherPx: 1,
  });
  return result.image;
}
