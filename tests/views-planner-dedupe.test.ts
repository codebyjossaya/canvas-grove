import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanner, buildToday, buildWorkItems, isClosedForSubmission } from "../lib/views/build";
import { addDays, firstParam, isValidKey, weekRangeLabel } from "../lib/views/dates";
import type { AssignmentRow, PlannerRow, WorkspaceRows } from "../lib/views/types";

const NOW = new Date("2026-11-11T17:00:00Z"); // Wednesday
const ZONE = "America/New_York";
const COURSE = { id: "c1", name: "Chemistry", courseCode: "CHM2046", termName: null, currentScore: null, currentGrade: null, favorite: true, canvasCourseId: "565953" };

function assignment(overrides: Partial<AssignmentRow> & Pick<AssignmentRow, "id" | "name">): AssignmentRow {
  return { courseId: "c1", dueAt: null, pointsPossible: 10, submissionTypes: ["online_upload"], workflowState: "published", canvasAssignmentId: overrides.id.replace(/\D/g, "") || "1", ...overrides };
}
function planner(overrides: Partial<PlannerRow> & Pick<PlannerRow, "id" | "title">): PlannerRow {
  return { courseId: "c1", assignmentId: null, source: "canvas", kind: "assignment", startsAt: null, dueAt: null, status: "todo", canvasItemType: null, canvasItemId: null, ...overrides };
}
function rows(assignments: AssignmentRow[], plannerRows: PlannerRow[] = []): WorkspaceRows {
  return { canvasOrigin: "https://canvas.example.edu", courses: [COURSE], assignments, submissions: [], planner: plannerRows, announcements: [], conversations: [] };
}

// ---------------------------------------------------------------- Bug 1: week navigation
test("views planner: week param moves the grid forward and back, and normalizes mid-week keys", () => {
  const data = rows([assignment({ id: "a100", name: "Next week lab", dueAt: "2026-11-17T04:59:00Z" })]);
  const current = buildPlanner(data, NOW, ZONE, {});
  assert.equal(current.weekStart, "2026-11-08");
  assert.equal(current.isCurrentWeek, true);
  assert.equal(current.nextWeek, "2026-11-15");
  const next = buildPlanner(data, NOW, ZONE, { weekStart: current.nextWeek });
  assert.equal(next.weekStart, "2026-11-15");
  assert.equal(next.isCurrentWeek, false);
  assert.equal(next.weekLabel, "November 15 – 21");
  assert.equal(next.days.flatMap(day => day.items).map(item => item.title).join(), "Next week lab");
  assert.equal(buildPlanner(data, NOW, ZONE, { weekStart: next.nextWeek }).weekStart, "2026-11-22");
  assert.equal(buildPlanner(data, NOW, ZONE, { weekStart: next.prevWeek }).isCurrentWeek, true);
  assert.equal(buildPlanner(data, NOW, ZONE, { weekStart: "2026-11-18" }).weekStart, "2026-11-15");
  assert.equal(buildPlanner(data, NOW, ZONE, { weekStart: "2026-11-25", weekStartsOn: 1 }).weekStart, "2026-11-23");
});

test("views planner: repeated or array search params still select a week; labels span months", () => {
  assert.equal(firstParam(["2026-11-22", "2026-11-15"]), "2026-11-22");
  assert.equal(firstParam(undefined), undefined);
  assert.equal(isValidKey(firstParam(["2026-11-22"])), true);
  assert.equal(weekRangeLabel("2026-11-29"), "Nov 29 – Dec 5");
  // Rapid clicks step from the optimistic target, so three clicks advance three weeks.
  assert.equal([1, 2, 3].reduce(week => addDays(week, 7), "2026-11-08"), "2026-11-29");
});

// ---------------------------------------------------------------- Bug 2: duplicates
test("views dedupe: one Canvas item from assignment, quiz, event and planner feeds appears once", () => {
  const data = rows([
    assignment({ id: "a7152259", name: "LQ23", dueAt: "2026-11-13T04:59:00Z", submissionTypes: ["online_quiz"], quizId: "1616652", htmlUrl: "https://canvas.example.edu/courses/565953/assignments/7152259" }),
    // Calendar event mirrored into assignments, plus the same event as a planner item.
    assignment({ id: "e4106197", name: "Class Lecture", dueAt: "2026-11-12T18:55:00Z", submissionTypes: [], workflowState: "active", sourceType: "event", canvasAssignmentId: "4106197", htmlUrl: "https://canvas.example.edu/calendar?event_id=4106197" }),
    // Per-section copies that are indistinguishable to the student.
    assignment({ id: "a6798550", name: "Complete FAFSA", submissionTypes: ["online_upload"] }),
    assignment({ id: "a6798551", name: "Complete  FAFSA ", submissionTypes: ["online_upload"] }),
    assignment({ id: "a7303149", name: "Assignment 3", dueAt: "2026-11-14T04:59:59Z" }),
  ], [
    planner({ id: "p-quiz", title: "LQ23", kind: "quiz", canvasItemType: "quiz", canvasItemId: "1616652", dueAt: "2026-11-13T04:59:00Z" }),
    planner({ id: "p-event", title: "Class Lecture", kind: "calendar_event", canvasItemType: "calendar_event", canvasItemId: "4106197", dueAt: "2026-11-12T18:55:00Z" }),
    planner({ id: "p-event-other-day", title: "Class Lecture", kind: "calendar_event", canvasItemType: "calendar_event", canvasItemId: "4106198", dueAt: "2026-11-17T18:55:00Z" }),
    planner({ id: "p-assign", title: "Assignment 3", canvasItemType: "assignment", canvasItemId: "7303149", dueAt: "2026-11-14T04:59:59Z", status: "completed" }),
  ]);
  const naive = data.assignments.length + data.planner.length;
  const items = buildWorkItems(data, NOW);
  assert.equal(naive, 9);
  assert.deepEqual(items.map(item => item.title).sort(), ["Assignment 3", "Class Lecture", "Class Lecture", "Complete FAFSA", "LQ23"]);
  const quiz = items.find(item => item.title === "LQ23")!;
  assert.equal(quiz.id, "a7152259", "the assignment record (points, state, link) wins over the planner copy");
  assert.equal(quiz.points, 10);
  assert.equal(quiz.href, "/courses/c1/assignments/a7152259");
  const lecture = items.find(item => item.id === "e4106197")!;
  assert.equal(lecture.kind, "event");
  assert.equal(lecture.canvasUrl, "https://canvas.example.edu/calendar?event_id=4106197");
  assert.equal(items.find(item => item.title === "Assignment 3")!.state, "done", "a Canvas planner checkmark on the duplicate is kept");
  const week = buildPlanner(data, NOW, ZONE, {}).days.flatMap(day => day.items).map(item => item.title);
  assert.equal(week.filter(title => title === "LQ23").length, 1);
  assert.equal(week.filter(title => title === "Class Lecture").length, 1);
});

// ---------------------------------------------------------------- Bug 3: not-actionable overdue
test("views today: overdue shows only work Canvas still accepts", () => {
  const data = rows([
    assignment({ id: "a1", name: "Late allowed", dueAt: "2026-11-05T04:59:00Z" }),
    assignment({ id: "a2", name: "Lock passed", dueAt: "2026-11-02T04:59:59Z", lockAt: "2026-11-02T04:59:59Z" }),
    assignment({ id: "a3", name: "Locked for user", dueAt: "2026-11-03T04:59:59Z", lockedForUser: true }),
    assignment({ id: "a4", name: "Paper only", dueAt: "2026-11-06T04:59:59Z", submissionTypes: ["on_paper"] }),
    assignment({ id: "a5", name: "No submission", dueAt: "2026-11-06T04:59:59Z", submissionTypes: ["none"] }),
    assignment({ id: "a6", name: "Closed period", dueAt: "2026-11-07T04:59:59Z", inClosedGradingPeriod: true }),
    assignment({ id: "a7", name: "Lock later", dueAt: "2026-11-08T04:59:59Z", lockAt: "2026-11-20T04:59:59Z" }),
    assignment({ id: "e1", name: "Office Hours", dueAt: "2026-11-10T15:00:00Z", submissionTypes: [], workflowState: "active", sourceType: "event" }),
  ]);
  const today = buildToday(data, NOW, ZONE, { since: null });
  assert.deepEqual(today.overdue.map(item => item.title).sort(), ["Late allowed", "Lock later"]);
  // Data is filtered in the view only.
  assert.equal(buildWorkItems(data, NOW).length, 8);
});

test("views closed: locked_for_user before unlock is not treated as closed", () => {
  const nowMs = NOW.getTime();
  assert.equal(isClosedForSubmission({ dueAt: "2026-11-20T00:00:00Z", unlockAt: "2026-11-15T00:00:00Z", lockedForUser: true, submissionTypes: ["online_upload"] }, nowMs), false);
  assert.equal(isClosedForSubmission({ dueAt: "2026-11-01T00:00:00Z", lockedForUser: false, submissionTypes: ["external_tool"] }, nowMs), false);
  assert.equal(isClosedForSubmission({ dueAt: "2026-11-01T00:00:00Z", lockAt: "2026-11-11T16:59:59Z", submissionTypes: ["online_quiz"] }, nowMs), true);
});
