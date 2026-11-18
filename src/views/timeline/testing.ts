/**
 * Test helpers for the Timeline view: a 2D context that records what is drawn (jsdom has no
 * canvas), and a switch that makes every `<canvas>` hand one out.
 */
import { vi } from "vitest";
import type { Ctx2D } from "./draw";

/** A text drawn with `fillText`. */
export interface DrawnText {
  text: string;
  x: number;
  y: number;
  fill: string;
}

/** Records the calls the timeline makes; text is 7 px per character wide. */
export class RecordingContext implements Ctx2D {
  fillStyle: string | CanvasGradient | CanvasPattern = "#000";
  strokeStyle: string | CanvasGradient | CanvasPattern = "#000";
  lineWidth = 1;
  font = "";
  textBaseline: CanvasTextBaseline = "alphabetic";
  textAlign: CanvasTextAlign = "start";
  globalAlpha = 1;
  texts: DrawnText[] = [];
  fillRects: { x: number; y: number; w: number; h: number; fill: string }[] = [];
  strokeRects: { x: number; y: number; w: number; h: number; stroke: string }[] = [];
  /** Rectangles added to paths (waveform bars and clip regions). */
  pathRects = 0;
  fills = 0;
  clears = 0;

  /** Forgets everything recorded (call before the frame to inspect). */
  reset(): void {
    this.texts = [];
    this.fillRects = [];
    this.strokeRects = [];
    this.pathRects = 0;
    this.fills = 0;
    this.clears = 0;
    this.roundRects = [];
  }

  save(): void {}
  restore(): void {}
  setTransform(): void {}
  clearRect(): void {
    this.reset();
    this.clears++;
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.fillRects.push({ x, y, w, h, fill: String(this.fillStyle) });
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.strokeRects.push({ x, y, w, h, stroke: String(this.strokeStyle) });
  }
  /** Rounded boxes in the current path; filled or stroked, each is recorded like a fillRect / strokeRect. */
  roundRects: { x: number; y: number; w: number; h: number; radii: number | number[] }[] = [];
  private path: { x: number; y: number; w: number; h: number; radii: number | number[] }[] = [];
  private plainInPath = 0;

  beginPath(): void {
    this.path = [];
    this.plainInPath = 0;
  }
  rect(): void {
    this.pathRects++;
    this.plainInPath++;
  }
  roundRect(x: number, y: number, w: number, h: number, radii: number | number[]): void {
    const r = { x, y, w, h, radii };
    this.path.push(r);
    this.roundRects.push(r);
  }
  /** A fill of plain rectangles (waveform bars) counts in `fills`; rounded boxes land in `fillRects`. */
  fill(): void {
    if (this.plainInPath > 0) this.fills++;
    for (const r of this.path) this.fillRects.push({ x: r.x, y: r.y, w: r.w, h: r.h, fill: String(this.fillStyle) });
  }
  stroke(): void {
    for (const r of this.path) this.strokeRects.push({ x: r.x, y: r.y, w: r.w, h: r.h, stroke: String(this.strokeStyle) });
  }
  clip(): void {}
  fillText(text: string, x: number, y: number): void {
    this.texts.push({ text, x, y, fill: String(this.fillStyle) });
  }
  measureText(text: string): { width: number } {
    return { width: text.length * 7 };
  }
}

/** Makes `getContext("2d")` return a `RecordingContext` per canvas; returns them and an undo. */
export function installRecordingCanvas(): { contexts: RecordingContext[]; restore: () => void } {
  const contexts: RecordingContext[] = [];
  const byCanvas = new WeakMap<HTMLCanvasElement, RecordingContext>();
  const spy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    let ctx = byCanvas.get(this);
    if (!ctx) {
      ctx = new RecordingContext();
      byCanvas.set(this, ctx);
      contexts.push(ctx);
    }
    return ctx as unknown as CanvasRenderingContext2D;
  } as unknown as HTMLCanvasElement["getContext"]);
  return { contexts, restore: () => spy.mockRestore() };
}
