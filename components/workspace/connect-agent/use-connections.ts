"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgentAccess } from "@/lib/scopes/catalog";
import { READ_SCOPE, WRITE_SCOPE, type AutoCategory } from "@/lib/mcp/categories";

export type TokenItem = { id: string; name: string; prefix: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; expiresAt: string | null };
export type GrantItem = { id: string; clientName: string; scopes: string[]; createdAt: string; lastUsedAt: string | null };
/** `defaults` = what a new connection gets unless the user picks otherwise (Settings > Data & permissions). */
export type ConnectionsData = { serverUrl: string; tokens: TokenItem[]; grants: GrantItem[]; defaults?: { access: AgentAccess; autoCategories: AutoCategory[] } };
export type ExpiryChoice = 30 | 90 | 365 | null;
export type CreateResult = { ok: true; token: string; item: TokenItem } | { ok: false; message: string };

type State = { status: "loading" | "ready" | "error"; data: ConnectionsData | null; message: string };

const HEADERS = { "x-grove-csrf": "1" };
const ENDPOINT = "/api/canvas/mcp";

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: string; code?: string };
    if (body.code === "TOKEN_LIMIT") return "You already have 10 active access tokens. Revoke one first.";
    return body.error || fallback;
  } catch { return fallback; }
}

/**
 * Loads the user's tokens and OAuth grants. With `fixture`, nothing touches the network.
 * `pollMs` re-reads the list quietly (no loading state) while the tab is visible, so a surface can
 * notice a connection made in another app (orientation step 6).
 */
export function useConnections(fixture?: ConnectionsData, options?: { pollMs?: number }) {
  const [state, setState] = useState<State>(fixture ? { status: "ready", data: fixture, message: "" } : { status: "loading", data: null, message: "" });
  const [nonce, setNonce] = useState(0);
  const pollMs = options?.pollMs ?? 0;

  useEffect(() => {
    if (fixture || pollMs <= 0) return;
    let live = true;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      fetch(`${ENDPOINT}/connections`, { headers: HEADERS, cache: "no-store" })
        .then(response => response.ok ? response.json() as Promise<ConnectionsData> : null)
        .then(data => { if (live && data) setState(previous => ({ ...previous, status: previous.status === "error" ? "ready" : previous.status, data, message: previous.status === "error" ? "" : previous.message })); })
        .catch(() => { /* a missed poll is retried on the next tick */ });
    };
    const timer = window.setInterval(refresh, pollMs);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => { live = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("focus", refresh); };
  }, [fixture, pollMs]);

  useEffect(() => {
    if (fixture) return;
    let live = true;
    fetch(`${ENDPOINT}/connections`, { headers: HEADERS, cache: "no-store" })
      .then(response => response.ok ? response.json() as Promise<ConnectionsData> : errorMessage(response, "Could not load your connections.").then(message => Promise.reject(new Error(message))))
      .then(data => { if (live) setState({ status: "ready", data, message: "" }); })
      .catch((error: Error) => { if (live) setState(previous => ({ status: "error", data: previous.data, message: error.message || "Could not load your connections." })); });
    return () => { live = false; };
  }, [fixture, nonce]);

  const reload = useCallback(() => { setState(previous => ({ ...previous, status: "loading", message: "" })); setNonce(value => value + 1); }, []);

  const revoke = useCallback(async (kind: "tokens" | "grants", id: string) => {
    const snapshot = state.data;
    setState(previous => previous.data ? { ...previous, message: "", data: { ...previous.data, [kind]: (previous.data[kind] as { id: string }[]).filter(item => item.id !== id) } as ConnectionsData } : previous);
    if (fixture) return true;
    const response = await fetch(`${ENDPOINT}/${kind}/${encodeURIComponent(id)}`, { method: "DELETE", headers: HEADERS });
    if (response.ok) return true;
    const message = await errorMessage(response, "Could not revoke that. Try again.");
    setState(previous => ({ ...previous, status: "ready", data: snapshot, message }));
    return false;
  }, [fixture, state.data]);

  /** `allowActions` is always sent: an omitted value would silently fall back to the saved default. */
  const createToken = useCallback(async (name: string, expiresInDays: ExpiryChoice, allowActions: boolean): Promise<CreateResult> => {
    let result: CreateResult;
    if (fixture) {
      const now = new Date("2026-11-12T12:00:00Z");
      const item: TokenItem = { id: `fixture-${fixture.tokens.length + 1}`, name, prefix: "gmt1.demo", scopes: allowActions ? [READ_SCOPE, WRITE_SCOPE] : [READ_SCOPE], createdAt: now.toISOString(), lastUsedAt: null, expiresAt: expiresInDays ? new Date(now.getTime() + expiresInDays * 864e5).toISOString() : null };
      result = { ok: true, token: "gmt1.preview-owner.preview-token.EXAMPLE-NOT-A-REAL-TOKEN", item };
    } else {
      try {
        const response = await fetch(`${ENDPOINT}/tokens`, { method: "POST", headers: { ...HEADERS, "content-type": "application/json" }, body: JSON.stringify({ name, expiresInDays, allowActions }), cache: "no-store" });
        if (!response.ok) return { ok: false, message: await errorMessage(response, "Could not create the token. Try again.") };
        const body = await response.json() as { token: string; item: TokenItem };
        result = { ok: true, token: body.token, item: body.item };
      } catch { return { ok: false, message: "Could not create the token. Check your connection and try again." }; }
    }
    if (result.ok) { const item = result.item; setState(previous => previous.data ? { ...previous, data: { ...previous.data, tokens: [item, ...previous.data.tokens] } } : previous); }
    return result;
  }, [fixture]);

  return { isFixture: fixture !== undefined, state, reload, createToken, revokeToken: (id: string) => revoke("tokens", id), revokeGrant: (id: string) => revoke("grants", id) };
}

export type Connections = ReturnType<typeof useConnections>;

export const PREVIEW_FIXTURE: ConnectionsData = {
  serverUrl: "https://grove.example.com/mcp",
  tokens: [
    { id: "t1", name: "Claude Code on laptop", prefix: "gmt1.3f9a", scopes: ["canvas:read"], createdAt: "2026-10-02T15:00:00Z", lastUsedAt: "2026-11-11T21:14:00Z", expiresAt: "2027-01-01T15:00:00Z" },
    { id: "t2", name: "Cursor (work)", prefix: "gmt1.b7c1", scopes: ["canvas:read"], createdAt: "2026-09-14T10:00:00Z", lastUsedAt: null, expiresAt: null },
  ],
  grants: [{ id: "g1", clientName: "Claude", scopes: ["canvas:read"], createdAt: "2026-10-20T18:30:00Z", lastUsedAt: "2026-11-12T08:02:00Z" }],
};
