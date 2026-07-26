---
name: Spot color / design alignment
description: Rules keeping exported spot separations (RDG_WHITE/GLOSS/fluor) aligned with the design across edits
---

Rule 1: Any PDF export path must trace/scale the spot layer at the SAME dimensions the design raster is drawn at. In the contour PDF the design is drawn at aspect-corrected dims (contourImageW/H, which exceed resizeSettings on one axis when image natural AR ≠ resize AR) — the spot tracer must receive those dims, never raw resizeSettings.

Rule 2: The spot pixelMap is captured from the image at tagging time (≤1000px). Image edits (bg removal, crop, erase) regenerate it and clear selections; but a download racing regeneration can see a stale map. traceColorRegionsAsync has a staleness guard: if map AR deviates >2% from the current image natural AR it discards the map (console.warn) and falls back to live color matching, which cannot drift.

**Why:** Users saw spot plates shifted/squashed vs the artwork after remove-background/crop/resize; root cause was resizeSettings passed to the spot tracer while the design was drawn at contourImageW/H.

**How to apply:** When adding/altering any download path that emits spot separations, mirror the exact geometry (dims + offsets) of the design draw. Preview and export must also share inclusion semantics and skip morphological closing for exact selections (see exactSelection flag in spot-color-worker).
