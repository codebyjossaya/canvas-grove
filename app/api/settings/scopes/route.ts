import { fail, reply, requireWebUser } from "@/lib/extension/http";
import { parseScopeSettingsBody } from "@/lib/scopes/settings";
import { getScopeSettings, saveScopeSettings } from "@/lib/scopes/store";

export const instant = false;

const MAX_BODY_BYTES = 4_096;

/** The signed-in user's data scopes and agent defaults (ScopeSettings). Clerk + CSRF header only. */
export async function GET(request: Request) {
  const ctx = await requireWebUser(request);
  if (ctx instanceof Response) return ctx;
  try {
    return reply(await getScopeSettings(ctx.ownerId));
  } catch {
    return fail(503, "SCOPES_UNAVAILABLE", "Grove could not load your data settings. Try again in a moment.");
  }
}

/** Replace the scope settings. `courses` is always kept on; returns the saved ScopeSettings. */
export async function PUT(request: Request) {
  const ctx = await requireWebUser(request);
  if (ctx instanceof Response) return ctx;
  const text = await request.text().catch(() => null);
  if (text == null || text.length > MAX_BODY_BYTES) return fail(400, "BAD_REQUEST", "Invalid request.");
  let body: unknown;
  try { body = JSON.parse(text); } catch { return fail(400, "BAD_REQUEST", "Invalid request."); }
  const parsed = parseScopeSettingsBody(body);
  if (!parsed.ok) return fail(400, "INVALID_SCOPES", parsed.error);
  try {
    return reply(await saveScopeSettings(ctx.ownerId, parsed.value));
  } catch {
    return fail(503, "SCOPES_SAVE_FAILED", "Grove could not save your data settings. Your previous settings are unchanged.");
  }
}
