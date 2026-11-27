import { describe, expect, it } from "vitest";
import { cutRanges } from "../edit";
import { layoutTranscript } from "./layout";
import { selectionToRanges, selectTokens } from "./selection";
import { strandedSilence } from "./stranded";
import { fixture, inputOf, MS } from "./testing.test-helpers";

// "one" [400, 720), "two" [800, 1120), pause [1200, 2400) (cut point 1160), "three" from 2480.
const PARAGRAPHS = ["one two [pause] three four"];

/** Like accepting a dead-air suggestion: the middle of the pause goes, a margin stays on each side. */
function withDeadAirCut() {
  const f = fixture([{ id: "a", paragraphs: PARAGRAPHS }]);
  f.doc = cutRanges(f.doc, f.ctx, [{ sourceId: "a", start: 1520 * MS, end: 2080 * MS }]);
  return f;
}

describe("strandedSilence", () => {
  it("finds the dead-air margin left on its own when the speech before it is cut from the text", () => {
    // Found in the real app: ~50 blips of 0.2 s silence between cuts, unreachable from the text.
    const f = withDeadAirCut();
    const l = layoutTranscript(inputOf(f));
    const before = f.doc.current;
    const after = cutRanges(f.doc, f.ctx, selectionToRanges(l, selectTokens(l, 0, 1))).current;
    expect(after.clips.map((c) => [c.start / MS, c.end / MS])).toEqual([
      [1160, 1520],
      [2080, 4200],
    ]);
    expect(strandedSilence(l, before, after)).toEqual([{ sourceId: "a", start: 1160 * MS, end: 1520 * MS }]);
  });

  it("leaves a piece that still holds speech", () => {
    const f = withDeadAirCut();
    const l = layoutTranscript(inputOf(f));
    const after = cutRanges(f.doc, f.ctx, selectionToRanges(l, selectTokens(l, 0, 0))).current;
    expect(after.clips[0]!.start).toBe(760 * MS); // "two" and the margin stay together
    expect(strandedSilence(l, f.doc.current, after)).toEqual([]);
  });

  it("leaves short silent clips the edit did not touch", () => {
    const f = withDeadAirCut();
    f.doc = cutRanges(f.doc, f.ctx, [{ sourceId: "a", start: 0, end: 1160 * MS }]);
    const l = layoutTranscript(inputOf(f));
    // Cutting "four" does not touch the silent [1160, 1520) clip, so it is not returned.
    const after = cutRanges(f.doc, f.ctx, selectionToRanges(l, selectTokens(l, 4, 4))).current;
    expect(after.clips.some((c) => c.start === 1160 * MS)).toBe(true);
    expect(strandedSilence(l, f.doc.current, after)).toEqual([]);
  });

  it("leaves a long stretch of silence", () => {
    const f = fixture([{ id: "a", paragraphs: PARAGRAPHS }]);
    const l = layoutTranscript(inputOf(f));
    // Cut everything before the pause and from "three" on: the whole 1.24 s pause is left, on purpose.
    const after = cutRanges(f.doc, f.ctx, [
      { sourceId: "a", start: 0, end: 1160 * MS },
      { sourceId: "a", start: 2440 * MS, end: 4200 * MS },
    ]).current;
    expect(strandedSilence(l, f.doc.current, after)).toEqual([]);
  });
});
