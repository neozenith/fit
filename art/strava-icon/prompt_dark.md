# fit.jpeak.ai — Strava OAuth application icon (DARK ground variant)
# Lines starting with '#' or '<!--' are STRIPPED before the prompt is sent.
#
# CONCEPT
#   Identical mark to prompt_light.md — abstract mountain peaks (surname: Peak)
#   doubling as a rising line chart — inverted onto the app's dark theme so the
#   icon holds up on Strava's dark surfaces. No wordmark: "Fit" is composited on
#   later with /art-edit, and this prompt keeps the upper half empty for it.
#
# STYLE NOTES
#   - Keep the geometry text byte-for-byte identical to prompt_light.md; ONLY the
#     background line and the palette paragraph differ. Divergence is a defect.
#   - Palette from frontend/src/styles/tokens.css dark theme:
#     bg #101010, fg #dddddd, accent #c3b0fd.
#
# REVISION HISTORY
#   rev1 (2026-08-09, art_20260809_161510_0.png) — REJECTED, same two defects as
#   the light sibling plus one of its own:
#     (a) over-zoomed, range cropped off every edge;
#     (b) "RESERVED CLEAR BAND" drawn literally as a visible horizontal stripe;
#     (c) the dark ground invited glow and semi-transparent overlaps, breaking the
#         flat-fill style. rev2 demands opacity explicitly.
#
# CHECKLIST APPLIED (resources/learned/prompt_checklist.md): #1, #4, #5, #6, #7 —
#   see prompt_light.md for the reasoning.
#
# ── Curated prompt below this line. ──

A flat vector app icon, filling a perfect square edge to edge with no border and no
rounded corners.

BACKGROUND: a solid, completely flat near-black field, hex #101010. Absolutely uniform —
no gradient, no texture, no vignette, no noise.

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

DEPTH: two overlapping layers of peaks. The rear layer is a deeper, dimmer violet and
sits slightly higher and further back; the front layer is the bright pale violet and
overlaps it. Both layers are completely opaque with hard clean edges where they overlap.
Solid unmodulated fills only — no transparency, no blending, no shading, no gradients, no
atmospheric haze, no glow around anything.

WHOLLY WORDLESS: the image is purely graphic and contains no lettering of any kind — no
words, no captions, no numerals, no signature, no watermark, no monogram, no axis labels,
no tagline, no typography anywhere.

COLOR PALETTE (strict, use nothing outside this list):
  #101010 — the background field
  #c3b0fd — the front mountain layer, the ridgeline stroke, and the data-point circles
  #5c4295 — the rear mountain layer only
  #ebb25f — used once and only once: the single data-point circle on the tallest
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
