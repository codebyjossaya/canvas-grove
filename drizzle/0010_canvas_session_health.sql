-- Value-free health log for server-side (cookie-authenticated) Canvas access.
-- Cookie names and booleans only: never cookie values, headers or bodies.
CREATE TABLE "canvas_session_health_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"owner_id" uuid NOT NULL,
	"hosted_session_id" uuid NOT NULL,
	"at" timestamptz DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"http_status" integer,
	"outcome" text NOT NULL,
	"rotated" boolean DEFAULT false NOT NULL,
	"cookie_names_rotated" text[] DEFAULT '{}'::text[] NOT NULL,
	"session_cookie_reissued" boolean DEFAULT false NOT NULL,
	"remember_cookie_present" boolean DEFAULT false NOT NULL,
	"remember_cookie_used" boolean DEFAULT false NOT NULL,
	"call_count" integer DEFAULT 1 NOT NULL,
	"ok_count" integer DEFAULT 0 NOT NULL,
	"auth_required_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"session_cookie_reissue_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "canvas_session_health_events_kind_check" CHECK ("kind" in ('keepalive', 'sync', 'restore-check', 'api')),
	CONSTRAINT "canvas_session_health_events_outcome_check" CHECK ("outcome" in ('ok', 'auth_required', 'error')),
	CONSTRAINT "canvas_session_health_events_names_check" CHECK (cardinality("cookie_names_rotated") <= 32)
);
--> statement-breakpoint
ALTER TABLE "canvas_session_health_events" ADD CONSTRAINT "canvas_session_health_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_session_health_events" ADD CONSTRAINT "canvas_session_health_events_tenant_session_fk" FOREIGN KEY ("owner_id","hosted_session_id") REFERENCES "public"."hosted_browser_sessions"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "canvas_session_health_events_session_time_idx" ON "canvas_session_health_events" USING btree ("owner_id","hosted_session_id","at");--> statement-breakpoint
ALTER TABLE "canvas_session_health_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "canvas_session_health_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "canvas_session_health_events" USING (owner_id = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);
