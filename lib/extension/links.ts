/**
 * Pinned, same-origin extension artifact used for the extension-first authentication trial.
 * Swap this for the Chrome Web Store listing after the live Canvas proof and store review.
 */
export const EXTENSION_DOWNLOAD_URL = "/downloads/grove-for-canvas-0.3.2.zip";
/** In-app install detection, instructions and browser pairing screen. */
export const EXTENSION_INSTALL_PATH = "/extension/connect";

/** Messages between Grove's /extension/connect page and the extension's content script (same window). */
export const BRIDGE = { web: "grove-web", extension: "grove-extension" } as const;
