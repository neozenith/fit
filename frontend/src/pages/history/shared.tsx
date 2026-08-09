import { useEffect, useState } from "react";
import { api } from "../../api.js";
import { Banner, Loading } from "../../components.jsx";
import { useHistoryWindow } from "../../filters.jsx";

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
 * Load one subpage's data once the window is resolvable.
 *
 * The fetch is keyed on the SERIALISED parameters rather than on the object,
 * because `resolveHistoryWindow` returns a fresh object every render — keying on
 * it directly is an infinite request loop that looks like a slow page.
 */
export const useHistoryData = <T,>(
  extent: Extent | null,
  fetcher: (params: Record<string, string>) => Promise<T>,
): { data: T | null; error: string | null; params: Record<string, string> } => {
  const [, params] = useHistoryWindow(extent);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = new URLSearchParams(params).toString();

  // `fetcher` is an inline arrow at every call site, so it is a new reference
  // on every render — depending on it would refetch continuously and defeat
  // `key`, which is the serialised parameters and the only thing that changes
  // what is actually requested.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on parameters
  useEffect(() => {
    let cancelled = false;
    fetcher(Object.fromEntries(new URLSearchParams(key)))
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return { data, error, params };
};

/**
 * The empty and error states, rendered identically on every subpage.
 *
 * Returns `null` when there is something to draw, so a caller reads as
 * `const gate = <PageGate …/>; if (gate) return gate;` — one line rather than
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
