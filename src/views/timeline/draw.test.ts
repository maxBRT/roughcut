import { describe, expect, it } from "vitest";
import type { Clip } from "../../types";
import { encodeWaveform, parseWaveform } from "../../types";
import { deviceAlignedWidth } from "./controller";
import { DEFAULT_COLORS, DEFAULT_MONO, drawTimeline, pixelGrid, type TimelineScene } from "./draw";
import { CANVAS_H, layoutClips, TRACK_TOP, type Viewport } from "./geometry";
import { RecordingContext } from "./testing";
import { buildPeaks, type WavePeaks } from "./waveforms";

const S = 1_000_000;

function peaksFor(sourceId: string, seconds: number, valuesPerSecond = 100): WavePeaks {
  const values = new Uint8Array(seconds * valuesPerSecond);
  for (let i = 0; i < values.length; i++) values[i] = (i * 37) % 256;
  return buildPeaks(parseWaveform(encodeWaveform({ sourceId, valuesPerSecond, count: values.length }, values)));
}

function scene(clips: Clip[], over: Partial<TimelineScene> = {}, vpOver: Partial<Viewport> = {}): TimelineScene {
  const layout = layoutClips(clips);
  return {
    width: 1000,
    height: CANVAS_H,
    layout,
    viewport: { width: 1000, zoom: 1, start: 0, duration: layout.duration, ...vpOver },
    names: new Map([
      ["a", "take-1.mp4"],
      ["b", "screen-demo.mp4"],
    ]),
    peaks: new Map(),
    current: -1,
    hover: -1,
    playhead: 0,
    drag: null,
    colors: DEFAULT_COLORS,
    mono: DEFAULT_MONO,
    ...over,
  };
}

const FOUR = [
  { id: "1", sourceId: "a", start: 0, end: 9 * S },
  { id: "2", sourceId: "a", start: 24 * S, end: 182.6 * S },
  { id: "3", sourceId: "a", start: 190 * S, end: 233.4 * S },
  { id: "4", sourceId: "b", start: 0, end: 51 * S },
];

describe("drawTimeline", () => {
  it("draws every clip with its name when wide enough, and outlines the current one", () => {
    const ctx = new RecordingContext();
    const stats = drawTimeline(ctx, scene(FOUR, { current: 1, playhead: 27.4 * S }));
    expect(stats.clips).toBe(4);
    const names = ctx.texts.filter((t) => t.y > TRACK_TOP).map((t) => t.text);
    // Clip 1 (9 s of 262 s in 1000 px, about 34 px) is too narrow for its name, as in the mockup.
    expect(names).toEqual(["take-1.mp4", "take-1.mp4", "screen-demo.mp4"]);
    expect(ctx.strokeRects).toHaveLength(1);
    expect(ctx.strokeRects[0]!.x).toBeGreaterThan(30);
    expect(ctx.strokeRects[0]!.stroke).toBe(DEFAULT_COLORS.ink);
    // The playhead label.
    expect(ctx.texts.some((t) => t.text === "0:27.4" && t.fill === DEFAULT_COLORS.onAccent)).toBe(true);
    // Ruler labels.
    expect(ctx.texts.some((t) => t.text === "0:00" && t.y < TRACK_TOP)).toBe(true);
  });

  it("keeps the playhead line on the canvas at the very end of the sequence", () => {
    for (const dpr of [1, 1.5]) {
      const ctx = new RecordingContext();
      const layout = layoutClips(FOUR);
      drawTimeline(ctx, scene(FOUR, { playhead: layout.duration, dpr }));
      const line = ctx.fillRects.find((r) => r.fill === DEFAULT_COLORS.accent && r.y === 0 && r.h > 100);
      expect(line).toBeDefined();
      expect(line!.x + line!.w).toBeLessThanOrEqual(1000);
      expect(line!.x).toBeGreaterThan(990);
    }
  });

  it("draws waveform bars only for sources whose waveform has arrived", () => {
    const without = new RecordingContext();
    expect(drawTimeline(without, scene(FOUR)).bars).toBe(0);
    const ctx = new RecordingContext();
    const stats = drawTimeline(ctx, scene(FOUR, { peaks: new Map([["a", peaksFor("a", 300)]]) }));
    // Clips 1-3 (source a) have bars, clip 4 (source b) does not: bars stop before its left edge.
    expect(stats.bars).toBeGreaterThan(150);
    const total = (9 + 158.6 + 43.4 + 51) * S;
    const startOf4 = ((9 + 158.6 + 43.4) * S * 1000) / total;
    expect(stats.bars).toBeLessThanOrEqual(Math.ceil(startOf4 / 4) + 3);
  });

  it("draws only what is on screen when zoomed in", () => {
    const clips: Clip[] = Array.from({ length: 300 }, (_, i) => ({ id: `c${i}`, sourceId: "a", start: i * 10 * S, end: i * 10 * S + 8 * S }));
    const ctx = new RecordingContext();
    const layout = layoutClips(clips);
    const stats = drawTimeline(ctx, scene(clips, {}, { zoom: 32, start: layout.duration / 2 }));
    expect(stats.clips).toBeLessThanOrEqual(12);
    expect(stats.clips).toBeGreaterThanOrEqual(9);
  });

  it("draws 300 clips with waveforms quickly (measured on this machine)", () => {
    // 300 clips of a one-hour source, 100 waveform values per second, fitted into 1600 px,
    // then zoomed to 8x mid-sequence. Measures the drawing code's own cost (the recording
    // context does no pixel work, so this is not the browser's raster time).
    const clips: Clip[] = Array.from({ length: 300 }, (_, i) => ({ id: `c${i}`, sourceId: "a", start: i * 12 * S, end: i * 12 * S + (4 + (i % 7)) * S }));
    const peaks = new Map([["a", peaksFor("a", 3600)]]);
    const ctx = new RecordingContext();
    const fit = scene(clips, { width: 1600, peaks, current: 150 }, { width: 1600 });
    const zoomed = scene(clips, { width: 1600, peaks, current: 150 }, { width: 1600, zoom: 8, start: fit.layout.duration / 2 });
    const frames = 200;
    let bars = 0;
    const t0 = performance.now();
    for (let f = 0; f < frames; f++) {
      const s = f % 2 === 0 ? fit : zoomed;
      bars += drawTimeline(ctx, { ...s, playhead: (f / frames) * s.layout.duration }).bars;
    }
    const perFrame = (performance.now() - t0) / frames;
    expect(drawTimeline(ctx, fit).clips).toBe(300);
    expect(bars).toBeGreaterThan(0);
    console.info(`timeline draw, 300 clips: ${perFrame.toFixed(3)} ms per frame (${frames} frames)`);
    // A 60 Hz frame is 16.7 ms; the drawing code must use a small part of it.
    expect(perFrame).toBeLessThan(4);
  });

  it("leaves out the ruler labels the playhead label would cover", () => {
    // 262 s in 1000 px: labels every 30 s (about 114 px apart). The playhead at 1:02 (x = 237)
    // ends its label on the line, over where "1:00" (x = 229) would be drawn.
    const ctx = new RecordingContext();
    drawTimeline(ctx, scene(FOUR, { playhead: 62 * S }));
    const ruler = ctx.texts.filter((t) => t.y < TRACK_TOP && t.fill === DEFAULT_COLORS.dim).map((t) => t.text);
    expect(ruler).toContain("0:30");
    expect(ruler).toContain("1:30");
    expect(ruler).not.toContain("1:00");
    const label = ctx.texts.find((t) => t.text === "1:02.0")!;
    expect(label.fill).toBe(DEFAULT_COLORS.onAccent);
    // Ruler labels and the playhead label share one line, as in the mockup.
    expect(ctx.texts.find((t) => t.text === "0:30")!.y).toBe(label.y);
  });

  it("ends the last ruler label at the right edge instead of cutting it off", () => {
    // 10:00 of material in 700 px: the 10:00 label falls on the right edge.
    const clips: Clip[] = [{ id: "1", sourceId: "a", start: 0, end: 600 * S }];
    const ctx = new RecordingContext();
    drawTimeline(ctx, scene(clips, { width: 700 }, { width: 700 }));
    const last = ctx.texts.find((t) => t.text === "10:00");
    expect(last).toBeTruthy();
    expect(last!.x + "10:00".length * 7).toBeLessThanOrEqual(700);
    const xs = ctx.texts.filter((t) => t.y < TRACK_TOP && t.fill === DEFAULT_COLORS.dim).map((t) => t.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it("draws clips as rounded boxes with 2 px between them, as the mockup", () => {
    const ctx = new RecordingContext();
    drawTimeline(ctx, scene(FOUR, { current: 1 }));
    const bodies = ctx.fillRects.filter((r) => r.fill === DEFAULT_COLORS.clip);
    expect(bodies).toHaveLength(4);
    expect(ctx.roundRects.filter((r) => r.y === TRACK_TOP && r.radii === 4)).toHaveLength(4);
    expect(bodies[1]!.x - (bodies[0]!.x + bodies[0]!.w)).toBeCloseTo(2, 5);
    // The outline sits inside the current clip's box.
    const o = ctx.strokeRects[0]!;
    expect(o.x).toBeCloseTo(bodies[1]!.x + 0.5, 5);
    expect(o.w).toBeCloseTo(bodies[1]!.w - 1, 5);
  });

  it("puts edges, bars and the playhead on whole device pixels at a ratio of 1.5", () => {
    const dpr = 1.5;
    const whole = (v: number) => Math.abs(v * dpr - Math.round(v * dpr)) < 1e-6;
    const ctx = new RecordingContext();
    drawTimeline(ctx, scene(FOUR, { dpr, current: 1, playhead: 27.4 * S }));
    const bodies = ctx.fillRects.filter((r) => r.fill === DEFAULT_COLORS.clip);
    expect(bodies).toHaveLength(4);
    expect(bodies.every((r) => whole(r.x) && whole(r.x + r.w))).toBe(true);
    const line = ctx.fillRects.find((r) => r.fill === DEFAULT_COLORS.accent && r.h > 100)!;
    expect(whole(line.x) && whole(line.x + line.w)).toBe(true);
    // A one-pixel line covers two whole device pixels rather than one and a half.
    expect(line.w * dpr).toBe(2);
    const o = ctx.strokeRects[0]!;
    // The outline's stroke (centred on its path) starts and ends on device pixel boundaries.
    const hair = pixelGrid(dpr).hair;
    expect(whole(o.x - hair / 2) && whole(o.x + o.w + hair / 2)).toBe(true);
    expect(pixelGrid(dpr).snap(10.2)).toBeCloseTo(10, 5);
    expect(pixelGrid(dpr).snap(10.4)).toBeCloseTo(32 / 3, 5);
    expect(pixelGrid(1).hair).toBe(1);
  });

  it("says so in the track when there are no clips", () => {
    const ctx = new RecordingContext();
    const stats = drawTimeline(ctx, scene([], { emptyText: "no clips · ctrl z to undo" }));
    expect(stats.clips).toBe(0);
    expect(ctx.texts.some((t) => t.text === "no clips · ctrl z to undo" && t.y > TRACK_TOP)).toBe(true);
    expect(ctx.strokeRects).toHaveLength(1);
    const quiet = new RecordingContext();
    drawTimeline(quiet, scene([]));
    expect(quiet.texts.some((t) => t.y > TRACK_TOP)).toBe(false);
  });
});

describe("deviceAlignedWidth", () => {
  it("keeps the canvas a whole number of device pixels wide", () => {
    expect(deviceAlignedWidth(1367.6, 1)).toBe(1367);
    expect(deviceAlignedWidth(1367, 1.5)).toBe(1366);
    expect(deviceAlignedWidth(1368, 1.5)).toBe(1368);
    expect(deviceAlignedWidth(1367, 1.25)).toBe(1364);
    for (const dpr of [1, 1.25, 1.5, 1.75, 2]) {
      for (let w = 300; w < 340; w++) {
        const got = deviceAlignedWidth(w, dpr);
        expect(got).toBeLessThanOrEqual(w);
        expect(Math.abs(got * dpr - Math.round(got * dpr))).toBeLessThan(1e-6);
      }
    }
  });
});
