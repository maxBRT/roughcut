import { describe, expect, it } from "vitest";
import type { KeyBinding } from "../types";
import { KEY_ACTIONS } from "./actions";
import {
  chordsFor,
  createKeymap,
  findClashes,
  rebind,
  resetAction,
  resolve,
  screenHints,
  shortcutGroups,
  toOverrides,
  type Keymap,
} from "./keymap";

const ev = (key: string, code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; repeat?: boolean } = {}) => ({
  key,
  code,
  ctrlKey: mods.ctrl === true,
  shiftKey: mods.shift === true,
  altKey: mods.alt === true,
  repeat: mods.repeat === true,
});

function ok(r: ReturnType<typeof rebind>): Keymap {
  if (!r.ok) throw new Error(`rebind refused: ${r.reason}`);
  return r.keymap;
}

describe("resolve", () => {
  const km = createKeymap();

  it("the active context first, then everywhere", () => {
    expect(resolve(km, ev("ArrowLeft", "ArrowLeft"), "transcript")).toBe("transcript.wordPrev");
    expect(resolve(km, ev("ArrowLeft", "ArrowLeft"), "timeline")).toBe("timeline.stepFrameBack");
    expect(resolve(km, ev("Delete", "Delete"), "timeline")).toBe("timeline.removeClip");
    expect(resolve(km, ev("Delete", "Delete"), "transcript")).toBe("transcript.cut");
    expect(resolve(km, ev("Backspace", "Backspace"), "transcript")).toBe("transcript.cut");
    expect(resolve(km, ev("Backspace", "Backspace"), "timeline")).toBeNull();
    expect(resolve(km, ev(" ", "Space"), "timeline")).toBe("everywhere.playPause");
    expect(resolve(km, ev("Tab", "Tab"), "transcript")).toBe("everywhere.switchView");
    expect(resolve(km, ev("ArrowLeft", "ArrowLeft"), "everywhere")).toBeNull();
    expect(resolve(km, ev("j", "KeyJ"), "everywhere")).toBe("everywhere.playBackward");
  });

  it("keys that need Shift", () => {
    expect(resolve(km, ev("?", "Slash", { shift: true }), "home")).toBe("everywhere.showShortcuts");
    expect(resolve(km, ev("+", "Equal", { shift: true }), "timeline")).toBe("timeline.zoomIn");
    expect(resolve(km, ev("+", "NumpadAdd"), "timeline")).toBe("timeline.zoomIn");
    expect(resolve(km, ev("<", "Comma", { shift: true }), "timeline")).toBe("timeline.nudgeStartEarlier");
    expect(resolve(km, ev(",", "Comma"), "timeline")).toBe("timeline.nudgeEndEarlier");
    expect(resolve(km, ev("/", "Slash"), "timeline")).toBe("timeline.previewCut");
    expect(resolve(km, ev("/", "Slash"), "transcript")).toBeNull();
    expect(resolve(km, ev("N", "KeyN", { shift: true }), "transcript")).toBe("transcript.prevSuggestion");
    expect(resolve(km, ev("A", "KeyA", { shift: true }), "transcript")).toBe("transcript.acceptAllSuggestions");
    expect(resolve(km, ev("ArrowLeft", "ArrowLeft", { shift: true, ctrl: true }), "transcript")).toBe("transcript.extendSentencePrev");
  });

  it("Ctrl combinations", () => {
    expect(resolve(km, ev("z", "KeyZ", { ctrl: true }), "timeline")).toBe("everywhere.undo");
    expect(resolve(km, ev("Z", "KeyZ", { ctrl: true, shift: true }), "transcript")).toBe("everywhere.redo");
    expect(resolve(km, ev("e", "KeyE", { ctrl: true }), "transcript")).toBe("everywhere.export");
    expect(resolve(km, ev("n", "KeyN", { ctrl: true }), "home")).toBe("everywhere.newProject");
    expect(resolve(km, ev("s", "KeyS", { ctrl: true }), "timeline")).toBeNull();
  });

  it("key repeat runs stepping and nudging, not toggles", () => {
    expect(resolve(km, ev("ArrowRight", "ArrowRight", { repeat: true }), "timeline")).toBe("timeline.stepFrameForward");
    expect(resolve(km, ev(".", "Period", { repeat: true }), "timeline")).toBe("timeline.nudgeEndLater");
    expect(resolve(km, ev("ArrowDown", "ArrowDown", { repeat: true, shift: true }), "transcript")).toBe("transcript.extendLineNext");
    expect(resolve(km, ev(" ", "Space", { repeat: true }), "transcript")).toBeNull();
    expect(resolve(km, ev("h", "KeyH", { repeat: true }), "transcript")).toBeNull();
    expect(resolve(km, ev("Tab", "Tab", { repeat: true }), "transcript")).toBeNull();
    expect(resolve(km, ev("s", "KeyS", { repeat: true }), "timeline")).toBeNull();
  });

  it("does not take keys typed in a text field, except Esc", () => {
    const input = document.createElement("input");
    const typed = (key: string, code: string, mods = {}) => ({ ...ev(key, code, mods), target: input });
    expect(resolve(km, typed("r", "KeyR"), "transcript")).toBeNull();
    expect(resolve(km, typed(" ", "Space"), "transcript")).toBeNull();
    expect(resolve(km, typed("ArrowLeft", "ArrowLeft"), "transcript")).toBeNull();
    expect(resolve(km, typed("Backspace", "Backspace"), "transcript")).toBeNull();
    expect(resolve(km, typed("z", "KeyZ", { ctrl: true }), "transcript")).toBeNull();
    expect(resolve(km, typed("?", "Slash", { shift: true }), "transcript")).toBeNull();
    expect(resolve(km, typed("Escape", "Escape"), "transcript")).toBe("everywhere.escape");
    // Enter and Shift+Enter in the find box are the box's own (next / previous match), not playback.
    expect(resolve(km, typed("Enter", "Enter"), "transcript")).toBeNull();
    expect(resolve(km, typed("Enter", "Enter", { shift: true }), "transcript")).toBeNull();
    expect(resolve(km, typed("Enter", "NumpadEnter"), "timeline")).toBeNull();
    expect(resolve(km, typed("Escape", "Escape"), { context: "export", phase: "done" })).toBe("export.close");
    // Outside a text field the same key acts.
    expect(resolve(km, { ...ev("r", "KeyR"), target: document.body }, "transcript")).toBe("transcript.restore");
  });

  it("export keys follow the dialog state", () => {
    const enter = ev("Enter", "Enter");
    const esc = ev("Escape", "Escape");
    const c = ev("c", "KeyC");
    expect(resolve(km, enter, { context: "export", phase: "confirm" })).toBe("export.confirm");
    expect(resolve(km, enter, "export")).toBe("export.confirm");
    expect(resolve(km, c, { context: "export", phase: "confirm" })).toBe("export.changeFolder");
    expect(resolve(km, esc, { context: "export", phase: "confirm" })).toBe("export.cancel");
    expect(resolve(km, esc, { context: "export", phase: "running" })).toBe("export.cancel");
    expect(resolve(km, enter, { context: "export", phase: "running" })).toBeNull();
    expect(resolve(km, c, { context: "export", phase: "running" })).toBeNull();
    expect(resolve(km, enter, { context: "export", phase: "done" })).toBe("export.showInFolder");
    expect(resolve(km, c, { context: "export", phase: "done" })).toBe("export.copyPath");
    expect(resolve(km, esc, { context: "export", phase: "done" })).toBe("export.close");
    // Outside the dialog Esc is the general one.
    expect(resolve(km, esc, "timeline")).toBe("everywhere.escape");
  });

  it("home keys", () => {
    expect(resolve(km, ev("ArrowDown", "ArrowDown", { repeat: true }), "home")).toBe("home.selectNext");
    expect(resolve(km, ev("Enter", "Enter"), "home")).toBe("home.open");
    expect(resolve(km, ev("Delete", "Delete"), "home")).toBe("home.remove");
  });

  it("modifier-only presses resolve to nothing", () => {
    expect(resolve(km, ev("Shift", "ShiftLeft", { shift: true }), "transcript")).toBeNull();
  });
});

describe("rebinding", () => {
  it("refuses a key used in the same context", () => {
    const r = rebind(createKeymap(), "timeline.split", "Q");
    expect(r).toMatchObject({ ok: false, reason: "clash", with: "timeline.trimStart" });
  });

  it("refuses a key used everywhere", () => {
    const r = rebind(createKeymap(), "timeline.split", "Space");
    expect(r).toMatchObject({ ok: false, reason: "clash", with: "everywhere.playPause" });
    const r2 = rebind(createKeymap(), "transcript.restore", "Ctrl+Z");
    expect(r2).toMatchObject({ ok: false, reason: "clash", with: "everywhere.undo" });
  });

  it("refuses, for an everywhere action, a key any context uses", () => {
    expect(rebind(createKeymap(), "everywhere.find", "S")).toMatchObject({ ok: false, reason: "clash", with: "timeline.split" });
    expect(rebind(createKeymap(), "everywhere.find", "Enter")).toMatchObject({ ok: false, reason: "clash" });
  });

  it("allows a key used only in another context", () => {
    const km = ok(rebind(createKeymap(), "timeline.split", "R"));
    expect(chordsFor(km, "timeline.split")).toEqual(["R"]);
    expect(resolve(km, ev("r", "KeyR"), "timeline")).toBe("timeline.split");
    expect(resolve(km, ev("s", "KeyS"), "timeline")).toBeNull();
    expect(resolve(km, ev("r", "KeyR"), "transcript")).toBe("transcript.restore");
    expect(findClashes(km.chords)).toEqual([]);
  });

  it("allows export states that never coexist to share a key, and the Esc shadow", () => {
    const km = ok(rebind(createKeymap(), "export.copyPath", "X"));
    // changeFolder (confirm) may take X too: copyPath only acts when done.
    const km2 = ok(rebind(km, "export.changeFolder", "X"));
    expect(resolve(km2, ev("x", "KeyX"), { context: "export", phase: "confirm" })).toBe("export.changeFolder");
    expect(resolve(km2, ev("x", "KeyX"), { context: "export", phase: "done" })).toBe("export.copyPath");
    const km3 = ok(rebind(createKeymap(), "export.close", "Q"));
    expect(ok(rebind(km3, "export.close", "Escape")).chords.get("export.close")).toEqual(["Escape"]);
    expect(rebind(createKeymap(), "export.confirm", "Escape")).toMatchObject({ ok: false, reason: "clash" });
  });

  it("refuses unknown actions and unreadable chords; keeps the keymap unchanged", () => {
    const km = createKeymap();
    expect(rebind(km, "timeline.nope", "X")).toEqual({ ok: false, reason: "unknown_action" });
    expect(rebind(km, "timeline.split", "Ctrl+")).toEqual({ ok: false, reason: "invalid_chord" });
    expect(chordsFor(km, "timeline.split")).toEqual(["S"]);
  });

  it("accepts loose spellings and stores the canonical chord", () => {
    const km = ok(rebind(createKeymap(), "timeline.zoomIn", "ctrl+="));
    expect(chordsFor(km, "timeline.zoomIn")).toEqual(["Ctrl+="]);
  });

  it("resetAction puts defaults back, or refuses when they are now taken", () => {
    let km = ok(rebind(createKeymap(), "timeline.split", "R"));
    km = ok(rebind(km, "timeline.trimStart", "S"));
    expect(resetAction(km, "timeline.split")).toMatchObject({ ok: false, reason: "clash", with: "timeline.trimStart" });
    km = ok(resetAction(km, "timeline.trimStart"));
    km = ok(resetAction(km, "timeline.split"));
    expect(toOverrides(km)).toEqual([]);
  });
});

describe("overrides", () => {
  it("toOverrides lists only changed actions, one entry per chord", () => {
    expect(toOverrides(createKeymap())).toEqual([]);
    let km = ok(rebind(createKeymap(), "timeline.split", "X"));
    km = ok(rebind(km, "transcript.cut", "Backspace"));
    expect(toOverrides(km)).toEqual([
      { action: "transcript.cut", context: "transcript", chord: "Backspace" },
      { action: "timeline.split", context: "timeline", chord: "X" },
    ]);
  });

  it("saving and loading gives back the same keymap", () => {
    let km = ok(rebind(createKeymap(), "timeline.split", "X"));
    km = ok(rebind(km, "everywhere.find", "Ctrl+K"));
    km = ok(rebind(km, "transcript.restore", "U"));
    const saved = toOverrides(km);
    const loaded = createKeymap(saved);
    expect(loaded.rejected).toEqual([]);
    for (const x of KEY_ACTIONS) expect(chordsFor(loaded, x.id), x.id).toEqual(chordsFor(km, x.id));
    expect(toOverrides(loaded)).toEqual(saved);
  });

  it("several saved bindings for one action give it several keys", () => {
    const km = createKeymap([
      { action: "timeline.split", context: "timeline", chord: "X" },
      { action: "timeline.split", context: "timeline", chord: "Shift+X" },
    ]);
    expect(chordsFor(km, "timeline.split")).toEqual(["X", "Shift+X"]);
    expect(resolve(km, ev("X", "KeyX", { shift: true }), "timeline")).toBe("timeline.split");
  });

  it("an override may take a key another override freed", () => {
    const km = createKeymap([
      { action: "timeline.trimStart", context: "timeline", chord: "S" },
      { action: "timeline.split", context: "timeline", chord: "Q" },
    ]);
    expect(km.rejected).toEqual([]);
    expect(resolve(km, ev("s", "KeyS"), "timeline")).toBe("timeline.trimStart");
    expect(resolve(km, ev("q", "KeyQ"), "timeline")).toBe("timeline.split");
  });

  it("rejects bad saved bindings and keeps the defaults for them", () => {
    const bad: KeyBinding[] = [
      { action: "timeline.gone", context: "timeline", chord: "X" },
      { action: "timeline.split", context: "transcript", chord: "X" },
      { action: "timeline.trimEnd", context: "timeline", chord: "Hyper+X" },
      { action: "timeline.zoomFit", context: "timeline", chord: "Q" }, // clashes with trimStart
      { action: "transcript.restore", context: "transcript", chord: "Space" }, // clashes with everywhere
    ];
    const km = createKeymap(bad);
    expect(km.rejected).toHaveLength(5);
    expect(chordsFor(km, "timeline.split")).toEqual(["S"]);
    expect(chordsFor(km, "timeline.trimEnd")).toEqual(["W"]);
    expect(chordsFor(km, "timeline.zoomFit")).toEqual(["0"]);
    expect(chordsFor(km, "transcript.restore")).toEqual(["R"]);
    expect(findClashes(km.chords)).toEqual([]);
    expect(toOverrides(km)).toEqual([]);
  });

  it("two overrides that clash with each other: one is dropped, the keymap stays clash-free", () => {
    const km = createKeymap([
      { action: "timeline.split", context: "timeline", chord: "X" },
      { action: "timeline.trimEnd", context: "timeline", chord: "X" },
    ]);
    expect(km.rejected).toHaveLength(1);
    expect(findClashes(km.chords)).toEqual([]);
  });
});

describe("shortcut overlay and hints", () => {
  it("groups by context in the order of spec 1.10, then Home and Export", () => {
    const groups = shortcutGroups(createKeymap());
    expect(groups.map((g) => g.title)).toEqual(["Everywhere", "Transcript view", "Timeline view", "Home", "Export"]);
    expect(groups.reduce((n, g) => n + g.entries.length, 0)).toBe(KEY_ACTIONS.length);
    const everywhere = groups[0]!;
    expect(everywhere.entries[0]).toMatchObject({ id: "everywhere.playPause", keys: ["Space"] });
    expect(everywhere.entries.find((e) => e.id === "everywhere.showShortcuts")?.keys).toEqual(["?"]);
    const cut = groups[1]!.entries.find((e) => e.id === "transcript.cut");
    expect(cut?.keys).toEqual(["Del", "Backspace"]);
  });

  it("shows the current binding after a rebind", () => {
    const km = ok(rebind(createKeymap(), "timeline.split", "X"));
    const split = shortcutGroups(km)[2]!.entries.find((e) => e.id === "timeline.split");
    expect(split?.keys).toEqual(["X"]);
    const hints = screenHints(km, "timeline");
    expect(hints.items.find((h) => h.label === "split")?.keys).toEqual(["x"]);
  });

  it("screen hints match the mockup bars", () => {
    const km = createKeymap();
    expect(screenHints(km, "home")).toEqual({
      items: [{ keys: ["enter"], label: "open" }, { keys: ["ctrl n"], label: "new project" }],
      trailing: { keys: ["?"], label: "all shortcuts" },
    });
    expect(screenHints(km, "timeline").items).toEqual([
      { keys: ["↑", "↓"], label: "jump to cut" },
      { keys: [",", "."], label: "nudge edge" },
      { keys: ["s"], label: "split" },
      { keys: ["del"], label: "remove clip" },
    ]);
    expect(screenHints(km, "transcribing").items[1]).toEqual({ keys: ["i", "o"], label: "mark range" });
    expect(screenHints(km, "suggestion")).toEqual({ items: [{ keys: ["a"], label: "cut" }, { keys: ["d"], label: "keep" }] });
    expect(screenHints(km, "exportConfirm").items).toEqual([{ keys: ["enter"], label: "export" }, { keys: ["esc"], label: "cancel" }]);
  });
});
