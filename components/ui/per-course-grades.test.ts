import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shell = readFileSync(new URL("./app-shell.tsx", import.meta.url), "utf8");
const workspace = readFileSync(new URL("./course-workspace.tsx", import.meta.url), "utf8");
const picker = readFileSync(new URL("./grade-course-picker.tsx", import.meta.url), "utf8");
const compatibilityPage = readFileSync(new URL("../../app/(workspace)/grades/page.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../../app/api/canvas/grades/route.ts", import.meta.url), "utf8");
const service = readFileSync(new URL("../../lib/grades/service.ts", import.meta.url), "utf8");

test("global navigation does not present a combined Grades destination", () => {
  assert.doesNotMatch(shell, /href:\s*"\/grades"/);
  assert.doesNotMatch(shell, /label:\s*"Grades"/);
});

test("course workspace owns the gradebook and private What-If experience", () => {
  assert.match(workspace, /<GradesWorkspace courseId=\{courseId\} embedded/);
  assert.match(workspace, /sectionLabels[\s\S]*grades:\s*"Grades"/);
  assert.match(workspace, /`\/courses\/\$\{courseId\}\/\$\{section\}`/);
});

test("legacy Grades route is a course picker or owned-course redirect, never an aggregate", () => {
  assert.match(compatibilityPage, /GradeCoursePicker/);
  assert.match(compatibilityPage, /courses\.some\(course => course\.id === requested\)/);
  assert.match(compatibilityPage, /redirect\(`\/courses\/\$\{requested\}\/grades`\)/);
  assert.match(picker, /does not combine unrelated courses into one overall grade/);
  assert.doesNotMatch(picker, /assignment rows|overall GPA/i);
});

test("grade API and service constrain an optional course id inside tenant scope", () => {
  assert.match(api, /searchParams\.get\("courseId"\)/);
  assert.match(service, /courseId \? eq\(courses\.id, courseId\)/);
  assert.match(service, /eq\(courses\.ownerId, ctx\.ownerId\)/);
});
