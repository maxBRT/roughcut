/** The transcript module on the stand-in core's seeded demo dataset (src/state/core). */
import { describe, expect, it } from "vitest";
import { contextFromProject, cutRanges, rangeKeepState, suggestionState } from "../edit";
import { DEMO_SOURCE_ID, demoProject, demoSuggestions, demoTranscript } from "../state/core/demoData";
import type { EditDocument } from "../types";
import { findInTranscript } from "./find";
import type { LayoutInput } from "./layout";
import { addressKey, layoutTranscript } from "./layout";
import { captionAt, nextPendingSuggestion, pendingSuggestionRanges, tokenAtSource } from "./lookup";
import { selectionToRanges, selectTokens } from "./selection";

function setup() {
  const project = demoProject();
  const transcript = demoTranscript(DEMO_SOURCE_ID);
  const suggestions = demoSuggestions(DEMO_SOURCE_ID);
  const ctx = contextFromProject(project);
  const input = (doc: EditDocument, hideCut = false): LayoutInput => ({
    frameRate: project.frameRate,
    sources: project.sources,
    transcripts: { [DEMO_SOURCE_ID]: transcript },
    edit: doc.current,
    suggestions: { [DEMO_SOURCE_ID]: suggestions },
    hideCut,
  });
  return { project, transcript, suggestions, ctx, input };
}

describe("the demo project", () => {
  it("lays out every utterance as a paragraph under one header, all kept, with every suggestion pending", () => {
    const { project, transcript, suggestions, input } = setup();
    const l = layoutTranscript(input(project.edit));
    const total = transcript.utterances.reduce((n, u) => n + u.tokens.length, 0);
    expect(l.blocks[0]).toMatchObject({ kind: "source", name: "TAKE-1.mp4" });
    expect(l.blocks.filter((b) => b.kind === "source")).toHaveLength(1);
    expect(l.blocks.filter((b) => b.kind === "paragraph")).toHaveLength(transcript.utterances.length);
    expect(l.tokens).toHaveLength(total);
    expect(l.tokens.every((t) => t.keep === "kept")).toBe(true);
    expect(l.tokens.some((t) => t.token.kind === "pause")).toBe(true);
    expect(l.tokens.some((t) => t.token.kind === "unrecognised")).toBe(true);
    expect(l.suggestions).toHaveLength(suggestions.suggestions.length);
    for (const s of l.suggestions) {
      expect(s.state).toBe("pending");
      expect(s.firstPosition).toBeGreaterThanOrEqual(0);
    }
    // The first suggestion is the false start in utterance 3, from its first word.
    const first = l.suggestions[0]!;
    expect(first.suggestion.kind).toBe("false_start");
    expect(first.first).toEqual({ sourceId: DEMO_SOURCE_ID, utterance: 3, token: 0 });
    expect(nextPendingSuggestion(l, 0)).toBe(first);
  });

  it("accepting every suggestion strikes their words in place, matching the clip list", () => {
    const { project, ctx, input } = setup();
    const l0 = layoutTranscript(input(project.edit));
    const doc = cutRanges(project.edit, ctx, pendingSuggestionRanges(l0));
    const l = layoutTranscript(input(doc), l0);
    expect(l.suggestions.every((s) => s.state === "applied")).toBe(true);
    for (const s of l.suggestions) expect(suggestionState(doc.current, s.suggestion.range, project.frameRate)).toBe("applied");
    // Same tokens in the same order: cut text stays where it was.
    expect(l.tokens.map((t) => addressKey(t.address))).toEqual(l0.tokens.map((t) => addressKey(t.address)));
    for (const t of l.tokens) {
      expect(t.keep).toBe(rangeKeepState(doc.current, { sourceId: DEMO_SOURCE_ID, start: t.token.start, end: t.token.end }));
      if (t.suggestionId !== null) expect(t.keep).toBe("cut");
    }
    // Hidden, the retake and the aside are gone.
    const hidden = layoutTranscript(input(doc, true));
    expect(hidden.tokens.length).toBeLessThan(l.tokens.length);
    expect(hidden.tokens.every((t) => t.keep !== "cut")).toBe(true);
    // Find still reaches the hidden cut text (spec 1.8 rule 10), flagged as hidden.
    const hiddenMatch = findInTranscript(hidden, "Wait, let me redo that");
    expect(hiddenMatch).toHaveLength(1);
    expect(hiddenMatch[0]!.hidden).toBe(true);
    expect(hiddenMatch[0]!.from).toBe(hiddenMatch[0]!.to);
    expect(findInTranscript(l, "Wait, let me redo that")).toHaveLength(1);
  });

  it("finds a phrase in kept and cut text, and captions the playhead", () => {
    const { project, ctx, input } = setup();
    const l0 = layoutTranscript(input(project.edit));
    expect(findInTranscript(l0, "the first thing")).toHaveLength(4);
    const m = findInTranscript(l0, "so the first thing you'll notice is the new signup form");
    expect(m).toHaveLength(1);
    const doc = cutRanges(project.edit, ctx, selectionToRanges(l0, selectTokens(l0, m[0]!.from, m[0]!.from + 2)));
    const l = layoutTranscript(input(doc), l0);
    expect(findInTranscript(l, "the first thing")).toHaveLength(4);
    const signup = l.tokens[m[0]!.to - 2]!;
    expect(signup.token).toMatchObject({ kind: "word", text: "signup" });
    const pos = { sourceId: DEMO_SOURCE_ID, at: signup.token.start + 1 };
    expect(tokenAtSource(l, pos)).toEqual(signup.address);
    expect(captionAt(l, pos, 4)).toMatchObject({ before: "notice is the new", current: "signup", after: "form, which is down" });
  });
});
