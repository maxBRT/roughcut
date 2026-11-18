/**
 * The Transcript view against the real store and the stand-in core (spec 3.7 "state and
 * views"): what it draws (headers, times, cut text, pause chips, suggestions, marks, find, hidden
 * cut text, text still arriving), the mouse (caret, word drag, double-click), the caret kept in
 * view, the visual lines it registers, and that only the rows on screen are rendered.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditDocument } from "../../edit";
import { RoughcutProvider, type RoughcutStore } from "../../state";
import { createTestRig, type TestRig } from "../../state/testing";
import { layoutTranscript } from "../../transcript";
import type { MediaInfo, SourceRef, Token, Transcript, Utterance } from "../../types";
import { TranscriptView } from "./index";
import { buildRows, markPosition, rowOfBoundary } from "./rows";
import { createVisualLines, measureLines } from "./visualLines";
import { formatClock } from "./format";

let rig: TestRig;
const state = () => rig.store.getState();

const VIEW_HEIGHT = 600;
const realRect = Element.prototype.getBoundingClientRect;
const realClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!;
const realClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!;
const realScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!;
const isScroller = (el: Element) => el instanceof HTMLElement && el.dataset.txScroller !== undefined;

/** jsdom lays nothing out: give the scroller a size so the virtual list renders a screenful. */
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

async function run(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await rig.store.idle();
  });
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
const caret = () => document.querySelector("[data-caret]");

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

describe("Transcript view: what it draws", () => {
  it("draws the source header, paragraph times and every word in document order", async () => {
    await openDemo();
    show(rig.store);
    const layout = state().layout!;
    const header = layout.blocks.find((b) => b.kind === "source")!;
    expect(screen.getByText(header.kind === "source" ? header.name : "")).toBeTruthy();
    const firstPara = layout.blocks.find((b) => b.kind === "paragraph")!;
    if (firstPara.kind !== "paragraph") throw new Error("no paragraph");
    const para = document.querySelector('[data-row="paragraph"]')!;
    expect(para.querySelector("time")!.textContent).toBe(formatClock(firstPara.sourceTime));
    // The first paragraph's tokens, at document positions 0.., with their text.
    firstPara.tokens.forEach((t, i) => {
      const el = token(i);
      expect(el).toBeTruthy();
      expect(el.dataset.kind).toBe(t.token.kind);
      if (t.token.kind === "word") expect(el.textContent).toBe(t.token.text);
    });
  });

  it("draws pause chips and unrecognised-speech blocks as tokens", async () => {
    await openDemo();
    show(rig.store);
    const layout = state().layout!;
    const pausePos = layout.tokens.findIndex((t) => t.token.kind === "pause");
    const unrecPos = layout.tokens.findIndex((t) => t.token.kind === "unrecognised");
    expect(pausePos).toBeGreaterThanOrEqual(0);
    expect(unrecPos).toBeGreaterThanOrEqual(0);
    await act$(() => rig.store.dispatch("ui.placeCaret", { boundary: pausePos }));
    expect(token(pausePos).className).toContain("rc-pause");
    expect(token(pausePos).textContent).toMatch(/^pause \d+\.\ds$/);
    await act$(() => rig.store.dispatch("ui.placeCaret", { boundary: unrecPos }));
    expect(token(unrecPos).textContent).toMatch(/^unrecognised speech \d+\.\ds$/);
  });

  it("shows cut text struck through and dimmed in place, and hides it with H", async () => {
    await openDemo();
    show(rig.store);
    await act$(() => rig.store.dispatch("ui.selectTokens", { anchorToken: 1, focusToken: 3 }));
    await act$(() => rig.store.dispatch("transcript.cut"));
    for (const p of [1, 2, 3]) {
      expect(token(p).dataset.keep).toBe("cut");
      expect(token(p).className).toContain("rc-cut");
    }
    expect(token(0).dataset.keep).toBe("kept");
    expect(token(0).className).not.toContain("rc-cut");
    const cutText = state().layout!.tokens[1]!.token;

    await act$(() => rig.store.dispatch("transcript.toggleCutText"));
    expect(document.querySelector("[data-cut-hidden]")).toBeTruthy();
    expect(document.querySelectorAll('[data-keep="cut"]').length).toBe(0);
    // Token 1 is now what came after the cut.
    expect(state().layout!.tokens[1]!.token).not.toBe(cutText);

    await act$(() => fireEvent.click(document.querySelector("[data-cut-hidden]")!));
    expect(document.querySelector("[data-cut-hidden]")).toBeNull();
    expect(token(1).dataset.keep).toBe("cut");
  });

  it("draws pending suggestions with the dashed marker, their reason and A / D buttons", async () => {
    await openDemo();
    show(rig.store);
    const pending = state().layout!.suggestions.filter((v) => v.state === "pending" && v.firstPosition >= 0);
    expect(pending.length).toBeGreaterThan(0);
    const first = pending[0]!;
    await act$(() => rig.store.dispatch("ui.selectSuggestion", { suggestionId: first.suggestion.id }));
    const marked = token(first.firstPosition);
    expect(marked.dataset.suggestion).toBe(first.suggestion.id);
    if (marked.dataset.kind === "word") expect(marked.className).toContain("rc-tx-sug");
    const line = document.querySelector<HTMLElement>(`[data-suggestion-line="${first.suggestion.id}"]`)!;
    expect(line).toBeTruthy();
    expect(line.textContent).toContain(`1 of ${pending.length}`);
    expect(line.dataset.current).toBe("true");
    expect(line.textContent).toContain("cut");
    expect(line.textContent).toContain("keep");

    // A cut: the suggested tokens become cut and the line goes away.
    await act$(() => fireEvent.click(line.querySelector("[data-accept]")!));
    expect(document.querySelector(`[data-suggestion-line="${first.suggestion.id}"]`)).toBeNull();
    const v = state().layout!.suggestions.find((x) => x.suggestion.id === first.suggestion.id)!;
    expect(v.state).toBe("applied");
    expect(token(v.firstPosition).dataset.keep).toBe("cut");
  });

  it("D keep dismisses a suggestion: its marker and line go, the text stays kept", async () => {
    await openDemo();
    show(rig.store);
    const v = state().layout!.suggestions.find((x) => x.state === "pending" && x.firstPosition >= 0)!;
    await act$(() => rig.store.dispatch("ui.selectSuggestion", { suggestionId: v.suggestion.id }));
    const line = document.querySelector(`[data-suggestion-line="${v.suggestion.id}"]`)!;
    await act$(() => fireEvent.click(line.querySelector("[data-dismiss]")!));
    expect(document.querySelector(`[data-suggestion-line="${v.suggestion.id}"]`)).toBeNull();
    expect(token(v.firstPosition).dataset.suggestion).toBeUndefined();
    expect(token(v.firstPosition).dataset.keep).not.toBe("cut");
  });

  it("draws the I and O marks and shades the range between them", async () => {
    await openDemo();
    show(rig.store);
    await act$(() => rig.store.dispatch("ui.placeCaret", { boundary: 2 }));
    await act$(() => rig.store.dispatch("transcript.markIn"));
    await act$(() => rig.store.dispatch("ui.placeCaret", { boundary: 6 }));
    await act$(() => rig.store.dispatch("transcript.markOut"));
    const flagIn = document.querySelector('[data-mark="in"]')!;
    const flagOut = document.querySelector('[data-mark="out"]')!;
    expect(flagIn.nextElementSibling).toBe(token(2));
    // O sits after the last token that starts before the mark.
    const model = buildRows(state().layout!);
    const outPos = markPosition(model, state().marks.out, "out");
    expect(flagOut.previousElementSibling).toBe(token(outPos));
    expect(outPos).toBeGreaterThanOrEqual(4);
    for (let p = 2; p <= outPos; p++) expect(token(p).className).toContain("rc-tx-marked");
    expect(token(outPos + 1)?.className ?? "").not.toContain("rc-tx-marked");
  });
});

describe("Transcript view: find", () => {
  it("opens on Ctrl+F's action with focus, highlights matches and steps with Enter / Shift+Enter", async () => {
    await openDemo();
    show(rig.store);
    await act$(() => rig.store.dispatch("everywhere.find"));
    const input = screen.getByRole("searchbox", { name: "Find in transcript" }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    const word = state().layout!.tokens.find((t) => t.token.kind === "word" && t.token.text.length > 3)!;
    const text = word.token.kind === "word" ? word.token.text.replace(/[^\p{L}\p{N}']/gu, "") : "";
    await act$(() => fireEvent.change(input, { target: { value: text } }));
    const { matches, index } = state().find;
    expect(matches.length).toBeGreaterThan(0);
    expect(index).toBe(0);
    expect(screen.getByText(`1 of ${matches.length}`)).toBeTruthy();
    expect(token(matches[0]!.from).className).toContain("rc-tx-find-hit--current");
    if (matches.length > 1) {
      await act$(() => fireEvent.keyDown(input, { key: "Enter" }));
      expect(state().find.index).toBe(1);
      await act$(() => fireEvent.keyDown(input, { key: "Enter", shiftKey: true }));
      expect(state().find.index).toBe(0);
    }
    // Closing the box (Esc) takes the highlights away; the found words stay selected.
    await act$(() => rig.store.dispatch("everywhere.escape"));
    expect(state().find.open).toBe(false);
    expect(document.querySelectorAll(".rc-tx-find-hit")).toHaveLength(0);
    await act$(() => rig.store.dispatch("everywhere.find"));
    const again = screen.getByRole("searchbox", { name: "Find in transcript" }) as HTMLInputElement;
    expect(document.querySelectorAll(".rc-tx-find-hit").length).toBeGreaterThan(0);
    await act$(() => fireEvent.change(again, { target: { value: "zzzqqq" } }));
    expect(screen.getByText("no matches")).toBeTruthy();
    await act$(() => fireEvent.click(screen.getByText("close")));
    expect(screen.queryByRole("searchbox")).toBeNull();
  });
});

describe("Transcript view: mouse", () => {
  it("a click places the caret at the word, and the caret is drawn there", async () => {
    await openDemo();
    show(rig.store);
    await act$(() => fireEvent.mouseDown(token(4), { button: 0, detail: 1 }));
    expect(state().selection).toEqual({ anchor: 4, focus: 4 });
    expect(caret()!.nextElementSibling).toBe(token(4));
    // Shift+click extends.
    await act$(() => fireEvent.mouseDown(token(7), { button: 0, detail: 1, shiftKey: true }));
    expect(state().selection).toEqual({ anchor: 4, focus: 7 });
    for (const p of [4, 5, 6]) expect(token(p).className).toContain("rc-sel");
    expect(token(7).className).not.toContain("rc-sel");
  });

  it("a drag selects whole words, both ends included, in either direction", async () => {
    await openDemo();
    show(rig.store);
    await act$(() => fireEvent.mouseDown(token(2), { button: 0, detail: 1 }));
    await act$(() => fireEvent.mouseMove(token(5), { buttons: 1 }));
    expect(state().selection).toEqual({ anchor: 2, focus: 6 });
    await act$(() => fireEvent.mouseMove(token(0), { buttons: 1 }));
    expect(state().selection).toEqual({ anchor: 3, focus: 0 });
    await act$(() => fireEvent.mouseUp(window));
    // After the button is up, moving does nothing.
    await act$(() => fireEvent.mouseMove(token(8), { buttons: 0 }));
    expect(state().selection).toEqual({ anchor: 3, focus: 0 });
  });

  it("a double-click selects one word", async () => {
    await openDemo();
    show(rig.store);
    await act$(() => fireEvent.mouseDown(token(3), { button: 0, detail: 2 }));
    expect(state().selection).toEqual({ anchor: 3, focus: 4 });
    expect(token(3).className).toContain("rc-sel");
  });

  it("a click on a paragraph's time puts the caret at its start; on its blank end, at its end", async () => {
    await openDemo();
    show(rig.store);
    const paras = document.querySelectorAll<HTMLElement>('[data-row="paragraph"]');
    const second = paras[1]!;
    await act$(() => fireEvent.mouseDown(second.querySelector("time")!, { button: 0 }));
    expect(state().selection.focus).toBe(Number(second.dataset.start));
    await act$(() => fireEvent.mouseDown(second.querySelector(".rc-tx-p__text")!, { button: 0 }));
    expect(state().selection.focus).toBe(Number(second.dataset.end));
  });
});

describe("Transcript view: still transcribing", () => {
  it("shows text as it arrives, with the blinking block where it stops", async () => {
    rig = createTestRig({ stepMs: 100, transcriptBatches: 4 });
    await rig.store.init();
    show(rig.store);
    await act$(() => rig.store.dispatch("ui.dropFiles", { paths: ["D:\\Footage\\TAKE-9.mp4"] }));
    expect(state().screen).toBe("editor");
    // Before any text: one row for the kept time with no text yet.
    expect(document.querySelector('[data-row="untranscribed"]')).toBeTruthy();
    let seen = 0;
    let sawPartial = false;
    for (let i = 0; i < 200 && !state().layout?.blocks.every((b) => b.kind !== "untranscribed"); i++) {
      await run(100);
      const words = state().layout!.tokens.length;
      expect(words).toBeGreaterThanOrEqual(seen);
      seen = words;
      // The text arrives at the end: put the caret there so that end is on screen.
      await act$(() => rig.store.dispatch("ui.placeCaret", { boundary: words }));
      await run(20);
      const partial = document.querySelector('[data-row="untranscribed"][data-status="partial"]');
      if (partial && words > 0) {
        sawPartial = true;
        expect(partial.textContent).toContain("text appears here as it is transcribed");
        expect(document.querySelector("[data-arriving]")).toBeTruthy();
      }
    }
    expect(sawPartial).toBe(true);
    expect(seen).toBeGreaterThan(0);
    // Done: no untranscribed rows and no blinking block.
    expect(document.querySelector('[data-row="untranscribed"]')).toBeNull();
    expect(document.querySelector("[data-arriving]")).toBeNull();
  });
});

// ---- a long transcript, set straight into the store ----

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

/** An hour of speech: `paragraphs` utterances of `words` words, 400 ms per word. */
function longTranscript(sourceId: string, paragraphs: number, words: number): Transcript {
  let t = 400_000;
  const utterances: Utterance[] = [];
  for (let u = 0; u < paragraphs; u++) {
    const tokens: Token[] = [];
    for (let w = 0; w < words; w++) {
      tokens.push({ kind: "word", text: `w${u}x${w}`, start: t, end: t + 320_000, cutBefore: t - 40_000 });
      t += 400_000;
    }
    t += 400_000;
    utterances.push({ index: u, start: tokens[0]!.start, end: tokens[tokens.length - 1]!.end, tokens });
  }
  return { schemaVersion: 1, sourceId, model: "test", complete: true, utterances };
}

async function openLong(paragraphs = 450, words = 20): Promise<void> {
  await openDemo();
  const id = "long";
  const transcript = longTranscript(id, paragraphs, words);
  const duration = paragraphs * (words * 400_000 + 400_000) + 800_000;
  const ref: SourceRef = { id, path: "D:\\Footage\\LONG.mp4", addedAt: "2026-11-13T09:00:00Z", media: media(duration) };
  const edit = createEditDocument([{ id: "c1", sourceId: id, start: 0, end: duration }]);
  const layout = layoutTranscript({ frameRate: RATE, sources: [ref], transcripts: { [id]: transcript }, edit: edit.current });
  rig.store.setState({ layout, selection: { anchor: 0, focus: 0 } });
}

describe("Transcript view: long transcripts", () => {
  it("renders only the rows on screen for an hour of text", async () => {
    await openLong();
    const t0 = performance.now();
    show(rig.store);
    const elapsed = performance.now() - t0;
    const total = state().layout!.blocks.filter((b) => b.kind === "paragraph").length;
    const rendered = document.querySelectorAll('[data-row="paragraph"]').length;
    expect(total).toBe(450);
    expect(rendered).toBeGreaterThan(3);
    expect(rendered).toBeLessThan(40);
    expect(document.querySelectorAll("[data-pos]").length).toBeLessThan(800);
    // Generous bound for jsdom; the point is it does not grow with the transcript.
    expect(elapsed).toBeLessThan(2000);
  });

  it("scrolls to keep the caret in view when it moves far away (as it does while playing)", async () => {
    await openLong();
    show(rig.store);
    const far = 400 * 20 + 5;
    expect(token(far)).toBeNull();
    await act$(() => rig.store.setState({ selection: { anchor: far, focus: far } }));
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    const scroller = document.querySelector<HTMLElement>("[data-tx-scroller]")!;
    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(token(far)).toBeTruthy();
    expect(caret()!.nextElementSibling).toBe(token(far));
  });

  it("follows the playhead: playing moves the caret and the caret row stays rendered", async () => {
    await openDemo();
    show(rig.store);
    await act$(() => rig.store.dispatch("ui.placeCaret", { boundary: 0 }));
    await act$(() => rig.store.dispatch("everywhere.playPause"));
    const before = state().selection.focus;
    await act$(() => rig.player.advance(8000));
    const after = state().selection.focus;
    expect(after).toBeGreaterThan(before);
    expect(caret()).toBeTruthy();
    expect(caret()!.className).toContain("rc-tx-caret--steady");
    expect(token(after) ?? token(after - 1)).toBeTruthy();
  });
});

describe("Transcript view: visual lines", () => {
  it("registers visual lines with the store and removes them on unmount", async () => {
    await openDemo();
    const spy = vi.spyOn(rig.store, "setVisualLines");
    const view = show(rig.store);
    expect(spy).toHaveBeenCalledTimes(1);
    const lines = spy.mock.calls[0]![0]!;
    expect(typeof lines.lineUp).toBe("function");
    view.unmount();
    expect(spy).toHaveBeenLastCalledWith(null);
  });

  /** Lays out `perLine` tokens of 50px on each 26px line. */
  function stubTokens(root: HTMLElement, perLine: number): void {
    root.querySelectorAll<HTMLElement>("[data-pos]").forEach((el) => {
      const p = Number(el.dataset.pos);
      const line = Math.floor(p / perLine);
      const col = p % perLine;
      el.getBoundingClientRect = () =>
        ({ x: col * 50, y: line * 26, left: col * 50, right: col * 50 + 40, top: line * 26, bottom: line * 26 + 24, width: 40, height: 24, toJSON: () => ({}) }) as DOMRect;
    });
  }

  it("moves by measured lines: up, down, line start and end", () => {
    const root = document.createElement("div");
    for (let p = 0; p < 12; p++) {
      const s = document.createElement("span");
      s.dataset.pos = String(p);
      root.appendChild(s);
    }
    stubTokens(root, 5); // lines: 0-4, 5-9, 10-11
    const model = { tokenCount: 12, paragraphRows: [0], paragraphStarts: [0], rows: [], layout: null } as never;
    const lines = createVisualLines(() => root, () => model);
    expect(measureLines(root)!.map((l) => l.tokens.map((t) => t.pos))).toEqual([
      [0, 1, 2, 3, 4],
      [5, 6, 7, 8, 9],
      [10, 11],
    ]);
    expect(lines.lineDown(2)).toBe(7);
    expect(lines.lineDown(7)).toBe(12); // the short last line: its end (right of 11) is nearest
    expect(lines.lineDown(11)).toBe(12); // last line: document end
    expect(lines.lineUp(7)).toBe(2);
    expect(lines.lineUp(3)).toBe(0); // first line: document start
    expect(lines.lineStart(8)).toBe(5);
    expect(lines.lineEnd(6)).toBe(10);
    expect(lines.lineUp(12)).toBe(7); // from the document end (right of token 11, x = 90)
  });

  it("falls back to paragraphs when nothing is laid out", async () => {
    await openDemo();
    show(rig.store);
    const model = buildRows(state().layout!);
    const lines = createVisualLines(() => document.body, () => model);
    const secondStart = model.paragraphStarts[1]!;
    const thirdStart = model.paragraphStarts[2]!;
    expect(lines.lineDown(0)).toBe(secondStart);
    expect(lines.lineUp(thirdStart + 1)).toBe(thirdStart);
    expect(lines.lineUp(thirdStart)).toBe(secondStart);
    expect(lines.lineStart(secondStart + 2)).toBe(secondStart);
    expect(lines.lineEnd(secondStart)).toBe(thirdStart);
    expect(rowOfBoundary(model, model.tokenCount)).toBe(model.paragraphRows[model.paragraphRows.length - 1]);
  });

  it("Down in the store uses the registered lines", async () => {
    await openDemo();
    show(rig.store);
    const scroller = document.querySelector<HTMLElement>("[data-tx-scroller]")!;
    stubTokens(scroller, 4);
    await act$(() => rig.store.dispatch("ui.placeCaret", { boundary: 1 }));
    await act$(() => rig.store.dispatch("transcript.lineNext"));
    expect(state().selection.focus).toBe(5);
  });
});

describe("Transcript view: no project", () => {
  it("shows an empty state without a layout", async () => {
    rig = createTestRig({ stepMs: 100 });
    await rig.store.init();
    show(rig.store);
    expect(screen.getByText("No project open")).toBeTruthy();
  });
});
