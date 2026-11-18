/**
 * An hour of speech (10 000 tokens in 600 utterances) stays fast: a layout after an edit is
 * well within a frame, and lookups are binary searches. The measured medians are printed.
 */
import { describe, expect, it } from "vitest";
import { cutRanges } from "../edit";
import type { EditDocument } from "../types";
import { findInTranscript } from "./find";
import { layoutTranscript } from "./layout";
import type { TranscriptLayout } from "./layout";
import { captionAt, tokenAtSource } from "./lookup";
import { moveCaret, selectionToRanges, selectTokens } from "./selection";
import { fixture, inputOf } from "./testing.test-helpers";

function median(fn: () => unknown, runs = 21): number {
  fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

const WORDS = ["so", "the", "first", "thing", "you'll", "notice", "is", "the", "new", "signup", "form,", "which", "is", "down", "to", "two", "fields."];

function hourOfSpeech() {
  const paragraphs: string[] = [];
  let n = 0;
  for (let u = 0; u < 600; u++) {
    const count = u % 3 === 0 ? 17 : 16; // 200 x 17 + 400 x 16 = 9 800 words, plus 200 pauses below
    const words: string[] = [];
    for (let i = 0; i < count; i++) words.push(WORDS[(n++ + u) % WORDS.length]!);
    if (u % 3 === 1) words.push("[pause]");
    paragraphs.push(words.join(" "));
  }
  return fixture([{ id: "a", paragraphs }]);
}

describe("an hour of speech", () => {
  const f = hourOfSpeech();
  const t0 = performance.now();
  const first = layoutTranscript(inputOf(f));
  const cold = performance.now() - t0;
  // 150 cuts spread over the hour: 151 clips.
  const ranges = [];
  for (let i = 0; i < 150; i++) {
    const p = 30 + i * 66;
    ranges.push(...selectionToRanges(first, selectTokens(first, p, p + 2)));
  }
  const cutDoc: EditDocument = cutRanges(f.doc, f.ctx, ranges);
  const base = layoutTranscript(inputOf({ ...f, doc: cutDoc }), first);

  it("has 10 000 tokens in 600 paragraphs", () => {
    expect(first.tokens).toHaveLength(10_000);
    expect(first.blocks.filter((b) => b.kind === "paragraph")).toHaveLength(600);
    expect(cutDoc.current.clips).toHaveLength(151);
  });

  it("lays out again after an edit within a frame, reusing what did not change", () => {
    let prev: TranscriptLayout = base;
    let k = 0;
    const docs = [5000, 5100, 5200, 5300].map((p) => cutRanges(cutDoc, f.ctx, selectionToRanges(base, selectTokens(base, p, p))));
    const afterEdit = median(() => {
      const doc = docs[k++ % docs.length]!;
      prev = layoutTranscript(inputOf({ ...f, doc }), prev);
    });
    const toggled = median(() => layoutTranscript(inputOf({ ...f, doc: cutDoc }, true), base)); // base shows cut text
    // Blocks before the edit are the same objects as before.
    const next = layoutTranscript(inputOf({ ...f, doc: docs[0]! }), base);
    expect(next.blocks[1]).toBe(base.blocks[1]);
    expect(next.blocks[100]).toBe(base.blocks[100]);
    console.log(`transcript layout, 10 000 tokens / 151 clips: cold ${cold.toFixed(1)} ms, after an edit ${afterEdit.toFixed(2)} ms (median), hide-cut toggle ${toggled.toFixed(2)} ms (median)`);
    expect(afterEdit).toBeLessThan(16);
    expect(toggled).toBeLessThan(16);
  });

  it("answers selection, find, caret and playhead questions quickly", () => {
    const sel = median(() => selectionToRanges(base, selectTokens(base, 100, 9_900)));
    const find = median(() => findInTranscript(layoutTranscript(inputOf({ ...f, doc: cutDoc }), null), "the new signup"));
    const findCached = median(() => findInTranscript(base, "the new signup"));
    const lookups = median(() => {
      for (let i = 0; i < 1000; i++) tokenAtSource(base, { sourceId: "a", at: i * 3_600_000 });
    });
    const caption = median(() => captionAt(base, { sourceId: "a", at: 1_800_000_000 }));
    const caret = median(() => moveCaret(base, { anchor: 5000, focus: 5000 }, "sentenceNext"));
    console.log(
      `selection->ranges (9 800 tokens) ${sel.toFixed(2)} ms, find incl. layout ${find.toFixed(2)} ms, find cached ${findCached.toFixed(2)} ms, 1000 playhead lookups ${lookups.toFixed(2)} ms, caption ${caption.toFixed(3)} ms, caret ${caret.toFixed(3)} ms`,
    );
    expect(findInTranscript(base, "the new signup").length).toBeGreaterThan(100);
    expect(sel).toBeLessThan(16);
    expect(findCached).toBeLessThan(16);
    expect(lookups).toBeLessThan(16);
    expect(caption).toBeLessThan(2);
    expect(caret).toBeLessThan(2);
  });
});
