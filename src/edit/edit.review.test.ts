/**
 * Review tests (track edit-review): each one pins a defect or a limit found in review.
 */
import { describe, expect, it } from "vitest";
import type { Clip } from "../types";
import { createEditDocument, cutPlacement, cutRanges, restoreRanges } from "./index";
import type { EditContext } from "./index";

const S = 1_000_000;
const ctx: EditContext = {
  frameRate: { num: 25, den: 1 },
  sources: [
    { id: "a", duration: 60 * S },
    { id: "b", duration: 60 * S },
  ],
};
const clip = (id: string, sourceId: string, start: number, end: number): Clip => ({ id, sourceId, start, end });
const shape = (clips: readonly Clip[]) => clips.map((c) => [c.sourceId, c.start, c.end]);

describe("review: cut text placement agrees with where restore puts it", () => {
  it("a cut word that touches a later, non-neighbouring clip of its source", () => {
    // a[0,10s) | b[0,10s) | a[20s,30s): a[10s,20s) is cut.
    const doc = createEditDocument([clip("clip-1", "a", 0, 10 * S), clip("clip-2", "b", 0, 10 * S), clip("clip-3", "a", 20 * S, 30 * S)]);
    const word = { sourceId: "a", start: 19 * S, end: 20 * S };
    // The cut word a[19s,20s) is shown at:
    const shown = cutPlacement(doc.current, ctx, word);
    // Restoring that word joins clip-3 (it touches it in source time), at sequence index 2.
    const restored = restoreRanges(doc, ctx, [word]).current.clips;
    expect(restored.find((c) => c.id === "clip-3")!.start).toBe(19 * S);
    // Spec 3.5.1: cut text sits where it would return to if restored, i.e. before clip-3.
    expect(shown).toEqual({ kind: "before", clipId: "clip-3", index: 2 });
  });
});

/*
 * Spec 3.7 says "cutting then restoring the same range changes nothing", but the 3.5.1
 * placement rule and the data (EditState keeps no memory of where cut material played) make
 * that impossible in general. These two cases pin the behaviour the rule gives: the same
 * moments come back, the playing order can differ. The conflict is reported to the spec owner.
 */
describe("review: cutting then restoring when the source plays out of order", () => {
  it("a whole clip that touched nothing comes back after the nearest earlier clip of its source (3.5.1 literal rule)", () => {
    // a[0,10s) | b[0,10s) | a[20s,30s)
    const doc = createEditDocument([clip("clip-1", "a", 0, 10 * S), clip("clip-2", "b", 0, 10 * S), clip("clip-3", "a", 20 * S, 30 * S)]);
    const range = { sourceId: "a", start: 20 * S, end: 30 * S };
    const cut = cutRanges(doc, ctx, [range]);
    // Where the transcript shows it while cut is where it returns.
    expect(cutPlacement(cut.current, ctx, range)).toEqual({ kind: "after", clipId: "clip-1", index: 0 });
    const back = restoreRanges(cut, ctx, [range]).current.clips;
    expect(shape(back)).toEqual([
      ["a", 0, 10 * S],
      ["a", 20 * S, 30 * S],
      ["b", 0, 10 * S],
    ]);
  });
  it("material touching two non-neighbouring clips of its source joins the earlier one whole (the old boundary is unknown)", () => {
    // a[0,10s) | b[0,10s) | a[10s,20s)
    const doc = createEditDocument([clip("clip-1", "a", 0, 10 * S), clip("clip-2", "b", 0, 10 * S), clip("clip-3", "a", 10 * S, 20 * S)]);
    const range = { sourceId: "a", start: 5 * S, end: 15 * S };
    const cut = cutRanges(doc, ctx, [range]);
    expect(cutPlacement(cut.current, ctx, range)).toEqual({ kind: "after", clipId: "clip-1", index: 0 });
    const back = restoreRanges(cut, ctx, [range]).current.clips;
    expect(shape(back)).toEqual([
      ["a", 0, 15 * S],
      ["b", 0, 10 * S],
      ["a", 15 * S, 20 * S],
    ]);
  });
  it("when the source plays in source order, cutting then restoring gives back the same playing order", () => {
    // a[0,10s) | a[10s,20s) | b[0,10s): cut across the boundary of two neighbours.
    const doc = createEditDocument([clip("clip-1", "a", 0, 10 * S), clip("clip-2", "a", 10 * S, 20 * S), clip("clip-3", "b", 0, 10 * S)]);
    const range = { sourceId: "a", start: 5 * S, end: 15 * S };
    const back = restoreRanges(cutRanges(doc, ctx, [range]), ctx, [range]).current.clips;
    // The boundary at 10 s is gone (the pieces merged), but the same moments play in the same order.
    expect(shape(back)).toEqual([
      ["a", 0, 20 * S],
      ["b", 0, 10 * S],
    ]);
  });
});
