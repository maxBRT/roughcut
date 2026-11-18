/**
 * Review tests (track edit-review, second pass): each one pins a defect found in review.
 * They are expected to FAIL until the module is fixed.
 */
import { describe, expect, it } from "vitest";
import type { Clip } from "../types";
import { createEditDocument, cutPoints, nudgeEdge, restoreRanges, splitAt, trimEdge, undo } from "./index";
import type { EditContext } from "./index";

const S = 1_000_000;
const ctx: EditContext = { frameRate: { num: 25, den: 1 }, sources: [{ id: "a", duration: 60 * S }] };
const clip = (id: string, sourceId: string, start: number, end: number): Clip => ({ id, sourceId, start, end });

describe("review: pulling an edge out to the neighbouring clip of the same source", () => {
  // a[0,10s) | a[20s,30s): a[10s,20s) is cut. These are neighbours in the sequence.
  const doc = createEditDocument([clip("clip-1", "a", 0, 10 * S), clip("clip-2", "a", 20 * S, 30 * S)]);

  it("trimEdge that brings back the whole gap gives the same clips as restoring that gap", () => {
    const restored = restoreRanges(doc, ctx, [{ sourceId: "a", start: 10 * S, end: 20 * S }]).current.clips;
    expect(restored).toEqual([clip("clip-1", "a", 0, 30 * S)]);
    const trimmed = trimEdge(doc, ctx, "clip-1", "end", 25 * S).current.clips;
    // Spec 1.8 timeline 2-3: trimming an edge restores the material it covers; 3.5.1: closing a gap merges.
    expect(trimmed).toEqual(restored);
  });

  it("after the gap is closed by a trim, no cut point is left where nothing is cut", () => {
    const trimmed = trimEdge(doc, ctx, "clip-2", "start", 0).current;
    expect(cutPoints(trimmed)).toEqual([]);
  });

  it("nudgeEdge closing the gap also merges", () => {
    const nudged = nudgeEdge(doc, ctx, "clip-1", "end", 1000).current.clips;
    expect(nudged).toHaveLength(1);
  });

  it("a start edge pulled back to the earlier neighbour merges, and the earlier clip keeps its id", () => {
    const next = trimEdge(doc, ctx, "clip-2", "start", 0);
    expect(next.current.clips).toEqual([clip("clip-1", "a", 0, 30 * S)]);
    expect(next.undo).toHaveLength(1);
    expect(nudgeEdge(doc, ctx, "clip-2", "start", -1000).current.clips).toEqual([clip("clip-1", "a", 0, 30 * S)]);
  });

  it("a trim that stops short of the neighbour does not merge", () => {
    const next = trimEdge(doc, ctx, "clip-1", "end", 15 * S).current.clips;
    expect(next).toEqual([clip("clip-1", "a", 0, 15 * S), clip("clip-2", "a", 20 * S, 30 * S)]);
  });

  it("no merge when the clip it reaches is not its neighbour in the sequence", () => {
    // a[20s,30s) plays first, then a[0,10s): pulling clip-1's end to 20s meets clip-2 in source time only.
    const swapped = createEditDocument([clip("clip-2", "a", 20 * S, 30 * S), clip("clip-1", "a", 0, 10 * S)]);
    const next = trimEdge(swapped, ctx, "clip-1", "end", 25 * S).current.clips;
    expect(next).toEqual([clip("clip-2", "a", 20 * S, 30 * S), clip("clip-1", "a", 0, 20 * S)]);
  });

  it("no merge across a different source between them", () => {
    const ctx2: EditContext = { ...ctx, sources: [...ctx.sources, { id: "b", duration: 60 * S }] };
    const mixed = createEditDocument([clip("clip-1", "a", 0, 10 * S), clip("clip-3", "b", 0, 5 * S), clip("clip-2", "a", 20 * S, 30 * S)]);
    const next = trimEdge(mixed, ctx2, "clip-1", "end", 25 * S).current.clips;
    expect(next).toHaveLength(3);
    expect(next[0]).toEqual(clip("clip-1", "a", 0, 20 * S));
  });

  it("a split boundary survives a trim that cannot move the touching edge", () => {
    const split = splitAt(createEditDocument([clip("clip-1", "a", 0, 10 * S)]), ctx, 4 * S);
    expect(split.current.clips).toHaveLength(2);
    expect(trimEdge(split, ctx, "clip-1", "end", 8 * S)).toBe(split);
    expect(nudgeEdge(split, ctx, "clip-2", "start", -3)).toBe(split);
  });

  it("undo after a merging trim gives back both clips exactly", () => {
    const merged = trimEdge(doc, ctx, "clip-1", "end", 25 * S);
    expect(undo(merged).current).toEqual(doc.current);
  });
});
