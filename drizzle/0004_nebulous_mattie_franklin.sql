CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"canvas_account_id" uuid NOT NULL,
	"course_id" uuid,
	"canvas_announcement_id" text NOT NULL,
	"title" text NOT NULL,
	"body_html" text,
	"posted_at" timestamp with time zone,
	"html_url" text,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcements_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "announcements_canvas_identity_unique" UNIQUE("canvas_account_id","canvas_announcement_id")
);
--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_tenant_account_fk" FOREIGN KEY ("owner_id","canvas_account_id") REFERENCES "public"."canvas_accounts"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_tenant_course_fk" FOREIGN KEY ("owner_id","course_id") REFERENCES "public"."courses"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcements_owner_time_idx" ON "announcements" USING btree ("owner_id","posted_at");--> statement-breakpoint
ALTER TABLE "announcements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "announcements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "announcements" USING (owner_id = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);
