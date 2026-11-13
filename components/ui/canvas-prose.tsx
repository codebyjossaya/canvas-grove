"use client";

import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";
import { useNavBase, withBase } from "./app-link";

/** Renders HTML already sanitized by lib/views/canvas-html.ts. Grove-internal links navigate client-side. */
/** The one place quiz/assignment HTML reaches the DOM; callers pass only renderCanvasHtml output (server-sanitized). */
export function CanvasProse({ html, className, inline = false }: { html: string; className?: string; inline?: boolean }) {
  const router = useRouter();
  const base = useNavBase();
  function onClick(event: MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[data-link='internal']");
    const href = link?.getAttribute("href");
    if (!href || !href.startsWith("/") || href.startsWith("//")) return;
    event.preventDefault();
    router.push(withBase(base, href));
  }
  const cls = `canvas-prose${inline ? " canvas-prose-inline" : ""}${className ? ` ${className}` : ""}`;
  return inline
    ? <span className={cls} dangerouslySetInnerHTML={{ __html: html }} />
    : <div className={cls} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
