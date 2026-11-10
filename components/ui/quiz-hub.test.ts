import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const source = readFileSync(new URL("./quiz-hub.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./quiz-hub.module.css", import.meta.url), "utf8");
test("hub is a keyboard-operated pseudo-table with bounded pagination", () => { assert.match(source, /role="tablist"/); assert.match(source, /role="table"/); assert.match(source, /role="row"/); assert.match(source, /ArrowLeft/); assert.match(source, /pageSize = 10/); assert.match(source, /Page \{page \+ 1\} of \{pages\}/); assert.match(css, /max-height:min\(62vh,720px\)/); });
test("actionable excludes completed work and History owns final states", () => { assert.match(source, /quiz\.actionable/); assert.match(source, /!\["completed", "past_due", "attempts_exhausted"\]\.includes/); assert.match(source, /filter === "history"/); assert.match(source, /"completed", "past_due", "attempts_exhausted"/); });
test("unknown attempt policy is never described as unlimited", () => { assert.match(source, /Set by Canvas/); assert.match(source, /quiz\.attemptsUnlimited/); assert.match(source, /quiz\.attemptsKnown === false/); });
test("cached refresh preserves rows and uses persisted timezone display", () => { assert.match(source, /freshness\?\.refreshing/); assert.match(source, /\?refresh=1/); assert.match(source, /3_000/); assert.match(source, /Saved quiz data is unchanged/); assert.doesNotMatch(source, /setQuizzes\(\[\]\)/); assert.match(source, /useDisplayTimeZone/); assert.match(css, /prefers-reduced-motion:reduce/); });
