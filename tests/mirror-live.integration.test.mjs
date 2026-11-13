// Live integration test for the DOM-mirror sign-in renderer. NOT part of the
// unit gate (the file name contains "integration"). Requires the canvas-grove
// Compose stack with SIGNIN_RENDERER_OVERRIDE=allow on browser-orchestrator, and
// Playwright's Chromium. Never enters real credentials: typed text is fake and
// nothing is ever submitted (no Enter, no submit buttons).
//
//   node --test tests/mirror-live.integration.test.mjs
//   MIRROR_SCHOOLS=uf,yale MIRROR_VIEWPORTS=mobile node --test tests/mirror-live.integration.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = process.env.MIRROR_BASE_URL || "https://canvas-grove.tail8dc4e4.ts.net";
const OUT = process.env.MIRROR_OUT || "mirror-screenshots";
const EXE = process.env.MIRROR_CHROMIUM || undefined;
mkdirSync(OUT, { recursive: true });
const helperSource = readFileSync(new URL("./mirror-live-helper.mjs", import.meta.url), "utf8");

function helper(...args) {
  const output = execFileSync("docker", ["compose", "-p", "canvas-grove", "--env-file", ".env.docker", "exec", "-T", "-e", `MIRROR_HELPER_ARGS=${JSON.stringify(args)}`, "browser-orchestrator", "node", "--input-type=module"],
    { input: helperSource, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  return JSON.parse(output.trim().split("\n").at(-1));
}
const remote = (id, expression) => helper("eval", id, expression).value;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 20_000, step = 500) {
  const end = Date.now() + timeout;
  for (;;) { const value = await fn().catch(() => undefined); if (value) return value; if (Date.now() > end) return value; await sleep(step); }
}

export const SCHOOLS = [
  { key: "uf", origin: "https://ufl.instructure.com", hosts: ["elearning.ufl.edu", "login.ufl.edu"], click: "GatorLink", clickHost: "login.ufl.edu" },
  { key: "fsu", origin: "https://canvas.fsu.edu", hosts: ["cas.fsu.edu"] },
  { key: "usf", origin: "https://usflearn.instructure.com", hosts: [] },
  { key: "yale", origin: "https://yale.instructure.com", hosts: ["canvas.yale.edu", "secure.its.yale.edu"], click: "NetID", clickHost: "secure.its.yale.edu" },
  { key: "ucf", origin: "https://webcourses.ucf.edu", hosts: [] },
  { key: "fau", origin: "https://fau.instructure.com", hosts: ["sso.fau.edu"] },
];
const VIEWPORTS = {
  desktop: { context: { viewport: { width: 1280, height: 800 } }, display: { width: 1280, height: 800 } },
  mobile: { context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, display: { mobile: true, cssWidth: 390, cssHeight: 844, dpr: 2 } },
};
const schools = (process.env.MIRROR_SCHOOLS || SCHOOLS.map((s) => s.key).join(",")).split(",");
const viewports = (process.env.MIRROR_VIEWPORTS || "desktop,mobile").split(",");
const results = [];

/** Mean absolute luminance difference (0..1) of two PNGs, both scaled to 96x96. */
async function roughDiff(page, a, b) {
  return page.evaluate(async ([x, y]) => {
    const load = (src) => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src; });
    const lum = async (src) => { const image = await load(src); const canvas = document.createElement("canvas"); canvas.width = 96; canvas.height = 96; const context = canvas.getContext("2d"); context.drawImage(image, 0, 0, 96, 96); const data = context.getImageData(0, 0, 96, 96).data; const out = []; for (let i = 0; i < data.length; i += 4) out.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]); return out; };
    const [p, q] = await Promise.all([lum(x), lum(y)]);
    let sum = 0; for (let i = 0; i < p.length; i += 1) sum += Math.abs(p[i] - q[i]);
    return sum / p.length / 255;
  }, [a, b]);
}

async function visibleField(page) {
  const handle = await page.evaluateHandle(() => {
    const doc = document.querySelector(".mirror-frame")?.contentDocument;
    if (!doc) return null;
    const fields = [...doc.querySelectorAll("input")].filter((input) => ["text", "email", "tel"].includes(input.type) && input.offsetParent !== null && !/search|keyword|query/i.test(`${input.name} ${input.id} ${input.placeholder}`));
    return fields[0] || null;
  });
  return handle.asElement();
}

const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});
test.after(async () => {
  await browser.close();
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  console.log("RESULTS", JSON.stringify(results));
});

for (const key of schools) for (const viewportName of viewports) {
  const school = SCHOOLS.find((item) => item.key === key);
  const viewport = VIEWPORTS[viewportName];
  test(`${key} ${viewportName}: mirror renders, round-trips input, navigates, runs no local script`, { timeout: 300_000 }, async () => {
    const row = { school: key, viewport: viewportName, render: false, input: false, clickNav: school.click ? false : "n/a", noScript: false, noExternal: false };
    results.push(row);
    const { id } = helper("create", school.origin, school.hosts, viewport.display, `${school.origin}/login`);
    const context = await browser.newContext(viewport.context);
    try {
      await sleep(7_000);
      // ---- classic pixel view (reference)
      const pixelPage = await context.newPage();
      await pixelPage.goto(`${BASE}${helper("live", id).url}?renderer=pixels`);
      await until(() => pixelPage.evaluate(() => document.documentElement.dataset.state === "connected"), 25_000);
      await sleep(3_000);
      await pixelPage.screenshot({ path: `${OUT}/${key}-${viewportName}-pixels.png` });
      await pixelPage.close();

      // ---- DOM mirror
      const page = await context.newPage();
      const requests = [], frameHeaders = [];
      page.on("request", (request) => requests.push(request.url()));
      page.on("response", (response) => { if (/\/m\/frame(?:-quirks)?\.html$/.test(response.url())) frameHeaders.push(response.headers()); });
      await page.goto(`${BASE}${helper("live", id).url}?renderer=mirror`);
      const rendered = await until(() => page.evaluate(() => document.documentElement.dataset.surface === "mirror" && document.documentElement.dataset.state === "connected" && Boolean(document.querySelector(".mirror-frame")?.contentDocument?.body?.innerText.trim())), 30_000);
      await sleep(3_000);
      await page.screenshot({ path: `${OUT}/${key}-${viewportName}-mirror.png` });
      const reference = helper("shot", id).png;
      if (reference) writeFileSync(`${OUT}/${key}-${viewportName}-remote.png`, Buffer.from(reference, "base64"));
      const mirrorPng = `data:image/png;base64,${readFileSync(`${OUT}/${key}-${viewportName}-mirror.png`).toString("base64")}`;
      row.diffVsRemote = reference ? Math.round(await roughDiff(page, mirrorPng, `data:image/png;base64,${reference}`) * 1000) / 1000 : null;
      row.surface = await page.evaluate(() => document.documentElement.dataset.surface);
      row.render = Boolean(rendered) && row.surface === "mirror";
      assert.ok(row.render, "the IdP page renders as HTML in the mirror");

      // ---- no page scripts locally: no <script>, no handlers, sandbox + CSP block injected script
      const safety = await page.evaluate(async () => {
        const frame = document.querySelector(".mirror-frame"), doc = frame.contentDocument;
        const all = [...doc.querySelectorAll("*")];
        const scripts = doc.querySelectorAll("script").length;
        const handlers = all.filter((element) => [...element.attributes].some((attribute) => /^on/i.test(attribute.name))).length;
        const jsUrls = all.filter((element) => [...element.attributes].some((attribute) => /^\s*javascript:/i.test(attribute.value))).length;
        const remoteUrls = all.filter((element) => [...element.attributes].some((attribute) => ["src", "href", "srcset", "action"].includes(attribute.name) && /^https?:/i.test(attribute.value))).length;
        window.__mirrorPwned = 0;
        const image = doc.createElement("img"); image.setAttribute("src", "data:,broken"); image.setAttribute("onerror", "parent.__mirrorPwned=1"); doc.body.appendChild(image);
        const script = doc.createElement("script"); script.textContent = "parent.__mirrorPwned=2"; doc.body.appendChild(script);
        await new Promise((resolve) => setTimeout(resolve, 600));
        image.remove(); script.remove();
        return { scripts, handlers, jsUrls, remoteUrls, pwned: window.__mirrorPwned, sandbox: frame.getAttribute("sandbox") };
      });
      row.safety = safety;
      const csp = frameHeaders[0]?.["content-security-policy"] || "";
      row.noScript = safety.scripts === 0 && safety.handlers === 0 && safety.jsUrls === 0 && safety.pwned === 0 && safety.sandbox === "allow-same-origin" && /script-src 'none'/.test(csp) && /sandbox allow-same-origin/.test(csp);
      assert.ok(row.noScript, `no local script execution ${JSON.stringify(safety)} csp=${csp}`);

      // ---- click a button/link: the REMOTE navigates (never a submit of typed text)
      if (school.click) {
        const target = await page.evaluateHandle((text) => [...document.querySelector(".mirror-frame").contentDocument.querySelectorAll("a,button,[role=button]")].find((element) => element.offsetParent !== null && (element.innerText || "").trim().includes(text)) || null, school.click);
        const element = target.asElement();
        assert.ok(element, `click target "${school.click}" found`);
        if (viewportName === "mobile") await element.tap(); else await element.click();
        const host = await until(async () => { const value = remote(id, "location.hostname"); return value === school.clickHost ? value : undefined; }, 25_000, 1_000);
        await until(async () => (await visibleField(page)) !== null, 20_000);
        await sleep(2_000);
        await page.screenshot({ path: `${OUT}/${key}-${viewportName}-after-click.png` });
        row.clickNav = host === school.clickHost;
        assert.ok(row.clickNav, `remote navigated to ${school.clickHost}`);
      }

      // ---- type FAKE text into the username field; read it remotely; remote change syncs back
      const field = await until(() => visibleField(page), 20_000);
      assert.ok(field, "a visible username field exists in the mirror");
      const hints = await field.evaluate((input) => ({ type: input.type, inputmode: input.getAttribute("inputmode"), autocomplete: input.getAttribute("autocomplete") }));
      row.fieldHints = hints;
      if (viewportName === "mobile") await field.tap(); else await field.click();
      const fake = `fake-mirror-test-${key}`;
      await page.keyboard.type(fake, { delay: 35 });
      const remoteValue = await until(async () => { const value = remote(id, "(()=>{let a=document.activeElement;while(a&&a.shadowRoot&&a.shadowRoot.activeElement)a=a.shadowRoot.activeElement;return a&&'value' in a?a.value:null})()"); return value === fake ? value : undefined; }, 10_000, 700);
      remote(id, "(()=>{const a=document.activeElement;a.value=a.value.toUpperCase();a.dispatchEvent(new Event('input',{bubbles:true}));return 1})()");
      await field.evaluate((input) => input.blur());
      const echoed = await until(() => field.evaluate((input, expected) => input.value === expected, fake.toUpperCase()), 6_000);
      await page.screenshot({ path: `${OUT}/${key}-${viewportName}-typed.png` });
      remote(id, "(()=>{const a=document.activeElement;if(a&&'value' in a){a.value='';a.dispatchEvent(new Event('input',{bubbles:true}))}return 1})()");
      row.input = remoteValue === fake && Boolean(echoed);
      assert.ok(row.input, `typed text reached the remote input (${remoteValue}) and the remote change came back (${echoed})`);

      // ---- the client never contacted a non-app host
      const external = requests.filter((url) => !url.startsWith(`${BASE}/`) && !/^(?:data|about|blob):/.test(url));
      row.requests = requests.length;
      row.external = external.slice(0, 5);
      row.noExternal = external.length === 0;
      assert.equal(external.length, 0, `no direct requests to non-app hosts: ${external.slice(0, 5).join(", ")}`);
      await page.close();
    } finally {
      await context.close().catch(() => undefined);
      helper("delete", id);
    }
  });
}
