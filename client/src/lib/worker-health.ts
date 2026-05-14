/**
 * Worker-health probe.
 *
 * Some embedded browsers (notably the Cursor IDE preview, which is an
 * Electron BrowserView) silently swallow `new Worker(...)` — the constructor
 * succeeds, no error event fires, but the worker module never executes and
 * `postMessage` never round-trips. Plain `typeof Worker !== 'undefined'`
 * checks pass in those environments, which is why the rest of the app used
 * to hang forever waiting for a worker that would never reply.
 *
 * This module spins up a tiny inline blob worker on first use, posts it a
 * ping, and waits up to `HEALTH_TIMEOUT_MS` for an echo. The result is
 * cached for the lifetime of the page so every subsequent worker-creation
 * call resolves synchronously after the first probe.
 *
 * Real browsers (Chrome / Edge / Firefox / Safari) resolve the probe in
 * single-digit milliseconds. The Cursor preview times out at the cap and
 * we drop back to whatever main-thread fallback the caller provides.
 */

const HEALTH_TIMEOUT_MS = 1500;

let healthPromise: Promise<boolean> | null = null;

export function workersHealthy(): Promise<boolean> {
  if (healthPromise) return healthPromise;

  healthPromise = new Promise<boolean>((resolve) => {
    if (typeof Worker === 'undefined') {
      console.warn('[WorkerHealth] Worker constructor missing — falling back');
      resolve(false);
      return;
    }

    let probe: Worker | null = null;
    let url: string | null = null;
    let resolved = false;

    const finish = (healthy: boolean, reason: string) => {
      if (resolved) return;
      resolved = true;
      console.log(`[WorkerHealth] verdict: ${healthy ? 'healthy' : 'broken'} (${reason})`);
      try { probe?.terminate(); } catch { /* noop */ }
      if (url) URL.revokeObjectURL(url);
      resolve(healthy);
    };

    try {
      const blob = new Blob(
        [
          'self.onmessage = (e) => {' +
          '  try { self.postMessage({ ok: true, echo: e.data }); }' +
          '  catch (err) { self.postMessage({ ok: false, error: String(err) }); }' +
          '};' +
          'self.postMessage({ ready: true });'
        ],
        { type: 'text/javascript' },
      );
      url = URL.createObjectURL(blob);
      probe = new Worker(url);

      probe.addEventListener('message', (e: MessageEvent) => {
        const data: any = e.data;
        if (data && data.ok && data.echo && data.echo.ping === 1) {
          finish(true, 'echo received');
        } else if (data && data.ready) {
          // Worker module evaluated; now confirm the message loop works.
          probe!.postMessage({ ping: 1 });
        }
      });
      probe.addEventListener('error', (err: ErrorEvent) => {
        finish(false, `error event: ${err.message}`);
      });
      probe.addEventListener('messageerror', () => {
        finish(false, 'messageerror');
      });

      setTimeout(() => finish(false, `timeout after ${HEALTH_TIMEOUT_MS}ms`), HEALTH_TIMEOUT_MS);
    } catch (err) {
      finish(false, `construct threw: ${(err as Error).message}`);
    }
  });

  return healthPromise;
}

/** For tests / forced-fallback scenarios. */
export function resetWorkerHealthCache() {
  healthPromise = null;
}
