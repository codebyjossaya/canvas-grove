// Pure, dependency-free input helpers for the viewer. Served to the browser and
// imported directly by node:test.

export const MAX_PASTE_CHARS = 64 * 1024;

export function normalizePasteText(value, max = MAX_PASTE_CHARS) {
  if (typeof value !== "string" || value.length === 0) return "";
  const text = value.replace(/\r\n?/g, "\n");
  if (text.length <= max) return text;
  // Never leave a dangling high surrogate at the cut point.
  const end = /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max;
  return text.slice(0, end);
}

// The local paste shortcut: Cmd+V on macOS, Ctrl+V elsewhere, never with Alt
// (AltGr layouts report Ctrl+Alt).
export function isPasteShortcut(event, mac) {
  if (!event || event.altKey) return false;
  const isV = event.code === "KeyV" || (typeof event.key === "string" && event.key.toLowerCase() === "v");
  if (!isV) return false;
  return mac ? Boolean(event.metaKey) && !event.ctrlKey : Boolean(event.ctrlKey) && !event.metaKey;
}

export const XK = Object.freeze({
  BackSpace: 0xff08, Tab: 0xff09, Return: 0xff0d, Escape: 0xff1b, Delete: 0xffff,
  Home: 0xff50, Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54, PageUp: 0xff55, PageDown: 0xff56, End: 0xff57,
  Control_L: 0xffe3, Control_R: 0xffe4, Super_L: 0xffeb, Super_R: 0xffec, v: 0x0076,
});

/** Navigation/editing keys a soft or hardware keyboard sends without producing text. */
export const NAMED_KEYS = Object.freeze({
  Enter: XK.Return, Backspace: XK.BackSpace, Tab: XK.Tab, Escape: XK.Escape, Delete: XK.Delete,
  Home: XK.Home, End: XK.End, PageUp: XK.PageUp, PageDown: XK.PageDown,
  ArrowLeft: XK.Left, ArrowUp: XK.Up, ArrowRight: XK.Right, ArrowDown: XK.Down,
});

/** X11 keysym for one Unicode code point (Latin-1 maps directly; others use the 0x01000000 Unicode range). */
export function keysymForCodePoint(codePoint) {
  if (codePoint === 0x0a || codePoint === 0x0d) return XK.Return;
  if (codePoint === 0x09) return XK.Tab;
  if ((codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa0 && codePoint <= 0xff)) return codePoint;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return null;
  return 0x01000000 | codePoint;
}

/**
 * Soft keyboards (and IME composition) edit a hidden textarea rather than
 * sending usable key events. Diff the previous and next value by common prefix:
 * delete what diverged with BackSpace, then type the new tail. Works for plain
 * typing, autocorrect replacements, composition updates and deletion.
 */
export function diffTextInput(previous, next) {
  const a = Array.from(previous ?? ""), b = Array.from(next ?? "");
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
  return { backspaces: a.length - common, text: b.slice(common).join("") };
}

/** Sentinel content so a BackSpace on an "empty" field is still observable as a deletion. */
export const SOFT_KEYBOARD_SENTINEL = "_".repeat(64);
