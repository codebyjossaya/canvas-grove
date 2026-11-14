# Grove for Canvas (browser extension)

The extension is the Canvas authentication boundary for Canvas Grove. Users sign in on the real
Canvas site in their own Chrome or Edge profile, review the detected Canvas identity in Grove, and
explicitly confirm before the extension sends a narrowly scoped Canvas cookie jar to Grove.

## Install (Chrome / Edge, Manifest V3)

1. Download `grove-for-canvas-<version>.zip` from the Releases page and unzip it to a folder you will keep.
2. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the folder.
3. Click the extension icon and choose **Connect to Canvas Grove**. On Grove, name and approve this browser.
4. In Grove, start Canvas setup. The extension opens the exact Canvas origin in this browser.
5. Sign in normally, return to Grove, review the detected Canvas account, and select **Connect as ...**.

## Authentication and trust boundaries

- Pairing creates a per-browser Grove credential. Only a hash of that credential is stored by Grove.
- Grove asks for permission to one exact HTTPS Canvas origin. Custom Canvas domains require an explicit
  browser permission prompt; unrelated sites and identity-provider origins are not included.
- Canvas passwords and multi-factor prompts stay on the institution's pages. The extension never reads
  form fields or captures identity-provider cookies.
- Before capture, the extension calls Canvas's `/api/v1/users/self` from the user's browser. Grove shows
  that identity and does not upload cookies until the user explicitly confirms it.
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

Sources are in `extension/src/`. Cookie contracts are covered by `tests/grove-extension.test.mjs` and
`tests/extension-canvas-auth.test.ts`; the device credential is covered by
`tests/extension-device-token.test.ts`.
