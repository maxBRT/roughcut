/**
 * The edit commands of spec 3.5.1. Each takes the current `EditDocument`, the `EditContext`
 * and its arguments, and returns the next document. A successful command is exactly one
 * undo step and clears redo; a command that changes nothing (or names a clip that does not
 * exist) returns the very same document object.
 *
 * New clip ids are deterministic: `clip-<n>`, where n is one more than the highest such
 * number in the current clip list (ids of any other shape are left alone and never reused).
 */
import type { Clip, ClipId, EditDocument, EditState, Micros, SequenceTime, SourceId, SourceRange } from "../types";
import { firstClipEnd, frameToMicros, isOnFrameGrid, microsToFrameFloor, snapToFrame } from "../types";
import type { EditContext, Resolved } from "./context";
import { resolve } from "./context";
import { commit, redo, undo } from "./history";
import { restoreTarget } from "./placement";
import { clipAt, snapRange } from "./queries";
import type { Span } from "./spans";
import { keptSpans, sourceEnd, subtract } from "./spans";

/** Which edge of a clip. */
export type Edge = "start" | "end";
/** Which way a clip moves. */
export type Direction = "earlier" | "later";

// ---- helpers ----------------------------------------------------------------------------

/** Hands out fresh `clip-<n>` ids that are not in use in `clips`. */
function idSource(clips: readonly Clip[]): () => ClipId {
  let max = 0;
  const used = new Set<ClipId>();
  for (const c of clips) {
    used.add(c.id);
    const m = /^clip-(\d+)$/.exec(c.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max;
  return () => {
    let id: ClipId;
    do id = `clip-${++n}`;
    while (used.has(id));
    used.add(id);
    return id;
  };
}

/** The grid point one frame after the grid point `t`. */
function nextGrid(t: Micros, r: Resolved): Micros {
  return frameToMicros(microsToFrameFloor(t, r.rate) + 1, r.rate);
}

/** The grid point one frame before `t` (or the grid point at or before `t` when `t` is off grid). */
function prevGrid(t: Micros, r: Resolved): Micros {
  const k = microsToFrameFloor(t, r.rate);
  return isOnFrameGrid(t, r.rate) ? frameToMicros(k - 1, r.rate) : frameToMicros(k, r.rate);
}

/** Snaps every range to the grid, drops empty ones, and groups them by source, sorted and merged. */
function normalise(ranges: readonly SourceRange[], r: Resolved): Map<SourceId, Span[]> {
  const by = new Map<SourceId, Span[]>();
  for (const range of ranges) {
    const s = snapRange(range, r.rate);
    if (s.end <= s.start) continue;
    let list = by.get(s.sourceId);
    if (!list) by.set(s.sourceId, (list = []));
    list.push([s.start, s.end]);
  }
  for (const [id, list] of by) {
    list.sort((a, b) => a[0] - b[0]);
    const merged: Span[] = [];
    for (const span of list) {
      const last = merged[merged.length - 1];
      if (last && last[1] >= span[0]) last[1] = Math.max(last[1], span[1]);
      else merged.push([span[0], span[1]]);
    }
    by.set(id, merged);
  }
  return by;
}

function withClips(state: EditState, clips: Clip[]): EditState {
  return { clips, dismissed: state.dismissed };
}

/** The limits an edge may move between: stops at other kept material of the source, the source's ends, and one frame of clip. */
function edgeLimits(state: EditState, r: Resolved, clip: Clip, edge: Edge): Span {
  if (edge === "start") {
    let lower = 0;
    for (const c of state.clips) if (c !== clip && c.sourceId === clip.sourceId && c.end <= clip.start && c.end > lower) lower = c.end;
    return [Math.min(lower, clip.start), Math.max(clip.start, prevGrid(clip.end, r))];
  }
  let upper = Math.max(clip.end, sourceEnd(r, state.clips, clip.sourceId));
  for (const c of state.clips) if (c !== clip && c.sourceId === clip.sourceId && c.start >= clip.end && c.start < upper) upper = c.start;
  return [Math.min(clip.end, nextGrid(clip.start, r)), upper];
}

/** Moves one edge to the grid point `to`, within its limits. */
function moveEdge(doc: EditDocument, r: Resolved, clipId: ClipId, edge: Edge, to: (clip: Clip) => Micros): EditDocument {
  const state = doc.current;
  const index = state.clips.findIndex((c) => c.id === clipId);
  if (index < 0) return doc;
  const clip = state.clips[index]!;
  const [lo, hi] = edgeLimits(state, r, clip, edge);
  const pos = Math.min(hi, Math.max(lo, to(clip)));
  const next: Clip = edge === "start" ? { ...clip, start: pos } : { ...clip, end: pos };
  if (next.start === clip.start && next.end === clip.end) return doc;
  const clips = state.clips.slice();
  clips[index] = next;
  // Pulling an edge out is a restore (spec 1.8): when it closes the gap to its neighbour in
  // the sequence, continuous in the same source, the two merge as `restoreRanges` would
  // (the earlier clip keeps its id).
  if (edge === "end") {
    const after = clips[index + 1];
    if (after && after.sourceId === next.sourceId && after.start === next.end) {
      clips[index] = { ...next, end: after.end };
      clips.splice(index + 1, 1);
    }
  } else {
    const before = clips[index - 1];
    if (before && before.sourceId === next.sourceId && before.end === next.start) {
      clips[index - 1] = { ...before, end: next.end };
      clips.splice(index, 1);
    }
  }
  return commit(doc, withClips(state, clips));
}

// ---- commands -----------------------------------------------------------------------------

/**
 * Adds the whole source as one clip at the end of the sequence: `[0, duration floored to
 * the grid)`. If parts of the source are already in the sequence, only the parts that are
 * not are added, each as its own clip, in source order. A source shorter than one frame
 * adds nothing.
 */
export function appendSource(doc: EditDocument, ctx: EditContext, sourceId: SourceId, duration: Micros): EditDocument {
  const end = firstClipEnd(duration, ctx.frameRate);
  if (end === null) return doc;
  const state = doc.current;
  const pieces = subtract([[0, end]], keptSpans(state.clips, sourceId));
  if (pieces.length === 0) return doc;
  const newId = idSource(state.clips);
  const clips = state.clips.concat(pieces.map(([s, e]) => ({ id: newId(), sourceId, start: s, end: e })));
  return commit(doc, withClips(state, clips));
}

/**
 * Those moments leave the sequence. Each range's ends snap to the nearest frame boundary.
 * Clips are shortened, split (the first piece keeps the id) or removed as needed.
 */
export function cutRanges(doc: EditDocument, ctx: EditContext, ranges: readonly SourceRange[]): EditDocument {
  const r = resolve(ctx);
  const by = normalise(ranges, r);
  if (by.size === 0) return doc;
  const state = doc.current;
  const newId = idSource(state.clips);
  const clips: Clip[] = [];
  let changed = false;
  for (const clip of state.clips) {
    const spans = by.get(clip.sourceId);
    if (!spans) {
      clips.push(clip);
      continue;
    }
    // First span that ends after the clip starts.
    let lo = 0;
    let hi = spans.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (spans[mid]![1] <= clip.start) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= spans.length || spans[lo]![0] >= clip.end) {
      clips.push(clip);
      continue;
    }
    changed = true;
    let cursor = clip.start;
    let first = true;
    const piece = (s: Micros, e: Micros) => {
      clips.push({ id: first ? clip.id : newId(), sourceId: clip.sourceId, start: s, end: e });
      first = false;
    };
    for (let i = lo; i < spans.length && spans[i]![0] < clip.end; i++) {
      const [s, e] = spans[i]!;
      if (s > cursor) piece(cursor, s);
      cursor = Math.max(cursor, e);
    }
    if (cursor < clip.end) piece(cursor, clip.end);
  }
  return changed ? commit(doc, withClips(state, clips)) : doc;
}

/**
 * Those moments return to the sequence. Ranges snap to the grid and are limited to the
 * source. Placement (spec 3.5.1): restored material joins the clip it touches in source
 * time; when it closes the gap between two clips that are neighbours in the sequence (the
 * earlier one first), they merge. Otherwise, touching both, it joins the earlier one.
 * Touching none, it becomes a new clip after the nearest earlier clip of the same source;
 * with no earlier clip, before that source's earliest clip; with no clip of that source at
 * all, after the last clip of the sources before it in project order (or first). The
 * decision is `restoreTarget` in placement.ts, which `cutPlacement` also uses.
 *
 * Cutting a range then restoring it gives back the same moments, but the playing order can
 * differ when that source's clips are out of source order in the sequence (see the module
 * comment of placement.ts): the state does not remember where cut material used to play.
 */
export function restoreRanges(doc: EditDocument, ctx: EditContext, ranges: readonly SourceRange[]): EditDocument {
  const r = resolve(ctx);
  const by = normalise(ranges, r);
  if (by.size === 0) return doc;
  const state = doc.current;
  const clips = state.clips.slice();
  const newId = idSource(clips);
  let changed = false;
  for (const [sourceId, spans] of by) {
    const end = sourceEnd(r, clips, sourceId);
    const limited = spans.map(([s, e]): Span => [Math.max(0, s), Math.min(end, e)]).filter(([s, e]) => s < e);
    for (const [a, b] of subtract(limited, keptSpans(clips, sourceId))) {
      changed = true;
      const target = restoreTarget(clips, r, sourceId, a, b);
      switch (target.kind) {
        case "merge":
          clips[target.left] = { ...clips[target.left]!, end: clips[target.right]!.end };
          clips.splice(target.right, 1);
          break;
        case "extendEnd":
          clips[target.index] = { ...clips[target.index]!, end: b };
          break;
        case "extendStart":
          clips[target.index] = { ...clips[target.index]!, start: a };
          break;
        case "insert":
          clips.splice(target.index, 0, { id: newId(), sourceId, start: a, end: b });
          break;
      }
    }
  }
  return changed ? commit(doc, withClips(state, clips)) : doc;
}

/**
 * Moves one edge of a clip to `to` (snapped to the nearest frame boundary), either way. It
 * stops at the next kept material of the same source, at the source's start or end, and
 * one frame short of emptying the clip. An edge pulled out until it meets its neighbour in
 * the sequence (same source, continuous in source time) merges the two clips, the earlier
 * one keeping its id, exactly as restoring that gap would.
 */
export function trimEdge(doc: EditDocument, ctx: EditContext, clipId: ClipId, edge: Edge, to: Micros): EditDocument {
  const r = resolve(ctx);
  const target = snapToFrame(Math.round(to), r.rate);
  return moveEdge(doc, r, clipId, edge, () => target);
}

/** Moves one edge by a whole number of frames (negative is earlier), with the limits of `trimEdge`. */
export function nudgeEdge(doc: EditDocument, ctx: EditContext, clipId: ClipId, edge: Edge, frames: number): EditDocument {
  const r = resolve(ctx);
  const step = Math.trunc(frames);
  if (step === 0) return doc;
  return moveEdge(doc, r, clipId, edge, (clip) => {
    const k = microsToFrameFloor(edge === "start" ? clip.start : clip.end, r.rate) + step;
    return frameToMicros(k, r.rate);
  });
}

/**
 * The clip under sequence time `t` becomes two at the frame boundary nearest that moment.
 * The first part keeps the id. Nothing happens when the boundary is one of the clip's edges.
 */
export function splitAt(doc: EditDocument, ctx: EditContext, t: SequenceTime): EditDocument {
  const state = doc.current;
  const placed = clipAt(state, t);
  if (!placed) return doc;
  const { clip, index } = placed;
  const at = snapToFrame(Math.round(clip.start + (t - placed.sequenceStart)), ctx.frameRate);
  if (at <= clip.start || at >= clip.end) return doc;
  const clips = state.clips.slice();
  clips.splice(index, 1, { ...clip, end: at }, { id: idSource(state.clips)(), sourceId: clip.sourceId, start: at, end: clip.end });
  return commit(doc, withClips(state, clips));
}

/** The clip leaves the sequence. */
export function removeClip(doc: EditDocument, _ctx: EditContext, clipId: ClipId): EditDocument {
  const state = doc.current;
  const index = state.clips.findIndex((c) => c.id === clipId);
  if (index < 0) return doc;
  const clips = state.clips.slice();
  clips.splice(index, 1);
  return commit(doc, withClips(state, clips));
}

/** The clip swaps places with its neighbour on that side; nothing happens at either end of the sequence. */
export function moveClip(doc: EditDocument, _ctx: EditContext, clipId: ClipId, direction: Direction): EditDocument {
  const state = doc.current;
  const index = state.clips.findIndex((c) => c.id === clipId);
  const other = direction === "earlier" ? index - 1 : index + 1;
  if (index < 0 || other < 0 || other >= state.clips.length) return doc;
  const clips = state.clips.slice();
  clips[index] = state.clips[other]!;
  clips[other] = state.clips[index]!;
  return commit(doc, withClips(state, clips));
}

/** The range (exactly as given) is added to `dismissed`; nothing happens if it is already there. */
export function dismissSuggestion(doc: EditDocument, _ctx: EditContext, range: SourceRange): EditDocument {
  const state = doc.current;
  if (state.dismissed.some((d) => d.sourceId === range.sourceId && d.start === range.start && d.end === range.end)) return doc;
  const entry: SourceRange = { sourceId: range.sourceId, start: range.start, end: range.end };
  return commit(doc, { clips: state.clips, dismissed: [...state.dismissed, entry] });
}

/** Every edit command as data, for dispatching from actions and for generated tests. */
export type EditCommand =
  | { type: "appendSource"; sourceId: SourceId; duration: Micros }
  | { type: "cutRanges"; ranges: readonly SourceRange[] }
  | { type: "restoreRanges"; ranges: readonly SourceRange[] }
  | { type: "trimEdge"; clipId: ClipId; edge: Edge; to: Micros }
  | { type: "nudgeEdge"; clipId: ClipId; edge: Edge; frames: number }
  | { type: "splitAt"; at: SequenceTime }
  | { type: "removeClip"; clipId: ClipId }
  | { type: "moveClip"; clipId: ClipId; direction: Direction }
  | { type: "dismissSuggestion"; range: SourceRange }
  | { type: "undo" }
  | { type: "redo" };

/** Applies one command; returns `doc` itself when the command changes nothing. */
export function applyEditCommand(doc: EditDocument, ctx: EditContext, cmd: EditCommand): EditDocument {
  switch (cmd.type) {
    case "appendSource":
      return appendSource(doc, ctx, cmd.sourceId, cmd.duration);
    case "cutRanges":
      return cutRanges(doc, ctx, cmd.ranges);
    case "restoreRanges":
      return restoreRanges(doc, ctx, cmd.ranges);
    case "trimEdge":
      return trimEdge(doc, ctx, cmd.clipId, cmd.edge, cmd.to);
    case "nudgeEdge":
      return nudgeEdge(doc, ctx, cmd.clipId, cmd.edge, cmd.frames);
    case "splitAt":
      return splitAt(doc, ctx, cmd.at);
    case "removeClip":
      return removeClip(doc, ctx, cmd.clipId);
    case "moveClip":
      return moveClip(doc, ctx, cmd.clipId, cmd.direction);
    case "dismissSuggestion":
      return dismissSuggestion(doc, ctx, cmd.range);
    case "undo":
      return undo(doc);
    case "redo":
      return redo(doc);
  }
}
