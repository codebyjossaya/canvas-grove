CREATE TYPE "sync_policy_status" AS ENUM('active', 'paused', 'disabled');
--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD COLUMN "fresh_until" timestamptz;
ALTER TABLE "sync_cursors" ADD COLUMN "last_error_at" timestamptz;
ALTER TABLE "sync_cursors" ADD COLUMN "last_error_message" text;
--> statement-breakpoint
CREATE TABLE "sync_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "canvas_account_id" uuid NOT NULL, "resource_type" text NOT NULL, "scope_key" text NOT NULL DEFAULT '',
  "status" sync_policy_status NOT NULL DEFAULT 'active', "interval_seconds" integer NOT NULL DEFAULT 900,
  "freshness_seconds" integer NOT NULL DEFAULT 1200, "jitter_seconds" integer NOT NULL DEFAULT 30,
  "priority" integer NOT NULL DEFAULT 0, "next_run_at" timestamptz NOT NULL DEFAULT now(), "last_enqueued_at" timestamptz,
  "last_success_at" timestamptz, "last_error_at" timestamptz, "last_error_code" text,
  "consecutive_failures" integer NOT NULL DEFAULT 0, "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sync_policies_scope_unique" UNIQUE("canvas_account_id", "resource_type", "scope_key"),
  CONSTRAINT "sync_policies_tenant_account_fk" FOREIGN KEY("owner_id", "canvas_account_id") REFERENCES "canvas_accounts"("owner_id", "id") ON DELETE CASCADE,
  CONSTRAINT "sync_policies_interval_check" CHECK (interval_seconds BETWEEN 60 AND 604800),
  CONSTRAINT "sync_policies_freshness_check" CHECK (freshness_seconds BETWEEN 60 AND 2592000),
  CONSTRAINT "sync_policies_owner_id_id_unique" UNIQUE("owner_id", "id")
);
CREATE INDEX "sync_policies_due_idx" ON "sync_policies"("status", "next_run_at");
CREATE INDEX "sync_policies_owner_idx" ON "sync_policies"("owner_id");
--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD COLUMN "hosted_session_id" uuid;
ALTER TABLE "sync_jobs" ADD COLUMN "policy_id" uuid;
ALTER TABLE "sync_jobs" ADD COLUMN "dedupe_key" text;
ALTER TABLE "sync_jobs" ADD COLUMN "lease_token_hash" text;
ALTER TABLE "sync_jobs" ADD COLUMN "heartbeat_at" timestamptz;
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_owner_id_id_unique" UNIQUE("owner_id", "id");
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_tenant_session_fk" FOREIGN KEY("owner_id", "hosted_session_id") REFERENCES "hosted_browser_sessions"("owner_id", "id") ON DELETE SET NULL;
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_tenant_policy_fk" FOREIGN KEY("owner_id", "policy_id") REFERENCES "sync_policies"("owner_id", "id") ON DELETE SET NULL;
CREATE UNIQUE INDEX "sync_jobs_active_dedupe_unique" ON "sync_jobs"("owner_id", "dedupe_key") WHERE status IN ('queued','leased','running') AND dedupe_key IS NOT NULL;
CREATE INDEX "sync_jobs_lease_expiry_idx" ON "sync_jobs"("lease_expires_at");
--> statement-breakpoint
CREATE TABLE "sync_events" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY, "owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "canvas_account_id" uuid NOT NULL, "job_id" uuid, "source" text NOT NULL, "event_type" text NOT NULL,
  "external_event_id" text, "payload_redacted" jsonb NOT NULL DEFAULT '{}', "received_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz, "outcome" text, "error_code" text,
  CONSTRAINT "sync_events_tenant_account_fk" FOREIGN KEY("owner_id", "canvas_account_id") REFERENCES "canvas_accounts"("owner_id", "id") ON DELETE CASCADE,
  CONSTRAINT "sync_events_tenant_job_fk" FOREIGN KEY("owner_id", "job_id") REFERENCES "sync_jobs"("owner_id", "id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "sync_events_external_unique" ON "sync_events"("canvas_account_id", "source", "external_event_id") WHERE external_event_id IS NOT NULL;
CREATE INDEX "sync_events_owner_time_idx" ON "sync_events"("owner_id", "received_at");
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['sync_policies','sync_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (owner_id = nullif(current_setting(''app.user_id'', true), '''')::uuid) WITH CHECK (owner_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)', t);
END LOOP; END $$;
