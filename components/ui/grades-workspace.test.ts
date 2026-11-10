import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const source = readFileSync(new URL("./grades-workspace.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./grades-workspace.module.css", import.meta.url), "utf8");
test("gradebook is cached, local-only, and supports scenario round trips", () => { assert.match(source, /\/api\/canvas\/grades/); assert.match(source, /\/scenarios\?courseId=/); assert.match(source, /Scenario saved privately/); assert.match(source, /never change Canvas/); assert.match(source, /applyScenario/); });
test("what-if preserves weighted groups, dropped work, and omitted assignments", () => { assert.match(source, /course\.summary\.weighted/); assert.match(source, /droppedAssignmentIds\.includes/); assert.match(source, /dropped \? "Dropped"/); assert.match(source, /item\.omitted \? "Omitted"/); assert.match(source, /!item\.excused && !item\.omitted/); assert.match(source, /item\.pointsPossible == null/); });
test("gradebook has bounded rows, status filters, timezone dates, and accessible inputs", () => { assert.match(source, /remaining[\s\S]*graded[\s\S]*attention/); assert.match(source, /sr-only/); assert.match(source, /useDisplayTimeZone/); assert.match(css, /max-height:min\(58vh,690px\)/); assert.match(css, /:focus-visible/); assert.match(css, /prefers-reduced-motion:reduce/); });
test("gradebook is always scoped to one explicit course", () => { assert.match(source, /courseId: string/); assert.match(source, /grades\?courseId=/); assert.doesNotMatch(source, /<select/); assert.doesNotMatch(source, /chooseCourse/); });
