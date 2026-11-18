/**
 * Playhead and caret (spec 1.8: they are the same thing), the Timeline view's one-line
 * caption, and moving between suggestions. Lookups by time are binary searches.
 */
import type { Micros, SequenceTime, SourcePosition, SourceRange } from "../types";
import type { SourceData, SuggestionView, TranscriptLayout } from "./layout";
import { resolveAddress } from "./layout";
import type { TextSelection } from "./selection";
import type { TokenAddress } from "./sourceIndex";
import { lastAtOrBefore } from "./sourceIndex";

/** Internal: the flat token whose stretch `[cutBefore, next cutBefore)` holds `at`, or -1. */
function flatAt(src: SourceData, at: Micros): number {
  const index = src.index;
  if (!index || index.count === 0) return -1;
  const i = lastAtOrBefore(index.cutBefore, at, index.count);
  if (i < 0) return -1;
  if (i === index.count - 1) {
    // The last token's stretch runs to the end of the source; while transcribing, only to its own end.
    const end = index.end[i]!;
    const reach = src.complete ? Math.max(src.sourceEnd, end) : end;
    if (at > end && at >= reach) return -1;
  }
  return i;
}

/**
 * The token at a source position: the one whose stretch, from its `cutBefore` to the next
 * token's, holds it. Null before the first token, past what has been transcribed, or for a
 * source without a transcript.
 */
export function tokenAtSource(layout: TranscriptLayout, pos: SourcePosition): TokenAddress | null {
  const src = layout.internals.byId.get(pos.sourceId);
  if (!src) return null;
  const f = flatAt(src, pos.at);
  return f < 0 ? null : src.index!.addresses[f]!;
}

/** Where a token is heard: its source and start time. */
export function tokenSourcePosition(layout: TranscriptLayout, address: TokenAddress): SourcePosition | null {
  const r = resolveAddress(layout, address);
  return r ? { sourceId: r.src.id, at: r.src.index!.start[r.flat]! } : null;
}

/**
 * The caret boundary for a playhead at a source position: before the token there (before the
 * source's first token when the position is earlier). Null when the source has no text there.
 */
export function caretForSource(layout: TranscriptLayout, pos: SourcePosition): number | null {
  const src = layout.internals.byId.get(pos.sourceId);
  if (!src || !src.index || src.index.count === 0) return null;
  let f = flatAt(src, pos.at);
  if (f < 0 && pos.at < src.index.cutBefore[0]!) f = 0;
  if (f < 0 || src.streamOf[f]! < 0) return null;
  return src.boundaryOf[f]!;
}

/**
 * The source position for a caret boundary: the start of the token after it (the end of the
 * last token at the end of the document). Null for an empty document.
 */
export function caretSourcePosition(layout: TranscriptLayout, boundary: number): SourcePosition | null {
  const n = layout.tokens.length;
  if (n === 0) return null;
  const { visSrc, visFlat, sources } = layout.internals;
  if (boundary >= n) {
    const src = sources[visSrc[n - 1]!]!;
    return { sourceId: src.id, at: src.index!.end[visFlat[n - 1]!]! };
  }
  const p = Math.max(0, boundary);
  const src = sources[visSrc[p]!]!;
  return { sourceId: src.id, at: src.index!.start[visFlat[p]!]! };
}

/**
 * The sequence time for a caret boundary, so moving the caret moves the playhead: where the
 * first kept token at or after it plays (cut tokens are skipped, as playback skips them), or
 * the end of the sequence.
 */
export function caretSequenceTime(layout: TranscriptLayout, boundary: number): SequenceTime {
  const seq = layout.internals.seqTime;
  for (let p = Math.max(0, boundary); p < seq.length; p++) {
    const t = seq[p]!;
    if (!Number.isNaN(t)) return t;
  }
  let total = 0;
  for (const c of layout.input.edit.clips) total += c.end - c.start;
  return total;
}

// ---- caption -----------------------------------------------------------------------

/** The Timeline view's one-line caption: the kept words around the playhead, in playing order. */
export interface Caption {
  /** Words before the current one, joined by spaces. */
  readonly before: string;
  /** The word at the playhead, or null (between words, in a pause, no text). */
  readonly current: string | null;
  readonly after: string;
  readonly currentAddress: TokenAddress | null;
}

const EMPTY_CAPTION: Caption = { before: "", current: null, after: "", currentAddress: null };

/** The kept words around a source position: up to `words` on each side (default 6). */
export function captionAt(layout: TranscriptLayout, pos: SourcePosition, words = 6): Caption {
  const src = layout.internals.byId.get(pos.sourceId);
  if (!src) return EMPTY_CAPTION;
  const f = flatAt(src, pos.at);
  if (f < 0) return EMPTY_CAPTION;
  const k = src.streamOf[f]!;
  if (k < 0) return EMPTY_CAPTION;
  const { streamSrc, streamFlat, sources } = layout.internals;
  const wordAt = (s: number): string | null => {
    const fl = streamFlat[s]!;
    if (fl < 0) return null;
    const sd = sources[streamSrc[s]!]!;
    if (sd.keep[fl] === 0) return null;
    const tok = sd.index!.tokens[fl]!;
    return tok.kind === "word" ? tok.text : null;
  };
  const current = wordAt(k);
  const before: string[] = [];
  for (let s = k - 1; s >= 0 && before.length < words; s--) {
    const w = wordAt(s);
    if (w !== null) before.push(w);
  }
  before.reverse();
  const after: string[] = [];
  for (let s = k + 1; s < streamFlat.length && after.length < words; s++) {
    const w = wordAt(s);
    if (w !== null) after.push(w);
  }
  return { before: before.join(" "), current, after: after.join(" "), currentAddress: current !== null ? src.index!.addresses[f]! : null };
}

// ---- suggestions -------------------------------------------------------------------

/** Options for moving between suggestions. */
export interface SuggestionNavOptions {
  /** Go round from the last to the first (or the first to the last). Default false. */
  wrap?: boolean;
  /** The id of the suggestion the caret is on now (the one `N` last landed on): it is skipped. */
  current?: string | null;
}

function pendingShown(layout: TranscriptLayout, current: string | null | undefined): SuggestionView[] {
  return layout.suggestions.filter((s) => s.state === "pending" && s.firstPosition >= 0 && s.suggestion.id !== current);
}

/**
 * The next pending suggestion starting at or after the caret boundary (`N`), or null. A
 * suggestion that starts exactly at the caret counts (the caret at 0 reaches one on the first
 * token); pass `current` to step past the one the caret is already on.
 */
export function nextPendingSuggestion(layout: TranscriptLayout, boundary: number, options: SuggestionNavOptions = {}): SuggestionView | null {
  const list = pendingShown(layout, options.current);
  const hit = list.find((s) => s.firstPosition >= boundary);
  return hit ?? (options.wrap ? list[0] ?? null : null);
}

/** The pending suggestion that starts before the caret boundary, nearest first, or null; `current` is skipped. */
export function previousPendingSuggestion(layout: TranscriptLayout, boundary: number, options: SuggestionNavOptions = {}): SuggestionView | null {
  const list = pendingShown(layout, options.current);
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.firstPosition < boundary) return list[i]!;
  return options.wrap ? list[list.length - 1] ?? null : null;
}

/** The suggestion covering the token after the caret boundary (a pending one wins), or null. */
export function suggestionAt(layout: TranscriptLayout, boundary: number): SuggestionView | null {
  const tok = layout.tokens[boundary];
  if (!tok || tok.suggestionId === null) return null;
  return layout.suggestions.find((s) => s.suggestion.id === tok.suggestionId) ?? null;
}

/** The selection of a suggestion's shown tokens, or null when none is shown. */
export function suggestionSelection(view: SuggestionView): TextSelection | null {
  if (view.firstPosition < 0) return null;
  return { anchor: view.firstPosition, focus: view.lastPosition + 1 };
}

/** The ranges of every pending suggestion (`Shift+A` cuts them in one `cutRanges`). */
export function pendingSuggestionRanges(layout: TranscriptLayout): SourceRange[] {
  return layout.suggestions.filter((s) => s.state === "pending").map((s) => ({ ...s.suggestion.range }));
}
