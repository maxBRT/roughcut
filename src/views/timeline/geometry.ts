/**
 * Pure geometry of the Timeline track (spec 1.7 D, 1.8 "On the timeline"): where each clip sits
 * in sequence time, how sequence time maps to pixels at a zoom and scroll position, what the
 * pointer is over, and the time formats the view prints. No DOM, no store.
 */
import type { Clip, Micros, Rational, SequenceTime } from "../../types";
import { firstClipEnd, frameToMicros, microsToFrameFloor, snapToFrame } from "../../types";

// ---- vertical layout of the canvas, in CSS pixels (the mockup's .tl-in: 22px ruler, 8px gap, 92px track) ----

export const RULER_H = 22;
export const TRACK_TOP = RULER_H + 8;
export const TRACK_H = 92;
export const TRACK_BOTTOM = TRACK_TOP + TRACK_H;
/** The thin scroll bar under the track (shown when zoomed in). */
export const SCROLL_TOP = TRACK_BOTTOM + 6;
export const SCROLL_H = 4;
export const CANVAS_H = SCROLL_TOP + SCROLL_H + 2;
/** How close (px) the pointer must be to a clip edge to grab it. */
export const EDGE_GRAB_PX = 6;

// ---- the clips placed end to end ----

/** The clips in playing order with their sequence starts (`starts[i]`), `starts[n]` = length. */
export interface TrackLayout {
  clips: readonly Clip[];
  starts: Float64Array;
  duration: Micros;
}

/** Places the clips end to end (one track, never a gap). */
export function layoutClips(clips: readonly Clip[]): TrackLayout {
  const starts = new Float64Array(clips.length + 1);
  let t = 0;
  for (let i = 0; i < clips.length; i++) {
    starts[i] = t;
    const c = clips[i]!;
    t += c.end - c.start;
  }
  starts[clips.length] = t;
  return { clips, starts, duration: t };
}

/** Index of the clip playing at `t` (the last clip at or past the end); -1 when there are no clips. */
export function clipIndexAt(layout: TrackLayout, t: SequenceTime): number {
  const n = layout.clips.length;
  if (n === 0) return -1;
  if (t <= 0) return 0;
  if (t >= layout.duration) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (layout.starts[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The first clip whose end is after `t` (for drawing only what is on screen). */
export function firstClipEndingAfter(layout: TrackLayout, t: SequenceTime): number {
  let lo = 0;
  let hi = layout.clips.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (layout.starts[mid + 1]! > t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// ---- time to pixels ----

/** What part of the sequence is on screen: zoom 1 shows all of it in `width` pixels. */
export interface Viewport {
  /** Drawable width in CSS pixels. */
  width: number;
  zoom: number;
  /** Sequence time at the left edge. */
  start: SequenceTime;
  /** Length of the whole sequence. */
  duration: Micros;
}

/** Pixels per microsecond (0 for an empty sequence). */
export function pxPerMicro(vp: Viewport): number {
  return vp.duration > 0 && vp.width > 0 ? (vp.width * vp.zoom) / vp.duration : 0;
}

/** How much sequence time is on screen. */
export function visibleSpan(vp: Viewport): Micros {
  return vp.duration / Math.max(1, vp.zoom);
}

export function timeToX(vp: Viewport, t: SequenceTime): number {
  return (t - vp.start) * pxPerMicro(vp);
}

export function xToTime(vp: Viewport, x: number): SequenceTime {
  const s = pxPerMicro(vp);
  return s > 0 ? vp.start + x / s : 0;
}

/** Keeps the left edge between 0 and the point where the end of the sequence meets the right edge. */
export function clampStart(vp: Viewport, start: SequenceTime): SequenceTime {
  const max = Math.max(0, vp.duration - visibleSpan(vp));
  return Math.max(0, Math.min(max, start));
}

/**
 * The left edge after a zoom change, keeping sequence time `anchorTime` under pixel `anchorX`
 * (the mouse for the wheel; the playhead for the keys).
 */
export function zoomAround(vp: Viewport, newZoom: number, anchorTime: SequenceTime, anchorX: number): SequenceTime {
  const next: Viewport = { ...vp, zoom: newZoom };
  const s = pxPerMicro(next);
  return clampStart(next, s > 0 ? anchorTime - anchorX / s : 0);
}

/** What the view remembers between draws to decide how to scroll. */
export interface ScrollMemory {
  start: SequenceTime;
  zoom: number;
  duration: Micros;
  width: number;
  playhead: SequenceTime;
  /** Set by the wheel: keep this time under this pixel when the zoom changes next. */
  anchor: { time: SequenceTime; x: number } | null;
}

/** A fresh memory (everything fitted, nothing drawn yet). */
export function initialScroll(): ScrollMemory {
  return { start: 0, zoom: 1, duration: 0, width: 0, playhead: -1, anchor: null };
}

/**
 * Brings the scroll position up to date with the store: a zoom change keeps the wheel's anchor
 * (or the playhead) in place; a playhead that moved off screen is brought back (paged ahead
 * while playing, centred otherwise). A scroll the user made stays until the playhead moves.
 */
export function syncScroll(
  mem: ScrollMemory,
  next: { zoom: number; duration: Micros; width: number; playhead: SequenceTime; playing: boolean },
): ScrollMemory {
  const vp: Viewport = { width: next.width, zoom: next.zoom, duration: next.duration, start: mem.start };
  let start = mem.start;
  if (next.zoom <= 1) start = 0;
  else if (next.zoom !== mem.zoom && mem.duration > 0 && mem.width > 0) {
    const before: Viewport = { width: mem.width, zoom: mem.zoom, duration: mem.duration, start: mem.start };
    if (mem.anchor) start = zoomAround(vp, next.zoom, mem.anchor.time, mem.anchor.x);
    else {
      const px = timeToX(before, next.playhead);
      const onScreen = px >= 0 && px <= before.width;
      start = zoomAround(vp, next.zoom, next.playhead, onScreen ? px : next.width / 2);
    }
  }
  vp.start = clampStart(vp, start);
  const moved = next.playhead !== mem.playhead;
  // The wheel zooms where the mouse is, even away from the playhead; anything else keeps it in view.
  if (next.zoom > 1 && (moved || (next.zoom !== mem.zoom && !mem.anchor))) {
    const span = visibleSpan(vp);
    const margin = Math.min(span * 0.02, 8 / Math.max(pxPerMicro(vp), 1e-12));
    if (next.playhead < vp.start + (next.playing ? 0 : margin) || next.playhead > vp.start + span - margin) {
      vp.start = clampStart(vp, next.playing ? next.playhead - span * 0.1 : next.playhead - span / 2);
    }
  }
  return { start: vp.start, zoom: next.zoom, duration: next.duration, width: next.width, playhead: next.playhead, anchor: null };
}

// ---- the ruler ----

const TICK_STEPS_S = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];

/** The ruler's label spacing: the smallest step at least `minPx` wide. */
export function tickStep(vp: Viewport, minPx = 72): Micros {
  const pxPerSecond = pxPerMicro(vp) * 1_000_000;
  for (const s of TICK_STEPS_S) if (s * pxPerSecond >= minPx) return s * 1_000_000;
  return TICK_STEPS_S[TICK_STEPS_S.length - 1]! * 1_000_000;
}

/** The ruler's labelled times on screen. */
export function ticks(vp: Viewport, minPx = 72): { step: Micros; times: SequenceTime[] } {
  const step = tickStep(vp, minPx);
  const times: SequenceTime[] = [];
  if (pxPerMicro(vp) <= 0) return { step, times: [0] };
  const end = vp.start + visibleSpan(vp);
  for (let k = Math.floor(vp.start / step); k * step <= end && times.length < 1000; k++) {
    if (k * step >= vp.start - step) times.push(k * step);
  }
  return { step, times };
}

/**
 * A time as the app prints it: "0:27.4", "41:12", "1:02:03". Tenths are floored (a playhead
 * at 27.49 s reads 0:27.4) and shown when `tenths` is true.
 */
export function formatTime(t: Micros, tenths = true): string {
  const neg = t < 0;
  // Tenths of a second, ignoring the up to 1 µs per cut that sequence times drift below the
  // frame grid (1:20.0 can arrive as 79 999 999 µs after a cut).
  const total = Math.floor((Math.abs(t) + 500) / 100_000);
  const tenth = total % 10;
  const secs = Math.floor(total / 10);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const ss = String(s).padStart(2, "0");
  const body = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  return (neg ? "-" : "") + (tenths ? `${body}.${tenth}` : body);
}

// ---- what the pointer is over ----

export type Hit =
  | { kind: "ruler" }
  | { kind: "scrollbar" }
  | { kind: "edge"; index: number; edge: "start" | "end" }
  | { kind: "clip"; index: number }
  | { kind: "track" };

/** What is under canvas point (x, y). Edges win over the clip body within `EDGE_GRAB_PX` (less on tiny clips). */
export function hitTest(layout: TrackLayout, vp: Viewport, x: number, y: number, scrollbar: boolean): Hit {
  if (y < TRACK_TOP - 4) return { kind: "ruler" };
  if (scrollbar && y >= SCROLL_TOP - 2) return { kind: "scrollbar" };
  const n = layout.clips.length;
  if (n === 0 || y > TRACK_BOTTOM + 2) return { kind: "track" };
  const endX = timeToX(vp, layout.duration);
  if (x >= endX) {
    return x - endX <= EDGE_GRAB_PX ? { kind: "edge", index: n - 1, edge: "end" } : { kind: "track" };
  }
  const startX = timeToX(vp, 0);
  if (x < startX) {
    return startX - x <= EDGE_GRAB_PX ? { kind: "edge", index: 0, edge: "start" } : { kind: "track" };
  }
  const i = clipIndexAt(layout, xToTime(vp, x));
  const x0 = timeToX(vp, layout.starts[i]!);
  const x1 = timeToX(vp, layout.starts[i + 1]!);
  const grab = Math.min(EDGE_GRAB_PX, (x1 - x0) / 3);
  if (x - x0 <= grab) return { kind: "edge", index: i, edge: "start" };
  if (x1 - x <= grab) return { kind: "edge", index: i, edge: "end" };
  return { kind: "clip", index: i };
}

/** The boundary (0 = before the first clip, n = after the last) nearest to pixel `x`. */
export function nearestGap(layout: TrackLayout, vp: Viewport, x: number): number {
  const n = layout.clips.length;
  if (n === 0) return 0;
  const t = xToTime(vp, x);
  if (t <= 0) return 0;
  if (t >= layout.duration) return n;
  const i = clipIndexAt(layout, t);
  const mid = (layout.starts[i]! + layout.starts[i + 1]!) / 2;
  return t < mid ? i : i + 1;
}

/** Where a clip dragged from `from` and dropped at boundary `gap` ends up (its new index). */
export function dropIndex(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap;
}

/**
 * The source time an edge dragged by `dt` microseconds goes to: on the frame grid, at least one
 * frame long, inside the source. Kept material beyond it is the store's business (`trimEdge`).
 */
export function trimTarget(clip: Clip, edge: "start" | "end", dt: Micros, rate: Rational, sourceDuration: Micros): Micros {
  if (edge === "start") {
    const latest = frameToMicros(microsToFrameFloor(clip.end, rate) - 1, rate);
    return Math.max(0, Math.min(latest, snapToFrame(Math.round(Math.max(0, clip.start + dt)), rate)));
  }
  const earliest = frameToMicros(microsToFrameFloor(clip.start, rate) + 1, rate);
  const last = Math.max(firstClipEnd(sourceDuration, rate) ?? clip.end, clip.end);
  return Math.max(earliest, Math.min(last, snapToFrame(Math.round(Math.max(0, clip.end + dt)), rate)));
}

/** The clip list with one edge moved (the drag preview). */
export function withEdge(clips: readonly Clip[], index: number, edge: "start" | "end", to: Micros): Clip[] {
  return clips.map((c, i) => (i !== index ? c : edge === "start" ? { ...c, start: to } : { ...c, end: to }));
}
