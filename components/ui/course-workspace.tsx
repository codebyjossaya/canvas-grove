"use client";

import { useParams, useSelectedLayoutSegment, useSelectedLayoutSegments } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { formatInstant } from "@/lib/time";
import { assignmentHref } from "@/lib/views/assignment-detail-core";
import { courseColor } from "@/lib/views/build";
import { htmlToParagraphs, plainText } from "@/lib/views/text";
import { CanvasProse } from "./canvas-prose";
import type { WorkItem } from "@/lib/views/types";
import { WorkList } from "@/components/workspace/work-row";
import { AppLink } from "./app-link";
import { GradesWorkspace } from "./grades-workspace";
import { Icon } from "./icons";
import styles from "./course-workspace.module.css";
import { useDisplayTimeZone } from "./use-display-timezone";
import { ActiveMarker, NAV_BACK, PageTransition } from "./page-transition";

export type CourseSection = "overview" | "assignments" | "announcements" | "files" | "syllabus" | "modules" | "pages" | "grades";
type Tab = { id: string; label: string; hidden?: boolean; position?: number; type?: "native" | "external"; nativePath?: string | null; canvasUrl?: string | null };
type Course = { id: string; name: string; courseCode?: string | null; canvasUrl?: string | null; currentScore?: number | null; currentGrade?: string | null };
type Item = Record<string, unknown>;
type SectionResponse = { course?: Course; data?: Record<string, unknown>; lastSyncedAt?: string | null; stale?: boolean };
type TabsResponse = { course?: Course; tabs?: Tab[]; lastSyncedAt?: string | null; stale?: boolean };
type SearchEntry = { id: string; kind: string; title: string; detail: string; href: string; external: boolean };

const sectionLabels: Record<CourseSection, string> = { overview: "Overview", assignments: "Assignments", announcements: "Announcements", modules: "Modules", pages: "Pages", files: "Files", syllabus: "Syllabus", grades: "Grades" };
const sectionOrder = Object.keys(sectionLabels) as CourseSection[];
const TimeZoneContext = createContext("UTC");
const courseSections = new Set<string>(sectionOrder);

// Mounted by app/(workspace)/courses/[courseId]/layout.tsx. The layout persists while the
// student switches sections, so the course header, search and tabs stay on screen and only the
// section body changes. An unknown section renders just the page's not-found UI.
export function CourseWorkspaceRoute({ children }: { children: ReactNode }) {
  const params = useParams<{ courseId: string }>();
  const segment = useSelectedLayoutSegment();
  const segments = useSelectedLayoutSegments();
  // /assignments/[assignmentId] is a standalone detail page: no section list above it.
  if (segment && (segment === "overview" || !courseSections.has(segment) || (segment === "assignments" && segments.length > 1))) return <>{children}</>;
  return <><PageTransition key={params.courseId}><CourseWorkspace courseId={params.courseId} active={(segment as CourseSection | null) ?? "overview"} /></PageTransition>{children}</>;
}

type SectionState = { data: Record<string, unknown>; lastSyncedAt: string | null; stale: boolean; course: Course | null };

export function CourseWorkspace({ courseId, active = "overview" }: { courseId: string; active?: CourseSection }) {
  const timeZone = useDisplayTimeZone();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [tabsCourse, setTabsCourse] = useState<Course | null>(null);
  const [tabsSync, setTabsSync] = useState<{ lastSyncedAt: string | null; stale: boolean }>({ lastSyncedAt: null, stale: false });
  // Section results are kept per section so revisiting a tab shows saved data immediately
  // while it refreshes, instead of unmounting the list into a skeleton every time.
  const [sections, setSections] = useState<Record<string, SectionState>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const cacheKey = `${courseId}:${active}`;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    fetch(`/api/canvas/courses/${courseId}/tabs`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const value = await response.json() as TabsResponse & { error?: string };
        if (cancelled || !response.ok) return;
        setTabs((value.tabs ?? []).filter(tab => !tab.hidden).sort((a, b) => (a.position ?? 99) - (b.position ?? 99)));
        setTabsCourse(value.course ?? null);
        setTabsSync({ lastSyncedAt: value.lastSyncedAt ?? null, stale: Boolean(value.stale) });
      })
      .catch(() => { /* Tabs are progressive enhancement; Overview stays available. */ });
    return () => { cancelled = true; controller.abort(); };
  }, [courseId]);

  const load = useCallback(async () => {
    setPending(cacheKey); setError("");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 12_000);
    try {
      const sectionResponse = await fetch(`/api/canvas/courses/${courseId}/${active}`, { cache: "no-store", signal: controller.signal });
      const sectionValue = await sectionResponse.json() as SectionResponse & { error?: string };
      if (!sectionResponse.ok) throw new Error(sectionValue.error || "Course data is unavailable");
      setSections(current => ({ ...current, [cacheKey]: { data: sectionValue.data ?? {}, lastSyncedAt: sectionValue.lastSyncedAt ?? null, stale: Boolean(sectionValue.stale), course: sectionValue.course ?? null } }));
    } catch (reason) {
      setError(reason instanceof DOMException && reason.name === "AbortError" ? "Saved course data took too long to load. Nothing was changed." : "This course section could not be loaded. Previously synced course data is unchanged.");
    } finally { window.clearTimeout(timer); setPending(current => current === cacheKey ? null : current); }
  }, [active, cacheKey, courseId]);

  useEffect(() => { const start = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(start); }, [load]);
  const navigation = useMemo(() => buildNavigation(courseId, tabs), [courseId, tabs]);
  const externalTabs = tabs.filter(tab => tab.type === "external" && safeUrl(tab.canvasUrl));
  const section = sections[cacheKey];
  const course = section?.course ?? tabsCourse;
  const lastSyncedAt = section?.lastSyncedAt ?? tabsSync.lastSyncedAt;
  const stale = section ? section.stale : tabsSync.stale;
  const loading = pending === cacheKey && !section;
  const color = courseColor(courseId);
  const grade = course?.currentGrade || (course?.currentScore != null ? `${course.currentScore.toFixed(1)}%` : null);

  return <TimeZoneContext.Provider value={timeZone}><main className={`${styles.workspace} c${color}`}>
    <header className={styles.hero}>
      <div className={styles.crumbs}><AppLink href="/courses" transitionTypes={NAV_BACK}>Courses</AppLink><Icon name="chevron-right" /><span className="course-code">{course ? course.courseCode || "Canvas course" : "…"}</span><Freshness value={lastSyncedAt} stale={stale} /></div>
      <div className={styles.heroRow}>
        <h1>{course?.name || (pending === cacheKey ? <span className={styles.titlePlaceholder} aria-hidden="true" /> : "Course")}</h1>
        <div className={styles.heroActions}>
          {grade && <AppLink className={styles.gradePill} href={`/courses/${courseId}/grades`} title="Current grade in Canvas"><small>Grade</small><strong className="num">{grade}</strong></AppLink>}
          {safeUrl(course?.canvasUrl) && <a className="button secondary" href={safeUrl(course?.canvasUrl)!} target="_blank" rel="noopener noreferrer">Open course in Canvas <Icon name="external" /></a>}
        </div>
      </div>
      <div className={styles.navRow}>
        <nav className={styles.tabs} aria-label="Course sections">
          {navigation.map(tab => <AppLink key={tab.section} href={tab.href} aria-current={active === tab.section ? "page" : undefined} scroll={false}>{tab.label}{active === tab.section && <ActiveMarker name="section-line" className={styles.tabLine} />}</AppLink>)}
          {externalTabs.length > 0 && <details className={styles.moreTabs}><summary>More <Icon name="chevron-down" /></summary><div>{externalTabs.map(tab => <a key={tab.id} href={safeUrl(tab.canvasUrl)!} target="_blank" rel="noopener noreferrer">{tab.label}<Icon name="external" /></a>)}</div></details>}
        </nav>
        <CourseSearch courseId={courseId} />
      </div>
    </header>
    <section className={styles.body} aria-live="polite" aria-busy={pending === cacheKey}>
      {section ? <ResourceView key={cacheKey} kind={active} data={section.data} courseId={courseId} course={course} /> : loading ? <SectionSkeleton kind={active} /> : error ? <State title="We couldn’t open this section" body={error} tone="error"><button className="button secondary" onClick={() => void load()}>Try again</button></State> : <SectionSkeleton kind={active} />}
    </section>
  </main></TimeZoneContext.Provider>;
}

function ResourceView({ kind, data, courseId, course }: { kind: CourseSection; data: Record<string, unknown>; courseId: string; course: Course | null }) {
  if (kind === "overview") return <Overview data={data} courseId={courseId} course={course} />;
  if (kind === "assignments") return <Assignments items={workItems(data.items ?? data.assignments)} courseId={courseId} />;
  if (kind === "announcements") return <Announcements items={array(data.announcements)} />;
  if (kind === "syllabus") return <Syllabus data={data} />;
  if (kind === "modules") return <Modules items={array(data.modules)} />;
  if (kind === "files") return <Files files={array(data.files)} folders={array(data.folders)} />;
  if (kind === "grades") return <CourseGrades courseId={courseId} />;
  return <Pages items={array(data.pages)} />;
}

function useNow() { const [now] = useState(() => new Date().toISOString()); return now; }

function Overview({ data, courseId, course }: { data: Record<string, unknown>; courseId: string; course: Course | null }) {
  const timeZone = useContext(TimeZoneContext), now = useNow();
  const upcoming = workItems(data.upcoming), overdue = workItems(data.overdue), announcements = array(data.announcements);
  const next = upcoming.filter(item => item.state === "open" && item.dueAt && item.dueAt >= now).slice(0, 4);
  const rest = upcoming.filter(item => !next.includes(item));
  return <div className={styles.overview}>
    {overdue.length > 0 && <div className={styles.alertStrip} role="status"><Icon name="alert" /><span><strong>{overdue.length} overdue</strong> {overdue.slice(0, 2).map(item => item.title).join(", ")}{overdue.length > 2 ? "…" : ""}</span><AppLink href={`/courses/${courseId}/assignments`}>Review</AppLink></div>}
    <section aria-labelledby="next-up">
      <h2 id="next-up" className="section-title">Next up</h2>
      {next.length ? <ol className={styles.strip}>{next.map(item => <li key={item.id}>
        <span className={styles.stripWhen}>{formatDate(item.dueAt, timeZone, { weekday: "short", month: "short", day: "numeric" })}</span>
        {item.canvasUrl ? <a className={styles.stripTitle} href={item.canvasUrl} target="_blank" rel="noopener noreferrer">{item.title}</a> : <span className={styles.stripTitle}>{item.title}</span>}
        <span className={styles.stripMeta}><span className="num">{formatDate(item.dueAt, timeZone, { hour: "numeric", minute: "2-digit" })}</span>{item.points != null && item.points > 0 && <span className="num">{item.points} pts</span>}{item.kind !== "assignment" && <span>{label(item.kind)}</span>}</span>
      </li>)}</ol> : <InlineEmpty>Nothing open is coming up. Upcoming work appears here after each sync.</InlineEmpty>}
    </section>
    <div className={styles.overviewGrid}>
      <section aria-labelledby="coming-up">
        <h2 id="coming-up" className="section-title">Coming up <span className="count">{rest.length}</span><AppLink href={`/courses/${courseId}/assignments`}>All assignments</AppLink></h2>
        {rest.length ? <div className={styles.listCard}><WorkList items={rest} now={now} zone={timeZone} when="date" showCourse={false} /></div> : <InlineEmpty>No other dated work this week.</InlineEmpty>}
      </section>
      <aside className={styles.overviewSide}>
        <AppLink className={styles.gradeCard} href={`/courses/${courseId}/grades`}>
          <small>Current grade</small>
          <strong className="num">{course?.currentGrade || (course?.currentScore != null ? `${course.currentScore.toFixed(1)}%` : "Not posted")}</strong>
          <span>{course?.currentGrade && course.currentScore != null ? `${course.currentScore.toFixed(2)}% · ` : ""}Breakdown and What-If <Icon name="arrow" /></span>
        </AppLink>
        <section aria-labelledby="recent-news">
          <h2 id="recent-news" className="section-title">Announcements<AppLink href={`/courses/${courseId}/announcements`}>All</AppLink></h2>
          {announcements.length ? <ul className={styles.newsList}>{announcements.slice(0, 4).map((item, index) => <li key={id(item, index)}>
            <AppLink href={`/courses/${courseId}/announcements#${encodeURIComponent(String(item.id ?? index))}`}><strong>{text(item.title, "Announcement")}</strong><small><time dateTime={String(item.postedAt ?? "")}>{formatDate(item.postedAt, timeZone)}</time></small>{typeof item.bodyHtml === "string" && <span>{plainText(item.bodyHtml, 140)}</span>}</AppLink>
          </li>)}</ul> : <InlineEmpty>No recent announcements.</InlineEmpty>}
        </section>
      </aside>
    </div>
  </div>;
}

function Assignments({ items: source, courseId }: { items: WorkItem[]; courseId: string }) {
  // Real assignments (those with a Canvas assignment URL) open the in-app detail page.
  const items = useMemo(() => source.map(item => item.canvasUrl && /\/assignments\/\d+/.test(item.canvasUrl) ? { ...item, href: assignmentHref(courseId, item.id) } : item), [source, courseId]);
  const timeZone = useContext(TimeZoneContext), now = useNow();
  const [filter, setFilter] = useState<"upcoming" | "past" | "all">("upcoming");
  const [limit, setLimit] = useState(30);
  const upcoming = items.filter(item => !item.dueAt || item.dueAt >= now), past = items.filter(item => item.dueAt && item.dueAt < now).reverse();
  const visible = filter === "upcoming" ? upcoming : filter === "past" ? past : items;
  return <>
    <SectionHead title="Assignments" count={items.length}>
      <div className={styles.segmented} role="group" aria-label="Filter assignments">{(["upcoming", "past", "all"] as const).map(value => <button key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setLimit(30); }}>{value === "upcoming" ? `Upcoming ${upcoming.length}` : value === "past" ? `Past ${past.length}` : "All"}</button>)}</div>
    </SectionHead>
    {visible.length ? <div className={`${styles.listCard} ${styles.scroll}`}><WorkList items={visible.slice(0, limit)} now={now} zone={timeZone} when="date" showCourse={false} />{visible.length > limit && <button className={styles.loadMore} onClick={() => setLimit(value => value + 30)}>Show {Math.min(30, visible.length - limit)} more</button>}</div>
      : <State title={filter === "upcoming" ? "Nothing upcoming" : "Nothing here yet"} body={filter === "upcoming" ? "No assignments with future due dates are cached for this course." : "No assignments are cached for this course."} />}
  </>;
}

function Announcements({ items }: { items: Item[] }) {
  const timeZone = useContext(TimeZoneContext);
  const [limit, setLimit] = useState(10);
  const [hash, setHash] = useState("");
  useEffect(() => { const timer = window.setTimeout(() => setHash(decodeURIComponent(window.location.hash.slice(1))), 0); return () => window.clearTimeout(timer); }, []);
  return <>
    <SectionHead title="Announcements" count={items.length} />
    {items.length ? <div className={styles.announcements}>{items.slice(0, limit).map((item, index) => {
      const key = String(item.id ?? index), paragraphs = htmlToParagraphs(typeof item.bodyHtml === "string" ? item.bodyHtml : "");
      return <details key={key} id={encodeURIComponent(key)} className={styles.announcement} open={index === 0 || hash === key}>
        <summary><span><strong>{text(item.title, "Announcement")}</strong><time dateTime={String(item.postedAt ?? "")}>{formatDate(item.postedAt, timeZone)}</time></span><Icon name="chevron-down" /></summary>
        <div className={styles.prose}>{text(item.renderedHtml, "") ? <CanvasProse html={text(item.renderedHtml, "")} /> : paragraphs.length ? paragraphs.map((paragraph, at) => <p key={at}>{paragraph}</p>) : <p>No text body.</p>}{safeUrl(item.htmlUrl) && <a className="inline-link" href={safeUrl(item.htmlUrl)!} target="_blank" rel="noopener noreferrer">Open in Canvas ↗</a>}</div>
      </details>;
    })}{items.length > limit && <button className={styles.loadMore} onClick={() => setLimit(value => value + 10)}>Show {Math.min(10, items.length - limit)} more</button>}</div>
      : <State title="No announcements yet" body="Announcements from this course appear after the next successful sync." />}
  </>;
}

function Files({ files, folders }: { files: Item[]; folders: Item[] }) {
  const [query, setQuery] = useState(""), [folder, setFolder] = useState<string | null>(null), [limit, setLimit] = useState(30);
  const normalized = query.trim().toLowerCase();
  const visibleFiles = files.filter(file => (!folder || String(file.folderId) === folder) && text(file.displayName, "").toLowerCase().includes(normalized));
  return <>
    <SectionHead title="Files" count={files.length}>
      <label className={styles.searchField}><Icon name="search" /><span className="sr-only">Search course files</span><input type="search" value={query} onChange={event => { setQuery(event.target.value); setLimit(30); }} placeholder="Filter files" /></label>
    </SectionHead>
    {folders.length > 0 && <div className={styles.chips} role="group" aria-label="Folders"><button aria-pressed={!folder} onClick={() => setFolder(null)}>All files</button>{folders.slice(0, 12).map((item, index) => <button key={id(item, index)} aria-pressed={folder === String(item.id)} onClick={() => { setFolder(String(item.id)); setLimit(30); }}>{text(item.name ?? item.fullName, "Folder")}<span className="count">{Number(item.filesCount ?? 0)}</span></button>)}</div>}
    {visibleFiles.length ? <div className={`${styles.listCard} ${styles.scroll}`}><ul className={styles.fileList}>{visibleFiles.slice(0, limit).map((file, index) => <FileRow key={id(file, index)} file={file} />)}</ul>{visibleFiles.length > limit && <button className={styles.loadMore} onClick={() => setLimit(value => value + 30)}>Show more files</button>}</div>
      : <State title={normalized || folder ? "No matching files" : "No files yet"} body={normalized || folder ? "Try a shorter search or another folder." : "Published files will appear after the next successful sync."} />}
  </>;
}

function FileRow({ file }: { file: Item }) {
  const timeZone = useContext(TimeZoneContext);
  const href = safeInternal(file.downloadPath) || safeUrl(file.canvasUrl);
  const name = text(file.displayName, "Untitled file"), extension = fileExtension(name);
  return <li className={styles.fileRow}>
    <span className={`${styles.fileType} ${styles[`type${extension}`] ?? ""}`} aria-hidden="true">{extension}</span>
    <span className={styles.fileMain}><strong>{name}</strong><small>{[fileSize(file.size), formatDate(file.updatedAt, timeZone, { month: "short", day: "numeric", year: "numeric" })].filter(Boolean).join(" · ")}</small></span>
    {href && (href.startsWith("/") ? <a className="button ghost" href={href}>Download</a> : <a className="button ghost" href={href} target="_blank" rel="noopener noreferrer">Open <Icon name="external" /></a>)}
  </li>;
}

function Syllabus({ data }: { data: Record<string, unknown> }) {
  const schedule = array(data.calendar), paragraphs = htmlToParagraphs(text(data.html ?? data.bodyHtml, ""));
  const timeZone = useContext(TimeZoneContext);
  return <>
    <SectionHead title="Syllabus" />
    <div className={styles.syllabusGrid}>
      <article className={`${styles.document} ${styles.prose}`}>{text(data.renderedHtml, "") ? <CanvasProse html={text(data.renderedHtml, "")} /> : paragraphs.length ? paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>) : <InlineEmpty>No syllabus text has synced yet.</InlineEmpty>}</article>
      <aside className={styles.schedule}><h3>Schedule</h3>{schedule.length ? <ol>{schedule.slice(0, 16).map((item, index) => <li key={id(item, index)}><time dateTime={String(item.dueAt ?? "")}>{formatDate(item.dueAt, timeZone, { month: "short", day: "numeric" })}</time><span>{text(item.title, "Item")}</span></li>)}</ol> : <InlineEmpty>No schedule entries are cached.</InlineEmpty>}</aside>
    </div>
  </>;
}

function Modules({ items }: { items: Item[] }) {
  const firstOpen = Math.max(0, items.findIndex(module => array(module.items).some(item => !item.completed)));
  return <>
    <SectionHead title="Modules" count={items.length} />
    {items.length ? <div className={styles.modules}>{items.map((module, index) => {
      const children = array(module.items), done = children.filter(item => item.completed).length;
      return <details className={styles.module} key={id(module, index)} open={index === firstOpen}>
        <summary>
          <span className={styles.moduleName}><strong>{text(module.name, "Untitled module")}</strong><small>{children.length} items{done ? ` · ${done} done` : ""}</small></span>
          <span className={styles.progress} aria-label={`${done} of ${children.length} complete`}><i style={{ width: `${children.length ? (done / children.length) * 100 : 0}%` }} /></span>
          <Icon name="chevron-down" />
        </summary>
        <ul className={styles.moduleItems}>{children.map((item, itemIndex) => {
          const internal = safeInternal(item.nativePath), external = safeUrl(item.canvasUrl), title = text(item.title, "Untitled item");
          const content = <><Icon name={moduleIcon(item.type)} /><span>{title}</span>{item.completed ? <Icon name="check" className={styles.doneIcon} aria-label="Completed" /> : null}{!internal && external ? <Icon name="external" className={styles.extIcon} /> : null}</>;
          return <li key={id(item, itemIndex)}>{internal ? <AppLink href={internal}>{content}</AppLink> : external ? <a href={external} target="_blank" rel="noopener noreferrer">{content}</a> : <span>{content}</span>}</li>;
        })}{!children.length && <li className={styles.muted}>No items in this module.</li>}</ul>
      </details>;
    })}</div> : <State title="No modules yet" body="Published modules will appear after the next successful sync." />}
  </>;
}

function Pages({ items }: { items: Item[] }) {
  const timeZone = useContext(TimeZoneContext);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => { const hash = decodeURIComponent(window.location.hash.slice(1)); setOpen(items.some(page => String(page.slug ?? page.id) === hash) ? hash : items.length ? String(items[0].slug ?? items[0].id ?? 0) : null); }, 0);
    return () => window.clearTimeout(timer);
  }, [items]);
  const current = items.find(page => String(page.slug ?? page.id) === open);
  return <>
    <SectionHead title="Pages" count={items.length} />
    {items.length ? <div className={styles.pages}>
      <ul className={styles.pageList}>{items.map((page, index) => { const key = String(page.slug ?? page.id ?? index); return <li key={key}><button aria-pressed={open === key} onClick={() => { setOpen(key); history.replaceState(null, "", `#${encodeURIComponent(key)}`); }}><Icon name="page" /><span><strong>{text(page.title, "Untitled page")}</strong><small>{formatDate(page.updatedAt, timeZone, { month: "short", day: "numeric", year: "numeric" }) || "Published page"}</small></span></button></li>; })}</ul>
      <article className={`${styles.document} ${styles.prose}`} aria-live="polite">{current ? <><h3>{text(current.title, "Untitled page")}</h3>{text(current.renderedHtml, "") ? <CanvasProse html={text(current.renderedHtml, "")} /> : htmlToParagraphs(text(current.html, "")).map((paragraph, index) => <p key={index}>{paragraph}</p>)}{!text(current.html, "") && !text(current.renderedHtml, "") && <p>No page text is cached.</p>}{safeUrl(current.canvasUrl) && <a className="inline-link" href={safeUrl(current.canvasUrl)!} target="_blank" rel="noopener noreferrer">Open full page in Canvas ↗</a>}</> : <InlineEmpty>Choose a page.</InlineEmpty>}</article>
    </div> : <State title="No pages yet" body="Published pages will appear after the next successful sync." />}
  </>;
}

function CourseGrades({ courseId }: { courseId: string }) {
  return <GradesWorkspace courseId={courseId} embedded />;
}

/** In-course search over everything synced for this course; the index loads on first focus. */
function CourseSearch({ courseId }: { courseId: string }) {
  const [query, setQuery] = useState(""), [entries, setEntries] = useState<SearchEntry[] | null>(null), [state, setState] = useState<"idle" | "loading" | "error">("idle"), [openList, setOpenList] = useState(false), [active, setActive] = useState(0);
  const listId = useId(), wrapRef = useRef<HTMLDivElement>(null);
  const loadIndex = useCallback(() => {
    if (entries || state === "loading") return;
    setState("loading");
    fetch(`/api/views/course-search/${courseId}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) }).then(response => response.ok ? response.json() : Promise.reject(new Error("unavailable"))).then((value: { entries?: SearchEntry[] }) => { setEntries(value.entries ?? []); setState("idle"); }).catch(() => setState("error"));
  }, [courseId, entries, state]);
  useEffect(() => { const close = (event: MouseEvent) => { if (!wrapRef.current?.contains(event.target as Node)) setOpenList(false); }; document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close); }, []);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const results = terms.length && entries ? entries.filter(entry => terms.every(term => `${entry.title} ${entry.detail}`.toLowerCase().includes(term))).slice(0, 12) : [];
  const show = openList && terms.length > 0;
  return <div className={styles.courseSearch} ref={wrapRef}>
    <label className={styles.searchField}><Icon name="search" /><span className="sr-only">Search this course</span>
      <input type="search" role="combobox" aria-expanded={show} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={show && results[active] ? `${listId}-${active}` : undefined} placeholder="Search this course" value={query}
        onFocus={() => { loadIndex(); setOpenList(true); }} onChange={event => { setQuery(event.target.value); setActive(0); setOpenList(true); }}
        onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setActive(value => Math.min(results.length - 1, value + 1)); } else if (event.key === "ArrowUp") { event.preventDefault(); setActive(value => Math.max(0, value - 1)); } else if (event.key === "Escape") setOpenList(false); else if (event.key === "Enter" && results[active]) { event.preventDefault(); (document.getElementById(`${listId}-${active}`)?.querySelector("a") as HTMLAnchorElement | null)?.click(); setOpenList(false); } }} />
    </label>
    {show && <div className={styles.searchResults} id={listId} role="listbox" aria-label="Course search results">
      {state === "loading" && <p>Loading course index…</p>}
      {state === "error" && <p>Search is unavailable right now. Nothing was changed.</p>}
      {state === "idle" && !results.length && <p>No matches for “{query}”.</p>}
      {results.map((entry, index) => <div key={`${entry.kind}-${entry.id}`} id={`${listId}-${index}`} role="option" aria-selected={index === active} onMouseMove={() => setActive(index)}>
        {entry.external ? <a href={entry.href} target={entry.href.startsWith("/api/") ? undefined : "_blank"} rel="noopener noreferrer"><Icon name={moduleIcon(entry.kind)} /><span>{entry.title}</span><small>{entry.detail}</small></a> : <AppLink href={entry.href} onClick={() => setOpenList(false)}><Icon name={moduleIcon(entry.kind)} /><span>{entry.title}</span><small>{entry.detail}</small></AppLink>}
      </div>)}
    </div>}
  </div>;
}

function SectionHead({ title, count, children }: { title: string; count?: number; children?: ReactNode }) { return <div className={styles.sectionHead}><h2>{title}{count != null && <span className="count">{count}</span>}</h2>{children}</div>; }
function Freshness({ value, stale }: { value: string | null; stale: boolean }) { const timeZone = useContext(TimeZoneContext); return <span className={`${styles.freshness} ${stale ? styles.stale : ""}`} title={value ? formatInstant(value, timeZone) : "Not synced yet"}><i aria-hidden="true" />{value ? `${stale ? "Last synced" : "Synced"} ${relative(value, timeZone)}` : "Waiting for sync"}</span>; }
function SectionSkeleton({ kind }: { kind: CourseSection }) { return <div className={styles.skeleton} role="status" data-kind={kind}><span className="sr-only">Loading saved course data</span>{kind === "overview" && <div className={styles.skStrip}>{[0, 1, 2, 3].map(index => <i key={index} className="skeleton" />)}</div>}<div className={styles.skRows}>{[0, 1, 2, 3, 4].map(index => <i key={index} className="skeleton" style={{ width: `${55 + (index * 13) % 40}%` }} />)}</div></div>; }
function State({ title, body, tone, children }: { title: string; body: string; tone?: "error"; children?: ReactNode }) { return <div className={`empty-state ${tone === "error" ? "error" : ""}`} role={tone === "error" ? "alert" : undefined}><span className="empty-icon"><Icon name={tone === "error" ? "alert" : "circle-dash"} /></span><h3>{title}</h3><p>{body}</p>{children && <div className="actions">{children}</div>}</div>; }
function InlineEmpty({ children }: { children: ReactNode }) { return <p className={styles.inlineEmpty}>{children}</p>; }

function buildNavigation(courseId: string, tabs: Tab[]) {
  const native = new Map<CourseSection, { section: CourseSection; label: string; href: string }>();
  for (const tab of tabs) { const section = sectionFromTab(tab); if (section && !native.has(section)) native.set(section, { section, label: sectionLabels[section], href: section === "overview" ? `/courses/${courseId}` : `/courses/${courseId}/${section}` }); }
  if (!native.has("overview")) native.set("overview", { section: "overview", label: "Overview", href: `/courses/${courseId}` });
  if (!native.has("grades")) native.set("grades", { section: "grades", label: "Grades", href: `/courses/${courseId}/grades` });
  return sectionOrder.filter(section => native.has(section)).map(section => native.get(section)!);
}
function sectionFromTab(tab: Tab): CourseSection | null { if (tab.id === "home") return "overview"; const suffix = tab.nativePath?.split("/").filter(Boolean).at(-1); const value = suffix === "overview" || tab.id === "overview" ? "overview" : suffix ?? tab.id; return sectionOrder.includes(value as CourseSection) ? value as CourseSection : null; }
function array(value: unknown): Item[] { return Array.isArray(value) ? value as Item[] : []; }
function workItems(value: unknown): WorkItem[] { return array(value).filter(item => typeof item.id === "string" && typeof item.title === "string" && typeof item.state === "string") as unknown as WorkItem[]; }
function id(item: Item, index: number) { return String(item.id ?? item.slug ?? item.canvasId ?? index); }
function text(value: unknown, fallback: string) { return typeof value === "string" && value.trim() ? value.trim() : fallback; }
function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function label(value: unknown) { return typeof value === "string" ? value.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase()) : ""; }
function safeInternal(value: unknown) { return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : null; }
function safeUrl(value: unknown) { try { const url = new URL(String(value)); return url.protocol === "https:" ? url.toString() : null; } catch { return null; } }
function formatDate(value: unknown, zone: string, options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) { return value ? formatInstant(String(value), zone, options) : ""; }
function relative(value: string, zone: string) { const delta = Math.max(0, Date.now() - new Date(value).getTime()); if (delta < 60_000) return "just now"; if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`; if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`; return formatDate(value, zone); }
function fileSize(value: unknown) { const size = number(value); if (size == null) return ""; if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(1)} MB`; return `${Math.max(1, Math.round(size / 1_000))} KB`; }
function fileExtension(name: string) { const extension = name.split(".").at(-1); return extension && extension !== name ? extension.slice(0, 4).toUpperCase() : "FILE"; }
function moduleIcon(type: unknown) { const kind = String(type ?? "").toLowerCase(); if (kind.includes("quiz")) return "quiz"; if (kind.includes("discussion")) return "discussion"; if (kind.includes("file")) return "file"; if (kind.includes("page")) return "page"; if (kind.includes("announcement")) return "megaphone"; if (kind.includes("module")) return "layers"; if (kind.includes("external") || kind.includes("url")) return "external"; return "assignment"; }
