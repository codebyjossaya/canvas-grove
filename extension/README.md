# Grove for Canvas (browser extension)

Opens Canvas links from Canvas Grove already signed in, so Gradescope and MATLAB (LTI 1.3)
assignments and New Quizzes work in your own browser. Without the extension, links to Canvas are
plain links.

## Install (Chrome / Edge, Manifest V3)

1. Download `grove-for-canvas-<version>.zip` from the Releases page and unzip it to a folder you will keep.
2. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, select the folder.
3. Click the extension icon and choose **Connect to Canvas Grove**. This opens the Canvas Grove
   website, where you (signed in) confirm and name the browser. No password or address is typed into the extension.
4. Click any Canvas link in Grove, or **Open Canvas** in the extension popup.

## How it works

- **Pairing starts on the website.** The extension opens `/extension/connect` on Grove. After you
  confirm, Grove creates a per-browser credential and hands it to the extension through a content
  script that only runs on that page. Only a hash of the credential is stored by Grove.
- **Disconnect from either side.** The popup's *Disconnect* and Grove's Settings → Browser extension
  both revoke the credential immediately.
- **Opening Canvas.** Clicking a link to your Canvas site in Grove asks the background worker whether this
  browser already has a live Canvas session. If not, it requests the Canvas cookies Grove holds for you
  (only cookies for the Canvas host, never login-provider or Duo cookies), installs them host-only, then opens the link.
- An existing live Canvas session in the browser is never overwritten. **Shift-click** replaces it with Grove's.
- Requests to Grove omit the browser's own Grove cookies and carry only the extension's credential.

## Permissions

`cookies` and `storage`; access to Grove's origin and `*.instructure.com`. A Canvas site on another
domain is requested from the popup (**Allow access to Canvas**) when needed.

## Caveat

The browser and Grove then share one Canvas session. Logging out of Canvas in the browser ends that
session for Grove too, and Grove will ask you to reconnect.

## Build

The Grove origin is fixed at build time (`grove.config.json`, or `--origin` / `GROVE_ORIGIN`):

```bash
node extension/build.mjs                              # -> extension/dist
node extension/build.mjs --origin https://grove.example
node extension/tools/make-icons.mjs                   # regenerate icons/ from the Grove mark
```

Sources are in `extension/src/`. The popup uses the same design tokens and Inter font as the website.
Pure cookie logic is covered by `tests/grove-extension.test.mjs`; the device credential by
`tests/extension-device-token.test.ts`.
