import { fail, reply } from "@/lib/extension/http";
import type { DecisionOutcome } from "@/lib/mcp/actions";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function decisionResponse(outcome: DecisionOutcome): Response {
  if (outcome.kind === "not_found") return fail(404, "NOT_FOUND", "That action does not exist.");
  if (outcome.kind === "expired") return Response.json({ error: "This action expired before it was approved.", code: "ACTION_EXPIRED", action: outcome.action }, { status: 410, headers: { "cache-control": "no-store" } });
  if (outcome.kind === "conflict") return Response.json({ error: "This action is no longer awaiting approval.", code: "ACTION_NOT_AWAITING", action: outcome.action }, { status: 409, headers: { "cache-control": "no-store" } });
  return reply({ action: outcome.action });
}
