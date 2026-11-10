import assert from "node:assert/strict";
import test from "node:test";
import { discoverSsoHosts, SSO_DISCOVERY_USER_AGENT } from "../lib/canvas/sso-discovery";

type Hop = { status: number; location?: string; headers?: Record<string, string> };
type Seen = Array<{ url: string; init?: RequestInit }>;

function stubFetch(routes: Record<string, Hop>, seen: Seen = []) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    const hop = routes[String(url)];
    if (!hop) throw new Error(`unexpected fetch ${String(url)}`);
    const headers = new Headers(hop.headers);
    if (hop.location) headers.set("location", hop.location);
    return new Response(hop.status === 200 ? "<html></html>" : null, { status: hop.status, headers });
  }) as typeof fetch;
}

const publicLookup = async () => [{ address: "93.184.216.34" }];

test("UF SAML link discovers the IdP host via manual redirects", async () => {
  const seen: Seen = [];
  const result = await discoverSsoHosts("https://ufl.instructure.com", "/login/saml/355", {
    lookup: publicLookup,
    fetch: stubFetch({
      "https://ufl.instructure.com/login/saml/355": { status: 302, location: "https://login.ufl.edu/idp/profile/SAML2/Redirect/SSO?SAMLRequest=abc" },
      "https://login.ufl.edu/idp/profile/SAML2/Redirect/SSO?SAMLRequest=abc": { status: 302, location: "/idp/profile/SAML2/Redirect/SSO?execution=e1s1" },
      "https://login.ufl.edu/idp/profile/SAML2/Redirect/SSO?execution=e1s1": { status: 200 },
    }, seen),
  });
  assert.deepEqual(result.hosts, ["login.ufl.edu"]);
  assert.equal(result.complete, true);
  assert.equal(seen[0].init?.redirect, "manual");
  assert.equal(new Headers(seen[0].init?.headers).get("user-agent"), SSO_DISCOVERY_USER_AGENT);
});

test("vanity Canvas host redirecting to another Canvas host includes that host", async () => {
  const result = await discoverSsoHosts("https://canvas.school.edu", "/login", {
    lookup: publicLookup,
    fetch: stubFetch({
      "https://canvas.school.edu/login": { status: 301, location: "https://school.instructure.com/login" },
      "https://school.instructure.com/login": { status: 200, headers: { "x-canvas-meta": "a=1" } },
    }),
  });
  assert.deepEqual(result.hosts, ["school.instructure.com"]);
  assert.deepEqual(result.canvasHosts, ["school.instructure.com"]);
});

test("same-origin hops are followed without being added", async () => {
  const result = await discoverSsoHosts("https://school.instructure.com", "/login", {
    lookup: publicLookup,
    fetch: stubFetch({
      "https://school.instructure.com/login": { status: 302, location: "/login/cas/7" },
      "https://school.instructure.com/login/cas/7": { status: 302, location: "https://cas.school.edu/cas/login?service=x" },
      "https://cas.school.edu/cas/login?service=x": { status: 200 },
    }),
  });
  assert.deepEqual(result.hosts, ["cas.school.edu"]);
});

test("private, http, port, credentialed and IP hops stop discovery without being fetched", async () => {
  for (const location of ["https://idp.corp.example.com/sso", "http://login.school.edu/", "https://login.school.edu:8443/", "https://u:p@login.school.edu/", "https://10.0.0.5/sso", "https://localhost/"]) {
    const fetched: Seen = [];
    const result = await discoverSsoHosts("https://school.instructure.com", "/login/saml", {
      lookup: async (host) => host === "idp.corp.example.com" ? [{ address: "10.1.2.3" }] : [{ address: "93.184.216.34" }],
      fetch: stubFetch({ "https://school.instructure.com/login/saml": { status: 302, location } }, fetched),
    });
    assert.deepEqual(result.hosts, [], location);
    assert.equal(fetched.length, 1, `never fetched ${location}`);
  }
});

test("redirect limit, network errors, timeouts and invalid paths degrade to partial results", async () => {
  const loop: Record<string, Hop> = { "https://school.instructure.com/login": { status: 302, location: "https://h0.example.com/" } };
  for (let i = 0; i < 10; i += 1) loop[`https://h${i}.example.com/`] = { status: 302, location: `https://h${i + 1}.example.com/` };
  const limited = await discoverSsoHosts("https://school.instructure.com", "/login", { lookup: publicLookup, fetch: stubFetch(loop) });
  assert.deepEqual(limited.hosts, ["h0.example.com", "h1.example.com", "h2.example.com", "h3.example.com", "h4.example.com"]);
  assert.equal(limited.complete, false);

  const failing = await discoverSsoHosts("https://school.instructure.com", "/login", { lookup: publicLookup, fetch: (async () => { throw new Error("ECONNRESET"); }) as typeof fetch });
  assert.deepEqual(failing.hosts, []);

  const started = Date.now();
  const hanging = await discoverSsoHosts("https://school.instructure.com", "/login", {
    timeoutMs: 50,
    lookup: publicLookup,
    fetch: ((_url: unknown, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch,
  });
  assert.deepEqual(hanging.hosts, []);
  assert.ok(Date.now() - started < 2000);

  const slowDns = await discoverSsoHosts("https://school.instructure.com", "/login", {
    timeoutMs: 50,
    lookup: () => new Promise(() => undefined),
    fetch: stubFetch({ "https://school.instructure.com/login": { status: 302, location: "https://idp.school.edu/" } }),
  });
  assert.deepEqual(slowDns.hosts, []);

  const badPath = await discoverSsoHosts("https://school.instructure.com", "/login/../admin", { lookup: publicLookup, fetch: stubFetch({}) });
  assert.deepEqual(badPath.hosts, []);
});
