"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { redirectWith, validateAuthorizeRequest, verifyConsentToken } from "@/lib/mcp/authorize";
import { grantedScopes } from "@/lib/mcp/oauth-policy";
import { MCP_LIMITS, limit } from "@/lib/mcp/limits";
import { publicOrigin } from "@/lib/mcp/origin";
import { createAuthorizationCode } from "@/lib/mcp/store";

/**
 * Consent decision (POST /oauth/authorize, as a Server Action). CSRF defences: Next's own
 * Origin/Host check for Server Actions, an explicit Origin check here, and an HMAC token bound
 * to this Clerk user and the exact request (10-minute lifetime).
 */
export async function decideConsent(form: FormData): Promise<void> {
  const h = await headers();
  const origin = publicOrigin(h, null);
  const sentOrigin = h.get("origin");
  if (!origin || !sentOrigin || sentOrigin !== origin) throw new Error("Request not allowed");
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");
  const allowed = limit(MCP_LIMITS.consent, userId);
  if (!allowed.allowed) throw new Error("Too many attempts");
  const fields: Record<string, string> = {};
  for (const [key, value] of form.entries()) if (typeof value === "string" && !key.startsWith("$")) fields[key] = value;
  const checked = await validateAuthorizeRequest(fields, origin);
  if (checked.kind === "fatal") throw new Error("Invalid authorization request");
  if (checked.kind === "redirect") redirect(checked.url);
  if (!verifyConsentToken(fields.csrf, userId, checked.request)) throw new Error("This consent page expired. Reload it and try again.");
  const { request } = checked;
  if (fields.decision !== "approve") redirect(redirectWith(request.redirectUri, { error: "access_denied", error_description: "The user denied access.", state: request.state, iss: origin }));
  const ctx = await ensureUserForClerk(userId);
  const code = await createAuthorizationCode(ctx.ownerId, { ...request, scopes: grantedScopes(request.offerWrite, fields.allow_actions === "1") });
  redirect(redirectWith(request.redirectUri, { code, state: request.state, iss: origin }));
}
