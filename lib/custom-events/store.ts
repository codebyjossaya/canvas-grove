import "server-only";
import { and, asc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { withTenantTransaction } from "@/lib/db";
import { courses, customEvents } from "@/lib/db/schema";
import type { CustomEventRow } from "@/lib/views/types";
import type { CustomEventInput } from "./contract";

// Tenant-scoped CRUD for the student's own calendar events. Every query runs in
// withTenantTransaction (forced RLS on app.user_id) AND carries an explicit owner predicate.
// Grove-only: nothing here talks to Canvas, and the sync worker never touches custom_events.

export class UnknownCourseError extends Error {}

const columns = {
  id: customEvents.id, courseId: customEvents.courseId, title: customEvents.title, notes: customEvents.notes, allDay: customEvents.allDay,
  startsAt: customEvents.startsAt, endsAt: customEvents.endsAt, startDate: customEvents.startDate, endDate: customEvents.endDate, color: customEvents.color,
};

function values(input: CustomEventInput) {
  return input.allDay
    ? { title: input.title, notes: input.notes, courseId: input.courseId, color: input.color, allDay: true, startsAt: null, endsAt: null, startDate: input.startDate, endDate: input.endDate }
    : { title: input.title, notes: input.notes, courseId: input.courseId, color: input.color, allDay: false, startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt), startDate: null, endDate: null };
}

type Tx = Parameters<Parameters<typeof withTenantTransaction>[1]>[0];
async function assertOwnCourse(tx: Tx, ownerId: string, courseId: string | null) {
  if (!courseId) return;
  const [course] = await tx.select({ id: courses.id }).from(courses).where(and(eq(courses.ownerId, ownerId), eq(courses.id, courseId), isNull(courses.deletedAt))).limit(1);
  if (!course) throw new UnknownCourseError("That course isn't in your Grove.");
}

/** Events overlapping [from, to]. All-day events compare by UTC date, padded a day each side for zones. */
export async function listCustomEvents(ownerId: string, from: Date, to: Date): Promise<CustomEventRow[]> {
  const fromDay = new Date(from.getTime() - 86_400_000).toISOString().slice(0, 10), toDay = new Date(to.getTime() + 86_400_000).toISOString().slice(0, 10);
  return withTenantTransaction(ownerId, tx => tx.select(columns).from(customEvents).where(and(
    eq(customEvents.ownerId, ownerId),
    or(
      and(eq(customEvents.allDay, false), lte(customEvents.startsAt, to), gte(customEvents.endsAt, from)),
      and(eq(customEvents.allDay, true), lte(customEvents.startDate, toDay), gte(customEvents.endDate, fromDay)),
    ),
  )).orderBy(asc(customEvents.startDate), asc(customEvents.startsAt)).limit(500));
}

export async function createCustomEvent(ownerId: string, input: CustomEventInput): Promise<CustomEventRow> {
  return withTenantTransaction(ownerId, async tx => {
    await assertOwnCourse(tx, ownerId, input.courseId);
    const [row] = await tx.insert(customEvents).values({ ownerId, ...values(input) }).returning(columns);
    return row;
  });
}

/** Full replacement. Null when the event does not exist for this owner. */
export async function updateCustomEvent(ownerId: string, id: string, input: CustomEventInput): Promise<CustomEventRow | null> {
  return withTenantTransaction(ownerId, async tx => {
    await assertOwnCourse(tx, ownerId, input.courseId);
    const [row] = await tx.update(customEvents).set({ ...values(input), updatedAt: sql`now()` })
      .where(and(eq(customEvents.ownerId, ownerId), eq(customEvents.id, id))).returning(columns);
    return row ?? null;
  });
}

export async function deleteCustomEvent(ownerId: string, id: string): Promise<boolean> {
  return withTenantTransaction(ownerId, async tx => {
    const rows = await tx.delete(customEvents).where(and(eq(customEvents.ownerId, ownerId), eq(customEvents.id, id))).returning({ id: customEvents.id });
    return rows.length > 0;
  });
}
