// Shared helpers for extension pages (popup, sign-in interstitial, side panel).

export const $ = (id) => document.getElementById(id);

/** Message the background worker; resolves null if it is unreachable. */
export const ask = (message) => new Promise((resolve) => {
  try { chrome.runtime.sendMessage(message, (reply) => resolve(chrome.runtime.lastError ? null : reply ?? null)); }
  catch { resolve(null); }
});

export function hostOf(origin) {
  try { return new URL(origin).host; } catch { return String(origin ?? ""); }
}

/** Shows the section whose data-view is `name`, hides its siblings. */
export function show(name) {
  for (const view of document.querySelectorAll("[data-view]")) view.hidden = view.dataset.view !== name;
}

/** Stage changes pushed by the background worker for one sign-in attempt. */
export function onSigninEvent(sessionId, listener) {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender?.id === chrome.runtime.id && message?.type === "signin-event" && message.status?.sessionId === sessionId) listener(message.status);
  });
}

/** Stable reason codes -> one plain sentence. Keep in step with the website's reasonMessage(). */
export function reasonText(reason, host) {
  const code = String(reason ?? "");
  if (code === "permission-denied") return `Chrome didn't allow access to ${host}. Grove needs it to confirm which Canvas account signed in.`;
  if (code === "expired") return "This sign-in was open for more than 30 minutes, so it stopped. Start again from Grove.";
  if (code === "revoked" || code === "not-paired") return "This browser is no longer connected to Grove. Reconnect it in Grove, then sign in again.";
  if (code === "session-cookie-missing") return `Canvas accepted the sign-in but didn't give ${host} a session Grove can use. Sign in again.`;
  if (code === "network") return "Grove couldn't be reached to save the session. Check your connection, then start again from Grove.";
  if (code === "replaced") return "A newer sign-in started from Grove, so this one stopped.";
  if (code === "tab-closed") return "The sign-in tab was closed. Start again from Grove.";
  if (code.startsWith("capture-rejected")) {
    const detail = code.split(":")[1];
    return `Grove couldn't verify this Canvas session${detail ? ` (${detail})` : ""}. Start sign-in again from Grove.`;
  }
  return code ? `Sign-in stopped (${code}). Start again from Grove.` : "Sign-in stopped. Start again from Grove.";
}
