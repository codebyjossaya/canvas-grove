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

// ---- Browser-UI shortcuts are never forwarded to the hosted Chromium.
// While the remote surface has focus every key goes to the remote browser,
// whose own UI (omnibox, new windows/tabs, DevTools, find bar, history,
// downloads, zoom bubble, task manager) can cover the sign-in page and swallow
// every click, which looks like a frozen stream. Editing and text keys pass.
// Judged on event.code (layout-independent) plus modifiers; Ctrl+Alt (AltGr)
// and Option/Alt combinations that produce a character are text and pass.
const CTRL_TEXT_LETTERS = new Set(["KeyA", "KeyC", "KeyV", "KeyX", "KeyZ", "KeyY", "KeyR"]);
const CTRL_SHIFT_TEXT_LETTERS = new Set(["KeyZ", "KeyV"]);
const CTRL_UI_KEYS = new Set(["Tab", "PageUp", "PageDown", "Equal", "Minus", "NumpadAdd", "NumpadSubtract", "Digit0", "Numpad0"]);
const ALT_UI_LETTERS = new Set(["KeyD", "KeyE", "KeyF"]);
const ALT_SHIFT_UI_LETTERS = new Set(["KeyI", "KeyT", "KeyA"]);

export function isBrowserUiShortcut(event) {
  if (!event || typeof event.code !== "string") return false;
  const code = event.code;
  // Function keys in any combination (F6 omnibox, F7 caret browsing, F10 menu,
  // F11 fullscreen, F12 DevTools, Alt+F4 / Ctrl+F4 close) except F5 reload.
  if (/^F(?:[1-9]|1\d|2[0-4])$/.test(code)) return code !== "F5";
  if (event.metaKey) return false; // macOS Cmd maps to Super on Linux: no Chromium shortcuts
  if (event.ctrlKey && event.altKey) return false; // AltGr text input
  if (event.ctrlKey) {
    if (/^Key[A-Z]$/.test(code)) return event.shiftKey ? !CTRL_SHIFT_TEXT_LETTERS.has(code) : !CTRL_TEXT_LETTERS.has(code);
    if (/^(?:Digit|Numpad)[1-9]$/.test(code)) return true; // switch tab
    if (CTRL_UI_KEYS.has(code)) return true; // tab cycling, zoom
    if (code === "Delete" && event.shiftKey) return true; // clear browsing data
    return false;
  }
  if (event.altKey) {
    if (code === "Home") return true; // home page in the sign-in tab
    const letters = event.shiftKey ? ALT_SHIFT_UI_LETTERS : ALT_UI_LETTERS;
    // Only a plain letter is a shortcut; Option+letter producing a symbol is text.
    return letters.has(code) && typeof event.key === "string" && event.key.toLowerCase() === code.slice(3).toLowerCase();
  }
  if (event.shiftKey && code === "Escape") return true; // task manager
  return false;
}
