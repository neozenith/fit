import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Identity } from "./api.js";
import { Banner } from "./components.jsx";
import { BlockPage } from "./pages/Block.jsx";
import { FinOpsPage } from "./pages/FinOps.jsx";
import { LogPage } from "./pages/Log.jsx";
import { MeasurementsPage } from "./pages/Measurements.jsx";
import { ProgressPage } from "./pages/Progress.jsx";
import { TodayPage } from "./pages/Today.jsx";
import "./styles/app.css";

/**
 * Routing is hash-based, deliberately.
 *
 * The alternative is History API routing, which needs the server to serve
 * `index.html` for every unknown path. CloudFront can be made to do that, but
 * the rewrite has to be scoped carefully or it starts laundering real 403s into
 * a rendered application — and a hash route needs none of that machinery to
 * behave identically in the local dev server, in S3, and behind CloudFront.
 */

const PAGES = [
  { id: "today", label: "Today", render: () => <TodayPage /> },
  { id: "block", label: "Block", render: () => <BlockPage /> },
  { id: "log", label: "Log", render: () => <LogPage /> },
  { id: "measurements", label: "Body", render: () => <MeasurementsPage /> },
  { id: "progress", label: "Progress", render: () => <ProgressPage /> },
  { id: "finops", label: "Cost", render: () => <FinOpsPage /> },
] as const;

type PageId = (typeof PAGES)[number]["id"];

const readHash = (): PageId => {
  const id = window.location.hash.replace(/^#\/?/, "") as PageId;
  return PAGES.some((p) => p.id === id) ? id : "today";
};

/** Environments other than prod announce themselves, so nobody logs into the wrong one. */
const ENV_LABEL: Record<string, string> = { dev: "DEV", test: "TEST", local: "LOCAL" };

export const App = () => {
  const [page, setPage] = useState<PageId>(readHash);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onHashChange = () => setPage(readHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    api
      .me()
      .then(setIdentity)
      .catch((e: unknown) => {
        // A 401 has already triggered a full-page redirect to sign in, so there
        // is nothing useful to render for it. Anything else is a real failure.
        if (e instanceof ApiError && e.status === 401) return;
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  const navigate = useCallback((id: PageId) => {
    window.location.hash = `#/${id}`;
  }, []);

  const active = PAGES.find((p) => p.id === page) ?? PAGES[0];
  const envBadge = identity ? ENV_LABEL[identity.environment] : undefined;

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">fit</span>
        {envBadge && (
          <span className="pill pill--accent" title="You are not in production">
            {envBadge}
          </span>
        )}
        <nav className="nav" aria-label="Sections">
          {PAGES.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => navigate(p.id)}
              aria-current={p.id === page ? "page" : undefined}
            >
              {p.label}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        {identity && (
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            {identity.email}
            {/* An agent-minted session is visibly different from a human one,
                so a screenshot from a test run is never mistaken for a real
                sign-in (ADR-0011). */}
            {identity.actor === "agent" && <span className="pill"> agent</span>}
          </span>
        )}
        <a className="pill" href="/oauth2/logout">
          Sign out
        </a>
      </header>

      <main>
        {error && <Banner variant="error">{error}</Banner>}
        {active.render()}
      </main>

      <footer>
        Candito 6-Week Strength Program. Every prescribed weight on this page is computed from your
        current one-rep maxes, not stored.
      </footer>
    </div>
  );
};
