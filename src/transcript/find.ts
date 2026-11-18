/**
 * Find (`Ctrl+F`, spec 1.8 rule 10): case-insensitive search over kept and cut text, in
 * playing order. Phrases may span tokens; punctuation differences are ignored ("its" finds
 * "it's", "sign on" finds "sign-on"); pauses and unrecognised speech are skipped over.
 *
 * Cut text is searched even when it is hidden (`H`). A match on hidden tokens is reported with
 * `hidden: true`; its `from` / `to` are then the caret boundaries where the hidden text sits
 * (equal when all of it is hidden), and `first` / `last` name its tokens, so the view can
 * show cut text again and select the match there (`positionOf` on the new layout).
 */
import type { TranscriptLayout } from "./layout";
import type { TokenAddress } from "./sourceIndex";
import { normaliseForSearch } from "./text";

/**
 * One match. `[from, to)` are document positions of its tokens, usable as a `TextSelection`
 * via `{ anchor: from, focus: to }`; for a match that is partly or wholly hidden they are the
 * boundaries around what is shown of it.
 */
export interface FindMatch {
  readonly from: number;
  readonly to: number;
  /** True when some of the match's tokens are hidden cut text. */
  readonly hidden: boolean;
  /** The match's first and last tokens. */
  readonly first: TokenAddress;
  readonly last: TokenAddress;
}

interface SearchText {
  text: string;
  /** Per word chunk: its character offset in `text`, and its source (index) and flat token. */
  charStart: Int32Array;
  src: Int32Array;
  flat: Int32Array;
}

/** The search text over the full stream (kept and cut, hidden or not), built once per layout. */
function searchText(layout: TranscriptLayout): SearchText {
  const cached = layout.internals.findCache as SearchText | undefined;
  if (cached) return cached;
  const { streamSrc, streamFlat, sources } = layout.internals;
  const parts: string[] = [];
  const charStart: number[] = [];
  const srcOf: number[] = [];
  const flatOf: number[] = [];
  let length = 0;
  for (let k = 0; k < streamFlat.length; k++) {
    const f = streamFlat[k]!;
    if (f < 0) continue; // a block with no text
    const s = streamSrc[k]!;
    const norm = sources[s]!.index!.norm[f]!;
    if (norm === "") continue;
    if (parts.length > 0) length += 1; // the space between words
    charStart.push(length);
    srcOf.push(s);
    flatOf.push(f);
    parts.push(norm);
    length += norm.length;
  }
  const built: SearchText = {
    text: parts.join(" "),
    charStart: Int32Array.from(charStart),
    src: Int32Array.from(srcOf),
    flat: Int32Array.from(flatOf),
  };
  layout.internals.findCache = built;
  return built;
}

/** The chunk holding character `c`: the last chunk starting at or before it. */
function chunkAt(st: SearchText, c: number): number {
  let lo = 0;
  let hi = st.charStart.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (st.charStart[mid]! <= c) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Every match of `query` in document order, not overlapping. An empty query (or only punctuation) finds nothing. */
export function findInTranscript(layout: TranscriptLayout, query: string): FindMatch[] {
  const q = normaliseForSearch(query);
  if (q === "") return [];
  const st = searchText(layout);
  const { sources, streamSrc, streamFlat } = layout.internals;
  const out: FindMatch[] = [];
  let from = 0;
  for (;;) {
    const c = st.text.indexOf(q, from);
    if (c < 0) break;
    const a = chunkAt(st, c);
    const b = chunkAt(st, c + q.length - 1);
    const srcA = sources[st.src[a]!]!;
    const srcB = sources[st.src[b]!]!;
    const fa = st.flat[a]!;
    const fb = st.flat[b]!;
    // Every token of the stream between the first and last word (pauses included) is part of the match.
    let hidden = false;
    for (let k = srcA.streamOf[fa]!; k <= srcB.streamOf[fb]!; k++) {
      const f = streamFlat[k]!;
      if (f >= 0 && sources[streamSrc[k]!]!.positionOf[f]! < 0) {
        hidden = true;
        break;
      }
    }
    const lastPos = srcB.positionOf[fb]!;
    out.push({
      from: srcA.boundaryOf[fa]!,
      to: lastPos >= 0 ? lastPos + 1 : srcB.boundaryOf[fb]!,
      hidden,
      first: srcA.index!.addresses[fa]!,
      last: srcB.index!.addresses[fb]!,
    });
    from = c + q.length;
  }
  return out;
}

/** The first match after the caret boundary (going round to the first), or null: for "jump to next match". */
export function nextMatch<M extends Pick<FindMatch, "from">>(matches: readonly M[], boundary: number): M | null {
  return matches.find((m) => m.from > boundary) ?? matches[0] ?? null;
}

/** The last match before the caret boundary (going round to the last), or null. */
export function previousMatch<M extends Pick<FindMatch, "from">>(matches: readonly M[], boundary: number): M | null {
  for (let i = matches.length - 1; i >= 0; i--) if (matches[i]!.from < boundary) return matches[i]!;
  return matches[matches.length - 1] ?? null;
}
