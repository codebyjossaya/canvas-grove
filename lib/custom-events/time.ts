import { dateFormatter, localDateKey, resolveTimeZone } from "@/lib/time";

// Client-safe conversions between the planner's display zone and UTC instants, for the event form.
// The form edits wall-clock date + time in the student's planner zone (not the device zone), so what
// they type matches what the planner shows.

function zoneOffsetMs(instant: number, zone: string) {
  const parts = dateFormatter("en-US", { timeZone: resolveTimeZone(zone), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second")) - Math.floor(instant / 1000) * 1000;
}

/** "2026-11-12" + "14:30" in `zone` -> ISO instant. Nonexistent DST times resolve forward. */
export function zonedIso(key: string, time: string, zone: string): string | null {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key), clock = /^(\d{2}):(\d{2})$/.exec(time);
  if (!date || !clock) return null;
  const wall = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]), Number(clock[1]), Number(clock[2]));
  if (!Number.isFinite(wall)) return null;
  let guess = wall - zoneOffsetMs(wall, zone);
  guess = wall - zoneOffsetMs(guess, zone);
  return new Date(guess).toISOString();
}

/** ISO instant -> { date: "YYYY-MM-DD", time: "HH:MM" } in `zone`. */
export function zonedParts(value: string, zone: string): { date: string; time: string } {
  const parts = dateFormatter("en-US", { timeZone: resolveTimeZone(zone), hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(value));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? "00";
  return { date: localDateKey(value, zone), time: `${get("hour").padStart(2, "0").replace(/^24$/, "00")}:${get("minute")}` };
}
