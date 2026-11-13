"use client";

import { useEffect, useState } from "react";
import type { ActionsPayload } from "./model";
import styles from "./approvals.module.css";

/** Count of actions waiting for approval. Renders nothing at zero. Not wired into the shell yet:
 *  the integrator places it next to the Approvals nav link. `count` overrides fetching (previews). */
export function ApprovalsBadge({ count, className = "" }: { count?: number; className?: string }) {
  const [fetched, setFetched] = useState(0);
  const offline = count !== undefined;
  useEffect(() => {
    if (offline) return;
    let live = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      fetch("/api/canvas/mcp/actions?view=awaiting&limit=1", { headers: { "x-grove-csrf": "1" }, cache: "no-store" })
        .then(response => response.ok ? response.json() as Promise<ActionsPayload> : Promise.reject(new Error("load")))
        .then(body => { if (live) setFetched(body.awaitingCount); })
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, 30_000);
    window.addEventListener("focus", load);
    return () => { live = false; window.clearInterval(timer); window.removeEventListener("focus", load); };
  }, [offline]);
  const value = count ?? fetched;
  if (value <= 0) return null;
  return <span className={`${styles.badge} ${className}`} aria-label={`${value} action${value === 1 ? "" : "s"} waiting for approval`}>{value > 99 ? "99+" : value}</span>;
}
