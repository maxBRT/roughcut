/**
 * The overview strip's model (spec 1.7 C): the whole of every source laid out in playing
 * order, kept material as the sequence plays it and cut material where the transcript shows
 * it, next to the clip it was cut from. Pure data: the strip component draws it and turns a
 * click into a sequence time.
 *
 * Placement of cut material (the same idea as the transcript's): a cut stretch of a source sits
 * after the clip that ends where it starts; failing that, before the clip that starts where it
 * ends; failing that, after the last clip of that source that ends before it, or before the
 * first that starts after it. A source with no clip at all is shown whole, as cut, at the end.
 */
import type { Clip, Micros, SequenceTime, SourceId, SourceRange } from "../../types";

/** One source as the strip needs it. */
export interface OverviewSource {
  id: SourceId;
  /** Where the source's material ends: its duration floored to the frame grid (`firstClipEnd`). */
  end: Micros;
  /** How far its transcript has got (source time); material after it is drawn as pending. */
  transcribedTo: Micros;
}

/** A stretch of the strip: kept (part of the sequence) or cut. */
export interface OverviewSegment {
  kind: "kept" | "cut";
  sourceId: SourceId;
  /** Source time range, `start` included. */
  start: Micros;
  end: Micros;
  /** Where the segment starts on the strip, in strip microseconds. */
  at: number;
  /** Kept: the sequence time of `start`. Cut: the sequence time of the boundary it sits at. */
  seqStart: SequenceTime;
}

/** Everything the strip shows. */
export interface OverviewModel {
  /** Total strip length in microseconds (kept plus cut). */
  length: number;
  /** Length of the sequence (kept only). */
  sequenceLength: SequenceTime;
  segments: readonly OverviewSegment[];
  /** Pending suggestions' ranges. */
  suggestions: readonly SourceRange[];
  /** Per source, how far its transcript has got. */
  transcribedTo: Readonly<Record<SourceId, Micros>>;
}

/** What one bar of the strip shows. */
export type BarKind = "kept" | "cut" | "suggested" | "pending";

/** One bar: its kind and loudness from 0 to 1. */
export interface OverviewBar {
  kind: BarKind;
  level: number;
}

/** Mean loudness (0 to 1) of a source between two source times; null when not known. */
export type Loudness = (sourceId: SourceId, from: Micros, to: Micros) => number | null;

/** Builds the strip from the clip list (playing order), the project's sources and the pending suggestions. */
export function buildOverview(input: {
  clips: readonly Clip[];
  sources: readonly OverviewSource[];
  suggestions?: readonly SourceRange[];
}): OverviewModel {
  const { clips, sources } = input;
  const before: SourceRange[][] = clips.map(() => []);
  const after: SourceRange[][] = clips.map(() => []);
  const tail: SourceRange[] = [];

  for (const src of sources) {
    const own = clips
      .map((clip, index) => ({ clip, index }))
      .filter((x) => x.clip.sourceId === src.id);
    for (const gap of gapsOf(src, own.map((x) => x.clip))) {
      const endsAt = own.find((x) => x.clip.end === gap.start);
      if (endsAt) {
        after[endsAt.index]!.push(gap);
        continue;
      }
      const startsAt = own.find((x) => x.clip.start === gap.end);
      if (startsAt) {
        before[startsAt.index]!.push(gap);
        continue;
      }
      const earlier = own.filter((x) => x.clip.end <= gap.start).sort((a, b) => b.clip.end - a.clip.end)[0];
      if (earlier) {
        after[earlier.index]!.push(gap);
        continue;
      }
      const later = own.filter((x) => x.clip.start >= gap.end).sort((a, b) => a.clip.start - b.clip.start)[0];
      if (later) before[later.index]!.push(gap);
      else tail.push(gap);
    }
  }

  const segments: OverviewSegment[] = [];
  let at = 0;
  let seq = 0;
  const pushCut = (gaps: SourceRange[]) => {
    for (const g of [...gaps].sort((a, b) => a.start - b.start)) {
      segments.push({ kind: "cut", sourceId: g.sourceId, start: g.start, end: g.end, at, seqStart: seq });
      at += g.end - g.start;
    }
  };
  clips.forEach((clip, i) => {
    pushCut(before[i]!);
    if (clip.end > clip.start) {
      segments.push({ kind: "kept", sourceId: clip.sourceId, start: clip.start, end: clip.end, at, seqStart: seq });
      at += clip.end - clip.start;
      seq += clip.end - clip.start;
    }
    pushCut(after[i]!);
  });
  pushCut(tail);

  return {
    length: at,
    sequenceLength: seq,
    segments,
    suggestions: input.suggestions ?? [],
    transcribedTo: Object.fromEntries(sources.map((s) => [s.id, s.transcribedTo])),
  };
}

/** The stretches of `src` no clip covers, in source order. */
function gapsOf(src: OverviewSource, clips: readonly Clip[]): SourceRange[] {
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  const gaps: SourceRange[] = [];
  let t = 0;
  for (const c of sorted) {
    if (c.start > t) gaps.push({ sourceId: src.id, start: t, end: Math.min(c.start, src.end) });
    t = Math.max(t, c.end);
  }
  if (src.end > t) gaps.push({ sourceId: src.id, start: t, end: src.end });
  return gaps.filter((g) => g.end > g.start);
}

/** The segment at strip position `pos` (the last one at the very end); null for an empty strip. */
export function segmentAt(model: OverviewModel, pos: number): OverviewSegment | null {
  const segs = model.segments;
  if (segs.length === 0) return null;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid]!.at <= pos) lo = mid;
    else hi = mid - 1;
  }
  return segs[lo]!;
}

/** The sequence time a click at `fraction` (0 = left, 1 = right) of the strip goes to. Cut material goes to the cut it sits at. */
export function timeAtFraction(model: OverviewModel, fraction: number): SequenceTime {
  const pos = Math.max(0, Math.min(1, fraction)) * model.length;
  const seg = segmentAt(model, pos);
  if (!seg) return 0;
  const t = seg.kind === "kept" ? seg.seqStart + Math.min(pos - seg.at, seg.end - seg.start) : seg.seqStart;
  return Math.max(0, Math.min(model.sequenceLength, Math.round(t)));
}

/** Where sequence time `t` is on the strip, from 0 to 1 (0 for an empty strip). */
export function fractionOfTime(model: OverviewModel, t: SequenceTime): number {
  if (model.length <= 0) return 0;
  let lastKeptEnd: number | null = null;
  for (const seg of model.segments) {
    if (seg.kind !== "kept") continue;
    const len = seg.end - seg.start;
    if (t >= seg.seqStart && t < seg.seqStart + len) return (seg.at + (t - seg.seqStart)) / model.length;
    lastKeptEnd = seg.at + len;
  }
  if (lastKeptEnd !== null && t >= model.sequenceLength) return lastKeptEnd / model.length;
  return 0;
}

const inside = (ranges: readonly SourceRange[], sourceId: SourceId, t: Micros) =>
  ranges.some((r) => r.sourceId === sourceId && r.start <= t && t < r.end);

/**
 * The strip as `count` bars, left to right. Each bar takes its kind from the material at its
 * middle: cut, pending (not yet transcribed), suggested (in a pending suggestion) or kept. Its
 * level is the mean loudness over its stretch of that segment, or `fallback` when not known.
 */
export function overviewBars(model: OverviewModel, count: number, loudness?: Loudness, fallback = 0.45): OverviewBar[] {
  const bars: OverviewBar[] = [];
  if (count <= 0 || model.length <= 0) return bars;
  const step = model.length / count;
  for (let i = 0; i < count; i++) {
    const mid = (i + 0.5) * step;
    const seg = segmentAt(model, mid)!;
    const t = seg.start + (mid - seg.at);
    const from = Math.max(seg.start, seg.start + (i * step - seg.at));
    const to = Math.min(seg.end, seg.start + ((i + 1) * step - seg.at));
    const known = loudness ? loudness(seg.sourceId, from, Math.max(from + 1, to)) : null;
    const level = Math.max(0.06, Math.min(1, known ?? fallback));
    let kind: BarKind;
    if (seg.kind === "cut") kind = "cut";
    else if (t >= (model.transcribedTo[seg.sourceId] ?? Infinity)) kind = "pending";
    else if (inside(model.suggestions, seg.sourceId, t)) kind = "suggested";
    else kind = "kept";
    bars.push({ kind, level });
  }
  return bars;
}

/** Colours the strip is drawn with. */
export interface OverviewColors {
  ink: string;
  accent: string;
  pending: string;
}

/** The subset of the canvas 2D context the strip uses (a test can record the calls). */
export type StripContext = Pick<
  CanvasRenderingContext2D,
  "clearRect" | "fillRect" | "strokeRect" | "setTransform" | "fillStyle" | "strokeStyle" | "lineWidth"
>;

/** Bar geometry: one 2 px bar every 4 px, as in the mockup. */
export const BAR_PITCH = 4;
export const BAR_WIDTH = 2;

/**
 * Draws the bars in a `width` x `height` (CSS pixels) area: kept bars in ink, cut bars low and
 * in the accent, suggested bars outlined in the accent, pending bars in the pending grey.
 */
export function drawOverview(ctx: StripContext, bars: readonly OverviewBar[], width: number, height: number, colors: OverviewColors): void {
  ctx.clearRect(0, 0, width, height);
  bars.forEach((bar, i) => {
    const x = i * BAR_PITCH;
    const scale = bar.kind === "cut" ? 0.3 : 1;
    const h = Math.max(2, Math.round(bar.level * height * scale));
    const y = (height - h) / 2;
    if (bar.kind === "suggested") {
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, BAR_WIDTH - 1, Math.max(1, h - 1));
      return;
    }
    ctx.fillStyle = bar.kind === "cut" ? colors.accent : bar.kind === "pending" ? colors.pending : colors.ink;
    ctx.fillRect(x, y, BAR_WIDTH, h);
  });
}
