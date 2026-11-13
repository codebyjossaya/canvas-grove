"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/icons";
import styles from "./connect-agent.module.css";

async function writeClipboard(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through to the legacy path */ }
  try {
    const area = document.createElement("textarea");
    area.value = text; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
    document.body.appendChild(area); area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch { return false; }
}

/** Copies `text`. Shows "Copied" for a moment. `label` names the target for screen readers. */
export function CopyButton({ text, label, children, variant = "ghost", className = "" }: { text: string; label: string; children?: ReactNode; variant?: "ghost" | "secondary"; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    const ok = await writeClipboard(text);
    setState(ok ? "copied" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1800);
  }
  const shown = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : children ?? "Copy";
  return <button type="button" className={`button ${variant} ${styles.copy} ${className}`} onClick={copy} aria-label={`${state === "copied" ? "Copied" : "Copy"} ${label}`}>
    <Icon name={state === "copied" ? "check" : "file"} />
    <span aria-live="polite">{shown}</span>
  </button>;
}
