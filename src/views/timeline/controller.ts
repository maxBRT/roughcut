/**
 * The canvas side of the Timeline view: keeps the drawing in step with the store and turns the
 * mouse into actions (spec 1.8 "Mouse works too"): click or drag on the ruler or a clip to place
 * the playhead, drag an edge to trim (`ui.trimEdgeTo`), drag a clip to reorder
 * (`ui.moveClipTo`), wheel to zoom (`ui.setZoom`), Shift+wheel or a sideways wheel to scroll.
 * It reads the store and dispatches actions only (spec 3.6 rule 1).
 */
import { formatChord } from "../../keys";
import { ZOOM_MAX, type Dispatch, type RoughcutState, type RoughcutStore } from "../../state";
import { fileNameOf } from "../../state";
import type { Clip, Micros, Rational, SourceId } from "../../types";
import { snapToFrame } from "../../types";
import {
  CANVAS_H,
  clampStart,
  clipIndexAt,
  dropIndex,
  formatTime,
  hitTest,
  initialScroll,
  layoutClips,
  nearestGap,
  pxPerMicro,
  syncScroll,
  timeToX,
  trimTarget,
  visibleSpan,
  withEdge,
  xToTime,
  type ScrollMemory,
  type TrackLayout,
  type Viewport,
} from "./geometry";
import {
  DEFAULT_COLORS,
  DEFAULT_MONO,
  drawTimeline,
  scrollThumb,
  type Ctx2D,
  type DragPreview,
  type DrawStats,
  type TimelineColors,
} from "./draw";
import type { WavePeaks } from "./waveforms";

/** Width used until the element can be measured (jsdom, first frame). */
const FALLBACK_WIDTH = 960;
/** A press on a clip or an edge becomes a drag (move or trim) after this many pixels; less is a click. */
const DRAG_THRESHOLD_PX = 4;
/** Dragging this close to a side scrolls the zoomed track. */
const AUTOSCROLL_PX = 24;
const FRAME_30: Rational = { num: 30, den: 1 };
/** What the track says when every clip has been removed: how to get them back. */
export function emptyText(s: RoughcutState): string {
  const chord = (s.keymap.chords.get("everywhere.undo") ?? [])[0];
  return chord === undefined ? "no clips" : `no clips · ${formatChord(chord, "cap")} to undo`;
}

/**
 * The canvas's CSS width: at most `measured`, and a whole number of device pixels wide, so the
 * browser never stretches the bitmap by a fraction of a pixel (which blurs every line). At a ratio
 * of 1.5 that means an even width; when no width within 8 px fits, the floor is used.
 */
export function deviceAlignedWidth(measured: number, dpr: number): number {
  const floor = Math.max(1, Math.floor(measured));
  for (let w = floor; w > 0 && w >= floor - 8; w--) {
    const device = w * dpr;
    if (Math.abs(device - Math.round(device)) < 1e-6) return w;
  }
  return floor;
}

type Drag =
  | { kind: "scrub"; last: Micros }
  | { kind: "scroll"; grab: number }
  | { kind: "press"; index: number; downX: number }
  | { kind: "edgePress"; index: number; edge: "start" | "end"; downX: number; downTime: Micros }
  | { kind: "move"; index: number; clipId: string; x: number; grab: number; gap: number }
  | { kind: "trim"; index: number; clip: Clip; edge: "start" | "end"; downTime: Micros; x: number; to: Micros };

/** Keeps one canvas drawn from the store and handles its mouse input. */
export class TimelineController {
  /** What the last draw did (read by tests). */
  lastStats: DrawStats | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: Ctx2D | null = null;
  private width = FALLBACK_WIDTH;
  private dpr = 1;
  private mem: ScrollMemory = initialScroll();
  private drag: Drag | null = null;
  private hover = -1;
  private peaks: ReadonlyMap<SourceId, WavePeaks> = new Map();
  private raf: number | null = null;
  private colors: TimelineColors = DEFAULT_COLORS;
  private mono = DEFAULT_MONO;
  private layoutCache: { clips: readonly Clip[]; layout: TrackLayout } | null = null;
  private namesCache: { sources: unknown; names: Map<SourceId, string> } | null = null;

  constructor(
    private readonly store: RoughcutStore,
    private readonly dispatch: Dispatch,
  ) {}

  /** Starts drawing into `canvas` (sized to `wrap`); returns the detach function. */
  attach(canvas: HTMLCanvasElement, wrap: HTMLElement): () => void {
    this.canvas = canvas;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
    this.ctx = ctx;
    this.readTheme(canvas);
    const measure = () => this.resize(wrap.clientWidth);
    measure();

    let last = this.store.getState();
    const unsub = this.store.subscribe((s) => {
      if (s.edit !== last.edit || s.playhead !== last.playhead || s.zoom !== last.zoom || s.project !== last.project) {
        this.requestDraw();
      }
      last = s;
    });
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver === "function") {
      ro = new ResizeObserver(measure);
      ro.observe(wrap);
    }
    window.addEventListener("resize", measure);

    const down = (e: PointerEvent) => this.onDown(e);
    const move = (e: PointerEvent) => this.onMove(e);
    const up = (e: PointerEvent) => this.onUp(e);
    const cancel = () => this.onCancel();
    const leave = () => this.setHover(-1);
    const wheel = (e: WheelEvent) => this.onWheel(e);
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("wheel", wheel, { passive: false });
    this.paint();

    return () => {
      unsub();
      ro?.disconnect();
      window.removeEventListener("resize", measure);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("wheel", wheel);
      if (this.raf !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.raf);
      this.raf = null;
      this.canvas = null;
      this.ctx = null;
      this.drag = null;
    };
  }

  /** New waveforms arrived. */
  setPeaks(peaks: ReadonlyMap<SourceId, WavePeaks>): void {
    if (peaks === this.peaks) return;
    this.peaks = peaks;
    this.requestDraw();
  }

  /** Draws on the next animation frame (at most once per frame). */
  requestDraw(): void {
    if (!this.canvas || this.raf !== null) return;
    if (typeof requestAnimationFrame !== "function") {
      this.paint();
      return;
    }
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.paint();
    });
  }

  /** Draws now. */
  paint(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const s = this.store.getState();
    const layout = this.layout(s);
    this.mem = syncScroll(this.mem, {
      zoom: s.zoom,
      duration: layout.duration,
      width: this.width,
      playhead: s.playhead.time,
      playing: s.playhead.playing,
    });
    const vp = this.viewport(layout);
    const ctx = this.ctx;
    if (!ctx) return;

    let drawn = layout;
    let preview: DragPreview | null = null;
    const d = this.drag;
    if (d?.kind === "trim") {
      drawn = layoutClips(withEdge(layout.clips, d.index, d.edge, d.to));
      const base = d.edge === "start" ? d.clip.start : d.clip.end;
      const delta = d.to - base;
      preview = { kind: "trim", x: d.x, label: `${d.edge === "start" ? "start" : "end"} ${delta >= 0 ? "+" : "−"}${formatTime(Math.abs(delta))}` };
    } else if (d?.kind === "move") {
      const w = timeToX(vp, layout.starts[d.index + 1]!) - timeToX(vp, layout.starts[d.index]!);
      const ghostW = Math.max(24, Math.min(240, w));
      preview = {
        kind: "move",
        index: d.index,
        ghostX: d.x - Math.min(d.grab, ghostW / 2),
        ghostW,
        gapX: timeToX(vp, layout.starts[d.gap]!),
      };
    }

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.lastStats = drawTimeline(ctx, {
      width: this.width,
      height: CANVAS_H,
      layout: drawn,
      viewport: vp,
      names: this.names(s),
      peaks: this.peaks,
      current: s.edit ? clipIndexAt(layout, s.playhead.time) : -1,
      hover: this.drag ? -1 : this.hover,
      playhead: s.playhead.time,
      drag: preview,
      colors: this.colors,
      mono: this.mono,
      dpr: this.dpr,
      emptyText: s.edit && s.edit.current.clips.length === 0 ? emptyText(s) : "",
    });
  }

  // ---- reading the store ----

  private layout(s: RoughcutState): TrackLayout {
    const clips = s.edit?.current.clips ?? [];
    if (this.layoutCache?.clips !== clips) this.layoutCache = { clips, layout: layoutClips(clips) };
    return this.layoutCache.layout;
  }

  private names(s: RoughcutState): ReadonlyMap<SourceId, string> {
    const sources = s.project?.sources ?? null;
    if (this.namesCache?.sources !== sources) {
      this.namesCache = { sources, names: new Map((sources ?? []).map((r) => [r.id, fileNameOf(r.path)])) };
    }
    return this.namesCache.names;
  }

  private viewport(layout: TrackLayout): Viewport {
    return { width: this.width, zoom: this.mem.zoom, start: this.mem.start, duration: layout.duration };
  }

  private rate(): Rational {
    return this.store.getState().project?.frameRate ?? FRAME_30;
  }

  private sourceDuration(id: SourceId): Micros {
    return this.store.getState().project?.sources.find((r) => r.id === id)?.media.duration ?? 0;
  }

  // ---- size and theme ----

  private resize(measured: number): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const dpr = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const width = deviceAlignedWidth(measured > 0 ? measured : FALLBACK_WIDTH, dpr);
    if (width === this.width && dpr === this.dpr && canvas.width === Math.round(width * dpr)) return;
    this.width = width;
    this.dpr = dpr;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(CANVAS_H * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${CANVAS_H}px`;
    this.paint();
  }

  private readTheme(el: HTMLElement): void {
    let css: CSSStyleDeclaration | null = null;
    try {
      css = getComputedStyle(el);
    } catch {
      css = null;
    }
    const v = (name: string, fallback: string) => css?.getPropertyValue(name).trim() || fallback;
    this.colors = {
      clip: v("--clip", DEFAULT_COLORS.clip),
      clipHover: v("--clip-hi", DEFAULT_COLORS.clipHover),
      ink: v("--o-ink", DEFAULT_COLORS.ink),
      dim: v("--o-dim", DEFAULT_COLORS.dim),
      accent: v("--accent", DEFAULT_COLORS.accent),
      onAccent: v("--on-accent", DEFAULT_COLORS.onAccent),
      line: v("--line", DEFAULT_COLORS.line),
      line2: v("--line-2", DEFAULT_COLORS.line2),
    };
    this.mono = v("--mono", DEFAULT_MONO);
  }

  // ---- the mouse ----

  private point(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private current(): { s: RoughcutState; layout: TrackLayout; vp: Viewport } {
    const s = this.store.getState();
    const layout = this.layout(s);
    return { s, layout, vp: this.viewport(layout) };
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.canvas) return;
    const { s, layout, vp } = this.current();
    if (!s.edit) return;
    const { x, y } = this.point(e);
    try {
      this.canvas.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is a nicety (a drag that leaves the canvas); without it the drag still works inside.
    }
    e.preventDefault();
    const hit = hitTest(layout, vp, x, y, vp.zoom > 1);
    switch (hit.kind) {
      case "scrollbar": {
        const thumb = scrollThumb(vp);
        const grab = x >= thumb.x && x <= thumb.x + thumb.w ? x - thumb.x : thumb.w / 2;
        this.drag = { kind: "scroll", grab };
        this.scrollThumbTo(x - grab);
        break;
      }
      case "edge":
        // Only a trim once the pointer moves: a plain click near a cut still places the playhead.
        this.drag = { kind: "edgePress", index: hit.index, edge: hit.edge, downX: x, downTime: xToTime(vp, x) };
        break;
      case "clip":
        this.drag = { kind: "press", index: hit.index, downX: x };
        break;
      default:
        this.drag = { kind: "scrub", last: -1 };
        this.seekAt(x);
    }
  }

  private onMove(e: PointerEvent): void {
    if (!this.canvas) return;
    const { x, y } = this.point(e);
    const d = this.drag;
    const { layout, vp } = this.current();
    if (!d) {
      const hit = hitTest(layout, vp, x, y, vp.zoom > 1);
      this.canvas.style.cursor =
        hit.kind === "edge" ? "ew-resize" : hit.kind === "clip" ? "grab" : hit.kind === "ruler" || hit.kind === "track" ? "pointer" : "default";
      this.setHover(hit.kind === "clip" || hit.kind === "edge" ? hit.index : -1);
      return;
    }
    switch (d.kind) {
      case "scrub":
        this.seekAt(x);
        break;
      case "scroll":
        this.scrollThumbTo(x - d.grab);
        break;
      case "press":
        if (Math.abs(x - d.downX) > DRAG_THRESHOLD_PX) {
          const clip = layout.clips[d.index];
          if (!clip) break;
          this.canvas.style.cursor = "grabbing";
          this.drag = { kind: "move", index: d.index, clipId: clip.id, x, grab: d.downX - timeToX(vp, layout.starts[d.index]!), gap: nearestGap(layout, vp, x) };
          this.requestDraw();
        }
        break;
      case "edgePress": {
        if (Math.abs(x - d.downX) <= DRAG_THRESHOLD_PX) break;
        const clip = layout.clips[d.index];
        if (!clip) break;
        const to = trimTarget(clip, d.edge, xToTime(vp, x) - d.downTime, this.rate(), this.sourceDuration(clip.sourceId));
        this.drag = { kind: "trim", index: d.index, clip, edge: d.edge, downTime: d.downTime, x, to };
        this.requestDraw();
        break;
      }
      case "move": {
        this.autoScroll(x, vp);
        const now = this.current().vp;
        d.x = x;
        d.gap = nearestGap(layout, now, x);
        this.requestDraw();
        break;
      }
      case "trim": {
        this.autoScroll(x, vp);
        const now = this.current().vp;
        d.x = x;
        d.to = trimTarget(d.clip, d.edge, xToTime(now, x) - d.downTime, this.rate(), this.sourceDuration(d.clip.sourceId));
        this.requestDraw();
        break;
      }
    }
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    try {
      this.canvas?.releasePointerCapture?.(e.pointerId);
    } catch {
      // Not captured.
    }
    if (!d || !this.canvas) return;
    const { x } = this.point(e);
    this.canvas.style.cursor = "";
    switch (d.kind) {
      case "press":
      case "edgePress":
        this.seekAt(x);
        break;
      case "move": {
        const index = dropIndex(d.index, d.gap);
        if (index !== d.index) void this.dispatch("ui.moveClipTo", { clipId: d.clipId, index });
        break;
      }
      case "trim": {
        const base = d.edge === "start" ? d.clip.start : d.clip.end;
        if (d.to !== base) void this.dispatch("ui.trimEdgeTo", { clipId: d.clip.id, edge: d.edge, to: d.to });
        break;
      }
      default:
        break;
    }
    this.requestDraw();
  }

  private onCancel(): void {
    if (!this.drag) return;
    this.drag = null;
    this.requestDraw();
  }

  private onWheel(e: WheelEvent): void {
    const { s, vp } = this.current();
    if (!s.edit || vp.duration <= 0) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.width : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
      const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
      const scale = pxPerMicro(vp);
      if (scale > 0 && vp.zoom > 1) {
        this.mem = { ...this.mem, start: clampStart(vp, vp.start + delta / scale) };
        this.requestDraw();
      }
      return;
    }
    if (dy === 0) return;
    const zoom = Math.max(1, Math.min(ZOOM_MAX, s.zoom * 2 ** (-dy / 240)));
    if (zoom === s.zoom) return;
    const { x } = this.point(e);
    this.mem = { ...this.mem, anchor: { time: xToTime(vp, x), x } };
    void this.dispatch("ui.setZoom", { zoom });
  }

  // ---- helpers ----

  private setHover(index: number): void {
    if (index === this.hover) return;
    this.hover = index;
    this.requestDraw();
  }

  /** Playhead to the frame nearest pixel `x` (within the sequence). */
  private seekAt(x: number): void {
    const { s, layout, vp } = this.current();
    if (!s.edit || layout.duration <= 0) return;
    const t = Math.max(0, Math.min(layout.duration, snapToFrame(Math.round(Math.max(0, xToTime(vp, x))), this.rate())));
    if (this.drag?.kind === "scrub") {
      if (this.drag.last === t) return;
      this.drag.last = t;
    }
    void this.dispatch("ui.seek", { time: t });
  }

  private scrollThumbTo(thumbX: number): void {
    const { vp } = this.current();
    const thumb = scrollThumb(vp);
    const room = vp.width - thumb.w;
    const maxStart = vp.duration - visibleSpan(vp);
    const start = room > 0 ? (thumbX / room) * maxStart : 0;
    this.mem = { ...this.mem, start: clampStart(vp, start) };
    this.requestDraw();
  }

  private autoScroll(x: number, vp: Viewport): void {
    if (vp.zoom <= 1) return;
    const span = visibleSpan(vp);
    let start = vp.start;
    if (x < AUTOSCROLL_PX) start -= span * 0.03;
    else if (x > vp.width - AUTOSCROLL_PX) start += span * 0.03;
    else return;
    this.mem = { ...this.mem, start: clampStart(vp, start) };
  }
}
