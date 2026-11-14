import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { customEventInput, customEventRange } from "../lib/custom-events/contract";
import { zonedIso, zonedParts } from "../lib/custom-events/time";
import { buildPlanner, customEventDays } from "../lib/views/build";
import type { AssignmentRow, CustomEventRow, WorkspaceRows } from "../lib/views/types";

const NOW = new Date("2026-11-11T17:00:00Z"); // Wednesday
const ZONE = "America/New_York";
const COURSE = { id: "c1", name: "Chemistry", courseCode: "CHM2046", termName: null, currentScore: null, currentGrade: null, favorite: true, canvasCourseId: "565953" };
const COURSE_UUID = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";

function rows(assignments: AssignmentRow[] = []): WorkspaceRows {
  return { canvasOrigin: "https://canvas.example.edu", courses: [COURSE], assignments, submissions: [], planner: [], announcements: [], conversations: [] };
}
function custom(overrides: Partial<CustomEventRow> & Pick<CustomEventRow, "id" | "title">): CustomEventRow {
  return { courseId: null, notes: null, allDay: false, startsAt: null, endsAt: null, startDate: null, endDate: null, color: 0, ...overrides };
}

// ---------------------------------------------------------------- request contract
test("custom events contract: timed and all-day bodies parse and normalize", () => {
  const timed = customEventInput.parse({ title: "  Study group ", allDay: false, startsAt: "2026-11-12T19:00:00.000Z", endsAt: "2026-11-12T20:30:00.000Z", notes: "", courseId: COURSE_UUID, color: 3 });
  assert.equal(timed.title, "Study group");
  assert.equal(timed.notes, null);
  assert.equal(timed.courseId, COURSE_UUID);
  const allDay = customEventInput.parse({ title: "Trip", allDay: true, startDate: "2026-11-14", endDate: "2026-11-16" });
  assert.equal(allDay.color, 0);
  assert.equal(allDay.courseId, null);
});

test("custom events contract: rejects bad shapes, inverted times, long spans and unknown keys", () => {
  const bad = [
    { title: "", allDay: false, startsAt: "2026-11-12T19:00:00Z", endsAt: "2026-11-12T20:00:00Z" },
    { title: "x", allDay: false, startsAt: "2026-11-12T19:00:00Z", endsAt: "2026-11-12T18:00:00Z" },
    { title: "x", allDay: true, startDate: "2026-11-16", endDate: "2026-11-14" },
    { title: "x", allDay: true, startDate: "2026-11-01", endDate: "2026-12-15" },
    { title: "x", allDay: true, startDate: "2026-11-14", endDate: "2026-11-14", color: 8 },
    { title: "x", allDay: true, startDate: "2026-11-14", endDate: "2026-11-14", courseId: "not-a-uuid" },
    { title: "x", allDay: false, startDate: "2026-11-14", endDate: "2026-11-14" },
    { title: "x", allDay: true, startDate: "2026-11-14", endDate: "2026-11-14", ownerId: COURSE_UUID },
    { title: "x".repeat(201), allDay: true, startDate: "2026-11-14", endDate: "2026-11-14" },
  ];
  for (const body of bad) assert.equal(customEventInput.safeParse(body).success, false, JSON.stringify(body).slice(0, 80));
  assert.equal(customEventRange.safeParse({ from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z" }).success, true);
  assert.equal(customEventRange.safeParse({ from: "2026-12-01T00:00:00Z", to: "2026-11-01T00:00:00Z" }).success, false);
  assert.equal(customEventRange.safeParse({ from: "2026-01-01T00:00:00Z", to: "2026-12-01T00:00:00Z" }).success, false);
});

// ---------------------------------------------------------------- zone conversions for the form
test("custom events time: wall clock in the planner zone round-trips across DST", () => {
  assert.equal(zonedIso("2026-11-12", "14:30", ZONE), "2026-11-12T19:30:00.000Z"); // EST
  assert.equal(zonedIso("2026-07-01", "09:00", ZONE), "2026-07-01T13:00:00.000Z"); // EDT
  assert.equal(zonedIso("2026-11-01", "12:00", ZONE), "2026-11-01T17:00:00.000Z"); // fall-back day
  assert.equal(zonedIso("2026-11-12", "14:30", "UTC"), "2026-11-12T14:30:00.000Z");
  assert.equal(zonedIso("bad", "14:30", ZONE), null);
  assert.deepEqual(zonedParts("2026-11-12T19:30:00.000Z", ZONE), { date: "2026-11-12", time: "14:30" });
  assert.deepEqual(zonedParts("2026-11-13T04:30:00.000Z", ZONE), { date: "2026-11-12", time: "23:30" });
  assert.deepEqual(zonedParts("2026-11-13T05:00:00.000Z", ZONE), { date: "2026-11-13", time: "00:00" });
});

// ---------------------------------------------------------------- planner merge
test("custom events planner: merged into their days, kept apart from Canvas items and workload", () => {
  const data = rows([{ id: "a1", courseId: "c1", name: "Lab report", dueAt: "2026-11-13T04:59:00Z", pointsPossible: 10, submissionTypes: ["online_upload"], workflowState: "published", canvasAssignmentId: "1" }]);
  const events = [
    custom({ id: "e1", title: "Study group", startsAt: "2026-11-12T19:00:00Z", endsAt: "2026-11-12T20:00:00Z", courseId: "c1", color: 2 }),
    custom({ id: "e2", title: "Trip", allDay: true, startDate: "2026-11-13", endDate: "2026-11-15" }),
  ];
  const view = buildPlanner(data, NOW, ZONE, { customEvents: events });
  const thursday = view.days.find(day => day.key === "2026-11-12")!;
  assert.deepEqual(thursday.items.map(item => item.title), ["Lab report"]);
  assert.deepEqual(thursday.custom!.map(event => event.title), ["Study group"]);
  assert.equal(thursday.custom![0].course?.code, "CHM2046");
  assert.equal("href" in thursday.custom![0], false, "custom events carry no Canvas link");
  assert.deepEqual(view.days.filter(day => day.custom?.some(event => event.id === "e2")).map(day => day.key), ["2026-11-13", "2026-11-14"]);
  assert.equal(view.workload.reduce((sum, day) => sum + day.count, 0), 1, "workload counts Canvas work only");
  const agendaSunday = view.agenda.find(group => group.key === "2026-11-15");
  assert.ok(agendaSunday, "a day with only custom events still shows in the agenda");
  assert.deepEqual(agendaSunday.items, []);
  assert.deepEqual(view.courses.map(course => course.id), ["c1"]);
  assert.equal(buildPlanner(rows(), NOW, ZONE, { customEvents: [events[1]] }).hasAnyData, true);
  assert.equal(buildPlanner(rows(), NOW, ZONE, {}).days.every(day => day.custom?.length === 0), true);
});

test("custom events planner: timed events land on local days, late-night spans cover both", () => {
  const late = custom({ id: "e3", title: "Late", startsAt: "2026-11-13T03:30:00Z", endsAt: "2026-11-13T06:00:00Z" });
  assert.deepEqual(customEventDays(late, ZONE), ["2026-11-12", "2026-11-13"]);
  assert.deepEqual(customEventDays(late, "UTC"), ["2026-11-13"]);
});

// ---------------------------------------------------------------- isolation from Canvas and sync
function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : []; });
}

test("custom events isolation: sync, bridge and Canvas code never touch custom_events", () => {
  const paths = [...files("lib/sync"), ...files("lib/bridge"), ...files("lib/canvas"), ...files("lib/mcp"), "scripts/sync-worker.ts"];
  for (const path of paths) assert.doesNotMatch(readFileSync(path, "utf8"), /custom_events|customEvents|custom-events/, path);
  const store = readFileSync("lib/custom-events/store.ts", "utf8");
  assert.doesNotMatch(store, /@\/lib\/(canvas|bridge|sync)/, "the store never reaches Canvas");
});

test("custom events migration: forced row-level security with the tenant policy", () => {
  const sql = readFileSync("drizzle/0015_custom_events.sql", "utf8");
  assert.match(sql, /ALTER TABLE "custom_events" ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE "custom_events" FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /CREATE POLICY tenant_isolation ON "custom_events" USING \(owner_id = nullif\(current_setting\('app\.user_id', true\), ''\)::uuid\) WITH CHECK \(owner_id = nullif\(current_setting\('app\.user_id', true\), ''\)::uuid\)/);
  assert.match(sql, /ON DELETE SET NULL \("course_id"\)/, "dropping a course never deletes or orphans the owner of an event");
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: Array<{ tag: string }> };
  assert.equal(journal.entries.at(-1)?.tag, "0015_custom_events");
});
