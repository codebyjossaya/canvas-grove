import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const compose = await readFile("compose.yaml", "utf8");
const migrationCompose = await readFile("compose.migration.yaml", "utf8");
const volumePolicy = JSON.parse(await readFile("migration/volume-policy.json", "utf8"));
const variables = JSON.parse(await readFile("migration/required-variables.json", "utf8"));

test("restore images are digest-overridable and every durable volume has policy", () => {
  for (const variable of ["CANVAS_GROVE_APP_IMAGE", "CANVAS_GROVE_MIGRATOR_IMAGE", "CANVAS_GROVE_WORKER_IMAGE", "CANVAS_GROVE_ORCHESTRATOR_IMAGE", "CANVAS_GROVE_BROWSER_IMAGE"])
    assert.match(migrationCompose, new RegExp(`\\$\\{${variable}:\\?`));
  const policies = new Map(volumePolicy.volumes.map((item) => [item.composeName, item.transfer]));
  assert.equal(policies.get("postgres_data"), "logical-backup-only");
  assert.equal(policies.get("browser_profiles"), "do-not-transfer");
  assert.equal(policies.get("browser_orchestrator_state"), "do-not-transfer");
});

test("database and control plane remain private in restore topology", () => {
  const postgresBlock = compose.match(/  postgres:\n([\s\S]*?)\n  migrate:/)?.[1] ?? "";
  const orchestratorBlock = compose.match(/  browser-orchestrator:\n([\s\S]*?)\n  app:/)?.[1] ?? "";
  assert.doesNotMatch(postgresBlock, /\n\s+ports:/);
  assert.doesNotMatch(orchestratorBlock, /\n\s+ports:/);
  assert.match(orchestratorBlock, /\/var\/run\/docker\.sock/);
  assert.match(compose, /browser_orchestrator_state:\/var\/lib\/canvas-grove\/state/);
});

test("restore checklist includes encrypted-state and authentication key continuity", () => {
  const required = new Set(variables.required.map((item) => item.name));
  for (const name of ["CLERK_SECRET_KEY", "BROWSER_ORCHESTRATOR_SECRET", "BROWSER_STATE_KEK", "BROWSER_STATE_KEK_ID"])
    assert.ok(required.has(name), name);
  assert.ok(variables.neverBundle.includes("browser cookies"));
  assert.ok(variables.neverBundle.includes("live-view grants"));
});
