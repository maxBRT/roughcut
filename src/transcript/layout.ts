/**
 * The Transcript view's content, worked out from the project's sources, their transcripts,
 * the clip list and the suggestions (spec 1.7 C, 1.8, 3.5.1).
 *
 * - Blocks come in playing order: a header whenever the source changes, then one paragraph
 *   per stretch of an utterance that plays continuously, then (for a source still being
 *   transcribed, or with no transcript) an "untranscribed" block for the kept time that has
 *   no text yet. A kept clip whose transcribed time holds no token gets a 'silent' block.
 * - Every token is marked kept, partial or cut against the clip list (spec 3.4 rule 3).
 * - Cut text sits next to the kept clip that borders it in source time: exactly where
 *   `restoreRanges` would put it back (`cutPlacement` from `edit`, spec 3.5.1).
 * - Document order is the order of the visible tokens (cut tokens are left out when cut text
 *   is hidden). A caret is a boundary 0..tokens.length between them.
 *
 * Speed: each transcript is flattened once and cached by object identity; a layout pass is
 * O(tokens x log(clips)); blocks and display tokens that did not change are reused from the
 * previous layout (same objects), so a view can skip redrawing them.
 */
import { contextFromProject, cutPlacement, suggestionState } from "../edit";
import type { EditContext, KeepState, SuggestionState } from "../edit";
import type {
  EditState,
  Micros,
  Rational,
  SequenceTime,
  SourceId,
  SourceRange,
  SourceRef,
  Suggestion,
  SuggestionSet,
  Token,
  Transcript,
} from "../types";
import { firstClipEnd } from "../types";
import type { SourceIndex, TokenAddress } from "./sourceIndex";
import { firstAfter, firstAtOrAfter, flatOf, indexTranscript, lastAtOrBefore } from "./sourceIndex";

/** Transcripts by source: a Map or a plain record. Missing or null means no transcript yet. */
export type TranscriptLookup =
  | ReadonlyMap<SourceId, Transcript | null | undefined>
  | Readonly<Record<SourceId, Transcript | null | undefined>>;

/** Suggestions: a flat list, or suggestion sets by source (Map or record). */
export type SuggestionLookup =
  | readonly Suggestion[]
  | ReadonlyMap<SourceId, SuggestionSet | null | undefined>
  | Readonly<Record<SourceId, SuggestionSet | null | undefined>>;

/** Everything the layout is computed from. Pass the same objects again to get the same layout back. */
export interface LayoutInput {
  frameRate: Rational;
  /** The project's sources, in project order. */
  sources: readonly SourceRef[];
  transcripts: TranscriptLookup;
  /** The current edit state (`doc.current`). */
  edit: EditState;
  suggestions?: SuggestionLookup;
  /** `H`: leave cut text out of the view (and out of document order). */
  hideCut?: boolean;
}

/** One token as the view draws it. Reused between layouts while nothing about it changes. */
export interface DisplayToken {
  readonly address: TokenAddress;
  readonly token: Token;
  /** Kept, partly kept (a timeline edge inside the word) or cut. */
  readonly keep: KeepState;
  /** The suggestion covering this token (a pending one wins when several do), or null. */
  readonly suggestionId: string | null;
  readonly suggestionState: SuggestionState | null;
}

/** A header line naming a source; appears whenever the playing order moves to another source. */
export interface SourceHeaderBlock {
  readonly kind: "source";
  readonly key: string;
  readonly sourceId: SourceId;
  /** The file name, from the source's path. */
  readonly name: string;
}

/** One paragraph: the tokens of one utterance that are shown together. */
export interface ParagraphBlock {
  readonly kind: "paragraph";
  readonly key: string;
  readonly sourceId: SourceId;
  /** Position of the utterance in `Transcript.utterances`. */
  readonly utterance: number;
  /** `Utterance.index`, the number Claude uses. */
  readonly utteranceIndex: number;
  /** True when this is not the start of its utterance (the clips split it). */
  readonly continued: boolean;
  readonly tokens: readonly DisplayToken[];
  /** Source time of the first shown token. */
  readonly sourceTime: Micros;
  /** Sequence time of the first kept token shown, or null when all of it is cut. */
  readonly sequenceTime: SequenceTime | null;
  /** True when every token shown is cut. */
  readonly allCut: boolean;
}

/**
 * Kept time with no text: no transcript ('none'), not transcribed so far ('partial'), or
 * transcribed but holding no speech ('silent', for example a screen recording with no voice).
 */
export interface UntranscribedBlock {
  readonly kind: "untranscribed";
  readonly key: string;
  readonly sourceId: SourceId;
  readonly range: SourceRange;
  readonly sequenceTime: SequenceTime;
  readonly status: "none" | "partial" | "silent";
}

/** One row of the Transcript view. */
export type LayoutBlock = SourceHeaderBlock | ParagraphBlock | UntranscribedBlock;

/** A suggestion with its worked-out state and the tokens it covers. */
export interface SuggestionView {
  readonly suggestion: Suggestion;
  readonly state: SuggestionState;
  /** First and last covered token, in source order; null when no token is covered. */
  readonly first: TokenAddress | null;
  readonly last: TokenAddress | null;
  /** First and last covered token in document order; -1 when none is visible. */
  readonly firstPosition: number;
  readonly lastPosition: number;
}

/** The Transcript view's content. Treat as read-only; `internals` is for this module only. */
export interface TranscriptLayout {
  readonly input: LayoutInput;
  readonly hideCut: boolean;
  readonly blocks: readonly LayoutBlock[];
  /** The visible tokens in document order; a caret is a boundary 0..tokens.length. */
  readonly tokens: readonly DisplayToken[];
  /** Every suggestion of a known source, in document order of its first visible token. */
  readonly suggestions: readonly SuggestionView[];
  readonly internals: LayoutInternals;
}

/** Internal: per-source data of one layout. */
export interface SourceData {
  readonly id: SourceId;
  readonly order: number;
  readonly name: string;
  readonly index: SourceIndex | null;
  readonly complete: boolean;
  /** The source's end on the grid (its first clip's end). */
  readonly sourceEnd: Micros;
  /** Per flat token: 0 cut, 1 partial, 2 kept. */
  readonly keep: Uint8Array;
  /** Per flat token: document position, or -1 when hidden. */
  readonly positionOf: Int32Array;
  /** Per flat token: the boundary it sits at (its position, or where it would be when hidden). */
  readonly boundaryOf: Int32Array;
  /** Per flat token: index in the full stream (kept and cut, hidden or not). */
  readonly streamOf: Int32Array;
  /** Per flat token: the display token. */
  readonly display: DisplayToken[];
}

/** Internal: everything the queries need. */
export interface LayoutInternals {
  readonly ctx: EditContext;
  readonly sources: readonly SourceData[];
  readonly byId: ReadonlyMap<SourceId, SourceData>;
  /** Per document position: source (index into `sources`) and flat token. */
  readonly visSrc: Int32Array;
  readonly visFlat: Int32Array;
  /** Per document position: sequence time of a kept token, NaN when cut. */
  readonly seqTime: Float64Array;
  /** The full stream in playing order (cut tokens included even when hidden). */
  readonly streamSrc: Int32Array;
  readonly streamFlat: Int32Array;
  /** Document positions where a paragraph / a sentence starts, ascending. */
  readonly paragraphStarts: Int32Array;
  readonly sentenceStarts: Int32Array;
  readonly blocksByKey: ReadonlyMap<string, LayoutBlock>;
  /** Lazily built search text (see find.ts). */
  findCache?: unknown;
}

const KEEP_NAMES: readonly KeepState[] = ["cut", "partial", "kept"];

function lookupTranscript(t: TranscriptLookup, id: SourceId): Transcript | null {
  const v = t instanceof Map ? t.get(id) : (t as Readonly<Record<SourceId, Transcript | null | undefined>>)[id];
  return v ?? null;
}

function flattenSuggestions(s: SuggestionLookup | undefined): Suggestion[] {
  if (!s) return [];
  if (Array.isArray(s)) return s as Suggestion[];
  const sets: (SuggestionSet | null | undefined)[] =
    s instanceof Map ? [...s.values()] : Object.values(s as Readonly<Record<SourceId, SuggestionSet | null | undefined>>);
  const out: Suggestion[] = [];
  for (const set of sets) if (set) out.push(...set.suggestions);
  return out;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function sameInput(a: LayoutInput, b: LayoutInput): boolean {
  return (
    a.frameRate === b.frameRate &&
    a.sources === b.sources &&
    a.transcripts === b.transcripts &&
    a.edit === b.edit &&
    a.suggestions === b.suggestions &&
    !!a.hideCut === !!b.hideCut
  );
}

function sameTokens(a: readonly DisplayToken[], b: readonly DisplayToken[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameBlock(a: LayoutBlock, b: LayoutBlock): boolean {
  if (a.kind !== b.kind || a.key !== b.key || a.sourceId !== b.sourceId) return false;
  if (a.kind === "source") return a.name === (b as SourceHeaderBlock).name;
  if (a.kind === "untranscribed") {
    const o = b as UntranscribedBlock;
    return a.status === o.status && a.sequenceTime === o.sequenceTime && a.range.start === o.range.start && a.range.end === o.range.end;
  }
  const o = b as ParagraphBlock;
  return (
    a.utterance === o.utterance &&
    a.utteranceIndex === o.utteranceIndex &&
    a.continued === o.continued &&
    a.sourceTime === o.sourceTime &&
    a.sequenceTime === o.sequenceTime &&
    a.allCut === o.allCut &&
    sameTokens(a.tokens, o.tokens)
  );
}

interface GapRef {
  src: number;
  start: Micros;
  tokens: number[];
}

interface Untranscribed {
  src: number;
  start: Micros;
  end: Micros;
  seq: SequenceTime;
  status: UntranscribedBlock["status"];
}

/**
 * The Transcript view's content for `input`. When `previous` is given and every input is the
 * same object as before, `previous` itself comes back; otherwise unchanged blocks and tokens
 * are reused from it.
 */
export function layoutTranscript(input: LayoutInput, previous?: TranscriptLayout | null): TranscriptLayout {
  if (previous && sameInput(previous.input, input)) return previous;
  const hideCut = !!input.hideCut;
  const rate = input.frameRate;
  const ctx = contextFromProject({ frameRate: rate, sources: input.sources });
  const state = input.edit;
  const clips = state.clips;
  const prevInternals = previous?.internals;
  /**
   * One frame. Clip edges sit on the frame grid, so less than a frame of a word kept (or cut)
   * can only be a rounding sliver from snapping a cut to the grid, never a real edit.
   */
  const sliver = rate.num > 0 ? (1_000_000 * rate.den) / rate.num : 0;

  // ---- sources ----
  const sources: SourceData[] = [];
  const byId = new Map<SourceId, SourceData>();
  for (const ref of input.sources) {
    if (byId.has(ref.id)) continue;
    const transcript = lookupTranscript(input.transcripts, ref.id);
    const index = transcript ? indexTranscript(transcript) : null;
    const n = index ? index.count : 0;
    const prevSrc = prevInternals?.byId.get(ref.id);
    const data: SourceData = {
      id: ref.id,
      order: sources.length,
      name: baseName(ref.path),
      index,
      complete: transcript ? transcript.complete : false,
      sourceEnd: firstClipEnd(ref.media.duration, rate) ?? 0,
      keep: new Uint8Array(n),
      positionOf: new Int32Array(n).fill(-1),
      boundaryOf: new Int32Array(n),
      streamOf: new Int32Array(n).fill(-1),
      display: prevSrc && prevSrc.index === index ? prevSrc.display.slice() : new Array<DisplayToken>(n),
    };
    sources.push(data);
    byId.set(ref.id, data);
  }

  // ---- sequence starts and kept spans per source ----
  const seqStart = new Float64Array(clips.length + 1);
  const spans: { s: number[]; e: number[]; c: number[] }[] = sources.map(() => ({ s: [], e: [], c: [] }));
  {
    const perSource: [number, number, number][][] = sources.map(() => []);
    let t = 0;
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i]!;
      seqStart[i] = t;
      t += c.end - c.start;
      const src = byId.get(c.sourceId);
      if (src) perSource[src.order]!.push([c.start, c.end, i]);
    }
    seqStart[clips.length] = t;
    perSource.forEach((list, k) => {
      list.sort((a, b) => a[0] - b[0]);
      const sp = spans[k]!;
      for (const [s, e, c] of list) {
        sp.s.push(s);
        sp.e.push(e);
        sp.c.push(c);
      }
    });
  }

  // ---- keep state of every token, and which clip / gap it is shown with ----
  const clipTokens: number[][] = clips.map(() => []);
  /**
   * Clips holding part of a word that is shown with the clip next to them in playing order
   * (a split inside a word): their sound is that word, not silence, so they get no
   * 'no speech' row.
   */
  const wordNextDoor = new Uint8Array(clips.length);
  const overlapped: number[] = [];
  const slotIdx: GapRef[][] = [];
  const slotBefore: GapRef[][] = [];
  const slotAfter: GapRef[][] = [];
  for (let i = 0; i <= clips.length; i++) {
    slotIdx.push([]);
    slotBefore.push([]);
    slotAfter.push([]);
  }
  for (const src of sources) {
    const index = src.index;
    if (!index || index.count === 0) continue;
    const sp = spans[src.order]!;
    const spanEnds = Float64Array.from(sp.e);
    const n = sp.s.length;
    // Cut gaps: the complement of the kept spans over the source (and anything the transcript reaches past it).
    const limit = Math.max(src.sourceEnd, index.extent);
    const gapStart: number[] = [];
    const gapEnd: number[] = [];
    let cursor = 0;
    for (let k = 0; k < n; k++) {
      if (sp.s[k]! > cursor) {
        gapStart.push(cursor);
        gapEnd.push(sp.s[k]!);
      }
      cursor = Math.max(cursor, sp.e[k]!);
    }
    if (cursor <= limit) {
      gapStart.push(cursor);
      gapEnd.push(Math.max(limit, cursor));
    }
    const gapStarts = Float64Array.from(gapStart);
    const gapTokens: number[][] = gapStart.map(() => []);
    for (let f = 0; f < index.count; f++) {
      const s = index.start[f]!;
      const e = index.end[f]!;
      const k = firstAfter(spanEnds, s, n); // the first span ending after s
      let kept = 0;
      let clip = -1;
      overlapped.length = 0;
      if (e > s) {
        for (let j = k; j < n && sp.s[j]! < e; j++) {
          const o = Math.min(e, sp.e[j]!) - Math.max(s, sp.s[j]!);
          if (o > 0) {
            kept += o;
            overlapped.push(sp.c[j]!);
            if (clip < 0) clip = sp.c[j]!;
          }
        }
      } else if (k < n && sp.s[k]! <= s && s < sp.e[k]!) {
        kept = 1;
        clip = sp.c[k]!;
      }
      // Cuts land on the frame grid and word times do not, so a word cut from the text keeps a
      // sliver of up to a frame at an edge (and its neighbour can lose one). A sliver that
      // short is not a word you can hear: the word counts as cut (or kept), not partial.
      let code: number;
      if (kept === 0) code = 0;
      else if (!(e > s) || kept >= e - s) code = 2;
      else if (kept < sliver) code = 0;
      else if (e - s - kept < sliver) code = 2;
      else code = 1;
      src.keep[f] = code;
      if (clip >= 0 && code !== 0) {
        clipTokens[clip]!.push(f);
        // The word runs on from its clip into the one playing straight after it.
        for (const c of overlapped) if (c === clip + 1) wordNextDoor[c] = 1;
      } else {
        // A word cut but for a sliver belongs to the gap its middle lies in.
        let g = lastAtOrBefore(gapStarts, clip >= 0 ? (s + e) / 2 : s);
        if (g < 0) g = 0;
        gapTokens[g]!.push(f);
      }
    }
    for (let g = 0; g < gapTokens.length; g++) {
      const toks = gapTokens[g]!;
      if (toks.length === 0) continue;
      const ref: GapRef = { src: src.order, start: gapStart[g]!, tokens: toks };
      const placement = cutPlacement(state, ctx, { sourceId: src.id, start: gapStart[g]!, end: gapEnd[g]! });
      if (placement.kind === "after") slotAfter[placement.index]!.push(ref);
      else if (placement.kind === "before") slotBefore[placement.index]!.push(ref);
      else slotIdx[Math.min(placement.index, clips.length)]!.push(ref);
    }
  }
  const byStart = (a: GapRef, b: GapRef) => a.start - b.start;
  for (let i = 0; i <= clips.length; i++) {
    slotIdx[i]!.sort((a, b) => a.src - b.src || a.start - b.start);
    slotBefore[i]!.sort(byStart);
    slotAfter[i]!.sort(byStart);
  }

  // ---- suggestions: which tokens each covers, and its state ----
  const allSuggestions = flattenSuggestions(input.suggestions);
  interface SugWork {
    s: Suggestion;
    state: SuggestionState;
    src: SourceData;
    first: number;
    last: number;
  }
  const work: SugWork[] = [];
  const sugOf: Int32Array[] = sources.map((s) => new Int32Array(s.index ? s.index.count : 0).fill(-1));
  for (const s of allSuggestions) {
    const src = byId.get(s.range.sourceId);
    if (!src) continue;
    const st = suggestionState(state, s.range, rate);
    let first = -1;
    let last = -1;
    const index = src.index;
    if (index && index.count > 0) {
      const rs = s.range.start;
      const re = s.range.end;
      let f = firstAtOrAfter(index.end, rs, index.count);
      for (; f < index.count && index.start[f]! < re; f++) {
        const ts = index.start[f]!;
        const te = index.end[f]!;
        const covered = te > ts ? te > rs : ts >= rs;
        if (!covered) continue;
        if (first < 0) first = f;
        last = f;
      }
    }
    const w = work.length;
    work.push({ s, state: st, src, first, last });
    if (first >= 0) {
      const marks = sugOf[src.order]!;
      for (let f = first; f <= last; f++) {
        const cur = marks[f]!;
        if (cur < 0 || (work[cur]!.state !== "pending" && st === "pending")) marks[f] = w;
      }
    }
  }

  // ---- the full stream in playing order ----
  const streamSrc: number[] = [];
  const streamFlat: number[] = [];
  const streamSeq: number[] = [];
  const untranscribed: Untranscribed[] = [];
  const emitGap = (g: GapRef) => {
    for (const f of g.tokens) {
      streamSrc.push(g.src);
      streamFlat.push(f);
      streamSeq.push(NaN);
    }
  };
  for (let i = 0; i <= clips.length; i++) {
    for (const g of slotIdx[i]!) emitGap(g);
    if (i === clips.length) break;
    for (const g of slotBefore[i]!) emitGap(g);
    const clip = clips[i]!;
    const src = byId.get(clip.sourceId);
    if (src) {
      const index = src.index;
      for (const f of clipTokens[i]!) {
        streamSrc.push(src.order);
        streamFlat.push(f);
        streamSeq.push(seqStart[i]! + Math.max(0, index!.start[f]! - clip.start));
      }
      const emitUntranscribed = (start: Micros, end: Micros, status: UntranscribedBlock["status"]) => {
        const seq = seqStart[i]! + (start - clip.start);
        untranscribed.push({ src: src.order, start, end, seq, status });
        streamSrc.push(src.order);
        streamFlat.push(-1 - (untranscribed.length - 1));
        streamSeq.push(seq);
      };
      // Where the transcribed part of this clip ends (the rest has no text yet).
      const transcribedEnd = !index ? clip.start : src.complete ? clip.end : Math.min(clip.end, Math.max(clip.start, index.extent));
      // A kept clip whose transcribed part holds no token (no speech) still gets a block, so it has a header and a row.
      if (index && clipTokens[i]!.length === 0 && !wordNextDoor[i] && transcribedEnd > clip.start) emitUntranscribed(clip.start, transcribedEnd, "silent");
      if (transcribedEnd < clip.end) emitUntranscribed(transcribedEnd, clip.end, index ? "partial" : "none");
    }
    for (const g of slotAfter[i]!) emitGap(g);
  }

  // ---- blocks, positions ----
  const blocks: LayoutBlock[] = [];
  const blocksByKey = new Map<string, LayoutBlock>();
  const prevBlocks = prevInternals?.blocksByKey;
  const tokens: DisplayToken[] = [];
  const visSrc: number[] = [];
  const visFlat: number[] = [];
  const visSeq: number[] = [];
  const paragraphStarts: number[] = [];
  const sentenceStarts: number[] = [];
  const headerCount = new Map<SourceId, number>();
  let lastBlockSource: SourceId | null = null;

  const pushBlock = (b: LayoutBlock) => {
    if (b.sourceId !== lastBlockSource) {
      const n = headerCount.get(b.sourceId) ?? 0;
      headerCount.set(b.sourceId, n + 1);
      const src = byId.get(b.sourceId)!;
      let header: LayoutBlock = { kind: "source", key: `source:${b.sourceId}:${n}`, sourceId: b.sourceId, name: src.name };
      const old = prevBlocks?.get(header.key);
      if (old && sameBlock(old, header)) header = old;
      blocks.push(header);
      blocksByKey.set(header.key, header);
      lastBlockSource = b.sourceId;
    }
    const old = prevBlocks?.get(b.key);
    const use = old && sameBlock(old, b) ? old : b;
    blocks.push(use);
    blocksByKey.set(use.key, use);
  };

  const displayFor = (src: SourceData, f: number): DisplayToken => {
    const keep = KEEP_NAMES[src.keep[f]!]!;
    const w = sugOf[src.order]![f]!;
    const sid = w >= 0 ? work[w]!.s.id : null;
    const sst = w >= 0 ? work[w]!.state : null;
    const old = src.display[f];
    if (old && old.keep === keep && old.suggestionId === sid && old.suggestionState === sst) return old;
    const d: DisplayToken = { address: src.index!.addresses[f]!, token: src.index!.tokens[f]!, keep, suggestionId: sid, suggestionState: sst };
    src.display[f] = d;
    return d;
  };

  let pos = 0;
  let para: { src: SourceData; u: number; lastFlat: number; firstFlat: number; tokens: DisplayToken[]; firstSeq: number; firstPos: number } | null = null;
  const flushPara = () => {
    if (!para) return;
    const p = para;
    para = null;
    if (p.tokens.length === 0) return;
    const index = p.src.index!;
    const utter = index.transcript.utterances[p.u]!;
    const first = p.tokens[0]!;
    paragraphStarts.push(p.firstPos);
    pushBlock({
      kind: "paragraph",
      key: `p:${p.src.id}:${p.u}:${p.firstFlat}`,
      sourceId: p.src.id,
      utterance: p.u,
      utteranceIndex: utter.index,
      continued: p.firstFlat !== index.uttOffset[p.u],
      tokens: p.tokens,
      sourceTime: first.token.start,
      sequenceTime: Number.isNaN(p.firstSeq) ? null : p.firstSeq,
      allCut: p.tokens.every((t) => t.keep === "cut"),
    });
  };

  for (let k = 0; k < streamFlat.length; k++) {
    const src = sources[streamSrc[k]!]!;
    const f = streamFlat[k]!;
    if (f < 0) {
      flushPara();
      const u = untranscribed[-1 - f]!;
      pushBlock({
        kind: "untranscribed",
        key: `u:${src.id}:${u.start}`,
        sourceId: src.id,
        range: { sourceId: src.id, start: u.start, end: u.end },
        sequenceTime: u.seq,
        status: u.status,
      });
      continue;
    }
    const index = src.index!;
    const u = index.utt[f]!;
    if (!para || para.src !== src || para.u !== u || para.lastFlat + 1 !== f) {
      flushPara();
      para = { src, u, lastFlat: f, firstFlat: f, tokens: [], firstSeq: NaN, firstPos: pos };
    }
    para.lastFlat = f;
    src.streamOf[f] = k;
    src.boundaryOf[f] = pos;
    const hidden = hideCut && src.keep[f] === 0;
    if (hidden) continue;
    const d = displayFor(src, f);
    if (para.tokens.length === 0) para.firstPos = pos;
    para.tokens.push(d);
    const seq = streamSeq[k]!;
    if (Number.isNaN(para.firstSeq) && !Number.isNaN(seq)) para.firstSeq = seq;
    // A sentence starts at a paragraph's first shown token and after a word ending in . ? !
    if (para.tokens.length === 1 || sources[visSrc[pos - 1]!]!.index!.sentenceEnd[visFlat[pos - 1]!] === 1) sentenceStarts.push(pos);
    src.positionOf[f] = pos;
    tokens.push(d);
    visSrc.push(src.order);
    visFlat.push(f);
    visSeq.push(seq);
    pos++;
  }
  flushPara();

  // ---- suggestion views ----
  const views: SuggestionView[] = work.map((w) => {
    let firstPosition = -1;
    let lastPosition = -1;
    if (w.first >= 0) {
      const p = w.src.positionOf;
      for (let f = w.first; f <= w.last; f++) {
        const at = p[f]!;
        if (at < 0) continue;
        if (firstPosition < 0 || at < firstPosition) firstPosition = at;
        if (at > lastPosition) lastPosition = at;
      }
    }
    const index = w.src.index;
    return {
      suggestion: w.s,
      state: w.state,
      first: w.first >= 0 ? index!.addresses[w.first]! : null,
      last: w.last >= 0 ? index!.addresses[w.last]! : null,
      firstPosition,
      lastPosition,
    };
  });
  views.sort((a, b) => {
    const pa = a.firstPosition < 0 ? Number.POSITIVE_INFINITY : a.firstPosition;
    const pb = b.firstPosition < 0 ? Number.POSITIVE_INFINITY : b.firstPosition;
    if (pa !== pb) return pa - pb;
    return a.suggestion.range.start - b.suggestion.range.start;
  });

  return {
    input,
    hideCut,
    blocks,
    tokens,
    suggestions: views,
    internals: {
      ctx,
      sources,
      byId,
      visSrc: Int32Array.from(visSrc),
      visFlat: Int32Array.from(visFlat),
      seqTime: Float64Array.from(visSeq),
      streamSrc: Int32Array.from(streamSrc),
      streamFlat: Int32Array.from(streamFlat),
      paragraphStarts: Int32Array.from(paragraphStarts),
      sentenceStarts: Int32Array.from(sentenceStarts),
      blocksByKey,
    },
  };
}

// ---- addresses and document order ----------------------------------------------------

/** Internal: the source data and flat index of an address in this layout, or null. */
export function resolveAddress(layout: TranscriptLayout, address: TokenAddress): { src: SourceData; flat: number } | null {
  const src = layout.internals.byId.get(address.sourceId);
  if (!src || !src.index) return null;
  const flat = flatOf(src.index, address);
  return flat < 0 ? null : { src, flat };
}

/** A token's position in document order, or -1 when it is not shown (hidden cut text, unknown address). */
export function positionOf(layout: TranscriptLayout, address: TokenAddress): number {
  const r = resolveAddress(layout, address);
  return r ? r.src.positionOf[r.flat]! : -1;
}

/**
 * The caret boundary at a token: its position when shown, or, for hidden cut text, the
 * boundary where it would be. -1 for an unknown address.
 */
export function boundaryOf(layout: TranscriptLayout, address: TokenAddress): number {
  const r = resolveAddress(layout, address);
  if (!r || r.src.streamOf[r.flat]! < 0) return -1;
  return r.src.boundaryOf[r.flat]!;
}

/** The token shown at a document position, or null outside 0..tokens.length-1. */
export function addressAt(layout: TranscriptLayout, position: number): TokenAddress | null {
  return layout.tokens[position]?.address ?? null;
}

/** The token an address names, or null. */
export function tokenOf(layout: TranscriptLayout, address: TokenAddress): Token | null {
  const r = resolveAddress(layout, address);
  return r ? r.src.index!.tokens[r.flat]! : null;
}

/** The sequence time of the token at a document position, or null when it is cut. */
export function sequenceTimeAt(layout: TranscriptLayout, position: number): SequenceTime | null {
  const t = layout.internals.seqTime[position];
  return t === undefined || Number.isNaN(t) ? null : t;
}

/** A string key for an address, for Maps and React keys. */
export function addressKey(address: TokenAddress): string {
  return `${address.sourceId}:${address.utterance}:${address.token}`;
}

/** Whether two addresses name the same token. */
export function sameAddress(a: TokenAddress | null, b: TokenAddress | null): boolean {
  if (a === null || b === null) return a === b;
  return a.sourceId === b.sourceId && a.utterance === b.utterance && a.token === b.token;
}

/**
 * Document order over addresses (negative: `a` first). Tokens of the layout compare by
 * where they are shown (hidden cut text by where it would be); unknown addresses come last,
 * ordered by source, utterance and token.
 */
export function compareAddresses(layout: TranscriptLayout, a: TokenAddress, b: TokenAddress): number {
  const ba = boundaryOf(layout, a);
  const bb = boundaryOf(layout, b);
  if (ba >= 0 && bb >= 0 && ba !== bb) return ba - bb;
  if (ba >= 0 && bb < 0) return -1;
  if (ba < 0 && bb >= 0) return 1;
  const ra = resolveAddress(layout, a);
  const rb = resolveAddress(layout, b);
  if (ra && rb) return ra.src.streamOf[ra.flat]! - rb.src.streamOf[rb.flat]!;
  if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
  return a.utterance - b.utterance || a.token - b.token;
}
