#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools>=4.53"]
# ///
"""Build the `fit` mark: mountainscape + plotted series, as SVG and PNG.

Scope right now is the MARK ONLY — no wordmark. The typography is a separate design
problem (parked in `tools/icon/wordmark.py`) and carrying it through every iteration
added noise to a question that is purely about mountains and a line.

The brief, taken from the two keeper generations:
  art/strava-icon/art_20260809_161725_0.png  (light)
  art/strava-icon/art_20260809_161752_0.png  (dark)

Five rules, each one a correction of a specific earlier mistake:

1. THREE tones of purple for the ranges — a far, a middle and a near — not two.
2. The series is a FOURTH purple. Not black, not white. It sits outside the three range
   tones (darker than all of them on light, lighter than all of them on dark) so it
   never reads as the edge of whatever mass it crosses, but it is unmistakably the same
   hue family.
3. The series is INDEPENDENT geometry. It does not trace any ridgeline. An earlier round
   made the line follow the front ridge exactly, which collapsed the mountain and the
   chart into a single shape and destroyed the double reading the whole mark exists for.
4. The line and its nodes share ONE casing, painted in the background colour and drawn
   entirely underneath them. This is what makes the series look cut out of the
   mountainscape. Critically, the nodes do NOT each get their own ring on top — that
   chops the line into segments. Non-summit nodes are the same colour as the line and
   disappear into it; they read as thickenings, not as separate objects.
5. Exactly ONE node has a visible border: the warm summit marker. Its border exists
   because it is the only element whose fill differs from the line, and the border is
   what stops it smearing into the line's silhouette.

Requirements (hard — this script crashes rather than degrading):
  * `resvg` on PATH — rasterises SVG to PNG.

Outputs, per variant, under art/strava-icon/svg/ and art/strava-icon/png/:
  <variant>-light.svg / -dark.svg              solid themed background
  <variant>-light-alpha.svg / -dark-alpha.svg  transparent background
  <variant>-themed.svg                         CSS-variable version that flips itself
  matching PNGs at every size in SIZES
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path
from typing import Callable

from wordmark import (
    FONT_LOCATION,
    Wordmark,
    outline_wordmark,
    place,
    tittle_centre,
    wordmark_group,
)

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / "art" / "strava-icon"
FONT_PATH = ART / "fonts" / "Fraunces.ttf"
SVG_DIR = ART / "svg"
PNG_DIR = ART / "png"

CANVAS = 512
SIZES = (512, 256, 128, 64, 32)

# ── Palette ──────────────────────────────────────────────────────────────────
# Anchored on the OsakaNights theme (--accent is #5c4295 light / #c3b0fd dark), but the
# reference generations are the authority on the tonal SPREAD: three range purples plus
# a fourth for the series.
#
# The tonal order inverts between themes on purpose. The rule is not a fixed hex per
# layer, it is "nearest carries the most contrast against the ground" — which means the
# near range is the deepest purple on light and the brightest lilac on dark.

THEMES: dict[str, dict[str, str]] = {
    "light": {
        "bg": "#faf8f9",  # --bg, and the casing colour
        "far": "#c3b3ec",  # range furthest back — palest
        "mid": "#8b74cf",  # middle range
        "near": "#5c4295",  # nearest range — this IS the --accent token
        "line": "#3a1a8c",  # the series: a fourth purple, deeper AND more saturated
        "spark": "#c96900",  # --series-5, the single warm summit node
    },
    "dark": {
        "bg": "#101010",
        "far": "#3a2a63",
        "mid": "#6b52ab",
        "near": "#b79bff",
        "line": "#dccbff",  # a fourth purple, lighter than every range
        "spark": "#ebb25f",
    },
}

# On the light ramp the series is NOT simply "the darkest purple". An earlier version
# used #2a1359, which sits at roughly 8% luminance — and below about 15% luminance hue
# is imperceptible, so a purple line reads as a black line. The fix was to lift the
# three range tones to make room, then give the series more CHROMA than any of them
# rather than just less lightness. Saturation is what carries hue at low luminance.

# ── Geometry ─────────────────────────────────────────────────────────────────

Point = tuple[float, float]
Peak = tuple[Point, float]  # apex, half-width

BASE_Y = 402.0


def peak_path(apex: Point, half_width: float, base_y: float = BASE_Y) -> str:
    ax, ay = apex
    return (
        f'<path d="M{ax - half_width:.1f} {base_y:.1f}'
        f"L{ax:.1f} {ay:.1f}L{ax + half_width:.1f} {base_y:.1f}Z\"/>"
    )


def mountain_range(peaks: list[Peak], fill: str, dy: float = 0.0) -> str:
    """One tonal layer: overlapping opaque triangles sharing a baseline.

    Opaque, never translucent. Overlapping semi-transparent violets invent a fourth and
    fifth tone that no palette defines, which is how a controlled three-tone scheme
    turns into grey soup.
    """
    body = "".join(peak_path((ax, ay + dy), w) for (ax, ay), w in peaks)
    return f'<g fill="{fill}">{body}</g>'


def series(
    points: list[Point],
    t: dict[str, str],
    *,
    stroke: float,
    casing: float,
    node_r: float,
    spark_index: int,
    spark_scale: float = 1.35,
    casing_opacity: float = 1.0,
    defer_spark: bool = False,
    dy: float = 0.0,
) -> str:
    """The plotted series: one silhouette, cased once, with a single bordered node.

    Draw order is the entire point of this function:

      1. casing   — the polyline at (stroke + 2*casing) AND a disc at (node_r + casing)
                    under every node, all in the BACKGROUND colour. Because this whole
                    layer goes down first, the line and its nodes share one continuous
                    outer edge and the mark appears punched through the mountains.
      2. mark     — the polyline at `stroke` and a disc at `node_r` per node, all in the
                    SAME line colour. Same colour + drawn after the casing means the
                    nodes fuse into the line instead of being ringed by it. This is the
                    correction: rings drawn on top chop the line at every dot.
      3. summit   — the one warm node, which gets its own casing disc precisely because
                    its fill differs from the line and it would otherwise smear into it.

    `casing_opacity` below 1 lets the mountains bleed through the cut-out. It is applied
    to the casing GROUP, never to the individual shapes: the polyline casing and the
    node discs overlap heavily, and per-shape opacity would double-composite every
    overlap into a darker rim, producing a lumpy outline instead of an even veil. Group
    opacity flattens the union first, then fades it once.
    """
    pts = [(x, y + dy) for x, y in points]
    poly = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
    common = 'fill="none" stroke-linecap="round" stroke-linejoin="round"'

    casing_layer = [
        f'<polyline points="{poly}" {common} stroke="{t["bg"]}" '
        f'stroke-width="{stroke + casing * 2:.1f}"/>'
    ]
    mark_layer = [
        f'<polyline points="{poly}" {common} stroke="{t["line"]}" '
        f'stroke-width="{stroke:.1f}"/>'
    ]
    for i, (x, y) in enumerate(pts):
        if i == spark_index:
            continue
        casing_layer.append(
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{node_r + casing:.1f}" fill="{t["bg"]}"/>'
        )
        mark_layer.append(
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{node_r:.1f}" fill="{t["line"]}"/>'
        )

    sx, sy = pts[spark_index]
    sr = node_r * spark_scale
    casing_layer.append(
        f'<circle cx="{sx:.1f}" cy="{sy:.1f}" r="{sr + casing:.1f}" fill="{t["bg"]}"/>'
    )
    summit = "" if defer_spark else spark_node((sx, sy), t, node_r, spark_scale)

    opacity = "" if casing_opacity >= 1.0 else f' opacity="{casing_opacity:g}"'
    return f'<g{opacity}>{"".join(casing_layer)}</g>{"".join(mark_layer)}{summit}'


def spark_node(
    at: Point, t: dict[str, str], node_r: float, spark_scale: float = 1.35
) -> str:
    """The record marker on its own, so it can be re-ordered above the wordmark.

    When the marker doubles as the dot on the `i`, the wordmark has to paint over the
    series (otherwise the purple line cuts across the letterforms) — but the marker must
    still sit on top of the letter it is completing. Splitting it out is what lets the
    same shape be the last thing drawn without dragging the whole series up with it.
    """
    return (
        f'<circle cx="{at[0]:.1f}" cy="{at[1]:.1f}" r="{node_r * spark_scale:.1f}" '
        f'fill="{t["spark"]}"/>'
    )


# ── The mountainscape ────────────────────────────────────────────────────────
#
# Three ranges, far to near. Far is tallest and sits behind everything; near is lowest
# and broadest. Apexes are deliberately off-phase between layers so no two ranges echo
# each other's rhythm — which is what makes the overlaps read as depth rather than as a
# repeated pattern.

# The far range is deliberately huge: it is the only layer with room to fill the upper
# half of the square, and letting it tower over the series is what stops the icon
# reading as a chart with scenery. Half-widths grow with the height so the flanks keep
# roughly their original slope — raising an apex without widening its base turns a
# mountain into a spike.
FAR: list[Peak] = [
    ((118.0, 104.0), 126.0),
    ((252.0, 44.0), 150.0),
    ((396.0, 86.0), 132.0),
]
# Mid climbs, and — more importantly — moves OFF-PHASE from far.
#
# Its summits previously sat at x=190 and x=326, symmetric about far's centre apex at
# x=252. Two peaks straddling a third that way continue its flanks as one unbroken line,
# and all three fuse into a single silhouette. The summits now sit near far's valleys
# (roughly x=185 and x=324) but deliberately offset from the valley floors, because a
# summit landing exactly in a valley merges just as badly in the opposite direction.
MID: list[Peak] = [
    ((60.0, 238.0), 104.0),
    ((170.0, 168.0), 130.0),
    ((300.0, 190.0), 122.0),
    ((438.0, 210.0), 100.0),
]
NEAR: list[Peak] = [
    ((126.0, 300.0), 118.0),
    ((288.0, 258.0), 138.0),
    ((424.0, 302.0), 104.0),
]

# Simplified mountainscape: the SAME three tones, five triangles instead of ten. The
# reduction is in triangle count, never in tonal depth — dropping to two ranges would
# cost a purple, which is the one thing the references are unambiguous about.
FAR_S: list[Peak] = [((256.0, 134.0), 168.0)]
MID_S: list[Peak] = [((146.0, 224.0), 134.0), ((376.0, 204.0), 140.0)]
NEAR_S: list[Peak] = [((206.0, 288.0), 190.0), ((404.0, 300.0), 132.0)]

# The plotted series, at three densities. All three describe the SAME gesture — a low
# start, a dip, a climb, the record, then settling — so the comparison is about how much
# measurement detail the mark carries, not about three different training stories.
SERIES_9: list[Point] = [
    (30.0, 350.0),
    (92.0, 296.0),
    (148.0, 324.0),
    (212.0, 240.0),
    (262.0, 284.0),
    (322.0, 132.0),
    (382.0, 244.0),
    (436.0, 206.0),
    (486.0, 252.0),
]
SERIES_7: list[Point] = [
    (32.0, 352.0),
    (100.0, 300.0),
    (166.0, 246.0),
    (232.0, 292.0),
    (322.0, 132.0),
    (404.0, 234.0),
    (484.0, 260.0),
]
SERIES_5: list[Point] = [
    (36.0, 348.0),
    (132.0, 264.0),
    (218.0, 306.0),
    (322.0, 136.0),
    (480.0, 246.0),
]

# The record node lifted so its CENTRE sits on the same horizontal as the far range's
# centre apex (FAR[1] at y=44). The peak of the plotted series and the peak of the
# mountainscape then share one sightline, which ties the two readings of the mark
# together at exactly the point they both mean the same thing.
FAR_APEX_Y = 44.0
SERIES_5_CREST: list[Point] = [
    *SERIES_5[:3],
    (SERIES_5[3][0], FAR_APEX_Y),
    SERIES_5[4],
]

SPARKS = {9: 5, 7: 4, 5: 3}

# Series weight, settled last round: the chart leads and the mountains are its ground.
HEAVY = {"stroke": 20.0, "casing": 12.0, "node_r": 20.0}


# ── Two axes of variation ────────────────────────────────────────────────────
#
# Every cell below is the same palette, the same gesture and the same series weight.
# Only two things move: how many data points the series carries, and how many triangles
# the mountainscape is built from. Holding everything else fixed is what makes a
# side-by-side mean anything.

# ── Accent candidates ────────────────────────────────────────────────────────
#
# All drawn from the OsakaNights plotly series, scored in tmp/palette_analysis.py by
# hue separation from the base violet and by WCAG contrast against the three surfaces
# the accent actually touches (ground, near range, series purple).
#
# The finding that shapes this table: the wordmark spans BOTH the mountains and the open
# ground, and those sit on opposite sides of the luminance range. Saturated accents win
# against the ground and lose against the purple; pastel accents do the reverse. There
# is no single winner, so these four bracket the trade rather than pretending to solve it.

ACCENTS: dict[str, dict[str, str]] = {
    # 133 deg from the violet — split-complementary. Current pick.
    "amber": {"light": "#c96900", "dark": "#ebb25f"},
    # 178 deg — the true complement, and the best separation from the series purple.
    "lime": {"light": "#649803", "dark": "#6ba304"},
    # Pastel warm: the strongest contrast against the near range on light (4.14:1).
    "sand": {"light": "#e9b26a", "dark": "#e9b26a"},
    # 110 deg, but the highest contrast against the light ground of any candidate.
    "coral": {"light": "#dd5139", "dark": "#ec563d"},
}

Variant = Callable[[dict[str, str]], str]


def mountains(t: dict[str, str], simple: bool = False, invert: bool = False) -> str:
    """Paint the three ranges, back to front.

    `invert` swaps which tone the FAR and NEAR ranges wear. With three tones that swap
    is the only other arrangement there is — the middle range is its own mirror — so
    this flag exhausts the axis rather than sampling it.

    The default is atmospheric perspective: distant ranges wash out toward the ground
    colour and near ones grow denser, which is the cue that makes the mark read as
    landscape. Inverting trades that for flat figure-ground contrast, where the rearmost
    shape shouts and the foreground recedes.
    """
    geometry = (FAR_S, MID_S, NEAR_S) if simple else (FAR, MID, NEAR)
    tones = ("near", "mid", "far") if invert else ("far", "mid", "near")
    return "".join(
        mountain_range(peaks, t[tone]) for peaks, tone in zip(geometry, tones)
    )


# ── Wordmark overlay ─────────────────────────────────────────────────────────
#
# The wordmark rides OVER the whole composition in the spark colour — the same warm tone
# as the record node, so the type and the hero marker read as one accent system rather
# than as two unrelated highlights. It is the only element allowed to break the purple.
#
# Sized by target WIDTH rather than cap height: the brief is that it runs across the
# icon, so the span is the design intent and the resulting cap height is a consequence.

# The wordmark is set LARGE and prominent — roughly 79% of the square wide at cap 250 —
# and it rides over the whole composition in the spark colour. Spark, not a fourth
# purple and not the ground colour, so the type and the record node read as ONE accent
# system rather than as two unrelated highlights. That is what earns it the top layer.
#
# Letterspacing was tried as a way to widen a three-letter word and abandoned: at the
# tracking needed to span the square, the mountains show through the gaps and "F i t"
# stops reading as a word.

WORDMARK_CAP = 250.0
WORDMARK_BASELINE = 330.0

# The x the record marker occupied before it moved onto the tittle. Aligning the dot to
# this column keeps the composition's vertical rhythm even though the word slides off
# centre — the eye still reads a single axis running down through the peak.
FORMER_SPARK_X = 322.0


def axes(weight: float = 700.0, soft: float = 0.0, wonk: float = 1.0) -> dict[str, float]:
    return {**FONT_LOCATION, "wght": weight, "SOFT": soft, "WONK": wonk}


def load_mark(text: str, loc: dict[str, float]) -> Wordmark:
    return outline_wordmark(FONT_PATH, text, location=loc)


def wordmark_overlay(
    t: dict[str, str], mark: Wordmark, fill_role: str = "spark", cx: float = CANVAS / 2
) -> str:
    """The wordmark, over everything.

    `fill_role` exists because the tittle treatment forces the question: if the record
    marker doubles as the dot on the `i` AND the word is spark-coloured, the marker
    disappears into the letter it is completing. Setting the word in the series purple
    keeps spark unique to the record, so one dot reads as both letter and personal best.
    """
    return wordmark_group(
        mark, cx=cx, baseline=WORDMARK_BASELINE, cap_px=WORDMARK_CAP, fill=t[fill_role]
    )


def tittle_point(text: str, loc: dict[str, float], cx: float) -> Point:
    """Canvas coordinates of the dot on the `i`, for the given text and axis location.

    Recomputed per axis location rather than measured once: a heavier or softer `i`
    carries a differently sized dot at a different height, and WONK shifts it sideways.
    A single hardcoded point would sit slightly off the tittle on every setting but one.
    """
    mark = load_mark(text, loc)
    dot = tittle_centre(FONT_PATH, text, text.index("i"), location=loc)
    return place(
        mark, (dot[0], dot[1]), cx=cx, baseline=WORDMARK_BASELINE, cap_px=WORDMARK_CAP
    )


def cx_aligning_tittle(text: str, loc: dict[str, float], target_x: float) -> float:
    """The wordmark centre that puts the tittle on `target_x`.

    Solved rather than searched: `place` is affine, so shifting cx shifts the tittle by
    exactly the same amount, and one evaluation gives the correction.
    """
    at_centre = tittle_point(text, loc, CANVAS / 2)[0]
    return CANVAS / 2 + (target_x - at_centre)


def _cell(
    points: list[Point],
    *,
    simple: bool = False,
    invert: bool = False,
    casing_opacity: float = 1.0,
    text: str | None = None,
    weight: float = 700.0,
    soft: float = 0.0,
    wonk: float = 1.0,
    tittle: bool = False,
    text_fill: str = "spark",
    align_tittle: bool = False,
) -> Variant:
    """One rendered cell.

    `tittle=True` re-routes the series so its record vertex lands exactly on the dot of
    the `i`, making the hero marker and the tittle the same object. The letterform then
    completes the chart, and the chart completes the word.

    `align_tittle=True` slides the whole word off centre so that dot lands on the column
    the record marker used to occupy, trading a centred wordmark for a preserved
    vertical axis.
    """
    loc = axes(weight, soft, wonk)
    cx = CANVAS / 2
    if text and align_tittle:
        cx = cx_aligning_tittle(text, loc, FORMER_SPARK_X)
    mark = load_mark(text, loc) if text else None
    pts = list(points)
    spark_at: Point | None = None
    if tittle:
        if text is None or "i" not in text:
            raise SystemExit("tittle mode needs text containing an 'i'")
        spark_at = tittle_point(text, loc, cx)
        pts[SPARKS[len(points)]] = spark_at

    def build(t: dict[str, str]) -> str:
        body = mountains(t, simple, invert) + series(
            pts,
            t,
            spark_index=SPARKS[len(points)],
            casing_opacity=casing_opacity,
            defer_spark=tittle,
            **HEAVY,
        )
        if mark is not None:
            body += wordmark_overlay(t, mark, text_fill, cx)
        if spark_at is not None:
            body += spark_node(spark_at, t, HEAVY["node_r"])
        return body

    return build


# Settled so far: 5-point series, full massif, normal (atmospheric) depth ramp, tall far
# range with mid off-phase beneath it.
# Open axis: how much the cut-out around the series lets the mountains bleed through.
# Variant keys never differ by CASE ALONE. macOS ships a case-insensitive filesystem by
# default, so `crest-Fit` and `crest-fit` resolve to the same path and the second build
# silently overwrites the first — a bug that is invisible locally until you compare the
# renders, and that would not reproduce on a Linux CI box.
# Locked in by now: lowercase "fit", the record marker doubling as the tittle, a 5-point
# series, the full massif, and a 25% cut-out. Everything below varies exactly one thing.
BASE = dict(points=SERIES_5, casing_opacity=0.25, text="fit", tittle=True)

# Sheet 1 — the Fraunces variable axes. WONK is binary, so w700-s0-flat is the control
# that shows what the wonk is actually contributing.
AXIS_CELLS = {
    "w400-s0": dict(weight=400.0, soft=0.0, wonk=1.0),
    "w400-s100": dict(weight=400.0, soft=100.0, wonk=1.0),
    "w700-s0": dict(weight=700.0, soft=0.0, wonk=1.0),
    "w700-s100": dict(weight=700.0, soft=100.0, wonk=1.0),
    "w900-s50": dict(weight=900.0, soft=50.0, wonk=1.0),
    "w700-s0-flat": dict(weight=700.0, soft=0.0, wonk=0.0),
}

# Sheet 2 — centred wordmark versus one slid across so the tittle sits on the column the
# record marker used to occupy.
ALIGN_CELLS = {
    "centred": dict(align_tittle=False),
    "offset": dict(align_tittle=True),
}

# Sheet 3 — accent colour, on the settled composition.
ACCENT_CELLS = {f"acc-{k}": dict(accent=k) for k in ACCENTS}

VARIANT_ACCENT: dict[str, str] = {}
VARIANTS: dict[str, Variant] = {}


def register(name: str, **kw: object) -> None:
    """Add a variant, peeling `accent` off into its own table.

    The accent cannot ride inside the geometry closure: it has to be resolved per THEME
    at emit time, and the CSS-variable build needs to bake it into the token block. So
    the closure stays colour-agnostic and the accent is looked up by variant name.
    """
    VARIANT_ACCENT[name] = str(kw.pop("accent", "amber"))
    VARIANTS[name] = _cell(**{**BASE, **kw})  # type: ignore[arg-type]


for _name, _kw in AXIS_CELLS.items():
    register(_name, **_kw)
for _name, _kw in ALIGN_CELLS.items():
    register(_name, weight=400.0, soft=100.0, **_kw)
for _name, _kw in ACCENT_CELLS.items():
    register(_name, weight=400.0, soft=100.0, **_kw)

# ── Emitters ─────────────────────────────────────────────────────────────────

HEADER = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" '
    'width="512" height="512" role="img" aria-label="Fit">'
)


def tokens_for(name: str, theme: str) -> dict[str, str]:
    """The theme palette with this variant's chosen accent substituted for `spark`."""
    return {**THEMES[theme], "spark": ACCENTS[VARIANT_ACCENT[name]][theme]}


def literal_svg(name: str, theme: str, *, solid: bool) -> str:
    """A flat SVG with concrete hex values — what rasterisers and Strava want.

    On the transparent build the casing still paints in the theme's background colour:
    the casing is structural, so dropping it would change the drawing rather than just
    the ground. A transparent icon is therefore still a themed icon.
    """
    t = tokens_for(name, theme)
    bg = f'<rect width="512" height="512" fill="{t["bg"]}"/>' if solid else ""
    return f"{HEADER}{bg}{VARIANTS[name](t)}</svg>"


def themed_svg(name: str) -> str:
    """A self-flipping SVG driven by CSS custom properties.

    Three theme states, exactly as tokens.css documents them: bare `:root` carries the
    COMPLETE light palette, `prefers-color-scheme` handles the default "system" state,
    and `[data-theme]` on the <svg> element wins over both. A colour whose only
    definition lives inside a media query has no value at all in that third state —
    hence the full light set first and dark blocks that only REDEFINE.

    CSS variables are a browser feature; rasterisers do not resolve them, which is
    precisely why the literal builds exist alongside this one.
    """
    light, dark = tokens_for(name, "light"), tokens_for(name, "dark")

    def tokens(t: dict[str, str]) -> str:
        return "".join(f"--icon-{k}:{v};" for k, v in t.items())

    refs = {k: f"var(--icon-{k})" for k in light}
    style = (
        f":root{{{tokens(light)}}}"
        f"@media(prefers-color-scheme:dark){{:root:not([data-theme='light'])"
        f"{{{tokens(dark)}}}}}"
        f":root[data-theme='dark']{{{tokens(dark)}}}"
    )
    bg = '<rect width="512" height="512" fill="var(--icon-bg)"/>'
    return f"{HEADER}<style>{style}</style>{bg}{VARIANTS[name](refs)}</svg>"


def rasterise(svg: Path, out: Path, size: int) -> None:
    subprocess.run(
        ["resvg", "--width", str(size), "--height", str(size), str(svg), str(out)],
        check=True,
        capture_output=True,
    )


def main() -> None:
    if shutil.which("resvg") is None:
        raise SystemExit("resvg is not on PATH — install it (brew install resvg) and re-run.")

    for stale in (SVG_DIR, PNG_DIR):
        if stale.exists():
            shutil.rmtree(stale)
    SVG_DIR.mkdir(parents=True)
    PNG_DIR.mkdir(parents=True)

    svgs = pngs = 0
    for name in VARIANTS:
        (SVG_DIR / f"{name}-themed.svg").write_text(themed_svg(name), encoding="utf-8")
        svgs += 1
        for theme in THEMES:
            for solid in (True, False):
                suffix = "" if solid else "-alpha"
                path = SVG_DIR / f"{name}-{theme}{suffix}.svg"
                path.write_text(literal_svg(name, theme, solid=solid), encoding="utf-8")
                svgs += 1
                for size in SIZES:
                    rasterise(path, PNG_DIR / f"{path.stem}@{size}.png", size)
                    pngs += 1

    print(f"wrote {svgs} svg, {pngs} png", file=sys.stderr)
    print(f"  svg: {SVG_DIR.relative_to(ROOT)}")
    print(f"  png: {PNG_DIR.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
