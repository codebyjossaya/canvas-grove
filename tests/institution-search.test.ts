import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  CANVAS_ACCOUNT_SEARCH_URL, INSTITUTION_SEARCH_USER_AGENT, InstitutionSearchUnavailableError, normalizeInstitutionQuery, searchCanvasInstitutions,
} from "../lib/canvas/institution-search";

type Seen = Array<{ url: string; init?: RequestInit }>;
function stubFetch(body: string, status = 200, seen: Seen = []) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("proxies Canvas account search and returns safe name/domain pairs", async () => {
  const seen: Seen = [];
  const payload = [
    { id: 1, name: "University of Florida", domain: "ufl.instructure.com", authentication_provider: "saml" },
    { id: 2, name: "  Florida   A&M ", domain: "famu.instructure.com" },
    { id: 3, name: "Florida A&M", domain: "FAMU.instructure.com" },
    { id: 4, name: "Bad host", domain: "localhost" },
    { id: 5, name: "Private", domain: "10.0.0.1" },
    { id: 6, name: "With path", domain: "school.instructure.com/login" },
    { id: 7, name: "Http", domain: "http://school.instructure.com" },
    { id: 8, name: "", domain: "empty.instructure.com" },
    { id: 9, name: "No domain" },
    { id: 10, name: "Vanity", domain: "canvas.example.edu" },
  ];
  const results = await searchCanvasInstitutions("  florida  ", { fetch: stubFetch(JSON.stringify(payload), 200, seen) });
  assert.deepEqual(results, [
    { name: "University of Florida", domain: "ufl.instructure.com" },
    { name: "Florida A&M", domain: "famu.instructure.com" },
    { name: "Vanity", domain: "canvas.example.edu" },
  ]);
  assert.equal(seen[0].url, `${CANVAS_ACCOUNT_SEARCH_URL}?name=florida`);
  assert.equal(new Headers(seen[0].init?.headers).get("user-agent"), INSTITUTION_SEARCH_USER_AGENT);
  assert.equal(seen[0].init?.credentials, "omit");
  assert.ok(seen[0].init?.signal, "requests carry a timeout signal");
});

test("query is encoded, length-limited and validated", async () => {
  const seen: Seen = [];
  await searchCanvasInstitutions("A&M?name=x#y", { fetch: stubFetch("[]", 200, seen) });
  assert.equal(seen[0].url, `${CANVAS_ACCOUNT_SEARCH_URL}?name=A%26M%3Fname%3Dx%23y`);
  for (const value of ["", " a ", "x".repeat(81), null]) assert.throws(() => normalizeInstitutionQuery(value), Error, String(value));
  assert.equal(normalizeInstitutionQuery("  New\n  York  "), "New York");
});

test("caps results at ten and tolerates the while(1); prefix", async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ name: `School ${i}`, domain: `s${i}.instructure.com` }));
  const results = await searchCanvasInstitutions("school", { fetch: stubFetch(`while(1);${JSON.stringify(many)}`) });
  assert.equal(results.length, 10);
  assert.deepEqual(await searchCanvasInstitutions("school", { fetch: stubFetch(JSON.stringify({ not: "an array" })) }), []);
});

test("upstream failures surface as InstitutionSearchUnavailableError", async () => {
  await assert.rejects(searchCanvasInstitutions("florida", { fetch: stubFetch("oops", 500) }), InstitutionSearchUnavailableError);
  await assert.rejects(searchCanvasInstitutions("florida", { fetch: stubFetch("not json") }), InstitutionSearchUnavailableError);
  await assert.rejects(searchCanvasInstitutions("florida", { fetch: (async () => { throw new Error("ECONNRESET"); }) as typeof fetch }), InstitutionSearchUnavailableError);
  await assert.rejects(searchCanvasInstitutions("florida", { fetch: stubFetch(`[${"1,".repeat(200_000)}1]`) }), InstitutionSearchUnavailableError);
  await assert.rejects(searchCanvasInstitutions("florida", {
    timeoutMs: 50,
    fetch: ((_url: unknown, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch,
  }), InstitutionSearchUnavailableError);
});

test("school search route requires Clerk auth and nothing uses Canvas mobile SSO endpoints", async () => {
  const source = await readFile("app/api/canvas/institutions/search/route.ts", "utf8");
  assert.match(source, /await auth\(\)/);
  assert.match(source, /Authentication required"\), 401/);
  const libs = (await Promise.all(["lib/canvas/institution-search.ts", "lib/canvas/institution-host-discovery.ts"].map((file) => readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(libs, /sso\.canvaslms\.com/);
});
