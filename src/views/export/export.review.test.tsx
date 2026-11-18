/**
 * Review tests (track viewExport-review): defects found in the Export dialog. Failing tests here
 * are left in place for the fixer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { attachStoreKeys, RoughcutProvider } from "../../state";
import { appError } from "../../state/core";
import { createTestRig, pressKey, type TestRig } from "../../state/testing";
import { LocateFilePrompt, Notices, ShortcutOverlay } from "../overlays";
import { ExportDialog } from "./index";

let rig: TestRig;
let detach: (() => void) | null = null;
const state = () => rig.store.getState();
const GiB = 1024 ** 3;

async function open(): Promise<void> {
  rig = createTestRig({ stepMs: 100, transcriptBatches: 2, pickedFolder: "E:\\Elsewhere" });
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
}

/** Puts a blocked disk_full plan with the given figures into the open dialog. */
async function blockDisk(estimatedBytes: number, freeBytes: number, message: string): Promise<HTMLElement> {
  await key("Ctrl+E", document.body);
  const d = state().dialogs.export!;
  await act(async () => {
    rig.store.setState({
      dialogs: {
        ...state().dialogs,
        export: {
          ...d,
          planning: false,
          plan: { ...d.plan!, estimatedBytes, freeBytes, blockedBy: appError("disk_full", message) },
        },
      },
    });
  });
  return within(screen.getByRole("dialog", { name: "export" })).getByRole("alert");
}

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

describe("review: Export dialog", () => {
  // Corrected by the fixer: the first version of this test required the view to print its own
  // "Needs about X; Y free" line, which contradicts the finding's own fix (the view must not work
  // out the amount needed; the core's message states it). It now checks that no such figure,
  // which could contradict the core, is shown.
  it("disk full: the view shows no amount of its own that could say the export fits (rounding)", async () => {
    await open();
    // Blocked: 18.4 GiB estimated, 18.2 GiB free (before this fix: "Needs about 18 gb; 18.2 gb free").
    const alert = await blockDisk(18.4 * GiB, 18.2 * GiB, "Not enough free space in the export folder.");
    const text = alert.textContent ?? "";
    expect(text).toContain("Not enough free space in the export folder.");
    expect(text).not.toMatch(/Needs about/);
    expect(text).not.toMatch(/18(\.\d)? gb/);
  });

  it("disk full: the detail does not contradict the real core's message (it needs about 3x the estimate)", async () => {
    await open();
    // What rc-media's plan_export returns when the file (x1.5 margin) plus the pieces (x1.5)
    // do not fit: 18 GB estimated, 40 GB free, blocked.
    const message = "Not enough disk space: the export needs about 54.0 GB on the drive of D:\\, and 40.0 GB is free.";
    const alert = await blockDisk(18_000_000_000, 40_000_000_000, message);
    const text = alert.textContent ?? "";
    expect(text).toContain(message);
    // Before this fix: "Needs about 17 gb; 37.3 gb free in D:\Exports" under that message.
    expect(text).not.toMatch(/Needs about/);
    expect(text).not.toMatch(/\d gb free/);
  });

  it("disk completely full: 0 bytes free is not shown as 0.1 kb", async () => {
    await open();
    const alert = await blockDisk(2 * GiB, 0, "Not enough free space in the export folder.");
    expect(alert.textContent).not.toContain("0.1 kb free");
  });

  it("editing the name then clicking 'export mp4' starts the export", async () => {
    await open();
    await key("Ctrl+E", document.body);
    // The real plan_export runs ffprobe per source: it takes a moment, unlike the stand-in.
    const plan = rig.core.planExport.bind(rig.core);
    vi.spyOn(rig.core, "planExport").mockImplementation(
      (req) => new Promise((resolve, reject) => setTimeout(() => plan(req).then(resolve, reject), 200)),
    );
    const box = screen.getByRole("dialog", { name: "export" });
    const input = within(box).getByLabelText("File name") as HTMLInputElement;
    const button = within(box).getByRole("button", { name: "export mp4" });
    input.focus();
    fireEvent.change(input, { target: { value: "for-sam.mp4" } });
    // A mouse click on the button: mousedown moves focus (the field blurs), then click ~100 ms later.
    await act(async () => {
      fireEvent.mouseDown(button);
      button.focus();
    });
    await act(async () => {
      vi.advanceTimersByTime(100);
      fireEvent.mouseUp(button);
      fireEvent.click(button);
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
      await rig.store.idle();
    });
    expect(state().dialogs.export?.fileName).toBe("for-sam.mp4");
    // Today the blur re-plans, the button is disabled under the pointer and the click is lost.
    expect(state().dialogs.export?.phase).toBe("running");
  });

  it("with the ? overlay open over the confirm stage, C does not open the folder picker behind it", async () => {
    await open();
    await key("Ctrl+E", document.body);
    await key("Shift+/", document.body);
    expect(screen.getByRole("dialog", { name: "shortcuts" })).toBeTruthy();
    const pick = vi.spyOn(rig.core, "pickFolder");
    await key("C");
    expect(pick).not.toHaveBeenCalled();
    expect(state().dialogs.export?.folder).not.toBe("E:\\Elsewhere");
  });

  it("a notice's Retry still works while the Export dialog is open", async () => {
    await open();
    rig.core.failNext("save_edit", appError("internal", "The disk is busy."));
    await act(async () => {
      await rig.store.dispatch("ui.setRate", { rate: 2 });
    });
    await act(async () => {
      vi.advanceTimersByTime(2500);
      await rig.store.idle();
    });
    const item = screen.getByRole("list", { name: "Notices" }).querySelector<HTMLElement>('[data-id="save"]')!;
    expect(item).not.toBeNull();
    await key("Ctrl+E", document.body);
    expect(state().dialogs.export).not.toBeNull();
    const save = vi.spyOn(rig.core, "saveEdit");
    await act(async () => {
      fireEvent.click(within(item).getByRole("button", { name: "retry" }));
      await rig.store.idle();
    });
    // The button is shown (above the dialog, z-index 110) but the store drops ui.retrySave.
    expect(save).toHaveBeenCalled();
  });
});
