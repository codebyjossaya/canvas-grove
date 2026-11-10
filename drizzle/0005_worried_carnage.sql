CREATE TABLE "quiz_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"quiz_id" uuid NOT NULL,
	"canvas_quiz_submission_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"workflow_state" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"score" numeric,
	"kept_score" numeric,
	"time_spent_seconds" integer,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_attempts_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "quiz_attempts_canvas_identity_unique" UNIQUE("quiz_id","canvas_quiz_submission_id")
);
--> statement-breakpoint
CREATE TABLE "quizzes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"canvas_account_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"canvas_quiz_id" text NOT NULL,
	"canvas_assignment_id" text,
	"engine" text DEFAULT 'classic' NOT NULL,
	"title" text NOT NULL,
	"description_html" text,
	"quiz_type" text,
	"points_possible" numeric,
	"question_count" integer,
	"time_limit_minutes" integer,
	"allowed_attempts" integer DEFAULT 1 NOT NULL,
	"scoring_policy" text,
	"due_at" timestamp with time zone,
	"unlock_at" timestamp with time zone,
	"lock_at" timestamp with time zone,
	"published" boolean DEFAULT false NOT NULL,
	"locked_for_user" boolean DEFAULT false NOT NULL,
	"lock_explanation" text,
	"html_url" text,
	"supported" boolean DEFAULT true NOT NULL,
	"unsupported_reason" text,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quizzes_owner_id_id_unique" UNIQUE("owner_id","id"),
	CONSTRAINT "quizzes_canvas_identity_unique" UNIQUE("course_id","canvas_quiz_id")
);
--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_tenant_quiz_fk" FOREIGN KEY ("owner_id","quiz_id") REFERENCES "public"."quizzes"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_tenant_account_fk" FOREIGN KEY ("owner_id","canvas_account_id") REFERENCES "public"."canvas_accounts"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_tenant_course_fk" FOREIGN KEY ("owner_id","course_id") REFERENCES "public"."courses"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quiz_attempts_owner_state_idx" ON "quiz_attempts" USING btree ("owner_id","workflow_state");--> statement-breakpoint
CREATE INDEX "quizzes_owner_due_idx" ON "quizzes" USING btree ("owner_id","due_at");--> statement-breakpoint
ALTER TABLE "quizzes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quizzes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "quizzes" USING (owner_id = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "quiz_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quiz_attempts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "quiz_attempts" USING (owner_id = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK (owner_id = nullif(current_setting('app.user_id', true), '')::uuid);
