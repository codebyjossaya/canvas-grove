"use client";

import Link from "next/link";
import { useParams, useSelectedLayoutSegment } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { formatInstant } from "@/lib/time";
import { GradesWorkspace } from "./grades-workspace";
import styles from "./course-workspace.module.css";
import { useDisplayTimeZone } from "./use-display-timezone";

export type CourseSection = "overview" | "assignments" | "announcements" | "files" | "syllabus" | "modules" | "pages" | "grades";
type Tab = { id: string; label: string; hidden?: boolean; position?: number; type?: "native" | "external"; nativePath?: string | null; canvasUrl?: string | null };
type Course = { id: string; name: string; courseCode?: string | null; canvasUrl?: string | null };
type Item = Record<string, unknown>;
type SectionResponse = { course?: Course; data?: Record<string, unknown>; lastSyncedAt?: string | null; stale?: boolean };
type TabsResponse = { course?: Course; tabs?: Tab[]; lastSyncedAt?: string | null; stale?: boolean };

const sectionLabels: Record<CourseSection, string> = { overview: "Overview", assignments: "Assignments", announcements: "Announcements", files: "Files", syllabus: "Syllabus", modules: "Modules", pages: "Pages", grades: "Grades" };
const sectionOrder = Object.keys(sectionLabels) as CourseSection[];
const TimeZoneContext = createContext("UTC");

const courseSections = new Set<string>(sectionOrder);

// Mounted by app/(workspace)/courses/[courseId]/layout.tsx. The layout persists while the
// student switches sections, so the course header and tabs stay on screen and only the
// section body changes. An unknown section renders just the page's not-found UI.
export function CourseWorkspaceRoute({ children }: { children: ReactNode }) {
  const params = useParams<{ courseId: string }>();
  const segment = useSelectedLayoutSegment();
  if (segment && (segment === "overview" || !courseSections.has(segment))) return <>{children}</>;
  return <><CourseWorkspace courseId={params.courseId} active={(segment as CourseSection | null) ?? "overview"} />{children}</>;
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

  return <TimeZoneContext.Provider value={timeZone}><main className={styles.workspace}>
    <div className={styles.topline}><Link className={styles.crumb} href="/courses"><span aria-hidden="true">←</span> All courses</Link><Freshness value={lastSyncedAt} stale={stale} /></div>
    <header className={styles.hero}>
      <div className={styles.courseMark} aria-hidden="true">{course ? initials(course.courseCode || course.name) : ""}</div>
      <div className={styles.heroCopy}><p className="eyebrow">{course ? course.courseCode || "Canvas course" : " "}</p><h1>{course?.name || (pending === cacheKey ? <span className={styles.titlePlaceholder} aria-hidden="true" /> : "Course")}</h1></div>
      {safeUrl(course?.canvasUrl) && <a className={styles.canvasLink} href={safeUrl(course?.canvasUrl)!} target="_blank" rel="noopener noreferrer">Open course in Canvas <span aria-hidden="true">↗</span></a>}
    </header>
    <nav className={styles.tabs} aria-label="Course sections">
      {navigation.map(tab => <Link key={tab.section} href={tab.href} aria-current={active === tab.section ? "page" : undefined}>{tab.label}</Link>)}
      {externalTabs.length > 0 && <details className={styles.moreTabs}><summary>More <span aria-hidden="true">⌄</span></summary><div>{externalTabs.map(tab => <a key={tab.id} href={safeUrl(tab.canvasUrl)!} target="_blank" rel="noopener noreferrer">{tab.label}<span aria-hidden="true">↗</span></a>)}</div></details>}
    </nav>
    <section className={styles.body} aria-live="polite" aria-busy={pending === cacheKey}>
      {section ? <ResourceView key={cacheKey} kind={active} data={section.data} courseId={courseId} /> : loading ? <SectionSkeleton /> : error ? <State title="We couldn’t open this section" body={error} tone="error"><button className="button secondary" onClick={() => void load()}>Try again</button></State> : <SectionSkeleton />}
    </section>
  </main></TimeZoneContext.Provider>;
}

function ResourceView({ kind, data, courseId }: { kind: CourseSection; data: Record<string, unknown>; courseId: string }) {
  if (kind === "overview") return <Overview data={data} courseId={courseId} />;
  if (kind === "syllabus") return <Syllabus data={data} />;
  if (kind === "modules") return <Modules items={array(data.modules)} />;
  if (kind === "files") return <Files files={array(data.files)} folders={array(data.folders)} />;
  if (kind === "grades") return <CourseGrades courseId={courseId} />;
  if (kind === "pages") return <Pages items={array(data.pages)} />;
  const descriptions: Record<CourseSection, string> = { overview: "", assignments: "Due dates, points, and submission status from Canvas.", announcements: "The latest updates published by your instructors.", files: "", syllabus: "", modules: "", pages: "", grades: "" };
  return <ResourceList title={sectionLabels[kind]} description={descriptions[kind]} items={array(data[kind])} empty={`No ${sectionLabels[kind].toLowerCase()} are cached for this course.`} />;
}

function Overview({ data, courseId }: { data: Record<string, unknown>; courseId: string }) {
  const assignments = array(data.upcoming), announcements = array(data.announcements);
  return <div className={styles.overviewGrid}>
    <section className={styles.panel}><SectionHead title="Coming up" description="Your next course deadlines" count={assignments.length} href={`/courses/${courseId}/assignments`} />{assignments.length ? <div className={styles.compactList}>{assignments.slice(0, 6).map((item, index) => <ResourceRow key={id(item, index)} item={item} compact />)}</div> : <InlineEmpty>Nothing due is cached right now.</InlineEmpty>}</section>
    <section className={styles.panel}><SectionHead title="Recent announcements" description="The latest instructor updates" count={announcements.length} href={`/courses/${courseId}/announcements`} />{announcements.length ? <div className={styles.compactList}>{announcements.slice(0, 4).map((item, index) => <ResourceRow key={id(item, index)} item={item} compact />)}</div> : <InlineEmpty>No recent announcements.</InlineEmpty>}</section>
  </div>;
}

function ResourceList({ title, description, items, empty }: { title: string; description: string; items: Item[]; empty: string }) {
  const [limit, setLimit] = useState(16);
  return <><SectionHead title={title} description={description} count={items.length} />{items.length ? <div className={styles.resourceFrame}><div className={styles.resourceList}>{items.slice(0, limit).map((item, index) => <ResourceRow key={id(item, index)} item={item} />)}</div>{items.length > limit && <button className={styles.loadMore} onClick={() => setLimit(value => value + 16)}>Show {Math.min(16, items.length - limit)} more</button>}</div> : <State title="Nothing here yet" body={empty} />}</>;
}

function ResourceRow({ item, compact = false }: { item: Item; compact?: boolean }) {
  const timeZone = useContext(TimeZoneContext);
  const href = safeInternal(item.nativePath) || safeUrl(item.htmlUrl ?? item.canvasUrl ?? item.url);
  const title = text(item.name ?? item.title ?? item.displayName, "Untitled item");
  const due = formatDate(item.dueAt ?? item.postedAt ?? item.updatedAt, timeZone);
  const meta = [label(item.status ?? item.workflowState ?? item.type), points(item.pointsPossible)].filter(Boolean).join(" · ");
  const className = `${styles.resourceRow} ${compact ? styles.compactRow : ""}`;
  const content = <><span className={styles.itemGlyph} aria-hidden="true">{glyph(item)}</span><span className={styles.itemMain}><strong>{title}</strong>{meta && <small>{meta}</small>}{!compact && item.bodyHtml ? <p>{plain(String(item.bodyHtml)).slice(0, 240)}</p> : null}</span><span className={styles.itemAside}>{due && <time dateTime={String(item.dueAt ?? item.postedAt ?? item.updatedAt)}>{due}</time>}{href && <span className={styles.rowArrow} aria-hidden="true">→</span>}</span></>;
  if (!href) return <article className={className}>{content}</article>;
  if (href.startsWith("/")) return <Link className={className} href={href}>{content}</Link>;
  return <a className={className} href={href} target="_blank" rel="noopener noreferrer">{content}</a>;
}

function Files({ files, folders }: { files: Item[]; folders: Item[] }) {
  const [query, setQuery] = useState(""), [limit, setLimit] = useState(24);
  const normalized = query.trim().toLowerCase();
  const visibleFiles = files.filter(file => text(file.displayName, "").toLowerCase().includes(normalized));
  return <><SectionHead title="Files" description="Published course folders and files" count={files.length} /><div className={styles.fileTools}><label><span className="sr-only">Search course files</span><input type="search" value={query} onChange={event => { setQuery(event.target.value); setLimit(24); }} placeholder="Search files" /></label><span>{folders.length} folders · {files.length} files</span></div>{folders.length > 0 && !normalized && <div className={styles.folderStrip} aria-label="Course folders">{folders.slice(0, 8).map((folder, index) => <div className={styles.folder} key={id(folder, index)}><span aria-hidden="true">⌑</span><strong>{text(folder.name ?? folder.fullName, "Folder")}</strong><small>{Number(folder.filesCount ?? 0)} files</small></div>)}</div>}{visibleFiles.length ? <div className={styles.resourceFrame}><div className={styles.resourceList}>{visibleFiles.slice(0, limit).map((file, index) => <FileRow key={id(file, index)} file={file} />)}</div>{visibleFiles.length > limit && <button className={styles.loadMore} onClick={() => setLimit(value => value + 24)}>Show more files</button>}</div> : <State title={normalized ? "No matching files" : "No files yet"} body={normalized ? "Try a shorter or different search." : "Published files will appear after the next successful sync."} />}</>;
}

function FileRow({ file }: { file: Item }) {
  const timeZone = useContext(TimeZoneContext);
  const href = safeInternal(file.downloadPath) || safeUrl(file.canvasUrl);
  return <article className={styles.resourceRow}><span className={styles.fileType} aria-hidden="true">{fileExtension(text(file.displayName, ""))}</span><span className={styles.itemMain}><strong>{text(file.displayName, "Untitled file")}</strong><small>{[text(file.contentType, ""), fileSize(file.size), formatDate(file.updatedAt, timeZone)].filter(Boolean).join(" · ")}</small></span>{href && (href.startsWith("/") ? <a className={styles.download} href={href}>Download</a> : <a className={styles.download} href={href} target="_blank" rel="noopener noreferrer">Open</a>)}</article>;
}

function Syllabus({ data }: { data: Record<string, unknown> }) {
  const schedule = array(data.calendar), content = syllabusText(text(data.html ?? data.bodyHtml, ""));
  return <><SectionHead title="Syllabus" description="Course policies and the synced schedule" /><div className={styles.syllabusGrid}><article className={styles.document}>{content ? content.split(/\n{2,}/).map((paragraph, index) => <p key={index}>{paragraph}</p>) : <InlineEmpty>No syllabus text has synced yet.</InlineEmpty>}</article><aside className={styles.schedule}><h3>Course schedule</h3>{schedule.length ? <div>{schedule.slice(0, 14).map((item, index) => <ResourceRow key={id(item, index)} item={item} compact />)}</div> : <InlineEmpty>No schedule entries are cached.</InlineEmpty>}</aside></div></>;
}

function Modules({ items }: { items: Item[] }) {
  return <><SectionHead title="Modules" description="Course content in instructor-defined order" count={items.length} />{items.length ? <div className={styles.modules}>{items.map((module, index) => <details className={styles.module} key={id(module, index)} open={index === 0}><summary><span><small>Module {index + 1}</small><strong>{text(module.name, "Untitled module")}</strong></span><span>{array(module.items).length} items <b aria-hidden="true">⌄</b></span></summary><div className={styles.moduleItems}>{array(module.items).map((item, itemIndex) => <ResourceRow key={id(item, itemIndex)} item={item} compact />)}</div></details>)}</div> : <State title="No modules yet" body="Published modules will appear after the next successful sync." />}</>;
}

function Pages({ items }: { items: Item[] }) {
  const timeZone = useContext(TimeZoneContext);
  const [open, setOpen] = useState<string | null>(null);
  return <><SectionHead title="Pages" description="Published course reference pages" count={items.length} />{items.length ? <div className={styles.pages}>{items.map((page, index) => { const key = String(page.slug ?? page.id ?? index), expanded = open === key; return <article id={encodeURIComponent(key)} key={key} className={styles.pageItem}><button aria-expanded={expanded} onClick={() => setOpen(expanded ? null : key)}><span><strong>{text(page.title, "Untitled page")}</strong><small>{formatDate(page.updatedAt, timeZone) || "Published page"}</small></span><span aria-hidden="true">{expanded ? "−" : "+"}</span></button>{expanded && <div><p>{plain(text(page.html, "No page text is cached.")).slice(0, 2200)}</p>{safeUrl(page.canvasUrl) && <a href={safeUrl(page.canvasUrl)!} target="_blank" rel="noopener noreferrer">Open full page in Canvas ↗</a>}</div>}</article>; })}</div> : <State title="No pages yet" body="Published pages will appear after the next successful sync." />}</>;
}

function CourseGrades({ courseId }: { courseId: string }) {
  return <GradesWorkspace courseId={courseId} embedded />;
}

function SectionHead({ title, description, count, href, hrefLabel = "View all" }: { title: string; description: string; count?: number; href?: string; hrefLabel?: string }) { return <div className={styles.sectionHead}><div><div className={styles.headingLine}><h2>{title}</h2>{count != null && <span>{count}</span>}</div>{description && <p>{description}</p>}</div>{href && <Link href={href}>{hrefLabel} <span aria-hidden="true">→</span></Link>}</div>; }
function Freshness({ value, stale }: { value: string | null; stale: boolean }) { const timeZone = useContext(TimeZoneContext); return <span className={`${styles.freshness} ${stale ? styles.stale : ""}`} title={value ? formatInstant(value, timeZone) : "Not synced yet"}><i aria-hidden="true" />{value ? `${stale ? "Last synced" : "Updated"} ${relative(value, timeZone)}` : "Waiting for sync"}</span>; }
function SectionSkeleton() { return <div className={styles.skeleton} role="status"><span className="sr-only">Loading saved course data</span><i /><i /><i /><i /></div>; }
function State({ title, body, tone, children }: { title: string; body: string; tone?: "error"; children?: React.ReactNode }) { return <div className={`${styles.state} ${tone === "error" ? styles.error : ""}`} role={tone === "error" ? "alert" : undefined}><span className={styles.stateGlyph} aria-hidden="true">{tone === "error" ? "!" : "·"}</span><strong>{title}</strong><p>{body}</p>{children}</div>; }
function InlineEmpty({ children }: { children: React.ReactNode }) { return <p className={styles.inlineEmpty}>{children}</p>; }

function buildNavigation(courseId: string, tabs: Tab[]) { const native = new Map<CourseSection, { section: CourseSection; label: string; href: string }>(); for (const tab of tabs) { const section = sectionFromTab(tab); if (section && !native.has(section)) native.set(section, { section, label: sectionLabels[section], href: section === "overview" ? `/courses/${courseId}` : `/courses/${courseId}/${section}` }); } if (!native.has("overview")) native.set("overview", { section: "overview", label: "Overview", href: `/courses/${courseId}` }); return sectionOrder.filter(section => native.has(section)).map(section => native.get(section)!); }
function sectionFromTab(tab: Tab): CourseSection | null { if (tab.id === "home") return "overview"; const suffix = tab.nativePath?.split("/").filter(Boolean).at(-1); const value = suffix === "overview" || tab.id === "overview" ? "overview" : suffix ?? tab.id; return sectionOrder.includes(value as CourseSection) ? value as CourseSection : null; }
function array(value: unknown): Item[] { return Array.isArray(value) ? value as Item[] : []; }
function id(item: Item, index: number) { return String(item.id ?? item.slug ?? item.canvasId ?? index); }
function text(value: unknown, fallback: string) { return typeof value === "string" && value.trim() ? value.trim() : fallback; }
function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function label(value: unknown) { return typeof value === "string" ? value.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase()) : ""; }
function plain(value: string) { return value.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, " ").trim(); }
function syllabusText(value: string) { return value.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<\/?(p|div|h[1-6]|ul|ol|li|table|tr|blockquote)[^>]*>/gi, "\n\n").replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;/gi, "'").replace(/&quot;/gi, '"').replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim(); }
function safeInternal(value: unknown) { return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : null; }
function safeUrl(value: unknown) { try { const url = new URL(String(value)); return url.protocol === "https:" ? url.toString() : null; } catch { return null; } }
function formatDate(value: unknown, zone: string) { return value ? formatInstant(String(value), zone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""; }
function relative(value: string, zone: string) { const delta = Math.max(0, Date.now() - new Date(value).getTime()); if (delta < 60_000) return "just now"; if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`; if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`; return formatDate(value, zone); }
function points(value: unknown) { const parsed = number(value); return parsed == null ? "" : `${parsed} ${parsed === 1 ? "point" : "points"}`; }
function fileSize(value: unknown) { const size = number(value); if (size == null) return ""; if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(1)} MB`; return `${Math.max(1, Math.round(size / 1_000))} KB`; }
function fileExtension(name: string) { const extension = name.split(".").at(-1); return extension && extension !== name ? extension.slice(0, 4).toUpperCase() : "FILE"; }
function glyph(item: Item) { const kind = String(item.type ?? item.kind ?? "").toLowerCase(); if (kind.includes("announcement")) return "A"; if (kind.includes("quiz")) return "Q"; if (kind.includes("page")) return "P"; if (kind.includes("file")) return "F"; return "•"; }
function initials(value: string) { const parts = value.replace(/[^a-zA-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean); return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : value.slice(0, 2)).toUpperCase(); }
