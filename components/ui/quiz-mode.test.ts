import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source=readFileSync(new URL("./quiz-mode.tsx",import.meta.url),"utf8");

test("mutations use the backend idempotency contract and explicit confirmations",()=>{
  assert.match(source,/confirmStart:true/);
  assert.match(source,/confirmSubmit:true/);
  assert.match(source,/"x-idempotency-key"/);
  assert.match(source,/pendingSaves:0/);
  assert.match(source,/submitting/);
});

test("autosave queues each question, persists flags, retries, and flushes",()=>{
  assert.match(source,/new Map<string,Save>/);
  assert.match(source,/pending\.current\.get\(item\.questionId\)/);
  assert.match(source,/for\(const \[questionId,item\] of Array\.from\(pending\.current\)\)/);
  assert.match(source,/flagged/);
  assert.match(source,/Save failed/);
  assert.match(source,/async function review\(\)[\s\S]*await save/);
  assert.match(source,/async function submit\(\)[\s\S]*await save/);
});

test("active resume failure cannot create a replacement attempt",()=>{
  assert.match(source,/No new attempt will be started/);
  assert.match(source,/Canvas may have started this attempt/);
  assert.match(source,/setResumeError\(true\);setStage\("preflight"\)/);
  assert.match(source,/!resumeError&&<button/);
});

test("timer reconciles on a stable interval from the authority endpoint",()=>{
  assert.match(source,/\/attempt\/time/);
  assert.match(source,/30_000/);
  assert.match(source,/\[quizId,stage\]/);
  assert.match(source,/stage!=="taking"&&stage!=="review"/);
  assert.match(source,/not auto-submitted/);
  assert.doesNotMatch(source,/seconds===0[\s\S]*submit/);
});

test("auth errors are actionable and pending saves are guarded on navigation",()=>{
  assert.match(source,/CANVAS_AUTH_EXPIRED/);
  assert.match(source,/reconnect Canvas, then retry/);
  assert.match(source,/beforeunload/);
  assert.match(source,/visibilitychange/);
  assert.match(source,/pagehide/);
});

test("dialogs are modal, described, focus trapped, escapable, and restore focus",()=>{
  assert.match(source,/aria-modal="true"/);
  assert.match(source,/aria-describedby/);
  assert.match(source,/e\.key==="Escape"/);
  assert.match(source,/e\.key==="Tab"/);
  assert.match(source,/previous\?\.focus/);
  assert.match(source,/stage==="review"&&!submitOpen&&<Review/);
  assert.match(source,/closeRef=useRef\(close\)/);
  assert.match(source,/previous\?\.focus\(\)\}\},\[\]\)/);
});

test("user-facing quiz text contains no encoding artifacts",()=>{
  assert.doesNotMatch(source,/â|Â/);
});

test("preflight can never remain blank or spin forever",()=>{
  assert.match(source,/12_000/);
  assert.match(source,/controller\.abort/);
  assert.match(source,/Checking Canvas\.\.\./);
  assert.match(source,/No attempt starts on this screen/);
  assert.match(source,/Retry preflight/);
  assert.match(source,/error&&!resumeError/);
  assert.doesNotMatch(source,/if\(data\.activeAttempt\)void resume/);
  assert.match(source,/Resume active attempt/);
  assert.match(source,/AbortSignal\.timeout\(15_000\)/);
});

test("hidden pre-start formats stay eligible with explicit attempt disclosure",()=>{
  assert.match(source,/formatVerification==="after_start"/);
  assert.match(source,/Formats are checked after you start/);
  assert.match(source,/Canvas will consume an attempt/);
  assert.match(source,/active attempt will continue in Canvas/);
});

test("unsupported post-start bundles preserve the attempt and leave native mode",()=>{
  assert.match(source,/data\.nativeSupported===false\?"handoff":"taking"/);
  assert.match(source,/stage==="handoff"&&active/);
  assert.match(source,/Attempt started/);
  assert.match(source,/Continue attempt in Canvas/);
  assert.match(source,/target="_blank" rel="noopener noreferrer"/);
  assert.match(source,/Quiz Mode has not selected, changed, or submitted any answers/);
});
