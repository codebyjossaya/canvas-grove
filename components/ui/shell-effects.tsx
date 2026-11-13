"use client";

import { useEffect } from "react";

// Cookie names are mirrored in lib/views/loaders.ts (server-only, so not imported here).
const TZ = "cg_tz", SEEN_AT = "cg_seen_at", SEEN_PREV = "cg_seen_prev";
const SESSION_GAP_MS = 30 * 60_000;

function read(name: string) {
  return document.cookie.split("; ").find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}
function write(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
}

/**
 * Tiny client effects for server-rendered views:
 * - shares this device's time zone so "Today" groups by the student's local day;
 * - records visits so Today can show what changed "since you last looked". A new visit
 *   (after 30 idle minutes) moves the previous visit into cg_seen_prev.
 */
export function ShellEffects() {
  useEffect(() => {
    const touch = () => {
      try {
        if (document.visibilityState !== "visible") return;
        const now = Date.now(), at = Date.parse(decodeURIComponent(read(SEEN_AT) ?? ""));
        if (Number.isFinite(at) && now - at > SESSION_GAP_MS) write(SEEN_PREV, new Date(at).toISOString());
        write(SEEN_AT, new Date(now).toISOString());
      } catch { /* Cookies are an enhancement; views fall back to safe defaults. */ }
    };
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (zone && decodeURIComponent(read(TZ) ?? "") !== zone) write(TZ, zone);
    } catch { /* ignore */ }
    touch();
    // Keep "last active" current during long sessions of client-side navigation.
    const timer = window.setInterval(touch, 5 * 60_000);
    document.addEventListener("visibilitychange", touch);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", touch); };
  }, []);
  return null;
}
