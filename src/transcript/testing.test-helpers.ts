/**
 * Small hand-made transcripts for the transcript tests. 25 frames per second, so the grid is
 * every 40 ms. Each word takes a 400 ms slot: spoken for 320 ms, then 80 ms of gap; a word's
 * `cutBefore` is 40 ms before it starts (the middle of the gap, on the grid). `[pause]` is a
 * 1.2 s pause chip, `[?]` 800 ms of unrecognised speech. Paragraphs are 400 ms apart.
 */
import type { EditContext } from "../edit";
import { contextFromProject, createEditDocument } from "../edit";
import type { EditDocument, MediaInfo, Rational, SourceRef, Suggestion, Token, Transcript, Utterance } from "../types";
import type { LayoutInput } from "./layout";

export const RATE: Rational = { num: 25, den: 1 };
export const MS = 1000;

/** A transcript from paragraphs of space-separated words. */
export function makeTranscript(sourceId: string, paragraphs: readonly string[], complete = true): Transcript {
  let t = 400 * MS;
  const utterances: Utterance[] = paragraphs.map((text, index) => {
    const tokens: Token[] = [];
    for (const w of text.split(/\s+/).filter(Boolean)) {
      const cutBefore = t - 40 * MS;
      if (w === "[pause]") {
        tokens.push({ kind: "pause", start: t, end: t + 1200 * MS, cutBefore });
        t += 1280 * MS;
      } else if (w === "[?]") {
        tokens.push({ kind: "unrecognised", start: t, end: t + 800 * MS, cutBefore });
        t += 880 * MS;
      } else {
        tokens.push({ kind: "word", text: w, start: t, end: t + 320 * MS, cutBefore });
        t += 400 * MS;
      }
    }
    t += 400 * MS;
    return { index, start: tokens[0]!.start, end: tokens[tokens.length - 1]!.end, tokens };
  });
  return { schemaVersion: 1, sourceId, model: "test", complete, utterances };
}

/** The end of a transcript's last token. */
export function lastEnd(t: Transcript): number {
  const u = t.utterances[t.utterances.length - 1]!;
  return u.tokens[u.tokens.length - 1]!.end;
}

function media(duration: number): MediaInfo {
  return {
    duration,
    container: "mov,mp4",
    video: { codec: "h264", width: 1920, height: 1080, frameRate: RATE, variableFrameRate: false, bitDepth: 8, hdr: false },
    audioTracks: [{ index: 0, codec: "aac", channels: 2, sampleRate: 48000 }],
    speechTrack: 0,
    directPlayable: true,
  };
}

/** A source reference with a duration. */
export function sourceRef(id: string, duration: number): SourceRef {
  return { id, path: `D:\\Footage\\${id.toUpperCase()}.mp4`, addedAt: "2026-11-13T09:00:00Z", media: media(duration) };
}

/** A small project: sources with transcripts (null = none yet) and a duration each, one clip per source. */
export interface Fixture {
  sources: SourceRef[];
  transcripts: Record<string, Transcript | null>;
  ctx: EditContext;
  doc: EditDocument;
  suggestions: Suggestion[];
}

/** Builds a fixture; each source lasts `durationMs` or, by default, until 1 s after its last token. */
export function fixture(spec: { id: string; paragraphs?: readonly string[]; complete?: boolean; durationMs?: number }[]): Fixture {
  const transcripts: Record<string, Transcript | null> = {};
  const sources: SourceRef[] = spec.map((s) => {
    const t = s.paragraphs ? makeTranscript(s.id, s.paragraphs, s.complete ?? true) : null;
    transcripts[s.id] = t;
    const duration = s.durationMs !== undefined ? s.durationMs * MS : t ? lastEnd(t) + 1000 * MS : 10_000 * MS;
    return sourceRef(s.id, duration);
  });
  const ctx = contextFromProject({ frameRate: RATE, sources });
  const clips = sources.map((s, i) => ({ id: `clip-${i + 1}`, sourceId: s.id, start: 0, end: Math.floor(s.media.duration / 40_000) * 40_000 }));
  return { sources, transcripts, ctx, doc: createEditDocument(clips), suggestions: [] };
}

/** The layout input of a fixture's current state. */
export function inputOf(f: Fixture, hideCut = false): LayoutInput {
  return { frameRate: RATE, sources: f.sources, transcripts: f.transcripts, edit: f.doc.current, suggestions: f.suggestions, hideCut };
}
