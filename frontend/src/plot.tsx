import { useEffect, useRef, useState } from "react";

/**
 * Plotly, themed and lazily loaded.
 *
 * The hand-drawn SVG charts this replaces were the right call while there were
 * three of them and no interaction. They stopped being right the moment charts
 * needed hover readouts, zoom, legend toggling and a shared date axis across
 * six subpages — reimplementing those is how a "small dependency-free chart"
 * becomes a chart library with no documentation.
 *
 * `plotly.js-basic-dist-min` rather than the full build: scatter and bar are
 * every trace this app draws, and the basic bundle is roughly a third of the
 * size. It is still the largest thing in the bundle, which is why it is
 * imported dynamically — Today, Block and Log never pay for it.
 *
 * That dynamic import is CODE-SPLITTING, not a hidden optional dependency: the
 * package is a hard dependency in package.json, and a failure to load it
 * surfaces as an error in the panel rather than as a silently missing chart.
 */

/** The subset of Plotly's surface this app uses. The package ships no types. */
interface PlotlyModule {
  newPlot: (
    el: HTMLElement,
    data: unknown[],
    layout: Record<string, unknown>,
    config: Record<string, unknown>,
  ) => Promise<unknown>;
  purge: (el: HTMLElement) => void;
  Plots: { resize: (el: HTMLElement) => void };
}

let plotlyPromise: Promise<PlotlyModule> | null = null;

const plotly = (): Promise<PlotlyModule> => {
  plotlyPromise ??= import("plotly.js-basic-dist-min").then(
    (m) => (m.default ?? m) as unknown as PlotlyModule,
  );
  return plotlyPromise;
};

/**
 * Read a CSS custom property off the document.
 *
 * Plotly takes literal colours, not `var(--x)`, so the theme has to be resolved
 * in JavaScript. Reading it from the live computed style rather than hardcoding
 * hex values is what makes a chart follow the theme toggle — including the
 * "system" setting, which stamps nothing on the root and is only visible
 * through the resolved value.
 */
const token = (name: string, fallback: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

export const SERIES_TOKENS = [
  "--series-1",
  "--series-2",
  "--series-3",
  "--series-4",
  "--series-5",
  "--series-6",
  "--series-7",
  "--series-8",
] as const;

/**
 * Resolve one theme colour to a literal.
 *
 * Plotly takes literal colours; handing it `var(--muted)` renders a black trace
 * with no error, which is the worst kind of failure — it looks like a styling
 * choice.
 */
export const themeColour = (name: string, fallback: string): string => token(name, fallback);

/** Resolve the categorical palette in theme order, cycling for long series. */
export const seriesColour = (index: number): string =>
  token(SERIES_TOKENS[index % SERIES_TOKENS.length] as string, "#6977f0");

export interface PlotProps {
  data: unknown[];
  /** Merged over the themed defaults; anything here wins. */
  layout?: Record<string, unknown>;
  height?: number;
  /** Accessible description. Plotly renders no alternative text of its own. */
  title: string;
}

export const Plot = ({ data, layout = {}, height = 340, title }: PlotProps) => {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  // A counter bumped on theme change. Plotly bakes resolved colours into the
  // rendered SVG, so a themed chart has to be redrawn rather than restyled by
  // CSS — without this the axes stay dark on a page that just went light.
  const [themeEpoch, setThemeEpoch] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeEpoch((n) => n + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => setThemeEpoch((n) => n + 1);
    media.addEventListener("change", onScheme);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", onScheme);
    };
  }, []);

  // `themeEpoch` is deliberately a dependency the body never reads: it exists
  // to force a REDRAW when the palette moves, because Plotly bakes resolved
  // colours into the SVG and no amount of CSS can restyle them afterwards.
  // biome-ignore lint/correctness/useExhaustiveDependencies: redraw trigger
  useEffect(() => {
    const el = container.current;
    if (!el) return;

    let cancelled = false;
    let drawn: HTMLElement | null = null;

    plotly()
      .then((Plotly) => {
        if (cancelled || !container.current) return;
        drawn = container.current;
        const fg = token("--fg", "#1c1a20");
        const muted = token("--muted", "#57525e");
        const grid = token("--chart-grid", "#e9e4e8");

        return Plotly.newPlot(
          drawn,
          data,
          {
            height,
            // The plot area is transparent so the card's own surface shows
            // through. A hardcoded white paper background is the single most
            // obvious way a chart betrays that it does not know about dark mode.
            paper_bgcolor: "rgba(0,0,0,0)",
            plot_bgcolor: "rgba(0,0,0,0)",
            font: { color: muted, family: token("--font-body", "sans-serif"), size: 12 },
            margin: { l: 56, r: 16, t: 8, b: 44 },
            xaxis: { gridcolor: grid, zerolinecolor: grid, linecolor: grid, tickcolor: grid },
            yaxis: { gridcolor: grid, zerolinecolor: grid, linecolor: grid, tickcolor: grid },
            legend: { orientation: "h", y: -0.22, font: { color: fg } },
            hovermode: "closest",
            ...layout,
          },
          {
            displaylogo: false,
            responsive: true,
            // The image-export and lasso tools are noise here; zoom, pan and
            // reset are the ones that make a five-year axis usable.
            modeBarButtonsToRemove: ["lasso2d", "select2d", "toImage"],
          },
        );
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
      if (drawn) plotly().then((Plotly) => Plotly.purge(drawn as HTMLElement));
    };
  }, [data, layout, height, themeEpoch]);

  if (error) {
    return <p className="banner banner--error">The chart library failed to load: {error}</p>;
  }

  return <div ref={container} className="plot" role="img" aria-label={title} />;
};

export interface Series {
  name: string;
  colour: string;
  points: Array<{ date: string; value: number }>;
}

/**
 * A multi-series line chart over a date axis.
 *
 * Exists so the two remaining callers keep the `series` shape they already had
 * while the drawing moves to Plotly. It replaced a hand-rolled SVG chart, and
 * the reason that was ever right stopped applying the moment there were nine
 * charts across seven pages: one implementation with hover, zoom and legend
 * toggling beats two implementations where only one of them has any of that.
 *
 * `colour` arrives as a `var(--series-n)` string from the callers, which Plotly
 * cannot resolve — so it is passed through `seriesColour` by index instead, and
 * the caller's value is used only when it is already a literal.
 */
export const LineSeriesPlot = ({
  series,
  height = 300,
  yLabel = "",
}: {
  series: Series[];
  height?: number;
  yLabel?: string;
}) => (
  <Plot
    title={`${series.map((s) => s.name).join(", ")} over time`}
    height={height}
    data={series.map((s, i) => ({
      type: "scatter",
      mode: "lines+markers",
      name: s.name,
      x: s.points.map((p) => p.date),
      y: s.points.map((p) => p.value),
      line: { color: s.colour.startsWith("#") ? s.colour : seriesColour(i), width: 2 },
      marker: { size: 5 },
      hovertemplate: `%{x}<br>${s.name}: %{y}<extra></extra>`,
    }))}
    layout={yLabel ? { yaxis: { title: { text: yLabel } } } : {}}
  />
);
