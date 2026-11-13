import { formatInstant, localDateKey } from "@/lib/time";
import type { Instant } from "./types";

// Calendar math on "YYYY-MM-DD" keys in the student's display time zone. Keys are converted to
// UTC noon only for weekday/label arithmetic, which is stable across DST transitions.

export function iso(value: Instant): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function ms(value: Instant) {
  const text = iso(value);
  return text ? new Date(text).getTime() : null;
}

export function dayKey(value: Instant, zone: string) {
  const text = iso(value);
  return text ? localDateKey(text, zone) : "";
}

function keyDate(key: string) { return new Date(`${key}T12:00:00.000Z`); }

export function addDays(key: string, days: number) {
  const date = keyDate(key);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function diffDays(later: string, earlier: string) {
  return Math.round((keyDate(later).getTime() - keyDate(earlier).getTime()) / 86_400_000);
}

export function keyWeekday(key: string) { return keyDate(key).getUTCDay(); }

export function weekStartKey(key: string, weekStartsOn = 0) {
  return addDays(key, -((keyWeekday(key) - weekStartsOn + 7) % 7));
}

export function formatKey(key: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(keyDate(key));
}

export function dayLabel(key: string, todayKey: string) {
  const delta = diffDays(key, todayKey);
  if (delta === 0) return "Today";
  if (delta === 1) return "Tomorrow";
  if (delta === -1) return "Yesterday";
  return formatKey(key, { weekday: "long" });
}

export function daySublabel(key: string) { return formatKey(key, { month: "short", day: "numeric" }); }

/** "November 8 – 14" or "Nov 29 – Dec 5" for the 7 days starting at `weekStart`. */
export function weekRangeLabel(weekStart: string) {
  const end = addDays(weekStart, 6);
  return weekStart.slice(0, 7) === end.slice(0, 7)
    ? `${formatKey(weekStart, { month: "long", day: "numeric" })} – ${formatKey(end, { day: "numeric" })}`
    : `${formatKey(weekStart, { month: "short", day: "numeric" })} – ${formatKey(end, { month: "short", day: "numeric" })}`;
}

/** First value of a search param that may arrive as a string, a repeated array, or be absent. */
export function firstParam(value: string | string[] | undefined | null) {
  return Array.isArray(value) ? value[0] : value ?? undefined;
}

export function isValidKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(keyDate(value).getTime()) && keyDate(value).toISOString().slice(0, 10) === value;
}

export function timeLabel(value: string | null, zone: string) {
  return value ? formatInstant(value, zone, { hour: "numeric", minute: "2-digit" }) : "";
}

export function shortDate(value: string | null, zone: string) {
  return value ? formatInstant(value, zone, { month: "short", day: "numeric" }) : "";
}

export function dateTime(value: string | null, zone: string) {
  return value ? formatInstant(value, zone, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
}

/** "Due 11:59 PM", "Due Thu 11:59 PM", "Due Nov 21". Relative to the day key it is grouped under. */
export function dueLabel(value: string | null, zone: string, nowIso: string) {
  if (!value) return "No due date";
  const today = dayKey(nowIso, zone), key = dayKey(value, zone), delta = diffDays(key, today);
  if (delta === 0) return timeLabel(value, zone);
  if (delta > 0 && delta < 7) return `${formatKey(key, { weekday: "short" })} ${timeLabel(value, zone)}`;
  return `${daySublabel(key)}, ${timeLabel(value, zone)}`;
}

export function relativePast(value: string | null, nowIso: string, zone: string) {
  if (!value) return "";
  const delta = Math.max(0, new Date(nowIso).getTime() - new Date(value).getTime());
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  const days = diffDays(dayKey(nowIso, zone), dayKey(value, zone));
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return shortDate(value, zone);
}

/** "3h left", "2 days late". Used next to overdue and near-term work. */
export function relativeDue(value: string | null, nowIso: string) {
  if (!value) return "";
  const delta = new Date(value).getTime() - new Date(nowIso).getTime();
  const abs = Math.abs(delta);
  const unit = abs < 3_600_000 ? `${Math.max(1, Math.round(abs / 60_000))}m` : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)}h` : `${Math.round(abs / 86_400_000)}d`;
  return delta >= 0 ? `in ${unit}` : `${unit} overdue`;
}
