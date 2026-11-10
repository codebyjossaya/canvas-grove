ALTER TABLE "user_preferences" ALTER COLUMN "timezone" SET DEFAULT 'auto';
-- Time-zone choice did not exist before this migration, so UTC rows are the
-- former implicit default rather than an explicit user override.
UPDATE "user_preferences" SET "timezone" = 'auto', "updated_at" = now() WHERE "timezone" = 'UTC';
