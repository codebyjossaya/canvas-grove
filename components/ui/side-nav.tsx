"use client";

import { usePathname } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AppLink, stripBase, useNavBase } from "./app-link";
import { Icon } from "./icons";
import type { SidebarCourse } from "@/lib/views/types";
import { ActiveMarker } from "./page-transition";
import { ApprovalsBadge } from "@/components/workspace/approvals/approvals-badge";

export const primaryLinks = [
  { href: "/", icon: "today", label: "Today", key: "t" },
  { href: "/planner", icon: "calendar", label: "Planner", key: "p" },
  { href: "/courses", icon: "book", label: "Courses", key: "c" },
  { href: "/inbox", icon: "inbox", label: "Inbox", key: "i" },
  { href: "/quizzes", icon: "quiz", label: "Quizzes", key: "q" },
] as const;

// Course grade pages live inside each course, so /grades highlights Courses.
export function activeHref(pathname: string) {
  if (pathname === "/") return "/";
  if (pathname.startsWith("/grades")) return "/courses";
  if (pathname.startsWith("/settings")) return "/settings";
  if (pathname.startsWith("/approvals")) return "/approvals";
  return primaryLinks.find(link => link.href !== "/" && (pathname === link.href || pathname.startsWith(`${link.href}/`)))?.href ?? null;
}

function useActive() {
  const base = useNavBase();
  return stripBase(base, usePathname() ?? "/");
}

// usePathname() is request data on dynamic routes, so it sits behind Suspense. The fallback is
// the same nav without the active marker, which keeps the static shell layout identical.
export function SideNav() {
  return <Suspense fallback={<NavLinks active={null} />}><ActiveNav /></Suspense>;
}
function ActiveNav() { return <NavLinks active={activeHref(useActive())} />; }

function NavLinks({ active }: { active: string | null }) {
  return <nav className="side-nav" aria-label="Workspace">
    {primaryLinks.map(item => <AppLink key={item.href} href={item.href} aria-current={active === item.href ? "page" : undefined}>{active === item.href && <ActiveMarker name="nav-pill" className="nav-pill" />}<Icon name={item.icon} /><span>{item.label}</span><span className="hint" aria-hidden="true"><kbd className="kbd">G</kbd> <kbd className="kbd">{item.key.toUpperCase()}</kbd></span></AppLink>)}
  </nav>;
}

export function SettingsLink() {
  return <Suspense fallback={<SettingsAnchor active={false} />}><ApprovalsAnchor /><ActiveSettings /></Suspense>;
}
function ApprovalsAnchor() {
  const active = useActive().startsWith("/approvals");
  return <AppLink className="sidebar-link" href="/approvals" aria-current={active ? "page" : undefined}>{active && <ActiveMarker name="nav-pill" className="nav-pill" />}<Icon name="check" /><span>Approvals</span><ApprovalsBadge /></AppLink>;
}
function ActiveSettings() { return <SettingsAnchor active={useActive().startsWith("/settings")} />; }
function SettingsAnchor({ active }: { active: boolean }) {
  return <AppLink className="sidebar-link" href="/settings" aria-current={active ? "page" : undefined}>{active && <ActiveMarker name="nav-pill" className="nav-pill" />}<Icon name="settings" /><span>Settings</span></AppLink>;
}

export function SidebarCourseList({ courses }: { courses: SidebarCourse[] }) {
  return <Suspense fallback={<CourseLinks courses={courses} active={null} />}><ActiveCourses courses={courses} /></Suspense>;
}
function ActiveCourses({ courses }: { courses: SidebarCourse[] }) {
  const match = useActive().match(/^\/courses\/([^/]+)/);
  return <CourseLinks courses={courses} active={match?.[1] ?? null} />;
}
function CourseLinks({ courses, active }: { courses: SidebarCourse[]; active: string | null }) {
  if (!courses.length) return null;
  return <div className="sidebar-section" aria-label="Your courses">
    <p><span>Courses</span><AppLink href="/courses">All</AppLink></p>
    {courses.map(course => <AppLink key={course.id} className={`sidebar-course c${course.color}`} href={`/courses/${course.id}`} aria-current={active === course.id ? "page" : undefined} title={course.name}>{active === course.id && <ActiveMarker name="course-pill" className="nav-pill" />}<span className="course-dot" aria-hidden="true" /><span>{course.code}<span className="sr-only">, {course.name}</span></span></AppLink>)}
  </div>;
}

const tabs = [primaryLinks[0], primaryLinks[1], primaryLinks[2], primaryLinks[3]];

/** Phone navigation: four destinations plus a More sheet for Quizzes, Grades and Settings. */
export function TabBar() {
  return <Suspense fallback={<Tabs active={null} />}><ActiveTabs /></Suspense>;
}
function ActiveTabs() { return <Tabs active={activeHref(useActive())} />; }
function Tabs({ active }: { active: string | null }) {
  const [open, setOpen] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const moreSheet = useRef<HTMLElement>(null);
  function closeMore(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => moreButton.current?.focus());
  }
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => moreSheet.current?.querySelector<HTMLElement>("a,button")?.focus());
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); closeMore(true); } };
    document.addEventListener("keydown", onKey);
    return () => { window.cancelAnimationFrame(frame); document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", onKey); };
  }, [open]);
  function trapSheetFocus(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") return;
    const controls = [...(moreSheet.current?.querySelectorAll<HTMLElement>("a,button") ?? [])];
    if (!controls.length) return;
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  const moreActive = active === "/quizzes" || active === "/settings" || active === "/approvals";
  return <>
    <nav className="tabbar" aria-label="Primary">
      {tabs.map(item => <AppLink key={item.href} href={item.href} aria-current={active === item.href ? "page" : undefined} onClick={() => setOpen(false)}>{active === item.href && <ActiveMarker name="tab-pill" className="tab-pill" />}<Icon name={item.icon} /><span>{item.label}</span></AppLink>)}
      <button ref={moreButton} type="button" aria-expanded={open} aria-haspopup="true" aria-controls="more-sheet" aria-current={moreActive && !open ? "page" : undefined} onClick={() => setOpen(value => !value)}>{moreActive && <ActiveMarker name="tab-pill" className="tab-pill" />}<Icon name="more" /><span>More</span></button>
    </nav>
    {open && <>
      <button type="button" tabIndex={-1} className="sheet-scrim" aria-label="Close menu" onClick={() => closeMore(true)} />
      <nav ref={moreSheet} className="more-sheet" id="more-sheet" aria-label="More destinations" onKeyDown={trapSheetFocus}>
        <AppLink href="/quizzes" onClick={() => closeMore()}><Icon name="quiz" />Quizzes</AppLink>
        <AppLink href="/grades" onClick={() => closeMore()}><Icon name="grade" />Course grades</AppLink>
        <AppLink href="/approvals" onClick={() => closeMore()}><Icon name="check" />Approvals<ApprovalsBadge /></AppLink>
        <AppLink href="/settings" onClick={() => closeMore()}><Icon name="settings" />Settings</AppLink>
      </nav>
    </>}
  </>;
}
