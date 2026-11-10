import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDisplay } from "../lib/bridge/display";

test("normalizes common physical framebuffer sizes", () => {
  assert.deepEqual(normalizeDisplay({ width: 1280, height: 720, dpr: 1 }), { width: 1280, height: 720 });
  assert.deepEqual(normalizeDisplay({ width: 768, height: 432, dpr: 2 }), { width: 1536, height: 864 });
  assert.deepEqual(normalizeDisplay({ width: 1920, height: 1080, dpr: 1 }), { width: 1920, height: 1080 });
});

test("clamps oversize and maps mobile requests into the safe budget", () => {
  assert.deepEqual(normalizeDisplay({ width: 5000, height: 4000, dpr: 4 }), { width: 1350, height: 1080 });
  assert.deepEqual(normalizeDisplay({ width: 390, height: 844, dpr: 3 }), { width: 800, height: 1080 });
});

test("uses a safe fallback for malformed dimensions", () => {
  assert.deepEqual(normalizeDisplay({ width: "no", height: null, dpr: Infinity }), { width: 1280, height: 720 });
});

test("mobile requests become a portrait CSS profile whose framebuffer stays under the cap", () => {
  assert.deepEqual(normalizeDisplay({ width: 390, height: 796, dpr: 3, mobile: true }), { width: 975, height: 1990, mobile: true, cssWidth: 390, cssHeight: 796, dpr: 2.5 });
  assert.deepEqual(normalizeDisplay({ width: 360, height: 640, dpr: 3, mobile: true }), { width: 1080, height: 1920, mobile: true, cssWidth: 360, cssHeight: 640, dpr: 3 });
  // Landscape at provision time is provisioned portrait; the viewer scales to fit.
  assert.deepEqual(normalizeDisplay({ width: 800, height: 360, dpr: 2, mobile: true }), { width: 720, height: 1600, mobile: true, cssWidth: 360, cssHeight: 800, dpr: 2 });
  // Out-of-range values are clamped into the profile.
  const tiny = normalizeDisplay({ width: 200, height: 300, dpr: 0.5, mobile: true });
  assert.deepEqual(tiny, { width: 320, height: 560, mobile: true, cssWidth: 320, cssHeight: 560, dpr: 1 });
  assert.deepEqual(normalizeDisplay({ width: "x", height: 1, mobile: true }), { width: 1280, height: 720 });
  // A mobile hint is never inferred: desktop requests are unchanged.
  assert.deepEqual(normalizeDisplay({ width: 390, height: 844, dpr: 3 }), { width: 800, height: 1080 });
});
