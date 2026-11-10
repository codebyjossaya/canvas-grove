// Runs in the page's main world before any page script, in every frame.
// The hosted browser has no authenticator the user can reach, so any WebAuthn
// request could only produce a dead-end "security key / phone" dialog. Report
// passkeys as unavailable (so IdPs like Duo fall back to push/code) and reject
// any request that is made anyway with the standard NotAllowedError.
(() => {
  "use strict";
  const notAllowed = () => Promise.reject(new DOMException("Passkeys are not available in this secure browser.", "NotAllowedError"));
  const define = (target, name, value) => {
    try { Object.defineProperty(target, name, { value, configurable: false, writable: false, enumerable: false }); } catch { /* already locked */ }
  };

  const credentials = globalThis.navigator && globalThis.navigator.credentials;
  if (credentials) {
    const container = Object.getPrototypeOf(credentials);
    const originalGet = container.get, originalCreate = container.create;
    const isWebAuthn = (options) => Boolean(options && typeof options === "object" && ("publicKey" in options || options.mediation === "conditional"));
    define(container, "get", function get(options) { return isWebAuthn(options) ? notAllowed() : originalGet.call(this, options); });
    define(container, "create", function create(options) { return isWebAuthn(options) ? notAllowed() : originalCreate.call(this, options); });
  }

  const PKC = globalThis.PublicKeyCredential;
  if (PKC) {
    define(PKC, "isUserVerifyingPlatformAuthenticatorAvailable", () => Promise.resolve(false));
    define(PKC, "isConditionalMediationAvailable", () => Promise.resolve(false));
    define(PKC, "getClientCapabilities", () => Promise.resolve({ conditionalGet: false, conditionalCreate: false, hybridTransport: false, passkeyPlatformAuthenticator: false, userVerifyingPlatformAuthenticator: false }));
  }
})();
