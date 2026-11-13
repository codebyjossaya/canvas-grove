"use client";

import { useCallback, useEffect, useState } from "react";
import type { AutoTarget, DurationMinutes } from "../approvals/auto-model";

type State = { status: "loading" | "ready" | "unavailable"; targets: AutoTarget[] };
export type AutoSave = { enabled: boolean; categories: string[]; durationMinutes: DurationMinutes };
export type AutoResult = { ok: true } | { ok: false; message: string };

const HEADERS = { "x-grove-csrf": "1", "content-type": "application/json" };
const API = "/api/canvas/mcp/auto-mode";

/** Auto-mode settings per connection. With `fixture`, nothing touches the network. If the endpoint
 *  is unavailable the rows simply do not render (status "unavailable"). */
export function useAutoMode(fixture?: AutoTarget[]) {
  const [state, setState] = useState<State>(fixture ? { status: "ready", targets: fixture } : { status: "loading", targets: [] });
  useEffect(() => {
    if (fixture) return;
    let live = true;
    fetch(API, { headers: HEADERS, cache: "no-store" })
      .then(response => response.ok ? response.json() as Promise<{ targets: AutoTarget[] }> : Promise.reject(new Error("load")))
      .then(body => { if (live) setState({ status: "ready", targets: body.targets }); })
      .catch(() => { if (live) setState({ status: "unavailable", targets: [] }); });
    return () => { live = false; };
  }, [fixture]);

  const save = useCallback(async (target: AutoTarget, change: AutoSave): Promise<AutoResult> => {
    const replace = (next: AutoTarget) => setState(previous => ({ ...previous, targets: previous.targets.map(item => item.kind === next.kind && item.id === next.id ? next : item) }));
    if (fixture) {
      const expiresAt = change.enabled && change.durationMinutes ? new Date(Date.now() + change.durationMinutes * 60_000).toISOString() : null;
      replace({ ...target, auto: change.enabled ? { enabled: true, categories: change.categories, expiresAt, usedLastHour: 0, usedToday: 0 } : { ...target.auto, enabled: false, categories: [], expiresAt: null } });
      return { ok: true };
    }
    try {
      const response = await fetch(`${API}/${target.kind}/${encodeURIComponent(target.id)}`, { method: "PUT", headers: HEADERS, body: JSON.stringify(change), cache: "no-store" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        return { ok: false, message: response.status === 409 ? "This connection cannot propose actions, so auto mode cannot be turned on." : body.error || "Could not save auto mode. Nothing was changed." };
      }
      const body = await response.json() as { target: AutoTarget };
      replace(body.target);
      return { ok: true };
    } catch { return { ok: false, message: "Could not save auto mode. Check your connection and try again." }; }
  }, [fixture]);

  return { state, save };
}
export type AutoModeApi = ReturnType<typeof useAutoMode>;
