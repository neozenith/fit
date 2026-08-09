"""Fraunces wordmark outlining — parked until the mountain mark is settled.

Kept out of `build_icons.py` on purpose: the wordmark is a separate design problem, and
mixing it in made every icon iteration carry typography noise it did not need. Import
`outline_wordmark` + `wordmark_group` from here when the lockup work resumes.

Requires `fonttools`; the caller's PEP-723 header must declare it.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

# Fraunces axis ranges, read from the font's own fvar table:
#   opsz 9..144 (default 9)   wght 100..900 (default 900)
#   SOFT 0..100 (default 0)   WONK 0..1     (default 1)
#
# WONK defaults to 1 — the wonky, splayed-terminal cut IS stock Fraunces, and setting it
# to 0 quietly removes the font's whole personality. opsz 144 selects the display cut,
# which is where the wonk is most expressive.
FONT_LOCATION = {"wght": 700.0, "opsz": 144.0, "SOFT": 0.0, "WONK": 1.0}


@dataclass(frozen=True)
class Wordmark:
    """An outlined string: SVG path data plus the metrics needed to place it."""

    path: str
    width: float
    upem: float
    cap_height: float


def outline_wordmark(
    font_path: Path,
    text: str,
    tracking: float = 0.0,
    location: dict[str, float] | None = None,
) -> Wordmark:
    """Outline `text` into SVG path data, in font units, y-up.

    `tracking` is extra letterspacing in font units, applied between glyphs only.
    `location` overrides the pinned variable-axis position (e.g. a different `wght`).
    """
    if not font_path.exists():
        raise SystemExit(
            f"Font not found at {font_path}.\n"
            "Fetch Fraunces with:\n"
            "  curl -sSL -o art/strava-icon/fonts/Fraunces.ttf \\\n"
            "    'https://github.com/google/fonts/raw/main/ofl/fraunces/"
            "Fraunces%5BSOFT%2CWONK%2Copsz%2Cwght%5D.ttf'"
        )

    font = TTFont(font_path)
    upem = float(font["head"].unitsPerEm)
    cap_height = float(getattr(font["OS/2"], "sCapHeight", 0.7 * upem))
    cmap = font.getBestCmap()
    glyph_set = font.getGlyphSet(location=location or FONT_LOCATION)

    parts: list[str] = []
    pen_x = 0.0
    for i, char in enumerate(text):
        name = cmap.get(ord(char))
        if name is None:
            raise SystemExit(f"Font has no glyph for {char!r}")
        glyph = glyph_set[name]
        pen = SVGPathPen(glyph_set)
        glyph.draw(pen)
        d = pen.getCommands()
        if d:
            parts.append(f'<path transform="translate({pen_x:.1f} 0)" d="{d}"/>')
        pen_x += glyph.width + (tracking if i < len(text) - 1 else 0.0)

    return Wordmark(path="".join(parts), width=pen_x, upem=upem, cap_height=cap_height)


def tittle_centre(
    font_path: Path,
    text: str,
    char_index: int,
    tracking: float = 0.0,
    location: dict[str, float] | None = None,
) -> tuple[float, float, float]:
    """Locate the dot on a dotted letter, in the same font units `outline_wordmark` uses.

    Returns `(x, y, radius)` for the tittle of `text[char_index]`, with `x` already
    offset by the advances of the glyphs before it — so it lands in the same coordinate
    space as the wordmark path and can be transformed by the identical matrix.

    Found structurally rather than by guessing at metrics: the glyph is recorded, split
    into contours at each `moveTo`, and the contour with the highest `yMax` is the dot.
    A dotted lowercase letter has exactly one contour floating above the rest, so this
    holds across weights and optical sizes — where a hardcoded fraction of the ascender
    would drift the moment an axis moves.
    """
    font = TTFont(font_path)
    cmap = font.getBestCmap()
    glyph_set = font.getGlyphSet(location=location or FONT_LOCATION)

    pen_x = 0.0
    for char in text[:char_index]:
        name = cmap.get(ord(char))
        if name is None:
            raise SystemExit(f"Font has no glyph for {char!r}")
        pen_x += glyph_set[name].width + tracking

    name = cmap.get(ord(text[char_index]))
    if name is None:
        raise SystemExit(f"Font has no glyph for {text[char_index]!r}")
    pen = RecordingPen()
    glyph_set[name].draw(pen)

    contours: list[list[tuple[float, float]]] = []
    for op, args in pen.value:
        if op == "moveTo":
            contours.append([])
        if contours and args:
            contours[-1].extend(p for p in args if isinstance(p, tuple))
    contours = [c for c in contours if c]
    if not contours:
        raise SystemExit(f"Glyph {name!r} has no contours to search for a tittle")

    dot = max(contours, key=lambda c: max(y for _, y in c))
    xs = [x for x, _ in dot]
    ys = [y for _, y in dot]
    return (
        pen_x + (min(xs) + max(xs)) / 2.0,
        (min(ys) + max(ys)) / 2.0,
        max(max(xs) - min(xs), max(ys) - min(ys)) / 2.0,
    )


def glyph_bounds(
    font_path: Path,
    text: str,
    char_index: int,
    tracking: float = 0.0,
    location: dict[str, float] | None = None,
) -> tuple[float, float, float, float]:
    """Inked bounds `(x0, y0, x1, y1)` of one glyph, in the wordmark's font-unit space.

    INKED bounds, not the advance box: the result is where the letter visually sits
    rather than where its metrics say it sits. For a glyph with asymmetric sidebearings —
    most of them — those differ by enough to throw an alignment off at icon scale.
    """
    font = TTFont(font_path)
    cmap = font.getBestCmap()
    glyph_set = font.getGlyphSet(location=location or FONT_LOCATION)

    pen_x = 0.0
    for char in text[:char_index]:
        name = cmap.get(ord(char))
        if name is None:
            raise SystemExit(f"Font has no glyph for {char!r}")
        pen_x += glyph_set[name].width + tracking

    name = cmap.get(ord(text[char_index]))
    if name is None:
        raise SystemExit(f"Font has no glyph for {text[char_index]!r}")
    pen = RecordingPen()
    glyph_set[name].draw(pen)
    pts = [p for _, args in pen.value for p in args if isinstance(p, tuple)]
    if not pts:
        raise SystemExit(f"Glyph {name!r} has no outline to measure")
    xs = [x for x, _ in pts]
    ys = [y for _, y in pts]
    return (pen_x + min(xs), min(ys), pen_x + max(xs), max(ys))


def glyph_centre(
    font_path: Path,
    text: str,
    char_index: int,
    tracking: float = 0.0,
    location: dict[str, float] | None = None,
) -> tuple[float, float]:
    """Inked centre of one glyph, in the wordmark's own font-unit coordinates."""
    x0, y0, x1, y1 = glyph_bounds(font_path, text, char_index, tracking, location)
    return ((x0 + x1) / 2.0, (y0 + y1) / 2.0)


def x_height(font_path: Path) -> float:
    """The font's x-height in font units — where a lowercase crossbar sits.

    Read from OS/2 rather than measured off a glyph, because `f` and `t` both carry
    ascenders and their bounding boxes say nothing about where their bars cross.
    """
    font = TTFont(font_path)
    return float(getattr(font["OS/2"], "sxHeight", 0.5 * font["head"].unitsPerEm))


def place(
    mark: Wordmark, point: tuple[float, float], *, cx: float, baseline: float, cap_px: float
) -> tuple[float, float]:
    """Map a font-unit point through the same transform `wordmark_group` applies."""
    scale = cap_px / mark.cap_height
    x0 = cx - (mark.width * scale) / 2.0
    return (x0 + point[0] * scale, baseline - point[1] * scale)


def wordmark_group(
    mark: Wordmark, *, cx: float, baseline: float, cap_px: float, fill: str
) -> str:
    """Place the outlined wordmark: centred on `cx`, sitting on `baseline`, `cap_px` tall.

    Sizing by CAP HEIGHT rather than em size keeps the wordmark optically matched to
    neighbouring geometry — em size is a typographic abstraction that varies between
    fonts for identical apparent size.
    """
    scale = cap_px / mark.cap_height
    x = cx - (mark.width * scale) / 2.0
    return (
        f'<g fill="{fill}" transform="translate({x:.2f} {baseline:.2f}) '
        f'scale({scale:.5f} {-scale:.5f})">{mark.path}</g>'
    )
