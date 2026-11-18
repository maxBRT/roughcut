import { describe, expect, it } from "vitest";
import type { Clip } from "../../types";
import { carriesFiles, droppedPaths, pathFromFileUri } from "./drop";
import { formatDuration, formatSeconds, formatTimecode, formatTimeLeft } from "./format";
import {
  BAR_PITCH,
  buildOverview,
  drawOverview,
  fractionOfTime,
  overviewBars,
  segmentAt,
  timeAtFraction,
  type StripContext,
} from "./overview";

const S = 1_000_000;
const clip = (id: string, sourceId: string, start: number, end: number): Clip => ({ id, sourceId, start: start * S, end: end * S });
const src = (id: string, end: number, transcribedTo = Infinity) => ({ id, end: end * S, transcribedTo: transcribedTo * S });

describe("buildOverview", () => {
  it("puts cut material after the clip it was cut from, in playing order", () => {
    const m = buildOverview({ clips: [clip("a", "A", 0, 2), clip("b", "A", 5, 10)], sources: [src("A", 10)] });
    expect(m.length).toBe(10 * S);
    expect(m.sequenceLength).toBe(7 * S);
    expect(m.segments.map((s) => [s.kind, s.start / S, s.end / S, s.at / S, s.seqStart / S])).toEqual([
      ["kept", 0, 2, 0, 0],
      ["cut", 2, 5, 2, 2],
      ["kept", 5, 10, 5, 2],
    ]);
  });

  it("puts a cut start before the first clip and a cut end after the last", () => {
    const m = buildOverview({ clips: [clip("a", "A", 1, 4)], sources: [src("A", 6)] });
    expect(m.segments.map((s) => [s.kind, s.start / S, s.end / S, s.seqStart / S])).toEqual([
      ["cut", 0, 1, 0],
      ["kept", 1, 4, 0],
      ["cut", 4, 6, 3],
    ]);
  });

  it("follows moved clips and shows a source with no clip whole at the end", () => {
    const m = buildOverview({
      clips: [clip("b", "A", 5, 8), clip("a", "A", 0, 3)],
      sources: [src("A", 8), src("B", 4)],
    });
    expect(m.segments.map((s) => [s.kind, s.sourceId, s.start / S, s.end / S])).toEqual([
      ["kept", "A", 5, 8],
      ["kept", "A", 0, 3],
      ["cut", "A", 3, 5],
      ["cut", "B", 0, 4],
    ]);
    expect(m.sequenceLength).toBe(6 * S);
    expect(m.length).toBe(12 * S);
  });

  it("is empty with no sources", () => {
    const m = buildOverview({ clips: [], sources: [] });
    expect(m.length).toBe(0);
    expect(segmentAt(m, 0)).toBeNull();
    expect(timeAtFraction(m, 0.5)).toBe(0);
    expect(fractionOfTime(m, 0)).toBe(0);
    expect(overviewBars(m, 10)).toEqual([]);
  });
});

describe("strip positions and sequence times", () => {
  const m = buildOverview({ clips: [clip("a", "A", 0, 2), clip("b", "A", 5, 10)], sources: [src("A", 10)] });

  it("a click on kept material goes to that moment of the sequence", () => {
    expect(timeAtFraction(m, 0.1)).toBe(1 * S);
    expect(timeAtFraction(m, 0.6)).toBe(3 * S);
    expect(timeAtFraction(m, 1)).toBe(7 * S);
    expect(timeAtFraction(m, -1)).toBe(0);
  });

  it("a click on cut material goes to the cut it sits at", () => {
    expect(timeAtFraction(m, 0.3)).toBe(2 * S);
    expect(timeAtFraction(m, 0.45)).toBe(2 * S);
  });

  it("the playhead is drawn where its material is", () => {
    expect(fractionOfTime(m, 1 * S)).toBeCloseTo(0.1);
    expect(fractionOfTime(m, 2 * S)).toBeCloseTo(0.5);
    expect(fractionOfTime(m, 7 * S)).toBeCloseTo(1);
    for (const t of [0, 0.5, 1.9, 2, 4.2, 6.99].map((x) => x * S)) {
      expect(timeAtFraction(m, fractionOfTime(m, t))).toBe(Math.round(t));
    }
  });
});

describe("overviewBars and drawOverview", () => {
  it("marks cut, suggested, pending and kept material", () => {
    const m = buildOverview({
      clips: [clip("a", "A", 0, 4), clip("b", "A", 6, 10)],
      sources: [src("A", 10, 8)],
      suggestions: [{ sourceId: "A", start: 1 * S, end: 3 * S }],
    });
    const bars = overviewBars(m, 10);
    expect(bars.map((b) => b.kind)).toEqual([
      "kept", "suggested", "suggested", "kept", "cut", "cut", "kept", "kept", "pending", "pending",
    ]);
    expect(bars.every((b) => b.level === 0.45)).toBe(true);
  });

  it("takes each bar's level from the loudness of its stretch", () => {
    const m = buildOverview({ clips: [clip("a", "A", 0, 4)], sources: [src("A", 4)] });
    const calls: [string, number, number][] = [];
    const bars = overviewBars(m, 4, (id, from, to) => {
      calls.push([id, from, to]);
      return from / (4 * S);
    });
    expect(calls).toEqual([
      ["A", 0, 1 * S],
      ["A", 1 * S, 2 * S],
      ["A", 2 * S, 3 * S],
      ["A", 3 * S, 4 * S],
    ]);
    expect(bars.map((b) => b.level)).toEqual([0.06, 0.25, 0.5, 0.75]);
  });

  it("draws kept in ink, cut low in the accent, suggested outlined, pending grey", () => {
    const ops: string[] = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      clearRect: () => ops.push("clear"),
      fillRect(this: { fillStyle: unknown }, x: number, _y: number, w: number, h: number) {
        ops.push(`fill ${String(this.fillStyle)} x=${x} w=${w} h=${h}`);
      },
      strokeRect(this: { strokeStyle: unknown }, x: number) {
        ops.push(`stroke ${String(this.strokeStyle)} x=${x}`);
      },
      setTransform: () => undefined,
    } as unknown as StripContext;
    drawOverview(
      ctx,
      [
        { kind: "kept", level: 1 },
        { kind: "cut", level: 1 },
        { kind: "suggested", level: 1 },
        { kind: "pending", level: 0.5 },
      ],
      16,
      34,
      { ink: "ink", accent: "acc", pending: "grey" },
    );
    expect(ops).toEqual([
      "clear",
      "fill ink x=0 w=2 h=34",
      `fill acc x=${BAR_PITCH} w=2 h=10`,
      `stroke acc x=${2 * BAR_PITCH + 0.5}`,
      `fill grey x=${3 * BAR_PITCH} w=2 h=17`,
    ]);
  });
});

describe("format", () => {
  it("formats lengths, the playhead and time left", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(2472 * S)).toBe("41:12");
    expect(formatDuration(3870 * S + 999_999)).toBe("1:04:30");
    expect(formatTimecode(28.27 * S)).toBe("0:28.2");
    expect(formatTimecode(3723.4 * S)).toBe("1:02:03.4");
    // Seen in the real app: after a cut the frame at 1:20.0 has sequence time 79 999 999 µs and
    // read "1:19.9". Times this close under a tenth belong to the frame on it.
    expect(formatTimecode(79_999_999)).toBe("1:20.0");
    expect(formatTimecode(79_999_000)).toBe("1:19.9");
    expect(formatSeconds(3.25 * S)).toBe("3.2 s");
    expect(formatSeconds(64 * S)).toBe("1:04");
    expect(formatTimeLeft(null)).toBeNull();
    expect(formatTimeLeft(20)).toBe("under a minute left");
    expect(formatTimeLeft(170)).toBe("about 3 min left");
    expect(formatTimeLeft(3 * 3600)).toBe("about 3 h left");
  });
});

describe("drop", () => {
  it("reads Windows paths from file URIs and File paths", () => {
    expect(pathFromFileUri("file:///D:/Footage/A%20B.mp4")).toBe("D:\\Footage\\A B.mp4");
    expect(pathFromFileUri("file://server/share/x.mp4")).toBe("\\\\server\\share\\x.mp4");
    expect(pathFromFileUri("https://example.com/x.mp4")).toBeNull();
    const list = { types: ["Files", "text/uri-list"], files: [], getData: () => "# comment\r\nfile:///D:/a.mp4\r\nfile:///D:/a.mp4\r\nfile:///E:/b.mov" };
    expect(droppedPaths(list)).toEqual(["D:\\a.mp4", "E:\\b.mov"]);
    const withPath = Object.assign(new File([""], "c.mp4"), { path: "C:\\c.mp4" });
    expect(droppedPaths({ types: ["Files"], files: [withPath], getData: () => "" })).toEqual(["C:\\c.mp4"]);
    expect(droppedPaths({ types: ["Files"], files: [new File([""], "d.mp4")], getData: () => "" })).toEqual([]);
    expect(carriesFiles({ types: ["text/plain"] })).toBe(false);
    expect(carriesFiles({ types: ["Files"] })).toBe(true);
    expect(carriesFiles(null)).toBe(false);
  });
});
