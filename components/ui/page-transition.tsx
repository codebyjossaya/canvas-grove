import { ViewTransition, type ReactNode } from "react";

// Route-level motion built on React's <ViewTransition> (browser View Transitions API).
// Navigations are React transitions, so these animate automatically; browsers without
// support simply swap content. Styles live in app/motion.css.
//
// Tag a link with one of these to give the slide a direction: deeper in the hierarchy
// (list -> course -> assignment) is forward, breadcrumbs back up are back.
export const NAV_FORWARD = ["nav-forward"];
export const NAV_BACK = ["nav-back"];

const enter = { "nav-forward": "nav-forward", "nav-back": "nav-back", default: "page-in" };
const exit = { "nav-forward": "nav-forward", "nav-back": "nav-back", default: "page-out" };

/**
 * Wrap a page's content *inside* its Suspense boundary, so the content animates in both when a
 * navigation commits and when streamed data replaces the skeleton. Put it in pages, not
 * layouts: layouts persist across navigations, so enter/exit never fire there.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  return <ViewTransition enter={enter} exit={exit} default="none">{children}</ViewTransition>;
}

/** Loading placeholders fade in softly and get out of the way fast when content arrives. */
export function SkeletonTransition({ children }: { children: ReactNode }) {
  return <ViewTransition enter="skeleton-in" exit="skeleton-out" default="none">{children}</ViewTransition>;
}

/**
 * A shared "you are here" marker. Only the active item renders it, so when the active item
 * changes during a navigation the browser morphs the marker from the old spot to the new one.
 * Each `name` must be rendered at most once on screen.
 */
export function ActiveMarker({ name, className }: { name: string; className: string }) {
  return <ViewTransition name={name} share="marker" default="none"><i className={className} aria-hidden="true" /></ViewTransition>;
}
