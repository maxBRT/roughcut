/**
 * Generated command sequences (fast-check): the rules of spec 3.4 hold after any series of
 * edits, at every supported frame rate; undo returns exactly the earlier state; cutting then
 * restoring a range gives back what was kept (and the same playing order when each source
 * plays in source order); cut text is shown where a restore would put it; edges stop at kept material and source ends.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { EditDocument, EditState, Micros, Rational, SourceRange } from "../types";
import { firstClipEnd, frameToMicros, isOnFrameGrid, microsToFrameFloor, snapToFrame } from "../types";
import {
  appendSource,
  applyEditCommand,
  createEditDocument,
  cutPlacement,
  cutRanges,
  keptRanges,
  redo,
  restoreRanges,
  trimEdge,
  undo,
  validateEditState,
} from "./index";
import type { EditCommand, EditContext } from "./index";

const RATES: Rational[] = [
  { num: 30000, den: 1001 },
  { num: 60000, den: 1001 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30, den: 1 },
  { num: 50, den: 1 },
  { num: 60, den: 1 },
];
const SOURCES = ["a", "b", "c"] as const;

/** A command whose clip choices are resolved against the document it is applied to. */
type Step =
  | { t: "cut" | "restore"; ranges: { s: number; start: number; len: number }[] }
  | { t: "trim"; i: number; edge: "start" | "end"; to: number }
  | { t: "nudge"; i: number; edge: "start" | "end"; frames: number }
  | { t: "split"; f: number }
  | { t: "remove"; i: number }
  | { t: "move"; i: number; dir: "earlier" | "later" }
  | { t: "dismiss"; s: number; start: number; len: number }
  | { t: "append"; s: number }
  | { t: "undo" }
  | { t: "redo" };

const rangeArb = fc.record({
  s: fc.integer({ min: 0, max: 2 }),
  start: fc.integer({ min: -2_000_000, max: 62_000_000 }),
  len: fc.integer({ min: 0, max: 20_000_000 }),
});
const edgeArb = fc.constantFrom<"start" | "end">("start", "end");
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constantFrom<"cut" | "restore">("cut", "restore"), ranges: fc.array(rangeArb, { minLength: 1, maxLength: 3 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant<"trim">("trim"), i: fc.nat(), edge: edgeArb, to: fc.integer({ min: -5_000_000, max: 70_000_000 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant<"nudge">("nudge"), i: fc.nat(), edge: edgeArb, frames: fc.integer({ min: -400, max: 400 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant<"split">("split"), f: fc.double({ min: 0, max: 1, noNaN: true }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant<"remove">("remove"), i: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant<"move">("move"), i: fc.nat(), dir: fc.constantFrom<"earlier" | "later">("earlier", "later") }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant<"dismiss">("dismiss"), s: fc.integer({ min: 0, max: 2 }), start: fc.nat(60_000_000), len: fc.integer({ min: 1, max: 5_000_000 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant<"append">("append"), s: fc.integer({ min: 0, max: 2 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant<"undo">("undo") }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant<"redo">("redo") }) },
);
const durationsArb = fc.tuple(
  fc.integer({ min: 1_000_000, max: 60_000_000 }),
  fc.integer({ min: 10_000, max: 60_000_000 }), // may be shorter than one frame
  fc.integer({ min: 1_000_000, max: 60_000_000 }),
);

function makeCtx(rate: Rational, durations: readonly number[]): EditContext {
  return { frameRate: rate, sources: SOURCES.map((id, i) => ({ id, duration: durations[i]! })) };
}
function startDoc(ctx: EditContext): EditDocument {
  let d = createEditDocument();
  for (const s of ctx.sources) d = appendSource(d, ctx, s.id, s.duration);
  return createEditDocument(d.current.clips);
}
function toRange(r: { s: number; start: number; len: number }): SourceRange {
  return { sourceId: SOURCES[r.s]!, start: r.start, end: r.start + r.len };
}
function toCommand(doc: EditDocument, ctx: EditContext, step: Step): EditCommand | null {
  const clips = doc.current.clips;
  const pick = (i: number) => clips[i % Math.max(1, clips.length)];
  switch (step.t) {
    case "cut":
      return { type: "cutRanges", ranges: step.ranges.map(toRange) };
    case "restore":
      return { type: "restoreRanges", ranges: step.ranges.map(toRange) };
    case "trim": {
      const c = pick(step.i);
      return c ? { type: "trimEdge", clipId: c.id, edge: step.edge, to: step.to } : null;
    }
    case "nudge": {
      const c = pick(step.i);
      return c ? { type: "nudgeEdge", clipId: c.id, edge: step.edge, frames: step.frames } : null;
    }
    case "split": {
      let total = 0;
      for (const c of clips) total += c.end - c.start;
      return { type: "splitAt", at: Math.floor(step.f * total) };
    }
    case "remove": {
      const c = pick(step.i);
      return c ? { type: "removeClip", clipId: c.id } : null;
    }
    case "move": {
      const c = pick(step.i);
      return c ? { type: "moveClip", clipId: c.id, direction: step.dir } : null;
    }
    case "dismiss":
      return { type: "dismissSuggestion", range: toRange(step) };
    case "append":
      return { type: "appendSource", sourceId: SOURCES[step.s]!, duration: ctx.sources[step.s]!.duration };
    case "undo":
      return { type: "undo" };
    case "redo":
      return { type: "redo" };
  }
}

/** Every kept moment of each source, merged, as `[start, end)` pairs. */
function coverage(state: EditState, ctx: EditContext): Record<string, [number, number][]> {
  const out: Record<string, [number, number][]> = {};
  for (const s of ctx.sources) {
    out[s.id] = keptRanges(state, { sourceId: s.id, start: -1e12, end: 1e12 }).map((r) => [r.start, r.end]);
  }
  return out;
}
function setOp(a: [number, number][], b: [number, number], op: "union" | "minus"): [number, number][] {
  const pts = new Set<number>([b[0], b[1]]);
  for (const [s, e] of a) pts.add(s).add(e);
  const sorted = [...pts].sort((x, y) => x - y);
  const inA = (t: number) => a.some(([s, e]) => s <= t && t < e);
  const inB = (t: number) => b[0] <= t && t < b[1];
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const s = sorted[i]!;
    const e = sorted[i + 1]!;
    const keep = op === "union" ? inA(s) || inB(s) : inA(s) && !inB(s);
    if (!keep) continue;
    const last = out[out.length - 1];
    if (last && last[1] === s) last[1] = e;
    else out.push([s, e]);
  }
  return out;
}

function checkRules(state: EditState, ctx: EditContext) {
  expect(validateEditState(state, ctx)).toEqual([]);
  for (const c of state.clips) {
    expect(isOnFrameGrid(c.start, ctx.frameRate)).toBe(true);
    expect(isOnFrameGrid(c.end, ctx.frameRate)).toBe(true);
  }
}

/** Runs a generated sequence, checking the rules and undo/redo after every step. */
function runSequence(rate: Rational, durations: number[], steps: Step[]): { ctx: EditContext; history: EditState[]; doc: EditDocument } {
  const ctx = makeCtx(rate, durations);
  let doc = startDoc(ctx);
  checkRules(doc.current, ctx);
  for (const step of steps) {
    const cmd = toCommand(doc, ctx, step);
    if (!cmd) continue;
    const next = applyEditCommand(doc, ctx, cmd);
    checkRules(next.current, ctx);
    if (cmd.type === "undo") {
      if (doc.undo.length === 0) expect(next).toBe(doc);
      else {
        expect(next.current).toEqual(doc.undo[doc.undo.length - 1]);
        expect(redo(next).current).toEqual(doc.current);
      }
    } else if (cmd.type === "redo") {
      if (doc.redo.length === 0) expect(next).toBe(doc);
      else expect(undo(next).current).toEqual(doc.current);
    } else if (next !== doc) {
      // One undo step, redo cleared, and a real change.
      expect(next.undo.length).toBe(doc.undo.length + 1);
      expect(next.redo).toEqual([]);
      expect(next.current).not.toEqual(doc.current);
      expect(undo(next).current).toEqual(doc.current);
      expect(redo(undo(next)).current).toEqual(next.current);
    } else {
      expect(next.undo.length).toBe(doc.undo.length);
    }
    doc = next;
  }
  return { ctx, history: [...doc.undo, doc.current], doc };
}

const steps = fc.array(stepArb, { minLength: 1, maxLength: 40 });

describe("generated command sequences", () => {
  for (const rate of RATES) {
    it(`keep every rule of spec 3.4, with every edge on the ${rate.num}/${rate.den} grid, and undo exactly`, () => {
      fc.assert(
        fc.property(durationsArb, steps, (durations, seq) => {
          const { history, doc } = runSequence(rate, durations, seq);
          // Undoing everything walks back through every earlier state, exactly.
          let d = doc;
          for (let i = history.length - 1; i >= 0; i--) {
            expect(d.current).toEqual(history[i]);
            if (i > 0) d = undo(d);
          }
          expect(undo(d)).toBe(d);
          // And redoing as many steps comes back to the final state.
          for (let i = 1; i < history.length; i++) d = redo(d);
          expect(d.current).toEqual(doc.current);
        }),
        { numRuns: 150 },
      );
    });
  }
});

/** The playing order: each clip's source, start and end, with continuous neighbours joined into one run. */
function runs(state: EditState): [string, number, number][] {
  const out: [string, number, number][] = [];
  for (const c of state.clips) {
    const last = out[out.length - 1];
    if (last && last[0] === c.sourceId && last[2] === c.start) last[2] = c.end;
    else out.push([c.sourceId, c.start, c.end]);
  }
  return out;
}
/** True when each source's clips play together, in source order, and the sources in project order. */
function inSourceOrder(state: EditState, ctx: EditContext): boolean {
  const order = (id: string) => ctx.sources.findIndex((s) => s.id === id);
  for (let i = 1; i < state.clips.length; i++) {
    const p = state.clips[i - 1]!;
    const c = state.clips[i]!;
    if (order(p.sourceId) > order(c.sourceId)) return false;
    if (p.sourceId === c.sourceId && p.end > c.start) return false;
  }
  return true;
}
/** Steps that keep each source's clips in source order (no move, no append of a partly kept source). */
const orderedSteps = fc.array(
  stepArb.filter((s) => s.t !== "move" && s.t !== "append"),
  { minLength: 1, maxLength: 40 },
);

describe("cutting then restoring", () => {
  it("a range strictly inside one clip changes nothing; touching its edges, the same moments come back", () => {
    fc.assert(
      fc.property(fc.constantFrom(...RATES), durationsArb, steps, fc.nat(), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (rate, durations, seq, ci, f1, f2) => {
        const { ctx, doc } = runSequence(rate, durations, seq);
        const clips = doc.current.clips;
        if (clips.length === 0) return;
        const c = clips[ci % clips.length]!;
        const lo = Math.min(f1, f2);
        const hi = Math.max(f1, f2);
        const range = { sourceId: c.sourceId, start: Math.floor(c.start + lo * (c.end - c.start)), end: Math.floor(c.start + hi * (c.end - c.start)) };
        const after = restoreRanges(cutRanges(doc, ctx, [range]), ctx, [range]);
        const snapped = { s: snapToFrame(range.start, rate), e: snapToFrame(range.end, rate) };
        if (snapped.s > c.start && snapped.e < c.end) {
          expect(after.current).toEqual(doc.current);
        } else {
          // Touching an edge, the material may join another clip of the source (see placement.ts).
          expect(coverage(after.current, ctx)).toEqual(coverage(doc.current, ctx));
          if (inSourceOrder(doc.current, ctx)) expect(runs(after.current)).toEqual(runs(doc.current));
        }
      }),
      { numRuns: 300 },
    );
  });
  it("any range, with every source in source order: the same moments play in the same order", () => {
    fc.assert(
      fc.property(fc.constantFrom(...RATES), durationsArb, orderedSteps, rangeArb, (rate, durations, seq, r) => {
        const { ctx, doc } = runSequence(rate, durations, seq);
        expect(inSourceOrder(doc.current, ctx)).toBe(true);
        // Cut a range, then restore what that cut took out (restoring the whole range would
        // also bring back moments that were never kept).
        const range = toRange(r);
        const taken = keptRanges(doc.current, { sourceId: range.sourceId, start: snapToFrame(range.start, rate), end: snapToFrame(range.end, rate) });
        const back = restoreRanges(cutRanges(doc, ctx, [range]), ctx, taken);
        expect(runs(back.current)).toEqual(runs(doc.current));
      }),
      { numRuns: 300 },
    );
  });
  it("any range: a cut removes exactly the snapped range and a restore brings back exactly that and what was kept", () => {
    fc.assert(
      fc.property(fc.constantFrom(...RATES), durationsArb, steps, rangeArb, (rate, durations, seq, r) => {
        const { ctx, doc } = runSequence(rate, durations, seq);
        const range = toRange(r);
        const before = coverage(doc.current, ctx);
        const cut = cutRanges(doc, ctx, [range]);
        const back = restoreRanges(cut, ctx, [range]);
        const end = firstClipEnd(ctx.sources[r.s]!.duration, rate) ?? 0;
        const s = Math.max(0, snapToFrame(range.start, rate));
        const e = Math.min(end, snapToFrame(range.end, rate));
        const span: [number, number] = [s, Math.max(s, e)];
        const id = range.sourceId;
        expect(coverage(cut.current, ctx)[id]).toEqual(setOp(before[id]!, span, "minus"));
        expect(coverage(back.current, ctx)[id]).toEqual(setOp(before[id]!, span, "union"));
        for (const other of SOURCES) if (other !== id) expect(coverage(back.current, ctx)[other]).toEqual(before[other]);
      }),
      { numRuns: 300 },
    );
  });
});

describe("cut text placement", () => {
  it("is where restoring that material puts it, for any cut range in any clip list", () => {
    fc.assert(
      fc.property(fc.constantFrom(...RATES), durationsArb, steps, rangeArb, (rate, durations, seq, r) => {
        const { ctx, doc } = runSequence(rate, durations, seq);
        // Make the range fully cut, then compare where it is shown with where it returns.
        const range = toRange(r);
        const cut = cutRanges(doc, ctx, [range]);
        const end = firstClipEnd(ctx.sources[r.s]!.duration, rate) ?? 0;
        const a = Math.max(0, snapToFrame(range.start, rate));
        const b = Math.min(end, snapToFrame(range.end, rate));
        if (a >= b) return;
        const shown = cutPlacement(cut.current, ctx, range);
        const back = restoreRanges(cut, ctx, [range]).current.clips;
        const k = back.findIndex((c) => c.sourceId === range.sourceId && c.start <= a && a < c.end);
        expect(k).toBeGreaterThanOrEqual(0);
        if (shown.kind === "after") {
          expect(back[k]!.id === shown.clipId || back[k - 1]?.id === shown.clipId).toBe(true);
          expect(k === shown.index || k === shown.index + 1).toBe(true);
        } else if (shown.kind === "before") {
          expect(back[k]!.id === shown.clipId || back[k + 1]?.id === shown.clipId).toBe(true);
          expect(k).toBe(shown.index);
        } else {
          expect(k).toBe(shown.index);
          expect(back[k]).toEqual(expect.objectContaining({ sourceId: range.sourceId, start: a, end: b }));
        }
      }),
      { numRuns: 400 },
    );
  });
});

describe("edges", () => {
  it("pulled outwards as far as possible, stop at the next kept material of the source or its start or end", () => {
    fc.assert(
      fc.property(fc.constantFrom(...RATES), durationsArb, steps, fc.nat(), (rate, durations, seq, ci) => {
        const { ctx, doc } = runSequence(rate, durations, seq);
        const clips = doc.current.clips;
        if (clips.length === 0) return;
        const c = clips[ci % clips.length]!;
        const same = clips.filter((o) => o !== c && o.sourceId === c.sourceId);
        const sourceEnd: Micros = firstClipEnd(ctx.sources[SOURCES.indexOf(c.sourceId as never)]!.duration, rate) ?? 0;
        const expectedEnd = Math.min(sourceEnd, ...same.filter((o) => o.start >= c.end).map((o) => o.start));
        const expectedStart = Math.max(0, ...same.filter((o) => o.end <= c.start).map((o) => o.end));
        // An edge that reaches its neighbour in the sequence (same source, continuous) merges
        // with it, the earlier clip keeping its id; otherwise it stops exactly at the limit. An
        // edge that cannot move (already touching, e.g. after splitAt) changes nothing.
        const i = clips.indexOf(c);
        const after = clips[i + 1];
        const before = clips[i - 1];
        const eClips = trimEdge(doc, ctx, c.id, "end", 1e12).current.clips;
        const e = eClips.find((x) => x.id === c.id)!;
        if (after && after.sourceId === c.sourceId && after.start === expectedEnd && expectedEnd !== c.end) {
          expect(e).toEqual({ ...c, end: after.end });
          expect(eClips.some((x) => x.id === after.id)).toBe(false);
          expect(eClips).toHaveLength(clips.length - 1);
        } else {
          expect(e.end).toBe(expectedEnd);
          expect(eClips).toHaveLength(clips.length);
        }
        const sClips = trimEdge(doc, ctx, c.id, "start", -1e12).current.clips;
        if (before && before.sourceId === c.sourceId && before.end === expectedStart && expectedStart !== c.start) {
          expect(sClips.some((x) => x.id === c.id)).toBe(false);
          expect(sClips.find((x) => x.id === before.id)).toEqual({ ...before, end: c.end });
          expect(sClips).toHaveLength(clips.length - 1);
        } else {
          expect(sClips.find((x) => x.id === c.id)!.start).toBe(expectedStart);
          expect(sClips).toHaveLength(clips.length);
        }
        // Pulled inwards as far as possible, a clip keeps one frame.
        const inE = trimEdge(doc, ctx, c.id, "end", -1e12).current.clips.find((x) => x.id === c.id)!;
        const inS = trimEdge(doc, ctx, c.id, "start", 1e12).current.clips.find((x) => x.id === c.id)!;
        expect(inE).toEqual({ ...c, end: frameToMicros(microsToFrameFloor(c.start, rate) + 1, rate) });
        expect(inS).toEqual({ ...c, start: frameToMicros(microsToFrameFloor(c.end, rate) - 1, rate) });
        expect(validateEditState(trimEdge(doc, ctx, c.id, "start", 1e12).current, ctx)).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});
