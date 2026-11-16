import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EXTENSION_DOWNLOAD_URL, EXTENSION_INSTALL_PATH } from "@/lib/extension/links";
import { ORIENTATION_STEPS } from "./orientation";

test("orientation is concise, institution-neutral, and covers the site-first extension handoff", () => {
  assert.equal(ORIENTATION_STEPS.length, 6);
  const copy = ORIENTATION_STEPS.map((step) => `${step.title} ${step.body} ${step.note}`).join(" ");
  for (const phrase of ["find your school", "required", "institution password", "multi-factor", "exact Canvas origin", "dedicated Canvas popup", "immediately closes", "background", "browser extension", "revoke"]) assert.match(copy, new RegExp(phrase, "i"));
  assert.doesNotMatch(copy, /isolated browser|remote browser|GatorLink|Duo|University of Florida|\bUF\b/i);
});

test("orientation progress is semantic and keyboard navigable", () => {
  const source = readFileSync(new URL("./orientation.tsx", import.meta.url), "utf8");
  assert.match(source, /<nav[^>]+aria-label="Orientation steps"/);
  assert.match(source, /<ol>/);
  assert.match(source, /aria-current=/);
  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) assert.match(source, new RegExp(key));
  assert.match(source, /progressButtons\.current\[next\]\?\.focus/);
  assert.match(source, /heading\.current\?\.focus/);
});

test("required extension orientation links to the real in-app installation flow", () => {
  const step = ORIENTATION_STEPS.find((item) => item.eyebrow === "Browser extension");
  assert.ok(step);
  assert.ok("installHref" in step);
  assert.equal(step.installHref, EXTENSION_INSTALL_PATH);
  assert.equal(EXTENSION_INSTALL_PATH, "/extension/connect");
  assert.equal(EXTENSION_DOWNLOAD_URL, "/downloads/grove-for-canvas-0.3.2.zip");
  assert.match(`${step.body} ${step.note}`, /required.*latest release.*unzip.*Chrome or Edge/i);
});

test("orientation has explicit skip and finish paths", () => {
  const source = readFileSync(new URL("./orientation.tsx", import.meta.url), "utf8");
  assert.match(source, /Skip for now/);
  assert.match(source, /Connect Canvas/);
  assert.match(source, /Enter dashboard/);
  assert.match(source, /settingsDestination\(\)/);
  assert.match(source, /finish\("\/"\)/);
});

test("school selection happens on the site before extension setup and pre-fills Settings", () => {
  const source = readFileSync(new URL("./orientation.tsx", import.meta.url), "utf8");
  assert.match(source, /\/api\/canvas\/institutions\/search\?q=/);
  assert.match(source, /canvasSchoolName/);
  assert.match(source, /canvasSchoolDomain/);
  assert.match(source, /step === 1 && !selectedSchool/);
  assert.match(source, /target="_blank"/);
  assert.match(source, /rel="noopener noreferrer"/);
});
