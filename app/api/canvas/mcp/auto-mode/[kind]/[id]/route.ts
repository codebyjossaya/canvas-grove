import { fail, reply, requireWebUser } from "@/lib/extension/http";
import { parseAutoInput, setAutoMode } from "@/lib/mcp/auto-mode";

export const instant = false;

/** Turn auto mode on/off for one connection. Turning it off cancels that connection's awaiting actions. */
export async function PUT(request: Request, context: { params: Promise<{ kind: string; id: string }> }) {
  const ctx = await requireWebUser(request);
  if (ctx instanceof Response) return ctx;
  const { kind, id } = await context.params;
  if ((kind !== "token" && kind !== "grant") || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return fail(400, "BAD_TARGET", "Invalid connection");
  const parsed = parseAutoInput(await request.json().catch(() => null));
  if (!parsed.ok) return fail(400, parsed.code, parsed.error);
  const result = await setAutoMode(ctx, kind, id, parsed.value);
  if (result.kind === "not_found") return fail(404, "NOT_FOUND", "That connection does not exist or was revoked.");
  if (result.kind === "cannot_propose") return fail(409, "CANNOT_PROPOSE", "This connection is read-only. Create a token with \"Allow proposing actions\" or reconnect the app with that option.");
  return reply({ target: result.target });
}
