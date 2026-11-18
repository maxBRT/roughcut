import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Clip } from "../../types";
import { frameToMicros, isOnFrameGrid } from "../../types";
import {
  clampStart,
  clipIndexAt,
  dropIndex,
  firstClipEndingAfter,
  formatTime,
  hitTest,
  initialScroll,
  layoutClips,
  nearestGap,
  RULER_H,
  syncScroll,
  tickStep,
  timeToX,
  TRACK_TOP,
  trimTarget,
  visibleSpan,
  withEdge,
  xToTime,
  type Viewport,
} from "./geometry";

const S = 1_000_000;
const clip = (id: string, start: number, end: number, sourceId = "src"): Clip => ({ id, sourceId, start, end });
const CLIPS = [clip("a", 0, 10 * S), clip("b", 20 * S, 50 * S), clip("c", 60 * S, 120 * S)];

describe("layout", () => {
  it("places clips end to end and finds the clip at a time", () => {
    const l = layoutClips(CLIPS);
    expect(Array.from(l.starts)).toEqual([0, 10 * S, 40 * S, 100 * S]);
    expect(l.duration).toBe(100 * S);
    expect(clipIndexAt(l, 0)).toBe(0);
    expect(clipIndexAt(l, 10 * S - 1)).toBe(0);
    expect(clipIndexAt(l, 10 * S)).toBe(1);
    expect(clipIndexAt(l, 99 * S)).toBe(2);
    expect(clipIndexAt(l, 100 * S)).toBe(2); // the end of the sequence: the last clip
    expect(clipIndexAt(layoutClips([]), 0)).toBe(-1);
    expect(firstClipEndingAfter(l, 10 * S)).toBe(1);
    expect(firstClipEndingAfter(l, 9 * S)).toBe(0);
    expect(firstClipEndingAfter(l, 100 * S)).toBe(3);
  });

  it("clipIndexAt agrees with a linear scan for 300 random clips", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 5000 }), { minLength: 1, maxLength: 300 }), fc.double({ min: 0, max: 1, noNaN: true }), (lengths, f) => {
        let t = 0;
        const clips = lengths.map((len, i) => {
          const c = clip(`c${i}`, t, t + len);
          t += len;
          return c;
        });
        const l = layoutClips(clips);
        const at = Math.floor(f * (l.duration - 1));
        let expected = 0;
        while (l.starts[expected + 1]! <= at) expected++;
        expect(clipIndexAt(l, at)).toBe(expected);
      }),
    );
  });
});

describe("viewport", () => {
  const vp: Viewport = { width: 1000, zoom: 4, start: 20 * S, duration: 100 * S };

  it("maps time to pixels and back", () => {
    expect(visibleSpan(vp)).toBe(25 * S);
    expect(timeToX(vp, 20 * S)).toBe(0);
    expect(timeToX(vp, 45 * S)).toBeCloseTo(1000);
    expect(xToTime(vp, timeToX(vp, 33 * S))).toBeCloseTo(33 * S);
  });

  it("keeps the left edge inside the sequence", () => {
    expect(clampStart(vp, -5)).toBe(0);
    expect(clampStart(vp, 90 * S)).toBe(75 * S);
    expect(clampStart({ ...vp, zoom: 1 }, 10 * S)).toBe(0);
  });

  it("zooming with the wheel keeps the time under the mouse", () => {
    let mem = syncScroll(initialScroll(), { zoom: 2, duration: 100 * S, width: 1000, playhead: 0, playing: false });
    const before: Viewport = { width: 1000, zoom: mem.zoom, start: mem.start, duration: 100 * S };
    const t = xToTime(before, 300);
    mem = { ...mem, anchor: { time: t, x: 300 } };
    mem = syncScroll(mem, { zoom: 8, duration: 100 * S, width: 1000, playhead: 0, playing: false });
    const after: Viewport = { width: 1000, zoom: 8, start: mem.start, duration: 100 * S };
    expect(timeToX(after, t)).toBeCloseTo(300);
  });

  it("zooming with the keys keeps the playhead where it was on screen", () => {
    let mem = syncScroll(initialScroll(), { zoom: 1, duration: 100 * S, width: 1000, playhead: 30 * S, playing: false });
    mem = syncScroll(mem, { zoom: 4, duration: 100 * S, width: 1000, playhead: 30 * S, playing: false });
    expect(timeToX({ width: 1000, zoom: 4, start: mem.start, duration: 100 * S }, 30 * S)).toBeCloseTo(300);
  });

  it("brings an off-screen playhead back: paged ahead while playing, centred when it jumps", () => {
    let mem = syncScroll(initialScroll(), { zoom: 4, duration: 100 * S, width: 1000, playhead: 0, playing: false });
    expect(mem.start).toBe(0);
    // Playing past the right edge pages so the playhead is near the left.
    mem = syncScroll(mem, { zoom: 4, duration: 100 * S, width: 1000, playhead: 26 * S, playing: true });
    expect(mem.start).toBeCloseTo(26 * S - 2.5 * S);
    // A jump far away centres it.
    mem = syncScroll(mem, { zoom: 4, duration: 100 * S, width: 1000, playhead: 70 * S, playing: false });
    expect(mem.start).toBeCloseTo(70 * S - 12.5 * S);
    // Near the end it stops at the end.
    mem = syncScroll(mem, { zoom: 4, duration: 100 * S, width: 1000, playhead: 99 * S, playing: false });
    expect(mem.start).toBe(75 * S);
  });

  it("a scroll the user made stays while the playhead does not move", () => {
    let mem = syncScroll(initialScroll(), { zoom: 4, duration: 100 * S, width: 1000, playhead: 5 * S, playing: false });
    mem = { ...mem, start: 60 * S };
    mem = syncScroll(mem, { zoom: 4, duration: 100 * S, width: 1000, playhead: 5 * S, playing: false });
    expect(mem.start).toBe(60 * S);
    // A visible playhead move keeps it too; one off screen brings it back.
    mem = syncScroll(mem, { zoom: 4, duration: 100 * S, width: 1000, playhead: 70 * S, playing: false });
    expect(mem.start).toBe(60 * S);
    mem = syncScroll(mem, { zoom: 4, duration: 100 * S, width: 1000, playhead: 6 * S, playing: false });
    expect(mem.start).toBe(0);
  });

  it("fit always starts at zero", () => {
    const mem = syncScroll({ ...initialScroll(), start: 40 * S, zoom: 4, duration: 100 * S, width: 1000 }, { zoom: 1, duration: 100 * S, width: 1000, playhead: 90 * S, playing: true });
    expect(mem.start).toBe(0);
  });
});

describe("ruler and times", () => {
  it("picks the mockup's 30 s spacing for a four-minute window 888 px wide", () => {
    expect(tickStep({ width: 888, zoom: 1, start: 0, duration: 240 * S })).toBe(30 * S);
    expect(tickStep({ width: 1000, zoom: 1, start: 0, duration: 2 * S })).toBe(0.2 * S);
  });

  it("formats times as the mockups do", () => {
    expect(formatTime(27_400_000)).toBe("0:27.4");
    expect(formatTime(27_499_000)).toBe("0:27.4");
    // Seen in the real app: after a cut, the frame at 1:20.0 has sequence time 79 999 999 µs
    // (each clip's length is a difference of two frame-grid times). It reads 1:20.0.
    expect(formatTime(79_999_999)).toBe("1:20.0");
    expect(formatTime((41 * 60 + 12) * S, false)).toBe("41:12");
    expect(formatTime((3 * 60 + 2.7) * S)).toBe("3:02.7");
    expect(formatTime(3723 * S, false)).toBe("1:02:03");
    expect(formatTime(0, false)).toBe("0:00");
  });
});

describe("hit testing", () => {
  const l = layoutClips(CLIPS); // 0-10, 10-40, 40-100 s
  const vp: Viewport = { width: 1000, zoom: 1, start: 0, duration: 100 * S }; // 10 px per second
  const y = TRACK_TOP + 40;

  it("finds the ruler, clip bodies and edges", () => {
    expect(hitTest(l, vp, 50, RULER_H / 2, false)).toEqual({ kind: "ruler" });
    expect(hitTest(l, vp, 50, y, false)).toEqual({ kind: "clip", index: 0 });
    expect(hitTest(l, vp, 250, y, false)).toEqual({ kind: "clip", index: 1 });
    // Either side of the cut at 100 px: the end of clip 0, the start of clip 1.
    expect(hitTest(l, vp, 97, y, false)).toEqual({ kind: "edge", index: 0, edge: "end" });
    expect(hitTest(l, vp, 103, y, false)).toEqual({ kind: "edge", index: 1, edge: "start" });
    expect(hitTest(l, vp, 1, y, false)).toEqual({ kind: "edge", index: 0, edge: "start" });
    expect(hitTest(l, vp, 999, y, false)).toEqual({ kind: "edge", index: 2, edge: "end" });
  });

  it("finds where a dragged clip would land", () => {
    expect(nearestGap(l, vp, 20)).toBe(0);
    expect(nearestGap(l, vp, 80)).toBe(1);
    expect(nearestGap(l, vp, 300)).toBe(2);
    expect(nearestGap(l, vp, 990)).toBe(3);
    expect(dropIndex(0, 3)).toBe(2);
    expect(dropIndex(2, 0)).toBe(0);
    expect(dropIndex(1, 1)).toBe(1);
    expect(dropIndex(1, 2)).toBe(1);
  });
});

describe("trim targets", () => {
  const rate = { num: 30000, den: 1001 };
  const c = clip("a", frameToMicros(300, rate), frameToMicros(600, rate));

  it("snaps to the frame grid and stays inside the source", () => {
    const end = trimTarget(c, "end", 1_234_567, rate, 60 * S);
    expect(isOnFrameGrid(end, rate)).toBe(true);
    expect(Math.abs(end - (c.end + 1_234_567))).toBeLessThanOrEqual(frameToMicros(1, rate));
    expect(trimTarget(c, "start", -100 * S, rate, 60 * S)).toBe(0);
    expect(trimTarget(c, "end", 1000 * S, rate, 60 * S)).toBe(frameToMicros(1798, rate)); // 60 s floored to the grid
  });

  it("never leaves a clip shorter than one frame", () => {
    expect(trimTarget(c, "start", 1000 * S, rate, 60 * S)).toBe(frameToMicros(599, rate));
    expect(trimTarget(c, "end", -1000 * S, rate, 60 * S)).toBe(frameToMicros(301, rate));
  });

  it("previews the edited list", () => {
    expect(withEdge(CLIPS, 1, "end", 55 * S)[1]).toEqual(clip("b", 20 * S, 55 * S));
    expect(withEdge(CLIPS, 1, "start", 25 * S)[1]).toEqual(clip("b", 25 * S, 50 * S));
  });
});
