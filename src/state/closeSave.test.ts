/**
 * Found in the real app (e2e "resume"): moving the playhead and closing the window within the
 * autosave's 2 s left the project at the old position on the next start. The save started from
 * `beforeunload` / `pagehide` never reached the core. Closing the window now waits for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRig, type TestRig } from "./testing";
import { attachSaveOnClose } from "./wiring";

let rig: TestRig;
let detach: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  detach?.();
  detach = null;
  rig?.store.dispose();
  rig?.core.dispose();
  vi.useRealTimers();
});

async function openDemo(): Promise<{ close: () => Promise<void>; projectId: string }> {
  rig = createTestRig({ stepMs: 100, transcriptBatches: 2 });
  let onClose: (() => Promise<void>) | null = null;
  rig.core.onCloseRequested = (handler) => {
    onClose = handler;
    return () => {
      onClose = null;
    };
  };
  await rig.store.init();
  const projectId = rig.core.demo.projectId;
  await rig.store.dispatch("ui.openProject", { projectId });
  await rig.store.idle();
  detach = attachSaveOnClose(rig.store, window);
  expect(onClose).not.toBeNull();
  return { close: () => onClose!(), projectId };
}

describe("closing the window", () => {
  it("saves a playhead moved just before, before the window goes", async () => {
    const { close, projectId } = await openDemo();
    await rig.store.dispatch("ui.seek", { time: 40_000_000 });
    const position = rig.store.getState().playhead.position;
    expect(position).not.toBeNull();
    expect(rig.store.getState().save.pending).toBe(true); // the autosave would come 2 s later

    await close();
    const saved = await rig.core.openProject(projectId);
    expect(saved.project.session.playhead).toEqual(position);
  });

  it("saves an edit made just before", async () => {
    const { close, projectId } = await openDemo();
    const clipsBefore = rig.store.getState().edit!.current.clips.length;
    await rig.store.dispatch("ui.seek", { time: 10_000_000 });
    await rig.store.dispatch("everywhere.switchView");
    await rig.store.dispatch("timeline.split");
    const clips = rig.store.getState().edit!.current.clips;
    expect(clips.length).toBe(clipsBefore + 1);

    await close();
    const saved = await rig.core.openProject(projectId);
    expect(saved.project.edit.current.clips).toEqual(clips);
    expect(saved.project.session.view).toBe("timeline");
  });

  it("pauses playback so the saved playhead is where the picture stopped", async () => {
    const { close, projectId } = await openDemo();
    await rig.store.dispatch("everywhere.playPause");
    rig.player.advance(1500);
    expect(rig.store.getState().playhead.playing).toBe(true);

    await close();
    const s = rig.store.getState();
    expect(s.playhead.playing).toBe(false);
    const saved = await rig.core.openProject(projectId);
    expect(saved.project.session.playhead).toEqual(s.playhead.position);
  });
});
