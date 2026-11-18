/**
 * The stand-in core's seeded demo dataset: a transcript of a talking-head recording with
 * consistent, increasing times and cut points, a `SuggestionSet` that refers to real
 * ranges in it, and plausible `MediaInfo`.
 *
 * Everything is deterministic: the same source id always gives the same data.
 */
import type {
  MediaInfo,
  Micros,
  Project,
  Rational,
  SourceId,
  SourceRef,
  Suggestion,
  SuggestionSet,
  Token,
  Transcript,
  Utterance,
} from "../../types";
import {
  frameToMicros as sharedFrameToMicros,
  microsToFrameFloor,
  snapToFrame as sharedSnapToFrame,
} from "../../types";
import { DEMO_SCRIPT, DEMO_SUGGESTION_SPECS } from "./demoScript";

export const DEMO_FRAME_RATE: Rational = { num: 30000, den: 1001 };
export const DEMO_SPEECH_MODEL = "parakeet-tdt-0.6b-v2 (stand-in)";
export const DEMO_CLAUDE_MODEL = "opus";

const MS = 1000;

/** Whole microseconds of frame `k` on the grid of `rate` (the shared definition, `types/grid.ts`). */
export function frameToMicros(k: number, rate: Rational = DEMO_FRAME_RATE): Micros {
  return sharedFrameToMicros(k, rate);
}

/** The frame boundary nearest `t` (the shared definition, `types/grid.ts`). */
export function snapToFrame(t: Micros, rate: Rational = DEMO_FRAME_RATE): Micros {
  return sharedSnapToFrame(t, rate);
}

/** A frame boundary inside [a, b] near the middle (the "quietest point of the gap", spec 2.4.5). */
function cutInGap(a: Micros, b: Micros): Micros {
  const mid = Math.round((a + b) / 2);
  const k = microsToFrameFloor(mid, DEMO_FRAME_RATE);
  for (const kk of [k, k + 1, k - 1]) {
    const t = frameToMicros(kk);
    if (t >= a && t <= b) return t;
  }
  return mid;
}

/** Small deterministic random numbers (mulberry32). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEAD_AIR_UTTERANCES = new Set(
  DEMO_SUGGESTION_SPECS.filter((s) => s.kind === "dead_air").map((s) => s.firstUtterance),
);

interface Built {
  utterances: Utterance[];
  duration: Micros;
}

let cached: Built | undefined;

/** Lays out the demo script in time once; per-source copies only change the id. */
function build(): Built {
  if (cached) return cached;
  const rand = rng(20261113);
  const between = (lo: number, hi: number) => Math.round(lo + (hi - lo) * rand());

  const utterances: Utterance[] = [];
  let prevEnd: Micros = 0; // end of the previous token (0 = start of file)
  let t: Micros = 1_200 * MS; // first word starts 1.2 s in

  DEMO_SCRIPT.forEach((line, index) => {
    const pauseAfter = line.endsWith(" //P");
    const text = pauseAfter ? line.slice(0, -4) : line;
    const tokens: Token[] = [];

    for (const raw of text.split(/\s+/).filter(Boolean)) {
      if (raw === "[?]") {
        const start = t;
        const end = start + between(1_300, 1_700) * MS;
        tokens.push({ kind: "unrecognised", start, end, cutBefore: cutInGap(prevEnd, start) });
        prevEnd = end;
        t = end + between(90, 160) * MS;
        continue;
      }
      const letters = raw.replace(/[^\p{L}\p{N}]/gu, "").length;
      const start = t;
      const dur = Math.max(110, Math.round((90 + 55 * letters) * (0.85 + 0.3 * rand()))) * MS;
      const end = start + dur;
      tokens.push({ kind: "word", text: raw, start, end, cutBefore: cutInGap(prevEnd, start) });
      prevEnd = end;
      // gap after the word: longer after punctuation
      let gap = between(60, 140);
      if (/[,;:]$/.test(raw)) gap += between(120, 220);
      if (/[.?!]$/.test(raw)) gap += between(220, 380);
      t = end + gap * MS;
    }

    if (pauseAfter) {
      const silence = DEAD_AIR_UTTERANCES.has(index) ? between(3_100, 3_700) : between(1_200, 2_100);
      const start = prevEnd + between(100, 160) * MS;
      const end = start + silence * MS;
      tokens.push({ kind: "pause", start, end, cutBefore: cutInGap(prevEnd, start) });
      prevEnd = end;
      t = end + between(100, 180) * MS;
    } else {
      t += between(250, 600) * MS; // ordinary gap between paragraphs
    }

    const first = tokens[0];
    const last = tokens[tokens.length - 1];
    if (!first || !last) throw new Error(`demo utterance ${index} is empty`);
    // Utterance.index starts at 1 (spec 3.4), like the core's transcripts.
    utterances.push({ index: index + 1, start: first.start, end: last.end, tokens });
  });

  const duration = snapToFrame(prevEnd + 1_500 * MS);
  cached = { utterances, duration };
  return cached;
}

/** Length of the demo recording. */
export function demoDuration(): Micros {
  return build().duration;
}

/** The complete demo transcript, for `sourceId`. */
export function demoTranscript(sourceId: SourceId): Transcript {
  return {
    schemaVersion: 1,
    sourceId,
    model: DEMO_SPEECH_MODEL,
    complete: true,
    utterances: structuredClone(build().utterances),
  };
}

/** The demo utterances split into `batches` roughly equal groups, as a transcriber would stream them. */
export function demoTranscriptBatches(batches: number): Utterance[][] {
  const all = build().utterances;
  const size = Math.ceil(all.length / batches);
  const out: Utterance[][] = [];
  for (let i = 0; i < all.length; i += size) out.push(structuredClone(all.slice(i, i + size)));
  return out;
}

interface FlatToken {
  token: Token;
  utterance: number;
}

function flatTokens(utterances: Utterance[]): FlatToken[] {
  // `utterance` is the position in the list, which DEMO_SUGGESTION_SPECS refers to.
  return utterances.flatMap((u, pos) => u.tokens.map((token) => ({ token, utterance: pos })));
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/** Where a cut that removes tokens [i, j] (inclusive) ends: the next token's cut point, or just past the last token. */
function rangeEndAfter(flat: FlatToken[], j: number, duration: Micros): Micros {
  const next = flat[j + 1];
  if (next) return next.token.cutBefore;
  const last = flat[j];
  if (!last) return duration;
  return Math.min(duration, cutInGap(last.token.end, Math.min(duration, last.token.end + 600 * MS)));
}

/**
 * The demo `SuggestionSet` for `sourceId`. With `includeClaude` false, only the dead air
 * found locally (the first `suggestions_ready` of an import).
 */
export function demoSuggestions(sourceId: SourceId, includeClaude = true): SuggestionSet {
  const { utterances, duration } = build();
  const flat = flatTokens(utterances);
  const suggestions: Suggestion[] = [];

  DEMO_SUGGESTION_SPECS.forEach((spec, n) => {
    if (spec.kind !== "dead_air" && !includeClaude) return;
    const id = `${sourceId}-s${n + 1}`;
    if (spec.kind === "dead_air") {
      const i = flat.findIndex((f) => f.utterance === spec.firstUtterance && f.token.kind === "pause");
      const pause = flat[i];
      if (!pause) throw new Error(`demo dead air: no pause in utterance ${spec.firstUtterance}`);
      suggestions.push({
        id,
        kind: "dead_air",
        origin: "local",
        range: { sourceId, start: pause.token.cutBefore, end: rangeEndAfter(flat, i, duration) },
        reason: spec.reason,
      });
      return;
    }
    // Locate the quote among the words of the named utterances (pauses are skipped, as the core does).
    const words = flat
      .map((f, i) => ({ ...f, i }))
      .filter(
        (f) =>
          f.utterance >= spec.firstUtterance && f.utterance <= spec.lastUtterance && f.token.kind === "word",
      );
    const quote = spec.quote.split(/\s+/).map(norm);
    let found = -1;
    for (let s = 0; s + quote.length <= words.length; s++) {
      if (quote.every((q, k) => {
        const w = words[s + k];
        return w !== undefined && w.token.kind === "word" && norm(w.token.text) === q;
      })) {
        found = s;
        break;
      }
    }
    const firstWord = words[found];
    const lastWord = words[found + quote.length - 1];
    if (found < 0 || !firstWord || !lastWord) throw new Error(`demo suggestion ${n + 1}: quote not found`);
    const suggestion: Suggestion = {
      id,
      kind: spec.kind,
      origin: "claude",
      range: { sourceId, start: firstWord.token.cutBefore, end: rangeEndAfter(flat, lastWord.i, duration) },
      reason: spec.reason,
    };
    if (spec.kind === "retake" && spec.keepUtterance !== undefined) {
      const keep = utterances[spec.keepUtterance];
      if (keep) suggestion.keptVersionAt = keep.start;
    }
    suggestions.push(suggestion);
  });

  const set: SuggestionSet = { schemaVersion: 1, sourceId, suggestions };
  if (includeClaude) set.claudeModel = DEMO_CLAUDE_MODEL;
  return set;
}

/** Plausible probe results. `.mkv` is not playable before the proxy exists; `.mov` is HEVC 10-bit HDR. */
export function fabricateMediaInfo(path: string, duration: Micros = demoDuration()): MediaInfo {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const hevc = ext === "mov";
  return {
    duration,
    container: ext === "mkv" ? "matroska,webm" : "mov,mp4,m4a,3gp,3g2,mj2",
    video: {
      codec: hevc ? "hevc" : "h264",
      width: 3840,
      height: 2160,
      frameRate: { ...DEMO_FRAME_RATE },
      variableFrameRate: false,
      bitDepth: hevc ? 10 : 8,
      hdr: hevc,
    },
    audioTracks: [{ index: 0, codec: "aac", channels: 2, sampleRate: 48000 }],
    speechTrack: 0,
    directPlayable: ext !== "mkv",
  };
}

/** A fingerprint-like id for a path (FNV-1a, 64 bits, hex). The stand-in has no file to read. */
export function fingerprintFor(path: string): SourceId {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export const DEMO_PROJECT_ID = "demo-weekly-update";
export const DEMO_SOURCE_PATH = "D:\\Footage\\TAKE-1.mp4";
export const DEMO_SOURCE_ID: SourceId = fingerprintFor(DEMO_SOURCE_PATH);

/** The seeded project: one source, fully imported, one clip covering it. */
export function demoProject(): Project {
  const duration = demoDuration();
  const source: SourceRef = {
    id: DEMO_SOURCE_ID,
    path: DEMO_SOURCE_PATH,
    addedAt: "2026-11-13T09:12:00.000Z",
    media: fabricateMediaInfo(DEMO_SOURCE_PATH, duration),
  };
  return {
    schemaVersion: 1,
    id: DEMO_PROJECT_ID,
    name: "Weekly update - Nov 13",
    createdAt: "2026-11-13T09:12:00.000Z",
    updatedAt: "2026-11-13T09:20:00.000Z",
    frameRate: { ...DEMO_FRAME_RATE },
    sources: [source],
    edit: {
      current: { clips: [{ id: "clip-1", sourceId: DEMO_SOURCE_ID, start: 0, end: duration }], dismissed: [] },
      undo: [],
      redo: [],
    },
    session: { view: "transcript", playhead: null, playbackRate: 1, cutTextHidden: false },
  };
}
