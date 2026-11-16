-- Orientation v2 scopes: which Canvas data areas Grove may sync/read, and the default permissions
-- for newly connected agents. NULL data_scopes / agent_defaults = never saved (defaults apply:
-- every area on, agents may propose). Same table, so RLS is unchanged.
ALTER TABLE "user_preferences" ADD COLUMN "data_scopes" text[];--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "agent_defaults" jsonb;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "scopes_saved_at" timestamp with time zone;
