CREATE TYPE "public"."interactive_monitor_status" AS ENUM('queued', 'leased', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "interactive_session_monitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"hosted_session_id" uuid NOT NULL,
	"status" "interactive_monitor_status" DEFAULT 'queued' NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"check_count" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_token_hash" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"last_observed_state" text,
	"last_error_code" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interactive_session_monitors_owner_id_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
ALTER TABLE "interactive_session_monitors" ADD CONSTRAINT "interactive_session_monitors_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_monitors" ADD CONSTRAINT "interactive_session_monitors_tenant_session_fk" FOREIGN KEY ("owner_id","hosted_session_id") REFERENCES "public"."hosted_browser_sessions"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "interactive_session_monitors_active_unique" ON "interactive_session_monitors" USING btree ("owner_id","hosted_session_id") WHERE "interactive_session_monitors"."status" in ('queued', 'leased');--> statement-breakpoint
CREATE INDEX "interactive_session_monitors_claim_idx" ON "interactive_session_monitors" USING btree ("status","next_check_at");--> statement-breakpoint
CREATE INDEX "interactive_session_monitors_lease_idx" ON "interactive_session_monitors" USING btree ("lease_expires_at");--> statement-breakpoint
ALTER TABLE "interactive_session_monitors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "interactive_session_monitors" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "interactive_session_monitors" USING (owner_id = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);
