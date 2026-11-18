/**
 * Checks an edit state against the rules of spec 3.4 ("Rules the data always obeys") and
 * reports every violation. Used by the tests and by the app in development.
 */
import type { ClipId, EditState } from "../types";
import { isOnFrameGrid } from "../types";
import type { EditContext } from "./context";
import { resolve } from "./context";

/** One broken rule. */
export interface Violation {
  /** `empty` and `off_grid` are rule 1, `overlap` is rule 2; the rest are integrity checks. */
  rule: "empty" | "off_grid" | "overlap" | "duplicate_id" | "out_of_source" | "unknown_source" | "bad_dismissed";
  clipId?: ClipId;
  message: string;
}

/** Every violation in `state`; an empty list means the state is sound. */
export function validateEditState(state: EditState, ctx: EditContext): Violation[] {
  const r = resolve(ctx);
  const out: Violation[] = [];
  const ids = new Set<ClipId>();
  const bySource = new Map<string, { id: ClipId; start: number; end: number }[]>();
  for (const c of state.clips) {
    if (ids.has(c.id)) out.push({ rule: "duplicate_id", clipId: c.id, message: `clip id ${c.id} is used more than once` });
    ids.add(c.id);
    if (!(c.end > c.start)) out.push({ rule: "empty", clipId: c.id, message: `clip ${c.id} is empty: [${c.start}, ${c.end})` });
    for (const t of [c.start, c.end]) {
      if (!Number.isSafeInteger(t) || !isOnFrameGrid(t, r.rate)) {
        out.push({ rule: "off_grid", clipId: c.id, message: `clip ${c.id} has an edge off the frame grid: ${t}` });
      }
    }
    const end = r.ends.get(c.sourceId);
    if (end === undefined) {
      if (ctx.sources.length > 0) out.push({ rule: "unknown_source", clipId: c.id, message: `clip ${c.id} uses unknown source ${c.sourceId}` });
    } else if (c.start < 0 || c.end > end) {
      out.push({ rule: "out_of_source", clipId: c.id, message: `clip ${c.id} [${c.start}, ${c.end}) runs outside its source [0, ${end})` });
    }
    let list = bySource.get(c.sourceId);
    if (!list) bySource.set(c.sourceId, (list = []));
    list.push({ id: c.id, start: c.start, end: c.end });
  }
  for (const [sourceId, list] of bySource) {
    list.sort((a, b) => a.start - b.start);
    let reach = list[0]!;
    for (let i = 1; i < list.length; i++) {
      const b = list[i]!;
      if (b.start < reach.end) {
        out.push({ rule: "overlap", clipId: b.id, message: `clips ${reach.id} and ${b.id} both hold part of ${sourceId} at ${b.start}` });
      }
      if (b.end > reach.end) reach = b;
    }
  }
  for (const d of state.dismissed) {
    if (!(d.end > d.start)) out.push({ rule: "bad_dismissed", message: `dismissed range of ${d.sourceId} is empty: [${d.start}, ${d.end})` });
  }
  return out;
}
