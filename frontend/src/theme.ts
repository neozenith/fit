import { useCallback, useEffect, useState } from "react";

/**
 * Light, dark, or follow the operating system.
 *
 * THREE states, not two, and the third is the default. `system` deliberately
 * stamps NOTHING on the root element, so the stylesheet's
 * `prefers-color-scheme` blocks decide — which is why every colour in
 * `tokens.css` is defined on bare `:root` first and only redefined inside the
 * dark blocks. A two-state toggle would have to guess an initial value and
 * would then disagree with the OS for anyone who changes it at sunset.
 */

export type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "fit:theme";
const THEMES: Theme[] = ["system", "light", "dark"];

const isTheme = (value: string | null): value is Theme =>
  value !== null && (THEMES as string[]).includes(value);

/**
 * Applied to `document.documentElement`, not to a React-rendered wrapper.
 *
 * The attribute has to exist before first paint or the page flashes the wrong
 * theme, and it has to be visible to `getComputedStyle` for the charts, which
 * resolve their palette from CSS custom properties rather than from React.
 */
const apply = (theme: Theme): void => {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
};

const stored = (): Theme => {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isTheme(value) ? value : "system";
  } catch {
    // Private browsing and blocked storage both throw on access rather than
    // returning null. The preference is a convenience; losing it is not a
    // reason for the app to fail to render.
    return "system";
  }
};

/** Set before React mounts, so there is no flash of the wrong palette. */
export const initTheme = (): void => apply(stored());

export const useTheme = (): [Theme, (next: Theme) => void] => {
  const [theme, setThemeState] = useState<Theme>(stored);

  useEffect(() => {
    apply(theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // See `stored()` — the choice still applies to this session.
    }
  }, []);

  return [theme, setTheme];
};

export const THEME_ORDER = THEMES;

export const THEME_LABEL: Record<Theme, string> = {
  system: "Auto",
  light: "Light",
  dark: "Dark",
};
