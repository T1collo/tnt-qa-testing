"use client";

import * as React from "react";

import { THEME_STORAGE_KEY } from "@/lib/theme";

export type Theme = "light" | "dark" | "system";

type ThemeContextValue = {
  theme: Theme;
  /** "system" resolved against the OS setting - what is actually on screen. */
  resolved: "light" | "dark";
  setTheme: (theme: Theme) => void;
};

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

// The stored choice and the OS preference are both external stores, so they are read with
// useSyncExternalStore rather than copied into state inside an effect. That keeps the server
// render and the hydrated client render consistent (React re-renders with the client
// snapshot itself) and avoids the cascading render a setState-in-effect would cause.
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

// Used only when localStorage is unavailable (private browsing, blocked site data). Without
// it the snapshot would re-read empty storage and silently discard the user's choice.
let inMemoryTheme: Theme | null = null;

function subscribeToStoredTheme(onChange: () => void) {
  listeners.add(onChange);
  // "storage" fires when another tab changes the choice; notify() covers this tab.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // Storage blocked - fall through to whatever was chosen this session.
  }
  return inMemoryTheme ?? "system";
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribeToSystemTheme(onChange: () => void) {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = React.useSyncExternalStore(
    subscribeToStoredTheme,
    readStoredTheme,
    () => "system" as Theme // no localStorage on the server
  );
  const systemPrefersDark = React.useSyncExternalStore(
    subscribeToSystemTheme,
    () => window.matchMedia(DARK_QUERY).matches,
    () => false
  );

  const resolved: "light" | "dark" =
    theme === "system" ? (systemPrefersDark ? "dark" : "light") : theme;

  // Pushing the resolved theme onto the document is the legitimate use of an effect here:
  // updating an external system from React state, not copying state into state.
  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
    // Keeps native UI (scrollbars, form controls, autofill) in step with the tokens.
    root.style.colorScheme = resolved;
  }, [resolved]);

  const setTheme = React.useCallback((next: Theme) => {
    inMemoryTheme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage blocked - the in-memory value keeps the choice for this session.
    }
    notify();
  }, []);

  const value = React.useMemo(
    () => ({ theme, resolved, setTheme }),
    [theme, resolved, setTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = React.useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside <ThemeProvider>");
  return context;
}
