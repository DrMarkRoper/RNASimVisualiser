import { useCallback, useLayoutEffect, useState } from "react";

/**
 * Light / dark theme toggle.
 *
 * The app originally shipped dark-only (`:root { color-scheme: dark; ... }`).
 * We keep dark as the default and layer a set of `[data-theme="light"]`
 * overrides in `index.css`; this hook is the only place that writes the
 * attribute so we don't get theme drift between tabs.
 *
 * The choice is persisted in `localStorage` under `rnasim:theme` so a
 * reload keeps the user's preference.  The initial read checks
 * `prefers-color-scheme` *only* when nothing is stored, so the first
 * visit respects OS settings but subsequent visits follow the toggle.
 */
export type Theme = "dark" | "light";

const STORAGE_KEY = "rnasim:theme";

function readInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // localStorage can throw in some sandboxes / private browsing —
    // fall through to the media-query default.
  }
  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: light)").matches
  ) {
    return "light";
  }
  return "dark";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  // `color-scheme` tells the UA to render form controls + scrollbars in
  // the matching palette, which stops the default scrollbar from
  // staying dark on a light background.
  root.style.colorScheme = theme;
}

export function useTheme(): { theme: Theme; toggle: () => void; setTheme: (t: Theme) => void } {
  const [theme, setThemeState] = useState<Theme>(() => readInitialTheme());

  // Apply on mount (SSR-safe: the state itself is computed from DOM
  // globals that only exist in the browser, so this is always
  // client-side) and whenever theme changes.
  //
  // useLayoutEffect (rather than useEffect) is deliberate.  Children — most
  // notably Viewer3D — read --viewer-bg off :root in their own [theme]
  // effect and push the value into the 3Dmol clear colour.  React fires
  // useEffect callbacks bottom-up (children first), which means with a
  // plain useEffect here the child's read would happen *before* this hook
  // had flipped the data-theme attribute, and the viewer would lag the
  // palette by exactly one toggle (matching the reported bug: the first
  // load is correct, every subsequent toggle is inverted).
  // Layout effects run synchronously after commit and *before* useEffects,
  // so writing the attribute in a layout effect guarantees the new
  // CSS-variable values are visible to every child useEffect that fires
  // immediately afterwards.
  useLayoutEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* see readInitialTheme note */
    }
  }, [theme]);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);
  const toggle = useCallback(
    () => setThemeState((t) => (t === "dark" ? "light" : "dark")),
    [],
  );

  return { theme, toggle, setTheme };
}
