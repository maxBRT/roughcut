/**
 * Scripted keyboard sessions (spec 3.7, "state and views"): each use case of spec 1.6 is done
 * from the keyboard alone, through the real key listener, against the stand-in core and a
 * stand-in player. A change made in one view is checked in the other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cutPoints, isKept, rangeKeepState, sequenceDuration, suggestionState } from "../edit";
import type { Clip } from "../types";
import { selectHintScreen, selectKeyScope, selectPendingSuggestions, selectTranscribing } from "./selectors";
import { createRoughcutStore, type RoughcutStore } from "./store";
import { createTestRig, FakePlayer, pressKey, type TestRig } from "./testing";
import { attachStoreKeys } from "./wiring";
import { appError, type StandinOptions } from "./core";

let rig: TestRig;
let detach: () => void;
let copied: string[];

async function setup(coreOptions: StandinOptions = {}): Promise<TestRig> {
  copied = [];
  rig = createTestRig(
    { stepMs: 100, transcriptBatches: 4, ...coreOptions },
    { clipboard: { writeText: async (t) => void copied.push(t) } },
  );
  detach = attachStoreKeys(rig.store, window);
  await rig.store.init();
  return rig;
}

/** Presses keys in order, letting each action finish. */
async function press(...chords: string[]): Promise<void> {
  for (const c of chords) {
    pressKey(c);
    await rig.store.idle();
  }
}

/** Lets the stand-in core's jobs run for `ms`, then lets the store finish what they started. */
async function run(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await rig.store.idle();
}

const state = () => rig.store.getState();
const clips = (): readonly Clip[] => state().edit!.current.clips;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  detach?.();
  rig?.store.dispose();
  rig?.core.dispose();
  vi.useRealTimers();
});

describe("UC1 import footage and UC2 timed transcript", () => {
  it("Ctrl+N opens a playable project at once; text streams in while you already work", async () => {
    await setup();
    expect(state().screen).toBe("home");
    expect(selectKeyScope(state())).toBe("home");

    await press("Ctrl+N");
    expect(state().screen).toBe("editor");
    expect(state().project!.name).toBe("TAKE-2");
    expect(clips()).toHaveLength(1);
    expect(selectKeyScope(state())).toBe("transcript");
    // The player was given the clip list.
    expect(rig.player.input!.clips).toHaveLength(1);

    // Before any text: play, mark a range with I / O, cut it (spec 1.7 B).
    expect(state().layout!.tokens).toHaveLength(0);
    expect(selectHintScreen(state())).toBe("transcribing");
    // The core's first assets event makes the original playable (spec 2.4.2); until then the
    // player has no address, as the real one would.
    await run(100);
    expect(state().sources[state().project!.sources[0]!.id]!.assets!.playback).toBe("original");
    expect(state().notices.filter((n) => n.id === "player")).toEqual([]);
    expect(state().layout!.tokens).toHaveLength(0);
    await press("Space");
    expect(state().playhead.playing).toBe(true);
    rig.player.advance(2000);
    await press("I");
    rig.player.advance(1500);
    await press("O", "Space");
    expect(state().marks.in).not.toBeNull();
    await press("Delete");
    expect(clips()).toHaveLength(2);
    expect(state().marks).toEqual({ in: null, out: null });
    await press("Ctrl+Z");
    expect(clips()).toHaveLength(1);

    // The original is playable after the first step; the transcript streams in.
    await run(150);
    const assets = state().sources[state().project!.sources[0]!.id]!.assets!;
    expect(assets.playback).toBe("original");
    expect(rig.player.urlOf(assets.sourceId)).toBe(assets.playbackUrl);
    await run(100);
    const first = state().layout!.tokens.length;
    expect(first).toBeGreaterThan(0);
    expect(selectTranscribing(state())).not.toBeNull();
    await run(100);
    expect(state().layout!.tokens.length).toBeGreaterThan(first);

    // Complete, then suggestions, then the proxy: the player switches address.
    await run(3000);
    const id = state().project!.sources[0]!.id;
    const entry = state().sources[id]!;
    expect(entry.transcript!.complete).toBe(true);
    expect(selectTranscribing(state())).toBeNull();
    expect(entry.suggestions!.suggestions.length).toBeGreaterThan(0);
    expect(entry.assets!.playback).toBe("proxy");
    const url = rig.player.urlOf(id);
    expect(url).toContain("/proxy");
    expect(rig.core.errors.missingSources).toEqual([]);
  });

  it("files dropped on Home make a project; dropped in the editor they are added", async () => {
    await setup();
    await rig.store.dispatch("ui.dropFiles", { paths: ["D:\\Footage\\A.mp4"] });
    expect(state().project!.name).toBe("A");
    await rig.store.dispatch("ui.dropFiles", { paths: ["D:\\Footage\\B.mp4"] });
    expect(state().project!.sources.map((s) => s.path)).toEqual(["D:\\Footage\\A.mp4", "D:\\Footage\\B.mp4"]);
    expect(clips().map((c) => c.sourceId)).toEqual(state().project!.sources.map((s) => s.id));
  });
});

/** Opens the seeded demo project (complete transcript and suggestions) from Home with Enter. */
async function openDemo(coreOptions: StandinOptions = {}): Promise<void> {
  await setup(coreOptions);
  expect(state().projects[0]!.id).toBe(rig.core.demo.projectId);
  await press("Enter");
  expect(state().screen).toBe("editor");
  expect(state().layout!.tokens.length).toBeGreaterThan(100);
}

describe("UC3 review suggested cuts", () => {
  it("N steps through suggestions, A cuts, D keeps, Shift+A accepts the rest in one undo step", async () => {
    await openDemo();
    const rate = state().project!.frameRate;
    const pending = selectPendingSuggestions(state());
    expect(pending.length).toBeGreaterThanOrEqual(3);

    await press("N");
    const first = state().currentSuggestion!;
    expect(first).toBe(pending[0]!.suggestion.id);
    expect(selectHintScreen(state())).toBe("suggestion");
    const view = state().layout!.suggestions.find((v) => v.suggestion.id === first)!;
    // The suggestion is selected, and the playhead is at its start.
    expect(Math.min(state().selection.anchor, state().selection.focus)).toBe(view.firstPosition);
    expect(state().playhead.position!.at).toBeGreaterThanOrEqual(view.suggestion.range.start - 1);

    await press("A");
    expect(suggestionState(state().edit!.current, view.suggestion.range, rate)).toBe("applied");
    // Cut text stays visible, struck through.
    expect(state().layout!.tokens[view.firstPosition]!.keep).toBe("cut");

    await press("N");
    const second = state().currentSuggestion!;
    expect(second).not.toBe(first);
    await press("D");
    const range = state().layout!.suggestions.find((v) => v.suggestion.id === second)!.suggestion.range;
    expect(suggestionState(state().edit!.current, range, rate)).toBe("dismissed");
    expect(state().edit!.current.dismissed).toHaveLength(1);

    // Shift+N goes back to an earlier pending one (none before the caret: stays put).
    await press("N", "Shift+N");
    const before = selectPendingSuggestions(state()).length;
    expect(before).toBeGreaterThan(0);
    const undoDepth = state().edit!.undo.length;
    await press("Shift+A");
    expect(selectPendingSuggestions(state())).toHaveLength(0);
    expect(state().edit!.undo.length).toBe(undoDepth + 1);
    await press("Ctrl+Z");
    expect(selectPendingSuggestions(state())).toHaveLength(before);
  });

  it("the suggestion block's buttons do what A and D do", async () => {
    await openDemo();
    const [a, b] = selectPendingSuggestions(state());
    await rig.store.dispatch("transcript.dismissSuggestion", { suggestionId: b!.suggestion.id });
    await rig.store.dispatch("transcript.acceptSuggestion", { suggestionId: a!.suggestion.id });
    const rate = state().project!.frameRate;
    expect(suggestionState(state().edit!.current, a!.suggestion.range, rate)).toBe("applied");
    expect(suggestionState(state().edit!.current, b!.suggestion.range, rate)).toBe("dismissed");
  });
});

describe("UC4 cut bad takes by deleting text", () => {
  it("select words, Delete strikes them through; R restores; H hides cut text", async () => {
    await openDemo();
    const n = state().layout!.tokens.length;
    await press("ArrowRight", "ArrowRight", "ArrowRight", "Shift+ArrowRight", "Shift+ArrowRight");
    expect(state().selection).toEqual({ anchor: 3, focus: 5 });
    // Moving the caret moved the playhead to the focus.
    const focusToken = state().layout!.tokens[5]!;
    expect(state().playhead.position!.at).toBe(focusToken.token.start);

    await press("Delete");
    expect(clips()).toHaveLength(2);
    expect(state().layout!.tokens).toHaveLength(n);
    expect(state().layout!.tokens[3]!.keep).toBe("cut");
    expect(state().layout!.tokens[4]!.keep).toBe("cut");
    expect(state().layout!.tokens[5]!.keep).toBe("kept");
    // The caret sits after the cut, and the playhead with it: where the next kept word plays.
    expect(state().selection).toEqual({ anchor: 5, focus: 5 });
    expect(state().playhead.position).toEqual({ sourceId: focusToken.address.sourceId, at: focusToken.token.start });

    // H hides the struck text; the caret keeps its token.
    const caretToken = state().layout!.tokens[5]!.address;
    await press("H");
    expect(state().layout!.tokens).toHaveLength(n - 2);
    expect(state().layout!.tokens[state().selection.focus]!.address).toEqual(caretToken);
    await press("H");
    expect(state().layout!.tokens).toHaveLength(n);

    await press("Shift+ArrowLeft", "Shift+ArrowLeft", "R");
    expect(clips()).toHaveLength(1);
    expect(state().layout!.tokens[3]!.keep).toBe("kept");

    // Delete with nothing selected cuts the word at the caret.
    await press("Ctrl+ArrowDown", "Delete");
    expect(clips()).toHaveLength(2);
    await press("Ctrl+Z", "Ctrl+Z", "Ctrl+Shift+Z");
    expect(clips()).toHaveLength(1);
    expect(state().layout!.tokens[3]!.keep).toBe("kept");
  });

  it("I and O while listening mark a range that Delete cuts, snapped to whole words", async () => {
    await openDemo();
    await press("Ctrl+ArrowDown", "Enter");
    expect(state().playhead.playing).toBe(true);
    rig.player.advance(400);
    await press("I");
    rig.player.advance(1200);
    await press("O", "K");
    expect(state().playhead.playing).toBe(false);
    const markIn = state().marks.in!;
    await press("Delete");
    expect(clips()).toHaveLength(2);
    // Every token cut is cut whole.
    for (const t of state().layout!.tokens) expect(t.keep).not.toBe("partial");
    expect(typeof markIn === "object" && isKept(state().edit!.current, { sourceId: markIn.sourceId, start: markIn.at, end: markIn.at + 1 })).toBe(false);
  });

  it("Ctrl+F finds kept and cut text and Enter in the box steps through matches", async () => {
    await openDemo();
    await press("Ctrl+F");
    expect(state().find.open).toBe(true);
    await rig.store.dispatch("ui.findQuery", { query: "the first thing" });
    const matches = state().find.matches;
    expect(matches.length).toBeGreaterThanOrEqual(3);
    expect(state().find.index).toBe(0);
    expect(Math.min(state().selection.anchor, state().selection.focus)).toBe(matches[0]!.from);
    await press("Delete");
    // The match is cut and hidden; find still reaches it and shows cut text again.
    await press("H");
    expect(state().session.cutTextHidden).toBe(true);
    await rig.store.dispatch("ui.findQuery", { query: "the first thing" });
    // The first match is hidden cut text: cut text is shown again and the match selected.
    expect(state().session.cutTextHidden).toBe(false);
    const sel = state().selection;
    expect(state().layout!.tokens[Math.min(sel.anchor, sel.focus)]!.keep).toBe("cut");
    await rig.store.dispatch("ui.findNext");
    expect(state().find.index).toBe(1);
    await rig.store.dispatch("ui.findPrevious");
    expect(state().find.index).toBe(0);
    await press("Escape");
    expect(state().find.open).toBe(false);
  });
});

describe("UC5 add and reorder recordings, UC6 fine-tune cuts on the timeline", () => {
  it("Ctrl+O appends a recording; on the timeline: jump, nudge, trim, split, remove, move; undo and redo across views", async () => {
    await openDemo({ pickedFiles: ["D:\\Footage\\SCREEN-DEMO.mp4"] });
    await press("Ctrl+O");
    expect(state().project!.sources).toHaveLength(2);
    expect(clips()).toHaveLength(2);
    const [take1, screen] = state().project!.sources;
    expect(clips()[1]!.sourceId).toBe(screen!.id);
    // Adding footage is one undo step.
    expect(state().edit!.undo).toHaveLength(1);

    // Cut a few words in the transcript, so there is a cut inside TAKE-1.
    await press("ArrowRight", "ArrowRight", "Shift+ArrowRight", "Shift+ArrowRight", "Delete");
    expect(clips()).toHaveLength(3);

    await press("Tab");
    expect(state().session.view).toBe("timeline");
    expect(selectKeyScope(state())).toBe("timeline");

    // Down: next cut (the text cut), then the cut between the two recordings.
    await press("Escape");
    // Up goes to the previous cut, and from the first cut to the start.
    for (let i = 0; i < 5 && state().playhead.time > 0; i++) await press("ArrowUp");
    expect(state().playhead.time).toBe(0);
    await press("ArrowDown");
    const cut1 = cutPoints(state().edit!.current)[0]!;
    expect(state().playhead.time).toBe(cut1.at);
    await press("ArrowDown");
    expect(state().playhead.time).toBe(cutPoints(state().edit!.current)[1]!.at);
    await press("ArrowUp");
    expect(state().playhead.time).toBe(cut1.at);

    // , nudges the end of the clip before the cut one frame earlier: the word before strikes partly.
    const endBefore = clips()[0]!.end;
    await press(",");
    expect(clips()[0]!.end).toBeLessThan(endBefore);
    expect(state().playhead.time).toBe(cutPoints(state().edit!.current)[0]!.at);
    await press(".");
    expect(clips()[0]!.end).toBe(endBefore);
    const startAfter = clips()[1]!.start;
    await press("Shift+.");
    expect(clips()[1]!.start).toBeGreaterThan(startAfter);
    await press("Shift+,");
    expect(clips()[1]!.start).toBe(startAfter);

    // Steps: frames and seconds.
    await press("ArrowRight");
    expect(rig.player.callsOf("step").pop()!.amount).toEqual({ frames: 1 });
    await press("Shift+ArrowRight", "Shift+ArrowRight");
    const t = state().playhead.time;
    expect(t).toBeGreaterThan(cut1.at + 1_900_000);

    // S splits at the playhead; the transcript view shows the same boundary.
    const before = clips().length;
    await press("S");
    expect(clips()).toHaveLength(before + 1);
    const [, firstPart, secondPart] = clips();
    // W trims the end of the clip under the playhead to the playhead.
    await press("Shift+ArrowLeft", "W");
    const trimmed = clips()[1]!;
    expect(trimmed.id).toBe(firstPart!.id);
    expect(trimmed.end).toBeLessThan(firstPart!.end);
    // The playhead is on the trimmed clip's last frame; a second on, Q trims the next clip's start to it.
    expect(state().playhead.position!.at).toBeLessThan(trimmed.end);
    await press("Shift+ArrowRight", "Q");
    const third = clips()[2]!;
    expect(third.id).toBe(secondPart!.id);
    expect(third.start).toBeGreaterThan(secondPart!.start);
    const placedEnd = trimmed.end;
    // The words in the trimmed-away stretch are struck in the transcript.
    expect(rangeKeepState(state().edit!.current, { sourceId: take1!.id, start: placedEnd, end: third.start })).toBe("cut");
    await press("Tab");
    const struck = state().layout!.tokens.filter((x) => x.keep !== "kept").length;
    expect(struck).toBeGreaterThan(2);
    await press("Tab");

    // Delete removes the clip under the playhead; the sequence closes up.
    const total = sequenceDuration(state().edit!.current);
    const under = clips()[2]!;
    await press("Delete");
    expect(clips().some((c) => c.id === under.id)).toBe(false);
    expect(sequenceDuration(state().edit!.current)).toBe(total - (under.end - under.start));

    // Alt+Left moves the last clip (the screen recording) earlier.
    // Down past the last cut goes to the end; a second back is inside the last clip.
    for (let i = 0; i < 10 && state().playhead.time < sequenceDuration(state().edit!.current); i++) await press("ArrowDown");
    expect(state().playhead.time).toBe(sequenceDuration(state().edit!.current));
    await press("Shift+ArrowLeft");
    expect(state().playhead.time).toBe(sequenceDuration(state().edit!.current) - 1_000_000);
    const last = clips()[clips().length - 1]!;
    expect(last.sourceId).toBe(screen!.id);
    await press("Alt+ArrowLeft");
    expect(clips()[clips().length - 2]!.id).toBe(last.id);
    // The playhead went with it.
    expect(state().playhead.position!.sourceId).toBe(screen!.id);
    await press("Alt+ArrowRight");
    expect(clips()[clips().length - 1]!.id).toBe(last.id);

    // / previews the nearest cut.
    await press("/");
    expect(rig.player.callsOf("previewCut")).toHaveLength(1);

    // Zoom.
    await press("Shift+=", "Shift+=");
    expect(state().zoom).toBe(4);
    await press("-");
    expect(state().zoom).toBe(2);
    await press("0");
    expect(state().zoom).toBe(1);

    // Undo everything from the transcript view, redo one step back.
    await press("Tab");
    expect(state().session.view).toBe("transcript");
    const steps = state().edit!.undo.length;
    for (let i = 0; i < steps; i++) await press("Ctrl+Z");
    expect(clips()).toHaveLength(1);
    expect(state().layout!.tokens.every((x) => x.keep === "kept" || x.address.sourceId !== take1!.id)).toBe(true);
    await press("Ctrl+Shift+Z");
    expect(clips()).toHaveLength(2);
  });

  it("dragging an edge and a clip are one undo step each", async () => {
    await openDemo({ pickedFiles: ["D:\\Footage\\SCREEN-DEMO.mp4", "D:\\Footage\\OUTRO.mp4"] });
    await press("Ctrl+O");
    expect(clips()).toHaveLength(3);
    const ids = clips().map((c) => c.id);
    await rig.store.dispatch("ui.moveClipTo", { clipId: ids[2]!, index: 0 });
    expect(clips().map((c) => c.id)).toEqual([ids[2], ids[0], ids[1]]);
    await press("Ctrl+Z");
    expect(clips().map((c) => c.id)).toEqual(ids);
    const c0 = clips()[0]!;
    await rig.store.dispatch("ui.trimEdgeTo", { clipId: c0.id, edge: "end", to: c0.end - 2_000_000 });
    expect(clips()[0]!.end).toBeLessThan(c0.end);
    await press("Ctrl+Z");
    expect(clips()[0]!.end).toBe(c0.end);
  });
});

describe("UC7 export an MP4", () => {
  it("Ctrl+E plans, Enter starts, progress arrives, done: Enter shows the file, C copies the path, Esc closes", async () => {
    await openDemo();
    await press("Ctrl+E");
    const d = state().dialogs.export!;
    expect(d.phase).toBe("confirm");
    expect(d.plan!.duration).toBe(sequenceDuration(state().edit!.current));
    expect(d.fileName).toMatch(/^take-2|^weekly-update-nov-13/);
    expect(selectKeyScope(state())).toEqual({ context: "export", phase: "confirm" });
    // Keys of the editor do nothing behind the dialog.
    await press("Tab");
    expect(state().session.view).toBe("transcript");

    await press("Enter");
    expect(state().dialogs.export!.phase).toBe("running");
    await run(250);
    expect(state().dialogs.export!.progress).toBeGreaterThan(0);
    await run(2000);
    const done = state().dialogs.export!;
    expect(done.phase).toBe("done");
    expect(done.result!.path).toContain(done.fileName);
    expect(state().project!.lastExport!.path).toBe(done.result!.path);

    await press("Enter");
    expect(rig.core.revealed).toEqual([done.result!.path]);
    await press("C");
    expect(copied).toEqual([done.result!.path]);
    await press("Escape");
    expect(state().dialogs.export).toBeNull();
  });

  it("Esc cancels a running export; a blocked plan cannot start; C changes the folder", async () => {
    await openDemo();
    await press("Ctrl+E");
    await press("C");
    expect(state().dialogs.export!.folder).toBe("D:\\Exports");
    expect(state().settings!.exportFolder).toBe("D:\\Exports");
    await press("Enter");
    await run(150);
    await press("Escape");
    expect(state().dialogs.export).toBeNull();
    expect(state().notices.some((n) => n.id === "export")).toBe(true);
    await run(3000);
    expect(state().dialogs.export).toBeNull();

    rig.core.setErrors({ diskFull: true });
    await press("Ctrl+E");
    expect(state().dialogs.export!.plan!.blockedBy!.code).toBe("disk_full");
    await press("Enter");
    expect(state().dialogs.export!.phase).toBe("confirm");
    await press("Escape");

    // Everything cut: export is blocked with nothing_to_export.
    rig.core.setErrors({ diskFull: false });
    // On the timeline, Delete removes the one clip under the playhead.
    await press("Tab", "Delete");
    expect(clips()).toHaveLength(0);
    await press("Ctrl+E");
    expect(state().dialogs.export!.plan!.blockedBy!.code).toBe("nothing_to_export");
  });
});

describe("UC8 resume a project later", () => {
  it("reopening restores the edit, the undo history and where you were", async () => {
    await openDemo();
    await press("ArrowRight", "Shift+ArrowRight", "Shift+ArrowRight", "Delete", "Tab", "2");
    expect(state().session.playbackRate).toBe(1.5);
    const edit = state().edit!;
    const playhead = state().playhead.position;
    // Closing the app: the pending save is flushed.
    await rig.store.flushSave();
    detach();
    rig.store.dispose();

    // A new app on the same core.
    const player = new FakePlayer();
    const store: RoughcutStore = createRoughcutStore({ core: rig.core, player });
    rig = { store, core: rig.core, player };
    detach = attachStoreKeys(store, window);
    await store.init();
    expect(state().screen).toBe("home");
    expect(state().homeSelection).toBe(0);
    await press("Enter");
    expect(state().edit).toEqual(edit);
    expect(state().session.view).toBe("timeline");
    expect(state().session.playbackRate).toBe(1.5);
    expect(state().playhead.position).toEqual(playhead);
    expect(player.callsOf("setRate").pop()!.rate).toBe(1.5);
    await press("Ctrl+Z");
    expect(clips()).toHaveLength(1);
  });

  it("Home: Up / Down select, Delete removes from the list", async () => {
    await setup();
    await press("Ctrl+N");
    await rig.store.flushSave();
    // Start the app again on the same core: it opens on Home, with both projects.
    detach();
    rig.store.dispose();
    const player = new FakePlayer();
    const store = createRoughcutStore({ core: rig.core, player });
    rig = { store, core: rig.core, player };
    detach = attachStoreKeys(store, window);
    await store.init();
    expect(state().screen).toBe("home");
    expect(state().projects).toHaveLength(2);
    await press("ArrowDown");
    expect(state().homeSelection).toBe(1);
    await press("ArrowUp");
    expect(state().homeSelection).toBe(0);
    const removed = state().projects[0]!.id;
    await press("Delete");
    expect(state().projects.map((p) => p.id)).not.toContain(removed);
  });
});

describe("everywhere keys", () => {
  it("Space, J K L, 1 2 3 drive the player; ? shows shortcuts; Esc closes and clears", async () => {
    await openDemo();
    await press("Space");
    expect(state().playhead.playing).toBe(true);
    rig.player.advance(3000);
    // The caret follows playback.
    expect(state().selection.focus).toBeGreaterThan(0);
    await press("Space", "L", "L");
    expect(rig.player.callsOf("shuttle").map((c) => c.key)).toEqual(["L", "L"]);
    await press("J", "K");
    expect(state().playhead.playing).toBe(false);
    await press("3");
    expect(rig.player.rate).toBe(2);
    expect(state().session.playbackRate).toBe(2);
    await press("1");
    expect(state().session.playbackRate).toBe(1);

    await press("Shift+/");
    expect(state().dialogs.shortcuts).toBe(true);
    await press("Escape");
    expect(state().dialogs.shortcuts).toBe(false);

    await press("Shift+ArrowRight", "I");
    await press("Escape");
    expect(state().selection.anchor).toBe(state().selection.focus);
    expect(state().marks.in).toBeNull();
  });

  it("Tab to the Timeline and back keeps the playhead and the selection", async () => {
    await openDemo();
    await press("ArrowRight", "ArrowRight", "ArrowRight", "Shift+ArrowRight", "Shift+ArrowRight", "Shift+ArrowRight");
    const selection = { ...state().selection };
    const playhead = state().playhead.time;
    expect(selection.anchor).not.toBe(selection.focus);
    await press("Tab");
    expect(state().session.view).toBe("timeline");
    expect(state().selection).toEqual(selection);
    expect(state().playhead.time).toBe(playhead);
    await press("Tab");
    expect(state().session.view).toBe("transcript");
    expect(state().selection).toEqual(selection);
    expect(state().playhead.time).toBe(playhead);
    // Moving the playhead in the Timeline view makes the caret follow it (the selection goes).
    await press("Tab", "ArrowRight", "Tab");
    expect(state().selection.anchor).toBe(state().selection.focus);
  });
});

describe("dialogs from the keyboard", () => {
  it("the Locate file prompt: view keys do nothing behind it, Enter locates the file, Esc closes it", async () => {
    await openDemo({ pickedFiles: ["D:\\Moved\\TAKE-1.mp4"] });
    rig.core.setErrors({ missingSources: [rig.core.demo.sourceId] });
    expect(state().dialogs.locate!.sourceId).toBe(rig.core.demo.sourceId);
    expect(selectKeyScope(state())).toBe("everywhere");
    const before = state().edit;
    await press("ArrowRight", "Delete");
    expect(state().edit).toBe(before);
    // Enter is "Locate…", not "play from the caret".
    await press("Enter");
    expect(rig.player.callsOf("play")).toHaveLength(0);
    expect(state().dialogs.locate).toBeNull();
    expect(state().project!.sources[0]!.path).toBe("D:\\Moved\\TAKE-1.mp4");
    expect(state().sources[rig.core.demo.sourceId]!.assets!.online).toBe(true);
    expect(selectKeyScope(state())).toBe("transcript");

    rig.core.setErrors({ missingSources: [rig.core.demo.sourceId] });
    expect(state().dialogs.locate).not.toBeNull();
    await press("Escape");
    expect(state().dialogs.locate).toBeNull();
  });

  it("the shortcut overlay is modal for view keys: Delete does not cut behind it", async () => {
    await openDemo();
    await press("Shift+/");
    expect(state().dialogs.shortcuts).toBe(true);
    const before = state().edit;
    await press("Shift+ArrowRight", "Delete", "S");
    expect(state().edit).toBe(before);
    await press("Shift+/");
    expect(state().dialogs.shortcuts).toBe(false);
    await press("Delete");
    expect(state().edit).not.toBe(before);
  });
});

describe("races with slow core answers", () => {
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }

  /** Presses keys while an action is held back: lets promises settle but does not wait for it. */
  async function tap(...chords: string[]): Promise<void> {
    for (const c of chords) {
      pressKey(c);
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
  }

  it("Ctrl+E, Enter, Esc before start_export answers: the job is cancelled and nothing is written", async () => {
    await openDemo();
    const gate = deferred();
    const original = rig.core.startExport.bind(rig.core);
    rig.core.startExport = (request) => gate.promise.then(() => original(request));
    const cancel = vi.spyOn(rig.core, "cancelJob");
    const finished: string[] = [];
    rig.core.onExportFinished((r) => finished.push(r.path));
    await press("Ctrl+E");
    pressKey("Enter");
    expect(state().dialogs.export!.phase).toBe("running");
    await tap("Escape");
    expect(state().dialogs.export).toBeNull();
    expect(state().notices.find((n) => n.id === "export")!.text).toMatch(/cancelled/i);
    gate.resolve();
    await run(5000);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(finished).toEqual([]);
    expect(state().project!.lastExport).toBeFalsy();
    // A later export works normally.
    rig.core.startExport = original;
    await press("Ctrl+E", "Enter");
    await run(5000);
    expect(state().dialogs.export!.phase).toBe("done");
  });

  it("an export that finishes before start_export answers still shows the done stage", async () => {
    await openDemo();
    const gate = deferred();
    const original = rig.core.startExport.bind(rig.core);
    rig.core.startExport = (request) => original(request).then((id) => gate.promise.then(() => id));
    await press("Ctrl+E");
    pressKey("Enter");
    // Let the job run to the end while the answer is held back.
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    }
    gate.resolve();
    await run(100);
    expect(state().dialogs.export!.phase).toBe("done");
    expect(state().dialogs.export!.result!.path).toMatch(/\.mp4$/);
  });

  it("an edit made with the keys during an import is saved to the old project", async () => {
    await openDemo({ pickedFiles: ["D:\\Footage\\NEW.mp4"] });
    const gate = deferred();
    const original = rig.core.createProject.bind(rig.core);
    rig.core.createProject = (paths) => gate.promise.then(() => original(paths));
    pressKey("Ctrl+N");
    for (let i = 0; i < 50 && state().busy === null; i++) await Promise.resolve();
    expect(state().busy).toBe("Importing footage");
    await tap("Tab", "Shift+ArrowRight", "Shift+ArrowRight", "S");
    expect(clips()).toHaveLength(2);
    gate.resolve();
    await run(5000);
    expect(state().project!.name).toBe("NEW");
    const demo = await rig.core.openProject(rig.core.demo.projectId);
    expect(demo.project.edit.current.clips).toHaveLength(2);
  });

  it("when that save fails the old project stays open with the edit, and Retry saves it", async () => {
    await openDemo({ pickedFiles: ["D:\\Footage\\NEW.mp4"] });
    const gate = deferred();
    const original = rig.core.createProject.bind(rig.core);
    rig.core.createProject = (paths) => gate.promise.then(() => original(paths));
    pressKey("Ctrl+N");
    for (let i = 0; i < 50 && state().busy === null; i++) await Promise.resolve();
    await tap("Tab", "Shift+ArrowRight", "S");
    expect(clips()).toHaveLength(2);
    rig.core.failNext("save_edit", appError("internal", "disk unplugged"));
    gate.resolve();
    await run(100);
    expect(state().project!.id).toBe(rig.core.demo.projectId);
    expect(clips()).toHaveLength(2);
    expect(state().busy).toBeNull();
    const notice = state().notices.find((n) => n.id === "save")!;
    expect(notice.text).toMatch(/stays open/);
    await rig.store.dispatch(notice.retry!.action);
    const demo = await rig.core.openProject(rig.core.demo.projectId);
    expect(demo.project.edit.current.clips).toHaveLength(2);
  });
});
