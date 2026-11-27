/**
 * Stranded silence: the short, speech-free pieces of clip a cut leaves behind.
 *
 * Found in the real app: accepting a dead-air suggestion leaves 0.35 s of silence on each
 * side of the pause. When the speech next to that pause is cut later (deleting the sentence,
 * accepting a retake or an aside), the margin stays on its own: a ~0.2 s clip of room noise
 * between two cuts. On the timeline it is a blip; in the text it only shows as a long pause
 * chip marked partial, so it looked like there was nothing left to delete. A cut made from
 * the text should not leave such pieces, so they are cut with it, in the same undo step.
 */
import type { Clip, EditState, Micros, SourceRange } from "../types";
import type { TranscriptLayout } from "./layout";
import { firstAfter } from "./sourceIndex";

/** The longest piece of silence that counts as stranded: anything longer is a pause someone may want. */
export const STRANDED_SILENCE_MAX: Micros = 1_000_000;

function sameClip(a: Clip, b: Clip): boolean {
  return a.id === b.id && a.sourceId === b.sourceId && a.start === b.start && a.end === b.end;
}

/**
 * The clips of `after` that the edit from `before` made (new or with a moved edge), that are
 * shorter than {@link STRANDED_SILENCE_MAX} and hold no speech: no word or unrecognised
 * speech plays in them (a sliver under a frame, from snapping to the grid, does not count).
 * Only transcribed material counts as silence; a piece the transcript does not reach yet is
 * never returned. Clips the edit did not touch are left alone, however short.
 */
export function strandedSilence(layout: TranscriptLayout, before: EditState, after: EditState): SourceRange[] {
  const rate = layout.input.frameRate;
  const frame = rate.num > 0 ? (1_000_000 * rate.den) / rate.num : 0;
  const old = new Map<string, Clip>();
  for (const c of before.clips) old.set(c.id, c);
  const out: SourceRange[] = [];
  for (const c of after.clips) {
    const prev = old.get(c.id);
    if (prev && sameClip(prev, c)) continue;
    if (c.end - c.start >= STRANDED_SILENCE_MAX) continue;
    const src = layout.internals.byId.get(c.sourceId);
    const index = src?.index;
    if (!src || !index) continue;
    if (!src.complete && c.end > index.extent) continue;
    let speech = 0;
    // Tokens are in time order and do not overlap, so their ends are sorted.
    for (let f = firstAfter(index.end, c.start, index.count); f < index.count && index.start[f]! < c.end; f++) {
      if (index.tokens[f]!.kind === "pause") continue;
      speech += Math.max(0, Math.min(c.end, index.end[f]!) - Math.max(c.start, index.start[f]!));
    }
    if (speech >= frame) continue;
    out.push({ sourceId: c.sourceId, start: c.start, end: c.end });
  }
  return out;
}
