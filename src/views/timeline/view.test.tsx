/**
 * The Timeline view against the real store on the stand-in core: what it shows, and the mouse
 * (click to place the playhead, drag an edge to trim, drag a clip to reorder, wheel to zoom).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RoughcutProvider, selectCaption, selectSequenceDuration, selectWaveformUrls } from "../../state";
import { createTestRig, type TestRig } from "../../state/testing";
import { encodeWaveform, snapToFrame } from "../../types";
import { TimelineView } from ".";
import { TRACK_TOP } from "./geometry";
import { installRecordingCanvas, type RecordingContext } from "./testing";

const WIDTH = 960; // the canvas width when the element cannot be measured (jsdom)
let rig: TestRig;
let canvasMock: ReturnType<typeof installRecordingCanvas>;
const state = () => rig.store.getState();

function demoWaveform(url: string): Uint8Array {
  const id = Object.entries(selectWaveformUrls(state())).find(([, u]) => u === url)?.[0] ?? "x";
  const values = new Uint8Array(4000).map((_, i) => 40 + ((i * 13) % 200));
  return encodeWaveform({ sourceId: id, valuesPerSecond: 20, count: values.length }, values);
}

/** Opens the demo project, cut into three clips at a third and two thirds. */
async function openThreeClips(): Promise<void> {
  rig = createTestRig({ stepMs: 20 });
  await rig.store.init();
  await rig.store.dispatch("ui.openProject", { projectId: rig.core.demo.projectId });
  await rig.store.idle();
  await rig.store.dispatch("ui.setView", { view: "timeline" });
  const d = selectSequenceDuration(state());
  await rig.store.dispatch("ui.seek", { time: Math.round(d / 3) });
  await rig.store.dispatch("timeline.split");
  await rig.store.dispatch("ui.seek", { time: Math.round((2 * d) / 3) });
  await rig.store.dispatch("timeline.split");
  await rig.store.idle();
  expect(state().edit!.current.clips).toHaveLength(3);
  // Playhead on the second cut: the start of the third clip.
  await rig.store.dispatch("ui.seek", { time: boundaries()[2]! });
  await rig.store.idle();
}

function renderView(fetchWaveform = vi.fn(async (url: string) => demoWaveform(url))) {
  const utils = render(
    <RoughcutProvider store={rig.store}>
      <TimelineView fetchWaveform={fetchWaveform} />
    </RoughcutProvider>,
  );
  const canvas = screen.getByRole("img", { name: /Timeline track/ }) as HTMLCanvasElement;
  return { ...utils, canvas, fetchWaveform, ctx: () => canvasMock.contexts[0] as RecordingContext };
}

/** Sequence time to canvas x at zoom 1. */
function xOf(t: number): number {
  return (t / selectSequenceDuration(state())) * WIDTH;
}

function boundaries(): number[] {
  const out = [0];
  for (const c of state().edit!.current.clips) out.push(out[out.length - 1]! + (c.end - c.start));
  return out;
}

const TRACK_Y = TRACK_TOP + 40;

function click(canvas: HTMLCanvasElement, x: number, y = TRACK_Y) {
  fireEvent.pointerDown(canvas, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  fireEvent.pointerUp(canvas, { clientX: x, clientY: y, button: 0, pointerId: 1 });
}

function drag(canvas: HTMLCanvasElement, from: number, to: number, y = TRACK_Y) {
  fireEvent.pointerDown(canvas, { clientX: from, clientY: y, button: 0, pointerId: 1 });
  const steps = 5;
  for (let i = 1; i <= steps; i++) fireEvent.pointerMove(canvas, { clientX: from + ((to - from) * i) / steps, clientY: y, pointerId: 1 });
  fireEvent.pointerUp(canvas, { clientX: to, clientY: y, button: 0, pointerId: 1 });
}

beforeEach(() => {
  canvasMock = installRecordingCanvas();
});

afterEach(() => {
  cleanup();
  canvasMock.restore();
  rig?.store.dispose();
  rig?.core.dispose();
});

describe("TimelineView", () => {
  it("shows the caption, the cut counter, the clip info and the zoom", async () => {
    await openThreeClips();
    const { container } = renderView();
    const caption = selectCaption(state());
    expect(caption?.current).toBeTruthy();
    expect(container.querySelector('[data-part="caption"] b')?.textContent).toBe(caption!.current);
    expect(container.querySelector('[data-part="caption"]')?.textContent).toBe(
      [caption!.before, caption!.current, caption!.after].filter((x) => x).join(" "),
    );
    // The playhead sits on the second cut.
    expect(screen.getByText("cut 2 of 2")).toBeTruthy();
    const info = container.querySelector('[data-part="clip-info"]')!.textContent!;
    expect(info).toMatch(/^Clip 3 of 3/);
    expect(info).toContain("from TAKE-1.mp4");
    expect(info).toContain("zoom: fit");
    // The mockup shows neither line: both are read out only (.tlv-status is visually hidden).
    const status = container.querySelector(".tlv-status")!;
    expect(status.querySelector('[data-part="cut-counter"]')).toBeTruthy();
    expect(status.querySelector('[data-part="clip-info"]')).toBeTruthy();
  });

  it("draws the three clips and their waveform once it has arrived", async () => {
    await openThreeClips();
    const url = selectWaveformUrls(state())[rig.core.demo.sourceId];
    expect(url).toBeTruthy();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const fetchWaveform = vi.fn(async (u: string) => {
      await gate;
      return demoWaveform(u);
    });
    const { ctx } = renderView(fetchWaveform);
    await waitFor(() => expect(ctx().clears).toBeGreaterThan(0));
    // Before the waveform arrives: clips without bars.
    expect(fetchWaveform).toHaveBeenCalledWith(url);
    expect(ctx().fills).toBe(0);
    expect(ctx().fillRects.filter((r) => r.fill === "#1C1C1A").length).toBe(3);
    // The clip under the playhead (the last) is outlined.
    expect(ctx().strokeRects).toHaveLength(1);
    expect(ctx().strokeRects[0]!.x).toBeGreaterThan(xOf(boundaries()[2]!) - 2);
    await act(async () => release());
    await waitFor(() => expect(ctx().fills).toBe(3));
    expect(ctx().texts.filter((t) => t.text === "TAKE-1.mp4")).toHaveLength(3);
  });

  it("a click on a clip or the ruler places the playhead on a frame", async () => {
    await openThreeClips();
    const { canvas } = renderView();
    const d = selectSequenceDuration(state());
    const rate = state().project!.frameRate;
    click(canvas, 100);
    await waitFor(() => expect(state().playhead.time).toBe(snapToFrame(Math.round((100 / WIDTH) * d), rate)));
    click(canvas, 480, 8); // the ruler
    await waitFor(() => expect(state().playhead.time).toBe(snapToFrame(Math.round(0.5 * d), rate)));
    await waitFor(() => expect(screen.getByText("cut 1 of 2")).toBeTruthy());
  });

  it("dragging the end edge of a clip trims it (one undo step)", async () => {
    await openThreeClips();
    const { canvas } = renderView();
    const [first] = state().edit!.current.clips;
    const before = selectSequenceDuration(state());
    const edgeX = xOf(boundaries()[1]!);
    drag(canvas, edgeX - 2, edgeX - 62);
    await waitFor(() => expect(state().edit!.current.clips[0]!.end).toBeLessThan(first!.end));
    const after = state().edit!.current.clips[0]!;
    const expectedCut = (60 / WIDTH) * before;
    expect(Math.abs(first!.end - after.end - expectedCut)).toBeLessThan(100_000);
    expect(selectSequenceDuration(state())).toBe(before - (first!.end - after.end));
    await rig.store.dispatch("everywhere.undo");
    expect(state().edit!.current.clips[0]).toEqual(first);
  });

  it("a press on an edge that barely moves is a click: playhead placed, nothing trimmed", async () => {
    await openThreeClips();
    const { canvas } = renderView();
    await rig.store.dispatch("ui.seek", { time: 0 });
    const before = state().edit!.current;
    const edgeX = xOf(boundaries()[1]!);
    fireEvent.pointerDown(canvas, { clientX: edgeX - 2, clientY: TRACK_Y, button: 0, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: edgeX - 4, clientY: TRACK_Y, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: edgeX - 4, clientY: TRACK_Y, button: 0, pointerId: 1 });
    const d = selectSequenceDuration(state());
    const rate = state().project!.frameRate;
    await waitFor(() => expect(state().playhead.time).toBe(snapToFrame(Math.round(((edgeX - 4) / WIDTH) * d), rate)));
    expect(state().edit!.current).toBe(before);
  });

  it("dragging an edge outwards brings cut material back", async () => {
    await openThreeClips();
    const { canvas } = renderView();
    // Cut the end of clip 1 first, then pull its edge back out.
    const edgeX = xOf(boundaries()[1]!);
    drag(canvas, edgeX - 2, edgeX - 80);
    await waitFor(() => expect(state().edit!.current.clips).toHaveLength(3));
    const shortened = state().edit!.current.clips[0]!.end;
    const newEdge = xOf(boundaries()[1]!);
    drag(canvas, newEdge - 2, newEdge + 200);
    // Pulled out past the kept material that follows: it stops there and the two clips join.
    await waitFor(() => expect(state().edit!.current.clips[0]!.end).toBeGreaterThan(shortened));
  });

  it("dragging a clip moves it to where it is dropped", async () => {
    await openThreeClips();
    const { canvas } = renderView();
    const ids = state().edit!.current.clips.map((c) => c.id);
    const b = boundaries();
    drag(canvas, xOf((b[0]! + b[1]!) / 2), WIDTH - 5);
    await waitFor(() => expect(state().edit!.current.clips.map((c) => c.id)).toEqual([ids[1], ids[2], ids[0]]));
  });

  it("a short press without moving does not reorder", async () => {
    await openThreeClips();
    const { canvas } = renderView();
    const ids = state().edit!.current.clips.map((c) => c.id);
    const b = boundaries();
    const x = xOf((b[0]! + b[1]!) / 2);
    drag(canvas, x, x + 3);
    await rig.store.idle();
    expect(state().edit!.current.clips.map((c) => c.id)).toEqual(ids);
  });

  it("the wheel zooms in and out, and the info line shows it", async () => {
    await openThreeClips();
    const { canvas, container } = renderView();
    fireEvent.wheel(canvas, { deltaY: -240, clientX: 300, clientY: TRACK_Y });
    await waitFor(() => expect(state().zoom).toBeCloseTo(2));
    expect(container.querySelector(".tlv-zoom")?.textContent).toBe("zoom: 2×");
    fireEvent.wheel(canvas, { deltaY: 480, clientX: 300, clientY: TRACK_Y });
    await waitFor(() => expect(state().zoom).toBe(1));
    expect(container.querySelector(".tlv-zoom")?.textContent).toBe("zoom: fit");
  });

  it("zoomed in, the playhead stays in view when it jumps", async () => {
    await openThreeClips();
    const { ctx } = renderView();
    await rig.store.dispatch("timeline.zoomIn");
    await rig.store.dispatch("timeline.zoomIn");
    await rig.store.dispatch("timeline.zoomIn"); // 8x
    await rig.store.dispatch("ui.seek", { time: 0 });
    await waitFor(() => expect(ctx().texts.some((t) => t.text === "0:00.0" && t.fill === "#101010")).toBe(true));
    const d = selectSequenceDuration(state());
    await rig.store.dispatch("ui.seek", { time: Math.round(d * 0.9) });
    // The view scrolled: the playhead line is on screen, near the middle, and its time is drawn.
    const playheadLine = () => ctx().fillRects.find((r) => r.fill === "#FF4D00" && r.y === 0 && r.w === 1);
    await waitFor(() => {
      const line = playheadLine();
      expect(line).toBeTruthy();
      expect(Math.abs(line!.x - WIDTH / 2)).toBeLessThan(5);
    });
    expect(ctx().texts.some((t) => t.fill === "#101010" && t.text !== "0:00.0")).toBe(true);
  });

  it("with no waveform available the clips are still drawn", async () => {
    await openThreeClips();
    const failing = vi.fn(async () => {
      throw new Error("404");
    });
    const { ctx } = renderView(failing);
    await waitFor(() => expect(failing).toHaveBeenCalled());
    await waitFor(() => expect(ctx().fillRects.filter((r) => r.fill === "#1C1C1A").length).toBe(3));
    expect(ctx().fills).toBe(0);
  });
});
