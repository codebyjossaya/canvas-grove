"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isThemePreference, resolveTheme, THEME_STORAGE_KEY, type ResolvedTheme, type ThemePreference } from "@/lib/theme";
import { Icon } from "./icons";

type ThemeContextValue = { preference: ThemePreference; resolvedTheme: ResolvedTheme; setPreference: (preference: ThemePreference) => void; resetPreference: () => void };
const ThemeContext = createContext<ThemeContextValue | null>(null);
const systemIsDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

function applyTheme(preference: ThemePreference) {
  const resolved = resolveTheme(preference, systemIsDark());
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolved;
  return resolved;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light");
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      const initial = isThemePreference(stored) ? stored : "system";
      setPreferenceState(initial);
      setResolvedTheme(applyTheme(initial));
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => { if (preference === "system") setResolvedTheme(applyTheme("system")); };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = isThemePreference(event.newValue) ? event.newValue : "system";
      setPreferenceState(next);
      setResolvedTheme(applyTheme(next));
    };
    media.addEventListener("change", onSystemChange);
    window.addEventListener("storage", onStorage);
    return () => { media.removeEventListener("change", onSystemChange); window.removeEventListener("storage", onStorage); };
  }, [preference]);
  const setPreference = (next: ThemePreference) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    setPreferenceState(next);
    setResolvedTheme(applyTheme(next));
  };
  const resetPreference = () => {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    setPreferenceState("system");
    setResolvedTheme(applyTheme("system"));
  };
  const value = useMemo(() => ({ preference, resolvedTheme, setPreference, resetPreference }), [preference, resolvedTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}

export function ThemeControl({ compact = false, allowSystemReset = false }: { compact?: boolean; allowSystemReset?: boolean }) {
  const { preference, setPreference, resetPreference } = useTheme();
  const label = "Toggle color theme";
  const toggle = () => {
    const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    setPreference(current === "dark" ? "light" : "dark");
  };
  return <div className={compact ? "theme-control compact" : "theme-control"}>
    <button type="button" className="theme-toggle" aria-label={label} title={label} onClick={toggle}><span className="theme-icon theme-icon-moon"><Icon name="moon"/></span><span className="theme-icon theme-icon-sun"><Icon name="sun"/></span></button>
    {allowSystemReset ? <button type="button" className="theme-reset" data-visible={preference !== "system"} aria-hidden={preference === "system"} tabIndex={preference === "system" ? -1 : 0} onClick={resetPreference}>Use system setting</button> : null}
  </div>;
}
