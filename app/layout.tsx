import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/ui/theme-provider";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "./globals.css";
import "./theme.css";
export const metadata: Metadata = { title: "Canvas Grove", description: "A calmer, clearer home for your Canvas courses." };
// viewportFit "cover" lets the layout use safe-area insets on notched phones; "resizes-content"
// makes Android Chrome shrink the layout when the on-screen keyboard opens so focused fields and
// the school search results stay visible. Zoom is never disabled.
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", interactiveWidget: "resizes-content", colorScheme: "light dark", themeColor: [{media:"(prefers-color-scheme: light)",color:"#f4f7f2"},{media:"(prefers-color-scheme: dark)",color:"#0d1511"}] };
export default function RootLayout({ children }: { children: ReactNode }) { return <html lang="en" suppressHydrationWarning><body><script dangerouslySetInnerHTML={{__html:THEME_INIT_SCRIPT}}/><ClerkProvider appearance={{variables:{colorPrimary:"var(--accent-primary)",colorBackground:"var(--surface-raised)",colorForeground:"var(--text-primary)",colorMutedForeground:"var(--text-muted)",borderRadius:"0.625rem"}}}><ThemeProvider>{children}</ThemeProvider></ClerkProvider></body></html>; }
