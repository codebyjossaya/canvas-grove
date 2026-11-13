import { reply, requireWebUser } from "@/lib/extension/http";
import { listAutoTargets } from "@/lib/mcp/auto-mode";

export const instant = false;

/** Per-connection auto-mode state. Clerk + CSRF only; tokens can never read or change it. */
export async function GET(request: Request) {
  const ctx = await requireWebUser(request);
  if (ctx instanceof Response) return ctx;
  return reply({ targets: await listAutoTargets(ctx) });
}
