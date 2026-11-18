/**
 * Caret and selection in the Transcript view, and turning them (or an `I` / `O` mark) into
 * source ranges for `cutRanges` / `restoreRanges` (spec 1.8, 3.6 "Cutting by deleting text").
 *
 * A caret is a boundary between tokens in document order: 0 is before the first visible
 * token, `layout.tokens.length` after the last. A selection is an anchor and a focus
 * boundary; the tokens selected are those between them, so a selection is always whole
 * tokens. Boundaries shift when the layout changes (for example when cut text is hidden):
 * keep an `AnchoredSelection` (token addresses) across layouts and resolve it again.
 */
import { sequenceTimeOf } from "../edit";
import type { EditState, Micros, SequenceTime, SourceId, SourcePosition, SourceRange } from "../types";
import type { SourceData, TranscriptLayout } from "./layout";
import { boundaryOf } from "./layout";
import type { TokenAddress } from "./sourceIndex";
import { firstAtOrAfter, lastAtOrBefore } from "./sourceIndex";

/** A caret (anchor === focus) or a selection of the tokens between two boundaries. */
export interface TextSelection {
  readonly anchor: number;
  readonly focus: number;
}

/** A selection held by token addresses, which survive layout changes. `null` = end of document. */
export interface AnchoredSelection {
  readonly anchor: TokenAddress | null;
  readonly focus: TokenAddress | null;
}

/** Ways the caret moves. */
export type CaretMotion =
  | "tokenPrev"
  | "tokenNext"
  | "sentencePrev"
  | "sentenceNext"
  | "paragraphPrev"
  | "paragraphNext"
  | "lineUp"
  | "lineDown"
  | "lineStart"
  | "lineEnd"
  | "documentStart"
  | "documentEnd";

/**
 * Visual lines depend on rendering, so the view supplies them. Each takes a caret boundary
 * and returns the boundary to move to.
 */
export interface VisualLines {
  lineUp(boundary: number): number;
  lineDown(boundary: number): number;
  lineStart(boundary: number): number;
  lineEnd(boundary: number): number;
}

/** Options for `moveCaret`. */
export interface MoveOptions {
  /** Shift held: move the focus only, keeping the anchor. */
  extend?: boolean;
  /** Needed for the line motions; without it they fall back to paragraph motions. */
  lines?: VisualLines;
}

function clamp(layout: TranscriptLayout, b: number): number {
  const n = layout.tokens.length;
  if (!Number.isFinite(b)) return b > 0 ? n : 0;
  return Math.max(0, Math.min(n, Math.round(b)));
}

/** A collapsed caret at a boundary (clamped to the document). */
export function caretAt(layout: TranscriptLayout, boundary: number): TextSelection {
  const b = clamp(layout, boundary);
  return { anchor: b, focus: b };
}

/** The selection limited to the document's boundaries. */
export function clampSelection(layout: TranscriptLayout, sel: TextSelection): TextSelection {
  return { anchor: clamp(layout, sel.anchor), focus: clamp(layout, sel.focus) };
}

/** Whether nothing is selected. */
export function isCollapsed(sel: TextSelection): boolean {
  return sel.anchor === sel.focus;
}

/** The selected tokens as a half-open range of document positions `[from, to)`. */
export function selectedSpan(sel: TextSelection): { from: number; to: number } {
  return { from: Math.min(sel.anchor, sel.focus), to: Math.max(sel.anchor, sel.focus) };
}

/**
 * Snaps a pointer selection to whole tokens: selects every token from the one at position
 * `anchorToken` to the one at `focusToken`, both included, keeping the direction.
 */
export function selectTokens(layout: TranscriptLayout, anchorToken: number, focusToken: number): TextSelection {
  const last = layout.tokens.length - 1;
  if (last < 0) return { anchor: 0, focus: 0 };
  const a = Math.max(0, Math.min(last, Math.round(anchorToken)));
  const f = Math.max(0, Math.min(last, Math.round(focusToken)));
  return f >= a ? { anchor: a, focus: f + 1 } : { anchor: a + 1, focus: f };
}

/** The first entry of a sorted array greater than `b`, or `fallback`. */
function nextIn(arr: Int32Array, b: number, fallback: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! <= b) lo = mid + 1;
    else hi = mid;
  }
  return lo < arr.length ? arr[lo]! : fallback;
}

/** The last entry of a sorted array less than `b`, or `fallback`. */
function prevIn(arr: Int32Array, b: number, fallback: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < b) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? arr[lo - 1]! : fallback;
}

/** The end of the paragraph containing boundary `b`: the next paragraph start after it, or the document end. */
function paragraphEnd(layout: TranscriptLayout, b: number): number {
  return nextIn(layout.internals.paragraphStarts, b, layout.tokens.length);
}

/** The start of the paragraph containing the token at `b` (or the one before the end). */
function paragraphStart(layout: TranscriptLayout, b: number): number {
  return prevIn(layout.internals.paragraphStarts, b + 1, 0);
}

/** Where a motion takes boundary `b`. */
function target(layout: TranscriptLayout, b: number, motion: CaretMotion, lines: VisualLines | undefined): number {
  const n = layout.tokens.length;
  const { paragraphStarts, sentenceStarts } = layout.internals;
  switch (motion) {
    case "tokenPrev":
      return b - 1;
    case "tokenNext":
      return b + 1;
    case "sentencePrev":
      return prevIn(sentenceStarts, b, 0);
    case "sentenceNext":
      return nextIn(sentenceStarts, b, n);
    case "paragraphPrev":
      return prevIn(paragraphStarts, b, 0);
    case "paragraphNext":
      return nextIn(paragraphStarts, b, n);
    case "lineUp":
      return lines ? lines.lineUp(b) : prevIn(paragraphStarts, b, 0);
    case "lineDown":
      return lines ? lines.lineDown(b) : nextIn(paragraphStarts, b, n);
    case "lineStart":
      return lines ? lines.lineStart(b) : paragraphStart(layout, Math.min(b, n - 1));
    case "lineEnd":
      return lines ? lines.lineEnd(b) : paragraphEnd(layout, b);
    case "documentStart":
      return 0;
    case "documentEnd":
      return n;
  }
}

/**
 * Moves the caret. With `extend`, only the focus moves. Without it, a token motion on a
 * selection collapses it to its start (`tokenPrev`) or end (`tokenNext`), as text editors do.
 */
export function moveCaret(layout: TranscriptLayout, sel: TextSelection, motion: CaretMotion, options: MoveOptions = {}): TextSelection {
  const s = clampSelection(layout, sel);
  if (!options.extend && s.anchor !== s.focus && (motion === "tokenPrev" || motion === "tokenNext")) {
    const { from, to } = selectedSpan(s);
    return caretAt(layout, motion === "tokenPrev" ? from : to);
  }
  const to = clamp(layout, target(layout, s.focus, motion, options.lines));
  return options.extend ? { anchor: s.anchor, focus: to } : { anchor: to, focus: to };
}

/** Selects the whole document. */
export function selectAll(layout: TranscriptLayout): TextSelection {
  return { anchor: 0, focus: layout.tokens.length };
}

/** A selection as token addresses, to keep across layouts. */
export function anchorSelection(layout: TranscriptLayout, sel: TextSelection): AnchoredSelection {
  const s = clampSelection(layout, sel);
  return { anchor: layout.tokens[s.anchor]?.address ?? null, focus: layout.tokens[s.focus]?.address ?? null };
}

/**
 * An anchored selection in this layout. A token that is now hidden resolves to the boundary
 * where it would be; an unknown one to the end of the document.
 */
export function resolveSelection(layout: TranscriptLayout, anchored: AnchoredSelection): TextSelection {
  const at = (a: TokenAddress | null) => {
    if (a === null) return layout.tokens.length;
    const b = boundaryOf(layout, a);
    return b < 0 ? layout.tokens.length : b;
  };
  return { anchor: at(anchored.anchor), focus: at(anchored.focus) };
}

// ---- selections to source ranges ---------------------------------------------------

/**
 * Where a cut after flat token `f` ends: the next token's cut point, or the end of the source
 * for the last token (for a transcript still in progress, the last token's end, since its
 * next cut point is not known yet).
 */
function cutAfter(src: SourceData, f: number): Micros {
  const index = src.index!;
  if (f + 1 < index.count) return index.cutBefore[f + 1]!;
  if (src.complete) return Math.max(src.sourceEnd, index.end[f]!);
  return index.end[f]!;
}

/**
 * Where a cut before flat token `f` starts: its cut point, or the start of the source for the
 * first token, so the silence before the first word belongs to it the way the silence after
 * the last word belongs to the last one (cutting every token then leaves nothing kept).
 */
function cutBeforeOf(src: SourceData, f: number): Micros {
  const index = src.index!;
  return f === 0 ? Math.min(0, index.cutBefore[0]!) : index.cutBefore[f]!;
}

/** Sorts ranges by source (project order) and start, and joins overlapping or touching ones. */
function mergeRanges(layout: TranscriptLayout, ranges: SourceRange[]): SourceRange[] {
  const order = (id: SourceId) => layout.internals.byId.get(id)?.order ?? Number.MAX_SAFE_INTEGER;
  ranges.sort((a, b) => order(a.sourceId) - order(b.sourceId) || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0) || a.start - b.start);
  const out: SourceRange[] = [];
  for (const r of ranges) {
    if (r.end <= r.start) continue;
    const last = out[out.length - 1];
    if (last && last.sourceId === r.sourceId && last.end >= r.start) {
      if (r.end > last.end) out[out.length - 1] = { ...last, end: r.end };
    } else out.push({ sourceId: r.sourceId, start: r.start, end: r.end });
  }
  return out;
}

/**
 * The source ranges covered by the tokens at document positions `[from, to)`. Each run of
 * tokens that follow each other in a source gives one range, from the first token's
 * `cutBefore` (the start of the source for its first token) to the next token's `cutBefore`
 * (the end of the source after the last token).
 * Several clips or sources give several ranges; touching ones are joined.
 */
export function tokensToRanges(layout: TranscriptLayout, from: number, to: number): SourceRange[] {
  const { visSrc, visFlat, sources } = layout.internals;
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(layout.tokens.length, Math.max(from, to));
  const ranges: SourceRange[] = [];
  let runSrc = -1;
  let runFirst = -1;
  let runLast = -1;
  const close = () => {
    if (runSrc < 0) return;
    const src = sources[runSrc]!;
    ranges.push({ sourceId: src.id, start: cutBeforeOf(src, runFirst), end: cutAfter(src, runLast) });
  };
  for (let p = lo; p < hi; p++) {
    const s = visSrc[p]!;
    const f = visFlat[p]!;
    if (s === runSrc && f === runLast + 1) {
      runLast = f;
      continue;
    }
    close();
    runSrc = s;
    runFirst = f;
    runLast = f;
  }
  close();
  return mergeRanges(layout, ranges);
}

/**
 * The source ranges a selection covers, for cutting (`Delete`) or restoring (`R`); a caret
 * with nothing selected gives none.
 */
export function selectionToRanges(layout: TranscriptLayout, sel: TextSelection): SourceRange[] {
  const { from, to } = selectedSpan(clampSelection(layout, sel));
  return tokensToRanges(layout, from, to);
}

// ---- I / O marks to source ranges ----------------------------------------------------

/** A mark set with `I` or `O`: a sequence time, or a source position. */
export type Mark = SequenceTime | SourcePosition;

/*
 * A mark snaps only when it falls on a token: between that token's cut point (`cutBefore`,
 * which lies in the gap before it) and its end. A mark in silence (before the first token,
 * after the last one, in the gap after a token's end, or past what a partial transcript
 * reaches) has no text there and is used raw, so a range never grows to swallow a word that
 * ended before the mark or a stretch the user did not mark.
 */

/** The token whose stretch `[cutBefore, end)` holds `t`, or -1 when `t` lies in silence. */
function tokenAtMark(src: SourceData, t: Micros, startSide: boolean): number {
  const index = src.index;
  if (!index || index.count === 0) return -1;
  // For an end mark exactly on a cut point, the token after it is not included.
  const i = startSide ? lastAtOrBefore(index.cutBefore, t, index.count) : firstAtOrAfter(index.cutBefore, t, index.count) - 1;
  if (i < 0) return -1;
  return t < index.end[i]! ? i : -1;
}

/** A start mark: the cut point of the token it falls on, or raw in silence. */
function snapStartDown(src: SourceData, t: Micros): Micros {
  const i = tokenAtMark(src, t, true);
  return i < 0 ? t : src.index!.cutBefore[i]!;
}

/**
 * An end mark: the next token's cut point when it falls on a token (for the last token, that
 * token's end, so the trailing silence the user did not mark is kept), or raw in silence.
 * A mark at or before the moment a word starts (the caret put before it, or O pressed in the
 * pause before it) is before anything of that word was heard: the range ends at that word's
 * cut point and the word stays.
 */
function snapEndUp(src: SourceData, t: Micros): Micros {
  const i = tokenAtMark(src, t, false);
  if (i < 0) return t;
  const index = src.index!;
  if (t <= index.start[i]!) return index.cutBefore[i]!;
  return i + 1 < index.count ? index.cutBefore[i + 1]! : index.end[i]!;
}

/**
 * A source range snapped to token boundaries where a mark falls on a token (outward, except an
 * end mark before its word has started), raw where it falls in silence or past the transcript.
 */
export function snapRangeToTokens(layout: TranscriptLayout, range: SourceRange): SourceRange {
  const src = layout.internals.byId.get(range.sourceId);
  if (!src) return { ...range };
  return { sourceId: range.sourceId, start: snapStartDown(src, range.start), end: snapEndUp(src, range.end) };
}

/** The source pieces that play between two sequence times. */
function sequencePieces(state: EditState, a: SequenceTime, b: SequenceTime): SourceRange[] {
  const out: SourceRange[] = [];
  let t = 0;
  for (const c of state.clips) {
    const len = c.end - c.start;
    const s = Math.max(a, t);
    const e = Math.min(b, t + len);
    if (s < e) out.push({ sourceId: c.sourceId, start: c.start + (s - t), end: c.start + (e - t) });
    t += len;
    if (t >= b) break;
  }
  return out;
}

/**
 * The source ranges between an `I` and an `O` mark (either order), snapped outward to token
 * boundaries where a mark falls on a token and used raw where it does not. The marks are
 * placed in the sequence and every source stretch that plays between them is included, so
 * reordered clips give what was heard between `I` and `O`. Only when a source position
 * cannot be placed (it is cut) and both marks are in the same source is the source span
 * between them used; otherwise an unplaceable mark gives no ranges.
 */
export function markToRanges(layout: TranscriptLayout, markIn: Mark, markOut: Mark): SourceRange[] {
  const state = layout.input.edit;
  const toSeq = (m: Mark): SequenceTime | null => (typeof m === "number" ? m : sequenceTimeOf(state, m));
  const ta = toSeq(markIn);
  const tb = toSeq(markOut);
  if (ta === null || tb === null) {
    if (typeof markIn === "number" || typeof markOut === "number" || markIn.sourceId !== markOut.sourceId) return [];
    const start = Math.min(markIn.at, markOut.at);
    const end = Math.max(markIn.at, markOut.at);
    if (end <= start) return [];
    return mergeRanges(layout, [snapRangeToTokens(layout, { sourceId: markIn.sourceId, start, end })]);
  }
  const a = Math.min(ta, tb);
  const b = Math.max(ta, tb);
  if (b <= a) return [];
  return mergeRanges(
    layout,
    sequencePieces(state, a, b).map((r) => snapRangeToTokens(layout, r)),
  );
}
