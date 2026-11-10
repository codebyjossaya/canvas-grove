ALTER TABLE "quizzes" ALTER COLUMN "allowed_attempts" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "quizzes" ALTER COLUMN "allowed_attempts" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "canvas_accounts" ADD COLUMN "institution_name" text;--> statement-breakpoint
ALTER TABLE "hosted_browser_profiles" ADD COLUMN "institution_name" text DEFAULT 'My institution' NOT NULL;--> statement-breakpoint
ALTER TABLE "hosted_browser_profiles" ADD COLUMN "auth_host_rules" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "hosted_browser_profiles" ADD COLUMN "login_path" text DEFAULT '/login' NOT NULL;--> statement-breakpoint
UPDATE "canvas_accounts"
SET "institution_name" = CASE
  WHEN "canvas_base_url" = 'https://ufl.instructure.com' THEN 'University of Florida'
  ELSE initcap(split_part(replace("canvas_base_url", 'https://', ''), '.', 1))
END
WHERE "institution_name" IS NULL;--> statement-breakpoint
UPDATE "hosted_browser_profiles"
SET "institution_name" = CASE
      WHEN "canvas_origin" = 'https://ufl.instructure.com' THEN 'University of Florida'
      ELSE initcap(split_part(replace("canvas_origin", 'https://', ''), '.', 1))
    END,
    "auth_host_rules" = CASE
      WHEN "canvas_origin" = 'https://ufl.instructure.com' THEN '["ufl.edu","duosecurity.com","duo.com"]'::jsonb
      ELSE '[]'::jsonb
    END,
    "login_path" = CASE
      WHEN "canvas_origin" = 'https://ufl.instructure.com' THEN '/login/saml'
      ELSE '/login'
    END;
