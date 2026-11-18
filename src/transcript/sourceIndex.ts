/**
 * Internal: one transcript flattened into parallel arrays (source order), built once per
 * `Transcript` object and cached. Every lookup by time is a binary search on these arrays.
 */
import type { Micros, SourceId, Token, Transcript } from "../types";
import { endsSentence, normaliseForSearch } from "./text";

/**
 * The stable address of a token: its source, the position of its utterance in
 * `Transcript.utterances` (for transcripts the core writes, the same number as
 * `Utterance.index`) and its position in that utterance's `tokens`.
 */
export interface TokenAddress {
  readonly sourceId: SourceId;
  readonly utterance: number;
  readonly token: number;
}

/** Internal: the flattened transcript of one source. */
export interface SourceIndex {
  readonly sourceId: SourceId;
  readonly transcript: Transcript;
  /** Number of tokens. */
  readonly count: number;
  readonly tokens: readonly Token[];
  readonly addresses: readonly TokenAddress[];
  readonly start: Float64Array;
  readonly end: Float64Array;
  readonly cutBefore: Float64Array;
  /** Utterance (array position) of each token. */
  readonly utt: Int32Array;
  /** Flat index of the first token of each utterance; length = utterances + 1. */
  readonly uttOffset: Int32Array;
  /** Searchable form of each word token ('' for pauses and unrecognised speech). */
  readonly norm: readonly string[];
  /** 1 when the token is a word that ends a sentence. */
  readonly sentenceEnd: Uint8Array;
  /** The furthest token end: how far the transcript reaches. */
  readonly extent: Micros;
}

const cache = new WeakMap<Transcript, SourceIndex>();

/** Internal: the (cached) index of a transcript. */
export function indexTranscript(transcript: Transcript): SourceIndex {
  const hit = cache.get(transcript);
  if (hit) return hit;
  const uttCount = transcript.utterances.length;
  let count = 0;
  for (const u of transcript.utterances) count += u.tokens.length;
  const tokens: Token[] = new Array<Token>(count);
  const addresses: TokenAddress[] = new Array<TokenAddress>(count);
  const start = new Float64Array(count);
  const end = new Float64Array(count);
  const cutBefore = new Float64Array(count);
  const utt = new Int32Array(count);
  const uttOffset = new Int32Array(uttCount + 1);
  const norm: string[] = new Array<string>(count);
  const sentenceEnd = new Uint8Array(count);
  const sourceId = transcript.sourceId;
  let i = 0;
  let extent = 0;
  for (let u = 0; u < uttCount; u++) {
    uttOffset[u] = i;
    const list = transcript.utterances[u]!.tokens;
    for (let t = 0; t < list.length; t++, i++) {
      const tok = list[t]!;
      tokens[i] = tok;
      addresses[i] = { sourceId, utterance: u, token: t };
      start[i] = tok.start;
      end[i] = tok.end;
      cutBefore[i] = tok.cutBefore;
      utt[i] = u;
      if (tok.kind === "word") {
        norm[i] = normaliseForSearch(tok.text);
        if (endsSentence(tok.text)) sentenceEnd[i] = 1;
      } else norm[i] = "";
      if (tok.end > extent) extent = tok.end;
    }
  }
  uttOffset[uttCount] = i;
  const index: SourceIndex = {
    sourceId,
    transcript,
    count,
    tokens,
    addresses,
    start,
    end,
    cutBefore,
    utt,
    uttOffset,
    norm,
    sentenceEnd,
    extent,
  };
  cache.set(transcript, index);
  return index;
}

/** Internal: the flat index of an address, or -1 when it names no token. */
export function flatOf(index: SourceIndex, address: TokenAddress): number {
  if (address.sourceId !== index.sourceId) return -1;
  const u = address.utterance;
  if (!Number.isInteger(u) || u < 0 || u >= index.uttOffset.length - 1) return -1;
  const first = index.uttOffset[u]!;
  const flat = first + address.token;
  if (!Number.isInteger(address.token) || address.token < 0 || flat >= index.uttOffset[u + 1]!) return -1;
  return flat;
}

/** Internal: the last index `i` with `arr[i] <= t`, or -1. */
export function lastAtOrBefore(arr: Float64Array, t: number, count = arr.length): number {
  let lo = 0;
  let hi = count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Internal: the first index `i` with `arr[i] >= t`, or `count`. */
export function firstAtOrAfter(arr: Float64Array, t: number, count = arr.length): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Internal: the first index `i` with `arr[i] > t`, or `count`. */
export function firstAfter(arr: Float64Array, t: number, count = arr.length): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
