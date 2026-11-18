import { describe, expect, it } from "vitest";
import { chordFromEvent, formatChord, isTypingTarget, parseChord } from "./chord";

describe("parseChord", () => {
  it.each([
    ["Space", "Space"],
    ["ctrl+shift+z", "Ctrl+Shift+Z"],
    ["Shift+Ctrl+Z", "Ctrl+Shift+Z"],
    ["Control+Alt+Delete", "Ctrl+Alt+Delete"],
    ["?", "Shift+/"],
    ["+", "Shift+="],
    ["Ctrl++", "Ctrl+Shift+="],
    ["<", "Shift+,"],
    ["Shift+,", "Shift+,"],
    ["Esc", "Escape"],
    ["Del", "Delete"],
    ["←", "ArrowLeft"],
    ["Alt+→", "Alt+ArrowRight"],
    ["a", "A"],
    ["-", "-"],
    ["0", "0"],
    ["F5", "F5"],
  ])("%s -> %s", (input, expected) => {
    expect(parseChord(input)).toBe(expected);
  });

  it.each(["", "Ctrl", "Ctrl+", "Hyper+A", "Ctrl+Shift", "é", "Ctrl+Foo"])("rejects %j", (input) => {
    expect(parseChord(input)).toBeNull();
  });
});

describe("chordFromEvent (QWERTY)", () => {
  it("letters, with and without Shift and Ctrl", () => {
    expect(chordFromEvent({ key: "s", code: "KeyS" })).toBe("S");
    expect(chordFromEvent({ key: "N", code: "KeyN", shiftKey: true })).toBe("Shift+N");
    expect(chordFromEvent({ key: "z", code: "KeyZ", ctrlKey: true })).toBe("Ctrl+Z");
    expect(chordFromEvent({ key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+Z");
    // Caps Lock on: key is upper case without Shift; still the plain letter.
    expect(chordFromEvent({ key: "H", code: "KeyH" })).toBe("H");
  });

  it("characters that need Shift are Shift plus the key they sit on", () => {
    expect(chordFromEvent({ key: "?", code: "Slash", shiftKey: true })).toBe("Shift+/");
    expect(chordFromEvent({ key: "+", code: "Equal", shiftKey: true })).toBe("Shift+=");
    expect(chordFromEvent({ key: "<", code: "Comma", shiftKey: true })).toBe("Shift+,");
    expect(chordFromEvent({ key: ">", code: "Period", shiftKey: true })).toBe("Shift+.");
    expect(chordFromEvent({ key: ",", code: "Comma" })).toBe(",");
    expect(chordFromEvent({ key: "/", code: "Slash" })).toBe("/");
  });

  it("falls back to `key` when `code` is missing", () => {
    expect(chordFromEvent({ key: "?", shiftKey: true })).toBe("Shift+/");
    expect(chordFromEvent({ key: "?" })).toBe("Shift+/");
    expect(chordFromEvent({ key: "<", shiftKey: true })).toBe("Shift+,");
    expect(chordFromEvent({ key: " " })).toBe("Space");
    expect(chordFromEvent({ key: "Esc" })).toBe("Escape");
    expect(chordFromEvent({ key: "a" })).toBe("A");
  });

  it("numeric keypad: + types plus, digits are digits", () => {
    expect(chordFromEvent({ key: "+", code: "NumpadAdd" })).toBe("Shift+=");
    expect(chordFromEvent({ key: "-", code: "NumpadSubtract" })).toBe("-");
    expect(chordFromEvent({ key: "0", code: "Numpad0" })).toBe("0");
    expect(chordFromEvent({ key: "Enter", code: "NumpadEnter" })).toBe("Enter");
    expect(chordFromEvent({ key: "ArrowLeft", code: "Numpad4" })).toBe("ArrowLeft");
    // Num Lock off: the keypad's Del key, and the operator keys report what they type.
    expect(chordFromEvent({ key: "Delete", code: "NumpadDecimal" })).toBe("Delete");
    expect(chordFromEvent({ key: "Delete", code: "NumpadDecimal", shiftKey: true })).toBe("Shift+Delete");
    expect(chordFromEvent({ key: ".", code: "NumpadDecimal" })).toBe(".");
    expect(chordFromEvent({ key: ",", code: "NumpadDecimal" })).toBe(".");
    expect(chordFromEvent({ key: "Insert", code: "Numpad0" })).toBe("Insert");
    expect(chordFromEvent({ key: "/", code: "NumpadDivide" })).toBe("/");
    expect(chordFromEvent({ key: "*", code: "NumpadMultiply" })).toBe("Shift+8");
  });

  it("named keys and modifiers with arrows", () => {
    expect(chordFromEvent({ key: " ", code: "Space" })).toBe("Space");
    expect(chordFromEvent({ key: "Tab", code: "Tab" })).toBe("Tab");
    expect(chordFromEvent({ key: "Escape", code: "Escape" })).toBe("Escape");
    expect(chordFromEvent({ key: "ArrowLeft", code: "ArrowLeft", altKey: true })).toBe("Alt+ArrowLeft");
    expect(chordFromEvent({ key: "ArrowUp", code: "ArrowUp", ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+ArrowUp");
    expect(chordFromEvent({ key: "Backspace", code: "Backspace" })).toBe("Backspace");
  });

  it("modifier alone, Windows key, composition and dead keys are not chords", () => {
    expect(chordFromEvent({ key: "Shift", code: "ShiftLeft", shiftKey: true })).toBeNull();
    expect(chordFromEvent({ key: "Control", code: "ControlLeft", ctrlKey: true })).toBeNull();
    expect(chordFromEvent({ key: "a", code: "KeyA", metaKey: true })).toBeNull();
    expect(chordFromEvent({ key: "a", code: "KeyA", isComposing: true })).toBeNull();
    expect(chordFromEvent({ key: "Process", code: "KeyA" })).toBeNull();
    expect(chordFromEvent({ key: "Dead", code: "Quote" })).toBeNull();
  });

  it("works on a real KeyboardEvent", () => {
    const e = new KeyboardEvent("keydown", { key: "?", code: "Slash", shiftKey: true });
    expect(chordFromEvent(e)).toBe("Shift+/");
  });
});

describe("formatChord", () => {
  it("plain style follows spec 1.10", () => {
    expect(formatChord("Shift+/")).toBe("?");
    expect(formatChord("Shift+=")).toBe("+");
    expect(formatChord("Shift+,")).toBe("Shift+,");
    expect(formatChord("Ctrl+Shift+Z")).toBe("Ctrl+Shift+Z");
    expect(formatChord("Alt+ArrowLeft")).toBe("Alt+←");
    expect(formatChord("Escape")).toBe("Esc");
    expect(formatChord("Delete")).toBe("Del");
  });

  it("cap style follows the mockup keycaps", () => {
    expect(formatChord("Ctrl+N", "cap")).toBe("ctrl n");
    expect(formatChord("Delete", "cap")).toBe("del");
    expect(formatChord("Shift+/", "cap")).toBe("?");
    expect(formatChord("ArrowUp", "cap")).toBe("↑");
    expect(formatChord("Space", "cap")).toBe("space");
  });

  it("every parseable chord round-trips through its plain format", () => {
    for (const c of ["Ctrl+Shift+Z", "Shift+/", "Shift+=", "Shift+,", "Alt+ArrowRight", "Escape", "Delete", "-", "0", "Ctrl+Shift+ArrowDown"]) {
      expect(parseChord(formatChord(c))).toBe(c);
    }
  });
});

describe("isTypingTarget", () => {
  it("text inputs, textareas and editable content are typing targets; buttons are not", () => {
    const text = document.createElement("input");
    const search = document.createElement("input");
    search.type = "search";
    const box = document.createElement("input");
    box.type = "checkbox";
    const area = document.createElement("textarea");
    const div = document.createElement("div");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const button = document.createElement("button");
    expect(isTypingTarget(text)).toBe(true);
    expect(isTypingTarget(search)).toBe(true);
    expect(isTypingTarget(area)).toBe(true);
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(box)).toBe(false);
    expect(isTypingTarget(div)).toBe(false);
    expect(isTypingTarget(button)).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
