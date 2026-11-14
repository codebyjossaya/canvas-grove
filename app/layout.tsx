import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/ui/theme-provider";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "./globals.css";
import "./canvas-prose.css";
import "./theme.css";
import "./motion.css";

// Inter (variable, latin subset) is self-hosted from app/fonts so builds never need network.
const inter = localFont({ src: "./fonts/inter-latin-var.woff2", variable: "--font-inter", weight: "400 700", display: "swap", fallback: ["ui-sans-serif", "system-ui", "Segoe UI", "Roboto", "sans-serif"] });

export const metadata: Metadata = { title: "Canvas Grove", description: "A calm, fast command center for your Canvas courses." };
// viewportFit "cover" lets the layout use safe-area insets on notched phones; "resizes-content"
// makes Android Chrome shrink the layout when the on-screen keyboard opens so focused fields and
// the school search results stay visible. Zoom is never disabled.
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", interactiveWidget: "resizes-content", colorScheme: "light dark", themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f6f6f7" }, { media: "(prefers-color-scheme: dark)", color: "#0e0e11" }] };
export default function RootLayout({ children }: { children: ReactNode }) { return <html lang="en" className={inter.variable} suppressHydrationWarning><body><script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}/><ClerkProvider appearance={{ variables: { colorPrimary: "var(--accent-primary)", colorBackground: "var(--surface-raised)", colorForeground: "var(--text-primary)", colorMutedForeground: "var(--text-muted)", colorPrimaryForeground: "var(--accent-on-primary)", colorInput: "var(--surface-subtle)", colorInputForeground: "var(--text-primary)", colorDanger: "var(--status-danger)", colorShadow: "transparent", borderRadius: "0.5rem", fontFamily: "var(--font-sans)" } }}><ThemeProvider>{children}</ThemeProvider></ClerkProvider></body></html>; }
