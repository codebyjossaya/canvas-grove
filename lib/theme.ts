export const THEME_STORAGE_KEY = "canvas-grove-theme";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function resolveTheme(preference: ThemePreference, systemIsDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemIsDark ? "dark" : "light") : preference;
}

// Runs before React hydrates so the first painted frame already has the correct palette.
export const THEME_INIT_SCRIPT = `(()=>{try{const k="${THEME_STORAGE_KEY}",v=localStorage.getItem(k),p=v==="light"||v==="dark"||v==="system"?v:"system",d=p==="dark"||(p==="system"&&matchMedia("(prefers-color-scheme: dark)").matches),r=document.documentElement;r.dataset.theme=d?"dark":"light";r.dataset.themePreference=p;r.style.colorScheme=d?"dark":"light"}catch{document.documentElement.dataset.theme="light";document.documentElement.style.colorScheme="light"}})()`;
