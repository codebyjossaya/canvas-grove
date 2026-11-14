import { customEventId, customEventInput, firstIssue } from "@/lib/custom-events/contract";
import { deleteCustomEvent, UnknownCourseError, updateCustomEvent } from "@/lib/custom-events/store";
import { fail, reply, requireWebUser } from "@/lib/extension/http";

export const instant = false;

type Context = { params: Promise<{ eventId: string }> };

/** Replace one of the student's own events (full body, same shape as create). */
export async function PUT(request: Request, context: Context) {
  const ctx = await requireWebUser(request);
  if (ctx instanceof Response) return ctx;
  const { eventId } = await context.params;
  if (!customEventId.safeParse(eventId).success) return fail(400, "BAD_ID", "Invalid event");
  const parsed = customEventInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(400, "BAD_EVENT", firstIssue(parsed.error));
  try {
    const event = await updateCustomEvent(ctx.ownerId, eventId, parsed.data);
    return event ? reply({ event }) : fail(404, "NOT_FOUND", "That event no longer exists.");
  } catch (error) {
    if (error instanceof UnknownCourseError) return fail(400, "BAD_COURSE", error.message);
    return fail(500, "SAVE_FAILED", "Could not save this event.");
  }
}

export async function DELETE(request: Request, context: Context) {
  const ctx = await requireWebUser(request);
  if (ctx instanceof Response) return ctx;
  const { eventId } = await context.params;
  if (!customEventId.safeParse(eventId).success) return fail(400, "BAD_ID", "Invalid event");
  return (await deleteCustomEvent(ctx.ownerId, eventId)) ? reply({ ok: true }) : fail(404, "NOT_FOUND", "That event no longer exists.");
}
