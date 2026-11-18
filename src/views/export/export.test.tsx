/**
 * The Export dialog driven from the keyboard against the stand-in core (spec 3.7, "state and
 * views"): confirm with its figures and notices, the blocked states, running with cancel, done
 * with show in folder and copy path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { appError, type StandinOptions } from "../../state/core";
import { attachStoreKeys, defaultExportFileName, RoughcutProvider } from "../../state";
import { createTestRig, pressKey, type TestRig } from "../../state/testing";
import { Notices } from "../overlays";
import { ExportDialog } from "./index";
import { describeFormat, fitPath, formatBytes, formatClock, formatEstimate, formatLength, formatTimeLeft } from "./format";

let rig: TestRig;
let detachKeys: (() => void) | null = null;
const clipboard = { writeText: vi.fn(async (_t: string) => undefined) };
const state = () => rig.store.getState();

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await rig.store.idle();
  });
}

async function key(chord: string, target: EventTarget = document.body): Promise<void> {
  await act(async () => {
    pressKey(chord, target);
    await rig.store.idle();
  });
}

/** Opens the demo project with the dialog and notices mounted and the key listener attached. */
async function openDemo(core: StandinOptions = {}): Promise<void> {
  rig = createTestRig(
    { stepMs: 100, transcriptBatches: 2, now: () => new Date(2026, 10, 13, 9, 30), ...core },
    { clipboard, now: () => new Date(2026, 10, 13, 9, 30) },
  );
  render(
    <RoughcutProvider store={rig.store}>
      <ExportDialog />
      <Notices />
    </RoughcutProvider>,
  );
  detachKeys = attachStoreKeys(rig.store, window);
  await act(async () => {
    await rig.store.init();
    await rig.store.dispatch("ui.openProject", { projectId: rig.core.demo.projectId });
    await rig.store.idle();
  });
}

/** Runs the stand-in's export job until the dialog leaves `running`. */
async function runExport(): Promise<void> {
  for (let i = 0; i < 50 && state().dialogs.export?.phase === "running"; i++) await settle(100);
}

const dialog = () => screen.getByRole("dialog");

beforeEach(() => {
  vi.useFakeTimers();
  clipboard.writeText.mockClear();
});

afterEach(() => {
  cleanup();
  detachKeys?.();
  detachKeys = null;
  rig?.store.dispose();
  rig?.core.dispose();
  vi.useRealTimers();
});

describe("figures", () => {
  it("writes lengths, sizes and times as the mockup does", () => {
    expect(formatLength(2_472_000_000)).toBe("41:12");
    expect(formatLength(7_000_000)).toBe("0:07");
    expect(formatClock(3723)).toBe("1:02:03");
    expect(formatClock(-4)).toBe("0:00");
    expect(formatBytes(18.4 * 1024 ** 3, true)).toBe("18 gb");
    expect(formatBytes(17.6 * 1024 ** 3)).toBe("17.6 gb");
    expect(formatBytes(250 * 1024 ** 2)).toBe("250 mb");
    expect(formatBytes(0)).toBe("0 kb");
    expect(formatBytes(0, true)).toBe("0 kb");
    expect(formatBytes(-5)).toBe("0 kb");
    expect(formatBytes(20)).toBe("0.1 kb");
    expect(formatEstimate(20)).toBe("under a minute");
    expect(formatEstimate(170)).toBe("about 3 min");
    expect(formatEstimate(4200)).toBe("about 1 h 10 min");
    expect(formatTimeLeft(70)).toBe("1:10 left");
    expect(formatTimeLeft(null)).toBe("working out time left");
    expect(
      describeFormat({ codec: "hevc", width: 3840, height: 2160, frameRate: { num: 30000, den: 1001 }, bitDepth: 10, hdr: true, audioTracks: 2 }),
    ).toBe("3840×2160 · 29.97 fps · hevc 10-bit hdr · 2 audio tracks");
  });

  // Found in the real app with real paths (e2e "edge-sources"): a long folder was cut at its
  // end, so the dialog showed "C:\Users\alice\.t3\scratch\2026-11-13-i-need-a-…" and neither the
  // folder's own name nor the exported file's name could be read.
  it("shortens a long path in the middle, keeping the folder's and the file's names", () => {
    const folder = "C:\\Users\\alice\\.t3\\scratch\\2026-11-13-i-need-a-video-editor-651bb36b\\roughcut\\.cache-dev\\e2e\\run\\edge-sources\\work\\out-hdr";
    expect(fitPath("D:\\Videos\\To editor", 60)).toBe("D:\\Videos\\To editor");
    const short = fitPath(folder, 60);
    expect(short.length).toBeLessThanOrEqual(60);
    expect(short.startsWith("C:\\…\\")).toBe(true);
    expect(short.endsWith("\\edge-sources\\work\\out-hdr")).toBe(true);
    const file = `${folder}\\hdr-screen-capture-10-bit-2026-11-15.mp4`;
    expect(fitPath(file, 50)).toBe("C:\\…\\hdr-screen-capture-10-bit-2026-11-15.mp4");
    // Too narrow even for the file name: its end is kept.
    const tiny = fitPath(file, 20);
    expect(tiny).toBe("…-bit-2026-11-15.mp4");
    expect(tiny.length).toBe(20);
    expect(fitPath("/home/me/videos/out/weekly.mp4", 22)).toBe("/…/out/weekly.mp4");
  });
});

describe("Export dialog", () => {
  it("renders nothing while closed", async () => {
    await openDemo();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("confirm shows name, folder, length, size and time, with no quality choice", async () => {
    await openDemo();
    await key("Ctrl+E");
    const d = state().dialogs.export!;
    expect(d.phase).toBe("confirm");
    const plan = d.plan!;
    const box = dialog();
    expect(within(box).getByLabelText("File name")).toHaveProperty(
      "value",
      defaultExportFileName(state().project!.name, new Date(2026, 10, 13)),
    );
    expect(box.textContent).toContain("D:\\Exports");
    expect(box.textContent).toContain(
      `${formatLength(plan.duration)} · full quality · about ${formatBytes(plan.estimatedBytes, true)} · takes ${formatEstimate(plan.estimatedSeconds)}`,
    );
    expect(box.textContent).toContain(describeFormat(plan.format));
    // No quality choice (spec 2.9).
    expect(within(box).queryAllByRole("radio")).toHaveLength(0);
    expect(within(box).queryAllByRole("combobox")).toHaveLength(0);
    expect(box.textContent).not.toMatch(/smaller/i);
    // The hint bar from the keymap.
    const hints = within(box).getByRole("list", { name: "Shortcuts" });
    expect(hints.textContent).toContain("enterexport");
    expect(hints.textContent).toContain("esccancel");
    expect((within(box).getByRole("button", { name: "export mp4" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("runs from the keyboard: Enter exports, progress and time left, then done with show in folder and copy path", async () => {
    await openDemo();
    await key("Ctrl+E");
    await key("Enter");
    expect(state().dialogs.export?.phase).toBe("running");
    await settle(100);
    await settle(100);
    const running = dialog();
    expect(running.textContent).toContain(`exporting ${state().dialogs.export!.fileName}`);
    const bar = within(running).getByRole("progressbar", { name: "Export progress" });
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    expect(running.textContent).toMatch(/\d+:\d\d left/);
    expect(within(running).getByRole("button", { name: "cancel export" })).toBeTruthy();

    await runExport();
    const d = state().dialogs.export!;
    expect(d.phase).toBe("done");
    const r = d.result!;
    const done = dialog();
    expect(done.textContent).toContain(`${formatLength(r.duration)} · ${formatBytes(r.bytes)} · took ${formatClock(r.tookSeconds)}`);
    expect(done.textContent).toContain(r.path);

    await key("Enter");
    expect(rig.core.revealed).toEqual([r.path]);
    await key("C");
    expect(clipboard.writeText).toHaveBeenCalledWith(r.path);
    expect(within(dialog()).getByRole("button", { name: "path copied" })).toBeTruthy();

    await key("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(state().project?.lastExport?.path).toBe(r.path);
  });

  it("shows the three stages side by side as the mockup does: only the current one is live", async () => {
    await openDemo();
    await key("Ctrl+E");
    const stage = (name: string) =>
      Array.from(dialog().querySelectorAll<HTMLElement>("[data-active]")).find(
        (el) => el.querySelector(".rc-lbl")?.textContent === name,
      )!;
    // Confirm: running and done wait, dimmed, with no live progress bar and no keys of their own.
    expect(stage("confirm").getAttribute("data-active")).toBe("true");
    expect(stage("running").getAttribute("data-active")).toBe("false");
    expect(stage("done").getAttribute("data-active")).toBe("false");
    expect(within(dialog()).queryByRole("progressbar")).toBeNull();
    expect(within(stage("running")).queryAllByRole("button")).toHaveLength(0);
    expect(stage("done").textContent).toContain("not exported yet");
    expect(within(stage("confirm")).getByRole("button", { name: "change folder" })).toBeTruthy();

    await key("Enter");
    await settle(100);
    expect(state().dialogs.export?.phase).toBe("running");
    // Running: the confirm stage still shows the name and folder, but nothing in it can be used.
    expect(stage("confirm").getAttribute("data-active")).toBe("false");
    expect(stage("running").getAttribute("data-active")).toBe("true");
    expect((within(dialog()).getByLabelText("File name") as HTMLInputElement).disabled).toBe(true);
    expect(stage("confirm").textContent).toContain("D:\\Exports");
    expect(within(stage("confirm")).queryAllByRole("button")).toHaveLength(0);
    expect(within(dialog()).getAllByRole("progressbar")).toHaveLength(1);
    expect(within(dialog()).getAllByRole("button").map((b) => b.textContent)).toEqual(["cancel export"]);

    await runExport();
    expect(state().dialogs.export?.phase).toBe("done");
    expect(stage("running").getAttribute("data-active")).toBe("false");
    expect(stage("running").textContent).toContain("100%");
    expect(stage("done").getAttribute("data-active")).toBe("true");
    expect(within(dialog()).queryByRole("progressbar")).toBeNull();
    expect(within(dialog()).getAllByRole("button").map((b) => b.textContent)).toEqual(["show in folder", "copy path", "close"]);
  });

  it("the buttons dispatch the same actions as the keys", async () => {
    await openDemo();
    await key("Ctrl+E");
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "export mp4" }));
      await rig.store.idle();
    });
    await runExport();
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "show in folder" }));
      await rig.store.idle();
    });
    expect(rig.core.revealed).toHaveLength(1);
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "close" }));
      await rig.store.idle();
    });
    expect(state().dialogs.export).toBeNull();
  });

  it("Esc while running cancels: the dialog closes and the notice says so", async () => {
    await openDemo();
    await key("Ctrl+E");
    await key("Enter");
    await settle(100);
    expect(state().dialogs.export?.phase).toBe("running");
    await key("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
    const notices = screen.getByRole("list", { name: "Notices" });
    expect(notices.textContent).toMatch(/Export cancelled/);
  });

  it("C changes the folder and the plan follows", async () => {
    await openDemo({ pickedFolder: "E:\\Handover" });
    await key("Ctrl+E");
    await key("C");
    expect(state().dialogs.export?.folder).toBe("E:\\Handover");
    expect(dialog().textContent).toContain("E:\\Handover");
  });

  it("editing the name and pressing Enter in the field exports under that name", async () => {
    await openDemo();
    await key("Ctrl+E");
    const input = within(dialog()).getByLabelText("File name") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "for-sam.mp4" } });
    // Keys typed in the field are text: C does not change the folder.
    await key("C", input);
    expect(state().dialogs.export?.fileName).not.toBe("for-sam.mp4");
    await act(async () => {
      fireEvent.submit(input.form!);
      await rig.store.idle();
    });
    await settle(0);
    expect(state().dialogs.export?.fileName).toBe("for-sam.mp4");
    expect(state().dialogs.export?.phase).toBe("running");
    await runExport();
    expect(state().dialogs.export?.result?.path).toMatch(/for-sam\.mp4$/);
  });

  it("an empty name is not used", async () => {
    await openDemo();
    await key("Ctrl+E");
    const before = state().dialogs.export!.fileName;
    const input = within(dialog()).getByLabelText("File name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    await act(async () => {
      fireEvent.blur(input);
      await rig.store.idle();
    });
    expect(state().dialogs.export?.fileName).toBe(before);
    expect(input.value).toBe(before);
  });

  it("not enough disk space blocks the export with the core's own message and the folder", async () => {
    await openDemo({ errors: { diskFull: true } });
    await key("Ctrl+E");
    const d = state().dialogs.export!;
    const plan = d.plan!;
    const alert = within(dialog()).getByRole("alert");
    expect(alert.getAttribute("data-code")).toBe("disk_full");
    expect(alert.textContent).toContain(plan.blockedBy!.message);
    expect(alert.textContent).toContain(d.folder);
    // The amount needed is the core's to state (file plus temporary pieces): the view shows the
    // plan's requiredBytes, never the estimate, next to the free space.
    const required = (plan as typeof plan & { requiredBytes?: number }).requiredBytes!;
    expect(required).toBeGreaterThan(plan.estimatedBytes);
    const needed = alert.querySelector("[data-needed]")!;
    expect(needed.textContent).toBe(`Needs about ${formatBytes(required, true)} · ${formatBytes(plan.freeBytes)} free`);
    expect(formatBytes(required, true)).not.toBe(formatBytes(plan.estimatedBytes, true));
    expect((within(dialog()).getByRole("button", { name: "export mp4" }) as HTMLButtonElement).disabled).toBe(true);
    await key("Enter");
    expect(state().dialogs.export?.phase).toBe("confirm");
  });

  it("disk full without requiredBytes in the plan shows no figure of its own", async () => {
    await openDemo({ errors: { diskFull: true } });
    await key("Ctrl+E");
    const d = state().dialogs.export!;
    const { requiredBytes: _dropped, ...older } = d.plan! as NonNullable<typeof d.plan> & { requiredBytes?: number };
    await act(async () => {
      rig.store.setState({ dialogs: { ...state().dialogs, export: { ...d, plan: older } } });
    });
    const alert = within(dialog()).getByRole("alert");
    expect(alert.querySelector("[data-needed]")).toBeNull();
    expect(alert.textContent).not.toMatch(/Needs about/);
    expect(alert.textContent).toContain(older.blockedBy!.message);
  });

  it("a missing source blocks the export and names the file", async () => {
    await openDemo();
    const path = state().project!.sources[0]!.path;
    await act(async () => {
      rig.core.setErrors({ missingSources: [rig.core.demo.sourceId] });
      await rig.store.idle();
    });
    await act(async () => {
      await rig.store.dispatch("ui.closeLocate");
    });
    await key("Ctrl+E");
    const alert = within(dialog()).getByRole("alert");
    expect(alert.getAttribute("data-code")).toBe("source_missing");
    expect(alert.textContent).toContain(path.split("\\").pop()!);
    expect((within(dialog()).getByRole("button", { name: "export mp4" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("nothing kept blocks the export with a note", async () => {
    await openDemo();
    await act(async () => {
      await rig.store.dispatch("ui.setView", { view: "timeline" });
      for (let i = 0; i < 50 && state().edit!.current.clips.length > 0; i++) {
        await rig.store.dispatch("ui.seek", { time: 0 });
        await rig.store.dispatch("timeline.removeClip");
      }
      await rig.store.idle();
    });
    expect(state().edit!.current.clips).toHaveLength(0);
    await key("Ctrl+E");
    const alert = within(dialog()).getByRole("alert");
    expect(alert.getAttribute("data-code")).toBe("nothing_to_export");
    expect((within(dialog()).getByRole("button", { name: "export mp4" }) as HTMLButtonElement).disabled).toBe(true);
    // No figures for a file that cannot exist ("0:00 · about 0 kb", "0×0 · 0 audio tracks").
    expect(dialog().textContent).not.toMatch(/0×0|0 kb|audio track/);
    expect(dialog().textContent).toContain("nothing kept");
  });

  it("mixed sources show the plan's notice", async () => {
    await openDemo({ pickedFiles: ["D:\\Footage\\PHONE.mov"] });
    await act(async () => {
      await rig.store.dispatch("everywhere.addFootage");
      await rig.store.idle();
    });
    await settle(100);
    await key("Ctrl+E");
    const notes = within(dialog()).getByRole("list", { name: "Export notices" });
    expect(notes.textContent).toMatch(/Sources differ/);
  });

  it("a click on 'export mp4' while the plan is still being worked out waits for it, then starts", async () => {
    await openDemo();
    const plan = rig.core.planExport.bind(rig.core);
    vi.spyOn(rig.core, "planExport").mockImplementation(
      (req) => new Promise((resolve, reject) => setTimeout(() => plan(req).then(resolve, reject), 300)),
    );
    await act(async () => {
      pressKey("Ctrl+E", document.body);
    });
    expect(state().dialogs.export?.planning).toBe(true);
    const button = within(dialog()).getByRole("button", { name: "export mp4" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    const startSpy = vi.spyOn(rig.core, "startExport");
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button); // a double click starts one export
    });
    expect(state().dialogs.export?.phase).toBe("confirm");
    await settle(400);
    expect(state().dialogs.export?.phase).toBe("running");
    await runExport();
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(state().dialogs.export?.phase).toBe("done");
  });

  it("a failed start is shown in the confirm stage", async () => {
    await openDemo();
    rig.core.failNext("start_export", appError("export_failed", "FFmpeg stopped: the GPU encoder is busy."));
    await key("Ctrl+E");
    await key("Enter");
    expect(state().dialogs.export?.phase).toBe("confirm");
    const alert = within(dialog()).getByRole("alert");
    expect(alert.textContent).toContain("FFmpeg stopped");
  });

  it("a GPU encoder failure says what to do and folds FFmpeg's output away", async () => {
    // What the real core sent when the GPU was hidden (edge-speech, "No GPU available").
    const ffmpegTail =
      "FFmpeg exit code: 0xb1b4b1ab: [h264_nvenc @ 000001efd3f806c0] dl_fn->cuda_dl->cuInit(0) failed -> CUDA_ERROR_NO_DEVICE: no CUDA-capable device is detected [vost#0:0/h264_nvenc @ 000001efd3f80440] [enc:h264_nvenc @ 000001efd1c47d80] Error while opening encoder";
    await openDemo();
    rig.core.failNext("start_export", appError("gpu_unavailable", "The GPU encoder (NVENC) could not start", ffmpegTail));
    await key("Ctrl+E");
    await key("Enter");
    const alert = within(dialog()).getByRole("alert");
    expect(alert.getAttribute("data-code")).toBe("gpu_unavailable");
    expect(alert.querySelector(".rcx-blocked__detail")?.textContent).toMatch(/graphics driver is installed and up to date/);
    const tech = alert.querySelector("details.rcx-blocked__tech");
    expect(tech).not.toBeNull();
    expect((tech as HTMLDetailsElement).open).toBe(false);
    expect(tech?.querySelector("pre")?.textContent).toBe(ffmpegTail);
    // The raw output is not one of the visible sentences.
    for (const p of alert.querySelectorAll("p")) expect(p.textContent).not.toContain("CUDA_ERROR");
  });
});
