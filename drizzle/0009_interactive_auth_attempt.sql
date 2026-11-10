ALTER TABLE "hosted_browser_sessions" ADD COLUMN "interactive_attempt_id" uuid;
ALTER TABLE "hosted_browser_sessions" ADD COLUMN "interactive_attempt_started_at" timestamptz;
ALTER TABLE "hosted_browser_sessions" ADD COLUMN "interactive_attempt_deadline_at" timestamptz;
ALTER TABLE "interactive_session_monitors" ADD COLUMN "auth_attempt_id" uuid;

-- Preserve an existing in-flight deadline during migration. Terminal rows do
-- not receive an attempt identity and therefore cannot be silently reopened.
UPDATE "hosted_browser_sessions"
SET "interactive_attempt_id" = gen_random_uuid(),
    "interactive_attempt_started_at" = "created_at",
    "interactive_attempt_deadline_at" = "created_at" + interval '30 minutes'
WHERE "status" IN ('provisioning', 'auth_required')
  AND "revoked_at" IS NULL;

UPDATE "interactive_session_monitors" m
SET "auth_attempt_id" = s."interactive_attempt_id",
    "deadline_at" = s."interactive_attempt_deadline_at"
FROM "hosted_browser_sessions" s
WHERE s."owner_id" = m."owner_id"
  AND s."id" = m."hosted_session_id"
  AND m."status" IN ('queued', 'leased')
  AND s."interactive_attempt_id" IS NOT NULL;

CREATE INDEX "hosted_browser_sessions_interactive_attempt_idx"
  ON "hosted_browser_sessions" ("owner_id", "interactive_attempt_id");
CREATE INDEX "interactive_session_monitors_attempt_idx"
  ON "interactive_session_monitors" ("owner_id", "hosted_session_id", "auth_attempt_id");
