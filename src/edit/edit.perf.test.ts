/** Commands and queries on a 2000-clip list stay within a few milliseconds (spec 2.4.7: an edit completes within a frame). */
import { describe, expect, it } from "vitest";
import type { EditDocument, SourceRange } from "../types";
import { frameToMicros } from "../types";
import {
  appendSource,
  clipAt,
  createEditDocument,
  cutPoints,
  cutRanges,
  moveClip,
  nudgeEdge,
  removeClip,
  restoreRanges,
  sequenceDuration,
  sequenceTimeOf,
  sourcePositionAt,
  splitAt,
  trimEdge,
  undo,
  validateEditState,
} from "./index";
import type { EditContext } from "./index";

const rate = { num: 30000, den: 1001 };
const HOURS2 = 2 * 3600 * 1_000_000;
const ctx: EditContext = { frameRate: rate, sources: [{ id: "a", duration: HOURS2 }, { id: "b", duration: 60_000_000 }] };

/** One source cut 1999 times: 2000 clips, with a history of 50 steps. */
function bigDoc(): EditDocument {
  let d = appendSource(createEditDocument(), ctx, "a", HOURS2);
  const ranges: SourceRange[] = [];
  for (let i = 1; i < 2000; i++) ranges.push({ sourceId: "a", start: frameToMicros(i * 100, rate), end: frameToMicros(i * 100 + 10, rate) });
  d = cutRanges(d, ctx, ranges);
  for (let i = 0; i < 50; i++) d = nudgeEdge(d, ctx, d.current.clips[i]!.id, "end", 1);
  return d;
}

function median(fn: () => unknown, runs = 25): number {
  fn(); // warm up
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

describe("a 2000-clip list", () => {
  const d = bigDoc();
  const mid = d.current.clips[1000]!;
  const total = sequenceDuration(d.current);
  it("has 2000 sound clips", () => {
    expect(d.current.clips).toHaveLength(2000);
    expect(validateEditState(d.current, ctx)).toEqual([]);
  });
  const cases: [string, () => unknown][] = [
    ["cutRanges", () => cutRanges(d, ctx, [{ sourceId: "a", start: mid.start + 1_000_000, end: mid.start + 1_500_000 }])],
    ["restoreRanges", () => restoreRanges(d, ctx, [{ sourceId: "a", start: mid.end, end: mid.end + 1_000_000 }])],
    ["trimEdge", () => trimEdge(d, ctx, mid.id, "end", mid.end + 10_000_000)],
    ["nudgeEdge", () => nudgeEdge(d, ctx, mid.id, "start", -3)],
    ["splitAt", () => splitAt(d, ctx, Math.floor(total / 2))],
    ["removeClip", () => removeClip(d, ctx, mid.id)],
    ["moveClip", () => moveClip(d, ctx, mid.id, "later")],
    ["appendSource", () => appendSource(d, ctx, "b", 60_000_000)],
    ["undo", () => undo(d)],
    ["clipAt (new list)", () => clipAt({ clips: d.current.clips.slice(), dismissed: [] }, Math.floor(total / 3))],
    ["sourcePositionAt", () => sourcePositionAt(d.current, Math.floor(total / 3))],
    ["sequenceTimeOf", () => sequenceTimeOf(d.current, { sourceId: "a", at: mid.start + 5 })],
    ["cutPoints", () => cutPoints(d.current)],
  ];
  for (const [name, fn] of cases) {
    it(`${name} takes under 5 ms`, () => {
      const ms = median(fn);
      console.log(`edit perf: ${name} on 2000 clips: median ${ms.toFixed(3)} ms`);
      expect(ms).toBeLessThan(5);
    });
  }
});
