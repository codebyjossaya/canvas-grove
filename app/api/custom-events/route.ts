import { customEventInput, customEventRange, firstIssue } from "@/lib/custom-events/contract";
import { createCustomEvent, listCustomEvents, UnknownCourseError } from "@/lib/custom-events/store";
import { fail, reply, requireWebUser } from "@/lib/extension/http";

export const instant = false;

/** The signed-in student's own events overlapping ?from=&to= (ISO instants). Grove-only, never Canvas. */
export async function GET(request: Request) {
  const ctx = await requireWebUser(request);
  if (ctx instanceof Response) return ctx;
  const params = new URL(request.url).searchParams;
  const range = customEventRange.safeParse({ from: params.get("from"), to: params.get("to") });
  if (!range.success) return fail(400, "BAD_RANGE", firstIssue(range.error));
  return reply({ events: await listCustomEvents(ctx.ownerId, new Date(range.data.from), new Date(range.data.to)) });
}

/** Create a custom event. Stored only in Grove; nothing is sent to Canvas. */
export async function POST(request: Request) {
  const ctx = await requireWebUser(request);
  if (ctx instanceof Response) return ctx;
  const parsed = customEventInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(400, "BAD_EVENT", firstIssue(parsed.error));
  try {
    return reply({ event: await createCustomEvent(ctx.ownerId, parsed.data) }, 201);
  } catch (error) {
    if (error instanceof UnknownCourseError) return fail(400, "BAD_COURSE", error.message);
    return fail(500, "SAVE_FAILED", "Could not save this event.");
  }
}
