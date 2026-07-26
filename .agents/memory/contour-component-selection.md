---
name: Contour component selection peers
description: Why near-equal disconnected pieces of a design must bypass the orphan area budget in contour generation
---

Rule: In the contour worker's component selection, a disconnected component whose area is ≥50% of the main component (and that passes the proximity + density gates) is a "peer" — part of the design itself. Peers must be kept and must not consume the orphan `maxExtraArea` budget.

**Why:** A logo split into two solid halves by a transparent gap (each ~96% of the other's area) had one half amputated by the 0.65×main-area orphan budget, producing a cut line that only hugged one half. The budget exists to shed debris/watermarks, not co-equal artwork.

**How to apply:** When tuning component selection or debugging "outline ignores part of the design", check the `[ZH:Component]` verdict logs first — they state exactly why each component was kept/dropped. A useful headless repro exists: the contour worker can be run under Node/tsx by stubbing `self`/`postMessage` and feeding pngjs pixel data (fails only at the final OffscreenCanvas composite, after all tracing logs).
