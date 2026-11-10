import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (path) => readFileSync(new URL(`../browser/browser-image/${path}`, import.meta.url), "utf8");

test("managed Chromium policy disables the password manager and related prompts", () => {
  const policy = JSON.parse(read("chromium-policy.json"));
  assert.equal(policy.PasswordManagerEnabled, false);
  assert.equal(policy.PasswordManagerPasskeysEnabled, false);
  assert.equal(policy.PasswordLeakDetectionEnabled, false);
  assert.equal(policy.SyncDisabled, true);
  assert.equal(policy.BrowserSignin, 0);
  assert.equal(policy.TranslateEnabled, false);
});

test("Dockerfile installs the policy as a read-only managed policy and copies the extension", () => {
  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, /^COPY\s+chromium-policy\.json\s+\/etc\/chromium\/policies\/managed\/[\w.-]+\.json\s*$/m);
  assert.match(dockerfile, /chmod 0444 \/etc\/chromium\/policies\/managed\//);
  assert.match(dockerfile, /^COPY\s+no-passkeys\s+\/opt\/canvas-grove\/no-passkeys\s*$/m);
  // The policy and extension must be copied before dropping to the unprivileged user (root-owned).
  assert.ok(dockerfile.indexOf("policies/managed") < dockerfile.indexOf("USER 10001"));
  assert.ok(dockerfile.indexOf("/opt/canvas-grove/no-passkeys") < dockerfile.indexOf("USER 10001"));
});

test("no-passkeys extension is an MV3 MAIN-world content script for every frame at document_start", () => {
  const manifest = JSON.parse(read("no-passkeys/manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.content_scripts.length, 1);
  const [script] = manifest.content_scripts;
  assert.deepEqual(script.matches, ["<all_urls>"]);
  assert.deepEqual(script.js, ["no-passkeys.js"]);
  assert.equal(script.world, "MAIN");
  assert.equal(script.all_frames, true);
  assert.equal(script.run_at, "document_start");
  assert.equal(script.match_about_blank, true);
});

test("start-browser loads only the no-passkeys extension and disables hybrid passkey features", () => {
  const script = read("start-browser.sh");
  assert.match(script, /--disable-extensions-except=\/opt\/canvas-grove\/no-passkeys\b/);
  assert.match(script, /--load-extension=\/opt\/canvas-grove\/no-passkeys\b/);
  const features = script.match(/--disable-features=(\S+)/);
  assert.ok(features, "expected --disable-features");
  for (const feature of ["WebAuthenticationCable", "WebAuthenticationHybridLinking", "PasswordManagerOnboarding"]) {
    assert.ok(features[1].split(",").includes(feature), feature);
  }
});

function loadNoPasskeys() {
  const calls = [];
  class CredentialsContainer {
    get(options) { calls.push(["get", options]); return Promise.resolve("native-get"); }
    create(options) { calls.push(["create", options]); return Promise.resolve("native-create"); }
  }
  class FakeDOMException extends Error {
    constructor(message, name) { super(message); this.name = name; }
  }
  const PublicKeyCredential = {
    isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
    isConditionalMediationAvailable: () => Promise.resolve(true),
    getClientCapabilities: () => Promise.resolve({ passkeyPlatformAuthenticator: true }),
  };
  const context = { navigator: { credentials: new CredentialsContainer() }, PublicKeyCredential, DOMException: FakeDOMException, Promise, Object, Boolean };
  context.globalThis = context;
  vm.runInNewContext(read("no-passkeys/no-passkeys.js"), context);
  return { context, calls };
}

test("no-passkeys rejects WebAuthn get/create with NotAllowedError and passes other credentials through", async () => {
  const { context, calls } = loadNoPasskeys();
  const { credentials } = context.navigator;
  await assert.rejects(credentials.get({ publicKey: { challenge: new Uint8Array(1) } }), { name: "NotAllowedError" });
  await assert.rejects(credentials.get({ mediation: "conditional", publicKey: {} }), { name: "NotAllowedError" });
  await assert.rejects(credentials.create({ publicKey: { challenge: new Uint8Array(1) } }), { name: "NotAllowedError" });
  assert.deepEqual(calls, [], "WebAuthn requests must never reach the native implementation");
  assert.equal(await credentials.get({ password: true }), "native-get");
  assert.equal(await credentials.create({ password: {} }), "native-create");
  assert.equal(calls.length, 2);
});

test("no-passkeys reports no platform authenticator and its overrides cannot be reassigned", async () => {
  const { context } = loadNoPasskeys();
  const PKC = context.PublicKeyCredential;
  assert.equal(await PKC.isUserVerifyingPlatformAuthenticatorAvailable(), false);
  assert.equal(await PKC.isConditionalMediationAvailable(), false);
  const caps = await PKC.getClientCapabilities();
  assert.equal(caps.passkeyPlatformAuthenticator, false);
  assert.equal(caps.hybridTransport, false);
  const proto = Object.getPrototypeOf(context.navigator.credentials);
  const descriptor = Object.getOwnPropertyDescriptor(proto, "get");
  assert.equal(descriptor.writable, false);
  assert.equal(descriptor.configurable, false);
});
