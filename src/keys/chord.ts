/**
 * Chords: the canonical text form of a keystroke, on a US QWERTY layout.
 *
 * A chord is modifiers in the fixed order `Ctrl`, `Alt`, `Shift`, then one key, joined by "+":
 * "Space", "Ctrl+Shift+Z", "Shift+ArrowLeft", "Shift+,". A character that needs Shift to type is
 * written as Shift plus the unshifted key it sits on: "?" is "Shift+/", "+" is "Shift+=", "<" is
 * "Shift+,". Letters are upper case. The Windows key (Meta) never forms a chord.
 */

/** Named keys that are not a single printable character. */
const NAMED_KEYS = [
  "Space", "Tab", "Enter", "Escape", "Backspace", "Delete", "Insert",
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Home", "End", "PageUp", "PageDown",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
] as const;

/** The unshifted punctuation keys of a US QWERTY keyboard. */
const BASE_PUNCTUATION = ["`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/"] as const;

/** Character typed with Shift -> the key it is typed on (US QWERTY). */
const SHIFTED: Readonly<Record<string, string>> = {
  "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8",
  "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'",
  "<": ",", ">": ".", "?": "/",
};

/** KeyboardEvent.code -> base key, for the physical keys of a QWERTY keyboard. */
const CODE_TO_KEY: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {
    Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
    Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
    Space: "Space", Tab: "Tab", Enter: "Enter", NumpadEnter: "Enter", Escape: "Escape",
    Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
    ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  };
  for (let c = 65; c <= 90; c++) map[`Key${String.fromCharCode(c)}`] = String.fromCharCode(c);
  for (let d = 0; d <= 9; d++) map[`Digit${d}`] = String(d);
  for (let f = 1; f <= 12; f++) map[`F${f}`] = `F${f}`;
  return map;
})();

/** Numeric keypad keys that type a character: the chord is that character's chord. */
const NUMPAD_CHAR: Readonly<Record<string, string>> = {
  NumpadAdd: "+", NumpadSubtract: "-", NumpadMultiply: "*", NumpadDivide: "/",
  NumpadDecimal: ".", NumpadComma: ",", NumpadEqual: "=",
};

/** Alternative spellings accepted by parseChord, and KeyboardEvent.key values of old browsers. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: "Escape", escape: "Escape", del: "Delete", delete: "Delete", ins: "Insert", insert: "Insert",
  space: "Space", spacebar: "Space", " ": "Space", tab: "Tab", enter: "Enter", return: "Enter",
  backspace: "Backspace", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  pgup: "PageUp", pgdn: "PageDown",
  left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown",
  arrowleft: "ArrowLeft", arrowright: "ArrowRight", arrowup: "ArrowUp", arrowdown: "ArrowDown",
  "←": "ArrowLeft", "→": "ArrowRight", "↑": "ArrowUp", "↓": "ArrowDown",
};

const MODIFIER_KEYS = new Set([
  "Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "Hyper", "Super", "CapsLock", "NumLock",
  "ScrollLock", "Fn", "FnLock",
]);

interface Parts {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

function join({ ctrl, alt, shift, key }: Parts): string {
  return [ctrl ? "Ctrl" : "", alt ? "Alt" : "", shift ? "Shift" : "", key].filter((s) => s !== "").join("+");
}

/**
 * Reads one key name (no modifiers) into a base key plus whether it implies Shift.
 * Returns null for anything that is not a key this module knows.
 */
function readKey(raw: string): { key: string; shift: boolean } | null {
  if (raw.length === 1) {
    if (raw === " ") return { key: "Space", shift: false };
    const shifted = SHIFTED[raw];
    if (shifted !== undefined) return { key: shifted, shift: true };
    if (/^[a-z]$/.test(raw)) return { key: raw.toUpperCase(), shift: false };
    if (/^[A-Z0-9]$/.test(raw)) return { key: raw, shift: false };
    if ((BASE_PUNCTUATION as readonly string[]).includes(raw)) return { key: raw, shift: false };
    const alias = KEY_ALIASES[raw];
    return alias !== undefined ? { key: alias, shift: false } : null;
  }
  const alias = KEY_ALIASES[raw.toLowerCase()];
  if (alias !== undefined) return { key: alias, shift: false };
  const named = NAMED_KEYS.find((n) => n.toLowerCase() === raw.toLowerCase());
  return named !== undefined ? { key: named, shift: false } : null;
}

/**
 * Parses a chord written by hand or found in a settings file into its canonical form.
 * Accepts any modifier order and case, "Control"/"Ctrl", "Esc", "Del", arrows as "←" or "Left",
 * and shifted characters ("?", "+", "<"). Returns null when the text is not a valid chord.
 * Examples: "ctrl+shift+z" -> "Ctrl+Shift+Z", "?" -> "Shift+/", "Ctrl++" -> "Ctrl+Shift+=".
 */
export function parseChord(text: string): string | null {
  const s = text.trim();
  if (s === "") return null;
  let keyText: string;
  let modText: string;
  if (s === "+") {
    keyText = "+";
    modText = "";
  } else if (s.endsWith("++")) {
    keyText = "+";
    modText = s.slice(0, -2);
  } else {
    const at = s.lastIndexOf("+");
    keyText = at < 0 ? s : s.slice(at + 1);
    modText = at < 0 ? "" : s.slice(0, at);
  }
  const parts: Parts = { ctrl: false, alt: false, shift: false, key: "" };
  if (modText !== "") {
    for (const m of modText.split("+")) {
      const lower = m.trim().toLowerCase();
      if (lower === "ctrl" || lower === "control") parts.ctrl = true;
      else if (lower === "alt") parts.alt = true;
      else if (lower === "shift") parts.shift = true;
      else return null;
    }
  }
  const key = readKey(keyText.length === 1 ? keyText : keyText.trim());
  if (key === null) return null;
  parts.key = key.key;
  parts.shift = parts.shift || key.shift;
  return join(parts);
}

/** The subset of KeyboardEvent that chord reading uses (lets tests pass plain objects). */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

/**
 * Turns a keydown event into its canonical chord, or null when it is not one: a modifier
 * pressed alone, the Windows key held, an input-method composition, a dead key.
 * The physical key (`code`) is read on a QWERTY layout; `key` is the fallback when `code` is
 * missing or unknown. So Shift+Comma is "Shift+," whatever character the layout types.
 */
export function chordFromEvent(event: KeyLike): string | null {
  if (event.isComposing === true || event.key === "Process" || event.key === "Dead") return null;
  if (event.key === "Unidentified" && (event.code === undefined || event.code === "")) return null;
  if (MODIFIER_KEYS.has(event.key)) return null;
  if (event.metaKey === true) return null;

  const parts: Parts = {
    ctrl: event.ctrlKey === true,
    alt: event.altKey === true,
    shift: event.shiftKey === true,
    key: "",
  };
  const code = event.code ?? "";
  let read: { key: string; shift: boolean } | null = null;

  const fromCode = CODE_TO_KEY[code];
  if (fromCode !== undefined) {
    read = { key: fromCode, shift: false };
  } else if (code.startsWith("Numpad")) {
    // A keypad key types its character only when `key` says so. With Num Lock off the same
    // physical key is a navigation key: Numpad4 is ArrowLeft, NumpadDecimal is Delete. Then
    // `key` is the truth. A locale's decimal separator (",") is still the keypad's ".".
    const ch = NUMPAD_CHAR[code];
    if (ch !== undefined && (event.key === ch || (code === "NumpadDecimal" && event.key === ","))) read = readKey(ch);
    else read = readKey(event.key); // Numpad digits, and Num Lock off: Home, End, arrows, Delete...
  } else {
    read = readKey(event.key);
  }
  if (read === null) return null;
  parts.key = read.key;
  parts.shift = parts.shift || read.shift;
  return join(parts);
}

/** Splits a canonical chord into its modifiers and key. */
export function chordParts(chord: string): Parts {
  const parsed = parseChord(chord);
  const s = parsed ?? chord;
  const tokens = s.split("+");
  const key = s.endsWith("+") ? "+" : (tokens[tokens.length - 1] ?? "");
  return {
    ctrl: tokens.includes("Ctrl"),
    alt: tokens.includes("Alt"),
    shift: tokens.includes("Shift"),
    key,
  };
}

/** Chords shown as the character they type, as spec 1.10 writes them. */
const SHOWN_AS_CHARACTER: Readonly<Record<string, string>> = { "Shift+/": "?", "Shift+=": "+" };

const KEY_LABEL: Readonly<Record<string, string>> = {
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
  Escape: "Esc", Delete: "Del", PageUp: "PgUp", PageDown: "PgDn",
};

/**
 * Text for showing a chord to the user.
 * "plain" (default) follows spec 1.10: "Ctrl+Shift+Z", "Shift+←", "?", "+", "Esc", "Del".
 * "cap" follows the keycaps of the mockups: lower case, space separated: "ctrl n", "del", "?".
 */
export function formatChord(chord: string, style: "plain" | "cap" = "plain"): string {
  const canonical = parseChord(chord) ?? chord;
  const asChar = SHOWN_AS_CHARACTER[canonical];
  if (asChar !== undefined) return asChar;
  const p = chordParts(canonical);
  const key = KEY_LABEL[p.key] ?? p.key;
  const pieces = [p.ctrl ? "Ctrl" : "", p.alt ? "Alt" : "", p.shift ? "Shift" : "", key].filter((x) => x !== "");
  return style === "cap" ? pieces.map((x) => x.toLowerCase()).join(" ") : pieces.join("+");
}

/**
 * True when the event's target is a place the user types text (an input that takes text, a
 * textarea, a select, or editable content). Keys typed there are left alone, except Esc.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== "object") return false;
  const el = target as Partial<HTMLElement> & { tagName?: string; type?: string; readOnly?: boolean };
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el.type ?? "text").toLowerCase();
    const nonText = ["button", "checkbox", "radio", "submit", "reset", "image", "file", "range", "color", "hidden"];
    return !nonText.includes(type);
  }
  if (el.isContentEditable === true) return true;
  const attr = typeof el.getAttribute === "function" ? el.getAttribute.call(el, "contenteditable") : null;
  return attr !== null && attr !== "false";
}

/**
 * Keys that still act while the user is typing in a text field: Esc only (it closes the find
 * box or a dialog). Enter and Shift+Enter belong to the field itself: in the find box they jump
 * to the next and previous match (spec 1.8 item 10), and a form's implicit submit must still
 * happen, so they are neither resolved nor prevented here.
 */
export function passesThroughTextField(chord: string): boolean {
  return chordParts(chord).key === "Escape";
}
