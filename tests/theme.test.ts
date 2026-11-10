import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { isThemePreference, resolveTheme, THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from "../lib/theme";

const root = resolve(import.meta.dirname, "..");
const css = readFileSync(resolve(root, "app/theme.css"), "utf8");
const layout = readFileSync(resolve(root, "app/layout.tsx"), "utf8");
const provider = readFileSync(resolve(root, "components/ui/theme-provider.tsx"), "utf8");
const icons = readFileSync(resolve(root, "components/ui/icons.tsx"), "utf8");

function block(selector: string) {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `missing ${selector}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index++) {
    if (css[index] === "{") depth++;
    if (css[index] === "}" && --depth === 0) return css.slice(open + 1, index);
  }
  throw new Error(`unclosed ${selector}`);
}

function variables(source: string) {
  return Object.fromEntries([...source.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map(match => [match[1], match[2]]));
}

function luminance(hex: string) {
  const channels = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
}

function contrast(a: string, b: string) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + .05) / (low + .05);
}

test("theme resolution accepts only supported preferences", () => {
  assert.equal(THEME_STORAGE_KEY, "canvas-grove-theme");
  assert.equal(isThemePreference("system"), true);
  assert.equal(isThemePreference("sepia"), false);
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
});

test("prepaint script resolves storage and system preference before hydration", () => {
  assert.match(THEME_INIT_SCRIPT, /localStorage\.getItem/);
  assert.match(THEME_INIT_SCRIPT, /prefers-color-scheme: dark/);
  assert.match(THEME_INIT_SCRIPT, /dataset\.theme/);
  assert.ok(layout.indexOf("THEME_INIT_SCRIPT") < layout.indexOf("<ClerkProvider"));
  assert.match(layout, /suppressHydrationWarning/);
  assert.match(provider, /localStorage\.setItem\(THEME_STORAGE_KEY, next\)/);
  assert.match(provider, /addEventListener\("change", onSystemChange\)/);
  assert.match(provider, /addEventListener\("storage", onStorage\)/);
  assert.match(provider, /localStorage\.removeItem\(THEME_STORAGE_KEY\)/);
  assert.match(provider, /aria-label=\{label\}/);
  assert.match(provider, /title=\{label\}/);
  assert.doesNotMatch(provider, /<select/);
  assert.match(icons, /moon:/);
  assert.match(icons, /sun:/);
  assert.match(css, /\.theme-toggle \{ width: 44px; height: 44px/);
});

test("light and dark semantic palettes meet text contrast targets", () => {
  const light = variables(block(":root {"));
  const dark = variables(block(':root[data-theme="dark"]'));
  for (const [name, palette] of [["light", light], ["dark", dark]] as const) {
    for (const text of ["text-primary", "text-secondary", "text-muted"]) {
      assert.ok(contrast(palette[text], palette["surface-page"]) >= 4.5, `${name} ${text} contrast`);
    }
    assert.ok(contrast(palette["accent-on-primary"], palette["accent-primary"]) >= 4.5, `${name} primary button contrast`);
    for (const status of ["success", "warning", "danger", "info"]) {
      assert.ok(contrast(palette[`status-${status}`], palette[`status-${status}-soft`]) >= 4.5, `${name} ${status} contrast`);
    }
  }
});

test("global states, media modes, and embedded content have explicit treatment", () => {
  for (const required of ["--surface-page", "--focus-ring", "--skeleton-base", "--scrollbar-thumb", ".cl-card", "@media print", "prefers-reduced-motion", "prefers-contrast", ".embedded-viewer iframe"]) assert.ok(css.includes(required), required);
  assert.doesNotMatch(css, /filter:\s*invert/);
  assert.match(css, /iframe \{ background: #ffffff; color-scheme: normal; \}/);
});
