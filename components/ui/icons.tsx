import type { ReactNode, SVGProps } from "react";

// One stroke icon set (24px grid, 1.75 stroke) so every glyph matches the type weight.
const paths: Record<string, ReactNode> = {
  home: <><path d="M4 10.5 12 4l8 6.5"/><path d="M6 9.5V20h12V9.5"/></>,
  today: <><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M16 3v4M8 3v4M3.5 10h17"/></>,
  book: <><path d="M5 4.5h10.5A3.5 3.5 0 0 1 19 8v11.5H8.5A3.5 3.5 0 0 1 5 16Z"/><path d="M5 16a3.5 3.5 0 0 1 3.5-3.5H19"/></>,
  inbox: <><path d="M4 13.5 6.2 6A2 2 0 0 1 8.1 4.5h7.8a2 2 0 0 1 1.9 1.5l2.2 7.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20"/></>,
  chart: <path d="M5 20V11M11 20V5M17 20v-6M3 20h18"/>,
  grade: <><path d="M19 5 5 19"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/></>,
  settings: <><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/></>,
  search: <><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></>,
  bell: <path d="M18 9a6 6 0 0 0-12 0c0 6.5-2.5 7.5-2.5 8.5h17c0-1-2.5-2-2.5-8.5M10 21h4"/>,
  arrow: <path d="M5 12h14M13 6l6 6-6 6"/>,
  "arrow-left": <path d="M19 12H5M11 6l-6 6 6 6"/>,
  external: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></>,
  check: <path d="m5 12.5 4.5 4.5L19 7"/>,
  "check-circle": <><circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.3 2.4 2.4 4.6-5"/></>,
  circle: <circle cx="12" cy="12" r="8"/>,
  "circle-dash": <><circle cx="12" cy="12" r="8" strokeDasharray="3.2 2.6"/></>,
  alert: <><circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v5M12 16.2v.01"/></>,
  clock: <><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></>,
  wifi: <><path d="M4.5 12a11 11 0 0 1 15 0M8 15.5a6 6 0 0 1 8 0"/><circle cx="12" cy="19" r=".8" fill="currentColor"/></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16"/><path d="M20 20v-4h-4"/></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>,
  sun: <><circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
  quiz: <><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.3 2.3 4.7-4.8"/></>,
  file: <><path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8Z"/><path d="M14 3.5V8h4.5"/></>,
  page: <><rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></>,
  layers: <><path d="m12 4 8.5 4.5L12 13 3.5 8.5Z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5"/><path d="m3.5 16.5 8.5 4.5 8.5-4.5" opacity=".55"/></>,
  megaphone: <><path d="M4 10v4a1 1 0 0 0 1 1h2l8 4V5L7 9H5a1 1 0 0 0-1 1Z"/><path d="M18.5 9.5a3.5 3.5 0 0 1 0 5"/></>,
  mail: <><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/></>,
  star: <path d="m12 4 2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6Z"/>,
  x: <path d="M6 6l12 12M18 6 6 18"/>,
  plus: <path d="M12 5v14M5 12h14"/>,
  more: <><circle cx="6" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18" cy="12" r="1.2" fill="currentColor"/></>,
  "chevron-right": <path d="m10 6 6 6-6 6"/>,
  "chevron-left": <path d="m14 6-6 6 6 6"/>,
  "chevron-down": <path d="m6 10 6 6 6-6"/>,
  list: <path d="M8.5 6.5H20M8.5 12H20M8.5 17.5H20M4 6.5h.01M4 12h.01M4 17.5h.01"/>,
  columns: <><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.2 4.5v15M14.8 4.5v15"/></>,
  discussion: <><path d="M5 5.5h11a2 2 0 0 1 2 2V13a2 2 0 0 1-2 2H10l-4 3.5V15H5a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2Z"/></>,
  event: <><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M16 3v4M8 3v4M3.5 10h17"/><circle cx="12" cy="15" r="1.4" fill="currentColor"/></>,
  note: <><path d="M5 4.5h14v10l-5 5H5Z"/><path d="M14 19.5v-5h5"/></>,
  assignment: <><path d="M8 4.5h8M9 3h6v3H9z"/><rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 11h6M9 15h4"/></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></>,
  flag: <path d="M5 21V4.5h11.5l-2 4 2 4H5"/>,
  command: <path d="M9 6.5a2.5 2.5 0 1 0-2.5 2.5H9Zm0 0V17.5m0-8.5h6M9 17.5a2.5 2.5 0 1 1-2.5-2.5H9Zm6-11a2.5 2.5 0 1 1 2.5 2.5H15Zm0 0V17.5m0 0a2.5 2.5 0 1 0 2.5-2.5H15m0 0H9"/>,
};

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: string }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>{paths[name] ?? paths.circle}</svg>;
}

export function GroveMark() { return <span className="grove-mark" aria-hidden="true"><i/><i/><i/></span>; }
