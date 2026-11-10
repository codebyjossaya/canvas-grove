import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const args = new Set(process.argv.slice(2));
const valueAfter = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const artifactRoot = resolve(root, ".migration-artifacts");
const writeTarget = valueAfter("--write");
const fileListTarget = valueAfter("--file-list");

const excludedDirectories = new Set([".git", ".next", "node_modules", "test-results", "playwright-report", "coverage", ".clerk", ".migration-artifacts", ".rollback-oci"]);
const excludedNames = new Set([".env", ".env.local", ".env.docker", "tsconfig.tsbuildinfo"]);
const excludedSuffixes = [".pem", ".key", ".agekey", ".age", ".log", ".tsbuildinfo", ".tar"];

function portable(value) { return value.split(sep).join("/"); }
function isExcluded(path, name, directory) {
  if (directory && excludedDirectories.has(name)) return true;
  if (excludedNames.has(name)) return true;
  if (name.startsWith(".env.") && name !== ".env.example") return true;
  if (name.startsWith(".viewer-")) return true;
  if (excludedSuffixes.some((suffix) => name.endsWith(suffix))) return true;
  return portable(relative(root, path)).startsWith(".migration-artifacts/");
}

async function collect(directory, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (isExcluded(path, entry.name, entry.isDirectory())) continue;
    if (entry.isDirectory()) await collect(path, files);
    else if (entry.isFile()) files.push(path);
    else if (entry.isSymbolicLink()) throw new Error(`Refusing to package symbolic link: ${portable(relative(root, path))}`);
  }
}

function safeArtifactPath(value) {
  const target = resolve(root, value);
  if (target !== artifactRoot && !target.startsWith(`${artifactRoot}${sep}`)) throw new Error("Manifest outputs must stay inside .migration-artifacts/");
  return target;
}

const paths = [];
await collect(root, paths);
const files = [];
for (const path of paths) {
  const contents = await readFile(path);
  files.push({ path: portable(relative(root, path)), bytes: contents.length, sha256: createHash("sha256").update(contents).digest("hex") });
}
const packageSha256 = createHash("sha256").update(files.map((file) => `${file.path}\0${file.sha256}\n`).join("")).digest("hex");
const manifest = { format: "canvas-grove-migration-manifest-v1", generatedAt: new Date().toISOString(), files, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), packageSha256 };

if (writeTarget) {
  const target = safeArtifactPath(writeTarget);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
if (fileListTarget) {
  const target = safeArtifactPath(fileListTarget);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${files.map((file) => file.path).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

if (args.has("--json")) process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
else console.log(JSON.stringify({ dryRun: !writeTarget && !fileListTarget, files: files.length, totalBytes: manifest.totalBytes, packageSha256, secretFilesIncluded: false, outputs: [writeTarget, fileListTarget].filter(Boolean) }));
