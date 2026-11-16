# Grove for Canvas (browser extension)

The extension is the Canvas authentication boundary for Canvas Grove. Users sign in on the real
Canvas site in their own Chrome or Edge profile. After Canvas recognizes the user, the extension
sends a narrowly scoped Canvas cookie jar to Grove for independent verification.

## Install (Chrome / Edge, Manifest V3)

1. Download `grove-for-canvas-<version>.zip` from the Releases page and unzip it to a folder you will keep.
2. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the folder.
3. Click the extension icon and choose **Connect to Canvas Grove**. On Grove, name and approve this browser.
4. In Grove's setup, choose your school and start Canvas sign-in. The extension opens a new tab next to Grove
   with a short Grove page; its "Continue to <School> Canvas" button grants access to that one Canvas site,
   opens a Grove side panel for that tab, and takes the tab to Canvas.
5. Sign in normally. The extension watches that tab's requests to the Canvas site, confirms the account with
   `/api/v1/users/self`, reads that site's cookies, closes the tab, and sends the session to Grove.

## Authentication and trust boundaries

- Pairing creates a per-browser Grove credential. Only a hash of that credential is stored by Grove.
- Grove asks for permission to one exact HTTPS Canvas origin. Custom Canvas domains require an explicit
  browser permission prompt; unrelated sites and identity-provider origins are not included.
- Canvas passwords and multi-factor prompts stay on the institution's pages. The extension never reads
  form fields or captures identity-provider cookies.
- Before capture, the extension calls Canvas's `/api/v1/users/self` from the user's browser. It reads and
  uploads cookies only after Canvas reports a signed-in identity. The sign-in tab closes as soon as the
  cookies are read; the attempt (in `chrome.storage.session`) expires after 30 minutes.
- The extension reads only cookies visible to the approved Canvas origin, removes browser profile/store
  metadata, normalizes them to that exact host, and uploads them with the paired-device credential.
- Grove independently calls Canvas's `/api/v1/users/self` with the captured cookies. It stores the jar
  only after verification succeeds, using the existing encrypted Canvas-session storage.
- Requests to Grove omit the browser's Grove cookies and carry only the extension credential.
- Disconnecting the browser in the popup or Grove Settings revokes its credential immediately.

The extension can also open Canvas and external tools such as Gradescope, MATLAB, and New Quizzes in
the user's own browser. It does not require or launch a remote desktop browser.

## Permissions

- `cookies`: read and maintain Canvas session cookies for the exact approved Canvas site.
- `storage`: keep the paired-device credential and a short-lived pending authentication attempt.
- `sidePanel`: show the sign-in status panel, enabled only for the sign-in tab.
- `webRequest`: notice when the sign-in tab reaches a signed-in Canvas page (only hosts the extension may access).
- `scripting`: inject the bridge into Grove tabs that were already open when the extension was installed.
- Grove origin: communicate only with the configured Grove deployment.
- Optional `https://*/*`: requested at runtime as one exact user-selected Canvas origin, including
  standard Instructure and custom Canvas hostnames.

## Build

The Grove origin is fixed at build time (`grove.config.json`, or `--origin` / `GROVE_ORIGIN`):

```bash
node extension/build.mjs
node extension/build.mjs --origin https://grove.example
node extension/tools/make-icons.mjs
```

Sources are in `extension/src/`. The sign-in flow is covered by `tests/extension-background-auth.test.mjs`,
the page bridge by `tests/grove-extension-content.test.mjs`, cookie contracts by `tests/grove-extension.test.mjs` and
`tests/extension-canvas-auth.test.ts`; the device credential is covered by
`tests/extension-device-token.test.ts`.
