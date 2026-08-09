import { useCallback, useEffect, useSyncExternalStore } from "react";

/**
 * Path-based routing over the History API.
 *
 * Hash routing was the original choice because it needs no server cooperation.
 * That reasoning expired: the edge authenticator already rewrites any
 * extensionless non-`/api/` path to `/index.html` (ADR-0024), so a real path
 * costs nothing and buys the thing a hash cannot — `/history/volume?from=…` is
 * a URL that can be pasted into a message, bookmarked, and opened straight into
 * the state it describes.
 *
 * That addressability is the whole point, and it is why filter state lives in
 * the query string rather than in component state. A chart whose configuration
 * exists only in memory can be described but not *shown*; one whose
 * configuration is in the URL can be sent.
 */

/**
 * Subscribing to location changes.
 *
 * `popstate` fires for back/forward but NOT for `pushState`, so a navigation
 * this app makes itself would never re-render. The custom event closes that
 * gap — every mutation below dispatches it after touching history.
 */
const LOCATION_EVENT = "fit:navigate";

const subscribe = (onChange: () => void): (() => void) => {
  window.addEventListener("popstate", onChange);
  window.addEventListener(LOCATION_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(LOCATION_EVENT, onChange);
  };
};

const snapshot = (): string => window.location.pathname + window.location.search;

/** The current `pathname + search`, re-rendering on any change to either. */
export const useLocation = (): string => useSyncExternalStore(subscribe, snapshot, snapshot);

/** Just the path, with any trailing slash removed so `/history/` matches `/history`. */
export const usePath = (): string => {
  const location = useLocation();
  const path = location.split("?")[0] ?? "/";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
};

const announce = (): void => {
  window.dispatchEvent(new Event(LOCATION_EVENT));
};

/**
 * Navigate, adding a history entry.
 *
 * `replace` exists for filter changes: adjusting a date range six times should
 * leave one entry to go back past, not six. The URL still updates, so the state
 * stays addressable either way — only the back button behaves differently.
 */
export const navigate = (to: string, options: { replace?: boolean } = {}): void => {
  if (to === snapshot()) return;
  if (options.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  announce();
};

/**
 * Read and write one query parameter as if it were component state.
 *
 * Reading falls back to `fallback` when absent, and WRITING the fallback value
 * removes the parameter rather than spelling it out. Without that, every page
 * would accumulate `?grain=month&range=all&env=` — noise that makes two
 * identical views look like different URLs and buries the parameter the user
 * actually changed.
 */
export const useQueryParam = (key: string, fallback: string): [string, (value: string) => void] => {
  const location = useLocation();
  const value = new URLSearchParams(location.split("?")[1] ?? "").get(key) ?? fallback;

  const set = useCallback(
    (next: string) => {
      const params = new URLSearchParams(window.location.search);
      if (next === fallback || next === "") params.delete(key);
      else params.set(key, next);
      const query = params.toString();
      navigate(`${window.location.pathname}${query ? `?${query}` : ""}`, { replace: true });
    },
    [key, fallback],
  );

  return [value, set];
};

/**
 * Intercept in-app link clicks so an `<a href>` routes without a page load.
 *
 * Real anchors rather than buttons, deliberately: middle-click, ⌘-click and
 * "copy link address" all work, and a screen reader announces a link as a link.
 * Modified clicks are left to the browser, which is what makes those gestures
 * open a new tab instead of navigating in place.
 */
export const useLinkInterception = (): void => {
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as Element | null)?.closest?.("a");
      if (!anchor) return;

      const href = anchor.getAttribute("href");
      if (!href?.startsWith("/") || anchor.hasAttribute("target")) return;
      // `/oauth2/start` and `/api/*` are the ORIGIN's, not the app's. Hijacking
      // them would turn a sign-in into a client-side route to nothing.
      if (href.startsWith("/api/") || href.startsWith("/oauth2/")) return;

      event.preventDefault();
      navigate(href);
    };

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
};

/** Build a URL that preserves the current query string — used by nav links. */
export const withQuery = (path: string, params: Record<string, string>): string => {
  const search = new URLSearchParams(params).toString();
  return search ? `${path}?${search}` : path;
};
