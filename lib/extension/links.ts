/**
 * Pinned, same-origin extension artifact used for the extension-first authentication trial.
 * Swap this for the Chrome Web Store listing after the live Canvas proof and store review.
 */
export const EXTENSION_DOWNLOAD_URL = "/downloads/grove-for-canvas-0.4.0.zip";
/** Oldest extension build that speaks protocol v2 (tab + side panel sign-in). Older builds are "outdated". */
export const EXTENSION_MIN_VERSION = "0.4.0";
/** Web <-> extension message protocol version implemented by EXTENSION_MIN_VERSION and later. */
export const EXTENSION_PROTOCOL = 2;
/** In-app install detection, instructions and browser pairing screen. */
export const EXTENSION_INSTALL_PATH = "/extension/connect";

/** Messages between Grove pages and the extension's content script (same window). */
export const BRIDGE = { web: "grove-web", extension: "grove-extension" } as const;
