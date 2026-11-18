/**
 * The Transcript view's rows, worked out once per layout: one row per source header,
 * paragraph or untranscribed stretch, with the document positions each paragraph holds, the
 * pending suggestions that end in it, and lookups from a caret boundary to its row.
 *
 * The layout's types are taken from the store's state (spec 3.6 rule 1: views use `state` and
 * `ui` only), so this file imports nothing from `transcript` itself.
 */
import type { RoughcutState } from "../../state";
import type { Micros } from "../../types";

/** The Transcript view's content (`transcript`'s `TranscriptLayout`, as the store holds it). */
export type Layout = NonNullable<RoughcutState["layout"]>;
export type Block = Layout["blocks"][number];
export type ParagraphBlock = Extract<Block, { kind: "paragraph" }>;
export type SourceHeaderBlock = Extract<Block, { kind: "source" }>;
export type UntranscribedBlock = Extract<Block, { kind: "untranscribed" }>;
export type DisplayToken = Layout["tokens"][number];
export type SuggestionView = Layout["suggestions"][number];
export type FindMatch = RoughcutState["find"]["matches"][number];
export type Mark = NonNullable<RoughcutState["marks"]["in"]>;
export type Selection = RoughcutState["selection"];

/** A source header line ("take-1.mp4"). */
export interface SourceRow {
  readonly kind: "source";
  readonly key: string;
  readonly block: SourceHeaderBlock;
}

/** One paragraph: tokens at document positions [start, end). */
export interface ParagraphRow {
  readonly kind: "paragraph";
  readonly key: string;
  readonly block: ParagraphBlock;
  readonly start: number;
  readonly end: number;
  /** The time shown in the margin: the source time of its first shown token (as in the mockup). */
  readonly time: Micros;
  /** Text for this source is still arriving right after this paragraph (the blinking block). */
  readonly arriving: boolean;
  /** Pending suggestions whose last visible token is in this paragraph: their reason lines go under it. */
  readonly endsSuggestions: readonly SuggestionView[];
  /** Ids of the pending suggestions that cover any token of this paragraph. */
  readonly suggestionIds: ReadonlySet<string>;
}

/** Kept time with no text (not transcribed yet, no transcript, or no speech). */
export interface UntranscribedRow {
  readonly kind: "untranscribed";
  readonly key: string;
  readonly block: UntranscribedBlock;
  /**
   * For a "partial" stretch: "block" when text arrives here and the blinking block is drawn in
   * this row, "note" when text arrives here but the paragraph just above draws the block, and
   * "none" for every other stretch of the source (text does not arrive there next).
   */
  readonly arrival: "block" | "note" | "none";
}

export type Row = SourceRow | ParagraphRow | UntranscribedRow;

/** The rows of one layout, with position lookups. */
export interface RowModel {
  readonly layout: Layout;
  readonly rows: readonly Row[];
  /** Row index of each paragraph, in document order. */
  readonly paragraphRows: readonly number[];
  /** First document position of each paragraph, parallel to `paragraphRows`. */
  readonly paragraphStarts: readonly number[];
  /** Number of visible tokens (the last caret boundary). */
  readonly tokenCount: number;
  /** Pending suggestions in document order, with their number ("1 of 3"). */
  readonly pendingOrder: ReadonlyMap<string, number>;
  readonly pendingCount: number;
}

const NO_SUGGESTIONS: readonly SuggestionView[] = [];
const NO_IDS: ReadonlySet<string> = new Set();

/** Builds the rows for a layout. */
export function buildRows(layout: Layout): RowModel {
  const rows: Row[] = [];
  const paragraphRows: number[] = [];
  const paragraphStarts: number[] = [];
  const blocks = layout.blocks;
  // Text arrives in one place per source: the partial stretch earliest in source time (the
  // transcriber works forward through the source, whatever order the clips play in).
  const arrivalBlock = new Map<string, number>();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.kind !== "untranscribed" || b.status !== "partial") continue;
    const k = arrivalBlock.get(b.sourceId);
    if (k === undefined) arrivalBlock.set(b.sourceId, i);
    else {
      const o = blocks[k] as UntranscribedBlock;
      if (b.range.start < o.range.start) arrivalBlock.set(b.sourceId, i);
    }
  }
  let pos = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.kind === "source") {
      rows.push({ kind: "source", key: b.key, block: b });
    } else if (b.kind === "untranscribed") {
      const prev = blocks[i - 1];
      const arrival =
        arrivalBlock.get(b.sourceId) !== i ? "none" : prev !== undefined && prev.kind === "paragraph" && prev.sourceId === b.sourceId ? "note" : "block";
      rows.push({ kind: "untranscribed", key: b.key, block: b, arrival });
    } else {
      const next = blocks[i + 1];
      const arriving = next !== undefined && next.kind === "untranscribed" && next.sourceId === b.sourceId && arrivalBlock.get(b.sourceId) === i + 1;
      const ids = new Set<string>();
      for (const t of b.tokens) if (t.suggestionId !== null && t.suggestionState === "pending") ids.add(t.suggestionId);
      paragraphRows.push(rows.length);
      paragraphStarts.push(pos);
      rows.push({
        kind: "paragraph",
        key: b.key,
        block: b,
        start: pos,
        end: pos + b.tokens.length,
        time: b.sourceTime,
        arriving,
        endsSuggestions: NO_SUGGESTIONS,
        suggestionIds: ids.size > 0 ? ids : NO_IDS,
      });
      pos += b.tokens.length;
    }
  }
  const model: RowModel = {
    layout,
    rows,
    paragraphRows,
    paragraphStarts,
    tokenCount: pos,
    pendingOrder: new Map(),
    pendingCount: 0,
  };
  // Reason lines go under the paragraph holding a pending suggestion's last visible token.
  const pending = layout.suggestions.filter((v) => v.state === "pending");
  const order = new Map<string, number>();
  pending.forEach((v, i) => order.set(v.suggestion.id, i + 1));
  const ends = new Map<number, SuggestionView[]>();
  for (const v of pending) {
    if (v.lastPosition < 0) continue;
    const r = rowOfPosition(model, v.lastPosition);
    if (r < 0) continue;
    const list = ends.get(r) ?? [];
    list.push(v);
    ends.set(r, list);
  }
  for (const [r, list] of ends) {
    const row = rows[r] as ParagraphRow;
    rows[r] = { ...row, endsSuggestions: list };
  }
  return { ...model, pendingOrder: order, pendingCount: pending.length };
}

/** Row indexes of the untranscribed rows (kept time with no text), in row order. */
export function untranscribedRowIndexes(model: RowModel): readonly number[] {
  const out: number[] = [];
  model.rows.forEach((r, i) => {
    if (r.kind === "untranscribed") out.push(i);
  });
  return out;
}

/**
 * The untranscribed row (of `rows`, from `untranscribedRowIndexes`) holding a source moment,
 * or -1 when that moment is in a paragraph or not kept.
 */
export function untranscribedRowAt(model: RowModel, rows: readonly number[], pos: { sourceId: string; at: Micros }): number {
  for (const i of rows) {
    const r = model.rows[i] as UntranscribedRow;
    const range = r.block.range;
    if (r.block.sourceId === pos.sourceId && pos.at >= range.start && pos.at < range.end) return i;
  }
  return -1;
}

/** Index in `paragraphStarts` of the last paragraph starting at or before `p`, or -1. */
function paragraphIndexAt(model: RowModel, p: number): number {
  const starts = model.paragraphStarts;
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= p) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The row of the paragraph holding the token at document position `p`, or -1. */
export function rowOfPosition(model: RowModel, p: number): number {
  if (p < 0 || p >= model.tokenCount) return -1;
  const k = paragraphIndexAt(model, p);
  return k < 0 ? -1 : model.paragraphRows[k]!;
}

/** The row where the caret at boundary `b` is drawn: before token `b`, or after the last token. */
export function rowOfBoundary(model: RowModel, b: number): number {
  if (model.tokenCount === 0) return -1;
  return rowOfPosition(model, Math.max(0, Math.min(b, model.tokenCount - 1)));
}

/** One find match as a paragraph draws it. */
export interface RowMatch {
  readonly from: number;
  readonly to: number;
  readonly current: boolean;
}

/** The find matches that touch each paragraph row (only shown tokens; matches are in document order). */
export function matchesByRow(model: RowModel, matches: readonly FindMatch[], current: number): ReadonlyMap<number, readonly RowMatch[]> {
  const out = new Map<number, RowMatch[]>();
  matches.forEach((m, i) => {
    if (m.to <= m.from) return;
    for (let p = m.from; p < m.to; ) {
      const r = rowOfPosition(model, p);
      if (r < 0) break;
      const row = model.rows[r] as ParagraphRow;
      const list = out.get(r) ?? [];
      list.push({ from: Math.max(m.from, row.start), to: Math.min(m.to, row.end), current: i === current });
      out.set(r, list);
      p = row.end;
    }
  });
  return out;
}

/** Document positions of the `I` and `O` marks (the token each sits on), -1 when not shown. */
export interface MarkPositions {
  readonly inPos: number;
  readonly outPos: number;
}

function isSourcePosition(m: Mark): m is Extract<Mark, { sourceId: string }> {
  return typeof m === "object" && m !== null;
}

/**
 * Where a mark is drawn. A mark held as a source position is placed by source time, whatever
 * order the clips play in: an `I` mark sits before the shown token of that source that ends
 * after it and starts earliest in source time (the token holding it, or the next one); an `O`
 * mark sits after the shown token that starts before it and starts latest. A mark held as a
 * sequence time (set before the sequence had a source moment) is placed by the kept tokens'
 * playing times.
 */
export function markPosition(model: RowModel, mark: Mark | null, side: "in" | "out"): number {
  if (mark === null) return -1;
  const tokens = model.layout.tokens;
  if (isSourcePosition(mark)) {
    let found = -1;
    let best = 0;
    for (let p = 0; p < tokens.length; p++) {
      const t = tokens[p]!;
      if (t.address.sourceId !== mark.sourceId) continue;
      const start = t.token.start;
      if (side === "in") {
        if (t.token.end > mark.at && (found < 0 || start < best)) {
          found = p;
          best = start;
        }
      } else if (start < mark.at && (found < 0 || start > best)) {
        found = p;
        best = start;
      }
    }
    return found;
  }
  // A sequence time: estimate each kept token's playing time from its paragraph's start.
  let found = -1;
  for (let k = 0; k < model.paragraphRows.length; k++) {
    const row = model.rows[model.paragraphRows[k]!] as ParagraphRow;
    const seq = row.block.sequenceTime;
    if (seq === null) continue;
    const first = row.block.tokens.find((t) => t.keep !== "cut");
    if (!first) continue;
    for (let i = 0; i < row.block.tokens.length; i++) {
      const t = row.block.tokens[i]!;
      if (t.keep === "cut") continue;
      const start = seq + (t.token.start - first.token.start);
      const end = seq + (t.token.end - first.token.start);
      if (side === "in" && end > mark) return row.start + i;
      if (side === "out" && start < mark) found = row.start + i;
    }
  }
  return found;
}
