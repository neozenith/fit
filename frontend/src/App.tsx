import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Identity } from "./api.js";
import { Banner } from "./components.jsx";
import { BlockInputsPage } from "./pages/BlockInputs.jsx";
import { ExercisesPage } from "./pages/Exercises.jsx";
import { FinOpsPage } from "./pages/FinOps.jsx";
import { HistoryCardioPage } from "./pages/history/Cardio.jsx";
import { HistoryOverviewPage } from "./pages/history/Overview.jsx";
import { HistoryRepMaxesPage } from "./pages/history/RepMaxes.jsx";
import { HistoryStreaksPage } from "./pages/history/Streaks.jsx";
import { HistoryVolumePage } from "./pages/history/Volume.jsx";
import { LogPage } from "./pages/Log.jsx";
import { MeasurementsPage } from "./pages/Measurements.jsx";
import { OverviewPage } from "./pages/Overview.jsx";
import { ProgressPage } from "./pages/Progress.jsx";
import { useLinkInterception, usePath } from "./router.jsx";
import "./styles/app.css";
import { THEME_LABEL, THEME_ORDER, useTheme } from "./theme.js";

/**
 * Real paths, not hash fragments.
 *
 * Every view is addressable — `/history/volume?grain=week&equipment=Barbell`
 * opens exactly that chart (ADR-0027). Filter state lives in the query string
 * for the same reason: a configuration that exists only in component memory can
 * be described but never *sent*.
 *
 * The edge authenticator already rewrites extensionless non-`/api/` paths to
 * `/index.html` (ADR-0024), so there is no server-side routing to add.
 */

interface Route {
  path: string;
  label: string;
  section: string;
  render: () => React.ReactNode;
  /** Paths that also resolve here — earlier names, kept so old links work. */
  aliases?: string[];
}

const ROUTES: Route[] = [
  {
    path: "/overview",
    label: "Overview",
    section: "Train",
    render: () => <OverviewPage />,
    // `/today` was this page's name before it became a six-week calendar rather
    // than a single day's prescription.
    aliases: ["/today", "/"],
  },
  { path: "/log", label: "Log a session", section: "Train", render: () => <LogPage /> },
  {
    path: "/block-inputs",
    label: "Block inputs",
    section: "Train",
    render: () => <BlockInputsPage />,
    aliases: ["/block"],
  },

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

/**
 * Paths that have MOVED, and where to.
 *
 * A redirect rather than an alias: `/history/bodyweight` merged into
 * `/measurements`, so its content is no longer a distinct view. Leaving two
 * URLs rendering one page would undermine "every view is a URL" from the other
 * direction — one view, one address.
 */
const MOVED: Record<string, string> = { "/history/bodyweight": "/measurements" };

const SECTIONS = ["Train", "Track", "History", "Platform"];

/** Environments other than prod announce themselves, so nobody logs into the wrong one. */
const ENV_LABEL: Record<string, string> = { dev: "DEV", test: "TEST", local: "LOCAL" };

const NAV_STORAGE_KEY = "fit:nav-collapsed";

export const App = () => {
  const path = usePath();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useTheme();

  // Two independent pieces of state, not one. On a phone the sidebar is a
  // drawer, closed by default; on a desktop it is a column, open by default and
  // collapsible. Conflating them made the drawer inherit a desktop preference
  // and open itself over the page on every load.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(NAV_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  const toggleCollapsed = useCallback(() => {
    setCollapsed((was) => {
      const next = !was;
      try {
        localStorage.setItem(NAV_STORAGE_KEY, String(next));
      } catch {
        // Blocked storage: the choice still applies for this session.
      }
      return next;
    });
  }, []);

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger
  useEffect(() => setDrawerOpen(false), [path]);

  // A moved page rewrites the address bar rather than just rendering the new
  // content, so the URL keeps describing what is on screen.
  useEffect(() => {
    const destination = MOVED[path];
    if (destination) window.history.replaceState(null, "", destination + window.location.search);
  }, [path]);

  const resolved = MOVED[path] ?? path;
  const active =
    ROUTES.find((r) => r.path === resolved) ??
    ROUTES.find((r) => r.aliases?.includes(resolved)) ??
    null;

  const envBadge = identity ? ENV_LABEL[identity.environment] : undefined;

  return (
    <div className={`shell${collapsed ? " shell--collapsed" : ""}`}>
      <header className="topbar">
        <button
          type="button"
          className="nav-toggle"
          aria-expanded={drawerOpen}
          aria-controls="sidenav"
          onClick={() => setDrawerOpen((open) => !open)}
        >
          <span aria-hidden="true">☰</span>
          <span className="visually-hidden">Sections</span>
        </button>
        <a className="brand" href="/overview">
          fit
        </a>
        {envBadge && (
          <span className="pill pill--accent" title="You are not in production">
            {envBadge}
          </span>
        )}
        <div className="spacer" />
        {identity && <span className="muted who">{identity.email}</span>}
        <a className="muted" href="/oauth2/logout">
          Sign out
        </a>
      </header>

      <div className="body">
        <nav
          id="sidenav"
          className={`sidenav${drawerOpen ? " sidenav--open" : ""}`}
          aria-label="Sections"
        >
          <div className="sidenav__scroll">
            {SECTIONS.map((section) => (
              <div key={section} className="sidenav__group">
                <h2 className="sidenav__heading">{section}</h2>
                {ROUTES.filter((r) => r.section === section).map((route) => (
                  <a
                    key={route.path}
                    href={route.path}
                    // The title is what a collapsed rail has instead of a label.
                    title={route.label}
                    aria-current={route.path === active?.path ? "page" : undefined}
                  >
                    <span className="sidenav__label">{route.label}</span>
                  </a>
                ))}
              </div>
            ))}
          </div>

          {/* The theme control lives at the FOOT of the nav, not in the global
              header. It is a preference — set once, rarely revisited — whereas
              the header carries what is true right now: which environment, who
              is signed in. Mixing the two put the app's least urgent control in
              its busiest strip. */}
          <div className="sidenav__foot">
            <fieldset className="theme-fieldset">
              <legend className="sidenav__heading">Theme</legend>
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

            <button
              type="button"
              className="sidenav__collapse"
              onClick={toggleCollapsed}
              aria-pressed={collapsed}
              // An explicit label because the visible one is `display: none`
              // once collapsed — and content hidden that way is excluded from
              // the accessible name, leaving the button called "»".
              aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            >
              <span aria-hidden="true">{collapsed ? "»" : "«"}</span>
              <span className="sidenav__label">Collapse</span>
            </button>
          </div>
        </nav>

        <main>
          {error && <Banner variant="error">{error}</Banner>}
          {active ? (
            active.render()
          ) : (
            <>
              <h1>Not found</h1>
              <Banner>
                <code className="mono">{path}</code> is not a page in this app.
              </Banner>
              <p>
                <a href="/overview">Back to the overview</a>
              </p>
            </>
          )}
        </main>
      </div>

      <footer className="footer muted">
        Candito 6-Week Strength Program. Every prescribed weight in this app is computed from your
        current one-rep maxes, not stored.
      </footer>
    </div>
  );
};
