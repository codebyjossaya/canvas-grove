CREATE TABLE "assignment_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"canvas_assignment_group_id" text NOT NULL,
	"name" text NOT NULL,
	"position" integer,
	"group_weight" numeric,
	"drop_lowest" integer DEFAULT 0 NOT NULL,
	"drop_highest" integer DEFAULT 0 NOT NULL,
	"never_drop_canvas_ids" text[] DEFAULT '{}' NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignment_groups_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "assignment_groups_identity_unique" UNIQUE("course_id","canvas_assignment_group_id")
);
--> statement-breakpoint
CREATE TABLE "course_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"canvas_file_id" text NOT NULL,
	"canvas_folder_id" text,
	"display_name" text NOT NULL,
	"filename" text,
	"content_type" text,
	"size" bigint,
	"locked" boolean DEFAULT false NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"source_created_at" timestamp with time zone,
	"source_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_files_identity_unique" UNIQUE("course_id","canvas_file_id")
);
--> statement-breakpoint
CREATE TABLE "course_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"canvas_folder_id" text NOT NULL,
	"parent_canvas_folder_id" text,
	"name" text NOT NULL,
	"full_name" text,
	"files_count" integer DEFAULT 0 NOT NULL,
	"folders_count" integer DEFAULT 0 NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"unlock_at" timestamp with time zone,
	"lock_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_folders_identity_unique" UNIQUE("course_id","canvas_folder_id")
);
--> statement-breakpoint
CREATE TABLE "course_module_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"module_id" uuid NOT NULL,
	"canvas_module_item_id" text NOT NULL,
	"title" text NOT NULL,
	"position" integer,
	"item_type" text,
	"content_canvas_id" text,
	"page_url" text,
	"html_url" text,
	"completed" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_module_items_identity_unique" UNIQUE("module_id","canvas_module_item_id")
);
--> statement-breakpoint
CREATE TABLE "course_modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"canvas_module_id" text NOT NULL,
	"name" text NOT NULL,
	"position" integer,
	"state" text,
	"unlock_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_modules_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "course_modules_identity_unique" UNIQUE("course_id","canvas_module_id")
);
--> statement-breakpoint
CREATE TABLE "course_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"canvas_page_url" text NOT NULL,
	"title" text NOT NULL,
	"body_html" text,
	"html_url" text,
	"published" boolean DEFAULT false NOT NULL,
	"front_page" boolean DEFAULT false NOT NULL,
	"source_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_pages_identity_unique" UNIQUE("course_id","canvas_page_url")
);
--> statement-breakpoint
CREATE TABLE "course_tabs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"canvas_tab_id" text NOT NULL,
	"label" text NOT NULL,
	"position" integer,
	"tab_type" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"external" boolean DEFAULT false NOT NULL,
	"html_url" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_tabs_identity_unique" UNIQUE("course_id","canvas_tab_id")
);
--> statement-breakpoint
CREATE TABLE "grade_scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"name" text NOT NULL,
	"hypothetical_scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grade_scenarios_owner_id_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "assignment_group_id" uuid;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "apply_assignment_group_weights" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "syllabus_body" text;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "syllabus_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assignment_groups" ADD CONSTRAINT "assignment_groups_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_groups" ADD CONSTRAINT "assignment_groups_tenant_course_fk" FOREIGN KEY ("owner_id","course_id") REFERENCES "public"."courses"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_files" ADD CONSTRAINT "course_files_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_files" ADD CONSTRAINT "course_files_tenant_course_fk" FOREIGN KEY ("owner_id","course_id") REFERENCES "public"."courses"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_folders" ADD CONSTRAINT "course_folders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_folders" ADD CONSTRAINT "course_folders_tenant_course_fk" FOREIGN KEY ("owner_id","course_id") REFERENCES "public"."courses"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_module_items" ADD CONSTRAINT "course_module_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_module_items" ADD CONSTRAINT "course_module_items_tenant_module_fk" FOREIGN KEY ("owner_id","module_id") REFERENCES "public"."course_modules"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_modules" ADD CONSTRAINT "course_modules_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_modules" ADD CONSTRAINT "course_modules_tenant_course_fk" FOREIGN KEY ("owner_id","course_id") REFERENCES "public"."courses"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_pages" ADD CONSTRAINT "course_pages_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_pages" ADD CONSTRAINT "course_pages_tenant_course_fk" FOREIGN KEY ("owner_id","course_id") REFERENCES "public"."courses"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_tabs" ADD CONSTRAINT "course_tabs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_tabs" ADD CONSTRAINT "course_tabs_tenant_course_fk" FOREIGN KEY ("owner_id","course_id") REFERENCES "public"."courses"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_scenarios" ADD CONSTRAINT "grade_scenarios_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_scenarios" ADD CONSTRAINT "grade_scenarios_tenant_course_fk" FOREIGN KEY ("owner_id","course_id") REFERENCES "public"."courses"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "course_tabs_owner_course_idx" ON "course_tabs" USING btree ("owner_id","course_id");--> statement-breakpoint
CREATE INDEX "grade_scenarios_owner_course_idx" ON "grade_scenarios" USING btree ("owner_id","course_id");--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_tenant_group_fk" FOREIGN KEY ("owner_id","assignment_group_id") REFERENCES "public"."assignment_groups"("owner_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['assignment_groups','course_files','course_folders','course_module_items','course_modules','course_pages','course_tabs','grade_scenarios'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t); EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (owner_id = nullif(current_setting(''app.user_id'', true), '''')::uuid) WITH CHECK (owner_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)', t); END LOOP; END $$;
