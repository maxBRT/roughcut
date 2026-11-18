/**
 * Review tests (track viewTimeline-review): defects found by an independent review.
 * Failing tests here are left for the fixer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RoughcutProvider, selectSequenceDuration, selectWaveformUrls } from "../../state";
import { createTestRig, type TestRig } from "../../state/testing";
import { encodeWaveform } from "../../types";
import { TimelineView } from ".";
import { TRACK_TOP } from "./geometry";
import { installRecordingCanvas } from "./testing";

const WIDTH = 960;
let rig: TestRig;
let canvasMock: ReturnType<typeof installRecordingCanvas>;
const state = () => rig.store.getState();
const TRACK_Y = TRACK_TOP + 40;

function wave(url: string): Uint8Array {
  const id = Object.entries(selectWaveformUrls(state())).find(([, u]) => u === url)?.[0] ?? "x";
  const values = new Uint8Array(4000).fill(100);
  return encodeWaveform({ sourceId: id, valuesPerSecond: 20, count: values.length }, values);
}

async function openWithClips(n: number): Promise<void> {
  rig = createTestRig({ stepMs: 20 });
  await rig.store.init();
  await rig.store.dispatch("ui.openProject", { projectId: rig.core.demo.projectId });
  await rig.store.idle();
  await rig.store.dispatch("ui.setView", { view: "timeline" });
  const d = selectSequenceDuration(state());
  for (let k = 1; k < n; k++) {
    await rig.store.dispatch("ui.seek", { time: Math.round((k * d) / n) });
    await rig.store.dispatch("timeline.split");
  }
  await rig.store.idle();
  expect(state().edit!.current.clips).toHaveLength(n);
  await rig.store.dispatch("ui.seek", { time: 0 });
  await rig.store.idle();
}

function renderView() {
  render(
    <RoughcutProvider store={rig.store}>
      <TimelineView fetchWaveform={vi.fn(async (u: string) => wave(u))} />
    </RoughcutProvider>,
  );
  return screen.getByRole("img", { name: /Timeline track/ }) as HTMLCanvasElement;
}

function boundaries(): number[] {
  const out = [0];
  for (const c of state().edit!.current.clips) out.push(out[out.length - 1]! + (c.end - c.start));
  return out;
}
const xOf = (t: number) => (t / selectSequenceDuration(state())) * WIDTH;

function click(canvas: HTMLCanvasElement, x: number, y = TRACK_Y) {
  fireEvent.pointerDown(canvas, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  fireEvent.pointerUp(canvas, { clientX: x, clientY: y, button: 0, pointerId: 1 });
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

describe("review: click to place the playhead (spec 1.8 'Mouse works too')", () => {
  it("a click (no drag) near a cut still places the playhead", async () => {
    await openWithClips(3);
    const canvas = renderView();
    const x = xOf(boundaries()[1]!) - 3; // 3 px before the first cut, inside clip 1
    expect(state().playhead.time).toBe(0);
    click(canvas, x);
    await rig.store.idle();
    // Fails: the press lands in the 6 px edge zone, starts a zero-length trim and is dropped.
    expect(state().playhead.time).toBeGreaterThan(0);
  });

  it("with many clips at fit, a click on the track places the playhead almost everywhere", async () => {
    await openWithClips(60); // 16 px per clip at 960 px
    const canvas = renderView();
    let moved = 0;
    const tries = 40;
    for (let i = 0; i < tries; i++) {
      const before = state().playhead.time;
      const x = 7 + i * 23.3; // spread over the track
      click(canvas, x);
      await rig.store.idle();
      if (state().playhead.time !== before) moved++;
    }
    // Fails: roughly two thirds of each clip's width is an edge zone, so most clicks do nothing.
    expect(moved).toBeGreaterThanOrEqual(tries - 2);
  });
});

describe("review: probes that pass (kept as regression checks)", () => {
  it("dragging the start edge of a clip inwards shortens it from the start", async () => {
    await openWithClips(3);
    const canvas = renderView();
    const second = state().edit!.current.clips[1]!;
    const d = selectSequenceDuration(state());
    const edgeX = xOf(boundaries()[1]!) + 2;
    fireEvent.pointerDown(canvas, { clientX: edgeX, clientY: TRACK_Y, button: 0, pointerId: 1 });
    for (let i = 1; i <= 5; i++) fireEvent.pointerMove(canvas, { clientX: edgeX + 12 * i, clientY: TRACK_Y, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: edgeX + 60, clientY: TRACK_Y, button: 0, pointerId: 1 });
    await rig.store.idle();
    const after = state().edit!.current.clips.find((c) => c.id === second.id)!;
    expect(Math.abs(after.start - second.start - (60 / WIDTH) * d)).toBeLessThan(100_000);
    expect(after.end).toBe(second.end);
  });
});

describe("review: scrolling and zoom probes", () => {
  const playheadX = () =>
    canvasMock.contexts[0]!.fillRects.find((r) => r.fill === "#FF4D00" && r.y === 0 && r.w === 1)?.x;

  it("the wheel zooms around the mouse: the playhead under the mouse stays put", async () => {
    await openWithClips(3);
    await rig.store.dispatch("ui.seek", { time: boundaries()[2]! });
    const canvas = renderView();
    await new Promise((r) => setTimeout(r, 50));
    const x0 = playheadX()!;
    fireEvent.wheel(canvas, { deltaY: -240, clientX: x0, clientY: TRACK_Y });
    await new Promise((r) => setTimeout(r, 50));
    expect(state().zoom).toBeCloseTo(2);
    expect(Math.abs(playheadX()! - x0)).toBeLessThanOrEqual(1);
  });

  it("while playing zoomed in, the playhead never leaves the view", async () => {
    await openWithClips(3);
    const canvas = renderView();
    void canvas;
    for (let i = 0; i < 4; i++) await rig.store.dispatch("timeline.zoomIn"); // 16x
    await rig.store.dispatch("everywhere.playPause");
    await rig.store.idle();
    for (let i = 0; i < 40; i++) {
      rig.player.advance(500);
      await new Promise((r) => setTimeout(r, 20));
      const x = playheadX();
      expect(x, `frame ${i} at ${state().playhead.time}`).toBeDefined();
    }
    expect(state().playhead.time).toBeGreaterThan(10_000_000);
  });
});
