# Grove for Canvas (browser extension)

Opens Canvas links from Canvas Grove already signed in, so Gradescope/MATLAB (LTI 1.3) assignments
and New Quizzes work in your own browser. Without the extension, links to Canvas are plain links.

## Install (Chrome / Edge, Manifest V3)

1. Download `grove-for-canvas-<version>.zip` from the Releases page and unzip it to a folder you will keep.
2. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, select the folder.
3. Click the extension icon, enter your Grove address and your Canvas address
   (for example `https://ufl.instructure.com`), then **Save and allow access**.
   Chrome asks to grant access to exactly those two sites.
4. Reload your Grove tab.

## How it works

- A content script runs only on your Grove origin. When you click a link whose origin is your Canvas origin,
  it asks the background worker whether the browser already has a live Canvas session.
- If not, it calls `POST /api/canvas/extension/session` on Grove (same-origin, with your Grove login) and
  receives the Canvas cookies the server holds for you: only cookies for the Canvas host, never
  login-provider or Duo cookies.
- The worker installs them host-only on the Canvas host and opens the link in a new tab.
- An existing live Canvas session in the browser is never overwritten. **Shift-click** replaces it with Grove's.
- The worker ignores messages from any page other than the configured Grove origin and refuses
  cookies that name another host.

## Caveat

The browser and Grove then share one Canvas session. Logging out of Canvas in the browser ends that
session for Grove too, and Grove will ask you to reconnect.

## Development

Pure cookie logic is in `cookies.js` and covered by `tests/grove-extension.test.mjs`
(`node --test tests/grove-extension.test.mjs`).
