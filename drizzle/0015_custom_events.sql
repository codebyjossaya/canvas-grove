-- Custom calendar events: the student's own planner entries, shown beside Canvas items.
-- Grove-only data. Canvas sync never reads or writes this table and nothing here is sent to Canvas.
-- Timed events use starts_at/ends_at; all-day events use start_date/end_date (zone-independent).
CREATE TABLE "custom_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"course_id" uuid,
	"title" text NOT NULL,
	"notes" text,
	"all_day" boolean DEFAULT false NOT NULL,
	"starts_at" timestamptz,
	"ends_at" timestamptz,
	"start_date" date,
	"end_date" date,
	"color" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "custom_events_title_check" CHECK (char_length("title") BETWEEN 1 AND 200),
	CONSTRAINT "custom_events_notes_check" CHECK ("notes" IS NULL OR char_length("notes") <= 2000),
	CONSTRAINT "custom_events_color_check" CHECK ("color" BETWEEN 0 AND 7),
	CONSTRAINT "custom_events_when_check" CHECK (
		("all_day" AND "start_date" IS NOT NULL AND "end_date" IS NOT NULL AND "end_date" >= "start_date" AND "starts_at" IS NULL AND "ends_at" IS NULL)
		OR (NOT "all_day" AND "starts_at" IS NOT NULL AND "ends_at" IS NOT NULL AND "ends_at" >= "starts_at" AND "start_date" IS NULL AND "end_date" IS NULL)
	)
);
--> statement-breakpoint
ALTER TABLE "custom_events" ADD CONSTRAINT "custom_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Removing a course only unlinks the event (SET NULL on course_id alone, never owner_id); the event survives.
ALTER TABLE "custom_events" ADD CONSTRAINT "custom_events_tenant_course_fk" FOREIGN KEY ("owner_id", "course_id") REFERENCES "public"."courses"("owner_id", "id") ON DELETE SET NULL ("course_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_events_owner_starts_idx" ON "custom_events" USING btree ("owner_id", "starts_at") WHERE NOT "all_day";--> statement-breakpoint
CREATE INDEX "custom_events_owner_dates_idx" ON "custom_events" USING btree ("owner_id", "start_date") WHERE "all_day";--> statement-breakpoint
ALTER TABLE "custom_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "custom_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "custom_events" USING (owner_id = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
-- TRUNCATE bypasses row-level security; the app role never needs it here (as in 0014).
REVOKE TRUNCATE ON "custom_events" FROM CURRENT_USER;
