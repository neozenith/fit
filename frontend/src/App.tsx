import { useEffect, useState } from "react";
import { ApiError, api, type Identity } from "./api.js";
import { Banner } from "./components.jsx";
import { BlockPage } from "./pages/Block.jsx";
import { ExercisesPage } from "./pages/Exercises.jsx";
import { FinOpsPage } from "./pages/FinOps.jsx";
import { HistoryBodyweightPage } from "./pages/history/Bodyweight.jsx";
import { HistoryCardioPage } from "./pages/history/Cardio.jsx";
import { HistoryOverviewPage } from "./pages/history/Overview.jsx";
import { HistoryRepMaxesPage } from "./pages/history/RepMaxes.jsx";
import { HistoryStreaksPage } from "./pages/history/Streaks.jsx";
import { HistoryVolumePage } from "./pages/history/Volume.jsx";
import { LogPage } from "./pages/Log.jsx";
import { MeasurementsPage } from "./pages/Measurements.jsx";
import { ProgressPage } from "./pages/Progress.jsx";
import { TodayPage } from "./pages/Today.jsx";
import { useLinkInterception, usePath } from "./router.jsx";
import "./styles/app.css";
import { THEME_LABEL, THEME_ORDER, useTheme } from "./theme.js";

/**
 * Real paths, not hash fragments.
 *
 * Every view is addressable — `/history/volume?grain=week&exercise=Barbell%20Back%20Squat`
 * opens exactly that chart. Filter state lives in the query string for the same
 * reason: a configuration that exists only in component memory can be described
 * but never *sent*, and this app's whole history surface is something to point
 * at and discuss.
 *
 * The edge authenticator already rewrites extensionless non-`/api/` paths to
 * `/index.html` (ADR-0024), so there is no server-side routing to add.
 */

interface Route {
  path: string;
  label: string;
  section: string;
  render: () => React.ReactNode;
  /** Hidden from the nav — reachable, but not a top-level destination. */
  nested?: boolean;
}

const ROUTES: Route[] = [
  { path: "/today", label: "Today", section: "Train", render: () => <TodayPage /> },
  { path: "/block", label: "Block", section: "Train", render: () => <BlockPage /> },
  { path: "/log", label: "Log", section: "Train", render: () => <LogPage /> },

  { path: "/measurements", label: "Body", section: "Track", render: () => <MeasurementsPage /> },
  { path: "/progress", label: "Progress", section: "Track", render: () => <ProgressPage /> },
  { path: "/exercises", label: "Exercises", section: "Track", render: () => <ExercisesPage /> },

  {
    path: "/history",
    label: "Overview",
    section: "History",
    render: () => <HistoryOverviewPage />,
  },
  {
    path: "/history/volume",
    label: "Volume",
    section: "History",
    render: () => <HistoryVolumePage />,
  },
  {
    path: "/history/bodyweight",
    label: "Body weight",
    section: "History",
    render: () => <HistoryBodyweightPage />,
  },
  {
    path: "/history/rep-maxes",
    label: "Rep maxes",
    section: "History",
    render: () => <HistoryRepMaxesPage />,
  },
  {
    path: "/history/cardio",
    label: "Cardio",
    section: "History",
    render: () => <HistoryCardioPage />,
  },
  {
    path: "/history/streaks",
    label: "Streaks",
    section: "History",
    render: () => <HistoryStreaksPage />,
  },

  { path: "/finops", label: "Cost", section: "Platform", render: () => <FinOpsPage /> },
];

const SECTIONS = ["Train", "Track", "History", "Platform"];

/** Environments other than prod announce themselves, so nobody logs into the wrong one. */
const ENV_LABEL: Record<string, string> = { dev: "DEV", test: "TEST", local: "LOCAL" };

export const App = () => {
  const path = usePath();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useTheme();
  const [navOpen, setNavOpen] = useState(false);

  useLinkInterception();

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

  // Close the mobile drawer on navigation. Without this, tapping a link on a
  // phone leaves the menu covering the page it just opened.
  // `path` is the TRIGGER, not a value the body reads — the effect exists
  // precisely to run when it changes, which is why the linter cannot see why
  // it is listed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger
  useEffect(() => setNavOpen(false), [path]);

  const active = ROUTES.find((r) => r.path === path) ?? ROUTES[0];
  const envBadge = identity ? ENV_LABEL[identity.environment] : undefined;
  const unknown = path !== "/" && !ROUTES.some((r) => r.path === path);

  return (
    <div className="shell">
      <header className="topbar">
        <button
          type="button"
          className="nav-toggle"
          aria-expanded={navOpen}
          aria-controls="sidenav"
          onClick={() => setNavOpen((open) => !open)}
        >
          <span aria-hidden="true">☰</span>
          <span className="visually-hidden">Sections</span>
        </button>
        <a className="brand" href="/today">
          fit
        </a>
        {envBadge && (
          <span className="pill pill--accent" title="You are not in production">
            {envBadge}
          </span>
        )}
        <div className="spacer" />
        <fieldset className="theme-fieldset">
          <legend className="visually-hidden">Colour theme</legend>
          <div className="theme-switch">
            {THEME_ORDER.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={theme === option}
                onClick={() => setTheme(option)}
              >
                {THEME_LABEL[option]}
              </button>
            ))}
          </div>
        </fieldset>
        {identity && <span className="muted who">{identity.email}</span>}
        <a className="muted" href="/oauth2/logout">
          Sign out
        </a>
      </header>

      <div className="body">
        <nav
          id="sidenav"
          className={`sidenav${navOpen ? " sidenav--open" : ""}`}
          aria-label="Sections"
        >
          {SECTIONS.map((section) => (
            <div key={section} className="sidenav__group">
              <h2 className="sidenav__heading">{section}</h2>
              {ROUTES.filter((r) => r.section === section && !r.nested).map((route) => (
                <a
                  key={route.path}
                  href={route.path}
                  aria-current={route.path === active?.path ? "page" : undefined}
                >
                  {route.label}
                </a>
              ))}
            </div>
          ))}
        </nav>

        <main>
          {error && <Banner variant="error">{error}</Banner>}
          {unknown ? (
            <>
              <h1>Not found</h1>
              <Banner>
                <code className="mono">{path}</code> is not a page in this app.
              </Banner>
              <p>
                <a href="/today">Back to today</a>
              </p>
            </>
          ) : (
            active?.render()
          )}
        </main>
      </div>

      <footer className="footer muted">
        Candito 6-Week Strength Program. Every prescribed weight on this page is computed from your
        current one-rep maxes, not stored.
      </footer>
    </div>
  );
};
