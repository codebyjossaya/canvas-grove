"use client";

import { flushSync } from "react-dom";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isThemePreference, resolveTheme, THEME_STORAGE_KEY, type ResolvedTheme, type ThemePreference } from "@/lib/theme";
import { Icon } from "./icons";

type ThemeContextValue = { preference: ThemePreference; resolvedTheme: ResolvedTheme; setPreference: (preference: ThemePreference, origin?: { x: number; y: number }) => void; resetPreference: () => void };
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

type ViewTransitionDocument = { startViewTransition?: (update: () => void) => { ready: Promise<void>; finished: Promise<void> } };

/** Swaps the theme inside a view transition so the new palette spreads out in a circle from the
 * control that was used (or the top centre). Falls back to an instant swap. */
function revealTheme(commit: () => void, next: ResolvedTheme, origin?: { x: number; y: number }) {
  const root = document.documentElement;
  const start = (document as unknown as ViewTransitionDocument).startViewTransition?.bind(document);
  if (!start || root.dataset.theme === next || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { commit(); return; }
  const x = origin?.x ?? window.innerWidth / 2, y = origin?.y ?? 0;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  root.dataset.vt = "theme";
  const transition = start(() => flushSync(commit));
  transition.ready.then(() => {
    root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] }, { duration: 620, easing: "cubic-bezier(.16,1,.3,1)", pseudoElement: "::view-transition-new(root)" });
  }).catch(() => {});
  transition.finished.finally(() => { delete root.dataset.vt; }).catch(() => {});
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
  const setPreference = (next: ThemePreference, origin?: { x: number; y: number }) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    revealTheme(() => { setPreferenceState(next); setResolvedTheme(applyTheme(next)); }, resolveTheme(next, systemIsDark()), origin);
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
  const toggle = (event: React.MouseEvent<HTMLButtonElement>) => {
    const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    const box = event.currentTarget.getBoundingClientRect();
    setPreference(current === "dark" ? "light" : "dark", { x: box.left + box.width / 2, y: box.top + box.height / 2 });
  };
  return <div className={compact ? "theme-control compact" : "theme-control"}>
    <button type="button" className="theme-toggle" aria-label={label} title={label} onClick={toggle}><span className="theme-icon theme-icon-moon"><Icon name="moon"/></span><span className="theme-icon theme-icon-sun"><Icon name="sun"/></span></button>
    {allowSystemReset ? <button type="button" className="theme-reset" data-visible={preference !== "system"} aria-hidden={preference === "system"} tabIndex={preference === "system" ? -1 : 0} onClick={resetPreference}>Use system setting</button> : null}
  </div>;
}
