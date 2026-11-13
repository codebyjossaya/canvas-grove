import assert from "node:assert/strict";
import test from "node:test";
import { assignmentHref, isUuid, renderCanvasHtml, submissionLabel } from "../lib/views/assignment-detail-core";

const ORIGIN = "https://school.instructure.com";

test("assignmentHref builds an encoded course assignment path", () => {
  assert.equal(assignmentHref("c1", "a1"), "/courses/c1/assignments/a1");
  assert.equal(assignmentHref("a/b", "x y"), "/courses/a%2Fb/assignments/x%20y");
});

test("isUuid accepts uuids only", () => {
  assert.equal(isUuid("0b9f1c52-3c53-4d3a-9d63-0a7a1c2b3d4e"), true);
  assert.equal(isUuid("y"), false);
});

test("sanitization strips scripts, handlers, javascript urls and styles", () => {
  const html = renderCanvasHtml("<p onclick=\"x()\" style=\"position:fixed\">Hi</p><script>alert(1)</script><img src=\"/a.png\" onerror=\"alert(1)\"><a href=\"javascript:alert(1)\">bad</a><iframe src=\"https://e.com\"></iframe>", ORIGIN);
  assert.ok(!/<script|onerror|onclick|javascript:|<iframe|style=/i.test(html), html);
  assert.ok(html.includes("Hi"));
});

test("relative Canvas links are absolutized; Canvas files and images go through Grove's proxy", () => {
  const html = renderCanvasHtml("<a href=\"/courses/1/pages/x\">p</a><img src=\"/files/3/preview\" alt=\"pic\"><a href=\"/courses/1/files/9/download?wrap=1\">f</a>", ORIGIN);
  assert.ok(html.includes(`href="${ORIGIN}/courses/1/pages/x" data-link="canvas"`), html);
  assert.ok(html.includes(`src="/api/canvas/files/3?inline=1"`), html);
  assert.ok(html.includes(`href="/api/canvas/files/9?inline=1" data-link="file"`), html);
  assert.ok(html.includes("target=\"_blank\"") && html.includes("rel=\"noopener noreferrer\""), html);
});

test("resolver turns Canvas links into Grove routes; theme-breaking markup is removed", () => {
  const html = renderCanvasHtml("<p style=\"color:red\" class=\"button\"><font color=\"blue\">Hi</font></p><a href=\"/courses/1/assignments/7\">a</a><img src=\"/equation_images/x%255E2\" data-equation-content=\"x^2\">", ORIGIN, (url) => url.pathname === "/courses/1/assignments/7" ? "/courses/c/assignments/a" : null);
  assert.ok(html.startsWith("<p>Hi</p>"), html);
  assert.ok(html.includes(`href="/courses/c/assignments/a" data-link="internal">`), html);
  assert.ok(!html.includes("target=\"_blank\" rel=\"noopener noreferrer\">a<"), html);
  assert.ok(html.includes(`src="/api/canvas/equation?p=%2Fequation_images%2Fx%25255E2"`), html);
});

test("non-http image and data urls are dropped", () => {
  const html = renderCanvasHtml("<img src=\"data:text/html;base64,AAAA\"><a href=\"data:text/html,x\">d</a>", ORIGIN);
  assert.ok(!html.includes("data:"), html);
});

test("empty descriptions render as an empty string", () => {
  assert.equal(renderCanvasHtml(null, ORIGIN), "");
  assert.equal(renderCanvasHtml("   ", ORIGIN), "");
  assert.equal(renderCanvasHtml(undefined, null), "");
});

test("submission label summarizes state", () => {
  assert.equal(submissionLabel(null, 10), null);
  assert.equal(submissionLabel({ state: "graded", late: false, missing: false, excused: false, submittedAt: null, score: 9, grade: "9" }, 10), "Graded: 9 / 10");
  assert.equal(submissionLabel({ state: "unsubmitted", late: false, missing: true, excused: false, submittedAt: null, score: null, grade: null }, 10), "Missing");
});
