import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { mergeDiscoveredAuthHosts } from "../lib/canvas/institution";
import { discoverInstitutionHosts, extractCanvasLoginPaths, HOST_DISCOVERY_USER_AGENT, MAX_FOLLOWED_LOGIN_LINKS } from "../lib/canvas/institution-host-discovery";

type Hop = { status: number; location?: string; html?: string; contentType?: string };
type Seen = Array<{ url: string; init?: RequestInit }>;

function stubFetch(routes: Record<string, Hop>, seen: Seen = []) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    const hop = routes[String(url)];
    if (!hop) throw new Error(`unexpected fetch ${String(url)}`);
    const headers = new Headers({ "content-type": hop.contentType ?? "text/html; charset=utf-8" });
    if (hop.location) headers.set("location", hop.location);
    return new Response(hop.status === 200 ? hop.html ?? "<html></html>" : null, { status: hop.status, headers });
  }) as typeof fetch;
}

const publicLookup = async () => [{ address: "93.184.216.34" }];

const UF_PORTAL = `<!doctype html><html><head><script>var x = '<a href="https://ufl.instructure.com/login/saml/1">Script</a>';</script></head><body>
  <!-- <a href="https://ufl.instructure.com/login/saml/2">Commented out</a> -->
  <a class="btn" href="https://ufl.instructure.com/login/saml/355"><span>Primary</span></a>
  <a href="https://ufl.instructure.com/login/saml/776">External&nbsp;ID</a>
  <a href="https://www.linkedin.com/school/university-of-florida/">LinkedIn</a>
  <a href="https://my.ufl.edu/ps/signon.html">Portal</a></body></html>`;

test("UF: portal page host plus each linked provider's IdP host", async () => {
  const seen: Seen = [];
  const result = await discoverInstitutionHosts("https://ufl.instructure.com", "/login", {
    lookup: publicLookup,
    fetch: stubFetch({
      "https://ufl.instructure.com/login": { status: 302, location: "https://elearning.ufl.edu/" },
      "https://elearning.ufl.edu/": { status: 200, html: UF_PORTAL },
      "https://ufl.instructure.com/login/saml/355": { status: 302, location: "https://login.ufl.edu/idp/profile/SAML2/Redirect/SSO?SAMLRequest=a" },
      "https://login.ufl.edu/idp/profile/SAML2/Redirect/SSO?SAMLRequest=a": { status: 200 },
      "https://ufl.instructure.com/login/saml/776": { status: 302, location: "https://ufl-linking.proxy.cirrusidentity.com/saml2/idp/SSOService.php?SAMLRequest=b" },
      "https://ufl-linking.proxy.cirrusidentity.com/saml2/idp/SSOService.php?SAMLRequest=b": { status: 200 },
    }, seen),
  });
  assert.deepEqual(result.loginPaths, ["/login/saml/355", "/login/saml/776"]);
  assert.deepEqual(result.hosts, ["elearning.ufl.edu", "login.ufl.edu", "ufl-linking.proxy.cirrusidentity.com"]);
  assert.ok(!seen.some(({ url }) => /linkedin|my\.ufl\.edu|saml\/(1|2)$/.test(url)), "unrelated links are never fetched");
  assert.equal(seen[0].init?.redirect, "manual");
  assert.equal(seen[0].init?.credentials, "omit");
  assert.equal(new Headers(seen[0].init?.headers).get("user-agent"), HOST_DISCOVERY_USER_AGENT);
});

test("Yale: http link on the Canvas host is upgraded; other Canvas tenants are ignored", async () => {
  const seen: Seen = [];
  const result = await discoverInstitutionHosts("https://yale.instructure.com", "/login", {
    lookup: publicLookup,
    fetch: stubFetch({
      "https://yale.instructure.com/login": { status: 302, location: "https://canvas.yale.edu/login" },
      "https://canvas.yale.edu/login": { status: 200, html: `
        <a href="http://yale.instructure.com/login/cas">NetID Login</a>
        <a href="https://yale.instructure.com/login/canvas">Guest Login</a>
        <a href="https://yaleonline.instructure.com/login/openid_connect">Yale Online</a>` },
      "https://yale.instructure.com/login/cas": { status: 302, location: "https://secure.its.yale.edu/cas/login?service=https%3A%2F%2Fyale.instructure.com%2Flogin%2Fcas" },
      "https://secure.its.yale.edu/cas/login?service=https%3A%2F%2Fyale.instructure.com%2Flogin%2Fcas": { status: 200 },
      "https://yale.instructure.com/login/canvas": { status: 200 },
    }, seen),
  });
  assert.deepEqual(result.loginPaths, ["/login/cas", "/login/canvas"]);
  assert.deepEqual(result.hosts, ["canvas.yale.edu", "secure.its.yale.edu"]);
  assert.ok(!seen.some(({ url }) => url.startsWith("http:") || url.includes("yaleonline")));
});

test("FSU: Canvas redirects through /login/cas straight to the CAS host", async () => {
  const result = await discoverInstitutionHosts("https://canvas.fsu.edu", "/login", {
    lookup: publicLookup,
    fetch: stubFetch({
      "https://canvas.fsu.edu/login": { status: 302, location: "https://canvas.fsu.edu/login/cas" },
      "https://canvas.fsu.edu/login/cas": { status: 302, location: "https://cas.fsu.edu/cas/login?service=x" },
      "https://cas.fsu.edu/cas/login?service=x": { status: 200, html: "<form><input name=username></form>" },
    }),
  });
  assert.deepEqual(result.hosts, ["cas.fsu.edu"]);
  assert.deepEqual(result.loginPaths, []);
});

test("USF: /login/saml -> /login/instructure -> Instructure identity host (trusted, merged last)", async () => {
  const uuidHost = "0f8e2c7a-1111-4222-8333-944455556666.iad.login.instructure.com";
  const result = await discoverInstitutionHosts("https://usflearn.instructure.com", "/login", {
    lookup: publicLookup,
    fetch: stubFetch({
      "https://usflearn.instructure.com/login": { status: 302, location: "https://usflearn.instructure.com/login/saml" },
      "https://usflearn.instructure.com/login/saml": { status: 302, location: "/login/instructure?authentication_provider=1863" },
      "https://usflearn.instructure.com/login/instructure?authentication_provider=1863": { status: 302, location: `https://${uuidHost}/` },
      [`https://${uuidHost}/`]: { status: 200, html: "<div id=root></div><script src=app.js></script>" },
    }),
  });
  assert.deepEqual(result.hosts, [uuidHost]);
  // Institution-specific hosts always take precedence over trusted identity hosts in the 8-rule list.
  const seven = Array.from({ length: 7 }, (_, i) => `h${i}.usf.edu`);
  assert.deepEqual(mergeDiscoveredAuthHosts(seven, [...result.hosts, "idp.usf.edu"], "https://usflearn.instructure.com"), [...seven, "idp.usf.edu"]);
});

test("hostile anchors are ignored: other hosts, scripts, credentials, ports, odd paths", () => {
  const html = [
    `<a href="https://evil.example/login/saml/1">Evil host</a>`,
    `<a href="https://ufl.instructure.com.evil.example/login/saml/1">Lookalike</a>`,
    `<a href="javascript:location='https://ufl.instructure.com/login/saml/1'">JS</a>`,
    `<a href=" JaVaScRiPt:alert(1)//https://ufl.instructure.com/login/saml/1">JS2</a>`,
    `<a href="ftp://ufl.instructure.com/login/saml/2">FTP</a>`,
    `<a href="https://u:p@ufl.instructure.com/login/saml/4">Creds</a>`,
    `<a href="https://ufl.instructure.com:8443/login/saml/5">Port</a>`,
    `<a href="http://ufl.instructure.com:80/login/saml/5">Http default port is fine</a>`,
    `<a href="https://ufl.instructure.com/login/../admin">Traversal</a>`,
    `<a href="https://ufl.instructure.com/login/evil/1">Unknown provider</a>`,
    `<a href="https://ufl.instructure.com/login">Plain login loops</a>`,
    `<a href="//evil.example/login/saml/6">Protocol-relative</a>`,
    `<a data-href="https://ufl.instructure.com/login/saml/7">No href</a>`,
    `<a href="https://ufl.instructure.com/login/saml/8?target=https://evil.example#x">Real</a>`,
    `<a href="https://ufl.instructure.com/login/saml/8/">Duplicate</a>`,
  ].join("\n");
  assert.deepEqual(extractCanvasLoginPaths(html, "https://elearning.ufl.edu/", "https://ufl.instructure.com"), ["/login/saml/5", "/login/saml/8"]);
});

test("at most six links are followed and at most eight hosts are kept", async () => {
  const routes: Record<string, Hop> = {
    "https://big.instructure.com/login": { status: 302, location: "https://portal.big.edu/" },
    "https://portal.big.edu/": { status: 200, html: Array.from({ length: 10 }, (_, i) => `<a href="https://big.instructure.com/login/saml/${i}">${i}</a>`).join("") },
  };
  for (let i = 0; i < 10; i += 1) {
    routes[`https://big.instructure.com/login/saml/${i}`] = { status: 302, location: `https://idp${i}.big.edu/` };
    routes[`https://idp${i}.big.edu/`] = { status: 302, location: `https://mfa${i}.big.edu/` };
    routes[`https://mfa${i}.big.edu/`] = { status: 200 };
  }
  const seen: Seen = [];
  const result = await discoverInstitutionHosts("big.instructure.com", "/login", { lookup: publicLookup, fetch: stubFetch(routes, seen) });
  assert.equal(result.loginPaths.length, MAX_FOLLOWED_LOGIN_LINKS);
  assert.equal(result.hosts.length, 8);
  assert.equal(result.hosts[0], "portal.big.edu");
  assert.ok(!seen.some(({ url }) => /saml\/(6|7|8|9)$/.test(url)));
});

test("private-IP, http and odd hops stop the walk without being fetched", async () => {
  for (const location of ["https://idp.corp.example.com/", "https://10.0.0.5/", "https://localhost/", "https://idp.school.edu:8443/", "http://idp.school.edu/"]) {
    const fetched: Seen = [];
    const result = await discoverInstitutionHosts("https://school.instructure.com", "/login", {
      lookup: async (host) => host === "idp.corp.example.com" ? [{ address: "10.1.2.3" }] : [{ address: "93.184.216.34" }],
      fetch: stubFetch({ "https://school.instructure.com/login": { status: 302, location } }, fetched),
    });
    assert.deepEqual(result.hosts, [], location);
    assert.equal(fetched.length, 1, `never fetched ${location}`);
  }
  // A private host reached via a scraped link is not collected either.
  const viaLink = await discoverInstitutionHosts("https://school.instructure.com", "/login", {
    lookup: async (host) => host === "idp.corp.example.com" ? [{ address: "192.168.0.9" }] : [{ address: "93.184.216.34" }],
    fetch: stubFetch({
      "https://school.instructure.com/login": { status: 200, html: `<a href="/login/saml/3">Sign in</a>` },
      "https://school.instructure.com/login/saml/3": { status: 302, location: "https://idp.corp.example.com/" },
    }),
  });
  assert.deepEqual(viaLink.hosts, []);
});

test("errors, timeouts, bad input, oversize and non-HTML pages degrade without throwing", async () => {
  const failing = await discoverInstitutionHosts("https://school.instructure.com", "/login", { lookup: publicLookup, fetch: (async () => { throw new Error("ECONNRESET"); }) as typeof fetch });
  assert.deepEqual(failing.hosts, []);

  const started = Date.now();
  const hanging = await discoverInstitutionHosts("https://school.instructure.com", "/login", {
    timeoutMs: 50, lookup: publicLookup,
    fetch: ((_url: unknown, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch,
  });
  assert.deepEqual(hanging.hosts, []);
  assert.ok(Date.now() - started < 2000);

  for (const [origin, path] of [["localhost", "/login"], ["http://school.instructure.com", "/login"], ["https://school.instructure.com", "/login/../admin"]])
    assert.deepEqual((await discoverInstitutionHosts(origin, path, { lookup: publicLookup, fetch: stubFetch({}) })).hosts, []);

  const big = `<p>${"x".repeat(600 * 1024)}</p><a href="/login/saml/1">Late</a>`;
  const capped = await discoverInstitutionHosts("big2.instructure.com", "/login", { lookup: publicLookup, fetch: stubFetch({ "https://big2.instructure.com/login": { status: 200, html: big } }) });
  assert.deepEqual(capped.loginPaths, []);

  const json = await discoverInstitutionHosts("json.instructure.com", "/login", { lookup: publicLookup, fetch: stubFetch({ "https://json.instructure.com/login": { status: 200, contentType: "application/json", html: `<a href="/login/saml/1">x</a>` } }) });
  assert.deepEqual(json.loginPaths, []);
});

test("session creation uses the institution host discovery and never fails on it", async () => {
  const route = await readFile("app/api/canvas/sessions/route.ts", "utf8");
  assert.match(route, /discoverInstitutionHosts\(canvasOrigin, loginPath\)\.catch\(/);
  assert.match(route, /mergeDiscoveredAuthHosts\(configuredRules, discovered\.hosts, canvasOrigin\)/);
});
