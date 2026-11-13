import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Static contract for the motion layer (docs/MOTION.md). Scans only the CSS this layer owns, so other
// contributors' module CSS cannot break it. Add a file here when it joins the shared motion system.
const ROOT = join(process.cwd());
const OWNED = ["app/globals.css", "app/motion.css", "app/theme.css", "components/ui/motion-preview.module.css"];
const css = Object.fromEntries(OWNED.map(file => [file, readFileSync(join(ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, match => match.includes("cg-allow-layout") ? "/*cg-allow-layout*/" : "")]));

type Declaration = { file: string; selector: string; prop: string; value: string };
function declarations(file: string): Declaration[] {
  const out: Declaration[] = [];
  for (const rule of css[file].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim();
    for (const part of rule[2].split(";")) {
      const at = part.indexOf(":");
      if (at > 0) out.push({ file, selector, prop: part.slice(0, at).trim().toLowerCase(), value: part.slice(at + 1).trim() });
    }
  }
  return out;
}
const all = OWNED.flatMap(declarations);
const motion = all.filter(item => item.prop === "transition" || item.prop === "animation" || item.prop === "transition-property");
const topLevel = (value: string) => value.split(/,(?![^(]*\))/).map(part => part.trim()).filter(Boolean);

test("no transition: all", () => {
  for (const file of OWNED) assert.doesNotMatch(css[file], /transition\s*:\s*all\b/, `${file} uses transition: all`);
  for (const item of all) assert.notEqual(item.prop === "transition-property" && item.value.trim(), "all", `${item.file} ${item.selector}`);
});

// Literal durations that are allowed because a token cannot express them (tokens are --motion-*, --dur-*, --vt-*).
const ALLOWED_MS = new Set(["0", "0.01", ".01", "60", "70", "80", "90", "100", "120", "140", "150", "200", "260", "280", "300", "320", "360", "380", "420", "520", "640", "1.55", "1.5", "1.6", "8000"]);
test("durations come from tokens or the allowlist", () => {
  const bad: string[] = [];
  for (const item of motion) {
    if (item.prop === "transition-property") continue;
    for (const match of item.value.replace(/var\([^)]*\)/g, "").matchAll(/(?<![\w.-])(\d*\.?\d+)(ms|s)\b/g)) {
      const ms = match[2] === "s" ? String(Number(match[1]) * 1000) : match[1];
      const seconds = match[2] === "s" ? match[1] : "";
      if (!ALLOWED_MS.has(ms) && !ALLOWED_MS.has(seconds)) bad.push(`${item.file} ${item.selector} -> ${match[0]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("every file that moves things is covered by a reduced-motion block", () => {
  for (const file of OWNED) {
    const moves = declarations(file).some(item => (item.prop === "transition" || item.prop === "animation" || item.prop === "transition-property") && /\b(transform|translate|scale|rotate)\b|@keyframes/.test(item.value));
    const keyframes = /@keyframes[^{]+\{[^]*?(transform|translate|scale|rotate)\s*:/.test(css[file]);
    if (moves || keyframes) assert.match(css[file], /prefers-reduced-motion\s*:\s*reduce/, `${file} moves content but has no reduced-motion block`);
  }
});

const LAYOUT = /^(width|height|min-width|min-height|max-width|max-height|top|left|right|bottom|inset|margin|margin-\w+|padding|padding-\w+|block-size|inline-size|flex-basis|gap)$/;
test("transitions and animations never target layout properties", () => {
  const bad: string[] = [];
  for (const file of OWNED) {
    for (const line of css[file].split("\n")) {
      if (line.includes("cg-allow-layout")) continue;
      for (const rule of line.matchAll(/(?:^|[;{\s])(transition(?:-property)?)\s*:\s*([^;}]+)/g)) {
        for (const part of topLevel(rule[2])) {
          const name = part.split(/\s+/)[0];
          if (LAYOUT.test(name)) bad.push(`${file}: ${name} in "${part}"`);
        }
      }
    }
    for (const frames of css[file].matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\}/g)) {
      for (const prop of frames[2].matchAll(/([\w-]+)\s*:/g)) if (LAYOUT.test(prop[1])) bad.push(`${file}: @keyframes ${frames[1]} animates ${prop[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("will-change is never global and never on the .button base", () => {
  for (const item of all.filter(entry => entry.prop === "will-change")) {
    assert.doesNotMatch(item.selector, /(^|,)\s*(\*|:root|html|body|\.button)\s*(,|$)/, `${item.file}: will-change on ${item.selector}`);
  }
});

test("hover-only effects on .button stay inside (hover: hover)", () => {
  const text = css["app/motion.css"];
  assert.match(text, /@media \(hover:hover\)\{[^]*\.button:hover/);
  const outside = text.replace(/@media \(hover:hover\)\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const offenders = [...outside.matchAll(/([^{}]+)\{[^{}]*\}/g)].map(rule => rule[1].trim()).filter(selector => /\.button/.test(selector) && /:hover/.test(selector));
  assert.deepEqual(offenders, []);
});

test("page fade-in stays within the stagger budget", () => {
  const text = css["app/motion.css"];
  const dur = Number(/--dur-enter:(\d+)ms/.exec(text)?.[1]), first = Number(/--dur-first:(\d+)ms/.exec(text)?.[1]), step = Number(/--dur-step:(\d+)ms/.exec(text)?.[1]);
  const maxIndex = Math.max(...[...text.matchAll(/--cg-i:(\d+)/g)].map(match => Number(match[1])));
  assert.ok(first <= 180, "first-load fade must be <= 180ms");
  assert.ok(dur >= 180 && dur <= 240, "enter fade must be 180-240ms");
  assert.ok(step <= 30 && dur + step * maxIndex <= 350, `total ${dur + step * maxIndex}ms exceeds 350ms`);
});

test("colours in motion rules come from tokens", () => {
  const hard = all.filter(item => item.file === "app/motion.css" && /#[0-9a-f]{3,8}\b|rgba?\(/i.test(item.value));
  assert.deepEqual(hard.map(item => `${item.selector}: ${item.prop}`), []);
});

test("sliding indicator moves with translate/scale only, snaps, and is reduced-motion safe", () => {
  const text = css["app/motion.css"];
  const rule = /\[data-slide\]::before\{[^}]*\}/.exec(text)?.[0] ?? "";
  assert.match(rule, /transition:translate [^,]+,scale /);
  assert.doesNotMatch(rule, /transition:[^;}]*(left|width|top|height)/);
  assert.match(text, /\[data-slide-snap\]::before\{transition:none\}/);
  assert.match(text, /prefers-reduced-motion:reduce\)\{[^]*\[data-slide\]::before\{transition:none!important\}/);
  const source = readFileSync(join(ROOT, "components/ui/slide-indicators.tsx"), "utf8");
  assert.match(source, /slideSnap/);
  assert.doesNotMatch(source, /style\.(left|top|width|height)\s*=/);
  assert.ok(source.length < 3200, "indicator script must stay tiny");
  assert.match(readFileSync(join(ROOT, "components/ui/shell-effects.tsx"), "utf8"), /<SlideIndicators/);
});
