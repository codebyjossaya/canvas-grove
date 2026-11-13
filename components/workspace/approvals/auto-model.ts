// Pure auto-mode helpers. No React. Contract: docs/MCP_CONTRACT_PHASE2.md.
import { CATEGORIES, DAILY_CAP, HOURLY_CAP } from "./model";

export type AutoState = { enabled: boolean; categories: string[]; expiresAt: string | null; usedLastHour: number; usedToday: number };
export type AutoTarget = { kind: "token" | "grant"; id: string; name: string; canPropose: boolean; auto: AutoState };
export type DurationMinutes = 60 | 480 | 1440 | null;
export const DURATIONS: ReadonlyArray<{ minutes: DurationMinutes; label: string }> = [
  { minutes: 60, label: "1 hour" }, { minutes: 480, label: "8 hours" }, { minutes: 1440, label: "24 hours" }, { minutes: null, label: "Until I turn it off" },
];

export function autoActive(auto: AutoState, now: number): boolean {
  return auto.enabled && (auto.expiresAt === null || new Date(auto.expiresAt).getTime() > now);
}
export type CapState = { hourly: boolean; daily: boolean; any: boolean };
export function capState(auto: AutoState): CapState {
  const hourly = auto.usedLastHour >= HOURLY_CAP, daily = auto.usedToday >= DAILY_CAP;
  return { hourly, daily, any: hourly || daily };
}
export function expiringSoon(auto: AutoState, now: number): boolean {
  return auto.expiresAt !== null && new Date(auto.expiresAt).getTime() - now < 10 * 60_000;
}
export function durationLabel(minutes: DurationMinutes): string {
  return DURATIONS.find(duration => duration.minutes === minutes)?.label ?? "Until I turn it off";
}
export function canEnable(categories: string[]): boolean { return categories.length > 0; }

/** The plain-words confirmation shown before auto mode is switched on. */
export function confirmationLines(assistant: string, categories: string[], minutes: DurationMinutes): { intro: string; does: string[]; limits: string[] } {
  const does = CATEGORIES.filter(category => categories.includes(category.id)).map(category => category.does);
  return {
    intro: `While auto mode is on, ${assistant} can do these things without asking you first:`,
    does,
    limits: [
      minutes === null ? "It stays on until you turn it off." : `It turns itself off after ${durationLabel(minutes)}.`,
      `At most ${HOURLY_CAP} actions per hour and ${DAILY_CAP} per day; after that, actions wait for your approval again.`,
      "Quiz auto mode includes graded quizzes and graded surveys; starting or submitting one may affect your course grade.",
      "You can turn it off at any time. Turning it off also cancels anything still waiting.",
    ],
  };
}
