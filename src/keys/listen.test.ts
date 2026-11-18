import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { KeyContext } from "../types";
import { createKeymap, rebind, type KeyScope, type Keymap } from "./keymap";
import { attachKeys } from "./listen";

let detach: (() => void) | null = null;
afterEach(() => {
  detach?.();
  detach = null;
  document.body.innerHTML = "";
});

function setup(scope: KeyContext | KeyScope = "transcript", keymap: Keymap = createKeymap()) {
  const dispatch = vi.fn();
  let current = scope;
  let km = keymap;
  detach = attachKeys({ target: window, keymap: () => km, scope: () => current, dispatch });
  return {
    dispatch,
    setScope: (s: KeyContext | KeyScope) => (current = s),
    setKeymap: (k: Keymap) => (km = k),
    ids: () => dispatch.mock.calls.map((c) => c[0] as string),
  };
}

function press(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

describe("attachKeys", () => {
  it("dispatches the action and prevents the browser default", () => {
    const t = setup("transcript");
    const space = press({ key: " ", code: "Space" });
    const tab = press({ key: "Tab", code: "Tab" });
    expect(t.ids()).toEqual(["everywhere.playPause", "everywhere.switchView"]);
    expect(space.defaultPrevented).toBe(true);
    expect(tab.defaultPrevented).toBe(true);
  });

  it("leaves unbound keys alone", () => {
    const t = setup("transcript");
    const e = press({ key: "x", code: "KeyX" });
    expect(t.dispatch).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("follows the scope and keymap getters on every key", () => {
    const t = setup("transcript");
    press({ key: "ArrowLeft", code: "ArrowLeft" });
    t.setScope("timeline");
    press({ key: "ArrowLeft", code: "ArrowLeft" });
    t.setScope({ context: "export", phase: "done" });
    press({ key: "Enter", code: "Enter" });
    const r = rebind(createKeymap(), "everywhere.playPause", "P");
    if (!r.ok) throw new Error(r.reason);
    t.setKeymap(r.keymap);
    t.setScope("timeline");
    press({ key: "p", code: "KeyP" });
    expect(t.ids()).toEqual(["transcript.wordPrev", "timeline.stepFrameBack", "export.showInFolder", "everywhere.playPause"]);
  });

  it("swallows a held-down toggle without running it again, but repeats stepping", () => {
    const t = setup("timeline");
    press({ key: " ", code: "Space" });
    const held = press({ key: " ", code: "Space", repeat: true });
    press({ key: "ArrowRight", code: "ArrowRight" });
    press({ key: "ArrowRight", code: "ArrowRight", repeat: true });
    press({ key: "ArrowRight", code: "ArrowRight", repeat: true });
    expect(held.defaultPrevented).toBe(true);
    expect(t.ids()).toEqual(["everywhere.playPause", "timeline.stepFrameForward", "timeline.stepFrameForward", "timeline.stepFrameForward"]);
  });

  it("ignores events another handler already took", () => {
    const t = setup("transcript");
    const e = new KeyboardEvent("keydown", { key: "r", code: "KeyR", bubbles: true, cancelable: true });
    e.preventDefault();
    document.body.dispatchEvent(e);
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it("while typing in the find box only Esc acts; Enter is left to the box (real typing)", async () => {
    const t = setup("transcript");
    const input = document.createElement("input");
    input.type = "search";
    document.body.appendChild(input);
    input.focus();
    const user = userEvent.setup();
    await user.keyboard("hello r{Backspace}{ArrowLeft}");
    expect(input.value).toBe("hello ");
    expect(t.dispatch).not.toHaveBeenCalled();
    const enters: KeyboardEvent[] = [];
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") enters.push(e);
    });
    await user.keyboard("{Enter}{Shift>}{Enter}{/Shift}{Escape}");
    expect(enters).toHaveLength(2);
    expect(enters.every((e) => !e.defaultPrevented)).toBe(true);
    expect(t.ids()).toEqual(["everywhere.escape"]);
  });

  it("Enter in a find box built as a form still submits it", async () => {
    const t = setup("transcript");
    const form = document.createElement("form");
    const input = document.createElement("input");
    input.type = "search";
    form.appendChild(input);
    document.body.appendChild(form);
    const submitted = vi.fn((e: Event) => e.preventDefault());
    form.addEventListener("submit", submitted);
    input.focus();
    const user = userEvent.setup();
    await user.keyboard("word{Enter}");
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(t.dispatch).not.toHaveBeenCalled();
    form.remove();
  });

  it("real typing outside a text field: Shift+/ opens the overlay, Ctrl+Shift+Z redoes", async () => {
    const t = setup("timeline");
    const user = userEvent.setup();
    await user.keyboard("{Shift>}?{/Shift}");
    await user.keyboard("{Control>}{Shift>}Z{/Shift}{/Control}");
    await user.keyboard("{Shift>}<{/Shift}");
    expect(t.ids()).toEqual(["everywhere.showShortcuts", "everywhere.redo", "timeline.nudgeStartEarlier"]);
  });

  it("detaching stops dispatch", () => {
    const t = setup("transcript");
    detach?.();
    detach = null;
    press({ key: " ", code: "Space" });
    expect(t.dispatch).not.toHaveBeenCalled();
  });
});
