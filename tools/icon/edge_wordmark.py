"""Emit the `fit` wordmark as SVG path data for the edge sign-in page.

A GENERATOR, run by hand; its output is pasted into
`infra/modules/edge/src/auth/routing.mjs`. The chooser cannot load a font — it
renders before the SPA exists and any `/fonts/*` request would arrive at the
edge with no session — so the letters have to arrive as outlines, not as text
in a family the browser must fetch.

Run: uv run --with fonttools tools/icon/edge_wordmark.py
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from wordmark import outline_wordmark

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

# Resolved from this file, not from the cwd: the script is run via
# `uv run --directory tools/icon` so that `wordmark` imports, which means the
# cwd is not the repo root.
FONT = Path(__file__).resolve().parents[2] / "frontend/public/fonts/Fraunces.ttf"
# Settled in build_icons.py: wght 400, SOFT 50, WONK at maximum. opsz 144 is the
# display cut, where the wonk this face is chosen for actually shows.
LOCATION = {"wght": 400.0, "opsz": 144.0, "SOFT": 50.0, "WONK": 1.0}
CAP_PX = 44.0  # cap height in CSS pixels


def round_coords(path: str) -> str:
    """Round path coordinates to whole font units.

    fontTools emits full float repr — `345.50689697265625` for a coordinate in a
    1000-unit em that is finally scaled by 0.031. Every one of those digits is
    three orders of magnitude below a device pixel, and together they were two
    thirds of the payload on a page with a 40KB response cap.
    """
    return re.sub(r"-?\d+\.\d+", lambda m: f"{round(float(m.group())):d}", path)


def main() -> None:
    mark = outline_wordmark(FONT, "fit", location=LOCATION)
    scale = CAP_PX / mark.cap_height
    width = mark.width * scale
    # Descenders are nil for "fit", but the ascenders on f and t overshoot the
    # cap height, so the box is taken from the em rather than from CAP_PX.
    height = mark.upem * scale * 0.78
    baseline = height * 0.86

    svg = (
        f'<svg viewBox="0 0 {width:.1f} {height:.1f}" width="{width:.1f}" height="{height:.1f}" '
        f'role="img" aria-label="fit">'
        f'<g fill="#e9b26a" transform="translate(0 {baseline:.2f}) scale({scale:.5f} {-scale:.5f})">'
        f"{round_coords(mark.path)}</g></svg>"
    )
    log.info("%s", svg)
    log.info("\n-- %d bytes, %.1f x %.1f px", len(svg.encode()), width, height)


if __name__ == "__main__":
    main()
