import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AUTO_CATEGORIES } from "../lib/mcp/categories";
import { syncPolicies, type SyncKind } from "../lib/sync/catalog";
import {
  DATA_SCOPES, DATA_SCOPE_INFO, DEFAULT_SCOPES, REQUIRED_SCOPES, disabledSyncKinds, isSyncKindAllowed, normalizeDataScopes, scopeForSyncKind,
} from "../lib/scopes/catalog";
import {
  agentDefaultAllowsActions, blockedScopeForTool, gatesFromRow, onboardingGatesMet, parseScopeSettingsBody, redactForScopes, SCOPE_DISABLED,
  ScopeDisabledError, scopeSettingsFromRow, storedAgentDefaults, storedDataScopes, TOOL_DATA_SCOPE,
} from "../lib/scopes/settings";

const allKinds = Object.keys(syncPolicies) as SyncKind[];

test("catalog: every scope has copy and every sync kind belongs to exactly one scope", () => {
  assert.deepEqual(Object.keys(DATA_SCOPE_INFO).sort(), [...DATA_SCOPES].sort());
  for (const scope of DATA_SCOPES) {
    const info = DATA_SCOPE_INFO[scope];
    assert.ok(info.label && info.description && info.detail, scope);
    assert.doesNotMatch(`${info.label} ${info.description} ${info.detail}`, /!/, `${scope} copy has no exclamation marks`);
  }
  const owners = allKinds.map((kind) => DATA_SCOPES.filter((scope) => DATA_SCOPE_INFO[scope].syncKinds.includes(kind)));
  for (const [index, list] of owners.entries()) assert.equal(list.length, 1, `${allKinds[index]} is covered once`);
  assert.deepEqual(DATA_SCOPE_INFO.courses.syncKinds, ["courses", "favorites"]);
  assert.deepEqual(DATA_SCOPE_INFO.assignments.syncKinds, ["assignments", "planner"]);
  assert.deepEqual(DATA_SCOPE_INFO.content.syncKinds, ["course_content"]);
  assert.equal(scopeForSyncKind("planner"), "assignments");
  assert.deepEqual(REQUIRED_SCOPES, ["courses"]);
});

test("catalog: defaults are everything on, agents may propose, no auto categories, never saved", () => {
  assert.deepEqual(DEFAULT_SCOPES, { data: [...DATA_SCOPES], agent: { access: "propose", autoCategories: [] }, savedAt: null });
  assert.equal(agentDefaultAllowsActions(DEFAULT_SCOPES), true);
});

test("PUT body: courses forced on, canonical order, duplicates collapsed", () => {
  const parsed = parseScopeSettingsBody({ data: ["grades", "inbox", "grades"], agent: { access: "read", autoCategories: [] } });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.data, ["courses", "grades", "inbox"]);
  assert.deepEqual(parsed.value.agent, { access: "read", autoCategories: [] });
  const empty = parseScopeSettingsBody({ data: [], agent: { access: "propose" } });
  assert.ok(empty.ok);
  assert.deepEqual(empty.value.data, ["courses"]);
});

test("PUT body: rejects unknown scopes, bad access and unknown categories", () => {
  assert.equal(parseScopeSettingsBody(null).ok, false);
  assert.equal(parseScopeSettingsBody([]).ok, false);
  assert.equal(parseScopeSettingsBody({ data: ["courses", "passwords"], agent: { access: "read" } }).ok, false);
  assert.equal(parseScopeSettingsBody({ data: "courses", agent: { access: "read" } }).ok, false);
  assert.equal(parseScopeSettingsBody({ data: ["courses"], agent: { access: "admin" } }).ok, false);
  assert.equal(parseScopeSettingsBody({ data: ["courses"] }).ok, false);
  assert.equal(parseScopeSettingsBody({ data: ["courses"], agent: { access: "propose", autoCategories: ["delete_everything"] } }).ok, false);
  assert.equal(parseScopeSettingsBody({ data: ["courses"], agent: { access: "propose", autoCategories: "quiz_entry" } }).ok, false);
});

test("PUT body: auto categories kept for propose (canonical order) and dropped for read", () => {
  const propose = parseScopeSettingsBody({ data: [...DATA_SCOPES], agent: { access: "propose", autoCategories: ["quiz_entry", "submit_assignment"] } });
  assert.ok(propose.ok);
  assert.deepEqual(propose.value.agent.autoCategories, AUTO_CATEGORIES.filter((c) => c === "quiz_entry" || c === "submit_assignment"));
  const read = parseScopeSettingsBody({ data: [...DATA_SCOPES], agent: { access: "read", autoCategories: ["quiz_entry"] } });
  assert.ok(read.ok);
  assert.deepEqual(read.value.agent.autoCategories, []);
});

test("stored rows: NULL means defaults; bad JSON falls back safely", () => {
  assert.deepEqual(storedDataScopes(null), [...DATA_SCOPES]);
  assert.deepEqual(storedDataScopes(["grades"]), ["courses", "grades"]);
  assert.deepEqual(storedDataScopes([]), ["courses"]);
  assert.deepEqual(storedAgentDefaults(null), { access: "propose", autoCategories: [] });
  assert.deepEqual(storedAgentDefaults({ access: "read", autoCategories: ["quiz_entry"] }), { access: "read", autoCategories: [] });
  assert.deepEqual(storedAgentDefaults({ access: "nope" }), { access: "propose", autoCategories: [] });
  const settings = scopeSettingsFromRow({ data_scopes: ["courses", "inbox"], agent_defaults: { access: "read" }, scopes_saved_at: "2026-11-16T12:00:00Z" });
  assert.deepEqual(settings, { data: ["courses", "inbox"], agent: { access: "read", autoCategories: [] }, savedAt: "2026-11-16T12:00:00.000Z" });
  assert.equal(scopeSettingsFromRow(undefined).savedAt, null);
});

test("sync: disabled scopes skip exactly their kinds; required kinds always run", () => {
  assert.deepEqual(disabledSyncKinds([...DATA_SCOPES]), []);
  assert.deepEqual(disabledSyncKinds(storedDataScopes(null)), []);
  const onlyCourses = disabledSyncKinds(["courses"]).sort();
  assert.deepEqual(onlyCourses, allKinds.filter((k) => k !== "courses" && k !== "favorites").sort());
  // Even a (malformed) empty list never disables the required courses kinds.
  assert.ok(!disabledSyncKinds([]).includes("courses"));
  assert.ok(!disabledSyncKinds([]).includes("favorites"));
  const noGrades = normalizeDataScopes(DATA_SCOPES.filter((s) => s !== "grades"));
  assert.deepEqual(disabledSyncKinds(noGrades), ["grades"]);
  assert.equal(isSyncKindAllowed("grades", noGrades), false);
  assert.equal(isSyncKindAllowed("planner", noGrades), true);
});

test("sync worker cancels queued jobs of disabled kinds and never enqueues them", async () => {
  const worker = await readFile("scripts/sync-worker.ts", "utf8");
  assert.match(worker, /disabledSyncKinds\(storedDataScopes\(/);
  assert.match(worker, /status='cancelled'[^`]*error_code='SCOPE_DISABLED'[^`]*status='queued' and kind in \$\{tx\(off\)\}/);
  assert.match(worker, /if \(!off\.includes\(policy\.resource_type\)\) await tx`insert into sync_jobs/);
  assert.match(worker, /j\.kind not in \$\{tx\(off\)\}/);
  const manual = await readFile("lib/sync/manual.ts", "utf8");
  assert.match(manual, /isSyncKindAllowed\(/);
});

test("MCP: tools in a disabled area are blocked with SCOPE_DISABLED naming the scope", () => {
  assert.equal(blockedScopeForTool("grades", ["courses"]), "grades");
  assert.equal(blockedScopeForTool("list_pages", ["courses"]), "content");
  assert.equal(blockedScopeForTool("list_quizzes", ["courses", "quizzes"]), null);
  assert.equal(blockedScopeForTool("list_courses", ["courses"]), null);
  assert.equal(blockedScopeForTool("search", ["courses"]), null);
  assert.equal(blockedScopeForTool("unknown_tool", ["courses"]), null);
  assert.equal(blockedScopeForTool("send_message", ["courses"]), "inbox");
  const error = new ScopeDisabledError("grades");
  assert.equal(error.code, SCOPE_DISABLED);
  assert.match(error.message, /Grades is turned off/);
  assert.match(error.message, /Settings > Data & permissions/);
  for (const scope of Object.values(TOOL_DATA_SCOPE)) if (scope) assert.ok((DATA_SCOPES as readonly string[]).includes(scope));
});

test("MCP: every read tool registered in tools.ts has a scope mapping", async () => {
  const tools = await readFile("lib/mcp/tools.ts", "utf8");
  const names = [...tools.matchAll(/server\.registerTool\("([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(names.length >= 14);
  for (const name of names) assert.ok(name in TOOL_DATA_SCOPE, `${name} mapped`);
  assert.match(tools, /if \(blocked\) throw new ScopeDisabledError\(blocked\)/);
});

test("MCP: submit_assignment_document needs assignments", () => {
  assert.equal(blockedScopeForTool("submit_assignment_document", ["courses", "content"]), "assignments");
  assert.equal(blockedScopeForTool("submit_assignment_document", ["courses", "assignments"]), null);
});

test("MCP: upload_course_document needs content", () => {
  assert.equal(blockedScopeForTool("upload_course_document", ["courses", "assignments"]), "content");
  assert.equal(blockedScopeForTool("upload_course_document", ["courses", "content"]), null);
});

test("MCP: reply_to_discussion needs content (discussions are course material)", () => {
  assert.equal(blockedScopeForTool("reply_to_discussion", ["courses", "announcements"]), "content");
  assert.equal(blockedScopeForTool("reply_to_discussion", ["courses", "content"]), null);
});

test("MCP: upload/document tools call the scope gate and return its SCOPE_DISABLED code", async () => {
  for (const [file, tool] of [["lib/mcp/course-upload.ts", "upload_course_document"], ["lib/mcp/assignment-document.ts", "submit_assignment_document"]]) {
    const source = await readFile(file, "utf8");
    assert.ok(source.includes(`await assertToolScope(auth.ctx.ownerId, "${tool}")`), file);
    assert.match(source, /error instanceof ScopeDisabledError \|\|/, file);
  }
});

test("MCP: grades off nulls every score field, other data intact", () => {
  const data = { courses: [{ name: "Bio", currentScore: 91.2, currentGrade: "A-" }], assignments: [{ name: "Lab", submission: { score: 9, grade: "9", late: false } }], attempts: [{ keptScore: 7 }] };
  assert.deepEqual(redactForScopes(data, [...DATA_SCOPES]), data);
  assert.deepEqual(redactForScopes(data, ["courses", "assignments"]), {
    courses: [{ name: "Bio", currentScore: null, currentGrade: null }], assignments: [{ name: "Lab", submission: { score: null, grade: null, late: false } }], attempts: [{ keptScore: null }],
  });
});

test("onboarding gates: extension, scopes and Canvas are required; agent is optional", () => {
  const all = { extensionPaired: true, scopesSaved: true, canvasConnected: true, agentConnected: false };
  assert.equal(onboardingGatesMet(all), true);
  for (const key of ["extensionPaired", "scopesSaved", "canvasConnected"] as const) assert.equal(onboardingGatesMet({ ...all, [key]: false }), false, key);
  assert.deepEqual(gatesFromRow({ extension_paired: true, scopes_saved: false, canvas_connected: true, agent_connected: true }), { extensionPaired: true, scopesSaved: false, canvasConnected: true, agentConnected: true });
  assert.deepEqual(gatesFromRow(undefined), { extensionPaired: false, scopesSaved: false, canvasConnected: false, agentConnected: false });
  assert.deepEqual(gatesFromRow({ extension_paired: "t" }).extensionPaired, false);
});
