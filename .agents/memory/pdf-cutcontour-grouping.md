---
name: PDF CutContour grouping (Illustrator group)
description: Decision + tradeoff for making contour PDF art and cut line one selectable Illustrator group.
---

# Grouping art + cut line in the contour PDF export

Decision: when a contour download needs the artwork and its CutContour cut line
to be "one selectable group" in Illustrator, wrap them in a single PDF **Form
XObject** (`/Subtype /Form`) drawn once. A plain shared content stream does NOT
group objects in Illustrator — only a Form XObject (or OCG layers) does.

**Why:** Illustrator imports a Form XObject as a Group, so art + cut line
select/move together, which is what was requested.

**How to apply / watch out for:**
- Nesting the CutContour `Separation` color space inside the form's own
  `/Resources /ColorSpace` (not page-level) is legal and RIPs read it fine, but
  naive preflight tools that only scan page-level `/ColorSpace` may not list the
  spot plate. First suspect if a cut workflow can't find the plate.
- Keep production spot separations (white/gloss) OUT of the art group.
- Anything that must paint on top of the group (e.g. QR overlay) must be drawn
  after the form, or z-order breaks.
- pdf-lib: an embedded image stays serialized at save even if you never call
  `page.drawImage` — referencing its ref from form resources is enough.
