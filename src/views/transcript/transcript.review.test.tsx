/**
 * Review tests for the Transcript view (track viewTranscript-review). Each test states a
 * behaviour the spec or the task asks for; the ones that fail show a defect for the fixer.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditDocument } from "../../edit";
import { RoughcutProvider, type RoughcutStore } from "../../state";
import { createTestRig, type TestRig } from "../../state/testing";
import { layoutTranscript } from "../../transcript";
import type { MediaInfo, SourceRef, Token, Transcript, Utterance } from "../../types";
import { TranscriptView } from "./index";
import { buildRows, markPosition } from "./rows";

let rig: TestRig;
const state = () => rig.store.getState();

const VIEW_HEIGHT = 600;
const realRect = Element.prototype.getBoundingClientRect;
const realClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!;
const realClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!;
const realScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!;
const isScroller = (el: Element) => el instanceof HTMLElement && el.dataset.txScroller !== undefined;

function stubLayout(): void {
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get(this: Element) {
      return isScroller(this) ? VIEW_HEIGHT : 0;
    },
  });
  Object.defineProperty(Element.prototype, "clientWidth", {
    configurable: true,
    get(this: Element) {
      return isScroller(this) ? 800 : 0;
    },
  });
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get(this: Element) {
      if (!isScroller(this)) return 0;
      const inner = this.firstElementChild as HTMLElement | null;
      return Math.max(VIEW_HEIGHT, Number.parseFloat(inner?.style.height ?? "") || 0);
    },
  });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (isScroller(this)) {
      return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: VIEW_HEIGHT, width: 800, height: VIEW_HEIGHT, toJSON: () => ({}) } as DOMRect;
    }
    return realRect.call(this);
  };
  Element.prototype.scrollTo = function (this: Element, opts?: ScrollToOptions | number) {
    const top = typeof opts === "object" ? (opts.top ?? 0) : 0;
    (this as HTMLElement).scrollTop = top;
    this.dispatchEvent(new Event("scroll"));
  } as Element["scrollTo"];
}

async function openDemo(): Promise<void> {
  rig = createTestRig({ stepMs: 100, transcriptBatches: 4 });
  await rig.store.init();
  await rig.store.dispatch("ui.openProject", { projectId: rig.core.demo.projectId });
  await rig.store.idle();
}

function show(store: RoughcutStore) {
  return render(
    <RoughcutProvider store={store}>
      <TranscriptView />
    </RoughcutProvider>,
  );
}

async function act$(fn: () => unknown): Promise<void> {
  await act(async () => {
    await fn();
    await rig.store.idle();
  });
}

const token = (p: number) => document.querySelector<HTMLElement>(`[data-pos="${p}"]`)!;

beforeEach(() => {
  vi.useFakeTimers();
  stubLayout();
});

afterEach(() => {
  cleanup();
  rig?.store.dispose();
  rig?.core.dispose();
  Element.prototype.getBoundingClientRect = realRect;
  Object.defineProperty(Element.prototype, "clientHeight", realClientHeight);
  Object.defineProperty(Element.prototype, "clientWidth", realClientWidth);
  Object.defineProperty(Element.prototype, "scrollHeight", realScrollHeight);
  vi.useRealTimers();
});

const RATE = { num: 25, den: 1 };

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

/** Words every 400 ms from 0 up to `until`, ten per utterance. */
function transcriptUntil(sourceId: string, until: number, complete: boolean): Transcript {
  const utterances: Utterance[] = [];
  let tokens: Token[] = [];
  let i = 0;
  for (let t = 0; t + 320_000 <= until; t += 400_000) {
    tokens.push({ kind: "word", text: `w${i++}`, start: t, end: t + 320_000, cutBefore: Math.max(0, t - 40_000) });
    if (tokens.length === 10) {
      utterances.push({ index: utterances.length, start: tokens[0]!.start, end: tokens[tokens.length - 1]!.end, tokens });
      tokens = [];
    }
  }
  if (tokens.length > 0) utterances.push({ index: utterances.length, start: tokens[0]!.start, end: tokens[tokens.length - 1]!.end, tokens });
  return { schemaVersion: 1, sourceId, model: "test", complete, utterances };
}

describe("review: clicks between words", () => {
  it("a click on the space between two words places the caret there, not at the paragraph's end", async () => {
    await openDemo();
    show(rig.store);
    const para = document.querySelector<HTMLElement>('[data-row="paragraph"]')!;
    const end = Number(para.dataset.end);
    expect(end).toBeGreaterThan(2);
    // The space between tokens 1 and 2.
    const gap = token(2).previousElementSibling as HTMLElement;
    expect(gap.className).toContain("rc-tx-gap");
    await act$(() => fireEvent.mouseDown(gap, { button: 0, detail: 1 }));
    const f = state().selection.focus;
    expect(f === 1 || f === 2, `caret went to ${f}, paragraph end is ${end}`).toBe(true);
  });

  it("a click on an I mark flag places the caret at the flag, not at the paragraph's end", async () => {
    await openDemo();
    show(rig.store);
    await act$(() => rig.store.dispatch("ui.placeCaret", { boundary: 2 }));
    await act$(() => rig.store.dispatch("transcript.markIn"));
    await act$(() => rig.store.dispatch("ui.placeCaret", { boundary: 0 }));
    const flag = document.querySelector<HTMLElement>('[data-mark="in"]')!;
    await act$(() => fireEvent.mouseDown(flag, { button: 0, detail: 1 }));
    expect(state().selection.focus).toBe(2);
  });
});

describe("review: focus after a click", () => {
  it("a click on a paragraph's time takes focus out of the find box, so transcript keys work again", async () => {
    await openDemo();
    show(rig.store);
    await act$(() => rig.store.dispatch("everywhere.find"));
    const input = screen.getByRole("searchbox", { name: "Find in transcript" });
    expect(document.activeElement).toBe(input);
    const second = document.querySelectorAll<HTMLElement>('[data-row="paragraph"]')[1]!;
    await act$(() => fireEvent.mouseDown(second.querySelector("time")!, { button: 0, detail: 1 }));
    expect(state().selection.focus).toBe(Number(second.dataset.start));
    // A click on a word does move focus to the transcript; a click on the time should too.
    expect(document.activeElement).not.toBe(input);
  });
});

describe("review: I / O marks after clips are reordered", () => {
  it("draws the I and O flags at the marked source time when a later part of the source plays first", async () => {
    await openDemo();
    const id = "reorder";
    const duration = 60_000_000;
    const ref: SourceRef = { id, path: "D:\\Footage\\R.mp4", addedAt: "2026-11-13T09:00:00Z", media: media(duration) };
    // The second half plays first, then the first half (a clip moved on the timeline).
    const edit = createEditDocument([
      { id: "b", sourceId: id, start: 30_000_000, end: 60_000_000 },
      { id: "a", sourceId: id, start: 0, end: 30_000_000 },
    ]);
    const layout = layoutTranscript({ frameRate: RATE, sources: [ref], transcripts: { [id]: transcriptUntil(id, duration, true) }, edit: edit.current });
    const marks = { in: { sourceId: id, at: 10_000_000 }, out: { sourceId: id, at: 12_000_000 } };
    const expectedIn = layout.tokens.findIndex((t) => t.token.end > 10_000_000 && t.token.start < 30_000_000);
    const expectedOut = layout.tokens.findIndex((t) => t.token.start >= 12_000_000 && t.token.start < 30_000_000) - 1;
    expect(layout.tokens[expectedIn]!.token.start).toBe(10_000_000);
    const model = buildRows(layout);
    expect(markPosition(model, marks.in, "in"), "I mark position").toBe(expectedIn);
    expect(markPosition(model, marks.out, "out"), "O mark position").toBe(expectedOut);

    rig.store.setState({ layout, selection: { anchor: expectedIn, focus: expectedIn }, marks });
    show(rig.store);
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    const flagIn = document.querySelector<HTMLElement>('[data-mark="in"]');
    expect(flagIn?.nextElementSibling).toBe(token(expectedIn));
    // The first token of the document (source 30 s) is outside the marked range.
    expect(token(0)?.className ?? "").not.toContain("rc-tx-marked");
  });
});

describe("review: still transcribing after a cut on the timeline", () => {
  it("shows one blinking block where arriving text stops, not one per clip", async () => {
    await openDemo();
    const id = "partial";
    const duration = 60_000_000;
    const ref: SourceRef = { id, path: "D:\\Footage\\P.mp4", addedAt: "2026-11-13T09:00:00Z", media: media(duration) };
    // Transcribed up to 10 s; 20-30 s cut on the timeline before any text got there.
    const edit = createEditDocument([
      { id: "a", sourceId: id, start: 0, end: 20_000_000 },
      { id: "b", sourceId: id, start: 30_000_000, end: 60_000_000 },
    ]);
    const layout = layoutTranscript({ frameRate: RATE, sources: [ref], transcripts: { [id]: transcriptUntil(id, 10_000_000, false) }, edit: edit.current });
    rig.store.setState({ layout, selection: { anchor: 0, focus: 0 } });
    show(rig.store);
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(document.querySelectorAll('[data-row="untranscribed"][data-status="partial"]').length).toBeGreaterThan(0);
    expect(document.querySelectorAll("[data-arriving]").length).toBe(1);
  });
});

describe("fixes: presses that are not on a word", () => {
  it("a drag that starts on the space between two words selects whole words from there", async () => {
    await openDemo();
    show(rig.store);
    const gap = token(2).previousElementSibling as HTMLElement;
    await act$(() => fireEvent.mouseDown(gap, { button: 0, detail: 1 }));
    expect(state().selection.focus).toBe(2);
    await act$(() => fireEvent.mouseMove(token(3), { buttons: 1 }));
    expect(state().selection).toEqual({ anchor: 2, focus: 4 });
    // Back over the word before the space: the selection turns round at the space.
    await act$(() => fireEvent.mouseMove(token(1), { buttons: 1 }));
    expect(state().selection).toEqual({ anchor: 2, focus: 1 });
    await act$(() => fireEvent.mouseUp(window));
  });

  it("a click on the O flag after a word puts the caret after that word", async () => {
    await openDemo();
    show(rig.store);
    await act$(() => rig.store.dispatch("ui.placeCaret", { boundary: 2 }));
    await act$(() => rig.store.dispatch("transcript.markOut"));
    await act$(() => rig.store.dispatch("ui.placeCaret", { boundary: 0 }));
    const flag = document.querySelector<HTMLElement>('[data-mark="out"]')!;
    const before = Number((flag.previousElementSibling as HTMLElement).dataset.pos);
    await act$(() => fireEvent.mouseDown(flag, { button: 0, detail: 1 }));
    expect(state().selection.focus).toBe(before + 1);
  });

  it("a click in the blank area of a paragraph puts the caret at its end and focuses the transcript", async () => {
    await openDemo();
    show(rig.store);
    await act$(() => rig.store.dispatch("everywhere.find"));
    const para = document.querySelector<HTMLElement>('[data-row="paragraph"]')!;
    await act$(() => fireEvent.mouseDown(para.querySelector(".rc-tx-p__text")!, { button: 0, detail: 1 }));
    expect(state().selection.focus).toBe(Number(para.dataset.end));
    expect(document.activeElement).toBe(document.querySelector("[data-tx-scroller]"));
  });
});

describe("fixes: where text arrives", () => {
  it("later stretches of a source still being transcribed say they wait, without the progress or the block", async () => {
    await openDemo();
    const id = "partial";
    const duration = 60_000_000;
    const ref: SourceRef = { id, path: "D:\Footage\P.mp4", addedAt: "2026-11-13T09:00:00Z", media: media(duration) };
    const edit = createEditDocument([
      { id: "a", sourceId: id, start: 0, end: 20_000_000 },
      { id: "b", sourceId: id, start: 30_000_000, end: 60_000_000 },
    ]);
    const layout = layoutTranscript({ frameRate: RATE, sources: [ref], transcripts: { [id]: transcriptUntil(id, 10_000_000, false) }, edit: edit.current });
    const model = buildRows(layout);
    const partial = model.rows.filter((r) => r.kind === "untranscribed" && r.block.status === "partial");
    expect(partial.map((r) => (r.kind === "untranscribed" ? r.arrival : ""))).toEqual(["note", "none"]);
    rig.store.setState({ layout, selection: { anchor: 0, focus: 0 } });
    show(rig.store);
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    const shown = document.querySelectorAll<HTMLElement>('[data-row="untranscribed"][data-status="partial"]');
    expect(shown[0]!.textContent).toContain("text appears here as it is transcribed");
    expect(shown[1]!.textContent).toContain("not transcribed yet");
    // The block is drawn by the paragraph where the text stops.
    expect(document.querySelector('[data-row="paragraph"] [data-arriving]')).toBeTruthy();
  });

  it("with nothing transcribed and the clips reordered, the block goes at the start of the source", async () => {
    await openDemo();
    const id = "empty";
    const duration = 60_000_000;
    const ref: SourceRef = { id, path: "D:\Footage\E.mp4", addedAt: "2026-11-13T09:00:00Z", media: media(duration) };
    const edit = createEditDocument([
      { id: "b", sourceId: id, start: 30_000_000, end: 60_000_000 },
      { id: "a", sourceId: id, start: 0, end: 30_000_000 },
    ]);
    const layout = layoutTranscript({ frameRate: RATE, sources: [ref], transcripts: { [id]: transcriptUntil(id, 0, false) }, edit: edit.current });
    const model = buildRows(layout);
    const arrivals = model.rows.flatMap((r) => (r.kind === "untranscribed" && r.block.status === "partial" ? [[r.block.range.start, r.arrival]] : []));
    expect(arrivals).toEqual([
      [30_000_000, "none"],
      [0, "block"],
    ]);
  });
});

describe("fixes: marks by source time", () => {
  it("an O mark between two words sits after the word before it in source time", async () => {
    await openDemo();
    const id = "reorder";
    const duration = 60_000_000;
    const ref: SourceRef = { id, path: "D:\Footage\R.mp4", addedAt: "2026-11-13T09:00:00Z", media: media(duration) };
    const edit = createEditDocument([
      { id: "b", sourceId: id, start: 30_000_000, end: 60_000_000 },
      { id: "a", sourceId: id, start: 0, end: 30_000_000 },
    ]);
    const layout = layoutTranscript({ frameRate: RATE, sources: [ref], transcripts: { [id]: transcriptUntil(id, duration, true) }, edit: edit.current });
    const model = buildRows(layout);
    // 50.35 s falls in the pause after the word at 50.0 s (which ends at 50.32 s).
    const out = markPosition(model, { sourceId: id, at: 50_350_000 }, "out");
    expect(layout.tokens[out]!.token.start).toBeLessThan(50_350_000);
    expect(layout.tokens[out + 1]!.token.start).toBeGreaterThanOrEqual(50_350_000);
    const inn = markPosition(model, { sourceId: id, at: 50_350_000 }, "in");
    expect(layout.tokens[inn]!.token.end).toBeGreaterThan(50_350_000);
    expect(markPosition(model, { sourceId: "other", at: 0 }, "in")).toBe(-1);
  });
});

describe("fixes: the playhead in kept time with no text", () => {
  // Found in the real app (e2e "two-sources"): playing a second recording with no speech left
  // the caret on the first word of the first recording and the view at the top. (Here: the
  // part of a recording not transcribed yet.)
  it("draws the caret in that stretch, not on a word elsewhere", async () => {
    await openDemo();
    const id = "partial";
    const ref: SourceRef = { id, path: "D:\Footage\P.mp4", addedAt: "2026-11-13T09:00:00Z", media: media(60_000_000) };
    const edit = createEditDocument([{ id: "a", sourceId: id, start: 0, end: 60_000_000 }]);
    const layout = layoutTranscript({ frameRate: RATE, sources: [ref], transcripts: { [id]: transcriptUntil(id, 10_000_000, false) }, edit: edit.current });
    rig.store.setState({
      layout,
      selection: { anchor: 0, focus: 0 },
      playhead: { time: 40_000_000, position: { sourceId: id, at: 40_000_000 }, playing: false, speed: 0 },
    });
    show(rig.store);
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    const rows = [...document.querySelectorAll<HTMLElement>('[data-row="untranscribed"]')];
    expect(rows.length).toBe(1);
    expect(rows[0]!.dataset.current).toBe("");
    const carets = document.querySelectorAll("[data-caret]");
    expect(carets.length).toBe(1);
    expect(rows[0]!.contains(carets[0]!)).toBe(true);

    // Back in the text: the caret is on its word again and the stretch is no longer current.
    await act$(() => rig.store.setState({ playhead: { time: 1_000_000, position: { sourceId: id, at: 1_000_000 }, playing: false, speed: 0 } }));
    expect(document.querySelector('[data-row="untranscribed"]')!.hasAttribute("data-current")).toBe(false);
    const caret = document.querySelector("[data-caret]");
    expect(caret?.closest('[data-row="paragraph"]')).not.toBeNull();
  });
});
