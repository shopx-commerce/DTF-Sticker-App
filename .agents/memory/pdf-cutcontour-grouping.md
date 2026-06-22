---
name: PDF CutContour grouping (Illustrator group)
description: How/why the contour PDF export wraps art + cut line into one selectable Illustrator group, and the spot-color tradeoff.
---

# CutContour grouping in contour PDF export

The contour download (`downloadContourPDF` in `client/src/lib/contour-outline.ts`)
wraps the bleed background image, the design raster, and the CutContour cut
path(s) (active + locked) into a SINGLE PDF Form XObject (`/Subtype /Form`),
drawn once on the page via `q /ArtCutGroup Do Q`. Adobe Illustrator imports a
Form XObject as one Group, so the artwork and its cut line select/move together.

**Why:** user explicitly wanted art + cut line as one selectable group in
Illustrator. A plain shared content stream does NOT group objects in AI — only a
Form XObject (or OCG layers) does.

**How to apply / constraints:**
- The CutContour `Separation` color spaces live in the FORM's `/Resources
  /ColorSpace`, not page-level. RIPs detect spot colors fine when nested, BUT
  naive preflight tools that scan only page-level `/ColorSpace` may not list the
  plate. If a cut workflow can't find the spot plate, this nesting is the first
  suspect.
- Spot-color white/gloss layers are intentionally kept OUT of the group (added
  after, on the page) — they are production separations, not art.
- Vector QR overlay must be drawn AFTER the form `Do` so QR modules stay on top
  (z-order). Background is emitted first inside the form, then design, then cut.
- Image refs (`pngImage.ref`, `bgPngImage.ref`) stay valid without
  `page.drawImage`: `embedPng` registers the image objects; referencing them via
  form resources keeps them serialized at save.
- Scope: only `downloadContourPDF`. `generateContourPDFBase64`, shape export
  (`shape-outline.ts`), and gang-sheet export were NOT changed. Replicate this
  pattern there only if the same grouping is explicitly requested.
