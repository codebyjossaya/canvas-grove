import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const source = readFileSync(new URL("./course-workspace.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./course-workspace.module.css", import.meta.url), "utf8");
test("workspace loads the exact section and maps Canvas Home to the stable root", () => { assert.match(source, /courses\/\$\{courseId\}\/\$\{active\}/); assert.doesNotMatch(source, /active\s*===\s*"overview"\s*\?\s*"assignments"/); assert.match(source, /tab\.id === "home"/); assert.match(source, /section === "overview" \? `\/courses\/\$\{courseId\}`/); });
test("native resources and honest external escape hatches are all present", () => { for (const name of ["Overview", "Files", "Syllabus", "Modules", "Pages", "CourseGrades"]) assert.match(source, new RegExp(name)); assert.match(source, /tab\.type === "external"/); assert.match(source, /Open course in Canvas/); assert.match(source, /safeUrl/); assert.doesNotMatch(source, /dangerouslySetInnerHTML/); });
test("long sections are bounded, searchable, responsive, and keyboard visible", () => { assert.match(source, /Show .* more|Show more files/); assert.match(source, /type="search"/); assert.match(css, /max-height:min\(62vh,720px\)/); assert.match(css, /overflow-y:auto/); assert.match(css, /:focus-visible/); assert.match(css, /prefers-reduced-motion:reduce/); });
test("dates use the persisted canonical display timezone", () => { assert.match(source, /useDisplayTimeZone/); assert.match(source, /formatInstant/); });
