/**
 * The sequence as frames: which clip and source moment every sequence frame shows. Sequence
 * times come from `edit` (a clip starts where the previous one ends); frames are counted on
 * the sequence frame grid of each clip's source times (`src/types/grid`), so stepping by one
 * frame always lands on the next grid point of the source, across cuts too.
 */
import { clipAt, sequenceDuration } from "../edit";
import type { Clip, EditState, Micros, Rational, SequenceTime } from "../types";
import { floorToFrame, frameToMicros, microsToFrameFloor } from "../types";

/** A frame of the sequence. */
export interface FrameLocation {
  /** Sequence frame index, from 0. */
  index: number;
  clipIndex: number;
  /** Source time of the frame's start. */
  at: Micros;
  /** Sequence time of the frame's start. */
  time: SequenceTime;
}

/**
 * Tolerance when mapping a decoder's frame time to the grid: container timestamps are
 * rounded, so a frame meant to start on grid point g can report g minus a few microseconds.
 */
export const MEDIA_TIME_TOLERANCE_US = 1000;

export class Timeline {
  readonly state: EditState;
  readonly duration: Micros;
  readonly totalFrames: number;
  private readonly seqStart: number[] = [];
  private readonly startFrame: number[] = [];
  /** Frames before clip i; `cum[n]` is the total. */
  private readonly cum: number[] = [0];

  constructor(
    readonly clips: readonly Clip[],
    readonly rate: Rational,
  ) {
    this.state = { clips: clips as Clip[], dismissed: [] };
    let t = 0;
    for (const c of clips) {
      this.seqStart.push(t);
      t += c.end - c.start;
      const f0 = microsToFrameFloor(c.start, rate);
      const f1 = Math.max(f0, microsToFrameFloor(c.end - 1, rate) + 1);
      this.startFrame.push(f0);
      this.cum.push(this.cum[this.cum.length - 1]! + (f1 - f0));
    }
    this.duration = sequenceDuration(this.state);
    this.totalFrames = this.cum[this.cum.length - 1]!;
  }

  get empty(): boolean {
    return this.totalFrames === 0;
  }

  clip(i: number): Clip | undefined {
    return this.clips[i];
  }

  /** Where clip `i` starts in the sequence. */
  clipStart(i: number): SequenceTime {
    return this.seqStart[i] ?? this.duration;
  }

  /** Sequence frame index of clip `i`'s first frame. */
  clipFirstFrame(i: number): number {
    return this.cum[i] ?? this.totalFrames;
  }

  /** Sequence time of source time `at` inside clip `i`. */
  timeOf(clipIndex: number, at: Micros): SequenceTime {
    const c = this.clips[clipIndex]!;
    return this.seqStart[clipIndex]! + (at - c.start);
  }

  /** The frame with sequence index `k`, clamped into the sequence; null when it is empty. */
  frame(k: number): FrameLocation | null {
    if (this.empty) return null;
    const index = Math.max(0, Math.min(this.totalFrames - 1, Math.floor(k)));
    let lo = 0;
    let hi = this.clips.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    // Skip clips with no frame (cannot happen for valid clips, but keeps the search safe).
    while (lo < this.clips.length - 1 && this.cum[lo + 1]! <= index) lo++;
    const at = Math.max(this.clips[lo]!.start, frameToMicros(this.startFrame[lo]! + (index - this.cum[lo]!), this.rate));
    return { index, clipIndex: lo, at, time: this.timeOf(lo, at) };
  }

  /** The frame showing at sequence time `t` (clamped into the sequence). */
  frameAt(t: SequenceTime): FrameLocation | null {
    if (this.empty) return null;
    if (t <= 0) return this.frame(0);
    const placed = clipAt(this.state, t);
    if (!placed) return this.frame(this.totalFrames - 1);
    return this.frameIn(placed.index, placed.clip.start + (t - placed.sequenceStart));
  }

  /** The frame of clip `clipIndex` that contains source time `at` (clamped into the clip). */
  frameIn(clipIndex: number, at: Micros): FrameLocation {
    const c = this.clips[clipIndex]!;
    const clamped = Math.max(c.start, Math.min(c.end - 1, at));
    const f = microsToFrameFloor(clamped, this.rate) - this.startFrame[clipIndex]!;
    const index = Math.max(this.cum[clipIndex]!, Math.min(this.cum[clipIndex + 1]! - 1, this.cum[clipIndex]! + f));
    const frameAt = Math.max(c.start, frameToMicros(this.startFrame[clipIndex]! + (index - this.cum[clipIndex]!), this.rate));
    return { index, clipIndex, at: frameAt, time: this.timeOf(clipIndex, frameAt) };
  }

  /**
   * The frame a decoder reports while playing clip `clipIndex`: `mediaMicros` is the frame's
   * presentation time. Null when that time is outside the clip.
   */
  frameFromMedia(clipIndex: number, mediaMicros: number): FrameLocation | null {
    const c = this.clips[clipIndex];
    if (!c) return null;
    const at = floorToFrame(Math.round(mediaMicros) + MEDIA_TIME_TOLERANCE_US, this.rate);
    if (at < c.start - MEDIA_TIME_TOLERANCE_US || at >= c.end) return null;
    return this.frameIn(clipIndex, Math.max(at, c.start));
  }

  /** The clip index of a clip id, or -1. */
  indexOfClip(id: string): number {
    return this.clips.findIndex((c) => c.id === id);
  }

  /** Length of one frame at source time `at` (grid points are uneven for rates like 30000/1001). */
  frameLength(at: Micros): Micros {
    const k = microsToFrameFloor(at, this.rate);
    return frameToMicros(k + 1, this.rate) - frameToMicros(k, this.rate);
  }
}
