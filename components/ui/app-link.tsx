"use client";

import Link, { useLinkStatus } from "next/link";
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";

// In the real app the base is "". The dev-only fixture preview mounts the same screens under
// /dev-preview and sets a base so in-app navigation stays inside the preview.
const BaseContext = createContext("");

export function NavBaseProvider({ base, children }: { base: string; children: ReactNode }) {
  return <BaseContext.Provider value={base}>{children}</BaseContext.Provider>;
}

export function useNavBase() { return useContext(BaseContext); }

export function withBase(base: string, href: string) {
  if (!base || !href.startsWith("/") || href.startsWith("//") || href.startsWith("/api/")) return href;
  return href === "/" ? base : `${base}${href}`;
}

/** Strips the preview base so active-route checks work identically in both modes. */
export function stripBase(base: string, pathname: string) {
  if (!base || !pathname.startsWith(base)) return pathname;
  return pathname.slice(base.length) || "/";
}

/** Rendered inside a Link: flags the pending navigation so CSS can style the clicked link and show the top bar. */
function PendingMark() {
  const { pending } = useLinkStatus();
  return pending ? <i className="link-pending" aria-hidden="true" /> : null;
}

export function AppLink({ href, children, ...props }: Omit<ComponentProps<typeof Link>, "href"> & { href: string }) {
  const base = useNavBase();
  return <Link href={withBase(base, href)} {...props}>{children}<PendingMark /></Link>;
}
