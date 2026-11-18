/** Layout: kept and cut text match the clip list, and cut text sits where the placement rule says (spec 3.5.1, 3.7). */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cutPlacement, cutRanges, dismissSuggestion, moveClip, rangeKeepState, removeClip, restoreRanges, splitAt, suggestionState } from "../edit";
import type { EditState, SourceRange } from "../types";
import type { LayoutBlock, TranscriptLayout } from "./layout";
import { boundaryOf, compareAddresses, layoutTranscript, positionOf } from "./layout";
import { selectionToRanges, selectTokens } from "./selection";
import { contextFromProject, createEditDocument } from "../edit";
import { fixture, inputOf, MS, RATE, sourceRef } from "./testing.test-helpers";
import type { Fixture } from "./testing.test-helpers";

/** A compact picture of the layout: `#FILE` headers, words, `~cut~`, `(p)` pauses, `(?)` unrecognised, `<...>` no text, ` | ` between blocks. */
function render(layout: TranscriptLayout): string {
  return layout.blocks
    .map((b: LayoutBlock) => {
      if (b.kind === "source") return `#${b.name.replace(/\.mp4$/i, "")}`;
      if (b.kind === "untranscribed") return `<${b.status}>`;
      return b.tokens
        .map((t) => {
          const s = t.token.kind === "word" ? t.token.text : t.token.kind === "pause" ? "(p)" : "(?)";
          return t.keep === "cut" ? `~${s}~` : t.keep === "partial" ? `%${s}%` : s;
        })
        .join(" ");
    })
    .join(" | ");
}

/** Position of the n-th token whose text is `w` (0-based occurrence). */
function at(layout: TranscriptLayout, w: string, n = 0): number {
  let seen = 0;
  for (let p = 0; p < layout.tokens.length; p++) {
    const t = layout.tokens[p]!.token;
    if (t.kind === "word" && t.text === w && seen++ === n) return p;
  }
  throw new Error(`no token ${w} #${n}`);
}

function cutWords(f: Fixture, from: string, to: string): void {
  const l = layoutTranscript(inputOf(f));
  f.doc = cutRanges(f.doc, f.ctx, selectionToRanges(l, selectTokens(l, at(l, from), at(l, to))));
}

/** Every token's keep state equals what `edit` says about its spoken stretch. */
function expectKeepMatchesClips(layout: TranscriptLayout, state: EditState): void {
  for (const t of layout.tokens) {
    const range: SourceRange = { sourceId: t.address.sourceId, start: t.token.start, end: t.token.end };
    expect(t.keep, `${t.address.utterance}/${t.address.token}`).toBe(rangeKeepState(state, range));
  }
}

const twoSources = () =>
  fixture([
    { id: "a", paragraphs: ["Hey everyone, welcome back.", "So uh the first thing.", "That is all."] },
    { id: "b", paragraphs: ["Okay, screen share now.", "Done here."] },
  ]);

describe("layout of an untouched project", () => {
  it("has a header per source and a paragraph per utterance, all kept", () => {
    const f = twoSources();
    const l = layoutTranscript(inputOf(f));
    expect(render(l)).toBe(
      "#A | Hey everyone, welcome back. | So uh the first thing. | That is all. | #B | Okay, screen share now. | Done here.",
    );
    expect(l.tokens).toHaveLength(18);
    expectKeepMatchesClips(l, f.doc.current);
    const paragraphs = l.blocks.filter((b) => b.kind === "paragraph");
    expect(paragraphs.map((b) => (b.kind === "paragraph" ? [b.utterance, b.continued, b.sequenceTime === null] : null))).toEqual([
      [0, false, false],
      [1, false, false],
      [2, false, false],
      [0, false, false],
      [1, false, false],
    ]);
  });

  it("gives every token a stable address and a document order", () => {
    const f = twoSources();
    const l = layoutTranscript(inputOf(f));
    l.tokens.forEach((t, p) => expect(positionOf(l, t.address)).toBe(p));
    expect(compareAddresses(l, { sourceId: "a", utterance: 2, token: 0 }, { sourceId: "b", utterance: 0, token: 0 })).toBeLessThan(0);
    expect(compareAddresses(l, { sourceId: "b", utterance: 0, token: 1 }, { sourceId: "a", utterance: 0, token: 0 })).toBeGreaterThan(0);
    expect(positionOf(l, { sourceId: "a", utterance: 9, token: 0 })).toBe(-1);
    expect(positionOf(l, { sourceId: "zz", utterance: 0, token: 0 })).toBe(-1);
  });

  it("returns the very same layout for the same input", () => {
    const f = twoSources();
    const input = inputOf(f);
    const l = layoutTranscript(input);
    expect(layoutTranscript(input, l)).toBe(l);
  });
});

describe("cut text", () => {
  it("stays where it was, struck through, and matches the clip list", () => {
    const f = twoSources();
    cutWords(f, "uh", "uh");
    const l = layoutTranscript(inputOf(f));
    expect(render(l)).toBe("#A | Hey everyone, welcome back. | So ~uh~ the first thing. | That is all. | #B | Okay, screen share now. | Done here.");
    expectKeepMatchesClips(l, f.doc.current);
    expect(f.doc.current.clips).toHaveLength(3);
  });

  it("is left out with hide cut text, and a paragraph that is all cut disappears", () => {
    const f = twoSources();
    cutWords(f, "uh", "uh");
    cutWords(f, "That", "all.");
    const shown = layoutTranscript(inputOf(f));
    expect(render(shown)).toBe(
      "#A | Hey everyone, welcome back. | So ~uh~ the first thing. | ~That~ ~is~ ~all.~ | #B | Okay, screen share now. | Done here.",
    );
    const hidden = layoutTranscript(inputOf(f, true));
    expect(render(hidden)).toBe("#A | Hey everyone, welcome back. | So the first thing. | #B | Okay, screen share now. | Done here.");
    expect(hidden.tokens).toHaveLength(14);
    const uh = { sourceId: "a", utterance: 1, token: 1 };
    expect(positionOf(hidden, uh)).toBe(-1);
    expect(boundaryOf(hidden, uh)).toBe(5); // between "So" and "the"
    const allCut = shown.blocks.find((b) => b.kind === "paragraph" && b.utterance === 2 && b.sourceId === "a");
    expect(allCut && allCut.kind === "paragraph" && allCut.allCut && allCut.sequenceTime === null).toBe(true);
  });

  it("follows reordered clips: text is in playing order, cut text next to the clip that borders it", () => {
    const f = fixture([{ id: "a", paragraphs: ["one two three four five six"] }]);
    // Clips: [one two] [four five six], with "three" cut; then move the second clip earlier.
    cutWords(f, "three", "three");
    f.doc = moveClip(f.doc, f.ctx, f.doc.current.clips[1]!.id, "earlier");
    const l = layoutTranscript(inputOf(f));
    // The gap ("three") touches the end of [one two] and the start of [four...]; they are not
    // neighbours in this order, so restoring joins the earlier clip in source time: [one two].
    const gap = { sourceId: "a", start: l.tokens[at(l, "three")]!.token.cutBefore, end: l.tokens[at(l, "four")]!.token.cutBefore };
    const placement = cutPlacement(f.doc.current, f.ctx, gap);
    expect(placement).toMatchObject({ kind: "after", index: 1 });
    expect(render(l)).toBe("#A | four five six | one two ~three~");
    expectKeepMatchesClips(l, f.doc.current);
    // Restoring puts it exactly there.
    const restored = layoutTranscript(inputOf({ ...f, doc: restoreRanges(f.doc, f.ctx, [gap]) }));
    expect(render(restored)).toBe("#A | four five six | one two three");
  });

  it("follows a split and a move across sources, with a header each time the source changes", () => {
    const f = twoSources();
    // Split source A after its first paragraph, then move source B's clip between the halves.
    const l0 = layoutTranscript(inputOf(f));
    const splitTime = l0.tokens[at(l0, "So")]!.token.cutBefore;
    f.doc = splitAt(f.doc, f.ctx, splitTime);
    f.doc = moveClip(f.doc, f.ctx, f.doc.current.clips[2]!.id, "earlier");
    const l = layoutTranscript(inputOf(f));
    expect(render(l)).toBe(
      "#A | Hey everyone, welcome back. | #B | Okay, screen share now. | Done here. | #A | So uh the first thing. | That is all.",
    );
    const headers = l.blocks.filter((b) => b.kind === "source").map((b) => b.key);
    expect(new Set(headers).size).toBe(3);
  });

  it("shows a source whose text is entirely cut where restoring it would put it", () => {
    const f = twoSources();
    f.doc = removeClip(f.doc, f.ctx, f.doc.current.clips[0]!.id);
    const l = layoutTranscript(inputOf(f));
    expect(render(l)).toBe(
      "#A | ~Hey~ ~everyone,~ ~welcome~ ~back.~ | ~So~ ~uh~ ~the~ ~first~ ~thing.~ | ~That~ ~is~ ~all.~ | #B | Okay, screen share now. | Done here.",
    );
    expectKeepMatchesClips(l, f.doc.current);
    expect(render(layoutTranscript(inputOf(f, true)))).toBe("#B | Okay, screen share now. | Done here.");
    // Removing source B instead: its text follows A, where it would come back.
    const g = twoSources();
    g.doc = removeClip(g.doc, g.ctx, g.doc.current.clips[1]!.id);
    expect(render(layoutTranscript(inputOf(g)))).toBe(
      "#A | Hey everyone, welcome back. | So uh the first thing. | That is all. | #B | ~Okay,~ ~screen~ ~share~ ~now.~ | ~Done~ ~here.~",
    );
  });

  it("marks a word partly kept when a timeline edge lands inside it", () => {
    const f = fixture([{ id: "a", paragraphs: ["alpha beta gamma"] }]);
    const l0 = layoutTranscript(inputOf(f));
    const beta = l0.tokens[1]!.token;
    f.doc = cutRanges(f.doc, f.ctx, [{ sourceId: "a", start: beta.start + 120 * MS, end: beta.end + 40 * MS }]);
    const l = layoutTranscript(inputOf(f));
    expect(render(l)).toBe("#A | alpha %beta% gamma");
    expectKeepMatchesClips(l, f.doc.current);
  });
});

describe("words off the frame grid (real transcripts)", () => {
  // Word times as the transcriber gives them: back to back, not on the 30 fps grid. Found in
  // the real app: cutting "is the" left both words 'partial' (a 14 ms and a 6 ms sliver kept),
  // so H did not hide them and they did not count as cut.
  const rate = { num: 30, den: 1 };
  const words: [string, number, number][] = [
    ["so", 1_586_000, 1_826_000],
    ["this", 1_826_000, 1_986_000],
    ["is", 1_986_000, 2_146_000],
    ["the", 2_146_000, 2_306_000],
    ["weekly", 2_306_000, 2_706_000],
    ["update.", 2_706_000, 3_186_000],
  ];
  function realFixture(): Fixture {
    const tokens = words.map(([text, start, end]) => ({ kind: "word" as const, text, start, end, cutBefore: start }));
    const transcript = { schemaVersion: 1, sourceId: "a", model: "test", complete: true, utterances: [{ index: 1, start: tokens[0]!.start, end: tokens[5]!.end, tokens }] };
    const ref = sourceRef("a", 5_000_000);
    ref.media.video!.frameRate = rate;
    const ctx = contextFromProject({ frameRate: rate, sources: [ref] });
    return { sources: [ref], transcripts: { a: transcript }, ctx, doc: createEditDocument([{ id: "c1", sourceId: "a", start: 0, end: 5_000_000 }]), suggestions: [] };
  }
  const input = (f: Fixture, hideCut = false) => ({ ...inputOf(f, hideCut), frameRate: rate });

  it("counts a word cut from the text as cut, and its neighbours as kept, despite frame rounding", () => {
    const f = realFixture();
    const l0 = layoutTranscript(input(f));
    f.doc = cutRanges(f.doc, f.ctx, selectionToRanges(l0, selectTokens(l0, 2, 3)));
    // The cut is on the grid, so it leaves slivers of both words.
    expect(f.doc.current.clips.map((c) => [c.start, c.end])).toEqual([
      [0, 2_000_000],
      [2_300_000, 5_000_000],
    ]);
    expect(render(layoutTranscript(input(f)))).toBe("#A | so this ~is~ ~the~ weekly update.");
    expect(render(layoutTranscript(input(f, true)))).toBe("#A | so this weekly update.");
  });

  it("shows no 'no speech' row for a clip that holds the rest of a word split by the timeline", () => {
    // Found in the real app: two splits made a 0.7 s clip holding the end of "today."; it was
    // shown as 'no speech · 0:06 – 0:06' under the paragraph holding that word.
    const f = realFixture();
    f.doc = splitAt(f.doc, f.ctx, 2_500_000); // inside "weekly"
    f.doc = splitAt(f.doc, f.ctx, 2_700_000); // just before "update."
    expect(f.doc.current.clips).toHaveLength(3);
    expect(render(layoutTranscript(input(f)))).toBe("#A | so this is the weekly update.");
    // Moved away from its neighbour, the clip shows where it plays, as no speech.
    f.doc = moveClip(f.doc, f.ctx, f.doc.current.clips[1]!.id, "earlier");
    expect(render(layoutTranscript(input(f)))).toBe("#A | <silent> | so this is the weekly update.");
  });

  it("still marks a word partial when a real edit keeps a frame or more of it", () => {
    const f = realFixture();
    f.doc = cutRanges(f.doc, f.ctx, [{ sourceId: "a", start: 2_400_000, end: 3_400_000 }]);
    expect(render(layoutTranscript(input(f)))).toBe("#A | so this is the %weekly% ~update.~ | <silent>");
  });
});

describe("pauses and unrecognised speech", () => {
  it("are tokens that select and cut like words", () => {
    const f = fixture([{ id: "a", paragraphs: ["Hello there [pause] and [?] then"] }]);
    const l = layoutTranscript(inputOf(f));
    expect(render(l)).toBe("#A | Hello there (p) and (?) then");
    f.doc = cutRanges(f.doc, f.ctx, selectionToRanges(l, selectTokens(l, 2, 2)));
    f.doc = cutRanges(f.doc, f.ctx, selectionToRanges(l, selectTokens(l, 4, 4)));
    const after = layoutTranscript(inputOf(f));
    expect(render(after)).toBe("#A | Hello there ~(p)~ and ~(?)~ then");
    expectKeepMatchesClips(after, f.doc.current);
  });
});

describe("sources without text yet", () => {
  it("shows kept time past a partial transcript, and a whole clip with no transcript, as untranscribed", () => {
    const f = fixture([
      { id: "a", paragraphs: ["first words here"], complete: false, durationMs: 20_000 },
      { id: "b", durationMs: 5_000 },
    ]);
    const l = layoutTranscript(inputOf(f));
    expect(render(l)).toBe("#A | first words here | <partial> | #B | <none>");
    const blocks = l.blocks.filter((b) => b.kind === "untranscribed");
    expect(blocks.map((b) => (b.kind === "untranscribed" ? [b.range.start, b.range.end] : null))).toEqual([
      [1520 * MS, 20_000 * MS],
      [0, 5_000 * MS],
    ]);
  });

  it("gives a kept clip with no speech a header and a 'silent' block, even in a complete transcript", () => {
    const f = fixture([
      { id: "a", paragraphs: ["one two three four"], durationMs: 10_000 },
      { id: "b", durationMs: 5_000 },
    ]);
    f.transcripts = { ...f.transcripts, b: { schemaVersion: 1, sourceId: "b", model: "test", complete: true, utterances: [] } };
    const l0 = layoutTranscript(inputOf(f));
    expect(render(l0)).toBe("#A | one two three four | #B | <silent>");
    const silent = l0.blocks[3]!;
    expect(silent).toMatchObject({ kind: "untranscribed", status: "silent", range: { sourceId: "b", start: 0, end: 5_000 * MS }, sequenceTime: f.doc.current.clips[0]!.end });
    // A kept clip of a transcribed source that covers only silence: split off the trailing silence and move it first.
    f.doc = splitAt(f.doc, f.ctx, 4_000 * MS);
    f.doc = moveClip(f.doc, f.ctx, f.doc.current.clips[1]!.id, "earlier");
    const l = layoutTranscript(inputOf(f));
    expect(render(l)).toBe("#A | <silent> | one two three four | #B | <silent>");
    // Unchanged, the layout reuses the same block objects.
    expect(layoutTranscript(inputOf(f), l)).toBe(l);
  });
});

describe("suggestions", () => {
  function withSuggestion() {
    const f = twoSources();
    const l = layoutTranscript(inputOf(f));
    const first = l.tokens[at(l, "So")]!.token;
    const next = l.tokens[at(l, "the")]!.token;
    const range = { sourceId: "a", start: first.cutBefore, end: next.cutBefore }; // "So uh"
    f.suggestions = [
      { id: "s1", kind: "false_start", origin: "claude", range, reason: "False start" },
      {
        id: "s2",
        kind: "aside",
        origin: "claude",
        range: { sourceId: "b", start: l.tokens[at(l, "Done")]!.token.cutBefore, end: 4_000 * MS },
        reason: "Aside",
      },
    ];
    return { f, range };
  }

  it("are attached to the tokens they cover, with their worked-out state", () => {
    const { f, range } = withSuggestion();
    let l = layoutTranscript(inputOf(f));
    expect(l.tokens.filter((t) => t.suggestionId === "s1").map((t) => (t.token.kind === "word" ? t.token.text : ""))).toEqual(["So", "uh"]);
    expect(l.suggestions.map((s) => [s.suggestion.id, s.state])).toEqual([
      ["s1", "pending"],
      ["s2", "pending"],
    ]);
    // Accept s1.
    f.doc = cutRanges(f.doc, f.ctx, [range]);
    l = layoutTranscript(inputOf(f), l);
    expect(l.suggestions[0]!.state).toBe("applied");
    expect(l.tokens.filter((t) => t.suggestionId === "s1").every((t) => t.suggestionState === "applied" && t.keep === "cut")).toBe(true);
    // Undo by restoring, then dismiss.
    f.doc = restoreRanges(f.doc, f.ctx, [range]);
    f.doc = dismissSuggestion(f.doc, f.ctx, range);
    l = layoutTranscript(inputOf(f), l);
    expect(l.suggestions[0]!.state).toBe("dismissed");
    expect(l.suggestions[0]!.state).toBe(suggestionState(f.doc.current, range, RATE));
  });
});

describe("recomputing only what changed", () => {
  it("reuses blocks and tokens that did not change", () => {
    const f = twoSources();
    const l1 = layoutTranscript(inputOf(f));
    cutWords(f, "Done", "Done");
    const l2 = layoutTranscript(inputOf(f), l1);
    expect(l2).not.toBe(l1);
    // Everything before source B's second paragraph is untouched.
    for (let i = 0; i < l2.blocks.length - 1; i++) expect(l2.blocks[i]).toBe(l1.blocks[i]);
    expect(l2.blocks[l2.blocks.length - 1]).not.toBe(l1.blocks[l1.blocks.length - 1]);
    expect(l2.tokens[0]).toBe(l1.tokens[0]);
    expect(l2.tokens[at(l2, "Done")]).not.toBe(l1.tokens[at(l1, "Done")]);
  });
});

describe("generated edit sequences", () => {
  it("keep the text matching the clip list and cut text where the placement rule says", () => {
    const f0 = fixture([
      { id: "a", paragraphs: ["a1 a2 a3 a4.", "a5 [pause] a6 a7", "a8 a9 a10"] },
      { id: "b", paragraphs: ["b1 b2 b3", "b4 b5 [?] b6"] },
    ]);
    const n = layoutTranscript(inputOf(f0)).tokens.length;
    const command = fc.oneof(
      fc.record({ type: fc.constant("cut" as const), a: fc.nat(n - 1), b: fc.nat(n - 1) }),
      fc.record({ type: fc.constant("restore" as const), a: fc.nat(n - 1), b: fc.nat(n - 1) }),
      fc.record({ type: fc.constant("split" as const), t: fc.double({ min: 0, max: 1, noNaN: true }) }),
      fc.record({ type: fc.constant("move" as const), i: fc.nat(20), later: fc.boolean() }),
      fc.record({ type: fc.constant("remove" as const), i: fc.nat(20) }),
    );
    fc.assert(
      fc.property(fc.array(command, { maxLength: 12 }), (cmds) => {
        const f: Fixture = { ...f0 };
        for (const c of cmds) {
          const full = layoutTranscript(inputOf(f));
          const clips = f.doc.current.clips;
          if (c.type === "cut") f.doc = cutRanges(f.doc, f.ctx, selectionToRanges(full, selectTokens(full, c.a, c.b)));
          else if (c.type === "restore") f.doc = restoreRanges(f.doc, f.ctx, selectionToRanges(full, selectTokens(full, c.a, c.b)));
          else if (c.type === "split") {
            const total = clips.reduce((s, k) => s + k.end - k.start, 0);
            f.doc = splitAt(f.doc, f.ctx, Math.floor(total * c.t));
          } else if (clips.length > 0) {
            const clip = clips[c.i % clips.length]!;
            f.doc = c.type === "move" ? moveClip(f.doc, f.ctx, clip.id, c.later ? "later" : "earlier") : removeClip(f.doc, f.ctx, clip.id);
          }
        }
        const state = f.doc.current;
        const l = layoutTranscript(inputOf(f));
        expect(l.tokens).toHaveLength(n); // every token is shown exactly once
        expect(new Set(l.tokens.map((t) => `${t.address.sourceId}/${t.address.utterance}/${t.address.token}`)).size).toBe(n);
        expectKeepMatchesClips(l, state);
        // Which clip each kept token plays in, by document position.
        const clipOfPos = l.tokens.map((t) => {
          if (t.keep === "cut") return -1;
          return state.clips.findIndex((c) => c.sourceId === t.address.sourceId && c.start < t.token.end && t.token.start < c.end);
        });
        // Kept tokens play in sequence order.
        const keptClips = clipOfPos.filter((c) => c >= 0);
        for (let i = 1; i < keptClips.length; i++) expect(keptClips[i]!).toBeGreaterThanOrEqual(keptClips[i - 1]!);
        // Each cut token sits where its gap would be restored.
        l.tokens.forEach((t, p) => {
          if (t.keep !== "cut") return;
          const id = t.address.sourceId;
          const ends = state.clips.filter((c) => c.sourceId === id && c.end <= t.token.start).map((c) => c.end);
          const starts = state.clips.filter((c) => c.sourceId === id && c.start >= t.token.end).map((c) => c.start);
          const src = f0.sources.find((s) => s.id === id)!;
          const gap = { sourceId: id, start: ends.length ? Math.max(...ends) : 0, end: starts.length ? Math.min(...starts) : Math.floor(src.media.duration / 40_000) * 40_000 };
          const place = cutPlacement(state, f.ctx, gap);
          const split = place.kind === "after" ? place.index + 1 : place.index; // kept clips before p are < split, after are >= split
          for (let q = 0; q < p; q++) if (clipOfPos[q]! >= 0) expect(clipOfPos[q]!).toBeLessThan(split);
          for (let q = p + 1; q < l.tokens.length; q++) if (clipOfPos[q]! >= 0) expect(clipOfPos[q]!).toBeGreaterThanOrEqual(split);
        });
      }),
      { numRuns: 150 },
    );
  });
});
