"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { classifyDecisionStatus, problemMessage, type ActionsPayload, type ApprovalAction } from "./model";

export type ActionsFixture = ActionsPayload | "error" | "loading";
export type Notice = { id: number; tone: "info" | "error"; text: string };
type State = { status: "loading" | "ready" | "error"; actions: ApprovalAction[]; awaitingCount: number };

const HEADERS = { "x-grove-csrf": "1" };
const API = "/api/canvas/mcp/actions";
export const POLL_MS = 10_000;

function initial(fixture?: ActionsFixture): State {
  if (fixture === "error") return { status: "error", actions: [], awaitingCount: 0 };
  if (!fixture || fixture === "loading") return { status: "loading", actions: [], awaitingCount: 0 };
  return { status: "ready", actions: fixture.actions, awaitingCount: fixture.awaitingCount };
}

/** Loads actions for one tab, polls every 10 s while the tab is visible, refreshes on focus. */
export function useActions(view: "awaiting" | "history", fixture?: ActionsFixture) {
  const [state, setState] = useState<State>(() => initial(fixture));
  const [nonce, setNonce] = useState(0);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const seq = useRef(0);
  const offline = fixture !== undefined;

  useEffect(() => {
    if (offline) return;
    let live = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      fetch(`${API}?view=${view}&limit=50`, { headers: HEADERS, cache: "no-store" })
        .then(response => response.ok ? response.json() as Promise<ActionsPayload> : Promise.reject(new Error("load")))
        .then(body => { if (live) setState({ status: "ready", actions: body.actions, awaitingCount: body.awaitingCount }); })
        .catch(() => { if (live) setState(previous => previous.status === "ready" ? previous : { ...previous, status: "error" }); });
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    window.addEventListener("focus", load);
    return () => { live = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", load); window.removeEventListener("focus", load); };
  }, [view, nonce, offline]);

  const reload = useCallback(() => { setState(previous => ({ ...previous, status: "loading" })); setNonce(value => value + 1); }, []);
  const notify = useCallback((tone: Notice["tone"], text: string) => { seq.current += 1; const id = seq.current; setNotices(list => [...list.slice(-2), { id, tone, text }]); }, []);
  const dismiss = useCallback((id: number) => setNotices(list => list.filter(notice => notice.id !== id)), []);

  /** Optimistic: the card leaves immediately; on failure it comes back with an error. */
  const decide = useCallback(async (action: ApprovalAction, decision: "approve" | "reject") => {
    let index = 0;
    setErrors(previous => { const next = { ...previous }; delete next[action.id]; return next; });
    setState(previous => { index = previous.actions.findIndex(item => item.id === action.id); return { ...previous, awaitingCount: Math.max(0, previous.awaitingCount - 1), actions: previous.actions.filter(item => item.id !== action.id) }; });
    const done = decision === "approve" ? `Approved: ${action.title}` : `Rejected: ${action.title}`;
    const rollback = (message: string) => {
      setState(previous => previous.actions.some(item => item.id === action.id) ? previous : { ...previous, awaitingCount: previous.awaitingCount + 1, actions: [...previous.actions.slice(0, Math.max(0, index)), action, ...previous.actions.slice(Math.max(0, index))] });
      setErrors(previous => ({ ...previous, [action.id]: message }));
    };
    if (offline) { notify("info", done); return; }
    try {
      const response = await fetch(`${API}/${encodeURIComponent(action.id)}/${decision}`, { method: "POST", headers: HEADERS, cache: "no-store" });
      if (response.ok) { notify("info", done); return; }
      const problem = classifyDecisionStatus(response.status);
      if (problem === "error") { rollback(problemMessage.error); return; }
      notify("error", problemMessage[problem]);
      reload();
    } catch { rollback(problemMessage.error); }
  }, [notify, offline, reload]);

  return { state, reload, decide, notices, dismiss, errors };
}
