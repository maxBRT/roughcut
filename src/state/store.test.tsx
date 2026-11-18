/**
 * The store's wiring: every action has a handler, autosave, event folding, the player kept
 * loaded, Locate file, Claude unavailable with retry, key binding overrides.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../App";
import { KEY_ACTIONS } from "../keys";
import { EVENTS } from "../types";
import { UI_ACTION_IDS } from "./actions";
import { appError, type StandinOptions } from "./core";
import { createRoughcutStore, defaultExportFileName } from "./store";
import { createTestRig, FakePlayer, pressKey, type TestRig } from "./testing";
import { attachStoreKeys } from "./wiring";

let rig: TestRig;
const state = () => rig.store.getState();

async function setup(coreOptions: StandinOptions = {}, autosaveMs = 300): Promise<TestRig> {
  rig = createTestRig({ stepMs: 100, transcriptBatches: 4, ...coreOptions }, { autosaveMs, sessionSaveMs: 2000 });
  await rig.store.init();
  return rig;
}

async function openDemo(coreOptions: StandinOptions = {}): Promise<void> {
  await setup(coreOptions);
  await rig.store.dispatch("ui.openProject", { projectId: rig.core.demo.projectId });
  await rig.store.idle();
}

async function run(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await rig.store.idle();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  rig?.store.dispose();
  rig?.core.dispose();
  vi.useRealTimers();
});

describe("actions", () => {
  it("has a handler for every action in the keys registry and every mouse action", async () => {
    await setup();
    const handled = new Set(rig.store.actionIds);
    const missing = KEY_ACTIONS.map((a) => a.id).filter((id) => !handled.has(id));
    expect(missing).toEqual([]);
    expect(UI_ACTION_IDS.filter((id) => !handled.has(id))).toEqual([]);
    // Nothing is handled that is neither a key action nor a declared mouse action.
    const declared = new Set<string>([...KEY_ACTIONS.map((a) => a.id), ...UI_ACTION_IDS]);
    expect(rig.store.actionIds.filter((id) => !declared.has(id))).toEqual([]);
  });

  it("an unknown action is ignored", async () => {
    await setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await rig.store.dispatch("nothing.here");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("mouse and keyboard do the same thing", async () => {
    await openDemo();
    const detach = attachStoreKeys(rig.store, window);
    pressKey("Tab");
    expect(state().session.view).toBe("timeline");
    await rig.store.dispatch("ui.setView", { view: "transcript" });
    expect(state().session.view).toBe("transcript");
    await rig.store.dispatch("ui.selectTokens", { anchorToken: 2, focusToken: 4 });
    expect(state().selection).toEqual({ anchor: 2, focus: 5 });
    pressKey("Delete");
    expect(state().layout!.tokens[2]!.keep).toBe("cut");
    await rig.store.dispatch("ui.placeCaret", { boundary: 10 });
    expect(state().selection).toEqual({ anchor: 10, focus: 10 });
    expect(state().playhead.position!.at).toBe(state().layout!.tokens[10]!.token.start);
    detach();
  });
});

describe("autosave", () => {
  it("saves shortly after an edit, without delaying the edit", async () => {
    await openDemo();
    const save = vi.spyOn(rig.core, "saveEdit");
    // Words inside the text (a cut from the first word reaches the source start: one clip).
    await rig.store.dispatch("ui.selectTokens", { anchorToken: 1, focusToken: 3 });
    void rig.store.dispatch("transcript.cut");
    // The edit is there at once; nothing written yet.
    expect(state().edit!.current.clips).toHaveLength(2);
    expect(state().save.pending).toBe(true);
    expect(save).not.toHaveBeenCalled();
    await run(299);
    expect(save).not.toHaveBeenCalled();
    await run(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![1]).toEqual(state().edit);
    expect(state().save.pending).toBe(false);
    expect(state().save.lastSavedAt).not.toBeNull();
    // The core has it: a fresh open returns the same edit.
    const opened = await rig.core.openProject(rig.core.demo.projectId);
    expect(opened.project.edit).toEqual(state().edit);
  });

  it("several quick edits are written together; flushSave writes at once (on close)", async () => {
    await openDemo();
    const save = vi.spyOn(rig.core, "saveEdit");
    await rig.store.dispatch("timeline.split");
    await rig.store.dispatch("ui.seek", { time: 10_000_000 });
    await rig.store.dispatch("timeline.split");
    await rig.store.dispatch("ui.seek", { time: 20_000_000 });
    await rig.store.dispatch("timeline.split");
    expect(save).not.toHaveBeenCalled();
    await rig.store.flushSave();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![1].current.clips).toHaveLength(3);
    await run(5000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("a change of view or playhead alone is saved later; a failed save is retried", async () => {
    await openDemo();
    const save = vi.spyOn(rig.core, "saveEdit");
    await rig.store.dispatch("everywhere.switchView");
    await run(1000);
    expect(save).not.toHaveBeenCalled();
    await run(1000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![2].view).toBe("timeline");

    rig.core.failNext("save_edit", appError("internal", "disk unplugged"));
    await rig.store.dispatch("ui.seek", { time: 5_000_000 });
    await rig.store.dispatch("timeline.split");
    await run(300);
    expect(state().save.error!.message).toBe("disk unplugged");
    const notice = state().notices.find((n) => n.id === "save")!;
    expect(notice.retry!.action).toBe("ui.retrySave");
    await rig.store.dispatch(notice.retry!.action);
    expect(state().save.error).toBeNull();
    expect(state().notices.some((n) => n.id === "save")).toBe(false);
  });

  it("opening another project saves the current one first", async () => {
    await openDemo({ pickedFiles: ["D:\\Footage\\NEW.mp4"] });
    await rig.store.dispatch("ui.seek", { time: 5_000_000 });
    await rig.store.dispatch("timeline.split");
    const save = vi.spyOn(rig.core, "saveEdit");
    await rig.store.dispatch("everywhere.newProject");
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toBe(rig.core.demo.projectId);
    expect(state().project!.name).toBe("NEW");
  });
});

describe("event folding", () => {
  it("folds job updates, assets, transcript batches, completion and suggestions", async () => {
    await setup({ pickedFiles: ["D:\\Footage\\T.mkv"] });
    await rig.store.dispatch("everywhere.newProject");
    const id = state().project!.sources[0]!.id;
    // Probe jobs were reported during create_project.
    expect(Object.values(state().jobs).some((j) => j.kind === "probe" && j.sourceId === id && j.state === "done")).toBe(true);
    await run(100);
    expect(Object.values(state().jobs).some((j) => j.kind === "proxy" && j.state === "running")).toBe(true);
    // An .mkv is not playable before its proxy: no address yet.
    expect(state().sources[id]!.assets!.playback).toBe("none");
    expect(rig.player.urlOf(id)).toBeNull();

    const counts: number[] = [];
    for (let i = 0; i < 4; i++) {
      await run(100);
      counts.push(state().sources[id]!.transcript?.utterances.length ?? 0);
    }
    expect(counts[0]).toBeGreaterThan(0);
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);
    await run(5000);
    const entry = state().sources[id]!;
    expect(entry.transcript!.complete).toBe(true);
    expect(entry.transcript!.model).not.toBe("");
    expect(entry.suggestions!.claudeModel).toBeDefined();
    expect(entry.assets!.playback).toBe("proxy");
    expect(rig.player.urlOf(id)).toContain("/proxy");
    // Utterances arrive once each, in order.
    const indexes = entry.transcript!.utterances.map((u) => u.index);
    expect(indexes).toEqual([...new Set(indexes)].sort((a, b) => a - b));
  });

  it("an event for a source arriving before the project is known is kept", async () => {
    await setup();
    let emit: ((p: unknown) => void) | null = null;
    rig.store.dispose();
    // A fresh store whose core sends a transcript batch for a source it has not seen yet.
    const core = rig.core;
    const original = core.onTranscriptAppended.bind(core);
    core.onTranscriptAppended = (h) => {
      emit = h as (p: unknown) => void;
      return original(h);
    };
    rig.store = createRoughcutStore({ core, player: new FakePlayer() });
    emit!({ sourceId: "later", utterances: [{ index: 0, start: 0, end: 10, tokens: [] }] });
    expect(rig.store.getState().sources["later"]!.transcript!.utterances).toHaveLength(1);
  });

  it("keeps the player loaded with the clips after every edit", async () => {
    await openDemo();
    const loads = rig.player.callsOf("load").length;
    await rig.store.dispatch("ui.seek", { time: 5_000_000 });
    await rig.store.dispatch("timeline.split");
    expect(rig.player.callsOf("load").length).toBe(loads + 1);
    expect(rig.player.input!.clips).toEqual(state().edit!.current.clips);
    // A seek alone does not reload.
    await rig.store.dispatch("ui.seek", { time: 1_000_000 });
    expect(rig.player.callsOf("load").length).toBe(loads + 1);
  });

  it("a player attached later is loaded and put at the playhead", async () => {
    await setup();
    rig.store.attachPlayer(null);
    await rig.store.dispatch("ui.openProject", { projectId: rig.core.demo.projectId });
    await rig.store.dispatch("ui.seek", { time: 3_000_000 });
    const p = new FakePlayer();
    rig.store.attachPlayer(p);
    expect(p.input!.clips).toEqual(state().edit!.current.clips);
    expect(p.callsOf("seek").pop()!.t).toBe(3_000_000);
    expect(p.frame.time).toBe(3_000_000);
  });

  it("a player error shows a notice", async () => {
    await openDemo();
    rig.player.emit({ type: "error", error: { code: "no_address", sourceId: null, message: "x" } });
    expect(state().playerError!.code).toBe("no_address");
    expect(state().notices.some((n) => n.id === "player")).toBe(true);
  });
});

describe("Claude unavailable", () => {
  it("shows a one-line notice with a retry, and retry brings the suggestions", async () => {
    await setup({ errors: { claudeSignedOut: true }, pickedFiles: ["D:\\Footage\\C.mp4"] });
    await rig.store.dispatch("everywhere.newProject");
    await run(5000);
    const id = state().project!.sources[0]!.id;
    expect(state().sources[id]!.suggestionsError!.code).toBe("claude_signed_out");
    // Dead air was still found locally.
    expect(state().sources[id]!.suggestions!.suggestions.every((s) => s.origin === "local")).toBe(true);
    const notice = state().notices.find((n) => n.id === "claude")!;
    expect(notice.text).toMatch(/signed out/);
    expect(notice.retry!.action).toBe("ui.retryClaude");

    rig.core.setErrors({ claudeSignedOut: false });
    await rig.store.dispatch(notice.retry!.action, notice.retry!.payload);
    expect(state().notices.some((n) => n.id === "claude")).toBe(false);
    expect(state().claude!.signedIn).toBe(true);
    await run(1000);
    expect(state().sources[id]!.suggestions!.claudeModel).toBeDefined();
    expect(state().sources[id]!.suggestionsError).toBeNull();
  });
});

describe("Locate file", () => {
  it("a missing source opens the prompt; a different file is refused; the right one is accepted", async () => {
    const core = await setup({ pickedFiles: ["D:\\Moved\\OTHER.mp4"] });
    core.core.setErrors({ missingSources: [core.core.demo.sourceId], mismatchPaths: ["D:\\Moved\\OTHER.mp4"] });
    await rig.store.dispatch("ui.openProject", { projectId: rig.core.demo.projectId });
    // Edits are intact and the editor works.
    expect(state().screen).toBe("editor");
    expect(state().edit!.current.clips).toHaveLength(1);
    const prompt = state().dialogs.locate!;
    expect(prompt.sourceId).toBe(rig.core.demo.sourceId);
    expect(prompt.name).toBe("TAKE-1.mp4");

    await rig.store.dispatch("ui.locateSource");
    expect(state().dialogs.locate!.error!.code).toBe("source_mismatch");

    core.core.setErrors({ mismatchPaths: [] });
    await rig.store.dispatch("ui.locateSource");
    expect(state().dialogs.locate).toBeNull();
    expect(state().project!.sources[0]!.path).toBe("D:\\Moved\\OTHER.mp4");
    expect(state().sources[rig.core.demo.sourceId]!.assets!.online).toBe(true);
  });

  it("Esc closes the prompt for this session; a source going missing later opens it", async () => {
    await openDemo();
    expect(state().dialogs.locate).toBeNull();
    rig.core.setErrors({ missingSources: [rig.core.demo.sourceId] });
    expect(state().dialogs.locate!.sourceId).toBe(rig.core.demo.sourceId);
    await rig.store.dispatch("everywhere.escape");
    expect(state().dialogs.locate).toBeNull();
    rig.core.setErrors({ missingSources: [] });
    rig.core.setErrors({ missingSources: [rig.core.demo.sourceId] });
    expect(state().dialogs.locate).toBeNull();
  });
});

describe("key bindings from Settings", () => {
  it("a rebind is saved to settings and used at once; a clash is refused", async () => {
    await openDemo();
    const detach = attachStoreKeys(rig.store, window);
    await rig.store.dispatch("ui.rebindKey", { actionId: "transcript.cut", chord: "X" });
    expect(state().rebindError).toBeNull();
    expect(state().settings!.keyBindings).toEqual([{ action: "transcript.cut", context: "transcript", chord: "X" }]);
    await rig.store.dispatch("ui.selectTokens", { anchorToken: 1, focusToken: 2 });
    pressKey("X");
    expect(state().edit!.current.clips).toHaveLength(2);

    await rig.store.dispatch("ui.rebindKey", { actionId: "transcript.restore", chord: "N" });
    expect(state().rebindError).not.toBeNull();
    await rig.store.dispatch("ui.resetAllKeys");
    expect(state().settings!.keyBindings).toEqual([]);
    detach();
  });

  it("overrides saved in Settings apply when the app starts", async () => {
    rig = createTestRig({ stepMs: 100 });
    await rig.core.updateSettings({ keyBindings: [{ action: "everywhere.switchView", context: "everywhere", chord: "Ctrl+T" }] });
    await rig.store.init();
    await rig.store.dispatch("ui.openProject", { projectId: rig.core.demo.projectId });
    const detach = attachStoreKeys(rig.store, window);
    pressKey("Ctrl+T");
    expect(state().session.view).toBe("timeline");
    detach();
  });
});

describe("App", () => {
  it("shows Home, then the editor, from the store", async () => {
    vi.useRealTimers();
    await setup();
    render(<App store={rig.store} />);
    expect(screen.getByRole("heading", { name: "Roughcut" })).toBeTruthy();
    await rig.store.dispatch("ui.openProject", { projectId: rig.core.demo.projectId });
    expect(await screen.findByRole("heading", { name: "Weekly update - Nov 13" })).toBeTruthy();
    expect(EVENTS.jobUpdated).toBe("job_updated");
  });
});

describe("helpers", () => {
  it("names the export after the project and the day", () => {
    expect(defaultExportFileName("Weekly update - Nov 13", new Date(2026, 10, 13))).toBe("weekly-update-nov-13-2026-11-13.mp4");
    expect(defaultExportFileName("***", new Date(2026, 0, 2))).toBe("export-2026-01-02.mp4");
  });
});
