/** Find covers kept and cut text, spans tokens, ignores case and punctuation (spec 1.8, 3.7). */
import { describe, expect, it } from "vitest";
import { cutRanges, moveClip, splitAt } from "../edit";
import type { FindMatch } from "./find";
import { findInTranscript, nextMatch, previousMatch } from "./find";
import { layoutTranscript } from "./layout";
import { selectionToRanges, selectTokens } from "./selection";
import { fixture, inputOf } from "./testing.test-helpers";

/** Just the document spans of matches. */
const spans = (m: readonly FindMatch[]) => m.map(({ from, to }) => ({ from, to }));

const project = () =>
  fixture([
    { id: "a", paragraphs: ["So the first thing, uh, the first thing you'll notice.", "It's the sign-on page [pause] for the First Thing."] },
    { id: "b", paragraphs: ["THE FIRST thing again."] },
  ]);

describe("find", () => {
  it("is case-insensitive and finds phrases spanning tokens, in document order", () => {
    const f = project();
    const l = layoutTranscript(inputOf(f));
    const m = findInTranscript(l, "the first THING");
    expect(m.every((x) => !x.hidden)).toBe(true);
    expect(spans(m)).toEqual([
      { from: 1, to: 4 },
      { from: 5, to: 8 },
      { from: 16, to: 19 },
      { from: 19, to: 22 },
    ]);
  });

  it("ignores punctuation differences and skips pause chips", () => {
    const f = project();
    const l = layoutTranscript(inputOf(f));
    expect(spans(findInTranscript(l, "thing uh the"))).toEqual([{ from: 3, to: 6 }]);
    expect(spans(findInTranscript(l, "its the sign on"))).toEqual([{ from: 10, to: 13 }]);
    expect(spans(findInTranscript(l, "youll"))).toEqual([{ from: 8, to: 9 }]);
    expect(spans(findInTranscript(l, "page for"))).toEqual([{ from: 13, to: 16 }]); // the pause between them is inside the match
    expect(findInTranscript(l, "  ,.!  ")).toEqual([]);
    expect(findInTranscript(l, "")).toEqual([]);
    expect(findInTranscript(l, "nowhere")).toEqual([]);
  });

  it("covers cut text as well as kept text, also when cut text is hidden (spec 1.8 rule 10)", () => {
    const f = project();
    const l0 = layoutTranscript(inputOf(f));
    f.doc = cutRanges(f.doc, f.ctx, selectionToRanges(l0, selectTokens(l0, 0, 4))); // "So the first thing, uh,"
    const shown = layoutTranscript(inputOf(f));
    const m = findInTranscript(shown, "first thing");
    expect(m).toHaveLength(4);
    expect(shown.tokens[m[0]!.from]!.keep).toBe("cut");
    expect(shown.tokens[m[1]!.from]!.keep).toBe("kept");
    const hidden = layoutTranscript(inputOf(f, true));
    const mh = findInTranscript(hidden, "first thing");
    expect(mh).toHaveLength(4);
    // The cut match is reported at the boundary where its hidden text sits, with its tokens named.
    expect(mh[0]).toMatchObject({ from: 0, to: 0, hidden: true, first: shown.tokens[m[0]!.from]!.address, last: shown.tokens[m[0]!.to - 1]!.address });
    expect(mh.slice(1).every((x) => !x.hidden)).toBe(true);
    expect(spans(mh.slice(1))).toEqual(spans(m.slice(1)).map(({ from, to }) => ({ from: from - 5, to: to - 5 })));
    expect(nextMatch(mh, 0)).toBe(mh[1]);
  });

  it("follows the playing order of reordered clips", () => {
    const f = fixture([{ id: "a", paragraphs: ["alpha beta gamma delta"] }]);
    const l0 = layoutTranscript(inputOf(f));
    f.doc = splitAt(f.doc, f.ctx, l0.tokens[2]!.token.cutBefore);
    f.doc = moveClip(f.doc, f.ctx, f.doc.current.clips[1]!.id, "earlier"); // gamma delta alpha beta
    const l = layoutTranscript(inputOf(f));
    expect(spans(findInTranscript(l, "delta alpha"))).toEqual([{ from: 1, to: 3 }]);
    expect(findInTranscript(l, "beta gamma")).toEqual([]);
  });

  it("steps to the next and previous match from the caret, going round", () => {
    const m = [
      { from: 1, to: 4 },
      { from: 5, to: 8 },
      { from: 15, to: 18 },
    ];
    expect(nextMatch(m, 1)).toEqual({ from: 5, to: 8 });
    expect(nextMatch(m, 15)).toEqual({ from: 1, to: 4 });
    expect(previousMatch(m, 5)).toEqual({ from: 1, to: 4 });
    expect(previousMatch(m, 1)).toEqual({ from: 15, to: 18 });
    expect(nextMatch([], 0)).toBeNull();
  });
});
