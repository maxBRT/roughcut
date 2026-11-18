/**
 * Review tests (track transcript-review): each one shows a defect found in review. They are
 * expected to fail until the transcript module is fixed.
 */
import { describe, expect, it } from "vitest";
import { createEditDocument, cutRanges, moveClip, splitAt } from "../edit";
import type { Suggestion, Transcript } from "../types";
import { findInTranscript } from "./find";
import { layoutTranscript } from "./layout";
import { nextPendingSuggestion } from "./lookup";
import { markToRanges, selectionToRanges, selectTokens } from "./selection";
import { fixture, inputOf, MS } from "./testing.test-helpers";

describe("review: I / O marks in silence with no token", () => {
  it("a mark in the trailing silence after the last word does not swallow that word or run to the source end", () => {
    // One word at 0.4-0.72 s, source 60 s long, transcript complete.
    const f = fixture([{ id: "a", paragraphs: ["hello"], durationMs: 60_000 }]);
    const l = layoutTranscript(inputOf(f));
    const word = l.tokens[0]!.token;
    const ranges = markToRanges(l, { sourceId: "a", at: 40_000 * MS }, { sourceId: "a", at: 45_000 * MS });
    // Marked 40 s..45 s of silence. Expected: about that span, not the word and not 15 s more.
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.start).toBeGreaterThanOrEqual(word.end);
    expect(ranges[0]!.end).toBeLessThan(60_000 * MS);
  });

  it("a mark in the leading silence before the first word does not run up to that word", () => {
    // First word at 30 s: build a transcript by hand.
    const f = fixture([{ id: "a", paragraphs: ["x"], durationMs: 60_000 }]);
    const t: Transcript = {
      schemaVersion: 1,
      sourceId: "a",
      model: "test",
      complete: true,
      utterances: [{ index: 0, start: 30_000 * MS, end: 30_320 * MS, tokens: [{ kind: "word", text: "late", start: 30_000 * MS, end: 30_320 * MS, cutBefore: 29_960 * MS }] }],
    };
    f.transcripts = { a: t };
    const l = layoutTranscript(inputOf(f));
    const ranges = markToRanges(l, { sourceId: "a", at: 5_000 * MS }, { sourceId: "a", at: 10_000 * MS });
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.end).toBeLessThanOrEqual(10_000 * MS + 1_000 * MS);
  });
});

describe("review: I / O marks as source positions with reordered clips", () => {
  it("covers what plays between the marks, not the source span between them", () => {
    const f = fixture([{ id: "a", paragraphs: ["one two three four five six"] }]);
    const l0 = layoutTranscript(inputOf(f));
    const four = l0.tokens[3]!.token;
    f.doc = splitAt(f.doc, f.ctx, four.cutBefore); // [one two three] [four five six]
    f.doc = moveClip(f.doc, f.ctx, f.doc.current.clips[1]!.id, "earlier"); // plays: four five six | one two three
    const l = layoutTranscript(inputOf(f));
    const five = l0.tokens[4]!.token;
    const two = l0.tokens[1]!.token;
    // I pressed while "five" plays (first in the sequence), O while "two" plays (later).
    // What played between them: "five six" and "one two". Neither "three" nor "four" played between.
    const ranges = markToRanges(l, { sourceId: "a", at: five.start + 10 * MS }, { sourceId: "a", at: two.start + 10 * MS });
    const covers = (t: { start: number; end: number }) => ranges.some((r) => r.start <= t.start && t.end <= r.end);
    expect(covers(l0.tokens[2]!.token)).toBe(false); // "three" was not between the marks
    expect(covers(l0.tokens[3]!.token)).toBe(false); // "four" was not between the marks
    expect(covers(l0.tokens[5]!.token)).toBe(true); // "six" was
    expect(covers(l0.tokens[0]!.token)).toBe(true); // "one" was
  });
});

describe("review: suggestion navigation from the very start", () => {
  it("N from the caret at the start of the document reaches a suggestion on the first token", () => {
    const f = fixture([{ id: "a", paragraphs: ["uh so hello there friends"] }]);
    const l0 = layoutTranscript(inputOf(f));
    const range = selectionToRanges(l0, selectTokens(l0, 0, 0))[0]!;
    const s: Suggestion = { id: "s0", kind: "false_start", origin: "claude", range, reason: "False start" };
    f.suggestions = [s];
    const l = layoutTranscript(inputOf(f));
    expect(l.suggestions[0]!.firstPosition).toBe(0);
    expect(nextPendingSuggestion(l, 0)?.suggestion.id).toBe("s0");
  });
});

describe("review: a source whose complete transcript has no words", () => {
  it("still gets a header line (spec 1.8: each source gets a header line)", () => {
    const f = fixture([
      { id: "a", paragraphs: ["Hello there."] },
      { id: "b", durationMs: 5_000 },
    ]);
    f.transcripts = { ...f.transcripts, b: { schemaVersion: 1, sourceId: "b", model: "test", complete: true, utterances: [] } };
    f.doc = createEditDocument(f.doc.current.clips);
    const l = layoutTranscript(inputOf(f));
    expect(l.blocks.filter((b) => b.kind === "source").map((b) => b.sourceId)).toEqual(["a", "b"]);
  });
});

describe("review: find with cut text hidden", () => {
  it("still finds cut text (spec 1.8 rule 10: Ctrl+F searches kept and cut text)", () => {
    const f = fixture([{ id: "a", paragraphs: ["keep this cut that"] }]);
    const l0 = layoutTranscript(inputOf(f));
    // Cut "cut that" and hide cut text.
    f.doc = cutRanges(f.doc, f.ctx, selectionToRanges(l0, selectTokens(l0, 2, 3)));
    const hidden = layoutTranscript(inputOf(f, true));
    expect(findInTranscript(hidden, "cut that").length).toBeGreaterThan(0);
  });
});
