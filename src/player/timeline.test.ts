import { describe, expect, it } from "vitest";
import type { Clip, Rational } from "../types";
import { frameToMicros } from "../types";
import { Timeline } from "./timeline";

const R30: Rational = { num: 30, den: 1 };
const NTSC: Rational = { num: 30000, den: 1001 };

function clip(id: string, sourceId: string, f0: number, f1: number, rate: Rational = R30): Clip {
  return { id, sourceId, start: frameToMicros(f0, rate), end: frameToMicros(f1, rate) };
}

describe("Timeline", () => {
  it("counts frames per clip and locates them", () => {
    const tl = new Timeline([clip("a", "A", 10, 13), clip("b", "B", 100, 102)], R30);
    expect(tl.totalFrames).toBe(5);
    expect(tl.frame(0)).toMatchObject({ clipIndex: 0, at: frameToMicros(10, R30), time: 0 });
    expect(tl.frame(2)).toMatchObject({ clipIndex: 0, at: frameToMicros(12, R30) });
    expect(tl.frame(3)).toMatchObject({ clipIndex: 1, at: frameToMicros(100, R30), time: tl.clipStart(1) });
    expect(tl.frame(99)!.index).toBe(4);
    expect(tl.frame(-5)!.index).toBe(0);
  });

  it("maps sequence times to the frame that contains them", () => {
    const tl = new Timeline([clip("a", "A", 10, 13), clip("b", "B", 100, 102)], R30);
    expect(tl.frameAt(0)!.index).toBe(0);
    expect(tl.frameAt(tl.clipStart(1) - 1)!.index).toBe(2);
    expect(tl.frameAt(tl.clipStart(1))!.index).toBe(3);
    expect(tl.frameAt(tl.duration)!.index).toBe(4);
    expect(tl.frameAt(tl.duration + 1e6)!.index).toBe(4);
  });

  it("maps decoder frame times to grid frames, with rounding tolerance", () => {
    const tl = new Timeline([clip("a", "A", 10, 13)], R30);
    // 11/30 s reported as a slightly rounded-down timestamp.
    expect(tl.frameFromMedia(0, 366_666 - 3)!.at).toBe(frameToMicros(11, R30));
    expect(tl.frameFromMedia(0, frameToMicros(13, R30))).toBeNull();
    expect(tl.frameFromMedia(0, frameToMicros(13, R30) - 5)).toBeNull();
    expect(tl.frameFromMedia(0, frameToMicros(5, R30))).toBeNull();
  });

  it("steps over uneven grids (30000/1001) without drifting", () => {
    const tl = new Timeline([clip("a", "A", 0, 7, NTSC), clip("b", "A", 1000, 1009, NTSC)], NTSC);
    expect(tl.totalFrames).toBe(16);
    for (let k = 0; k < 16; k++) {
      const f = tl.frame(k)!;
      expect(tl.frameAt(f.time)!.index).toBe(k);
    }
    expect(tl.frame(7)!.at).toBe(frameToMicros(1000, NTSC));
  });

  it("is empty with no clips", () => {
    const tl = new Timeline([], R30);
    expect(tl.empty).toBe(true);
    expect(tl.frame(0)).toBeNull();
    expect(tl.frameAt(0)).toBeNull();
  });
});
