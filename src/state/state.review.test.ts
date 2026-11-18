/**
 * Review tests (track state-review): defects found in the state module. These are left
 * failing on purpose for the fixer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StandinOptions } from "./core";
import { createTestRig, type TestRig } from "./testing";

let rig: TestRig;
const state = () => rig.store.getState();

async function openDemo(coreOptions: StandinOptions = {}): Promise<void> {
  rig = createTestRig({ stepMs: 100, transcriptBatches: 4, ...coreOptions }, { autosaveMs: 300 });
  await rig.store.init();
  await rig.store.dispatch("ui.openProject", { projectId: rig.core.demo.projectId });
  await rig.store.idle();
}

async function run(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await rig.store.idle();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  rig?.store.dispose();
  rig?.core.dispose();
  vi.useRealTimers();
});

describe("review: export cancelled before start_export answers", () => {
  it("Esc right after Enter must stop the export, not leave it running", async () => {
    await openDemo();
    // start_export is in flight over IPC: the core has not queued the job yet.
    const gate = deferred();
    const original = rig.core.startExport.bind(rig.core);
    rig.core.startExport = (request) => gate.promise.then(() => original(request));
    const finished: string[] = [];
    rig.core.onExportFinished((r) => finished.push(r.path));

    await rig.store.dispatch("everywhere.export");
    expect(state().dialogs.export!.phase).toBe("confirm");
    const started = rig.store.dispatch("export.confirm");
    expect(state().dialogs.export!.phase).toBe("running");
    await rig.store.dispatch("export.cancel");
    // The dialog says "Export cancelled. The project is untouched."
    expect(state().dialogs.export).toBeNull();
    expect(state().notices.find((n) => n.id === "export")!.text).toMatch(/cancelled/i);

    gate.resolve();
    await started;
    await run(5000);
    // The export ran to completion anyway and wrote a file the user cancelled.
    expect(finished).toEqual([]);
    expect(state().project!.lastExport).toBeFalsy();
  });
});

describe("review: player notice once playback works again", () => {
  it("the 'press Space again' notice goes away when playback starts", async () => {
    await openDemo();
    rig.player.emit({ type: "error", error: { code: "play_rejected", sourceId: null, message: "NotAllowedError" } });
    expect(state().notices.some((n) => n.id === "player")).toBe(true);
    await rig.store.dispatch("everywhere.playPause");
    expect(state().playhead.playing).toBe(true);
    expect(state().playerError).toBeNull();
    // Playback works, yet the notice still tells the user it did not start.
    expect(state().notices.some((n) => n.id === "player")).toBe(false);
  });
});

describe("review: an edit made while another project is being opened", () => {
  it("is saved to the project it was made in", async () => {
    await openDemo({ pickedFiles: ["D:\\Footage\\NEW.mp4"] });
    const gate = deferred();
    const original = rig.core.createProject.bind(rig.core);
    rig.core.createProject = (paths) => gate.promise.then(() => original(paths));

    const creating = rig.store.dispatch("everywhere.newProject");
    for (let i = 0; i < 50 && state().busy === null; i++) await Promise.resolve();
    expect(state().busy).toBe("Importing footage");
    // The demo project is still on screen and still editable: the user splits a clip.
    await rig.store.dispatch("ui.seek", { time: 5_000_000 });
    await rig.store.dispatch("timeline.split");
    expect(state().edit!.current.clips).toHaveLength(2);
    expect(state().project!.id).toBe(rig.core.demo.projectId);

    gate.resolve();
    await creating;
    await run(5000);
    expect(state().project!.name).toBe("NEW");
    const demo = await rig.core.openProject(rig.core.demo.projectId);
    // The split was accepted on screen, then silently lost.
    expect(demo.project.edit.current.clips).toHaveLength(2);
  });
});
