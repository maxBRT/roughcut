/**
 * The two placement rules of spec 3.5.1. Restored material and cut text go to the same
 * place, because both are decided by one function, `restoreTarget`: `restoreRanges` acts on
 * it and `cutPlacement` reports it.
 *
 * Known limit (the state keeps no memory of where cut material used to play): cutting a
 * range and restoring it gives back the same moments, but not always the same playing order.
 * - A whole clip that touched no other kept material of its source comes back after the
 *   nearest earlier clip of that source (the literal rule), not necessarily where it was.
 * - Material that touches two clips of its source that are not neighbours in the sequence
 *   joins the earlier one, whole: where the old boundary between them was cannot be known.
 * When each source's clips play in source order and the sources in project order, a cut then
 * restore always gives back the same playing order.
 */
import type { Clip, ClipId, EditState, Micros, SourceId, SourceRange } from "../types";
import type { EditContext, Resolved } from "./context";
import { resolve } from "./context";
import { snapRange } from "./queries";
import { keptSpans, sourceEnd, subtract } from "./spans";

/**
 * Internal: the sequence index where a new clip of `sourceId` starting at source time `a`
 * goes. After the nearest earlier clip of that source; with none, before that source's
 * earliest later clip; with no clip of that source at all, after the last clip of the
 * sources that come before it in project order (or first; or last for an unknown source).
 */
export function insertionIndex(clips: readonly Clip[], r: Resolved, sourceId: SourceId, a: Micros): number {
  let earlier = -1;
  let later = -1;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!;
    if (c.sourceId !== sourceId) continue;
    if (c.end <= a && (earlier < 0 || c.end > clips[earlier]!.end)) earlier = i;
    if (c.start >= a && (later < 0 || c.start < clips[later]!.start)) later = i;
  }
  if (earlier >= 0) return earlier + 1;
  if (later >= 0) return later;
  const mine = r.order.get(sourceId);
  if (mine === undefined) return clips.length;
  let at = 0;
  for (let i = 0; i < clips.length; i++) {
    const o = r.order.get(clips[i]!.sourceId);
    if (o !== undefined && o < mine) at = i + 1;
  }
  return at;
}

/**
 * Internal: what restoring the cut span `[a, b)` of `sourceId` does to `clips` (spec 3.5.1,
 * first rule). It joins the clip it touches in source time; touching an earlier clip and the
 * very next clip in the sequence, the two merge; touching two clips that are not neighbours,
 * it joins the earlier one; touching none, it becomes a new clip at `insertionIndex`.
 */
export type RestoreTarget =
  | { kind: "merge"; left: number; right: number }
  | { kind: "extendEnd"; index: number }
  | { kind: "extendStart"; index: number }
  | { kind: "insert"; index: number };

/** Internal: the one decision both `restoreRanges` and `cutPlacement` use. */
export function restoreTarget(clips: readonly Clip[], r: Resolved, sourceId: SourceId, a: Micros, b: Micros): RestoreTarget {
  let li = -1;
  let ri = -1;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!;
    if (c.sourceId !== sourceId) continue;
    if (c.end === a) li = i;
    if (c.start === b) ri = i;
  }
  if (li >= 0 && ri === li + 1) return { kind: "merge", left: li, right: ri };
  if (li >= 0) return { kind: "extendEnd", index: li };
  if (ri >= 0) return { kind: "extendStart", index: ri };
  return { kind: "insert", index: insertionIndex(clips, r, sourceId, a) };
}

/**
 * Where cut material is shown (and where restoring it would put it):
 * - `after`: at the end of that clip (sequence index `index`);
 * - `before`: at the start of that clip (sequence index `index`);
 * - `index`: no clip of the source borders it; it sits before the clip at `index` in the
 *   sequence (`index` may equal the clip count: after everything).
 */
export type CutPlacement =
  | { kind: "after"; clipId: ClipId; index: number }
  | { kind: "before"; clipId: ClipId; index: number }
  | { kind: "index"; index: number };

/**
 * Where the cut text for `range` sits in the sequence (spec 3.5.1, second rule): exactly
 * where `restoreRanges([range])` would put it. The range is snapped and limited to the source
 * as a restore would; when part of it is still kept, the first cut part decides.
 */
export function cutPlacement(state: EditState, ctx: EditContext, range: SourceRange): CutPlacement {
  const clips = state.clips;
  const r = resolve(ctx);
  const { sourceId } = range;
  const snapped = snapRange(range, r.rate);
  const end = sourceEnd(r, clips, sourceId);
  let a = Math.min(end, Math.max(0, snapped.start));
  let b = Math.max(a, Math.min(end, snapped.end));
  if (a < b) {
    const first = subtract([[a, b]], keptSpans(clips, sourceId))[0];
    if (first) [a, b] = first;
  }
  const target = restoreTarget(clips, r, sourceId, a, b);
  switch (target.kind) {
    case "merge":
      return { kind: "after", clipId: clips[target.left]!.id, index: target.left };
    case "extendEnd":
      return { kind: "after", clipId: clips[target.index]!.id, index: target.index };
    case "extendStart":
      return { kind: "before", clipId: clips[target.index]!.id, index: target.index };
    case "insert": {
      const index = target.index;
      const prev = clips[index - 1];
      if (prev && prev.sourceId === sourceId && prev.end <= a) return { kind: "after", clipId: prev.id, index: index - 1 };
      const next = clips[index];
      if (next && next.sourceId === sourceId && next.start >= b) return { kind: "before", clipId: next.id, index };
      return { kind: "index", index };
    }
  }
}
