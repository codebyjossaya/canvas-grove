// Runs only on Grove's /extension/connect page. It is the hand-off between the website (where the
// user approves pairing while signed in) and the extension: the page posts the new device token
// to this window, and this script passes it to the background worker.
const WEB = "grove-web";
const EXT = "grove-extension";
const say = (type) => window.postMessage({ source: EXT, type }, window.location.origin);

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== WEB) return;
  if (event.data.type === "ping") return say("present");
  if (event.data.type === "pair") {
    const { token, deviceName, canvasOrigin } = event.data;
    try {
      chrome.runtime.sendMessage({ type: "pair", token, deviceName, canvasOrigin }, (result) => say(!chrome.runtime.lastError && result?.ok ? "paired" : "pair-failed"));
    } catch { say("pair-failed"); }
  }
});
say("present");
