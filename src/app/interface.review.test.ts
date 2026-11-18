/**
 * Review tests (track interface-review): defects found in the joined-up interface. They fail
 * on purpose until the fix lands; each one names the steps a user takes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRig, type TestRig } from "../state/testing";

let rig: TestRig;
const state = () => rig.store.getState();

async function run(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await rig.store.idle();
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  rig?.store.dispose();
  rig?.core.dispose();
  vi.useRealTimers();
});

describe("review: UC1, the 'cannot play yet' notice after an import", () => {
  it("goes away as soon as the original is playable, not only when the proxy is ready", async () => {
    rig = createTestRig({ stepMs: 100, transcriptBatches: 4 });
    await rig.store.init();
    await rig.store.dispatch("everywhere.newProject");
    await rig.store.idle();
    const id = state().project!.sources[0]!.id;

    // The real player (src/player/Player.ts) reports no_address when it is loaded with a source
    // that has no playback address yet. In the browser this happens on every Ctrl+N: the
    // project is shown before the first source_assets_changed arrives.
    expect(rig.player.urlOf(id) ?? null).toBeNull();
    rig.player.emit({
      type: "error",
      error: { code: "no_address", sourceId: id, message: "this source has no playable video yet" },
    });
    // (Fixer: the store records the error but shows no notice while the source's assets are
    // not known yet; the rest of this test is the reviewer's, unchanged.)
    expect(state().playerError?.code).toBe("no_address");
    expect(state().notices.some((n) => n.id === "player")).toBe(false);

    // The core reports the original as playable (spec 2.4.2: the player uses the original
    // while the proxy is being made, 5 to 8 minutes for an hour of 4K).
    for (let i = 0; i < 50 && state().sources[id]?.assets?.playback !== "original"; i++) await run(50);
    expect(state().sources[id]?.assets?.playback).toBe("original");
    expect(rig.player.urlOf(id)).toBeTruthy();

    // The video is playable now (spec 1.6 UC1): the notice saying it is not must be gone.
    expect(state().notices.filter((n) => n.id === "player").map((n) => n.text)).toEqual([]);
    expect(state().playerError).toBeNull();
  });
});

describe("fix: the 'cannot play yet' notice when it is true", () => {
  it("shows for a source that cannot play until its proxy is made, and goes when the proxy is ready", async () => {
    // An .mkv original is not playable in the window (stand-in: directPlayable false).
    rig = createTestRig({ stepMs: 100, transcriptBatches: 2, pickedFiles: ["D:\Footage\talk.mkv"] });
    await rig.store.init();
    await rig.store.dispatch("everywhere.newProject");
    await rig.store.idle();
    const id = state().project!.sources[0]!.id;
    expect(state().notices.some((n) => n.id === "player")).toBe(false); // assets not known yet

    await run(100); // the first assets event: no playable address
    expect(state().sources[id]?.assets?.playback).toBe("none");
    expect(state().notices.filter((n) => n.id === "player").map((n) => n.text)).toEqual([
      "This part cannot play yet: its preview copy is still being made.",
    ]);
    expect(state().playerError?.code).toBe("no_address");

    for (let i = 0; i < 100 && state().sources[id]?.assets?.playback !== "proxy"; i++) await run(100);
    expect(state().sources[id]?.assets?.playback).toBe("proxy");
    expect(state().notices.filter((n) => n.id === "player")).toEqual([]);
    expect(state().playerError).toBeNull();
  });
});

describe("review: busy guard, Delete on Home while the selected project is opening", () => {
  it("does not remove the project that is being opened", async () => {
    rig = createTestRig({ stepMs: 100 });
    await rig.store.init();
    const opening = gate();
    const original = rig.core.openProject.bind(rig.core);
    vi.spyOn(rig.core, "openProject").mockImplementation(async (id) => {
      // The core has read the project file; its answer is still on its way back over IPC.
      const opened = await original(id);
      await opening.promise;
      return opened;
    });
    const remove = vi.spyOn(rig.core, "removeProject");

    // Enter on Home opens the selected project; open_project reads it from disk (slow).
    void rig.store.dispatch("home.open");
    await Promise.resolve();
    expect(state().busy).toBe("Opening project");
    // Delete, a moment later, on the same (still selected) row.
    void rig.store.dispatch("home.remove");
    await Promise.resolve();
    opening.open();
    await rig.store.idle();

    // Either the remove is refused while busy, or the open is abandoned. What must not happen:
    // the editor shows a project that was just removed from the list (its saves then go to a
    // project the core no longer lists).
    const shown = state().project?.id ?? null;
    const listed = state().projects.map((p) => p.id);
    expect({ shown, removed: remove.mock.calls.map((c) => c[0]), listed }).toEqual(
      shown === null ? { shown, removed: remove.mock.calls.map((c) => c[0]), listed } : { shown, removed: [], listed },
    );
    if (shown !== null) expect(listed).toContain(shown);
  });

  it("the mouse remove (ui.removeProject) is refused too while an open runs", async () => {
    rig = createTestRig({ stepMs: 100 });
    await rig.store.init();
    const opening = gate();
    const original = rig.core.openProject.bind(rig.core);
    vi.spyOn(rig.core, "openProject").mockImplementation(async (id) => {
      const opened = await original(id);
      await opening.promise;
      return opened;
    });
    const remove = vi.spyOn(rig.core, "removeProject");
    const target = state().projects[0]!.id;
    void rig.store.dispatch("home.open");
    await Promise.resolve();
    expect(state().busy).toBe("Opening project");
    await rig.store.dispatch("ui.removeProject", { projectId: target });
    expect(remove).not.toHaveBeenCalled();
    opening.open();
    await rig.store.idle();
    expect(state().project?.id).toBe(target);
    expect(state().projects.map((p) => p.id)).toContain(target);
    // Once nothing is running, removing works again.
    await rig.store.dispatch("ui.goHome");
    await rig.store.idle();
    await rig.store.dispatch("ui.removeProject", { projectId: target });
    expect(remove).toHaveBeenCalledWith(target);
  });
});
