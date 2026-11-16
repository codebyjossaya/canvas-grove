import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EXTENSION_DOWNLOAD_URL } from "@/lib/extension/links";
import { ORIENTATION_STEPS, agentConnections, firstBlockedStep, hostOf, missingSteps, newlyConnected, resumeStep, stepIndex, type GateState } from "@/components/orientation/model";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const steps = ["welcome", "school", "extension", "scopes", "signin", "agent", "done"].map((name) => read(`../orientation/step-${name}.tsx`)).join("\n");
const shell = read("../orientation/shell.tsx");
const container = read("../orientation/orientation.tsx");
const school = { name: "Example University", domain: "example.instructure.com" };
const none: GateState = { school: null, extensionReady: false, scopesSaved: false, canvasConnected: false, agentConnected: false };

test("orientation v2 has seven steps in the agreed order, only the agent step optional", () => {
  assert.deepEqual(ORIENTATION_STEPS.map((step) => step.id), ["welcome", "school", "extension", "scopes", "signin", "agent", "done"]);
  assert.deepEqual(ORIENTATION_STEPS.filter((step) => "optional" in step && step.optional).map((step) => step.id), ["agent"]);
});

test("resume derives the step from real state, first unmet gate wins", () => {
  assert.equal(resumeStep(none), stepIndex("welcome"));
  assert.equal(resumeStep({ ...none, school }), stepIndex("extension"));
  assert.equal(resumeStep({ ...none, school, extensionReady: true }), stepIndex("scopes"));
  assert.equal(resumeStep({ ...none, school, extensionReady: true, scopesSaved: true }), stepIndex("signin"));
  assert.equal(resumeStep({ ...none, school, extensionReady: true, scopesSaved: true, canvasConnected: true }), stepIndex("agent"));
  assert.equal(resumeStep({ school, extensionReady: true, scopesSaved: true, canvasConnected: true, agentConnected: true }), stepIndex("done"));
  // Gates are ordered: a saved scope does not skip a missing extension.
  assert.equal(resumeStep({ ...none, school, scopesSaved: true, canvasConnected: true }), stepIndex("extension"));
  assert.equal(firstBlockedStep({ ...none, school, extensionReady: true }), stepIndex("scopes"));
});

test("a 409 from the server maps back to the unfinished required steps", () => {
  assert.deepEqual(missingSteps({ extensionPaired: true, scopesSaved: false, canvasConnected: false, agentConnected: false }), ["scopes", "signin"]);
  assert.deepEqual(missingSteps(undefined), []);
});

test("agent detection counts OAuth grants and used tokens that appeared after load", () => {
  const before = agentConnections({ grants: [], tokens: [{ id: "t1", name: "Unused", lastUsedAt: null }] });
  assert.equal(before.length, 0);
  const after = agentConnections({ grants: [{ id: "g1", clientName: "Claude" }], tokens: [{ id: "t1", name: "Unused", lastUsedAt: null }] });
  assert.equal(newlyConnected(before.map((item) => item.key), after)?.name, "Claude");
  assert.equal(newlyConnected(after.map((item) => item.key), after), null);
  assert.equal(newlyConnected(null, after), null);
});

test("hosts are shown without scheme or path", () => {
  assert.equal(hostOf("https://ufl.instructure.com/login"), "ufl.instructure.com");
  assert.equal(hostOf("canvas.fsu.edu"), "canvas.fsu.edu");
  assert.equal(hostOf(null), "");
});

test("orientation is unskippable apart from the agent step, and has no decorative orbit", () => {
  assert.doesNotMatch(`${steps}${shell}${container}`, /Skip for now|orientation-orbit|Enter dashboard/);
  assert.match(steps, /Set up later/);
  assert.match(container, /\/api\/onboarding/);
  assert.match(container, /status === 409/);
});

test("progress is a semantic, keyboard-navigable status with focus moving to the step heading", () => {
  assert.match(shell, /<nav[^>]+aria-label="Orientation steps"/);
  assert.match(shell, /aria-current=\{current \? "step"/);
  assert.match(shell, /Step \{step \+ 1\} of \{STEP_COUNT\}/);
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) assert.match(shell, new RegExp(key));
  assert.match(shell, /buttons\.current\[next\]\?\.focus/);
  assert.match(shell, /querySelector<HTMLHeadingElement>\("h1"\)\?\.focus/);
  assert.match(shell, /disabled=\{index > reachable\}/);
});

test("school search keeps the debounced combobox", () => {
  const source = read("../orientation/step-school.tsx");
  assert.match(source, /\/api\/canvas\/institutions\/search\?q=/);
  assert.match(source, /role="combobox"/);
  assert.match(source, /aria-activedescendant/);
  assert.match(source, /SEARCH_DEBOUNCE_MS/);
});

test("step copy has no filler, exclamation marks or generic errors", () => {
  // JSX text only: runs between tags that contain no code punctuation.
  const strings = steps.match(/>[^<>{}=;&|]{12,}</g)?.join(" ") ?? "";
  assert.doesNotMatch(strings, /!|Seamless|Unlock|Let's get|Something went wrong/i);
});

test("the extension step pins the current download", () => {
  assert.equal(EXTENSION_DOWNLOAD_URL, "/downloads/grove-for-canvas-0.4.0.zip");
});

test("orientation styles moved out of the global stylesheets", () => {
  for (const file of ["../../app/globals.css", "../../app/motion.css", "../../app/theme.css"]) {
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(css, /\.orientation[\w-]*/, file);
    assert.doesNotMatch(css, /\.orientation-school|cg-orientation/, file);
  }
});
