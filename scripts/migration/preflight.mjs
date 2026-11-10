import { lookup } from "node:dns/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cpus, platform, arch, totalmem } from "node:os";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const value = (name, fallback) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; };
const execute = has("--check");
const role = value("--role", "target");
const expectedPlatform = value("--platform", "linux/amd64");
const port = Number(value("--port", "3000"));
const publicHost = value("--hostname", "");
const docker = value("--docker", "docker");
const minimumRamGiB = Number(value("--min-ram-gib", "8"));
const requiredManifest = JSON.parse(await readFile(resolve(root, "migration/required-variables.json"), "utf8"));

const planned = [
  "Docker Engine and Compose v2 availability",
  "Buildx availability and target architecture compatibility",
  `At least ${minimumRamGiB} GiB RAM and two CPU threads`,
  `TCP port ${port} availability on loopback`,
  "Tailscale CLI availability",
  publicHost ? `DNS resolution for ${publicHost}` : "DNS check skipped until --hostname is supplied",
  has("--check-env") ? "Presence (never values) of required runtime variables" : "Required-variable presence check skipped unless --check-env is supplied",
];

if (!execute) {
  console.log(JSON.stringify({ dryRun: true, role, host: { platform: platform(), arch: arch(), cpuThreads: cpus().length, ramGiB: Number((totalmem() / 2 ** 30).toFixed(1)) }, expectedPlatform, planned, mutatesHost: false, readsSecretValues: false }));
  process.exit(0);
}

const results = [];
function record(name, ok, detail, required = true) { results.push({ name, ok, detail, required }); }
function command(program, parameters) {
  return new Promise((resolveResult) => {
    const child = spawn(program, parameters, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => resolveResult({ ok: false, output: error.code || error.message }));
    child.once("close", (code) => resolveResult({ ok: code === 0, output: (stdout || stderr).trim().split(/\r?\n/)[0]?.slice(0, 160) || `exit ${code}` }));
  });
}

for (const [name, parameters] of [["Docker Engine", ["version", "--format", "{{.Server.Version}}"]], ["Docker Compose", ["compose", "version", "--short"]], ["Docker Buildx", ["buildx", "version"]]]) {
  const result = await command(docker, parameters); record(name, result.ok, result.output);
}
const hostArch = arch() === "x64" ? "linux/amd64" : arch() === "arm64" ? "linux/arm64" : `${platform()}/${arch()}`;
record("Target architecture", ["linux/amd64", "linux/arm64"].includes(expectedPlatform), `host=${hostArch}; requested=${expectedPlatform}`);
record("CPU", cpus().length >= 2, `${cpus().length} logical CPUs`);
record("RAM", totalmem() >= minimumRamGiB * 2 ** 30, `${(totalmem() / 2 ** 30).toFixed(1)} GiB`);
const portAvailable = await new Promise((resolveResult) => {
  const server = createServer();
  server.once("error", () => resolveResult(false));
  server.listen(port, "127.0.0.1", () => server.close(() => resolveResult(true)));
});
record("Port", portAvailable, portAvailable ? `127.0.0.1:${port} is available` : `127.0.0.1:${port} is already in use`);
const tailscale = await command("tailscale", ["version"]); record("Tailscale CLI", tailscale.ok, tailscale.output, false);
if (publicHost) {
  try { const addresses = await lookup(publicHost, { all: true }); record("DNS", addresses.length > 0, `${addresses.length} address record(s)`); }
  catch (error) { record("DNS", false, error.code || "resolution failed"); }
}
if (has("--check-env")) {
  const missing = requiredManifest.required.filter((item) => !process.env[item.name]).map((item) => item.name);
  record("Required variables", missing.length === 0, missing.length ? `missing names: ${missing.join(", ")}` : `${requiredManifest.required.length} names present; values not inspected`);
}
const failed = results.filter((item) => item.required && !item.ok);
console.log(JSON.stringify({ dryRun: false, role, readsSecretValues: false, results, ready: failed.length === 0 }));
if (failed.length) process.exitCode = 1;

