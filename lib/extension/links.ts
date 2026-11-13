/** Where people get the "Grove for Canvas" extension. Swap for the Chrome Web Store listing when it exists. */
export const EXTENSION_DOWNLOAD_URL = "https://github.com/codebyjossaya/canvas-grove/releases";

/** Messages between Grove's /extension/connect page and the extension's content script (same window). */
export const BRIDGE = { web: "grove-web", extension: "grove-extension" } as const;
