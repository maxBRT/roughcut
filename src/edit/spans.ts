/**
 * Internal: small helpers on spans of source time, shared by the commands and the placement
 * rules. Not part of the public surface.
 */
import type { Clip, Micros, SourceId } from "../types";
import type { Resolved } from "./context";

/** A half-open span `[start, end)` of source time. */
export type Span = [start: Micros, end: Micros];

/** The end of a source on the grid; for a source the context does not know, its furthest kept moment. */
export function sourceEnd(r: Resolved, clips: readonly Clip[], sourceId: SourceId): Micros {
  const known = r.ends.get(sourceId);
  if (known !== undefined) return known;
  let end = 0;
  for (const c of clips) if (c.sourceId === sourceId && c.end > end) end = c.end;
  return end;
}

/** Parts of `spans` (sorted, disjoint) not covered by `covered` (sorted, disjoint). */
export function subtract(spans: readonly Span[], covered: readonly Span[]): Span[] {
  const out: Span[] = [];
  let j = 0;
  for (const [s, e] of spans) {
    let cursor = s;
    while (j < covered.length && covered[j]![1] <= cursor) j++;
    let k = j;
    while (k < covered.length && covered[k]![0] < e) {
      const [cs, ce] = covered[k]!;
      if (cs > cursor) out.push([cursor, cs]);
      cursor = Math.max(cursor, ce);
      k++;
    }
    if (cursor < e) out.push([cursor, e]);
  }
  return out;
}

/** The kept spans of one source, sorted. */
export function keptSpans(clips: readonly Clip[], sourceId: SourceId): Span[] {
  const spans: Span[] = [];
  for (const c of clips) if (c.sourceId === sourceId) spans.push([c.start, c.end]);
  spans.sort((a, b) => a[0] - b[0]);
  return spans;
}
