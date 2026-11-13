import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { executeCanvasSyncJob } from "../lib/sync/executor";
import type { CanvasApi } from "../lib/canvas/session-client";

test("quiz inventory crawl is GET-only, paginated, and includes latest submission summaries", async () => {
  const calls: Array<{ method: string; path: string }> = [];
  const api: CanvasApi = {
    request: async (request) => {
      calls.push(request);
      const page = (data: unknown) => ({ ok: true, status: 200, authRequired: false, data, hasLinkHeader: true });
      if (request.path.includes("/courses?")) return page([{ id: 101, name: "Marketing" }]);
      if (request.path.includes("/courses/101/quizzes?")) return page([{ id: 8, title: "Quiz 08", assignment_id: 80 }]);
      if (request.path.includes("/courses/101/assignments?")) return page([]);
      if (request.path.includes("/quizzes/8/submission")) return page({ quiz_submissions: [{ id: 800, attempt: 1, workflow_state: "untaken" }] });
      throw new Error(`Unexpected request ${request.path}`);
    },
  };
  const result = await executeCanvasSyncJob({ kind: "quizzes", api });
  assert.equal(result.ok, true);
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.ok(calls.some((call) => call.path.includes("per_page=100")));
  assert.match(JSON.stringify(result.records), /Quiz 08/);
  assert.doesNotMatch(JSON.stringify(result.records), /validation_token|quiz_submission_questions/);
});

test("quiz hub is DB-first stale-while-revalidate", () => {
  const route = readFileSync(new URL("../app/api/canvas/quizzes/route.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../lib/quizzes/service.ts", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../scripts/sync-worker.ts", import.meta.url), "utf8");
  const catalog = readFileSync(new URL("../lib/sync/catalog.ts", import.meta.url), "utf8");
  assert.match(route, /getQuizHubData/);
  assert.match(route, /refresh.*=== "1"/);
  assert.match(service, /listQuizSummaries\(ctx, false\)/);
  assert.match(service, /if \(!options\.live\)[\s\S]*formatVerification: "after_start"/);
  assert.match(service, /getQuizPreflight\(ctx, quizId, \{ live: true \}\)/);
  assert.match(service, /freshness:/);
  assert.match(service, /dedupeKey: `\$\{canvasAccountId\}:quizzes`/);
  assert.match(worker, /job\.kind === "quizzes"/);
  assert.match(worker, /quiz_attempts/);
  assert.doesNotMatch(worker, /validation_token/);
  assert.match(catalog, /quizzes: \{ intervalMs: 15 \* 60_000/);
  assert.match(catalog, /QUIZ_ATTEMPT_RESYNC_SECONDS = 60;/);
  assert.doesNotMatch(worker, /24 hours/, "a 24h deadline window kept quizzes on a 60s sweep all day");
});
