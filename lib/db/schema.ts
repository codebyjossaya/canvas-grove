import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const userStatus = pgEnum("user_status", ["active", "suspended", "deleted"]);
export const connectionStatus = pgEnum("connection_status", ["connected", "reauth_required", "revoked"]);
export const deviceStatus = pgEnum("device_status", ["pending", "active", "revoked"]);
export const browserSessionStatus = pgEnum("browser_session_status", ["provisioning", "active", "auth_required", "expired", "revoked", "failed"]);
export const controlLeaseStatus = pgEnum("control_lease_status", ["pending", "active", "released", "expired", "revoked"]);
export const browserRuntimeStatus = pgEnum("browser_runtime_status", ["provisioning", "running", "stopped", "failed", "revoked"]);
export const syncJobStatus = pgEnum("sync_job_status", ["queued", "leased", "running", "succeeded", "failed", "cancelled"]);
export const syncPolicyStatus = pgEnum("sync_policy_status", ["active", "paused", "disabled"]);
export const interactiveMonitorStatus = pgEnum("interactive_monitor_status", ["queued", "leased", "succeeded", "failed", "cancelled"]);
export const operationStatus = pgEnum("operation_status", ["previewed", "confirmed", "dispatched", "succeeded", "failed", "unknown", "cancelled"]);
export const plannerSource = pgEnum("planner_source", ["app", "canvas"]);
export const plannerStatus = pgEnum("planner_status", ["todo", "in_progress", "completed", "cancelled"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  primaryEmail: text("primary_email"),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  status: userStatus("status").notNull().default("active"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  ...timestamps,
});

export const userPreferences = pgTable("user_preferences", {
  ownerId: uuid("owner_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  timezone: text("timezone").notNull().default("auto"),
  theme: text("theme").notNull().default("system"),
  weekStartsOn: integer("week_starts_on").notNull().default(0),
  notifications: jsonb("notifications").notNull().default({}),
  retention: jsonb("retention").notNull().default({}),
  orientationVersion: text("orientation_version"),
  orientationCompletedAt: timestamp("orientation_completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("user_preferences_week_start_check", sql`${t.weekStartsOn} between 0 and 6`)]);

export const canvasAccounts = pgTable("canvas_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  canvasBaseUrl: text("canvas_base_url").notNull(),
  institutionName: text("institution_name"),
  canvasUserId: text("canvas_user_id").notNull(),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  locale: text("locale"),
  timezone: text("timezone"),
  status: connectionStatus("status").notNull().default("connected"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  ...timestamps,
}, (t) => [
  unique("canvas_accounts_owner_id_id_unique").on(t.ownerId, t.id),
  unique("canvas_accounts_identity_unique").on(t.ownerId, t.canvasBaseUrl, t.canvasUserId),
  index("canvas_accounts_owner_idx").on(t.ownerId),
]);

export const hostedBrowserProfiles = pgTable("hosted_browser_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  canvasAccountId: uuid("canvas_account_id"),
  provider: text("provider").notNull(),
  providerProfileRef: text("provider_profile_ref").notNull(),
  canvasOrigin: text("canvas_origin").notNull(),
  institutionName: text("institution_name").notNull().default("My institution"),
  authHostRules: jsonb("auth_host_rules").$type<string[]>().notNull().default([]),
  loginPath: text("login_path").notNull().default("/login"),
  region: text("region"),
  status: text("status").notNull().default("active"),
  ...timestamps,
}, (t) => [
  unique("hosted_browser_profiles_owner_id_id_unique").on(t.ownerId, t.id),
  unique("hosted_browser_profiles_provider_ref_unique").on(t.provider, t.providerProfileRef),
  foreignKey({ columns: [t.ownerId, t.canvasAccountId], foreignColumns: [canvasAccounts.ownerId, canvasAccounts.id], name: "hosted_browser_profiles_tenant_account_fk" }).onDelete("cascade"),
  index("hosted_browser_profiles_owner_idx").on(t.ownerId),
]);

export const hostedBrowserSessions = pgTable("hosted_browser_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  profileId: uuid("profile_id").notNull(),
  canvasAccountId: uuid("canvas_account_id"),
  canvasExternalAccountId: text("canvas_external_account_id"),
  provider: text("provider").notNull(),
  providerSessionRef: text("provider_session_ref").notNull(),
  providerContainerRef: text("provider_container_ref"),
  status: browserSessionStatus("status").notNull().default("provisioning"),
  // Optional envelope-encrypted state. Never store cookies or credentials in plaintext.
  encryptedStateCiphertext: text("encrypted_state_ciphertext"),
  encryptedStateNonce: text("encrypted_state_nonce"),
  wrappedDataKey: text("wrapped_data_key"),
  keyVersion: integer("key_version"),
  providerSecretRef: text("provider_secret_ref"),
  consentVersion: text("consent_version").notNull(),
  consentedAt: timestamp("consented_at", { withTimezone: true }).notNull(),
  consentIpHash: text("consent_ip_hash"),
  lastAuthCheckAt: timestamp("last_auth_check_at", { withTimezone: true }),
  interactiveAttemptId: uuid("interactive_attempt_id"),
  interactiveAttemptStartedAt: timestamp("interactive_attempt_started_at", { withTimezone: true }),
  interactiveAttemptDeadlineAt: timestamp("interactive_attempt_deadline_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  failureCode: text("failure_code"),
  ...timestamps,
}, (t) => [
  unique("hosted_browser_sessions_owner_id_id_unique").on(t.ownerId, t.id),
  unique("hosted_browser_sessions_provider_ref_unique").on(t.provider, t.providerSessionRef),
  foreignKey({ columns: [t.ownerId, t.profileId], foreignColumns: [hostedBrowserProfiles.ownerId, hostedBrowserProfiles.id], name: "hosted_browser_sessions_tenant_profile_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.ownerId, t.canvasAccountId], foreignColumns: [canvasAccounts.ownerId, canvasAccounts.id], name: "hosted_browser_sessions_tenant_account_fk" }).onDelete("cascade"),
  check("hosted_browser_sessions_secret_storage_check", sql`(${t.providerSecretRef} is not null) or (${t.encryptedStateCiphertext} is not null and ${t.encryptedStateNonce} is not null and ${t.wrappedDataKey} is not null and ${t.keyVersion} is not null)`),
  index("hosted_browser_sessions_owner_status_idx").on(t.ownerId, t.status),
  index("hosted_browser_sessions_expiry_idx").on(t.expiresAt),
]);

export const remoteBrowserControlLeases = pgTable("remote_browser_control_leases", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull(),
  controllerType: text("controller_type").notNull(),
  controllerId: text("controller_id").notNull(),
  leaseTokenHash: text("lease_token_hash").notNull(),
  takeoverTokenRef: text("takeover_token_ref"),
  status: controlLeaseStatus("status").notNull().default("pending"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokeReason: text("revoke_reason"),
  ...timestamps,
}, (t) => [
  unique("remote_browser_control_leases_owner_id_id_unique").on(t.ownerId, t.id),
  foreignKey({ columns: [t.ownerId, t.sessionId], foreignColumns: [hostedBrowserSessions.ownerId, hostedBrowserSessions.id], name: "remote_browser_control_leases_tenant_session_fk" }).onDelete("cascade"),
  index("remote_browser_control_leases_owner_session_idx").on(t.ownerId, t.sessionId, t.status),
  index("remote_browser_control_leases_expiry_idx").on(t.leaseExpiresAt),
]);

export const selfHostedBrowserInstances = pgTable("self_hosted_browser_instances", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull(),
  runtimeId: text("runtime_id").notNull().unique(),
  containerRef: text("container_ref").notNull(),
  profileVolumeRef: text("profile_volume_ref"),
  cdpEndpointRef: text("cdp_endpoint_ref"),
  status: browserRuntimeStatus("status").notNull().default("provisioning"),
  resourceLimits: jsonb("resource_limits").notNull().default({}),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  failureCode: text("failure_code"),
  ...timestamps,
}, (t) => [
  unique("self_hosted_browser_instances_owner_id_id_unique").on(t.ownerId, t.id),
  unique("self_hosted_browser_instances_session_unique").on(t.ownerId, t.sessionId),
  foreignKey({ columns: [t.ownerId, t.sessionId], foreignColumns: [hostedBrowserSessions.ownerId, hostedBrowserSessions.id], name: "self_hosted_browser_instances_tenant_session_fk" }).onDelete("cascade"),
  index("self_hosted_browser_instances_owner_status_idx").on(t.ownerId, t.status),
]);

export const interactiveSessionMonitors = pgTable("interactive_session_monitors", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), hostedSessionId: uuid("hosted_session_id").notNull(), authAttemptId: uuid("auth_attempt_id"), status: interactiveMonitorStatus("status").notNull().default("queued"), nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(), deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(), checkCount: integer("check_count").notNull().default(0), leaseOwner: text("lease_owner"), leaseTokenHash: text("lease_token_hash"), leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }), heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }), lastObservedState: text("last_observed_state"), lastErrorCode: text("last_error_code"), finishedAt: timestamp("finished_at", { withTimezone: true }), ...timestamps,
}, (t) => [
  unique("interactive_session_monitors_owner_id_id_unique").on(t.ownerId, t.id),
  foreignKey({ columns: [t.ownerId, t.hostedSessionId], foreignColumns: [hostedBrowserSessions.ownerId, hostedBrowserSessions.id], name: "interactive_session_monitors_tenant_session_fk" }).onDelete("cascade"),
  uniqueIndex("interactive_session_monitors_active_unique").on(t.ownerId, t.hostedSessionId).where(sql`${t.status} in ('queued', 'leased')`),
  index("interactive_session_monitors_claim_idx").on(t.status, t.nextCheckAt), index("interactive_session_monitors_lease_idx").on(t.leaseExpiresAt),
]);

// Value-free session-lifetime log for server-side Canvas access (names and booleans only).
export const canvasSessionHealthEvents = pgTable("canvas_session_health_events", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), hostedSessionId: uuid("hosted_session_id").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(), kind: text("kind").notNull(), httpStatus: integer("http_status"), outcome: text("outcome").notNull(),
  rotated: boolean("rotated").notNull().default(false), cookieNamesRotated: text("cookie_names_rotated").array().notNull().default(sql`'{}'::text[]`),
  sessionCookieReissued: boolean("session_cookie_reissued").notNull().default(false), rememberCookiePresent: boolean("remember_cookie_present").notNull().default(false), rememberCookieUsed: boolean("remember_cookie_used").notNull().default(false),
  callCount: integer("call_count").notNull().default(1), okCount: integer("ok_count").notNull().default(0), authRequiredCount: integer("auth_required_count").notNull().default(0), errorCount: integer("error_count").notNull().default(0), sessionCookieReissueCount: integer("session_cookie_reissue_count").notNull().default(0),
}, (t) => [
  foreignKey({ columns: [t.ownerId, t.hostedSessionId], foreignColumns: [hostedBrowserSessions.ownerId, hostedBrowserSessions.id], name: "canvas_session_health_events_tenant_session_fk" }).onDelete("cascade"),
  check("canvas_session_health_events_kind_check", sql`${t.kind} in ('keepalive', 'sync', 'restore-check', 'api')`),
  check("canvas_session_health_events_outcome_check", sql`${t.outcome} in ('ok', 'auth_required', 'error')`),
  check("canvas_session_health_events_names_check", sql`cardinality(${t.cookieNamesRotated}) <= 32`),
  index("canvas_session_health_events_session_time_idx").on(t.ownerId, t.hostedSessionId, t.at),
]);

export const extensionDevices = pgTable("extension_devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  canvasAccountId: uuid("canvas_account_id"),
  publicId: text("public_id").notNull().unique(),
  name: text("name").notNull().default("Canvas browser"),
  credentialHash: text("credential_hash"),
  credentialPrefix: text("credential_prefix"),
  scopes: text("scopes").array().notNull().default(sql`ARRAY[]::text[]`),
  status: deviceStatus("status").notNull().default("pending"),
  pairedAt: timestamp("paired_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  userAgentSummary: text("user_agent_summary"),
  ...timestamps,
}, (t) => [
  unique("extension_devices_owner_id_id_unique").on(t.ownerId, t.id),
  foreignKey({ columns: [t.ownerId, t.canvasAccountId], foreignColumns: [canvasAccounts.ownerId, canvasAccounts.id], name: "extension_devices_tenant_account_fk" }).onDelete("cascade"),
  index("extension_devices_owner_status_idx").on(t.ownerId, t.status),
]);

export const pairingCodes = pgTable("pairing_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  claimedDeviceId: uuid("claimed_device_id"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ columns: [t.ownerId, t.claimedDeviceId], foreignColumns: [extensionDevices.ownerId, extensionDevices.id], name: "pairing_codes_tenant_device_fk" }),
  index("pairing_codes_expiry_idx").on(t.expiresAt),
]);

export const courses = pgTable("courses", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  canvasAccountId: uuid("canvas_account_id").notNull(),
  canvasCourseId: text("canvas_course_id").notNull(),
  name: text("name").notNull(), courseCode: text("course_code"), termName: text("term_name"),
  workflowState: text("workflow_state"), startAt: timestamp("start_at", { withTimezone: true }), endAt: timestamp("end_at", { withTimezone: true }),
  currentScore: numeric("current_score"), currentGrade: text("current_grade"), imageUrl: text("image_url"), favorite: boolean("favorite").notNull().default(false),
  applyAssignmentGroupWeights: boolean("apply_assignment_group_weights").notNull().default(false),
  syllabusBody: text("syllabus_body"), syllabusSyncedAt: timestamp("syllabus_synced_at", { withTimezone: true }),
  sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }), syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }), sourcePayload: jsonb("source_payload").notNull().default({}),
  ...timestamps,
}, (t) => [
  unique("courses_owner_id_id_unique").on(t.ownerId, t.id),
  unique("courses_canvas_identity_unique").on(t.canvasAccountId, t.canvasCourseId),
  foreignKey({ columns: [t.ownerId, t.canvasAccountId], foreignColumns: [canvasAccounts.ownerId, canvasAccounts.id], name: "courses_tenant_account_fk" }).onDelete("cascade"),
  index("courses_owner_active_idx").on(t.ownerId, t.deletedAt),
]);

export const courseTabs = pgTable("course_tabs", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), courseId: uuid("course_id").notNull(),
  canvasTabId: text("canvas_tab_id").notNull(), label: text("label").notNull(), position: integer("position"), tabType: text("tab_type"), hidden: boolean("hidden").notNull().default(false), external: boolean("external").notNull().default(false), htmlUrl: text("html_url"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(), deletedAt: timestamp("deleted_at", { withTimezone: true }), ...timestamps,
}, (t) => [unique("course_tabs_identity_unique").on(t.courseId, t.canvasTabId), foreignKey({ columns: [t.ownerId, t.courseId], foreignColumns: [courses.ownerId, courses.id], name: "course_tabs_tenant_course_fk" }).onDelete("cascade"), index("course_tabs_owner_course_idx").on(t.ownerId, t.courseId)]);

export const courseFolders = pgTable("course_folders", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), courseId: uuid("course_id").notNull(),
  canvasFolderId: text("canvas_folder_id").notNull(), parentCanvasFolderId: text("parent_canvas_folder_id"), name: text("name").notNull(), fullName: text("full_name"), filesCount: integer("files_count").notNull().default(0), foldersCount: integer("folders_count").notNull().default(0), locked: boolean("locked").notNull().default(false), hidden: boolean("hidden").notNull().default(false),
  unlockAt: timestamp("unlock_at", { withTimezone: true }), lockAt: timestamp("lock_at", { withTimezone: true }), syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(), deletedAt: timestamp("deleted_at", { withTimezone: true }), ...timestamps,
}, (t) => [unique("course_folders_identity_unique").on(t.courseId, t.canvasFolderId), foreignKey({ columns: [t.ownerId, t.courseId], foreignColumns: [courses.ownerId, courses.id], name: "course_folders_tenant_course_fk" }).onDelete("cascade")]);

export const courseFiles = pgTable("course_files", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), courseId: uuid("course_id").notNull(),
  canvasFileId: text("canvas_file_id").notNull(), canvasFolderId: text("canvas_folder_id"), displayName: text("display_name").notNull(), filename: text("filename"), contentType: text("content_type"), size: bigint("size", { mode: "number" }), locked: boolean("locked").notNull().default(false), hidden: boolean("hidden").notNull().default(false), sourceCreatedAt: timestamp("source_created_at", { withTimezone: true }), sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(), deletedAt: timestamp("deleted_at", { withTimezone: true }), ...timestamps,
}, (t) => [unique("course_files_identity_unique").on(t.courseId, t.canvasFileId), foreignKey({ columns: [t.ownerId, t.courseId], foreignColumns: [courses.ownerId, courses.id], name: "course_files_tenant_course_fk" }).onDelete("cascade")]);

export const courseModules = pgTable("course_modules", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), courseId: uuid("course_id").notNull(),
  canvasModuleId: text("canvas_module_id").notNull(), name: text("name").notNull(), position: integer("position"), state: text("state"), unlockAt: timestamp("unlock_at", { withTimezone: true }), syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(), deletedAt: timestamp("deleted_at", { withTimezone: true }), ...timestamps,
}, (t) => [unique("course_modules_owner_id_id_unique").on(t.ownerId, t.id), unique("course_modules_identity_unique").on(t.courseId, t.canvasModuleId), foreignKey({ columns: [t.ownerId, t.courseId], foreignColumns: [courses.ownerId, courses.id], name: "course_modules_tenant_course_fk" }).onDelete("cascade")]);

export const courseModuleItems = pgTable("course_module_items", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), moduleId: uuid("module_id").notNull(),
  canvasModuleItemId: text("canvas_module_item_id").notNull(), title: text("title").notNull(), position: integer("position"), itemType: text("item_type"), contentCanvasId: text("content_canvas_id"), pageUrl: text("page_url"), htmlUrl: text("html_url"), completed: boolean("completed").notNull().default(false), syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(), deletedAt: timestamp("deleted_at", { withTimezone: true }), ...timestamps,
}, (t) => [unique("course_module_items_identity_unique").on(t.moduleId, t.canvasModuleItemId), foreignKey({ columns: [t.ownerId, t.moduleId], foreignColumns: [courseModules.ownerId, courseModules.id], name: "course_module_items_tenant_module_fk" }).onDelete("cascade")]);

export const coursePages = pgTable("course_pages", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), courseId: uuid("course_id").notNull(),
  canvasPageUrl: text("canvas_page_url").notNull(), title: text("title").notNull(), bodyHtml: text("body_html"), htmlUrl: text("html_url"), published: boolean("published").notNull().default(false), frontPage: boolean("front_page").notNull().default(false), sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }), syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(), deletedAt: timestamp("deleted_at", { withTimezone: true }), ...timestamps,
}, (t) => [unique("course_pages_identity_unique").on(t.courseId, t.canvasPageUrl), foreignKey({ columns: [t.ownerId, t.courseId], foreignColumns: [courses.ownerId, courses.id], name: "course_pages_tenant_course_fk" }).onDelete("cascade")]);

export const assignmentGroups = pgTable("assignment_groups", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), courseId: uuid("course_id").notNull(),
  canvasAssignmentGroupId: text("canvas_assignment_group_id").notNull(), name: text("name").notNull(), position: integer("position"), groupWeight: numeric("group_weight"), dropLowest: integer("drop_lowest").notNull().default(0), dropHighest: integer("drop_highest").notNull().default(0), neverDropCanvasIds: text("never_drop_canvas_ids").array().notNull().default([]),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(), deletedAt: timestamp("deleted_at", { withTimezone: true }), ...timestamps,
}, (t) => [unique("assignment_groups_owner_id_id_unique").on(t.ownerId, t.id), unique("assignment_groups_identity_unique").on(t.courseId, t.canvasAssignmentGroupId), foreignKey({ columns: [t.ownerId, t.courseId], foreignColumns: [courses.ownerId, courses.id], name: "assignment_groups_tenant_course_fk" }).onDelete("cascade")]);

export const assignments = pgTable("assignments", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), courseId: uuid("course_id").notNull(),
  assignmentGroupId: uuid("assignment_group_id"),
  canvasAssignmentId: text("canvas_assignment_id").notNull(), name: text("name").notNull(), descriptionHtml: text("description_html"),
  dueAt: timestamp("due_at", { withTimezone: true }), unlockAt: timestamp("unlock_at", { withTimezone: true }), lockAt: timestamp("lock_at", { withTimezone: true }),
  pointsPossible: numeric("points_possible"), submissionTypes: text("submission_types").array().notNull().default(sql`ARRAY[]::text[]`), workflowState: text("workflow_state"), gradingType: text("grading_type"),
  position: integer("position"), sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }), syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(), deletedAt: timestamp("deleted_at", { withTimezone: true }), sourcePayload: jsonb("source_payload").notNull().default({}), ...timestamps,
}, (t) => [
  unique("assignments_owner_id_id_unique").on(t.ownerId, t.id), unique("assignments_canvas_identity_unique").on(t.courseId, t.canvasAssignmentId),
  foreignKey({ columns: [t.ownerId, t.courseId], foreignColumns: [courses.ownerId, courses.id], name: "assignments_tenant_course_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.ownerId, t.assignmentGroupId], foreignColumns: [assignmentGroups.ownerId, assignmentGroups.id], name: "assignments_tenant_group_fk" }).onDelete("cascade"),
  index("assignments_owner_due_idx").on(t.ownerId, t.dueAt),
]);

export const submissions = pgTable("submissions", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), assignmentId: uuid("assignment_id").notNull(),
  canvasSubmissionId: text("canvas_submission_id"), attempt: integer("attempt").notNull().default(0), state: text("state"), submittedAt: timestamp("submitted_at", { withTimezone: true }), gradedAt: timestamp("graded_at", { withTimezone: true }),
  score: numeric("score"), grade: text("grade"), late: boolean("late").notNull().default(false), missing: boolean("missing").notNull().default(false), excused: boolean("excused").notNull().default(false),
  sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }), syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(), sourcePayload: jsonb("source_payload").notNull().default({}), ...timestamps,
}, (t) => [
  unique("submissions_assignment_attempt_unique").on(t.assignmentId, t.attempt),
  foreignKey({ columns: [t.ownerId, t.assignmentId], foreignColumns: [assignments.ownerId, assignments.id], name: "submissions_tenant_assignment_fk" }).onDelete("cascade"),
  index("submissions_owner_state_idx").on(t.ownerId, t.state),
]);

export const gradeScenarios = pgTable("grade_scenarios", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), courseId: uuid("course_id").notNull(),
  name: text("name").notNull(), hypotheticalScores: jsonb("hypothetical_scores").notNull().default({}), ...timestamps,
}, (t) => [
  unique("grade_scenarios_owner_id_id_unique").on(t.ownerId, t.id),
  foreignKey({ columns: [t.ownerId, t.courseId], foreignColumns: [courses.ownerId, courses.id], name: "grade_scenarios_tenant_course_fk" }).onDelete("cascade"),
  index("grade_scenarios_owner_course_idx").on(t.ownerId, t.courseId),
]);

export const quizzes = pgTable("quizzes", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  canvasAccountId: uuid("canvas_account_id").notNull(),
  courseId: uuid("course_id").notNull(),
  canvasQuizId: text("canvas_quiz_id").notNull(),
  canvasAssignmentId: text("canvas_assignment_id"),
  engine: text("engine").notNull().default("classic"),
  title: text("title").notNull(),
  descriptionHtml: text("description_html"),
  quizType: text("quiz_type"),
  pointsPossible: numeric("points_possible"),
  questionCount: integer("question_count"),
  timeLimitMinutes: integer("time_limit_minutes"),
  // null means Canvas did not disclose the limit; -1 means explicitly unlimited.
  allowedAttempts: integer("allowed_attempts"),
  scoringPolicy: text("scoring_policy"),
  dueAt: timestamp("due_at", { withTimezone: true }),
  unlockAt: timestamp("unlock_at", { withTimezone: true }),
  lockAt: timestamp("lock_at", { withTimezone: true }),
  published: boolean("published").notNull().default(false),
  lockedForUser: boolean("locked_for_user").notNull().default(false),
  lockExplanation: text("lock_explanation"),
  htmlUrl: text("html_url"),
  supported: boolean("supported").notNull().default(true),
  unsupportedReason: text("unsupported_reason"),
  sourcePayload: jsonb("source_payload").notNull().default({}),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  ...timestamps,
}, (t) => [
  unique("quizzes_owner_id_id_unique").on(t.ownerId, t.id),
  unique("quizzes_canvas_identity_unique").on(t.courseId, t.canvasQuizId),
  foreignKey({ columns: [t.ownerId, t.canvasAccountId], foreignColumns: [canvasAccounts.ownerId, canvasAccounts.id], name: "quizzes_tenant_account_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.ownerId, t.courseId], foreignColumns: [courses.ownerId, courses.id], name: "quizzes_tenant_course_fk" }).onDelete("cascade"),
  index("quizzes_owner_due_idx").on(t.ownerId, t.dueAt),
]);

// Quiz answers and Canvas validation tokens deliberately never enter this
// table. Canvas remains the system of record for every in-progress answer.
export const quizAttempts = pgTable("quiz_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  quizId: uuid("quiz_id").notNull(),
  canvasQuizSubmissionId: text("canvas_quiz_submission_id").notNull(),
  attempt: integer("attempt").notNull(),
  workflowState: text("workflow_state").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  endAt: timestamp("end_at", { withTimezone: true }),
  score: numeric("score"),
  keptScore: numeric("kept_score"),
  timeSpentSeconds: integer("time_spent_seconds"),
  lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
}, (t) => [
  unique("quiz_attempts_owner_id_id_unique").on(t.ownerId, t.id),
  unique("quiz_attempts_canvas_identity_unique").on(t.quizId, t.canvasQuizSubmissionId),
  foreignKey({ columns: [t.ownerId, t.quizId], foreignColumns: [quizzes.ownerId, quizzes.id], name: "quiz_attempts_tenant_quiz_fk" }).onDelete("cascade"),
  index("quiz_attempts_owner_state_idx").on(t.ownerId, t.workflowState),
]);

export const plannerItems = pgTable("planner_items", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), canvasAccountId: uuid("canvas_account_id"), courseId: uuid("course_id"), assignmentId: uuid("assignment_id"),
  source: plannerSource("source").notNull().default("app"), canvasItemType: text("canvas_item_type"), canvasItemId: text("canvas_item_id"), kind: text("kind").notNull().default("task"), title: text("title").notNull(), notes: text("notes"),
  startsAt: timestamp("starts_at", { withTimezone: true }), dueAt: timestamp("due_at", { withTimezone: true }), completedAt: timestamp("completed_at", { withTimezone: true }), status: plannerStatus("status").notNull().default("todo"), priority: integer("priority").notNull().default(0), recurrence: jsonb("recurrence"), deletedAt: timestamp("deleted_at", { withTimezone: true }), ...timestamps,
}, (t) => [
  foreignKey({ columns: [t.ownerId, t.canvasAccountId], foreignColumns: [canvasAccounts.ownerId, canvasAccounts.id], name: "planner_items_tenant_account_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.ownerId, t.courseId], foreignColumns: [courses.ownerId, courses.id], name: "planner_items_tenant_course_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.ownerId, t.assignmentId], foreignColumns: [assignments.ownerId, assignments.id], name: "planner_items_tenant_assignment_fk" }).onDelete("cascade"),
  index("planner_items_owner_due_idx").on(t.ownerId, t.status, t.dueAt),
  uniqueIndex("planner_items_canvas_identity_unique").on(t.canvasAccountId, t.canvasItemType, t.canvasItemId).where(sql`${t.source} = 'canvas'`),
]);

export const notes = pgTable("notes", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), courseId: uuid("course_id"), assignmentId: uuid("assignment_id"), title: text("title").notNull(), bodyMd: text("body_md").notNull().default(""), deletedAt: timestamp("deleted_at", { withTimezone: true }), ...timestamps,
}, (t) => [
  foreignKey({ columns: [t.ownerId, t.courseId], foreignColumns: [courses.ownerId, courses.id], name: "notes_tenant_course_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.ownerId, t.assignmentId], foreignColumns: [assignments.ownerId, assignments.id], name: "notes_tenant_assignment_fk" }).onDelete("cascade"),
  index("notes_owner_updated_idx").on(t.ownerId, t.updatedAt),
]);

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), canvasAccountId: uuid("canvas_account_id").notNull(), courseId: uuid("course_id"), canvasConversationId: text("canvas_conversation_id").notNull(), subject: text("subject"), workflowState: text("workflow_state"), lastMessageAt: timestamp("last_message_at", { withTimezone: true }), messageCount: integer("message_count").notNull().default(0), starred: boolean("starred").notNull().default(false), participants: jsonb("participants").notNull().default([]), sourcePayload: jsonb("source_payload").notNull().default({}), syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(), ...timestamps,
}, (t) => [
  unique("conversations_owner_id_id_unique").on(t.ownerId, t.id), unique("conversations_canvas_identity_unique").on(t.canvasAccountId, t.canvasConversationId),
  foreignKey({ columns: [t.ownerId, t.canvasAccountId], foreignColumns: [canvasAccounts.ownerId, canvasAccounts.id], name: "conversations_tenant_account_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.ownerId, t.courseId], foreignColumns: [courses.ownerId, courses.id], name: "conversations_tenant_course_fk" }),
  index("conversations_owner_recent_idx").on(t.ownerId, t.lastMessageAt),
]);

export const announcements = pgTable("announcements", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  canvasAccountId: uuid("canvas_account_id").notNull(),
  courseId: uuid("course_id"),
  canvasAnnouncementId: text("canvas_announcement_id").notNull(),
  title: text("title").notNull(),
  bodyHtml: text("body_html"),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  htmlUrl: text("html_url"),
  sourcePayload: jsonb("source_payload").notNull().default({}),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
}, (t) => [
  unique("announcements_owner_id_id_unique").on(t.ownerId, t.id),
  unique("announcements_canvas_identity_unique").on(t.canvasAccountId, t.canvasAnnouncementId),
  foreignKey({ columns: [t.ownerId, t.canvasAccountId], foreignColumns: [canvasAccounts.ownerId, canvasAccounts.id], name: "announcements_tenant_account_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.ownerId, t.courseId], foreignColumns: [courses.ownerId, courses.id], name: "announcements_tenant_course_fk" }),
  index("announcements_owner_time_idx").on(t.ownerId, t.postedAt),
]);

export const conversationMessages = pgTable("conversation_messages", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), conversationId: uuid("conversation_id").notNull(), canvasMessageId: text("canvas_message_id").notNull(), authorCanvasId: text("author_canvas_id"), authorName: text("author_name"), bodyHtml: text("body_html"), sentAt: timestamp("sent_at", { withTimezone: true }).notNull(), attachments: jsonb("attachments").notNull().default([]), sourcePayload: jsonb("source_payload").notNull().default({}), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("conversation_messages_identity_unique").on(t.conversationId, t.canvasMessageId),
  foreignKey({ columns: [t.ownerId, t.conversationId], foreignColumns: [conversations.ownerId, conversations.id], name: "conversation_messages_tenant_conversation_fk" }).onDelete("cascade"),
  index("conversation_messages_thread_time_idx").on(t.conversationId, t.sentAt),
]);

export const syncCursors = pgTable("sync_cursors", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), canvasAccountId: uuid("canvas_account_id").notNull(), resourceType: text("resource_type").notNull(), scopeKey: text("scope_key").notNull().default(""), cursor: jsonb("cursor"), etag: text("etag"), lastSuccessAt: timestamp("last_success_at", { withTimezone: true }), lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }), freshUntil: timestamp("fresh_until", { withTimezone: true }), lastErrorAt: timestamp("last_error_at", { withTimezone: true }), consecutiveFailures: integer("consecutive_failures").notNull().default(0), lastErrorCode: text("last_error_code"), lastErrorMessage: text("last_error_message"), ...timestamps,
}, (t) => [
  unique("sync_cursors_scope_unique").on(t.canvasAccountId, t.resourceType, t.scopeKey),
  foreignKey({ columns: [t.ownerId, t.canvasAccountId], foreignColumns: [canvasAccounts.ownerId, canvasAccounts.id], name: "sync_cursors_tenant_account_fk" }).onDelete("cascade"),
]);

export const syncPolicies = pgTable("sync_policies", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), canvasAccountId: uuid("canvas_account_id").notNull(), resourceType: text("resource_type").notNull(), scopeKey: text("scope_key").notNull().default(""), status: syncPolicyStatus("status").notNull().default("active"), intervalSeconds: integer("interval_seconds").notNull().default(900), freshnessSeconds: integer("freshness_seconds").notNull().default(1200), jitterSeconds: integer("jitter_seconds").notNull().default(30), priority: integer("priority").notNull().default(0), nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull().defaultNow(), lastEnqueuedAt: timestamp("last_enqueued_at", { withTimezone: true }), lastSuccessAt: timestamp("last_success_at", { withTimezone: true }), lastErrorAt: timestamp("last_error_at", { withTimezone: true }), lastErrorCode: text("last_error_code"), consecutiveFailures: integer("consecutive_failures").notNull().default(0), ...timestamps,
}, (t) => [
  unique("sync_policies_owner_id_id_unique").on(t.ownerId, t.id),
  unique("sync_policies_scope_unique").on(t.canvasAccountId, t.resourceType, t.scopeKey),
  foreignKey({ columns: [t.ownerId, t.canvasAccountId], foreignColumns: [canvasAccounts.ownerId, canvasAccounts.id], name: "sync_policies_tenant_account_fk" }).onDelete("cascade"),
  check("sync_policies_interval_check", sql`${t.intervalSeconds} between 60 and 604800`),
  check("sync_policies_freshness_check", sql`${t.freshnessSeconds} between 60 and 2592000`),
  index("sync_policies_due_idx").on(t.status, t.nextRunAt), index("sync_policies_owner_idx").on(t.ownerId),
]);

export const syncJobs = pgTable("sync_jobs", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), canvasAccountId: uuid("canvas_account_id").notNull(), hostedSessionId: uuid("hosted_session_id"), policyId: uuid("policy_id"), deviceId: uuid("device_id"), kind: text("kind").notNull(), scope: jsonb("scope").notNull().default({}), dedupeKey: text("dedupe_key"), status: syncJobStatus("status").notNull().default("queued"), priority: integer("priority").notNull().default(0), attempt: integer("attempt").notNull().default(0), maxAttempts: integer("max_attempts").notNull().default(5), runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(), leaseOwner: text("lease_owner"), leaseTokenHash: text("lease_token_hash"), leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }), heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }), startedAt: timestamp("started_at", { withTimezone: true }), finishedAt: timestamp("finished_at", { withTimezone: true }), errorCode: text("error_code"), errorMessage: text("error_message"), stats: jsonb("stats").notNull().default({}), ...timestamps,
}, (t) => [
  foreignKey({ columns: [t.ownerId, t.canvasAccountId], foreignColumns: [canvasAccounts.ownerId, canvasAccounts.id], name: "sync_jobs_tenant_account_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.ownerId, t.hostedSessionId], foreignColumns: [hostedBrowserSessions.ownerId, hostedBrowserSessions.id], name: "sync_jobs_tenant_session_fk" }).onDelete("set null"),
  foreignKey({ columns: [t.ownerId, t.policyId], foreignColumns: [syncPolicies.ownerId, syncPolicies.id], name: "sync_jobs_tenant_policy_fk" }).onDelete("set null"),
  foreignKey({ columns: [t.ownerId, t.deviceId], foreignColumns: [extensionDevices.ownerId, extensionDevices.id], name: "sync_jobs_tenant_device_fk" }),
  unique("sync_jobs_owner_id_id_unique").on(t.ownerId, t.id), uniqueIndex("sync_jobs_active_dedupe_unique").on(t.ownerId, t.dedupeKey).where(sql`${t.status} in ('queued', 'leased', 'running') and ${t.dedupeKey} is not null`),
  index("sync_jobs_claim_idx").on(t.status, t.runAfter, t.priority), index("sync_jobs_owner_status_idx").on(t.ownerId, t.status), index("sync_jobs_lease_expiry_idx").on(t.leaseExpiresAt),
]);

export const syncEvents = pgTable("sync_events", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), canvasAccountId: uuid("canvas_account_id").notNull(), jobId: uuid("job_id"), source: text("source").notNull(), eventType: text("event_type").notNull(), externalEventId: text("external_event_id"), payloadRedacted: jsonb("payload_redacted").notNull().default({}), receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(), processedAt: timestamp("processed_at", { withTimezone: true }), outcome: text("outcome"), errorCode: text("error_code"),
}, (t) => [
  foreignKey({ columns: [t.ownerId, t.canvasAccountId], foreignColumns: [canvasAccounts.ownerId, canvasAccounts.id], name: "sync_events_tenant_account_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.ownerId, t.jobId], foreignColumns: [syncJobs.ownerId, syncJobs.id], name: "sync_events_tenant_job_fk" }).onDelete("set null"),
  uniqueIndex("sync_events_external_unique").on(t.canvasAccountId, t.source, t.externalEventId).where(sql`${t.externalEventId} is not null`), index("sync_events_owner_time_idx").on(t.ownerId, t.receivedAt),
]);

export const operationPreviews = pgTable("operation_previews", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), canvasAccountId: uuid("canvas_account_id"), action: text("action").notNull(), requestDigest: text("request_digest").notNull(), preview: jsonb("preview").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), confirmedAt: timestamp("confirmed_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("operation_previews_owner_id_id_unique").on(t.ownerId, t.id), foreignKey({ columns: [t.ownerId, t.canvasAccountId], foreignColumns: [canvasAccounts.ownerId, canvasAccounts.id], name: "operation_previews_tenant_account_fk" }).onDelete("cascade"), index("operation_previews_expiry_idx").on(t.expiresAt)]);

export const canvasOperations = pgTable("canvas_operations", {
  id: uuid("id").primaryKey().defaultRandom(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), canvasAccountId: uuid("canvas_account_id"), deviceId: uuid("device_id"), previewId: uuid("preview_id"), action: text("action").notNull(), method: text("method").notNull(), canvasPath: text("canvas_path").notNull(), requestRedacted: jsonb("request_redacted").notNull().default({}), status: operationStatus("status").notNull().default("previewed"), idempotencyKey: text("idempotency_key").notNull(), responseStatus: integer("response_status"), responseRedacted: jsonb("response_redacted"), dispatchedAt: timestamp("dispatched_at", { withTimezone: true }), completedAt: timestamp("completed_at", { withTimezone: true }), errorCode: text("error_code"), ...timestamps,
}, (t) => [
  unique("canvas_operations_owner_id_id_unique").on(t.ownerId, t.id), unique("canvas_operations_owner_idempotency_unique").on(t.ownerId, t.idempotencyKey),
  foreignKey({ columns: [t.ownerId, t.canvasAccountId], foreignColumns: [canvasAccounts.ownerId, canvasAccounts.id], name: "canvas_operations_tenant_account_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.ownerId, t.deviceId], foreignColumns: [extensionDevices.ownerId, extensionDevices.id], name: "canvas_operations_tenant_device_fk" }),
  foreignKey({ columns: [t.ownerId, t.previewId], foreignColumns: [operationPreviews.ownerId, operationPreviews.id], name: "canvas_operations_tenant_preview_fk" }),
  index("canvas_operations_owner_recent_idx").on(t.ownerId, t.createdAt),
]);

export const idempotencyKeys = pgTable("idempotency_keys", {
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), key: text("key").notNull(), requestHash: text("request_hash").notNull(), operationId: uuid("operation_id"), state: text("state").notNull().default("processing"), responseStatus: integer("response_status"), responseBodyRedacted: jsonb("response_body_redacted"), lockedUntil: timestamp("locked_until", { withTimezone: true }), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.ownerId, t.key] }), foreignKey({ columns: [t.ownerId, t.operationId], foreignColumns: [canvasOperations.ownerId, canvasOperations.id], name: "idempotency_keys_tenant_operation_fk" }).onDelete("cascade"), index("idempotency_keys_expiry_idx").on(t.expiresAt)]);

export const auditEvents = pgTable("audit_events", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }), actorClerkUserId: text("actor_clerk_user_id"), actorType: text("actor_type").notNull(), actorDeviceId: uuid("actor_device_id"), action: text("action").notNull(), targetType: text("target_type"), targetId: text("target_id"), outcome: text("outcome").notNull(), requestId: text("request_id"), ipHash: text("ip_hash"), userAgentSummary: text("user_agent_summary"), metadataRedacted: jsonb("metadata_redacted").notNull().default({}), occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [foreignKey({ columns: [t.ownerId, t.actorDeviceId], foreignColumns: [extensionDevices.ownerId, extensionDevices.id], name: "audit_events_tenant_device_fk" }), index("audit_events_owner_time_idx").on(t.ownerId, t.occurredAt)]);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type CanvasAccount = typeof canvasAccounts.$inferSelect;
export type Course = typeof courses.$inferSelect;
export type Assignment = typeof assignments.$inferSelect;
