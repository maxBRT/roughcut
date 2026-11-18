/**
 * Questions about the sequence, which change nothing (spec 3.5.1). They take an `EditState`
 * (usually `doc.current`). Sequence times are positions in the edited sequence; source
 * positions are positions in a source file.
 */
import type { Clip, EditState, Micros, Rational, SequenceTime, SourcePosition, SourceRange } from "../types";
import { snapToFrame } from "../types";

/** Where each clip starts in the sequence; memoised per clip array (arrays are never mutated). */
const startsCache = new WeakMap<readonly Clip[], Float64Array>();

/** Internal: sequence start of every clip, plus the total at index `clips.length`. */
export function sequenceStarts(clips: readonly Clip[]): Float64Array {
  let starts = startsCache.get(clips);
  if (starts) return starts;
  starts = new Float64Array(clips.length + 1);
  let t = 0;
  for (let i = 0; i < clips.length; i++) {
    starts[i] = t;
    const c = clips[i]!;
    t += c.end - c.start;
  }
  starts[clips.length] = t;
  startsCache.set(clips, starts);
  return starts;
}

/** The length of the edited sequence. */
export function sequenceDuration(state: EditState): Micros {
  return sequenceStarts(state.clips)[state.clips.length]!;
}

/** A clip together with where it sits in the sequence. */
export interface PlacedClip {
  clip: Clip;
  index: number;
  /** Where the clip starts in the sequence. */
  sequenceStart: SequenceTime;
}

/** The clip playing at sequence time `t` (start included, end not); null outside the sequence. */
export function clipAt(state: EditState, t: SequenceTime): PlacedClip | null {
  const clips = state.clips;
  const starts = sequenceStarts(clips);
  if (clips.length === 0 || t < 0 || t >= starts[clips.length]!) return null;
  let lo = 0;
  let hi = clips.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return { clip: clips[lo]!, index: lo, sequenceStart: starts[lo]! };
}

/** The clip with this id and its place in the sequence, or null. */
export function findClip(state: EditState, clipId: string): PlacedClip | null {
  const index = state.clips.findIndex((c) => c.id === clipId);
  if (index < 0) return null;
  return { clip: state.clips[index]!, index, sequenceStart: sequenceStarts(state.clips)[index]! };
}

/**
 * The source moment shown at sequence time `t`. The very end of the sequence maps to the
 * end of the last clip. Null outside the sequence.
 */
export function sourcePositionAt(state: EditState, t: SequenceTime): SourcePosition | null {
  const placed = clipAt(state, t);
  if (placed) return { sourceId: placed.clip.sourceId, at: placed.clip.start + (t - placed.sequenceStart) };
  const last = state.clips[state.clips.length - 1];
  if (last && t === sequenceDuration(state)) return { sourceId: last.sourceId, at: last.end };
  return null;
}

/**
 * Where a source moment plays in the sequence; null when that moment is cut. The end of the
 * last clip maps to the end of the sequence.
 */
export function sequenceTimeOf(state: EditState, pos: SourcePosition): SequenceTime | null {
  const clips = state.clips;
  const starts = sequenceStarts(clips);
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!;
    if (c.sourceId === pos.sourceId && c.start <= pos.at && pos.at < c.end) return starts[i]! + (pos.at - c.start);
  }
  const last = clips[clips.length - 1];
  if (last && last.sourceId === pos.sourceId && last.end === pos.at) return starts[clips.length]!;
  return null;
}

/** A boundary between two neighbouring clips. */
export interface CutPoint {
  /** Index of the clip after the boundary. */
  index: number;
  /** Where the boundary is in the sequence. */
  at: SequenceTime;
  before: Clip;
  after: Clip;
}

/** Every boundary between neighbouring clips, in playing order. */
export function cutPoints(state: EditState): CutPoint[] {
  const clips = state.clips;
  const starts = sequenceStarts(clips);
  const out: CutPoint[] = [];
  for (let i = 1; i < clips.length; i++) out.push({ index: i, at: starts[i]!, before: clips[i - 1]!, after: clips[i]! });
  return out;
}

/** The cut point nearest sequence time `t` (the earlier one on a tie), or null when there is none. */
export function nearestCutPoint(state: EditState, t: SequenceTime): CutPoint | null {
  let best: CutPoint | null = null;
  for (const p of cutPoints(state)) if (best === null || Math.abs(p.at - t) < Math.abs(best.at - t)) best = p;
  return best;
}

/** The parts of `range` that are kept, in source order, with touching parts joined. */
export function keptRanges(state: EditState, range: SourceRange): SourceRange[] {
  const parts: [number, number][] = [];
  for (const c of state.clips) {
    if (c.sourceId !== range.sourceId) continue;
    const s = Math.max(c.start, range.start);
    const e = Math.min(c.end, range.end);
    if (s < e) parts.push([s, e]);
  }
  parts.sort((a, b) => a[0] - b[0]);
  const out: SourceRange[] = [];
  for (const [s, e] of parts) {
    const last = out[out.length - 1];
    if (last && last.end >= s) last.end = Math.max(last.end, e);
    else out.push({ sourceId: range.sourceId, start: s, end: e });
  }
  return out;
}

/** How much of a source range is kept. */
export type KeepState = "kept" | "partial" | "cut";

/**
 * Whether a source range is fully kept, partly kept or cut. An empty range counts as kept
 * when its start lies inside a clip, otherwise as cut.
 */
export function rangeKeepState(state: EditState, range: SourceRange): KeepState {
  if (range.end <= range.start) {
    return state.clips.some((c) => c.sourceId === range.sourceId && c.start <= range.start && range.start < c.end) ? "kept" : "cut";
  }
  const kept = keptRanges(state, range).reduce((sum, r) => sum + (r.end - r.start), 0);
  if (kept === 0) return "cut";
  return kept === range.end - range.start ? "kept" : "partial";
}

/** Whether every moment of `range` is kept. */
export function isKept(state: EditState, range: SourceRange): boolean {
  return rangeKeepState(state, range) === "kept";
}

/**
 * A range with both ends snapped to the nearest frame boundary: exactly what `cutRanges`
 * and `restoreRanges` act on. May come out empty.
 */
export function snapRange(range: SourceRange, rate: Rational): SourceRange {
  return { sourceId: range.sourceId, start: snapToFrame(Math.round(range.start), rate), end: snapToFrame(Math.round(range.end), rate) };
}

/** A suggestion's state, worked out from the edit (spec 3.4 rule 4). */
export type SuggestionState = "dismissed" | "applied" | "pending";

/**
 * Dismissed when a dismissed range covers the suggestion's range; applied when none of its
 * range (snapped to the grid, as `cutRanges` would cut it) is kept; pending otherwise.
 */
export function suggestionState(state: EditState, range: SourceRange, rate: Rational): SuggestionState {
  if (state.dismissed.some((d) => d.sourceId === range.sourceId && d.start <= range.start && range.end <= d.end)) return "dismissed";
  const snapped = snapRange(range, rate);
  const target = snapped.end > snapped.start ? snapped : range;
  return rangeKeepState(state, target) === "cut" ? "applied" : "pending";
}
