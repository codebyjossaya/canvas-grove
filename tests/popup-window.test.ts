import assert from "node:assert/strict";
import test from "node:test";
import { SECURE_BROWSER_WINDOW_NAME, secureBrowserPopupFeatures } from "../lib/popup-window";

test("secure browser uses one stable named window", () => {
  assert.equal(SECURE_BROWSER_WINDOW_NAME, "canvas-grove-secure-browser");
});

test("popup size follows available screen instead of a hard-coded viewport", () => {
  assert.equal(secureBrowserPopupFeatures({ availWidth: 1920, availHeight: 1080, availLeft: 20, availTop: 10 }), "popup=yes,width=1766,height=972,left=97,top=64,resizable=yes,scrollbars=yes");
  assert.equal(secureBrowserPopupFeatures({ availWidth: 390, availHeight: 844 }), "popup=yes,width=358,height=759,left=16,top=42,resizable=yes,scrollbars=yes");
});

test("popup geometry remains usable when browser screen metadata is absent", () => {
  const features = secureBrowserPopupFeatures({});
  assert.match(features, /width=1104,height=720/);
  assert.match(features, /resizable=yes,scrollbars=yes/);
});

test("popup never requests more space than a very small available screen", () => {
  assert.equal(secureBrowserPopupFeatures({ availWidth: 280, availHeight: 320 }), "popup=yes,width=280,height=320,left=0,top=0,resizable=yes,scrollbars=yes");
});
