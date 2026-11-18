/**
 * Draws the Timeline track on a 2D canvas (spec 2.4.11): the ruler, the clips end to end with
 * their name and waveform (no thumbnails, spec 2.9), the clip under the playhead outlined, drag
 * previews, the scroll bar and the playhead with its time. Only what is on screen is drawn, so the
 * cost follows the width of the window, not the number of clips.
 */
import type { SequenceTime, SourceId } from "../../types";
import {
  formatTime,
  firstClipEndingAfter,
  pxPerMicro,
  SCROLL_H,
  SCROLL_TOP,
  ticks,
  timeToX,
  TRACK_BOTTOM,
  TRACK_H,
  TRACK_TOP,
  visibleSpan,
  type TrackLayout,
  type Viewport,
} from "./geometry";
import { peakBetween, type WavePeaks } from "./waveforms";

/** The part of `CanvasRenderingContext2D` the timeline uses (tests pass a recording stand-in). */
export interface Ctx2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textBaseline: CanvasTextBaseline;
  textAlign: CanvasTextAlign;
  globalAlpha: number;
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  roundRect(x: number, y: number, w: number, h: number, radii: number | number[]): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
}

/** Colours, from the design tokens (spec 2.4.11). */
export interface TimelineColors {
  clip: string;
  clipHover: string;
  ink: string;
  dim: string;
  accent: string;
  onAccent: string;
  line: string;
  line2: string;
}

/** The mockup's values (src/ui/tokens.css), used when the CSS variables cannot be read. */
export const DEFAULT_COLORS: TimelineColors = {
  clip: "#1C1C1A",
  clipHover: "#262623",
  ink: "#F2F2EC",
  dim: "#9A9A93",
  accent: "#FF4D00",
  onAccent: "#101010",
  line: "rgba(238, 238, 231, .14)",
  line2: "rgba(238, 238, 231, .28)",
};

export const DEFAULT_MONO = '"DM Mono", ui-monospace, "Cascadia Mono", Consolas, monospace';

/** A drag in progress, as drawn. */
export type DragPreview =
  | { kind: "trim"; x: number; label: string }
  | { kind: "move"; index: number; ghostX: number; ghostW: number; gapX: number };

/** Everything one frame of the track needs. */
export interface TimelineScene {
  width: number;
  height: number;
  /** The clips as drawn (with a trim preview applied). */
  layout: TrackLayout;
  viewport: Viewport;
  names: ReadonlyMap<SourceId, string>;
  peaks: ReadonlyMap<SourceId, WavePeaks>;
  /** The clip under the playhead (outlined), or -1. */
  current: number;
  hover: number;
  playhead: SequenceTime;
  drag: DragPreview | null;
  colors: TimelineColors;
  mono: string;
  /** Device pixels per CSS pixel (default 1): edges and lines are placed on whole device pixels. */
  dpr?: number;
  /** Shown in the track when there are no clips. */
  emptyText?: string;
}

/** What one draw did (for tests and the 300-clip check). */
export interface DrawStats {
  clips: number;
  bars: number;
  names: number;
}

const HEADER_H = 24;
const WAVE_TOP = TRACK_TOP + HEADER_H + 4;
const WAVE_H = TRACK_BOTTOM - 8 - WAVE_TOP;
const WAVE_MID = WAVE_TOP + WAVE_H / 2;
const BAR_STEP = 4;
const BAR_W = 2;
/** The mockup shows a clip's name only when it is wider than this. */
const NAME_MIN_PX = 90;

/** The mockup's clip corners (.clip border-radius) and the playhead label's (3px 0 0 3px). */
const CLIP_R = 4;
const LABEL_R = 3;
const LABEL_H = 18;
/** Where the ruler's and the playhead label's text sit (the mockup's labels share a line). */
const RULER_TEXT_Y = 3;

/** Snaps CSS pixel values to whole device pixels, so edges and 1 px lines stay sharp at any ratio. */
export interface PixelGrid {
  /** `v` moved to the nearest device pixel boundary. */
  snap(v: number): number;
  /** The thinnest line that covers whole device pixels (1 CSS px at ratio 1, 2/1.5 at 1.5). */
  hair: number;
}

export function pixelGrid(dpr = 1): PixelGrid {
  const r = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  return { snap: (v) => Math.round(v * r) / r, hair: Math.max(1, Math.round(r)) / r };
}

/** Draws one frame of the track. */
export function drawTimeline(ctx: Ctx2D, scene: TimelineScene): DrawStats {
  const { width, height, layout, viewport: vp, colors } = scene;
  const stats: DrawStats = { clips: 0, bars: 0, names: 0 };
  const px = pixelGrid(scene.dpr);
  const { snap, hair } = px;
  ctx.clearRect(0, 0, width, height);
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const scale = pxPerMicro(vp);

  // The playhead label's box, worked out first so the ruler labels it covers are left out.
  let head: { x: number; left: number; w: number; label: string } | null = null;
  if (vp.duration > 0 && scale > 0) {
    const raw = snap(timeToX(vp, scene.playhead));
    if (raw >= -1 && raw <= width + 1) {
      // At the very end (or start) the line stays on the canvas instead of one pixel past it.
      const x = Math.max(0, Math.min(width - hair, raw));
      ctx.font = `500 12px ${scene.mono}`;
      const label = formatTime(scene.playhead);
      const w = Math.ceil(ctx.measureText(label).width) + 10;
      head = { x, left: snap(Math.max(0, Math.min(width - w, x + hair - w))), w, label };
    }
  }

  // Ruler: labels only, as in the mockup.
  ctx.font = `400 12px ${scene.mono}`;
  ctx.fillStyle = colors.dim;
  if (scale > 0) {
    const { step, times } = ticks(vp);
    let lastEnd = -Infinity;
    for (const t of times) {
      const at = timeToX(vp, t);
      if (at < -60 || at > width) continue;
      const text = formatTime(t, step < 1_000_000);
      const tw = ctx.measureText(text).width;
      // A label that would run past the right edge ends at it instead (never cut off).
      const x = snap(Math.min(at, width - tw));
      if (x < lastEnd + 8) continue;
      if (head && x < head.left + head.w + 4 && x + tw > head.left - 4) continue;
      ctx.fillText(text, x, RULER_TEXT_Y);
      lastEnd = x + tw;
    }
  } else if (!head) {
    ctx.fillText(formatTime(0, false), 0, RULER_TEXT_Y);
  }

  // Clips on screen.
  const n = layout.clips.length;
  if (scale > 0 && n > 0) {
    const viewEnd = vp.start + visibleSpan(vp) + 1;
    const barW = snap(BAR_W) || hair;
    for (let i = firstClipEndingAfter(layout, vp.start); i < n && layout.starts[i]! < viewEnd; i++) {
      const clip = layout.clips[i]!;
      const seqStart = layout.starts[i]!;
      const rawX0 = timeToX(vp, seqStart);
      const rawX1 = timeToX(vp, layout.starts[i + 1]!);
      if (rawX1 < 0 || rawX0 > width) continue;
      const x0 = snap(rawX0);
      const x1 = snap(rawX1);
      const full = x1 - x0;
      // The mockup leaves 2 px between clips; very short clips keep a hairline gap, then none.
      const gap = full > 6 ? snap(2) : full > 2 ? hair : 0;
      const w = Math.max(hair, full - gap);
      const r = Math.min(CLIP_R, w / 2);
      stats.clips++;
      const dragged = scene.drag?.kind === "move" && scene.drag.index === i;
      ctx.globalAlpha = dragged ? 0.35 : 1;
      ctx.fillStyle = i === scene.hover && !dragged ? colors.clipHover : colors.clip;
      ctx.beginPath();
      ctx.roundRect(x0, TRACK_TOP, w, TRACK_H, r);
      ctx.fill();
      if (i === scene.current && w > 2 * hair) {
        // A 1 px border inside the clip's box (the mockup's .clip.on), on whole device pixels.
        ctx.strokeStyle = colors.ink;
        ctx.lineWidth = hair;
        ctx.beginPath();
        ctx.roundRect(x0 + hair / 2, TRACK_TOP + hair / 2, w - hair, TRACK_H - hair, Math.max(0, r - hair / 2));
        ctx.stroke();
      }

      // Name, clipped to the clip.
      if (w > NAME_MIN_PX) {
        const name = scene.names.get(clip.sourceId);
        if (name) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0, TRACK_TOP, w - 8, HEADER_H);
          ctx.clip();
          ctx.fillStyle = colors.dim;
          ctx.fillText(name, snap(Math.max(x0, Math.min(0, x1 - 8 - NAME_MIN_PX)) + 8), TRACK_TOP + 6);
          ctx.restore();
          stats.names++;
        }
      }

      // Waveform: one bar per 4 px, the loudest value under it. None until it has arrived.
      const peaks = scene.peaks.get(clip.sourceId);
      if (peaks) {
        const inset = w > 20 ? 5 : 0;
        const first = x0 + inset;
        const right = Math.min(x0 + w - inset, width + BAR_STEP);
        let k = first < -BAR_STEP ? Math.ceil((-BAR_STEP - first) / BAR_STEP) : 0;
        ctx.beginPath();
        let any = false;
        for (let bx = first + k * BAR_STEP; bx + BAR_W <= right; k++, bx = first + k * BAR_STEP) {
          const from = clip.start + (bx - x0) / scale;
          const to = clip.start + (bx + BAR_STEP - x0) / scale;
          const v = peakBetween(peaks, from, Math.min(to, clip.end));
          const h = Math.max(2, snap((v / 255) * WAVE_H));
          ctx.rect(snap(bx), snap(WAVE_MID - h / 2), barW, h);
          stats.bars++;
          any = true;
        }
        if (any) {
          ctx.fillStyle = colors.ink;
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
  } else if (n === 0 && scene.emptyText) {
    // Nothing kept: an empty slot with a line saying so, in place of the clips.
    ctx.strokeStyle = colors.line2;
    ctx.lineWidth = hair;
    ctx.beginPath();
    ctx.roundRect(hair / 2, TRACK_TOP + hair / 2, width - hair, TRACK_H - hair, CLIP_R);
    ctx.stroke();
    ctx.font = `400 13px ${scene.mono}`;
    ctx.fillStyle = colors.dim;
    ctx.textAlign = "center";
    ctx.fillText(scene.emptyText, snap(width / 2), TRACK_TOP + TRACK_H / 2 - 6);
    ctx.textAlign = "left";
  }

  // Drag previews.
  const drag = scene.drag;
  if (drag?.kind === "move") {
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = colors.clipHover;
    const gx = snap(drag.ghostX);
    const gw = snap(drag.ghostW);
    ctx.beginPath();
    ctx.roundRect(gx, TRACK_TOP + 6, gw, TRACK_H - 12, Math.min(CLIP_R, gw / 2));
    ctx.fill();
    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = hair;
    ctx.beginPath();
    ctx.roundRect(gx + hair / 2, TRACK_TOP + 6 + hair / 2, Math.max(hair, gw - hair), TRACK_H - 12 - hair, Math.max(0, Math.min(CLIP_R, gw / 2) - hair / 2));
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.accent;
    ctx.fillRect(snap(drag.gapX - 1), TRACK_TOP - 4, snap(2), TRACK_H + 8);
  } else if (drag?.kind === "trim") {
    ctx.fillStyle = colors.accent;
    ctx.fillRect(snap(drag.x), TRACK_TOP - 4, hair, TRACK_H + 8);
    ctx.font = `500 12px ${scene.mono}`;
    const tw = Math.ceil(ctx.measureText(drag.label).width) + 10;
    const left = snap(Math.max(0, Math.min(width - tw, drag.x + 4)));
    ctx.beginPath();
    ctx.roundRect(left, TRACK_BOTTOM - 22, tw, LABEL_H, LABEL_R);
    ctx.fill();
    ctx.fillStyle = colors.onAccent;
    ctx.fillText(drag.label, left + 5, TRACK_BOTTOM - 19);
  }

  // Scroll bar, when zoomed in.
  if (vp.zoom > 1 && vp.duration > 0) {
    ctx.fillStyle = colors.line;
    ctx.beginPath();
    ctx.roundRect(0, SCROLL_TOP, width, SCROLL_H, SCROLL_H / 2);
    ctx.fill();
    const thumb = scrollThumb(vp);
    ctx.fillStyle = colors.line2;
    ctx.beginPath();
    ctx.roundRect(snap(thumb.x), SCROLL_TOP, snap(thumb.w), SCROLL_H, SCROLL_H / 2);
    ctx.fill();
  }

  // Playhead and its time, the label ending at the line (as in the mockup).
  if (head) {
    ctx.fillStyle = colors.accent;
    ctx.fillRect(head.x, 0, hair, TRACK_BOTTOM);
    ctx.beginPath();
    ctx.roundRect(head.left, 0, head.w, LABEL_H, [LABEL_R, 0, 0, LABEL_R]);
    ctx.fill();
    ctx.font = `500 12px ${scene.mono}`;
    ctx.fillStyle = colors.onAccent;
    ctx.fillText(head.label, head.left + 5, RULER_TEXT_Y);
  }
  return stats;
}


/** Where the scroll bar's thumb is, in pixels. */
export function scrollThumb(vp: Viewport): { x: number; w: number } {
  if (vp.duration <= 0) return { x: 0, w: vp.width };
  const w = Math.max(24, vp.width / Math.max(1, vp.zoom));
  const room = vp.width - w;
  const maxStart = vp.duration - visibleSpan(vp);
  return { x: maxStart > 0 ? (vp.start / maxStart) * room : 0, w };
}
