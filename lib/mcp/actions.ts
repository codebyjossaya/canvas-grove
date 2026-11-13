import "server-only";
import type postgres from "postgres";
import { withTenantSql } from "@/lib/db";
import type { AuthContext } from "@/lib/db/auth-context";
import { ACTION_TTL_MINUTES, MAX_AWAITING_ACTIONS, TOOL_CATEGORY, type AutoCategory, type DecidedBy } from "./categories";
import { autoDecision } from "./action-policy";
import { MCP_LIMITS, limit } from "./limits";
import type { BearerAuth } from "./store";

// Staged MCP actions. Models propose; the signed-in user approves inside Grove (or the
// connection's auto mode does, server-side, within its categories, expiry and caps). Approval and
// execution are exactly-once: every transition is a row-locked compare-and-set on `status`.

type Tx = postgres.TransactionSql;
type Stamp = Date | string | null;
const iso = (value: Stamp) => (value ? new Date(value).toISOString() : null);

export type Connection = { kind: "token" | "grant"; id: string; clientName: string };
export const connectionOf = (auth: BearerAuth): Connection =>
  auth.kind === "pat" ? { kind: "token", id: auth.tokenId, clientName: auth.clientName } : { kind: "grant", id: auth.grantId!, clientName: auth.clientName };
const cols = (c: { kind: "token" | "grant"; id: string }) => ({ tokenId: c.kind === "token" ? c.id : null, grantId: c.kind === "grant" ? c.id : null });

export type PreviewLine = { label: string; value: string };
export type Preview = { title: string; summary: string; lines: PreviewLine[]; warning?: string };
export type ExecResult = { ok: boolean; message: string; code?: string; data?: Record<string, unknown> };
export type ActionRow = {
  id: string; owner_id: string; token_id: string | null; grant_id: string | null; client_name: string; tool: string; category: string | null;
  args: Record<string, unknown>; preview: Preview; status: string; decided_by: DecidedBy | null; created_at: Stamp; expires_at: Stamp; decided_at: Stamp; result: ExecResult | null;
};
export type Executor = (ctx: AuthContext, action: ActionRow) => Promise<ExecResult>;

export type PublicAction = {
  id: string; tool: string; category: string | null; title: string; summary: string;
  preview: { lines: PreviewLine[]; warning?: string };
  client: { name: string; connectionId: string; kind: "token" | "grant" };
  status: string; decidedBy: DecidedBy | null; createdAt: string | null; expiresAt: string | null; decidedAt: string | null;
  result?: { ok: boolean; message: string; code?: string };
};

export function publicAction(row: ActionRow): PublicAction {
  return {
    id: row.id, tool: row.tool, category: row.category, title: row.preview?.title ?? row.tool, summary: row.preview?.summary ?? "",
    preview: { lines: row.preview?.lines ?? [], ...(row.preview?.warning ? { warning: row.preview.warning } : {}) },
    client: { name: row.client_name, connectionId: (row.token_id ?? row.grant_id)!, kind: row.token_id ? "token" : "grant" },
    status: row.status, decidedBy: row.decided_by, createdAt: iso(row.created_at), expiresAt: iso(row.expires_at), decidedAt: iso(row.decided_at),
    ...(row.result ? { result: { ok: row.result.ok, message: row.result.message, ...(row.result.code ? { code: row.result.code } : {}) } } : {}),
  };
}

const COLUMNS = "id, owner_id, token_id, grant_id, client_name, tool, category, args, preview, status, decided_by, created_at, expires_at, decided_at, result";

// ------------------------------------------------------------------ audit (never content)

export async function auditTx(tx: Tx, ownerId: string, entry: { tokenId?: string | null; grantId?: string | null; clientName?: string | null; tool: string; outcome: string; actionId?: string | null; decidedBy?: string | null }) {
  await tx`insert into mcp_audit (owner_id, token_id, grant_id, client_name, tool, outcome, action_id, decided_by)
    values (${ownerId}, ${entry.tokenId ?? null}, ${entry.grantId ?? null}, ${entry.clientName ?? null}, ${entry.tool}, ${entry.outcome.slice(0, 60)}, ${entry.actionId ?? null}, ${entry.decidedBy ?? null})`;
}

export async function audit(auth: BearerAuth, tool: string, outcome: string, actionId: string | null = null) {
  const conn = connectionOf(auth);
  const { tokenId, grantId } = cols(conn);
  await withTenantSql(auth.ctx.ownerId, (tx) => auditTx(tx, auth.ctx.ownerId, { tokenId, grantId, clientName: conn.clientName, tool, outcome, actionId })).catch(() => undefined);
}

const sweepExpired = (tx: Tx, ownerId: string) => tx`update mcp_pending_actions set status = 'expired', decided_by = 'system', decided_at = now()
  where owner_id = ${ownerId} and status = 'awaiting_approval' and expires_at <= now()`;

// ------------------------------------------------------------------ execution

async function finalize(ownerId: string, id: string, result: ExecResult): Promise<ActionRow> {
  return withTenantSql(ownerId, async (tx) => {
    const [row] = await tx<ActionRow[]>`update mcp_pending_actions set status = ${result.ok ? "done" : "failed"}, result = ${JSON.stringify(result)}::jsonb
      where owner_id = ${ownerId} and id = ${id} and status = 'executing' returning ${tx.unsafe(COLUMNS)}`;
    await auditTx(tx, ownerId, { tokenId: row?.token_id, grantId: row?.grant_id, clientName: row?.client_name, tool: row?.tool ?? "unknown", outcome: result.ok ? "done" : `failed:${result.code ?? "error"}`, actionId: id, decidedBy: row?.decided_by });
    return row;
  });
}

async function run(ctx: AuthContext, row: ActionRow, executor: Executor): Promise<ActionRow> {
  let result: ExecResult;
  try { result = await executor(ctx, row); }
  catch (error) {
    // Error class and code only: never arguments, tokens or Canvas content.
    console.error(JSON.stringify({ event: "mcp_action_error", tool: row.tool, ownerId: ctx.ownerId, error: error instanceof Error ? error.name : "unknown", code: (error as { code?: unknown })?.code ?? null }));
    const kind = typeof (error as { code?: unknown })?.code === "string" ? String((error as { code: string }).code).slice(0, 40) : error instanceof Error ? error.name : "unknown";
    result = { ok: false, code: "EXECUTION_FAILED", message: `Grove could not complete this action (${kind}). Nothing further was attempted.` };
  }
  return finalize(ctx.ownerId, row.id, result);
}

// ------------------------------------------------------------------ staging (bearer, MCP)

export class StageError extends Error { constructor(public code: string, message: string) { super(message); } }

export type StageInput = { tool: string; args: Record<string, unknown>; preview: Preview; idempotencyKey?: string | null };
export type StageOutcome = { action: PublicAction; replay: boolean; autoNote?: string };

/**
 * Stage an outward action. If the connection's auto mode currently covers the tool's category (and
 * caps allow), it is claimed for execution in the same transaction and executed right away;
 * otherwise it waits for approval in Grove. `executor` is resolved by the caller (tests may stub it).
 */
export async function stageAction(auth: BearerAuth, input: StageInput, executor: Executor): Promise<StageOutcome> {
  const allowed = limit(MCP_LIMITS.writeToken, auth.tokenId);
  if (!allowed.allowed) throw new StageError("RATE_LIMITED", "Too many proposed actions from this connection. Try again later.");
  const conn = connectionOf(auth);
  const { tokenId, grantId } = cols(conn);
  const ownerId = auth.ctx.ownerId;
  const category: AutoCategory | null = TOOL_CATEGORY[input.tool] ?? null;
  const staged = await withTenantSql(ownerId, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`mcp-actions:${ownerId}`}))`;
    await sweepExpired(tx, ownerId);
    if (input.idempotencyKey) {
      const [prior] = await tx<ActionRow[]>`select ${tx.unsafe(COLUMNS)} from mcp_pending_actions where owner_id = ${ownerId}
        and coalesce(token_id, grant_id) = ${conn.id} and idempotency_key = ${input.idempotencyKey}`;
      if (prior) return { row: prior, replay: true, auto: false, note: undefined as string | undefined };
    }
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from mcp_pending_actions where owner_id = ${ownerId} and status = 'awaiting_approval'`;
    if (n >= MAX_AWAITING_ACTIONS) throw new StageError("TOO_MANY_PENDING", `There are already ${MAX_AWAITING_ACTIONS} actions waiting for approval in Grove.`);
    const [mode] = await tx<{ enabled: boolean; categories: string[]; expires_at: Stamp }[]>`select enabled, categories, expires_at from mcp_auto_modes
      where owner_id = ${ownerId} and token_id is not distinct from ${tokenId}::uuid and grant_id is not distinct from ${grantId}::uuid for update`;
    const [used] = await tx<{ hour: number; day: number }[]>`select count(*) filter (where decided_at > now() - interval '1 hour')::int as hour,
      count(*) filter (where decided_at > now() - interval '1 day')::int as day from mcp_pending_actions
      where owner_id = ${ownerId} and coalesce(token_id, grant_id) = ${conn.id} and decided_by = 'auto'`;
    const decision = autoDecision(mode, category, used.hour, used.day);
    const [row] = await tx<ActionRow[]>`insert into mcp_pending_actions (owner_id, token_id, grant_id, client_name, tool, category, args, preview, status, decided_by, decided_at, expires_at, idempotency_key)
      values (${ownerId}, ${tokenId}, ${grantId}, ${conn.clientName}, ${input.tool}, ${category}, ${JSON.stringify(input.args)}::jsonb, ${JSON.stringify(input.preview)}::jsonb,
        ${decision.auto ? "executing" : "awaiting_approval"}, ${decision.auto ? "auto" : null}, case when ${decision.auto} then now() else null end, now() + ${`${ACTION_TTL_MINUTES} minutes`}::interval, ${input.idempotencyKey ?? null})
      on conflict do nothing returning ${tx.unsafe(COLUMNS)}`;
    if (!row) throw new StageError("DUPLICATE", "An action with this idempotency key already exists.");
    const reason = decision.auto ? null : decision.reason;
    const capped = reason === "hour_cap" || reason === "day_cap";
    await auditTx(tx, ownerId, { tokenId, grantId, clientName: conn.clientName, tool: input.tool, outcome: decision.auto ? "auto_approved" : capped ? "staged:auto_cap_reached" : reason === "expired" ? "staged:auto_expired" : "staged", actionId: row.id, decidedBy: decision.auto ? "auto" : null });
    const note = capped ? "Auto mode reached its cap for this connection, so this action is waiting for approval in Grove." : reason === "expired" ? "Auto mode for this connection has expired, so this action is waiting for approval in Grove." : undefined;
    return { row, replay: false, auto: decision.auto, note };
  });
  const row = staged.auto ? await run(auth.ctx, staged.row, executor) : staged.row;
  return { action: publicAction(row), replay: staged.replay, ...(staged.note ? { autoNote: staged.note } : {}) };
}

/** Grove-local actions (planner) run immediately; they are still recorded for history and audit. */
export async function recordImmediate(auth: BearerAuth, tool: string, preview: Preview, args: Record<string, unknown>, result: ExecResult) {
  const conn = connectionOf(auth);
  const { tokenId, grantId } = cols(conn);
  const ownerId = auth.ctx.ownerId;
  await withTenantSql(ownerId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`insert into mcp_pending_actions (owner_id, token_id, grant_id, client_name, tool, category, args, preview, status, decided_by, decided_at, expires_at, result)
      values (${ownerId}, ${tokenId}, ${grantId}, ${conn.clientName}, ${tool}, null, ${JSON.stringify(args)}::jsonb, ${JSON.stringify(preview)}::jsonb, ${result.ok ? "done" : "failed"}, 'system', now(), now(), ${JSON.stringify(result)}::jsonb) returning id`;
    await auditTx(tx, ownerId, { tokenId, grantId, clientName: conn.clientName, tool, outcome: result.ok ? "done" : "failed", actionId: row.id, decidedBy: "system" });
  });
}

// ------------------------------------------------------------------ approval (Clerk session only, never bearer)

export type DecisionOutcome = { kind: "ok"; action: PublicAction } | { kind: "conflict"; action: PublicAction } | { kind: "expired"; action: PublicAction } | { kind: "not_found" };

async function connectionLive(tx: Tx, ownerId: string, row: ActionRow): Promise<boolean> {
  if (row.token_id) return (await tx`select 1 from mcp_tokens where owner_id = ${ownerId} and id = ${row.token_id} and revoked_at is null and (expires_at is null or expires_at > now())`).length > 0;
  return (await tx`select 1 from mcp_grants where owner_id = ${ownerId} and id = ${row.grant_id} and revoked_at is null`).length > 0;
}

/**
 * Approve and execute. Row lock + status compare-and-set: concurrent clicks see `executing` (409),
 * an expired action becomes `expired` (410), and the executor runs at most once.
 */
export async function approveAction(ctx: AuthContext, actionId: string, executorFor: (tool: string) => Executor): Promise<DecisionOutcome> {
  const claimed = await withTenantSql(ctx.ownerId, async (tx) => {
    const [row] = await tx<ActionRow[]>`select ${tx.unsafe(COLUMNS)} from mcp_pending_actions where owner_id = ${ctx.ownerId} and id = ${actionId} for update`;
    if (!row) return { kind: "not_found" as const };
    if (row.status === "awaiting_approval" && !(new Date(row.expires_at!).getTime() > Date.now())) {
      const [expired] = await tx<ActionRow[]>`update mcp_pending_actions set status = 'expired', decided_by = 'system', decided_at = now() where owner_id = ${ctx.ownerId} and id = ${actionId} returning ${tx.unsafe(COLUMNS)}`;
      return { kind: "expired" as const, row: expired };
    }
    if (row.status !== "awaiting_approval") return { kind: "conflict" as const, row };
    if (!(await connectionLive(tx, ctx.ownerId, row))) {
      const [cancelled] = await tx<ActionRow[]>`update mcp_pending_actions set status = 'cancelled', decided_by = 'system', decided_at = now() where owner_id = ${ctx.ownerId} and id = ${actionId} returning ${tx.unsafe(COLUMNS)}`;
      return { kind: "conflict" as const, row: cancelled };
    }
    const [executing] = await tx<ActionRow[]>`update mcp_pending_actions set status = 'executing', decided_by = 'you', decided_at = now()
      where owner_id = ${ctx.ownerId} and id = ${actionId} and status = 'awaiting_approval' returning ${tx.unsafe(COLUMNS)}`;
    await auditTx(tx, ctx.ownerId, { tokenId: row.token_id, grantId: row.grant_id, clientName: row.client_name, tool: row.tool, outcome: "approved", actionId, decidedBy: "you" });
    return { kind: "claimed" as const, row: executing };
  });
  if (claimed.kind === "not_found") return claimed;
  if (claimed.kind !== "claimed") return { kind: claimed.kind, action: publicAction(claimed.row) };
  return { kind: "ok", action: publicAction(await run(ctx, claimed.row, executorFor(claimed.row.tool))) };
}

export async function rejectAction(ctx: AuthContext, actionId: string): Promise<DecisionOutcome> {
  return withTenantSql(ctx.ownerId, async (tx) => {
    await sweepExpired(tx, ctx.ownerId);
    const [row] = await tx<ActionRow[]>`update mcp_pending_actions set status = 'rejected', decided_by = 'you', decided_at = now()
      where owner_id = ${ctx.ownerId} and id = ${actionId} and status = 'awaiting_approval' returning ${tx.unsafe(COLUMNS)}`;
    if (row) {
      await auditTx(tx, ctx.ownerId, { tokenId: row.token_id, grantId: row.grant_id, clientName: row.client_name, tool: row.tool, outcome: "rejected", actionId, decidedBy: "you" });
      return { kind: "ok" as const, action: publicAction(row) };
    }
    const [current] = await tx<ActionRow[]>`select ${tx.unsafe(COLUMNS)} from mcp_pending_actions where owner_id = ${ctx.ownerId} and id = ${actionId}`;
    if (!current) return { kind: "not_found" as const };
    return { kind: current.status === "expired" ? "expired" as const : "conflict" as const, action: publicAction(current) };
  });
}

export async function listActionsForOwner(ctx: AuthContext, view: "awaiting" | "history", max: number): Promise<{ awaitingCount: number; actions: PublicAction[] }> {
  return withTenantSql(ctx.ownerId, async (tx) => {
    await sweepExpired(tx, ctx.ownerId);
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from mcp_pending_actions where owner_id = ${ctx.ownerId} and status = 'awaiting_approval'`;
    const rows = view === "awaiting"
      ? await tx<ActionRow[]>`select ${tx.unsafe(COLUMNS)} from mcp_pending_actions where owner_id = ${ctx.ownerId} and status = 'awaiting_approval' order by created_at desc limit ${max}`
      : await tx<ActionRow[]>`select ${tx.unsafe(COLUMNS)} from mcp_pending_actions where owner_id = ${ctx.ownerId} and status <> 'awaiting_approval' order by coalesce(decided_at, created_at) desc limit ${max}`;
    return { awaitingCount: n, actions: rows.map(publicAction) };
  });
}

// ------------------------------------------------------------------ the assistant's own actions (bearer)

export async function connectionActions(auth: BearerAuth, status: string | null, max: number): Promise<PublicAction[]> {
  const conn = connectionOf(auth);
  return withTenantSql(auth.ctx.ownerId, async (tx) => {
    await sweepExpired(tx, auth.ctx.ownerId);
    const rows = await tx<ActionRow[]>`select ${tx.unsafe(COLUMNS)} from mcp_pending_actions where owner_id = ${auth.ctx.ownerId}
      and coalesce(token_id, grant_id) = ${conn.id} ${status ? tx`and status = ${status}` : tx``} order by created_at desc limit ${max}`;
    return rows.map(publicAction);
  });
}

export async function connectionAction(auth: BearerAuth, actionId: string): Promise<PublicAction | null> {
  const conn = connectionOf(auth);
  return withTenantSql(auth.ctx.ownerId, async (tx) => {
    await sweepExpired(tx, auth.ctx.ownerId);
    const [row] = await tx<ActionRow[]>`select ${tx.unsafe(COLUMNS)} from mcp_pending_actions where owner_id = ${auth.ctx.ownerId} and id = ${actionId} and coalesce(token_id, grant_id) = ${conn.id}`;
    return row ? publicAction(row) : null;
  });
}

/** Cancel one of this connection's own awaiting actions; for a done quiz entry, ends its session. */
export async function cancelConnectionAction(auth: BearerAuth, actionId: string): Promise<PublicAction | null> {
  const conn = connectionOf(auth);
  const ownerId = auth.ctx.ownerId;
  return withTenantSql(ownerId, async (tx) => {
    await sweepExpired(tx, ownerId);
    const [row] = await tx<ActionRow[]>`select ${tx.unsafe(COLUMNS)} from mcp_pending_actions where owner_id = ${ownerId} and id = ${actionId} and coalesce(token_id, grant_id) = ${conn.id} for update`;
    if (!row) return null;
    let updated = row;
    if (row.status === "awaiting_approval") {
      [updated] = await tx<ActionRow[]>`update mcp_pending_actions set status = 'cancelled', decided_by = 'system', decided_at = now() where owner_id = ${ownerId} and id = ${actionId} returning ${tx.unsafe(COLUMNS)}`;
    }
    if (row.tool === "start_quiz_attempt") await tx`update mcp_quiz_sessions set ended_at = now() where owner_id = ${ownerId} and action_id = ${actionId} and ended_at is null`;
    const { tokenId, grantId } = cols(conn);
    await auditTx(tx, ownerId, { tokenId, grantId, clientName: conn.clientName, tool: row.tool, outcome: "cancelled", actionId });
    return publicAction(updated);
  });
}
