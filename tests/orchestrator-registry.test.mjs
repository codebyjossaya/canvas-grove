import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const server = resolve("services/browser-orchestrator/server.mjs");

async function runWithRegistry(registryPath) {
  return await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [server], {
      env: {
        ...process.env,
        PORT: "0",
        BROWSER_ORCHESTRATOR_SECRET: "registry-test-secret-that-is-long-enough",
        BROWSER_RELAY_SECRET: "registry-test-relay-secret-distinct-and-long",
        BROWSER_PUBLIC_BASE_URL: "https://canvas.example.test",
        BROWSER_REGISTRY_PATH: registryPath,
        BROWSER_WARM_POOL_SIZE: "0",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolveExit({ code, stderr }));
  });
}

test("orchestrator fails closed when its durable registry is corrupt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-registry-"));
  const registry = join(directory, "registry.json");
  await writeFile(registry, "not-json", "utf8");
  const result = await runWithRegistry(registry);
  assert.notEqual(result.code, 0);
  assert.equal(result.stderr, "");
});

test("orchestrator fails closed when its registry path cannot be read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-registry-"));
  const registryDirectory = join(directory, "registry.json");
  await mkdir(registryDirectory);
  const result = await runWithRegistry(registryDirectory);
  assert.notEqual(result.code, 0);
  assert.equal(result.stderr, "");
});
