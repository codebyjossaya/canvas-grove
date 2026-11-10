// Browser display profiles accepted by the orchestrator. Desktop: framebuffer
// 800-1920 x 600-1080. Mobile: a portrait CSS viewport with a device scale factor.
// Both stay under the same pixel cap.

export const MAX_DISPLAY_PIXELS = 2_073_600;
// Mobile portrait profile, in CSS pixels; the framebuffer is CSS size x DPR.
// Must match MOBILE_PROFILE in lib/bridge/display.ts.
export const MOBILE_PROFILE = Object.freeze({ minWidth: 320, maxWidth: 480, minHeight: 560, maxHeight: 1000, minDpr: 1, maxDpr: 3 });
export function validMobileDisplay(value) {
  const { cssWidth, cssHeight, dpr } = value;
  if (!Number.isInteger(cssWidth) || !Number.isInteger(cssHeight) || typeof dpr !== "number" || !Number.isFinite(dpr)) return null;
  if (cssWidth < MOBILE_PROFILE.minWidth || cssWidth > MOBILE_PROFILE.maxWidth || cssHeight < MOBILE_PROFILE.minHeight || cssHeight > MOBILE_PROFILE.maxHeight) return null;
  if (dpr < MOBILE_PROFILE.minDpr || dpr > MOBILE_PROFILE.maxDpr || Math.round(dpr * 4) !== dpr * 4) return null;
  const width = Math.round(cssWidth * dpr), height = Math.round(cssHeight * dpr);
  if (width * height > MAX_DISPLAY_PIXELS) return null;
  return { width, height, mobile: true, cssWidth, cssHeight, dpr };
}
export function validDisplay(value) {
  if (!value || typeof value !== "object") return null;
  if (value.mobile === true) return validMobileDisplay(value);
  if (!Number.isInteger(value.width) || !Number.isInteger(value.height)) return null;
  if (value.width < 800 || value.width > 1920 || value.height < 600 || value.height > 1080 || value.width * value.height > MAX_DISPLAY_PIXELS) return null;
  return { width: value.width, height: value.height };
}

// Mobile sessions get a launch-time Chromium profile (UA, scale factor, touch);
// desktop launches pass no extra environment and are unchanged.
export function mobileLaunchEnv(display) {
  if (display?.mobile !== true) return [];
  return ["-e", "BROWSER_MOBILE=1", "-e", `BROWSER_CSS_WIDTH=${display.cssWidth}`, "-e", `BROWSER_CSS_HEIGHT=${display.cssHeight}`, "-e", `BROWSER_DPR=${display.dpr}`];
}
