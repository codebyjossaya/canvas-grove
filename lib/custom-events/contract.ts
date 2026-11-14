import { z } from "zod";

// Request contract for /api/custom-events. Custom events are Grove-only: these shapes never reach
// Canvas, and the sync worker never reads or writes the custom_events table.

export const CUSTOM_EVENT_MAX_DAYS = 31;
export const CUSTOM_EVENT_RANGE_MAX_DAYS = 120;
const DAY_MS = 86_400_000;

const dateKey = z.iso.date();
const base = {
  title: z.string().trim().min(1, "Give the event a title.").max(200),
  notes: z.string().trim().max(2000).nullish().transform(value => value || null),
  courseId: z.uuid().nullish().transform(value => value ?? null),
  color: z.number().int().min(0).max(7).default(0),
};

const timed = z.strictObject({ ...base, allDay: z.literal(false), startsAt: z.iso.datetime({ offset: true }), endsAt: z.iso.datetime({ offset: true }) })
  .refine(value => Date.parse(value.endsAt) >= Date.parse(value.startsAt), { message: "The event ends before it starts.", path: ["endsAt"] })
  .refine(value => Date.parse(value.endsAt) - Date.parse(value.startsAt) <= CUSTOM_EVENT_MAX_DAYS * DAY_MS, { message: `Events can span at most ${CUSTOM_EVENT_MAX_DAYS} days.`, path: ["endsAt"] });
const allDay = z.strictObject({ ...base, allDay: z.literal(true), startDate: dateKey, endDate: dateKey })
  .refine(value => value.endDate >= value.startDate, { message: "The event ends before it starts.", path: ["endDate"] })
  .refine(value => Date.parse(value.endDate) - Date.parse(value.startDate) <= CUSTOM_EVENT_MAX_DAYS * DAY_MS, { message: `Events can span at most ${CUSTOM_EVENT_MAX_DAYS} days.`, path: ["endDate"] });

/** Create and update share one full-replacement body. */
export const customEventInput = z.discriminatedUnion("allDay", [timed, allDay]);
export type CustomEventInput = z.output<typeof customEventInput>;

/** List window: ISO instants, `from` <= `to`, at most CUSTOM_EVENT_RANGE_MAX_DAYS apart. */
export const customEventRange = z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
  .refine(value => Date.parse(value.to) >= Date.parse(value.from), { message: "`to` is before `from`.", path: ["to"] })
  .refine(value => Date.parse(value.to) - Date.parse(value.from) <= CUSTOM_EVENT_RANGE_MAX_DAYS * DAY_MS, { message: `Ranges can span at most ${CUSTOM_EVENT_RANGE_MAX_DAYS} days.`, path: ["to"] });

export const customEventId = z.uuid();

/** First validation message, for the `{ error, code }` reply shape the app routes use. */
export function firstIssue(error: z.ZodError) {
  return error.issues[0]?.message ?? "Invalid event.";
}
