#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools>=4.53"]
# ///
"""Build the fit app-icon exploration: hand-authored SVG variants + rasterised PNGs.

Why this exists
---------------
The AI generations in `art/strava-icon/art_*.png` settled the *style*; this script
settles the *geometry*. Everything downstream of a design decision here is
deterministic: the same inputs always produce byte-identical SVGs, so a tweak is a diff
rather than a re-roll, and the light and dark icons can never drift apart because both
are projections of ONE geometry through the OsakaNights design tokens.

The central idea, from the brief: the surname is Peak, and the mountains must also read
as a line chart. Round 1 drew those as two stacked objects and they fought. Here the
plotted series traces the front range's own ridgeline — one silhouette, two readings.

Two forms come out of every variant, because they are genuinely different artifacts:
  * icon   — wordless, the mark fills the square. This is the Strava OAuth app icon.
  * lockup — the same mark scaled down with the Fraunces wordmark beneath it.
A three-letter serif wordmark is unreadable at 32px; pretending otherwise is how an app
icon ends up as grey mush in a list view.

Requirements (hard — this script crashes rather than degrading):
  * `art/strava-icon/fonts/Fraunces.ttf` — the variable font, outlined at build time.
  * `resvg` on PATH — rasterises SVG to PNG.

Outputs, per variant and form, under art/strava-icon/svg/ and art/strava-icon/png/:
  <variant>-<form>-light.svg / -dark.svg              solid themed background
  <variant>-<form>-light-alpha.svg / -dark-alpha.svg  transparent background
  <variant>-<form>-themed.svg                         CSS-variable version that flips
  matching PNGs at every size in SIZES
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / "art" / "strava-icon"
FONT_PATH = ART / "fonts" / "Fraunces.ttf"
SVG_DIR = ART / "svg"
PNG_DIR = ART / "png"

CANVAS = 512
SIZES = (512, 128, 32)

# ── Design tokens ────────────────────────────────────────────────────────────
# Lifted verbatim from the OsakaNights theme
# (.claude/skills/richdocs/resources/themes/osakanights/design-tokens.json and its
# projection in frontend/src/styles/tokens.css). Named by ROLE, so a theme change is a
# value change in one table and never a hunt through path data.
#
# OsakaNights fonts, for the record: display 'Fraunces', body 'Fira Sans',
# mono 'JetBrains Mono'. The wordmark uses display.

THEMES: dict[str, dict[str, str]] = {
    "light": {
        "bg": "#faf8f9",  # --bg          the ground
        "ink": "#1c1a20",  # --fg          wordmark, and the plotted series
        "front": "#5c4295",  # --accent      the front range
        "rear": "#a78fd6",  # accent, lifted  the range behind it
        "spark": "#c96900",  # --series-5    the one warm node, on the summit
    },
    "dark": {
        "bg": "#101010",
        "ink": "#ffffff",
        "front": "#c3b0fd",
        "rear": "#5c4295",
        "spark": "#ebb25f",
    },
}

# ── Wordmark ─────────────────────────────────────────────────────────────────

WORDMARK = "Fit"
# Fraunces is a variable font; pin the axis location so the outline is reproducible.
# wght 700 for weight at small sizes, opsz 144 for display-optical proportions, and
# SOFT/WONK at 0 to keep terminals crisp against the hard-edged mountain geometry.
FONT_LOCATION = {"wght": 700.0, "opsz": 144.0, "SOFT": 0.0, "WONK": 0.0}


@dataclass(frozen=True)
class Wordmark:
    """An outlined string: SVG path data plus the metrics needed to place it."""

    path: str
    width: float
    upem: float
    cap_height: float


def outline_wordmark(text: str, tracking: float = 0.0) -> Wordmark:
    """Outline `text` from Fraunces into SVG path data, in font units, y-up.

    `tracking` is extra letterspacing in font units, applied between glyphs only.
    """
    if not FONT_PATH.exists():
        raise SystemExit(
            f"Fraunces not found at {FONT_PATH}.\n"
            "Fetch it with:\n"
            "  curl -sSL -o art/strava-icon/fonts/Fraunces.ttf \\\n"
            "    'https://github.com/google/fonts/raw/main/ofl/fraunces/"
            "Fraunces%5BSOFT%2CWONK%2Copsz%2Cwght%5D.ttf'"
        )

    font = TTFont(FONT_PATH)
    upem = float(font["head"].unitsPerEm)
    cap_height = float(getattr(font["OS/2"], "sCapHeight", 0.7 * upem))
    cmap = font.getBestCmap()
    glyph_set = font.getGlyphSet(location=FONT_LOCATION)

    parts: list[str] = []
    pen_x = 0.0
    for i, char in enumerate(text):
        name = cmap.get(ord(char))
        if name is None:
            raise SystemExit(f"Fraunces has no glyph for {char!r}")
        glyph = glyph_set[name]
        pen = SVGPathPen(glyph_set)
        glyph.draw(pen)
        d = pen.getCommands()
        if d:
            parts.append(f'<path transform="translate({pen_x:.1f} 0)" d="{d}"/>')
        pen_x += glyph.width + (tracking if i < len(text) - 1 else 0.0)

    return Wordmark(path="".join(parts), width=pen_x, upem=upem, cap_height=cap_height)


def wordmark_group(
    mark: Wordmark, *, cx: float, baseline: float, cap_px: float, fill: str
) -> str:
    """Place the outlined wordmark: centred on `cx`, sitting on `baseline`, `cap_px` tall.

    Sizing by CAP HEIGHT rather than em size is what keeps the wordmark optically
    matched to the mountain geometry — em size is a typographic abstraction the
    mountains know nothing about, and it varies between fonts for identical apparent size.
    """
    scale = cap_px / mark.cap_height
    x = cx - (mark.width * scale) / 2.0
    return (
        f'<g fill="{fill}" transform="translate({x:.2f} {baseline:.2f}) '
        f'scale({scale:.5f} {-scale:.5f})">{mark.path}</g>'
    )


# ── Geometry primitives ──────────────────────────────────────────────────────

Point = tuple[float, float]


def range_path(ridge: list[Point], base_y: float) -> str:
    """Close a ridgeline into a filled mountain range, dropping to `base_y` at each end.

    When the ridge already starts and ends on `base_y` the drop is a no-op and the range
    meets the ground on a slope. Round 2 ended its ridge mid-air, so the closing segments
    rendered as vertical walls and the mark read as a flat-bottomed blob.
    """
    head = f"M{ridge[0][0]:.1f} {base_y:.1f}"
    body = "".join(f"L{x:.1f} {y:.1f}" for x, y in ridge)
    tail = f"L{ridge[-1][0]:.1f} {base_y:.1f}Z"
    return f'<path d="{head}{body}{tail}"/>'


def peak(apex: Point, half_width: float, base_y: float) -> str:
    """A single sharp triangle — used for the range BEHIND.

    Back peaks are drawn as narrow individual triangles rather than as one wide closed
    ridge: a wide back ridge only ever shows as angular slabs poking out either side of
    the front range, which reads as ribbons rather than distance.
    """
    ax, ay = apex
    return (
        f'<path d="M{ax - half_width:.1f} {base_y:.1f}'
        f"L{ax:.1f} {ay:.1f}L{ax + half_width:.1f} {base_y:.1f}Z\"/>"
    )


def series_line(ridge: list[Point], stroke: str, width: float) -> str:
    pts = " ".join(f"{x:.1f},{y:.1f}" for x, y in ridge)
    return (
        f'<polyline points="{pts}" fill="none" stroke="{stroke}" '
        f'stroke-width="{width:.1f}" stroke-linecap="round" stroke-linejoin="round"/>'
    )


def series_nodes(
    ridge: list[Point],
    r: float,
    fill: str,
    spark_index: int,
    spark: str,
    *,
    skip_ends: bool = True,
) -> str:
    """Data-point markers. The summit gets the one warm colour and a slightly larger dot.

    Only the summit is enlarged: making every node bigger reads as decoration, whereas a
    single outsized node reads as a record — which is the whole point of the mark.

    `skip_ends` omits markers on the two ground anchors. Those points exist to land the
    series on the baseline, not to represent a measurement, and dotting them puts two
    heavy circles in the corners where they read as feet.
    """
    out = []
    last = len(ridge) - 1
    for i, (x, y) in enumerate(ridge):
        if skip_ends and i in (0, last):
            continue
        is_spark = i == spark_index
        out.append(
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{(r * 1.3 if is_spark else r):.1f}" '
            f'fill="{spark if is_spark else fill}"/>'
        )
    return "".join(out)


# ── The shared ridgeline ─────────────────────────────────────────────────────
#
# The plotted series IS the front range's skyline: rising left to right through a
# training block, spiking at a personal record, then settling. Both endpoints sit at the
# extremes of the range, so the line has a visible domain instead of dangling in space.

BASE_Y = 396.0

# Both ends sit ON the baseline, so the range meets the ground on a slope and the
# series has a visible domain. Interior points are the measurements; the summit is the
# personal record. Index 5 is the summit; indices 0 and 8 are the ground anchors.
RIDGE: list[Point] = [
    (40.0, 396.0),
    (96.0, 292.0),
    (146.0, 330.0),
    (206.0, 236.0),
    (250.0, 284.0),
    (308.0, 146.0),
    (366.0, 260.0),
    (416.0, 214.0),
    (472.0, 396.0),
]
SPARK_INDEX = 5

# The range behind: narrow, sharp, individually drawn triangles whose tips clear the
# front ridge. Offset off the front summits so the two ranges never merely echo.
BACK_PEAKS: list[tuple[Point, float]] = [
    ((150.0, 214.0), 74.0),
    ((262.0, 176.0), 86.0),
    ((388.0, 158.0), 80.0),
]

# Thumbnail-first reduction: two dominant peaks and one deep valley between them.
COARSE_RIDGE: list[Point] = [
    (44.0, 396.0),
    (168.0, 210.0),
    (256.0, 300.0),
    (330.0, 138.0),
    (468.0, 396.0),
]
COARSE_SPARK = 3
COARSE_BACK: list[tuple[Point, float]] = [((238.0, 190.0), 96.0)]


# ── The five design directions ───────────────────────────────────────────────
#
# Every one carries the same DNA — opaque violet ranges, a ridgeline that doubles as a
# plotted series, round data nodes, exactly one warm summit node. They differ in how
# much of that survives, which is the actual open question.

Variant = Callable[[dict[str, str]], str]


def back_range(t: dict[str, str], peaks: list[tuple[Point, float]]) -> str:
    return f'<g fill="{t["rear"]}">{"".join(peak(a, w, BASE_Y) for a, w in peaks)}</g>'


def mark_ridge(t: dict[str, str]) -> str:
    """A — the full statement. Two ranges, seven data points, the line IS the skyline."""
    return (
        back_range(t, BACK_PEAKS)
        + f'<g fill="{t["front"]}">{range_path(RIDGE, BASE_Y)}</g>'
        + series_line(RIDGE, t["ink"], 12.0)
        + series_nodes(RIDGE, 13.0, t["ink"], SPARK_INDEX, t["spark"])
    )


def mark_summit(t: dict[str, str]) -> str:
    """B — thumbnail-first. Two peaks, three data points, fatter stroke."""
    return (
        back_range(t, COARSE_BACK)
        + f'<g fill="{t["front"]}">{range_path(COARSE_RIDGE, BASE_Y)}</g>'
        + series_line(COARSE_RIDGE, t["ink"], 20.0)
        + series_nodes(COARSE_RIDGE, 21.0, t["ink"], COARSE_SPARK, t["spark"])
    )


def mark_line(t: dict[str, str]) -> str:
    """C — the chart alone. No filled mass; the peaks are implied entirely by the series.

    The ground anchors are dropped here: with no range beneath it, a series that dives
    into both bottom corners reads as a V, not as a skyline.
    """
    floating = RIDGE[1:-1]
    return series_line(floating, t["front"], 18.0) + series_nodes(
        floating, 18.0, t["front"], SPARK_INDEX - 1, t["spark"], skip_ends=False
    )


def mark_tile(t: dict[str, str]) -> str:
    """D — the mark knocked out of a solid accent tile. Never vanishes on any surface.

    No back range and no opacity tricks: on a tile the ground is already the accent, so
    a second violet behind the knockout has nothing to contrast against, and translucent
    white over violet renders as the muddy grey round 2 produced.
    """
    return (
        f'<rect x="0" y="0" width="512" height="512" rx="116" fill="{t["front"]}"/>'
        + f'<g fill="{t["bg"]}">{range_path(RIDGE, BASE_Y)}</g>'
        + series_line(RIDGE, t["front"], 13.0)
        + series_nodes(RIDGE, 14.0, t["front"], SPARK_INDEX, t["spark"])
    )


def mark_area(t: dict[str, str]) -> str:
    """E — area chart as mountain. One mass, one line on its edge. The purest fusion."""
    return (
        f'<g fill="{t["rear"]}">{range_path(RIDGE, BASE_Y)}</g>'
        + series_line(RIDGE, t["front"], 16.0)
        + series_nodes(RIDGE, 17.0, t["front"], SPARK_INDEX, t["spark"])
    )


VARIANTS: dict[str, Variant] = {
    "a-ridge": mark_ridge,
    "b-summit": mark_summit,
    "c-line": mark_line,
    "d-tile": mark_tile,
    "e-area": mark_area,
}

# Variants that paint their own ground and so must never receive a background rect.
SELF_GROUNDED = {"d-tile"}

# ── Forms ────────────────────────────────────────────────────────────────────
#
# The mark is authored once at icon scale, occupying roughly y 138..392. The lockup is
# that same group shrunk about a shared centre and lifted, with the wordmark beneath —
# so the two forms can never disagree about what the mark looks like.

LOCKUP_SCALE = 0.74
LOCKUP_SHIFT_Y = -54.0

# A full-bleed tile occupies the entire square by definition, so it needs a harder
# reduction and a higher centre than an open mark before type can sit beneath it.
LOCKUP_TILE_SCALE = 0.60
LOCKUP_TILE_SHIFT_Y = -96.0


def compose(name: str, t: dict[str, str], form: str, mark: Wordmark) -> str:
    body = VARIANTS[name](t)
    if form == "icon":
        return body
    tiled = name in SELF_GROUNDED
    scale = LOCKUP_TILE_SCALE if tiled else LOCKUP_SCALE
    shift = LOCKUP_TILE_SHIFT_Y if tiled else LOCKUP_SHIFT_Y
    inner = (
        f'<g transform="translate(256 265) scale({scale}) '
        f'translate(-256 {shift - 265:.1f})">{body}</g>'
    )
    return inner + wordmark_group(mark, cx=256, baseline=470, cap_px=88, fill=t["ink"])


FORMS = ("icon", "lockup")

# ── Emitters ─────────────────────────────────────────────────────────────────

HEADER = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" '
    'width="512" height="512" role="img" aria-label="Fit">'
)


def literal_svg(name: str, form: str, theme: str, *, solid: bool) -> str:
    """A flat SVG with concrete hex values — what rasterisers and Strava want."""
    t = THEMES[theme]
    bg = (
        f'<rect width="512" height="512" fill="{t["bg"]}"/>'
        if solid and name not in SELF_GROUNDED
        else ""
    )
    return f"{HEADER}{bg}{compose(name, t, form, MARK)}</svg>"


def themed_svg(name: str, form: str) -> str:
    """A self-flipping SVG driven by CSS custom properties.

    Three theme states, exactly as tokens.css documents them: bare `:root` carries the
    COMPLETE light palette, `prefers-color-scheme` handles the default "system" state,
    and `[data-theme]` on the <svg> element wins over both. A colour whose only
    definition lives inside a media query has no value at all in that third state —
    hence the full light set first and dark blocks that only REDEFINE.

    CSS variables are a browser feature; rasterisers do not resolve them, which is
    precisely why the literal pair above exists alongside this.
    """
    light, dark = THEMES["light"], THEMES["dark"]

    def tokens(t: dict[str, str]) -> str:
        return "".join(f"--icon-{k}:{v};" for k, v in t.items())

    refs = {k: f"var(--icon-{k})" for k in light}
    bg = (
        '<rect width="512" height="512" fill="var(--icon-bg)"/>'
        if name not in SELF_GROUNDED
        else ""
    )
    style = (
        f":root{{{tokens(light)}}}"
        f"@media(prefers-color-scheme:dark){{:root:not([data-theme='light'])"
        f"{{{tokens(dark)}}}}}"
        f":root[data-theme='dark']{{{tokens(dark)}}}"
    )
    return f"{HEADER}<style>{style}</style>{bg}{compose(name, refs, form, MARK)}</svg>"


def rasterise(svg: Path, out: Path, size: int) -> None:
    """Rasterise with resvg.

    No font arguments are passed, deliberately: the wordmark is already outlined to path
    data at build time, so rendering has no text to resolve and cannot silently
    substitute Times New Roman when Fraunces is absent from the system font database.
    """
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
        for form in FORMS:
            (SVG_DIR / f"{name}-{form}-themed.svg").write_text(
                themed_svg(name, form), encoding="utf-8"
            )
            svgs += 1
            for theme in THEMES:
                for solid in (True, False):
                    suffix = "" if solid else "-alpha"
                    path = SVG_DIR / f"{name}-{form}-{theme}{suffix}.svg"
                    path.write_text(
                        literal_svg(name, form, theme, solid=solid), encoding="utf-8"
                    )
                    svgs += 1
                    for size in SIZES:
                        rasterise(path, PNG_DIR / f"{path.stem}@{size}.png", size)
                        pngs += 1

    print(f"wrote {svgs} svg, {pngs} png", file=sys.stderr)
    print(f"  svg: {SVG_DIR.relative_to(ROOT)}")
    print(f"  png: {PNG_DIR.relative_to(ROOT)}")


MARK = outline_wordmark(WORDMARK, tracking=0.0)

if __name__ == "__main__":
    main()
