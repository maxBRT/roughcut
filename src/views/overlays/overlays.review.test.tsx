/**
 * Review tests (track viewExport-review): defects found in the overlays. Failing tests here are
 * left in place for the fixer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { chordsFor } from "../../keys";
import { attachStoreKeys, RoughcutProvider } from "../../state";
import { createTestRig, pressKey, type TestRig } from "../../state/testing";
import { ExportDialog } from "../export";
import { LocateFilePrompt, Notices, ShortcutOverlay } from "./index";

let rig: TestRig;
let detach: (() => void) | null = null;
const state = () => rig.store.getState();

async function start(): Promise<void> {
  rig = createTestRig({ stepMs: 100, transcriptBatches: 2 });
  render(
    <RoughcutProvider store={rig.store}>
      <ExportDialog />
      <LocateFilePrompt />
      <ShortcutOverlay />
      <Notices />
    </RoughcutProvider>,
  );
  detach = attachStoreKeys(rig.store, window);
  await act(async () => {
    await rig.store.init();
    await rig.store.dispatch("ui.openProject", { projectId: rig.core.demo.projectId });
    await rig.store.idle();
  });
}

async function key(chord: string, target: EventTarget = document.activeElement ?? document.body): Promise<void> {
  await act(async () => {
    pressKey(chord, target);
    await rig.store.idle();
  });
  await act(async () => {
    await rig.store.idle();
  });
}

const overlay = () => screen.getByRole("dialog", { name: "shortcuts" });
const row = (id: string) => overlay().querySelector<HTMLElement>(`[data-action="${id}"]`)!;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  detach?.();
  detach = null;
  rig?.store.dispose();
  rig?.core.dispose();
  vi.useRealTimers();
});

describe("review: ShortcutOverlay", () => {
  it("a refused reset (its default key is now taken) says why instead of doing nothing", async () => {
    await start();
    await act(async () => {
      await rig.store.dispatch("ui.rebindKey", { actionId: "everywhere.find", chord: "Ctrl+K" });
      await rig.store.dispatch("ui.rebindKey", { actionId: "everywhere.pause", chord: "Ctrl+F" });
    });
    await key("Shift+/", document.body);
    await act(async () => {
      fireEvent.click(within(row("everywhere.find")).getByRole("button", { name: /Reset the key for/ }));
      await rig.store.idle();
    });
    // The store refused it: Ctrl+F belongs to Pause now.
    expect(chordsFor(state().keymap, "everywhere.find")).toEqual(["Ctrl+K"]);
    expect(state().rebindError).toMatchObject({ reason: "clash", with: "everywhere.pause" });
    // Today the overlay shows its idle text: the user sees nothing happen.
    expect(overlay().textContent).toMatch(/already used/);
  });

  it("'reset all' can be reached from the keyboard (Tab is not swallowed by the view switch behind)", async () => {
    await start();
    await act(async () => {
      await rig.store.dispatch("ui.rebindKey", { actionId: "everywhere.find", chord: "Ctrl+K" });
    });
    await key("Shift+/", document.body);
    const view = state().session.view;
    const ev = await (async () => {
      let e!: KeyboardEvent;
      await act(async () => {
        e = pressKey("Tab", document.activeElement ?? document.body);
        await rig.store.idle();
      });
      return e;
    })();
    // Tab switches Transcript/Timeline behind the modal list and its default (move focus) is
    // prevented, so focus never reaches "reset all"; the list has no key for it either.
    expect(state().session.view).toBe(view);
    expect(ev.defaultPrevented).toBe(false);
  });
});
