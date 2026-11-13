-- Security review follow-ups for the MCP tables.
-- M2: track whether a client was ever granted, so grant-less registrations can be pruned safely
-- (grants are RLS-hidden from the pruning query, so it must never rely on joining them).
ALTER TABLE "mcp_clients" ADD COLUMN "last_granted_at" timestamptz;--> statement-breakpoint
-- Existing clients are treated as granted (never pruned).
UPDATE "mcp_clients" SET "last_granted_at" = "created_at" WHERE "last_granted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "mcp_clients_prune_idx" ON "mcp_clients" USING btree ("created_at") WHERE "last_granted_at" IS NULL;--> statement-breakpoint
-- A client that has grants can never be deleted (pruning bug or not).
ALTER TABLE "mcp_grants" DROP CONSTRAINT "mcp_grants_client_id_fk";--> statement-breakpoint
ALTER TABLE "mcp_grants" ADD CONSTRAINT "mcp_grants_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mcp_clients"("client_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- L4: TRUNCATE bypasses row-level security; the app role never needs it on MCP tables.
REVOKE TRUNCATE ON "mcp_clients", "mcp_grants", "mcp_tokens", "mcp_auth_codes", "mcp_pending_actions", "mcp_auto_modes", "mcp_quiz_sessions", "mcp_audit" FROM CURRENT_USER;
