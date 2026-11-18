/** Selections snap to whole tokens and map to the right source ranges; caret motions; I / O marks (spec 1.8, 3.7). */
import { describe, expect, it } from "vitest";
import { cutRanges, moveClip, restoreRanges, sameState, splitAt } from "../edit";
import type { TranscriptLayout } from "./layout";
import { layoutTranscript } from "./layout";
import {
  anchorSelection,
  caretAt,
  isCollapsed,
  markToRanges,
  moveCaret,
  resolveSelection,
  selectAll,
  selectedSpan,
  selectionToRanges,
  selectTokens,
  snapRangeToTokens,
} from "./selection";
import type { VisualLines } from "./selection";
import { fixture, inputOf, MS } from "./testing.test-helpers";

const tok = (l: TranscriptLayout, p: number) => l.tokens[p]!.token;

const project = () =>
  fixture([
    { id: "a", paragraphs: ["Hey everyone. Welcome back to the show.", "So uh the first thing. Is this."] },
    { id: "b", paragraphs: ["Okay screen share."] },
  ]);

describe("selection to source ranges", () => {
  it("runs from the first token's cutBefore to the next token's cutBefore", () => {
    const f = project();
    const l = layoutTranscript(inputOf(f));
    const ranges = selectionToRanges(l, selectTokens(l, 2, 4)); // "Welcome back to"
    expect(ranges).toEqual([{ sourceId: "a", start: tok(l, 2).cutBefore, end: tok(l, 5).cutBefore }]);
  });

  it("ends at the end of the source for a source's last token", () => {
    const f = project();
    const l = layoutTranscript(inputOf(f));
    const last = 13; // "this."
    expect(tok(l, last)).toMatchObject({ kind: "word", text: "this." });
    const sourceEnd = f.doc.current.clips[0]!.end;
    expect(selectionToRanges(l, selectTokens(l, last, last))).toEqual([{ sourceId: "a", start: tok(l, last).cutBefore, end: sourceEnd }]);
  });

  it("gives one range per source when the selection spans sources", () => {
    const f = project();
    const l = layoutTranscript(inputOf(f));
    const ranges = selectionToRanges(l, selectTokens(l, 11, 14));
    expect(ranges).toEqual([
      { sourceId: "a", start: tok(l, 11).cutBefore, end: f.doc.current.clips[0]!.end },
      { sourceId: "b", start: 0, end: tok(l, 15).cutBefore }, // b's first token: from the source start
    ]);
  });

  it("gives several ranges across reordered clips, and one across a split that plays in order", () => {
    const f = fixture([{ id: "a", paragraphs: ["one two three four five six"] }]);
    let l = layoutTranscript(inputOf(f));
    f.doc = splitAt(f.doc, f.ctx, tok(l, 3).cutBefore); // [one two three] [four five six]
    l = layoutTranscript(inputOf(f));
    expect(selectionToRanges(l, selectTokens(l, 1, 4))).toEqual([{ sourceId: "a", start: tok(l, 1).cutBefore, end: tok(l, 5).cutBefore }]);
    f.doc = moveClip(f.doc, f.ctx, f.doc.current.clips[1]!.id, "earlier"); // four five six one two three
    l = layoutTranscript(inputOf(f));
    const texts = l.tokens.map((t) => (t.token.kind === "word" ? t.token.text : ""));
    expect(texts).toEqual(["four", "five", "six", "one", "two", "three"]);
    const ranges = selectionToRanges(l, selectTokens(l, 2, 3)); // "six one"
    expect(ranges).toEqual([
      { sourceId: "a", start: 0, end: tok(l, 4).cutBefore }, // one, the source's first token
      { sourceId: "a", start: tok(l, 2).cutBefore, end: f.doc.current.clips[0]!.end }, // six, the source's last token
    ]);
  });

  it("a selection of every token covers the whole source, silence before the first word included", () => {
    const f = fixture([{ id: "a", paragraphs: ["one two three", "four five six"] }]);
    const l = layoutTranscript(inputOf(f));
    expect(tok(l, 0).cutBefore).toBeGreaterThan(0); // the first word is not at the very start
    const ranges = selectionToRanges(l, selectTokens(l, 0, l.tokens.length - 1));
    expect(ranges).toEqual([{ sourceId: "a", start: 0, end: f.doc.current.clips[0]!.end }]);
    f.doc = cutRanges(f.doc, f.ctx, ranges);
    expect(f.doc.current.clips).toEqual([]); // nothing kept, so Export is blocked (spec 1.12)
  });

  it("is empty for a caret", () => {
    const l = layoutTranscript(inputOf(project()));
    expect(selectionToRanges(l, caretAt(l, 3))).toEqual([]);
  });

  it("restores what it cut: cut then restore of the same selection changes nothing", () => {
    const f = project();
    const before = f.doc.current;
    const l = layoutTranscript(inputOf(f));
    const sel = selectTokens(l, 8, 9); // "uh the"
    f.doc = cutRanges(f.doc, f.ctx, selectionToRanges(l, sel));
    const cut = layoutTranscript(inputOf(f));
    expect(cut.tokens.slice(8, 10).map((t) => t.keep)).toEqual(["cut", "cut"]);
    expect(cut.tokens[7]!.keep).toBe("kept");
    expect(cut.tokens[10]!.keep).toBe("kept");
    f.doc = restoreRanges(f.doc, f.ctx, selectionToRanges(cut, sel));
    expect(sameState(f.doc.current, before)).toBe(true);
  });
});

describe("snapping to whole tokens", () => {
  it("selects every token between two pointer positions, keeping the direction", () => {
    const l = layoutTranscript(inputOf(project()));
    expect(selectTokens(l, 2, 4)).toEqual({ anchor: 2, focus: 5 });
    expect(selectTokens(l, 4, 2)).toEqual({ anchor: 5, focus: 2 });
    expect(selectTokens(l, 3, 3)).toEqual({ anchor: 3, focus: 4 });
    expect(selectTokens(l, -5, 999)).toEqual({ anchor: 0, focus: l.tokens.length });
    expect(selectedSpan({ anchor: 5, focus: 2 })).toEqual({ from: 2, to: 5 });
  });
});

describe("caret motions", () => {
  // Tokens: 0 Hey 1 everyone. 2 Welcome 3 back 4 to 5 the 6 show. | 7 So 8 uh 9 the 10 first 11 thing. 12 Is 13 this. | 14 Okay 15 screen 16 share.
  const f = fixture([
    { id: "a", paragraphs: ["Hey everyone. Welcome back to the show.", "So uh the first thing. Is this."] },
    { id: "b", paragraphs: ["Okay screen share."] },
  ]);
  const l = layoutTranscript(inputOf(f));
  const move = (b: number, m: Parameters<typeof moveCaret>[2]) => moveCaret(l, caretAt(l, b), m).focus;

  it("moves by token, clamped to the document", () => {
    expect(move(3, "tokenNext")).toBe(4);
    expect(move(3, "tokenPrev")).toBe(2);
    expect(move(0, "tokenPrev")).toBe(0);
    expect(move(17, "tokenNext")).toBe(17);
  });

  it("moves by sentence", () => {
    expect(move(3, "sentenceNext")).toBe(7);
    expect(move(0, "sentenceNext")).toBe(2);
    expect(move(3, "sentencePrev")).toBe(2);
    expect(move(2, "sentencePrev")).toBe(0);
    expect(move(12, "sentenceNext")).toBe(14);
    expect(move(16, "sentenceNext")).toBe(17);
  });

  it("moves by paragraph and to the start or end", () => {
    expect(move(3, "paragraphNext")).toBe(7);
    expect(move(7, "paragraphNext")).toBe(14);
    expect(move(14, "paragraphNext")).toBe(17);
    expect(move(9, "paragraphPrev")).toBe(7);
    expect(move(7, "paragraphPrev")).toBe(0);
    expect(move(9, "documentStart")).toBe(0);
    expect(move(9, "documentEnd")).toBe(17);
  });

  it("extends a selection, and collapses one on a plain token motion", () => {
    let s = moveCaret(l, caretAt(l, 3), "tokenNext", { extend: true });
    s = moveCaret(l, s, "sentenceNext", { extend: true });
    expect(s).toEqual({ anchor: 3, focus: 7 });
    expect(isCollapsed(s)).toBe(false);
    expect(moveCaret(l, s, "tokenPrev")).toEqual({ anchor: 3, focus: 3 });
    expect(moveCaret(l, s, "tokenNext")).toEqual({ anchor: 7, focus: 7 });
    expect(moveCaret(l, s, "paragraphNext")).toEqual({ anchor: 14, focus: 14 });
    expect(selectAll(l)).toEqual({ anchor: 0, focus: 17 });
  });

  it("uses the view's visual lines, and falls back to paragraphs without them", () => {
    const lines: VisualLines = {
      lineUp: (b) => b - 4,
      lineDown: (b) => b + 4,
      lineStart: (b) => b - (b % 4),
      lineEnd: (b) => b - (b % 4) + 4,
    };
    expect(moveCaret(l, caretAt(l, 9), "lineUp", { lines }).focus).toBe(5);
    expect(moveCaret(l, caretAt(l, 9), "lineDown", { lines }).focus).toBe(13);
    expect(moveCaret(l, caretAt(l, 9), "lineStart", { lines }).focus).toBe(8);
    expect(moveCaret(l, caretAt(l, 9), "lineEnd", { lines, extend: true })).toEqual({ anchor: 9, focus: 12 });
    expect(moveCaret(l, caretAt(l, 9), "lineStart").focus).toBe(7);
    expect(moveCaret(l, caretAt(l, 9), "lineEnd").focus).toBe(14);
  });
});

describe("selections across layouts", () => {
  it("are kept by token address when cut text is hidden or shown", () => {
    const f = project();
    const shown0 = layoutTranscript(inputOf(f));
    f.doc = cutRanges(f.doc, f.ctx, selectionToRanges(shown0, selectTokens(shown0, 8, 8))); // cut "uh"
    const shown = layoutTranscript(inputOf(f));
    const hidden = layoutTranscript(inputOf(f, true));
    const anchored = anchorSelection(shown, { anchor: 9, focus: 12 }); // "the first thing."
    expect(resolveSelection(hidden, anchored)).toEqual({ anchor: 8, focus: 11 });
    // A caret on the hidden "uh" lands where it would be.
    expect(resolveSelection(hidden, anchorSelection(shown, caretAt(shown, 8)))).toEqual({ anchor: 8, focus: 8 });
    // The end of the document stays the end.
    expect(resolveSelection(hidden, anchorSelection(shown, caretAt(shown, 17)))).toEqual({ anchor: 16, focus: 16 });
  });
});

describe("I / O marks to source ranges", () => {
  it("snaps two source positions outward to token boundaries", () => {
    const f = project();
    const l = layoutTranscript(inputOf(f));
    const markIn = { sourceId: "a", at: tok(l, 2).start + 100 * MS }; // inside "Welcome"
    const markOut = { sourceId: "a", at: tok(l, 4).start + 10 * MS }; // inside "to"
    expect(markToRanges(l, markOut, markIn)).toEqual([{ sourceId: "a", start: tok(l, 2).cutBefore, end: tok(l, 5).cutBefore }]);
  });

  it("splits sequence times across the clips that play between them", () => {
    const f = project();
    const l0 = layoutTranscript(inputOf(f));
    f.doc = cutRanges(f.doc, f.ctx, selectionToRanges(l0, selectTokens(l0, 4, 5))); // cut "to the"
    f.doc = moveClip(f.doc, f.ctx, f.doc.current.clips[1]!.id, "earlier"); // [show. ... a end] [Hey ... back] [b]
    const l = layoutTranscript(inputOf(f));
    const clips = f.doc.current.clips;
    const firstLen = clips[0]!.end - clips[0]!.start;
    const secondLen = clips[1]!.end - clips[1]!.start;
    // From the middle of the first clip's last paragraph word "Is" to inside source b's "screen".
    const isTok = l0.tokens[12]!.token;
    const screen = l0.tokens[15]!.token;
    const tIn = isTok.start - clips[0]!.start + 50 * MS;
    const tOut = firstLen + secondLen + (screen.start + 30 * MS);
    expect(markToRanges(l, tIn, tOut)).toEqual([
      { sourceId: "a", start: 0, end: clips[1]!.end }, // all of [Hey ... back], snapped down to the source start
      { sourceId: "a", start: isTok.cutBefore, end: clips[0]!.end },
      { sourceId: "b", start: 0, end: l0.tokens[16]!.token.cutBefore },
    ]);
  });

  it("uses positions raw where there is no transcript", () => {
    const f = fixture([
      { id: "a", paragraphs: ["one two three"], complete: false, durationMs: 20_000 },
      { id: "b", durationMs: 5_000 },
    ]);
    const l = layoutTranscript(inputOf(f));
    expect(markToRanges(l, { sourceId: "b", at: 1_234_567 }, { sourceId: "b", at: 2_000_001 })).toEqual([{ sourceId: "b", start: 1_234_567, end: 2_000_001 }]);
    // Past what a partial transcript reaches: raw; inside it: snapped.
    expect(markToRanges(l, { sourceId: "a", at: 5_000_000 }, { sourceId: "a", at: 6_000_000 })).toEqual([{ sourceId: "a", start: 5_000_000, end: 6_000_000 }]);
    const two = l.tokens[1]!.token;
    expect(snapRangeToTokens(l, { sourceId: "a", start: two.start + 1, end: 5_000_000 })).toEqual({ sourceId: "a", start: two.cutBefore, end: 5_000_000 });
  });

  it("uses marks in silence raw: never pulls in a word that ended before the mark, or runs to the source end", () => {
    const f = fixture([{ id: "a", paragraphs: ["one two", "three"], durationMs: 30_000 }]);
    const l = layoutTranscript(inputOf(f));
    const two = tok(l, 1);
    const three = tok(l, 2);
    // Start in the gap after "two" ended, end in the trailing silence after the last word.
    expect(markToRanges(l, { sourceId: "a", at: two.end + 20 * MS }, { sourceId: "a", at: 20_000 * MS })).toEqual([{ sourceId: "a", start: two.end + 20 * MS, end: 20_000 * MS }]);
    // End inside the last word: up to that word's end, not the end of the source.
    expect(markToRanges(l, { sourceId: "a", at: three.start + 10 * MS }, { sourceId: "a", at: three.start + 100 * MS })).toEqual([{ sourceId: "a", start: three.cutBefore, end: three.end }]);
    // Leading silence before the first word, ending exactly on a cut point: raw, no word included.
    expect(markToRanges(l, { sourceId: "a", at: 100 * MS }, { sourceId: "a", at: tok(l, 0).cutBefore })).toEqual([{ sourceId: "a", start: 100 * MS, end: tok(l, 0).cutBefore }]);
  });

  it("ends before a word when O is at the word's start (the caret before it), as found in the real app", () => {
    const f = fixture([{ id: "a", paragraphs: ["one two three four"] }]);
    const l = layoutTranscript(inputOf(f));
    const [one, , three, four] = [tok(l, 0), tok(l, 1), tok(l, 2), tok(l, 3)];
    // I at the start of "two"... O with the caret before "four": "two three" go, "four" stays.
    expect(markToRanges(l, { sourceId: "a", at: tok(l, 1).start }, { sourceId: "a", at: four.start })).toEqual([{ sourceId: "a", start: tok(l, 1).cutBefore, end: four.cutBefore }]);
    // O in the pause before "three" (after its cut point): "three" stays.
    expect(markToRanges(l, { sourceId: "a", at: one.start }, { sourceId: "a", at: three.cutBefore + 10 * MS })).toEqual([{ sourceId: "a", start: one.cutBefore, end: three.cutBefore }]);
    // O once "three" has started: it goes.
    expect(markToRanges(l, { sourceId: "a", at: one.start }, { sourceId: "a", at: three.start + 1 })).toEqual([{ sourceId: "a", start: one.cutBefore, end: four.cutBefore }]);
    // Both marks before the same word: nothing to cut.
    expect(markToRanges(l, { sourceId: "a", at: three.cutBefore + 5 * MS }, { sourceId: "a", at: three.start })).toEqual([]);
  });

  it("takes source-position marks in playing order when clips are reordered", () => {
    const f = fixture([{ id: "a", paragraphs: ["one two three four"] }]);
    const l0 = layoutTranscript(inputOf(f));
    f.doc = splitAt(f.doc, f.ctx, tok(l0, 2).cutBefore); // [one two] [three four]
    f.doc = moveClip(f.doc, f.ctx, f.doc.current.clips[1]!.id, "earlier"); // plays: three four | one two
    const l = layoutTranscript(inputOf(f));
    // I in "four", O in "one": what played between them is "four" and "one".
    expect(markToRanges(l, { sourceId: "a", at: tok(l0, 3).start + 10 * MS }, { sourceId: "a", at: tok(l0, 0).start + 10 * MS })).toEqual([
      { sourceId: "a", start: 0, end: tok(l0, 1).cutBefore },
      { sourceId: "a", start: tok(l0, 3).cutBefore, end: f.doc.current.clips[0]!.end },
    ]);
    // A mark on cut material cannot be placed: two such marks in one source use the source span.
    f.doc = cutRanges(f.doc, f.ctx, [{ sourceId: "a", start: tok(l0, 0).cutBefore, end: tok(l0, 2).cutBefore }]);
    const lc = layoutTranscript(inputOf(f));
    expect(markToRanges(lc, { sourceId: "a", at: tok(l0, 0).start + 10 * MS }, { sourceId: "a", at: tok(l0, 1).start + 10 * MS })).toEqual([
      { sourceId: "a", start: tok(l0, 0).cutBefore, end: tok(l0, 2).cutBefore },
    ]);
  });

  it("gives nothing for an empty or unplaceable mark", () => {
    const f = project();
    const l = layoutTranscript(inputOf(f));
    expect(markToRanges(l, 1000, 1000)).toEqual([]);
    expect(markToRanges(l, { sourceId: "a", at: 5 }, { sourceId: "zz", at: 9 })).toEqual([]);
  });
});
