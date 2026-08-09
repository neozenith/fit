import { useEffect, useState } from "react";
import { api } from "../../api.js";
import { Banner, Loading } from "../../components.jsx";

/**
 * The scaffolding every history subpage shares.
 *
 * Each subpage is its own address (`/history/volume`, `/history/cardio`, …) so
 * a single chart can be linked to and talked about on its own. What they share
 * is the dataset's EXTENT: every window preset is counted back from the last
 * recorded day rather than from today, so each page needs the summary before it
 * can resolve its own filter into dates.
 */

export interface Extent {
  from: string;
  to: string;
}

/**
 * The dataset's date range, or `null` while unknown / when nothing is imported.
 *
 * Fetched per subpage rather than lifted into a context. It is one small
 * request, the browser coalesces repeats, and a context would make every page
 * depend on being mounted inside a provider for a value it can ask for itself.
 */
export const useExtent = (): {
  extent: Extent | null;
  unavailable: string | null;
  loading: boolean;
} => {
  const [extent, setExtent] = useState<Extent | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .historySummary()
      .then((summary) => {
        if (summary.available) setExtent({ from: summary.from, to: summary.to });
        else setUnavailable(summary.reason);
      })
      .catch((e: unknown) => setUnavailable(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  return { extent, unavailable, loading };
};

/**
 * Fetch a subpage's data whenever ITS REQUEST CHANGES.
 *
 * The key is the serialised FULL parameter set, not just the date window. An
 * earlier version keyed on the window alone, which meant changing the grain or
 * the exercise updated the URL and re-rendered the page while quietly showing
 * the previous query's results — the worst possible failure for a surface whose
 * entire promise is that the URL describes what you see.
 *
 * `pending` is returned rather than inferred from `data === null`, because a
 * refetch that keeps the previous data on screen is indistinguishable from one
 * that has finished. Without it a filter change looks like it did nothing.
 */
export const useHistoryData = <T,>(
  params: Record<string, string>,
  fetcher: (params: Record<string, string>) => Promise<T>,
  /** Hold the request until the caller has what it needs to build `params`. */
  ready = true,
): { data: T | null; error: string | null; pending: boolean } => {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const key = new URLSearchParams(params).toString();

  // `fetcher` is an inline arrow at every call site, so it is a new reference on
  // every render — depending on it would refetch continuously. `key` is the
  // serialised parameters and the only thing that changes what is requested.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on parameters
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setPending(true);
    fetcher(Object.fromEntries(new URLSearchParams(key)))
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key, ready]);

  return { data, error, pending };
};

/**
 * The empty and error states, rendered identically on every subpage.
 *
 * Returns `null` when there is something to draw, so a caller reads as
 * `const gate = PageGate(…); if (gate) return gate;` — one line rather than
 * three branches repeated six times.
 */
export const PageGate = ({
  title,
  loading,
  unavailable,
  error,
  what,
}: {
  title: string;
  loading: boolean;
  unavailable: string | null;
  error: string | null;
  what: string;
}): React.ReactElement | null => {
  if (error) {
    return (
      <>
        <h1>{title}</h1>
        <Banner variant="error">{error}</Banner>
      </>
    );
  }
  if (loading) return <Loading what={what} />;
  if (unavailable) {
    return (
      <>
        <h1>{title}</h1>
        <Banner>{unavailable}</Banner>
        <p className="muted">
          Curate the workbook with <code className="mono">make history</code>, then publish it with{" "}
          <code className="mono">make publish-history ENV=&lt;env&gt;</code>.
        </p>
      </>
    );
  }
  return null;
};

/**
 * An in-flight marker that does not move the page.
 *
 * Rendered beside a heading rather than replacing the chart: swapping a drawn
 * chart for a spinner on every filter change makes the layout jump and loses
 * the thing being compared against. `aria-live` announces it without stealing
 * focus.
 */
export const Pending = ({ pending }: { pending: boolean }) =>
  pending ? (
    <span className="pending" aria-live="polite">
      querying…
    </span>
  ) : null;
