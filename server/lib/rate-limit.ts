// Minimal in-memory fixed-window rate limiter for the auth endpoints (blunts brute-force/enumeration).

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Returns true (and increments) if `key` is still under `limit` for this `windowMs` window; false once hit.
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

// Periodic sweep so the map doesn't grow unbounded (forEach avoids needing --downlevelIteration).
setInterval(() => {
  const now = Date.now();
  buckets.forEach((bucket, key) => {
    if (bucket.resetAt <= now) buckets.delete(key);
  });
}, 10 * 60 * 1000).unref();
