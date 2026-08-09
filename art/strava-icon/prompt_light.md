# fit.jpeak.ai — Strava OAuth application icon (LIGHT ground variant)
# Lines starting with '#' or '<!--' are STRIPPED before the prompt is sent.
#
# CONCEPT
#   The maintainer's surname is Peak. The mark is a range of abstract mountain
#   peaks that are simultaneously a rising line chart — ridgelines drawn as a
#   polyline with circular data-point nodes at each vertex. Strength-training
#   progress, literally plotted as a skyline.
#
#   The "Fit" wordmark is deliberately NOT generated here — it will be composited
#   on later with /art-edit, where the typeface is exact and free to re-do. This
#   prompt's job is to keep the upper half of the square empty for that text.
#
# STYLE NOTES
#   - Flat vector, geometric, poster-grade. No photorealism, no 3D, no bevels.
#   - Must survive being scaled to 32x32 in Strava's app list: few shapes,
#     thick strokes, one focal accent.
#   - Palette is the app's own design tokens (frontend/src/styles/tokens.css),
#     light theme: bg #faf8f9, fg #1c1a20, accent #5c4295.
#   - Sibling file prompt_dark.md is the same mark on the dark ground. Only the
#     palette paragraph should differ between the two.
#
# REVISION HISTORY
#   rev1 (2026-08-09, art_20260809_161445_0.png) — REJECTED. Two defects:
#     (a) massively over-zoomed; the range ran off every edge and only three
#         peaks were visible. Caused by "its bases running off the left and right
#         edges", which licensed the model to crop. rev2 replaces this with an
#         explicit containment statement.
#     (b) the "RESERVED CLEAR BAND" paragraph was rendered LITERALLY as a visible
#         horizontal stripe in the dark sibling. "Band" is a drawable noun.
#         rev2 states the clear space as empty background instead.
#
# CHECKLIST APPLIED (resources/learned/prompt_checklist.md)
#   #1 — no text is wanted, so no string to be rendered is named anywhere in the
#        prompt body; lettering is excluded by describing absent categories only.
#   #4 — declared original and unbranded; no third-party marks.
#   #5 — constraints written as things to draw wherever possible; and per rev1,
#        a reserved region is described as EMPTY BACKGROUND, never as a "band".
#   #6 — verify sidecar `dimensions` + `estimated_cost_usd` after the first run.
#   #7 — the wordmark is a deterministic art-edit composite, so it is not worth
#        paying a model to guess at kerning.
#
# ── Curated prompt below this line. ──

A flat vector app icon, filling a perfect square edge to edge with no border and no
rounded corners.

BACKGROUND: a solid, completely flat warm off-white field, hex #faf8f9. Absolutely
uniform — no gradient, no texture, no vignette, no noise.

FRAMING — the single most important requirement: this is a WIDE, FULLY ZOOMED-OUT view.
The complete mountain range is small within the square and is entirely visible, with
clear margin all around it. Every peak, both far ends of the range, and every data-point
circle sit comfortably inside the frame. Nothing is cropped, nothing touches or crosses
the top edge, nothing is cut off at the left or right. Think of a small emblem centred in
a large empty square.

EMPTY UPPER HALF: the top half of the square is pure, untouched background colour and
nothing else. No peaks, no strokes, no circles, no marks of any kind reach into it. It is
completely bare.

MAIN MOTIF — mountain range that is also a line chart: sitting in the lower half of the
square is a small range of five sharp, angular, abstract mountain peaks, rendered as
clean geometric triangles with straight edges. The upper ridgeline of the range is
emphasised as a single continuous bold polyline stroke, like the plotted series of a line
chart, stepping generally upward from a low starting point on the left to the tallest
peak at the right of centre, then settling slightly. At every vertex of that ridgeline —
each summit and each valley — sits a small solid filled circle, exactly like the
data-point markers of a chart. The circles are all the same modest size.

DEPTH: two overlapping layers of peaks. The rear layer is a lighter, softer violet and
sits slightly higher and further back; the front layer is the deep saturated violet and
overlaps it. Both layers are completely opaque with hard clean edges where they overlap.
Solid unmodulated fills only — no transparency, no blending, no shading, no gradients, no
atmospheric haze, no glow around anything.

WHOLLY WORDLESS: the image is purely graphic and contains no lettering of any kind — no
words, no captions, no numerals, no signature, no watermark, no monogram, no axis labels,
no tagline, no typography anywhere.

COLOR PALETTE (strict, use nothing outside this list):
  #faf8f9 — the background field
  #5c4295 — the front mountain layer, the ridgeline stroke, and the data-point circles
  #a78fd6 — the rear mountain layer only
  #c96900 — used once and only once: the single data-point circle on the tallest
            summit, which is the one warm focal accent in the whole icon

COMPOSITION: square 1:1. The range is horizontally centred and spans roughly the middle
70% of the square's width, leaving visible background margin at both the left and the
right. Its base rests a little above the bottom edge. Its tallest peak reaches only about
45% of the square's height, so the entire upper half stays empty. The mark is small,
balanced, and instantly readable when shrunk to a thumbnail.

STYLE: flat two-dimensional vector illustration, Swiss poster geometry, crisp hard edges,
solid opaque fills, thick confident strokes. Original and unbranded — an independent
design containing no company logo, badge, emblem or third-party mark of any kind. Not
photorealistic, not painterly, not three-dimensional, no drop shadows, no glow, no gloss,
no reflections, no outlines around the square itself.
