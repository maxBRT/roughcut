/**
 * The overlays driven from the keyboard against the stand-in core (spec 3.7, "state and
 * views"): the "?" list with rebinding, the Locate file prompt, the notices with retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { chordsFor, KEY_ACTIONS } from "../../keys";
import { attachStoreKeys, RoughcutProvider } from "../../state";
import { appError, type StandinOptions } from "../../state/core";
import { createTestRig, pressKey, type TestRig } from "../../state/testing";
import { ExportDialog } from "../export";
import { LocateFilePrompt, Notices, ShortcutOverlay } from "./index";

let rig: TestRig;
let detachKeys: (() => void) | null = null;
const state = () => rig.store.getState();

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await rig.store.idle();
  });
}

/** One keystroke at the focused element (the body when nothing has focus). */
async function key(chord: string, target?: EventTarget): Promise<KeyboardEvent> {
  let event!: KeyboardEvent;
  await act(async () => {
    event = pressKey(chord, target ?? document.activeElement ?? document.body);
    await rig.store.idle();
  });
  await act(async () => {
    await rig.store.idle();
  });
  return event;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el);
    await rig.store.idle();
  });
  await act(async () => {
    await rig.store.idle();
  });
}

async function start(core: StandinOptions = {}, open = true): Promise<void> {
  rig = createTestRig({ stepMs: 100, transcriptBatches: 2, ...core });
  render(
    <RoughcutProvider store={rig.store}>
      <ExportDialog />
      <LocateFilePrompt />
      <ShortcutOverlay />
      <Notices />
    </RoughcutProvider>,
  );
  detachKeys = attachStoreKeys(rig.store, window);
  await act(async () => {
    await rig.store.init();
    if (open) await rig.store.dispatch("ui.openProject", { projectId: rig.core.demo.projectId });
    await rig.store.idle();
  });
}

const overlay = () => screen.getByRole("dialog", { name: "shortcuts" });
const row = (actionId: string) => overlay().querySelector<HTMLElement>(`[data-action="${actionId}"]`)!;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  detachKeys?.();
  detachKeys = null;
  rig?.store.dispose();
  rig?.core.dispose();
  vi.useRealTimers();
});

describe("ShortcutOverlay", () => {
  it("? shows every action from the keys registry, grouped, and Esc closes it", async () => {
    await start();
    expect(screen.queryByRole("dialog", { name: "shortcuts" })).toBeNull();
    await key("Shift+/");
    const box = overlay();
    const titles = within(box).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(["Everywhere", "Transcript view", "Timeline view", "Home", "Export"]);
    for (const a of KEY_ACTIONS) expect(row(a.id), a.id).not.toBeNull();
    // Keycaps are written as the hint bar writes them ("ctrl z"), as in the mockup.
    expect(row("everywhere.undo").textContent).toContain("ctrl z");
    expect(row("everywhere.undo").textContent).not.toContain("Ctrl+Z");
    expect(row("transcript.cut").textContent).toMatch(/del.*or.*backspace/);
    expect(row("everywhere.showShortcuts").textContent).toContain("?");
    await key("Escape");
    expect(screen.queryByRole("dialog", { name: "shortcuts" })).toBeNull();
  });

  it("rebinds one action with the mouse; the new key works at once and is saved", async () => {
    await start();
    await key("Shift+/");
    await click(within(row("everywhere.find")).getByRole("button", { name: /Change the key for/ }));
    expect(row("everywhere.find").getAttribute("data-waiting")).toBe("true");
    expect(overlay().textContent).toContain("Press the new key for “Find in transcript”");
    await key("Ctrl+K", document.body);
    expect(chordsFor(state().keymap, "everywhere.find")).toEqual(["Ctrl+K"]);
    expect(row("everywhere.find").textContent).toContain("ctrl k");
    expect(row("everywhere.find").getAttribute("data-waiting")).toBeNull();
    expect(overlay().textContent).toContain("“Find in transcript” is now Ctrl+K.");
    expect((await rig.core.getSettings()).keyBindings).toEqual([expect.objectContaining({ action: "everywhere.find", chord: "Ctrl+K" })]);

    await key("Escape");
    await key("Ctrl+K", document.body);
    expect(state().find.open).toBe(true);
  });

  it("refuses a key that is taken, says by what, and keeps waiting; Esc keeps the old key", async () => {
    await start();
    await key("Shift+/");
    await click(within(row("everywhere.find")).getByRole("button", { name: /Change the key for/ }));
    const undoBefore = state().edit;
    await key("Ctrl+Z", document.body);
    // The keystroke went to the overlay, not to Undo.
    expect(state().edit).toBe(undoBefore);
    expect(chordsFor(state().keymap, "everywhere.find")).toEqual(["Ctrl+F"]);
    expect(state().rebindError).toMatchObject({ reason: "clash", with: "everywhere.undo" });
    expect(overlay().textContent).toContain("Ctrl+Z is already used by “Undo”.");
    expect(row("everywhere.find").getAttribute("data-waiting")).toBe("true");

    await key("Escape", document.body);
    expect(screen.getByRole("dialog", { name: "shortcuts" })).toBeTruthy();
    expect(row("everywhere.find").getAttribute("data-waiting")).toBeNull();
    expect(overlay().textContent).not.toContain("already used");
    expect(chordsFor(state().keymap, "everywhere.find")).toEqual(["Ctrl+F"]);
  });

  it("works from the keyboard alone: arrows choose, Enter changes, Delete resets", async () => {
    await start();
    await key("Shift+/");
    expect(document.activeElement?.classList.contains("rcs-panel")).toBe(true);
    expect(row(KEY_ACTIONS[0]!.id).getAttribute("data-active")).toBe("true");
    await key("ArrowDown");
    await key("ArrowDown");
    const target = KEY_ACTIONS[2]!; // everywhere.pause (K)
    expect(row(target.id).getAttribute("data-active")).toBe("true");
    await key("Enter");
    expect(row(target.id).getAttribute("data-waiting")).toBe("true");
    await key("Ctrl+K", document.body);
    expect(chordsFor(state().keymap, target.id)).toEqual(["Ctrl+K"]);
    expect(within(row(target.id)).getByRole("button", { name: /Reset the key/ })).toBeTruthy();

    // Focus is back on the list: Delete resets the highlighted row to its default.
    expect(document.activeElement?.classList.contains("rcs-panel")).toBe(true);
    await key("Delete");
    expect(chordsFor(state().keymap, target.id)).toEqual(target.defaults);
  });

  it("reset all puts every key back", async () => {
    await start();
    await act(async () => {
      await rig.store.dispatch("ui.rebindKey", { actionId: "everywhere.find", chord: "Ctrl+K" });
      await rig.store.dispatch("ui.rebindKey", { actionId: "everywhere.pause", chord: "Ctrl+J" });
    });
    await key("Shift+/");
    const resetAll = within(overlay()).getByRole("button", { name: "reset all" }) as HTMLButtonElement;
    expect(resetAll.disabled).toBe(false);
    await click(resetAll);
    expect(chordsFor(state().keymap, "everywhere.find")).toEqual(["Ctrl+F"]);
    expect(chordsFor(state().keymap, "everywhere.pause")).toEqual(["K"]);
    expect((within(overlay()).getByRole("button", { name: "reset all" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("view keys do nothing behind the overlay", async () => {
    await start();
    await act(async () => {
      await rig.store.dispatch("ui.setView", { view: "timeline" });
    });
    await key("Shift+/");
    const clips = state().edit!.current.clips;
    await key("S", document.body); // split, a Timeline key
    expect(state().edit!.current.clips).toBe(clips);
  });

  it("a reset says what the key is back to, and a refused one names who has the key", async () => {
    await start();
    await act(async () => {
      await rig.store.dispatch("ui.rebindKey", { actionId: "everywhere.find", chord: "Ctrl+K" });
    });
    await key("Shift+/");
    await click(within(row("everywhere.find")).getByRole("button", { name: /Reset the key for/ }));
    expect(chordsFor(state().keymap, "everywhere.find")).toEqual(["Ctrl+F"]);
    expect(overlay().textContent).toContain("“Find in transcript” is back to Ctrl+F.");

    // Find moved again, and its usual key given to Pause: the reset is refused, with the reason.
    await act(async () => {
      await rig.store.dispatch("ui.rebindKey", { actionId: "everywhere.find", chord: "Ctrl+K" });
      await rig.store.dispatch("ui.rebindKey", { actionId: "everywhere.pause", chord: "Ctrl+F" });
    });
    await click(within(row("everywhere.find")).getByRole("button", { name: /Reset the key for/ }));
    expect(chordsFor(state().keymap, "everywhere.find")).toEqual(["Ctrl+K"]);
    expect(overlay().textContent).toContain("Ctrl+F is already used by “Pause”; change that one first.");
  });

  it("Tab moves inside the overlay and wraps; nothing behind it acts", async () => {
    await start();
    await act(async () => {
      await rig.store.dispatch("ui.rebindKey", { actionId: "everywhere.find", chord: "Ctrl+K" });
    });
    await key("Shift+/");
    const view = state().session.view;
    const close = within(overlay()).getByRole("button", { name: "close" });
    const resetAll = within(overlay()).getByRole("button", { name: "reset all" });
    const first = within(overlay()).getAllByRole("button")[0]!;
    act(() => close.focus());
    // From the last stop Tab wraps to the first (focus never leaves for the page behind).
    const ev = await key("Tab");
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(state().session.view).toBe(view);
    // Shift+Tab from the first wraps back to the last.
    await key("Shift+Tab");
    expect(document.activeElement).toBe(close);
    // With focus fallen to the page, Tab brings it back into the overlay; nothing switches.
    act(() => (document.activeElement as HTMLElement).blur());
    await key("Tab", document.body);
    expect(document.activeElement).toBe(first);
    expect(state().session.view).toBe(view);
    // "reset all" is a plain button in the tab order.
    expect(resetAll.tabIndex).toBe(0);
    await click(resetAll);
    expect(chordsFor(state().keymap, "everywhere.find")).toEqual(["Ctrl+F"]);
  });

  it("over the Export dialog, Esc closes only the overlay and Enter does not start the export", async () => {
    await start();
    await key("Ctrl+E", document.body);
    await key("Shift+/", document.body);
    act(() => within(overlay()).getByRole("button", { name: "close" }).focus());
    await key("Enter");
    expect(state().dialogs.export?.phase).toBe("confirm");
    await key("Escape");
    expect(screen.queryByRole("dialog", { name: "shortcuts" })).toBeNull();
    expect(state().dialogs.export?.phase).toBe("confirm");
    expect(screen.getByRole("dialog", { name: "export" })).toBeTruthy();
  });
});

describe("LocateFilePrompt", () => {
  it("opens for a missing source with its name and the Enter / Esc hints; Esc closes it", async () => {
    await start({}, false);
    await act(async () => {
      rig.core.setErrors({ missingSources: [rig.core.demo.sourceId] });
      await rig.store.dispatch("ui.openProject", { projectId: rig.core.demo.projectId });
      await rig.store.idle();
    });
    const prompt = screen.getByRole("dialog", { name: "locate file" });
    const name = state().dialogs.locate!.name;
    expect(prompt.textContent).toContain(`${name} was moved or deleted.`);
    expect(prompt.textContent).toContain(state().dialogs.locate!.path);
    const hints = within(prompt).getByRole("list", { name: "Shortcuts" });
    expect(hints.textContent).toContain("enterlocate…");
    expect(hints.textContent).toContain("escnot now");
    await key("Escape", document.body);
    expect(screen.queryByRole("dialog", { name: "locate file" })).toBeNull();
  });

  it("Enter locates once; a different file is refused with its own message; the right file closes it", async () => {
    await start({ pickedFiles: ["E:\\Other\\holiday.mp4"], errors: { mismatchPaths: ["E:\\Other\\holiday.mp4"] } }, false);
    await act(async () => {
      rig.core.setErrors({ missingSources: [rig.core.demo.sourceId] });
      await rig.store.dispatch("ui.openProject", { projectId: rig.core.demo.projectId });
      await rig.store.idle();
    });
    const pick = vi.spyOn(rig.core, "pickFiles");
    await key("Enter", document.body);
    expect(pick).toHaveBeenCalledTimes(1);
    const alert = within(screen.getByRole("dialog", { name: "locate file" })).getByRole("alert");
    expect(alert.getAttribute("data-code")).toBe("source_mismatch");
    expect(alert.textContent).toContain("That is a different file (holiday.mp4)");

    // The buttons do not take focus, so Enter is never handled twice.
    const locateButton = within(screen.getByRole("dialog", { name: "locate file" })).getByRole("button", { name: "locate…" });
    const md = fireEvent.mouseDown(locateButton);
    expect(md).toBe(false); // default (focusing) prevented
    expect(locateButton.tabIndex).toBe(-1);

    rig.core.setErrors({ mismatchPaths: [] });
    await click(locateButton);
    expect(pick).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog", { name: "locate file" })).toBeNull();
    expect(state().project!.sources[0]!.path).toBe("E:\\Other\\holiday.mp4");
  });

  it("not now closes the prompt for this session", async () => {
    await start({}, false);
    await act(async () => {
      rig.core.setErrors({ missingSources: [rig.core.demo.sourceId] });
      await rig.store.dispatch("ui.openProject", { projectId: rig.core.demo.projectId });
      await rig.store.idle();
    });
    await click(within(screen.getByRole("dialog", { name: "locate file" })).getByRole("button", { name: "not now" }));
    expect(state().dialogs.locate).toBeNull();
    expect(screen.queryByRole("dialog", { name: "locate file" })).toBeNull();
  });
});

describe("Notices", () => {
  it("shows a one-line notice with its retry, which dispatches the notice's action", async () => {
    await start();
    rig.core.failNext("save_edit", appError("internal", "The disk is busy."));
    await act(async () => {
      await rig.store.dispatch("ui.setRate", { rate: 2 });
    });
    await settle(2500);
    const list = screen.getByRole("list", { name: "Notices" });
    const item = list.querySelector<HTMLElement>('[data-id="save"]')!;
    expect(item.textContent).toContain("Could not save: The disk is busy.");
    expect(within(item).getByRole("alert")).toBeTruthy();
    const save = vi.spyOn(rig.core, "saveEdit");
    await click(within(item).getByRole("button", { name: "retry" }));
    expect(save).toHaveBeenCalled();
    expect(screen.queryByRole("list", { name: "Notices" })).toBeNull();
  });

  it("the close button dismisses a notice", async () => {
    await start({}, false);
    await act(async () => {
      rig.store.setState({ notices: [{ id: "t", kind: "warning", text: "Sources differ; the export follows the first clip." }] });
    });
    const list = screen.getByRole("list", { name: "Notices" });
    expect(within(list).getByRole("alert").textContent).toContain("Sources differ");
    await click(within(list).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("list", { name: "Notices" })).toBeNull();
  });
});
