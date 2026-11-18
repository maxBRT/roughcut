import { describe, expect, it } from "vitest";
import type { Token } from "../../types";
import { DEMO_SOURCE_ID, demoDuration, demoProject, demoSuggestions, demoTranscript, snapToFrame } from "./demoData";
import * as S from "./shapes.test-helpers";

const t = demoTranscript(DEMO_SOURCE_ID);
const tokens: Token[] = t.utterances.flatMap((u) => u.tokens);
const set = demoSuggestions(DEMO_SOURCE_ID);

describe("demo dataset", () => {
  it("has the documented shapes", () => {
    S.expectShape(S.transcript, t);
    S.expectShape(S.suggestionSet, set);
    S.expectShape(S.project, demoProject());
  });

  it("has at least 120 utterances with consistent, increasing times", () => {
    expect(t.utterances.length).toBeGreaterThanOrEqual(120);
    t.utterances.forEach((u, i) => {
      expect(u.index).toBe(i + 1); // spec 3.4: Utterance.index starts at 1
      expect(u.start).toBe(u.tokens[0]!.start);
      expect(u.end).toBe(u.tokens.at(-1)!.end);
    });
    let prevEnd = 0;
    let prevCut = -1;
    for (const tok of tokens) {
      expect(tok.start).toBeLessThan(tok.end);
      expect(tok.cutBefore).toBeGreaterThanOrEqual(prevEnd); // the cut lies in the gap
      expect(tok.cutBefore).toBeLessThanOrEqual(tok.start);
      expect(tok.cutBefore).toBeGreaterThan(prevCut);
      prevEnd = tok.end;
      prevCut = tok.cutBefore;
    }
    expect(prevEnd).toBeLessThan(demoDuration());
  });

  it("puts cut points on the frame grid", () => {
    const onGrid = tokens.filter((tok) => snapToFrame(tok.cutBefore) === tok.cutBefore).length;
    expect(onGrid).toBe(tokens.length);
  });

  it("contains pause chips over a second and exactly one unrecognised block", () => {
    const pauses = tokens.filter((tok) => tok.kind === "pause");
    expect(pauses.length).toBeGreaterThanOrEqual(5);
    expect(pauses.every((p) => p.end - p.start > 1_000_000)).toBe(true);
    expect(tokens.filter((tok) => tok.kind === "unrecognised")).toHaveLength(1);
  });

  it("has suggestions of every kind that refer to real ranges", () => {
    const kinds = new Set(set.suggestions.map((s) => s.kind));
    expect(kinds).toEqual(new Set(["retake", "false_start", "aside", "dead_air"]));
    const cuts = new Set(tokens.map((tok) => tok.cutBefore));
    const sorted = [...set.suggestions].sort((a, b) => a.range.start - b.range.start);
    let prevEnd = 0;
    for (const s of sorted) {
      expect(s.range.sourceId).toBe(DEMO_SOURCE_ID);
      expect(cuts.has(s.range.start)).toBe(true);
      expect(s.range.end).toBeGreaterThan(s.range.start);
      expect(s.range.end).toBeLessThanOrEqual(demoDuration());
      expect(s.range.start).toBeGreaterThanOrEqual(prevEnd); // no overlaps
      prevEnd = s.range.end;
      if (s.kind === "dead_air") {
        expect(s.origin).toBe("local");
        const inside = tokens.filter((tok) => tok.start >= s.range.start && tok.end <= s.range.end);
        expect(inside.map((tok) => tok.kind)).toEqual(["pause"]);
      } else {
        expect(s.origin).toBe("claude");
      }
      if (s.kind === "retake") expect(s.keptVersionAt).toBeGreaterThanOrEqual(s.range.end);
    }
    expect(new Set(set.suggestions.map((s) => s.id)).size).toBe(set.suggestions.length);
  });

  it("the dead-air-only set has no Claude model", () => {
    const local = demoSuggestions(DEMO_SOURCE_ID, false);
    expect(local.claudeModel).toBeUndefined();
    expect(local.suggestions.every((s) => s.kind === "dead_air")).toBe(true);
  });

  it("the demo clip covers the whole source on the frame grid", () => {
    const p = demoProject();
    const clip = p.edit.current.clips[0]!;
    expect(clip).toMatchObject({ start: 0, end: demoDuration() });
    expect(snapToFrame(clip.end)).toBe(clip.end);
  });
});
