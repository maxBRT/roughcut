import { describe, expect, it } from "vitest";
import type { Clip, EditDocument, EditState } from "../types";
import {
  appendSource,
  applyEditCommand,
  canRedo,
  canUndo,
  clipAt,
  contextFromProject,
  createEditDocument,
  cutPlacement,
  cutPoints,
  cutRanges,
  dismissSuggestion,
  findClip,
  isKept,
  keptRanges,
  moveClip,
  nearestCutPoint,
  nudgeEdge,
  rangeKeepState,
  redo,
  removeClip,
  restoreRanges,
  sequenceDuration,
  sequenceTimeOf,
  sourcePositionAt,
  splitAt,
  suggestionState,
  trimEdge,
  undo,
  validateEditState,
} from "./index";
import type { EditContext } from "./index";

// 25 fps: frame k is exactly k * 40 000 microseconds.
const RATE = { num: 25, den: 1 };
const F = (k: number) => k * 40_000;
const ctx: EditContext = {
  frameRate: RATE,
  sources: [
    { id: "a", duration: F(250) + 123 }, // 10 s and a bit: the grid end is F(250)
    { id: "b", duration: F(125) },
    { id: "c", duration: F(75) },
  ],
};

function clip(id: string, sourceId: string, s: number, e: number): Clip {
  return { id, sourceId, start: F(s), end: F(e) };
}
function spans(state: EditState): [string, number, number][] {
  return state.clips.map((c) => [c.sourceId, c.start / 40_000, c.end / 40_000]);
}
function oneSource(): EditDocument {
  return createEditDocument([clip("clip-1", "a", 0, 250)]);
}
function sound(doc: EditDocument) {
  expect(validateEditState(doc.current, ctx)).toEqual([]);
}

describe("appendSource", () => {
  it("adds one clip covering the whole source, its duration floored to the grid", () => {
    const d = appendSource(createEditDocument(), ctx, "a", F(250) + 123);
    expect(d.current.clips).toEqual([{ id: "clip-1", sourceId: "a", start: 0, end: F(250) }]);
    expect(d.undo).toHaveLength(1);
    sound(d);
  });
  it("adds it at the end of the sequence", () => {
    const d = appendSource(oneSource(), ctx, "b", F(125));
    expect(spans(d.current)).toEqual([["a", 0, 250], ["b", 0, 125]]);
  });
  it("adds nothing for a source shorter than one frame", () => {
    const d0 = createEditDocument();
    expect(appendSource(d0, ctx, "x", 39_999)).toBe(d0);
  });
  it("adds only the parts of the source not already in the sequence", () => {
    const d = cutRanges(oneSource(), ctx, [{ sourceId: "a", start: F(100), end: F(200) }]);
    const e = appendSource(d, ctx, "a", F(250));
    expect(spans(e.current)).toEqual([["a", 0, 100], ["a", 200, 250], ["a", 100, 200]]);
    sound(e);
    expect(appendSource(e, ctx, "a", F(250))).toBe(e);
  });
});

describe("cutRanges", () => {
  it("splits a clip around a cut in the middle; the first piece keeps the id", () => {
    const d = cutRanges(oneSource(), ctx, [{ sourceId: "a", start: F(10), end: F(20) }]);
    expect(d.current.clips).toEqual([clip("clip-1", "a", 0, 10), clip("clip-2", "a", 20, 250)]);
    sound(d);
  });
  it("shortens a clip at either end and removes a clip that is cut whole", () => {
    let d = createEditDocument([clip("clip-1", "a", 0, 250), clip("clip-2", "b", 0, 125)]);
    d = cutRanges(d, ctx, [
      { sourceId: "a", start: 0, end: F(5) },
      { sourceId: "a", start: F(240), end: F(300) },
      { sourceId: "b", start: -5, end: F(999) },
    ]);
    expect(spans(d.current)).toEqual([["a", 5, 240]]);
    expect(d.undo).toHaveLength(1);
    sound(d);
  });
  it("snaps arbitrary microseconds to the nearest frame boundary, ties to the later one", () => {
    const d = cutRanges(oneSource(), ctx, [{ sourceId: "a", start: F(10) + 19_999, end: F(20) + 20_000 }]);
    expect(spans(d.current)).toEqual([["a", 0, 10], ["a", 21, 250]]);
  });
  it("handles overlapping and unsorted ranges across several clips", () => {
    let d = createEditDocument([clip("clip-1", "a", 0, 100), clip("clip-2", "b", 0, 125), clip("clip-3", "a", 100, 250)]);
    d = cutRanges(d, ctx, [
      { sourceId: "a", start: F(150), end: F(160) },
      { sourceId: "a", start: F(90), end: F(110) },
      { sourceId: "a", start: F(95), end: F(105) },
    ]);
    expect(spans(d.current)).toEqual([["a", 0, 90], ["b", 0, 125], ["a", 110, 150], ["a", 160, 250]]);
    sound(d);
  });
  it("changes nothing (and adds no undo step) when the range is already cut or snaps to nothing", () => {
    const d = cutRanges(oneSource(), ctx, [{ sourceId: "a", start: F(10), end: F(20) }]);
    expect(cutRanges(d, ctx, [{ sourceId: "a", start: F(12), end: F(18) }])).toBe(d);
    expect(cutRanges(d, ctx, [{ sourceId: "a", start: F(30) + 5, end: F(30) + 10 }])).toBe(d);
    expect(cutRanges(d, ctx, [{ sourceId: "zzz", start: 0, end: F(10) }])).toBe(d);
    expect(cutRanges(d, ctx, [])).toBe(d);
  });
  it("accepting every suggestion is one cut and one undo", () => {
    const d0 = oneSource();
    const d = cutRanges(d0, ctx, [
      { sourceId: "a", start: F(10), end: F(20) },
      { sourceId: "a", start: F(40), end: F(50) },
    ]);
    expect(d.current.clips).toHaveLength(3);
    expect(undo(d).current).toEqual(d0.current);
  });
});

describe("restoreRanges", () => {
  it("cutting then restoring the same range gives back exactly the same clips", () => {
    const d0 = oneSource();
    const r = { sourceId: "a", start: F(10) + 7, end: F(20) - 3 };
    const d = restoreRanges(cutRanges(d0, ctx, [r]), ctx, [r]);
    expect(d.current).toEqual(d0.current);
  });
  it("joins the clip it touches in source time", () => {
    const d = cutRanges(oneSource(), ctx, [{ sourceId: "a", start: F(10), end: F(30) }]);
    const e = restoreRanges(d, ctx, [{ sourceId: "a", start: F(10), end: F(15) }]);
    expect(spans(e.current)).toEqual([["a", 0, 15], ["a", 30, 250]]);
    const f = restoreRanges(d, ctx, [{ sourceId: "a", start: F(25), end: F(30) }]);
    expect(spans(f.current)).toEqual([["a", 0, 10], ["a", 25, 250]]);
  });
  it("does not merge clips that are not neighbours in the sequence; the earlier one grows", () => {
    let d = createEditDocument([clip("clip-1", "a", 0, 100), clip("clip-2", "b", 0, 125), clip("clip-3", "a", 110, 250)]);
    d = restoreRanges(d, ctx, [{ sourceId: "a", start: F(100), end: F(110) }]);
    expect(spans(d.current)).toEqual([["a", 0, 110], ["b", 0, 125], ["a", 110, 250]]);
    sound(d);
  });
  it("does not merge neighbours that are in the wrong order in the sequence", () => {
    let d = createEditDocument([clip("clip-1", "a", 110, 250), clip("clip-2", "a", 0, 100)]);
    d = restoreRanges(d, ctx, [{ sourceId: "a", start: F(100), end: F(110) }]);
    expect(spans(d.current)).toEqual([["a", 110, 250], ["a", 0, 110]]);
  });
  it("splitAt does not merge back, and restoring kept material changes nothing", () => {
    const d = splitAt(oneSource(), ctx, F(100));
    expect(spans(d.current)).toEqual([["a", 0, 100], ["a", 100, 250]]);
    expect(restoreRanges(d, ctx, [{ sourceId: "a", start: F(90), end: F(110) }])).toBe(d);
  });
  it("places material that touches nothing after the nearest earlier clip of the source", () => {
    let d = createEditDocument([clip("clip-1", "a", 0, 10), clip("clip-2", "b", 0, 125), clip("clip-3", "a", 100, 110)]);
    d = restoreRanges(d, ctx, [{ sourceId: "a", start: F(50), end: F(60) }]);
    expect(d.current.clips.map((c) => c.id)).toEqual(["clip-1", "clip-4", "clip-2", "clip-3"]);
    expect(d.current.clips[1]).toEqual(clip("clip-4", "a", 50, 60));
  });
  it("with no earlier clip of the source, places it before that source's first clip", () => {
    let d = createEditDocument([clip("clip-1", "b", 0, 125), clip("clip-2", "a", 100, 110)]);
    d = restoreRanges(d, ctx, [{ sourceId: "a", start: F(5), end: F(10) }]);
    expect(spans(d.current)).toEqual([["b", 0, 125], ["a", 5, 10], ["a", 100, 110]]);
  });
  it("with no clip of the source at all, places it where that source's clip would be, by project order", () => {
    let d = createEditDocument([clip("clip-1", "a", 0, 250), clip("clip-2", "c", 0, 75)]);
    d = restoreRanges(d, ctx, [{ sourceId: "b", start: F(5), end: F(10) }]);
    expect(spans(d.current)).toEqual([["a", 0, 250], ["b", 5, 10], ["c", 0, 75]]);
  });
  it("is limited to the source's start and end", () => {
    let d = cutRanges(oneSource(), ctx, [{ sourceId: "a", start: 0, end: F(250) }]);
    expect(d.current.clips).toEqual([]);
    d = restoreRanges(d, ctx, [{ sourceId: "a", start: -F(10), end: F(9999) }]);
    expect(spans(d.current)).toEqual([["a", 0, 250]]);
    sound(d);
  });
});

describe("trimEdge and nudgeEdge", () => {
  const base = () => cutRanges(oneSource(), ctx, [{ sourceId: "a", start: F(100), end: F(120) }]);
  // clips: clip-1 [0,100), clip-2 [120,250)
  it("moves an edge outwards, bringing back cut material, and stops at the next kept material", () => {
    // Pulled out as far as it goes, the edge closes the gap to its neighbour of the same
    // source, so the two merge (spec 1.8, 3.5.1) and the earlier clip keeps its id.
    const d = trimEdge(base(), ctx, "clip-1", "end", F(200));
    expect(d.current.clips).toEqual([clip("clip-1", "a", 0, 250)]);
    const e = trimEdge(base(), ctx, "clip-2", "start", F(3));
    expect(e.current.clips).toEqual([clip("clip-1", "a", 0, 250)]);
    const partial = trimEdge(base(), ctx, "clip-1", "end", F(110));
    expect(spans(partial.current)).toEqual([["a", 0, 110], ["a", 120, 250]]);
    sound(d);
    sound(e);
  });
  it("stops at the source's start and end", () => {
    let d = createEditDocument([clip("clip-1", "a", 50, 60)]);
    d = trimEdge(d, ctx, "clip-1", "start", -F(100));
    d = trimEdge(d, ctx, "clip-1", "end", F(10_000));
    expect(spans(d.current)).toEqual([["a", 0, 250]]);
  });
  it("moves an edge inwards but never empties the clip", () => {
    let d = createEditDocument([clip("clip-1", "a", 50, 60)]);
    d = trimEdge(d, ctx, "clip-1", "start", F(80));
    expect(spans(d.current)).toEqual([["a", 59, 60]]);
    const e = trimEdge(createEditDocument([clip("clip-1", "a", 50, 60)]), ctx, "clip-1", "end", 0);
    expect(spans(e.current)).toEqual([["a", 50, 51]]);
  });
  it("snaps the new position to the nearest frame boundary", () => {
    const d = trimEdge(createEditDocument([clip("clip-1", "a", 50, 60)]), ctx, "clip-1", "end", F(70) + 20_001);
    expect(spans(d.current)).toEqual([["a", 50, 71]]);
  });
  it("nudges by whole frames with the same limits", () => {
    // clip-2 plays first, so the two are not continuous neighbours and never merge.
    let d = createEditDocument([clip("clip-2", "a", 62, 70), clip("clip-1", "a", 50, 60)]);
    d = nudgeEdge(d, ctx, "clip-1", "end", 1);
    expect(spans(d.current)).toEqual([["a", 62, 70], ["a", 50, 61]]);
    d = nudgeEdge(d, ctx, "clip-1", "end", 5);
    expect(spans(d.current)).toEqual([["a", 62, 70], ["a", 50, 62]]);
    d = nudgeEdge(d, ctx, "clip-1", "start", -1000);
    expect(spans(d.current)).toEqual([["a", 62, 70], ["a", 0, 62]]);
    d = nudgeEdge(d, ctx, "clip-2", "start", 3);
    expect(spans(d.current)).toEqual([["a", 65, 70], ["a", 0, 62]]);
    // In playing order, a nudge that closes the gap merges them.
    const m = nudgeEdge(createEditDocument([clip("clip-1", "a", 50, 60), clip("clip-2", "a", 62, 70)]), ctx, "clip-1", "end", 5);
    expect(m.current.clips).toEqual([clip("clip-1", "a", 50, 70)]);
  });
  it("changes nothing when the edge cannot move or the clip does not exist", () => {
    const d = createEditDocument([clip("clip-1", "a", 0, 250)]);
    expect(nudgeEdge(d, ctx, "clip-1", "end", 1)).toBe(d);
    expect(nudgeEdge(d, ctx, "clip-1", "start", -1)).toBe(d);
    expect(nudgeEdge(d, ctx, "nope", "start", 1)).toBe(d);
    expect(nudgeEdge(d, ctx, "clip-1", "start", 0)).toBe(d);
  });
});

describe("splitAt, removeClip, moveClip", () => {
  it("splits the clip under a sequence time at the nearest frame boundary", () => {
    let d = createEditDocument([clip("clip-1", "a", 0, 100), clip("clip-2", "b", 10, 110)]);
    d = splitAt(d, ctx, F(150) + 15_000);
    expect(d.current.clips).toEqual([clip("clip-1", "a", 0, 100), clip("clip-2", "b", 10, 60), clip("clip-3", "b", 60, 110)]);
  });
  it("does nothing on an existing boundary or outside the sequence", () => {
    const d = createEditDocument([clip("clip-1", "a", 0, 100), clip("clip-2", "b", 10, 110)]);
    expect(splitAt(d, ctx, F(100))).toBe(d);
    expect(splitAt(d, ctx, F(100) + 1)).toBe(d);
    expect(splitAt(d, ctx, F(500))).toBe(d);
    expect(splitAt(d, ctx, -1)).toBe(d);
  });
  it("removes a clip and closes up", () => {
    const d = removeClip(createEditDocument([clip("clip-1", "a", 0, 100), clip("clip-2", "b", 10, 110)]), ctx, "clip-1");
    expect(spans(d.current)).toEqual([["b", 10, 110]]);
    expect(sequenceDuration(d.current)).toBe(F(100));
  });
  it("moves a clip by swapping with its neighbour; nothing happens at the ends", () => {
    const d = createEditDocument([clip("clip-1", "a", 0, 100), clip("clip-2", "b", 10, 110), clip("clip-3", "c", 0, 10)]);
    const e = moveClip(d, ctx, "clip-2", "later");
    expect(e.current.clips.map((c) => c.id)).toEqual(["clip-1", "clip-3", "clip-2"]);
    expect(moveClip(d, ctx, "clip-2", "earlier").current.clips.map((c) => c.id)).toEqual(["clip-2", "clip-1", "clip-3"]);
    expect(moveClip(d, ctx, "clip-1", "earlier")).toBe(d);
    expect(moveClip(d, ctx, "clip-3", "later")).toBe(d);
  });
});

describe("suggestions", () => {
  const range = { sourceId: "a", start: F(10) + 300, end: F(20) - 300 };
  it("are pending, applied when cut, dismissed when dismissed", () => {
    const d = oneSource();
    expect(suggestionState(d.current, range, RATE)).toBe("pending");
    expect(suggestionState(cutRanges(d, ctx, [range]).current, range, RATE)).toBe("applied");
    const dd = dismissSuggestion(d, ctx, range);
    expect(dd.current.dismissed).toEqual([range]);
    expect(suggestionState(dd.current, range, RATE)).toBe("dismissed");
    expect(dismissSuggestion(dd, ctx, range)).toBe(dd);
    expect(undo(dd).current.dismissed).toEqual([]);
  });
  it("partly cut is still pending", () => {
    const d = cutRanges(oneSource(), ctx, [{ sourceId: "a", start: F(10), end: F(15) }]);
    expect(suggestionState(d.current, range, RATE)).toBe("pending");
  });
});

describe("undo and redo", () => {
  it("move between states exactly, and a new command clears redo", () => {
    const d0 = oneSource();
    const d1 = cutRanges(d0, ctx, [{ sourceId: "a", start: F(10), end: F(20) }]);
    const d2 = splitAt(d1, ctx, F(100));
    expect(canUndo(d0)).toBe(false);
    expect(canUndo(d2)).toBe(true);
    const u1 = undo(d2);
    expect(u1.current).toEqual(d1.current);
    expect(canRedo(u1)).toBe(true);
    const u0 = undo(u1);
    expect(u0.current).toEqual(d0.current);
    expect(undo(u0)).toBe(u0);
    expect(redo(redo(u0)).current).toEqual(d2.current);
    const branched = removeClip(u1, ctx, "clip-1");
    expect(canRedo(branched)).toBe(false);
    expect(redo(branched)).toBe(branched);
  });
  it("applyEditCommand dispatches every command", () => {
    let d = createEditDocument();
    d = applyEditCommand(d, ctx, { type: "appendSource", sourceId: "a", duration: F(250) });
    d = applyEditCommand(d, ctx, { type: "cutRanges", ranges: [{ sourceId: "a", start: F(10), end: F(20) }] });
    d = applyEditCommand(d, ctx, { type: "restoreRanges", ranges: [{ sourceId: "a", start: F(10), end: F(12) }] });
    d = applyEditCommand(d, ctx, { type: "trimEdge", clipId: "clip-2", edge: "start", to: F(18) });
    d = applyEditCommand(d, ctx, { type: "nudgeEdge", clipId: "clip-2", edge: "start", frames: 1 });
    d = applyEditCommand(d, ctx, { type: "splitAt", at: F(50) });
    d = applyEditCommand(d, ctx, { type: "moveClip", clipId: "clip-1", direction: "later" });
    d = applyEditCommand(d, ctx, { type: "removeClip", clipId: "clip-3" });
    d = applyEditCommand(d, ctx, { type: "dismissSuggestion", range: { sourceId: "a", start: 1, end: 2 } });
    expect(spans(d.current)).toEqual([["a", 19, 57], ["a", 0, 12]]);
    expect(d.undo).toHaveLength(9);
    d = applyEditCommand(d, ctx, { type: "undo" });
    expect(d.current.dismissed).toEqual([]);
    d = applyEditCommand(d, ctx, { type: "redo" });
    expect(d.current.dismissed).toHaveLength(1);
  });
});

describe("queries", () => {
  // a[0,100) b[10,60) a[120,250)
  const state: EditState = {
    clips: [clip("c1", "a", 0, 100), clip("c2", "b", 10, 60), clip("c3", "a", 120, 250)],
    dismissed: [],
  };
  it("sequence duration and the clip at a sequence time", () => {
    expect(sequenceDuration(state)).toBe(F(280));
    expect(clipAt(state, 0)?.clip.id).toBe("c1");
    expect(clipAt(state, F(100) - 1)?.clip.id).toBe("c1");
    expect(clipAt(state, F(100))).toEqual({ clip: state.clips[1], index: 1, sequenceStart: F(100) });
    expect(clipAt(state, F(280))).toBeNull();
    expect(findClip(state, "c3")?.sequenceStart).toBe(F(150));
    expect(findClip(state, "x")).toBeNull();
  });
  it("maps sequence time to source position and back; a cut moment has no sequence time", () => {
    expect(sourcePositionAt(state, F(120))).toEqual({ sourceId: "b", at: F(30) });
    expect(sourcePositionAt(state, F(150))).toEqual({ sourceId: "a", at: F(120) });
    expect(sourcePositionAt(state, F(280))).toEqual({ sourceId: "a", at: F(250) });
    expect(sourcePositionAt(state, F(281))).toBeNull();
    expect(sequenceTimeOf(state, { sourceId: "a", at: F(130) })).toBe(F(160));
    expect(sequenceTimeOf(state, { sourceId: "a", at: F(110) })).toBeNull();
    expect(sequenceTimeOf(state, { sourceId: "b", at: F(5) })).toBeNull();
    expect(sequenceTimeOf(state, { sourceId: "a", at: F(250) })).toBe(F(280));
    for (const t of [0, 1, F(99), F(100), F(149) + 7, F(279)]) {
      expect(sequenceTimeOf(state, sourcePositionAt(state, t)!)).toBe(t);
    }
  });
  it("lists cut points and finds the nearest", () => {
    expect(cutPoints(state).map((p) => [p.at, p.before.id, p.after.id])).toEqual([
      [F(100), "c1", "c2"],
      [F(150), "c2", "c3"],
    ]);
    expect(nearestCutPoint(state, F(140))?.at).toBe(F(150));
    expect(nearestCutPoint({ clips: [state.clips[0]!], dismissed: [] }, 0)).toBeNull();
  });
  it("says whether a source range is kept, partly kept or cut", () => {
    expect(rangeKeepState(state, { sourceId: "a", start: F(10), end: F(20) })).toBe("kept");
    expect(rangeKeepState(state, { sourceId: "a", start: F(90), end: F(130) })).toBe("partial");
    expect(rangeKeepState(state, { sourceId: "a", start: F(100), end: F(120) })).toBe("cut");
    expect(rangeKeepState(state, { sourceId: "c", start: 0, end: F(5) })).toBe("cut");
    expect(isKept(state, { sourceId: "b", start: F(10), end: F(60) })).toBe(true);
    expect(keptRanges(state, { sourceId: "a", start: F(50), end: F(200) })).toEqual([
      { sourceId: "a", start: F(50), end: F(100) },
      { sourceId: "a", start: F(120), end: F(200) },
    ]);
  });
  it("places cut text next to the kept clip that borders it in source time", () => {
    const R = (sourceId: string, s: number, e: number) => ({ sourceId, start: F(s), end: F(e) });
    expect(cutPlacement(state, ctx, R("a", 110, 111))).toEqual({ kind: "after", clipId: "c1", index: 0 });
    expect(cutPlacement(state, ctx, R("a", 100, 101))).toEqual({ kind: "after", clipId: "c1", index: 0 });
    // Touching the later clip of its source only: shown before it, where a restore puts it.
    expect(cutPlacement(state, ctx, R("a", 119, 120))).toEqual({ kind: "before", clipId: "c3", index: 2 });
    // Touching both, not neighbours: a restore joins the earlier one.
    expect(cutPlacement(state, ctx, R("a", 100, 120))).toEqual({ kind: "after", clipId: "c1", index: 0 });
    expect(cutPlacement(state, ctx, R("b", 5, 6))).toEqual({ kind: "before", clipId: "c2", index: 1 });
    expect(cutPlacement(state, ctx, R("b", 70, 71))).toEqual({ kind: "after", clipId: "c2", index: 1 });
    expect(cutPlacement(state, ctx, R("c", 5, 6))).toEqual({ kind: "index", index: 3 });
    // Partly kept: the first cut part decides (a[90,110) is cut only from 100).
    expect(cutPlacement(state, ctx, R("a", 90, 110))).toEqual({ kind: "after", clipId: "c1", index: 0 });
    // The same place restoring would put it.
    const d = restoreRanges(createEditDocument(state.clips), ctx, [{ sourceId: "a", start: F(105), end: F(110) }]);
    expect(d.current.clips.map((c) => c.id)).toEqual(["c1", "clip-1", "c2", "c3"]);
  });
});

describe("validateEditState", () => {
  it("reports every broken rule", () => {
    const bad: EditState = {
      clips: [
        { id: "x", sourceId: "a", start: F(10), end: F(10) },
        { id: "y", sourceId: "a", start: F(5) + 1, end: F(20) },
        { id: "y", sourceId: "a", start: F(15), end: F(300) },
        { id: "z", sourceId: "q", start: 0, end: F(1) },
      ],
      dismissed: [{ sourceId: "a", start: 5, end: 5 }],
    };
    const rules = [...new Set(validateEditState(bad, ctx).map((v) => v.rule))].sort();
    expect(rules).toEqual(["bad_dismissed", "duplicate_id", "empty", "off_grid", "out_of_source", "overlap", "unknown_source"]);
  });
  it("accepts the document create_project makes", () => {
    const c = contextFromProject({
      frameRate: { num: 30000, den: 1001 },
      sources: [{ id: "s", path: "p", addedAt: "", media: { duration: 10_000_000 } as never }],
    });
    const d = appendSource(createEditDocument(), c, "s", 10_000_000);
    expect(validateEditState(d.current, c)).toEqual([]);
    expect(d.current.clips[0]!.end).toBe(9_976_633);
  });
});
