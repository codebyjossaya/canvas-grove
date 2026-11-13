"use client";

import { useSyncExternalStore } from "react";

const STEP = 15_000;
const subscribe = (notify: () => void) => { const id = window.setInterval(notify, STEP); return () => window.clearInterval(id); };
const snapshot = () => Math.floor(Date.now() / STEP) * STEP;

/** Current time, refreshed every 15 s. Render text that depends on it with suppressHydrationWarning. */
export function useNow(): number { return useSyncExternalStore(subscribe, snapshot, snapshot); }
