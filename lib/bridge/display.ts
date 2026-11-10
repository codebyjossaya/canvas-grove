export type DisplayRequest = { width?: unknown; height?: unknown; dpr?: unknown; mobile?: unknown };
/** Framebuffer size in device pixels. Mobile profiles also carry the CSS viewport and scale factor. */
export type DisplaySize = { width: number; height: number; mobile?: true; cssWidth?: number; cssHeight?: number; dpr?: number };

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Same pixel budget as the desktop profile (1920x1080). */
export const MAX_DISPLAY_PIXELS = 2_073_600;
/** Mobile portrait profile bounds, in CSS pixels. Must match validDisplay in the orchestrator. */
export const MOBILE_PROFILE = Object.freeze({ minWidth: 320, maxWidth: 480, minHeight: 560, maxHeight: 1000, minDpr: 1, maxDpr: 3 });

export function normalizeMobileDisplay(input: DisplayRequest): DisplaySize | null {
  const rawWidth = Number(input.width), rawHeight = Number(input.height), rawDpr = Number(input.dpr);
  if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth <= 0 || rawHeight <= 0) return null;
  // Always provision portrait; a landscape phone simply scales the surface to fit.
  const cssWidth = Math.round(clamp(Math.min(rawWidth, rawHeight), MOBILE_PROFILE.minWidth, MOBILE_PROFILE.maxWidth));
  const cssHeight = Math.round(clamp(Math.max(rawWidth, rawHeight), MOBILE_PROFILE.minHeight, MOBILE_PROFILE.maxHeight));
  let dpr = Number.isFinite(rawDpr) ? clamp(rawDpr, MOBILE_PROFILE.minDpr, MOBILE_PROFILE.maxDpr) : 2;
  // Keep the pixel cap by lowering the scale factor in quarter steps.
  const fit = Math.sqrt(MAX_DISPLAY_PIXELS / (cssWidth * cssHeight));
  dpr = Math.max(MOBILE_PROFILE.minDpr, Math.floor(Math.min(dpr, fit) * 4) / 4);
  return { width: Math.round(cssWidth * dpr), height: Math.round(cssHeight * dpr), mobile: true, cssWidth, cssHeight, dpr };
}

export function normalizeDisplay(input: DisplayRequest = {}): DisplaySize {
  if (input.mobile === true) {
    const mobile = normalizeMobileDisplay(input);
    if (mobile) return mobile;
  }
  const cssWidth = Number(input.width); const cssHeight = Number(input.height); const rawDpr = Number(input.dpr);
  if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight) || cssWidth <= 0 || cssHeight <= 0) return { width: 1280, height: 720 };
  const dpr = Number.isFinite(rawDpr) ? Math.min(2, Math.max(0.75, rawDpr)) : 1;
  let width = cssWidth * dpr; let height = cssHeight * dpr;
  const scale = Math.min(1, 1920 / width, 1080 / height, Math.sqrt(MAX_DISPLAY_PIXELS / (width * height)));
  width *= scale; height *= scale;
  return { width: even(Math.min(1920, Math.max(800, width))), height: even(Math.min(1080, Math.max(600, height))) };
}
