-- Grove MCP phase 2: staged actions (approve in Grove), per-connection auto mode, entry-scoped
-- quiz sessions and a content-free audit log. A "connection" is one PAT (token_id) or one OAuth
-- grant (grant_id); exactly one of the two is set. All tables are owner-scoped with forced RLS.
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_owner_id_id_unique" UNIQUE ("owner_id", "id");--> statement-breakpoint
CREATE TABLE "mcp_pending_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"token_id" uuid,
	"grant_id" uuid,
	"client_name" text NOT NULL,
	"tool" text NOT NULL,
	"category" text,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"preview" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'awaiting_approval' NOT NULL,
	"decided_by" text,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"expires_at" timestamptz NOT NULL,
	"decided_at" timestamptz,
	"result" jsonb,
	"idempotency_key" text,
	CONSTRAINT "mcp_pending_actions_connection_check" CHECK (("token_id" IS NULL) <> ("grant_id" IS NULL)),
	CONSTRAINT "mcp_pending_actions_status_check" CHECK ("status" in ('awaiting_approval', 'approved', 'rejected', 'executing', 'done', 'failed', 'expired', 'cancelled')),
	CONSTRAINT "mcp_pending_actions_decided_by_check" CHECK ("decided_by" IS NULL OR "decided_by" in ('you', 'auto', 'system')),
	CONSTRAINT "mcp_pending_actions_category_check" CHECK ("category" IS NULL OR "category" in ('submit_assignment', 'outward_messages', 'quiz_entry')),
	CONSTRAINT "mcp_pending_actions_key_check" CHECK ("idempotency_key" IS NULL OR char_length("idempotency_key") BETWEEN 8 AND 64),
	CONSTRAINT "mcp_pending_actions_size_check" CHECK (pg_column_size("args") <= 65536 AND pg_column_size("preview") <= 65536)
);
--> statement-breakpoint
CREATE TABLE "mcp_auto_modes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"token_id" uuid,
	"grant_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" timestamptz,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_auto_modes_connection_check" CHECK (("token_id" IS NULL) <> ("grant_id" IS NULL)),
	CONSTRAINT "mcp_auto_modes_categories_check" CHECK ("categories" <@ ARRAY['submit_assignment', 'outward_messages', 'quiz_entry']::text[])
);
--> statement-breakpoint
CREATE TABLE "mcp_quiz_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"token_id" uuid,
	"grant_id" uuid,
	"action_id" uuid,
	"quiz_id" uuid NOT NULL,
	"canvas_submission_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"expires_at" timestamptz NOT NULL,
	"ended_at" timestamptz,
	CONSTRAINT "mcp_quiz_sessions_connection_check" CHECK (("token_id" IS NULL) <> ("grant_id" IS NULL)),
	CONSTRAINT "mcp_quiz_sessions_submission_check" CHECK ("canvas_submission_id" ~ '^[0-9]{1,20}$')
);
--> statement-breakpoint
CREATE TABLE "mcp_audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"owner_id" uuid NOT NULL,
	"at" timestamptz DEFAULT now() NOT NULL,
	"token_id" uuid,
	"grant_id" uuid,
	"client_name" text,
	"tool" text NOT NULL,
	"outcome" text NOT NULL,
	"action_id" uuid,
	"decided_by" text
);
--> statement-breakpoint
ALTER TABLE "mcp_pending_actions" ADD CONSTRAINT "mcp_pending_actions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_pending_actions" ADD CONSTRAINT "mcp_pending_actions_tenant_token_fk" FOREIGN KEY ("owner_id", "token_id") REFERENCES "public"."mcp_tokens"("owner_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_pending_actions" ADD CONSTRAINT "mcp_pending_actions_tenant_grant_fk" FOREIGN KEY ("owner_id", "grant_id") REFERENCES "public"."mcp_grants"("owner_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_auto_modes" ADD CONSTRAINT "mcp_auto_modes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_auto_modes" ADD CONSTRAINT "mcp_auto_modes_tenant_token_fk" FOREIGN KEY ("owner_id", "token_id") REFERENCES "public"."mcp_tokens"("owner_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_auto_modes" ADD CONSTRAINT "mcp_auto_modes_tenant_grant_fk" FOREIGN KEY ("owner_id", "grant_id") REFERENCES "public"."mcp_grants"("owner_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_quiz_sessions" ADD CONSTRAINT "mcp_quiz_sessions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_quiz_sessions" ADD CONSTRAINT "mcp_quiz_sessions_tenant_token_fk" FOREIGN KEY ("owner_id", "token_id") REFERENCES "public"."mcp_tokens"("owner_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_quiz_sessions" ADD CONSTRAINT "mcp_quiz_sessions_tenant_grant_fk" FOREIGN KEY ("owner_id", "grant_id") REFERENCES "public"."mcp_grants"("owner_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_quiz_sessions" ADD CONSTRAINT "mcp_quiz_sessions_tenant_quiz_fk" FOREIGN KEY ("owner_id", "quiz_id") REFERENCES "public"."quizzes"("owner_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_audit" ADD CONSTRAINT "mcp_audit_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_pending_actions_owner_status_idx" ON "mcp_pending_actions" USING btree ("owner_id", "status", "created_at");--> statement-breakpoint
CREATE INDEX "mcp_pending_actions_token_idx" ON "mcp_pending_actions" USING btree ("owner_id", "token_id", "decided_by", "decided_at") WHERE "token_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mcp_pending_actions_grant_idx" ON "mcp_pending_actions" USING btree ("owner_id", "grant_id", "decided_by", "decided_at") WHERE "grant_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_pending_actions_idempotency_idx" ON "mcp_pending_actions" USING btree ("owner_id", (coalesce("token_id", "grant_id")), "idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_auto_modes_token_idx" ON "mcp_auto_modes" USING btree ("owner_id", "token_id") WHERE "token_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_auto_modes_grant_idx" ON "mcp_auto_modes" USING btree ("owner_id", "grant_id") WHERE "grant_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mcp_quiz_sessions_lookup_idx" ON "mcp_quiz_sessions" USING btree ("owner_id", "quiz_id", "ended_at");--> statement-breakpoint
CREATE INDEX "mcp_audit_owner_time_idx" ON "mcp_audit" USING btree ("owner_id", "at");--> statement-breakpoint
ALTER TABLE "mcp_pending_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mcp_pending_actions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mcp_pending_actions" USING (owner_id = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "mcp_auto_modes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mcp_auto_modes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mcp_auto_modes" USING (owner_id = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "mcp_quiz_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mcp_quiz_sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mcp_quiz_sessions" USING (owner_id = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "mcp_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mcp_audit" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mcp_audit" USING (owner_id = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);
