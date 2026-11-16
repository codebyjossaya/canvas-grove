// Builds extension/dist from extension/src. The Grove origin is fixed at build time: the
// extension only ever talks to that origin plus the user's Canvas site.
//
//   node extension/build.mjs [--origin https://grove.example]   (or GROVE_ORIGIN=...)
//
// Default origin comes from extension/grove.config.json.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, "src");
const dist = join(root, "dist");

const flag = process.argv.indexOf("--origin");
const requested = (flag > 0 ? process.argv[flag + 1] : null) ?? process.env.GROVE_ORIGIN ?? JSON.parse(readFileSync(join(root, "grove.config.json"), "utf8")).groveOrigin;

function normalise(value) {
  const url = new URL(String(value));
  const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !local) throw new Error(`Grove origin must be https (or http://localhost): ${value}`);
  return url.origin;
}
const origin = normalise(requested);
// Chrome match patterns ignore ports, so http://localhost:3000 becomes http://localhost/*
const pattern = `${new URL(origin).protocol}//${new URL(origin).hostname}/*`;

export const ENTRIES = [
  "background.js", "content.js", "cookies.js", "detect.js", "ui.js",
  "popup.html", "popup.js", "popup.css", "tokens.css", "pages.css",
  "signin.html", "signin.js", "sidepanel.html", "sidepanel.js",
  "fonts", "icons",
];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const entry of ENTRIES) {
  if (!existsSync(join(src, entry))) throw new Error(`missing src/${entry}`);
  cpSync(join(src, entry), join(dist, entry), { recursive: true });
}
const manifest = readFileSync(join(src, "manifest.template.json"), "utf8").replaceAll("__GROVE_PATTERN__", pattern);
JSON.parse(manifest);
writeFileSync(join(dist, "manifest.json"), manifest);
writeFileSync(join(dist, "config.js"), `export const GROVE_ORIGIN = ${JSON.stringify(origin)};\nexport const GROVE_PATTERN = ${JSON.stringify(pattern)};\n`);
console.log(`built ${dist} for ${origin} (v${JSON.parse(manifest).version})`);
