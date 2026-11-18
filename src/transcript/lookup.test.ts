/** Playhead and caret, caption, suggestion navigation. */
import { describe, expect, it } from "vitest";
import { cutRanges, sequenceTimeOf } from "../edit";
import type { Suggestion } from "../types";
import { layoutTranscript } from "./layout";
import {
  captionAt,
  caretForSource,
  caretSequenceTime,
  caretSourcePosition,
  nextPendingSuggestion,
  pendingSuggestionRanges,
  previousPendingSuggestion,
  suggestionAt,
  suggestionSelection,
  tokenAtSource,
  tokenSourcePosition,
} from "./lookup";
import { selectionToRanges, selectTokens } from "./selection";
import { fixture, inputOf, MS } from "./testing.test-helpers";

const project = () =>
  fixture([
    { id: "a", paragraphs: ["you'll notice is the new signup form,", "which is down to two fields."] },
    { id: "b", paragraphs: ["Okay screen share."] },
  ]);

describe("playhead to token and back", () => {
  it("finds the token whose stretch holds a source position, by binary search", () => {
    const l = layoutTranscript(inputOf(project()));
    const signup = l.tokens[5]!;
    expect(tokenAtSource(l, { sourceId: "a", at: signup.token.start + 10 })).toEqual(signup.address);
    expect(tokenAtSource(l, { sourceId: "a", at: signup.token.cutBefore })).toEqual(signup.address);
    expect(tokenAtSource(l, { sourceId: "a", at: signup.token.cutBefore - 1 })).toEqual(l.tokens[4]!.address);
    expect(tokenAtSource(l, { sourceId: "a", at: 0 })).toBeNull();
    expect(tokenAtSource(l, { sourceId: "zz", at: 0 })).toBeNull();
    // The last token's stretch runs to the end of the source, not past it.
    const end = l.input.edit.clips[0]!.end;
    expect(tokenAtSource(l, { sourceId: "a", at: end - 1 })).toEqual(l.tokens[12]!.address);
    expect(tokenAtSource(l, { sourceId: "a", at: end + 1 })).toBeNull();
  });

  it("maps a token to where it is heard, and the caret to the playhead and back", () => {
    const f = project();
    const l = layoutTranscript(inputOf(f));
    const signup = l.tokens[5]!;
    expect(tokenSourcePosition(l, signup.address)).toEqual({ sourceId: "a", at: signup.token.start });
    expect(caretSourcePosition(l, 5)).toEqual({ sourceId: "a", at: signup.token.start });
    expect(caretForSource(l, { sourceId: "a", at: signup.token.start + 50 * MS })).toBe(5);
    expect(caretForSource(l, { sourceId: "a", at: 0 })).toBe(0); // before the first word
    expect(caretForSource(l, { sourceId: "b", at: 0 })).toBe(13);
    expect(caretSourcePosition(l, l.tokens.length)).toEqual({ sourceId: "b", at: l.tokens[15]!.token.end });
    expect(caretSequenceTime(l, 5)).toBe(sequenceTimeOf(f.doc.current, { sourceId: "a", at: signup.token.start }));
  });

  it("skips cut tokens when the caret sets the playhead", () => {
    const f = project();
    const l0 = layoutTranscript(inputOf(f));
    f.doc = cutRanges(f.doc, f.ctx, selectionToRanges(l0, selectTokens(l0, 4, 5))); // "new signup"
    const l = layoutTranscript(inputOf(f));
    expect(caretSequenceTime(l, 4)).toBe(sequenceTimeOf(f.doc.current, { sourceId: "a", at: l.tokens[6]!.token.start }));
    const total = f.doc.current.clips.reduce((s, c) => s + c.end - c.start, 0);
    expect(caretSequenceTime(l, l.tokens.length)).toBe(total);
  });
});

describe("caption", () => {
  it("shows the kept words around the playhead in playing order", () => {
    const f = project();
    let l = layoutTranscript(inputOf(f));
    const at = { sourceId: "a", at: l.tokens[5]!.token.start + 1 };
    expect(captionAt(l, at, 4)).toEqual({ before: "notice is the new", current: "signup", after: "form, which is down", currentAddress: l.tokens[5]!.address });
    f.doc = cutRanges(f.doc, f.ctx, selectionToRanges(l, selectTokens(l, 3, 4))); // cut "the new"
    l = layoutTranscript(inputOf(f, true));
    expect(captionAt(l, at, 3)).toMatchObject({ before: "you'll notice is", current: "signup", after: "form, which is" });
    // At the end of the first source, the caption carries on into the next one.
    const fields = { sourceId: "a", at: l.input.edit.clips[1]!.end - 1 };
    expect(captionAt(l, fields, 2)).toMatchObject({ before: "to two", current: "fields.", after: "Okay screen" });
    expect(captionAt(l, { sourceId: "a", at: 0 })).toEqual({ before: "", current: null, after: "", currentAddress: null });
  });
});

describe("suggestion navigation", () => {
  function withSuggestions() {
    const f = project();
    const l = layoutTranscript(inputOf(f));
    const range = (a: number, b: number) => ({ sourceId: l.tokens[a]!.address.sourceId, start: l.tokens[a]!.token.cutBefore, end: l.tokens[b + 1]!.token.cutBefore });
    const s = (id: string, a: number, b: number): Suggestion => ({ id, kind: "retake", origin: "claude", range: range(a, b), reason: id });
    f.suggestions = [s("late", 9, 10), s("early", 1, 2), s("mid", 4, 5)];
    return f;
  }

  it("steps through pending suggestions from the caret, in document order", () => {
    const f = withSuggestions();
    let l = layoutTranscript(inputOf(f));
    expect(l.suggestions.map((s) => s.suggestion.id)).toEqual(["early", "mid", "late"]);
    expect(nextPendingSuggestion(l, 0)?.suggestion.id).toBe("early");
    // A suggestion starting exactly at the caret is reached; the one the caret is on is stepped past.
    expect(nextPendingSuggestion(l, 1)?.suggestion.id).toBe("early");
    expect(nextPendingSuggestion(l, 1, { current: "early" })?.suggestion.id).toBe("mid");
    // From the end of the current one's selection (its focus), the next one, and previous skips it.
    expect(nextPendingSuggestion(l, 3, { current: "early" })?.suggestion.id).toBe("mid");
    expect(previousPendingSuggestion(l, 6, { current: "mid" })?.suggestion.id).toBe("early");
    expect(nextPendingSuggestion(l, 10)).toBeNull();
    expect(nextPendingSuggestion(l, 9)?.suggestion.id).toBe("late");
    expect(nextPendingSuggestion(l, 10, { wrap: true })?.suggestion.id).toBe("early");
    expect(previousPendingSuggestion(l, 9)?.suggestion.id).toBe("mid");
    expect(previousPendingSuggestion(l, 1)).toBeNull();
    expect(previousPendingSuggestion(l, 1, { wrap: true })?.suggestion.id).toBe("late");
    expect(suggestionAt(l, 5)?.suggestion.id).toBe("mid");
    expect(suggestionAt(l, 3)).toBeNull();
    expect(suggestionSelection(l.suggestions[1]!)).toEqual({ anchor: 4, focus: 6 });
    // Accepting "mid" takes it out of the pending ones.
    f.doc = cutRanges(f.doc, f.ctx, [l.suggestions[1]!.suggestion.range]);
    l = layoutTranscript(inputOf(f), l);
    expect(nextPendingSuggestion(l, 1, { current: "early" })?.suggestion.id).toBe("late");
    expect(pendingSuggestionRanges(l).map((r) => r.start)).toEqual([l.suggestions[0]!.suggestion.range.start, l.suggestions[2]!.suggestion.range.start]);
  });
});
