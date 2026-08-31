// VPS offload health probe — mirrors worker-health.ts's pattern (memoized single promise, short timeout, cached for the page's lifetime).
const HEALTH_TIMEOUT_MS = 1500;

export function offloadUrl(): string {
  return import.meta.env.VITE_OFFLOAD_URL || '';
}

let healthPromise: Promise<boolean> | null = null;

// Empty VITE_OFFLOAD_URL = the kill switch — offload disabled entirely, no network call ever made.
export function offloadHealthy(): Promise<boolean> {
  if (healthPromise) return healthPromise;

  const url = offloadUrl();
  if (!url) {
    healthPromise = Promise.resolve(false);
    return healthPromise;
  }

  healthPromise = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      const res = await fetch(`${url}/health`, { signal: controller.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  })();

  return healthPromise;
}

// For tests / forced-fallback scenarios.
export function resetOffloadHealthCache() {
  healthPromise = null;
}
