"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { withBase, useNavBase } from "./app-link";
import { Icon } from "./icons";
import { primaryLinks } from "./side-nav";
import { requestSyncNow } from "./sync-status";
import { useTheme } from "./theme-provider";
import type { PaletteIndex, WorkState } from "@/lib/views/types";

export const OPEN_PALETTE_EVENT = "cg:open-palette";
export function openCommandPalette() { window.dispatchEvent(new Event(OPEN_PALETTE_EVENT)); }

type Entry = { id: string; group: string; label: string; detail?: string; icon: string; color?: number; keywords: string; run: () => void; shortcut?: string[] };

const groupOrder = ["Jump to", "Actions", "Courses", "Work", "Course sections"];
const sectionShortcuts = [["Grades", "grades"], ["Assignments", "assignments"], ["Modules", "modules"], ["Files", "files"], ["Pages", "pages"], ["Syllabus", "syllabus"], ["Announcements", "announcements"]] as const;
const stateLabel: Partial<Record<WorkState, string>> = { overdue: "Overdue", missing: "Missing", submitted: "Submitted", graded: "Graded", late: "Late", excused: "Excused" };

function isTyping(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)));
}

/** Global keyboard layer: Cmd/Ctrl+K or "/" opens the palette; "g" then a letter jumps to a page. */
export function CommandPalette() {
  const router = useRouter();
  const base = useNavBase();
  const { setPreference } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<PaletteIndex | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "error">("idle");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const listId = useId();

  const go = useCallback((href: string) => { setOpen(false); router.push(withBase(base, href)); }, [base, router]);

  const show = useCallback(() => { restoreRef.current = document.activeElement as HTMLElement | null; setQuery(""); setActive(0); setOpen(true); }, []);
  const hide = useCallback(() => { setOpen(false); requestAnimationFrame(() => restoreRef.current?.focus?.()); }, []);

  useEffect(() => {
    let pendingG = 0;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") { event.preventDefault(); if (open) hide(); else show(); return; }
      if (open || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (event.key === "/") { event.preventDefault(); show(); return; }
      if (event.key === "g") { pendingG = Date.now(); return; }
      if (pendingG && Date.now() - pendingG < 900) {
        pendingG = 0;
        const target = event.key === "s" ? "/settings" : primaryLinks.find(link => link.key === event.key.toLowerCase())?.href;
        if (target) { event.preventDefault(); router.push(withBase(base, target)); }
      }
    };
    const onOpen = () => show();
    document.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => { document.removeEventListener("keydown", onKey); window.removeEventListener(OPEN_PALETTE_EVENT, onOpen); };
  }, [base, hide, open, router, show]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    if (index || loadState === "loading") return;
    const timer = window.setTimeout(() => {
      setLoadState("loading");
      fetch("/api/views/palette", { cache: "no-store", signal: AbortSignal.timeout(10_000) })
        .then(response => response.ok ? response.json() as Promise<PaletteIndex> : Promise.reject(new Error("unavailable")))
        .then(value => { setIndex(value); setLoadState("idle"); })
        .catch(() => setLoadState("error"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [index, loadState, open]);

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [
      ...primaryLinks.map(link => ({ id: `nav-${link.href}`, group: "Jump to", label: link.label, icon: link.icon, keywords: `${link.label} page go`, run: () => go(link.href), shortcut: ["G", link.key.toUpperCase()] })),
      { id: "nav-grades", group: "Jump to", label: "Course grades", icon: "grade", keywords: "grades what-if gpa scores", run: () => go("/grades") },
      { id: "nav-settings", group: "Jump to", label: "Settings", icon: "settings", keywords: "settings preferences connection timezone", run: () => go("/settings"), shortcut: ["G", "S"] },
      { id: "action-sync", group: "Actions", label: "Sync Canvas now", detail: "Queue a fresh sync of every resource", icon: "refresh", keywords: "sync refresh update canvas now", run: () => { setOpen(false); requestSyncNow(); } },
      { id: "action-theme-dark", group: "Actions", label: "Switch to dark theme", icon: "moon", keywords: "theme dark mode appearance", run: () => { setPreference("dark"); setOpen(false); } },
      { id: "action-theme-light", group: "Actions", label: "Switch to light theme", icon: "sun", keywords: "theme light mode appearance", run: () => { setPreference("light"); setOpen(false); } },
      { id: "action-week", group: "Actions", label: "Show this week as a calendar", icon: "columns", keywords: "planner week calendar view", run: () => go("/planner?view=week") },
      { id: "action-unread", group: "Actions", label: "Read announcements", icon: "megaphone", keywords: "announcements news inbox", run: () => go("/inbox?tab=announcements") },
    ];
    for (const course of index?.courses ?? []) {
      list.push({ id: `course-${course.id}`, group: "Courses", label: course.name, detail: course.code + (course.favorite ? "" : " · inactive"), icon: "book", color: course.color, keywords: `${course.code} ${course.name} course`, run: () => go(`/courses/${course.id}`) });
      for (const [label, section] of sectionShortcuts) list.push({ id: `course-${course.id}-${section}`, group: "Course sections", label: `${course.code} › ${label}`, detail: course.name, icon: section === "grades" ? "grade" : "chevron-right", color: course.color, keywords: `${course.code} ${course.name} ${label}`, run: () => go(`/courses/${course.id}/${section}`) });
    }
    for (const item of index?.items ?? []) {
      const due = item.dueAt ? new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(new Date(item.dueAt)) : "No due date";
      list.push({ id: `item-${item.id}`, group: "Work", label: item.title, detail: [item.course?.code, due, stateLabel[item.state]].filter(Boolean).join(" · "), icon: "assignment", color: item.course?.color, keywords: `${item.title} ${item.course?.code ?? ""} ${item.course?.name ?? ""}`, run: () => item.href ? go(item.href) : item.canvasUrl ? window.open(item.canvasUrl, "_blank", "noopener,noreferrer") : undefined });
    }
    return list;
  }, [go, index, setPreference]);

  const results = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return entries.filter(entry => entry.group === "Jump to" || entry.group === "Actions" || entry.group === "Courses").slice(0, 24);
    const scored = entries.flatMap(entry => {
      const haystack = `${entry.label} ${entry.keywords}`.toLowerCase(), label = entry.label.toLowerCase();
      if (!terms.every(term => haystack.includes(term))) return [];
      const score = (label.startsWith(terms[0]) ? 0 : label.includes(terms[0]) ? 1 : 2) + groupOrder.indexOf(entry.group) * .1;
      return [{ entry, score }];
    }).sort((a, b) => a.score - b.score);
    const perGroup = new Map<string, number>();
    return scored.filter(({ entry }) => { const count = perGroup.get(entry.group) ?? 0; perGroup.set(entry.group, count + 1); return count < (entry.group === "Work" ? 8 : 6); })
      .map(({ entry }) => entry).sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group));
  }, [entries, query]);

  useEffect(() => { listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);

  // One highlight glides between options instead of each row toggling its own background.
  // Positioned imperatively so moving the selection never re-renders the list.
  useLayoutEffect(() => {
    const highlight = highlightRef.current;
    if (!highlight) return;
    const option = listRef.current?.querySelector<HTMLElement>(`[data-index="${Math.min(active, results.length - 1)}"]`);
    if (!option) { highlight.style.opacity = "0"; return; }
    const place = () => { highlight.style.transform = `translateY(${option.offsetTop}px)`; highlight.style.height = `${option.offsetHeight}px`; highlight.style.opacity = "1"; };
    if (highlight.dataset.placed) { place(); return; }
    highlight.style.transition = "none"; place(); void highlight.offsetHeight; highlight.style.transition = ""; highlight.dataset.placed = "1";
  });

  if (!open) return null;
  const clamp = (value: number) => results.length ? (value + results.length) % results.length : 0;
  const current = results[Math.min(active, results.length - 1)];

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive(value => clamp(value + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive(value => clamp(value - 1)); }
    else if (event.key === "Enter") { event.preventDefault(); current?.run(); }
    else if (event.key === "Escape") { event.preventDefault(); hide(); }
    else if (event.key === "Tab") { event.preventDefault(); }
  }

  return <div className="palette-root" onKeyDown={onKeyDown}>
    <button type="button" className="palette-scrim" aria-label="Close command palette" tabIndex={-1} onClick={hide} />
    <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="palette-input">
        <Icon name="search" />
        <input ref={inputRef} role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={current ? `${listId}-${current.id}` : undefined} aria-label="Search pages, courses, assignments and actions" placeholder="Search or jump to…" value={query} onChange={event => { setQuery(event.target.value); setActive(0); }} spellCheck={false} autoComplete="off" />
        <kbd className="kbd">Esc</kbd>
      </div>
      <div className="palette-list" id={listId} role="listbox" aria-label="Results" ref={listRef}>
        <div className="palette-hl" ref={highlightRef} aria-hidden="true" />
        {results.map((entry, position) => {
          const header = position === 0 || results[position - 1].group !== entry.group ? entry.group : null;
          return <div key={entry.id} role="presentation">
            {header && <div className="palette-group" role="presentation">{header}</div>}
            <div id={`${listId}-${entry.id}`} role="option" aria-selected={position === active} data-index={position} className={`palette-option${entry.color != null ? ` c${entry.color}` : ""}`} onMouseMove={() => setActive(position)} onClick={() => entry.run()}>
              {entry.color != null ? <span className="course-dot" aria-hidden="true" /> : <Icon name={entry.icon} />}
              <span className="palette-label">{entry.label}</span>
              {entry.detail && <span className="palette-detail">{entry.detail}</span>}
              {entry.shortcut && <span className="palette-keys" aria-hidden="true">{entry.shortcut.map(key => <kbd key={key} className="kbd">{key}</kbd>)}</span>}
            </div>
          </div>;
        })}
        {!results.length && <div className="palette-empty" role="status">{loadState === "loading" ? "Loading your courses and work…" : `No matches for “${query}”.`}</div>}
        {loadState === "error" && <div className="palette-empty" role="status">Courses and assignments are unavailable right now. Pages and actions still work.</div>}
      </div>
      <div className="palette-foot" aria-hidden="true"><span><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> navigate</span><span><kbd className="kbd">↵</kbd> open</span><span><kbd className="kbd">G</kbd> then a letter jumps anywhere</span></div>
    </div>
  </div>;
}

export function PaletteTrigger({ variant = "field" }: { variant?: "field" | "icon" }) {
  if (variant === "icon") return <button type="button" className="icon-btn" aria-label="Search and commands" onClick={openCommandPalette}><Icon name="search" /></button>;
  return <button type="button" className="search-trigger" onClick={openCommandPalette} aria-keyshortcuts="Control+K Meta+K"><Icon name="search" /><span>Search or jump to…</span><span className="keys" aria-hidden="true"><kbd className="kbd">Ctrl</kbd><kbd className="kbd">K</kbd></span></button>;
}
