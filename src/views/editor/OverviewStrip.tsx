/**
 * The thin overview of the whole sequence along the bottom of the Transcript view (spec 1.7 C):
 * kept, cut, suggested and not-yet-transcribed material drawn as bars on a canvas, with the
 * playhead. Clicking or dragging on it moves the playhead (`ui.seek`).
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  selectClips,
  selectPendingSuggestions,
  selectWaveformUrls,
  useDispatch,
  useRoughcut,
  type RoughcutState,
} from "../../state";
import { firstClipEnd, parseWaveform, type Rational, type SourceId, type SourceRef, type Waveform } from "../../types";
import { formatTimecode } from "./format";
import {
  BAR_PITCH,
  buildOverview,
  drawOverview,
  fractionOfTime,
  overviewBars,
  timeAtFraction,
  type Loudness,
  type OverviewColors,
  type OverviewModel,
  type OverviewSource,
} from "./overview";

const NO_SOURCES: readonly SourceRef[] = [];
const STRIP_HEIGHT = 34;
const FALLBACK_COLORS: OverviewColors = { ink: "#F2F2EC", accent: "#FF4D00", pending: "#3A3A36" };

/* ---- waveforms --------------------------------------------------------------------------- */

const waveformCache = new Map<string, Promise<Waveform | null>>();
const WAVEFORM_CACHE_MAX = 32;

/** Fetches and parses a waveform file once per address; a failed fetch is tried again next time. */
function loadWaveform(url: string): Promise<Waveform | null> {
  const known = waveformCache.get(url);
  if (known) return known;
  const p = (typeof fetch === "function" ? fetch(url) : Promise.reject(new Error("no fetch")))
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((buf) => (buf ? parseWaveform(buf) : null))
    .catch(() => null)
    .then((w) => {
      if (!w) waveformCache.delete(url);
      return w;
    });
  waveformCache.set(url, p);
  while (waveformCache.size > WAVEFORM_CACHE_MAX) {
    const oldest = waveformCache.keys().next().value;
    if (oldest === undefined) break;
    waveformCache.delete(oldest);
  }
  return p;
}

/** The parsed waveform of each source whose waveform address is known. */
function useWaveforms(urls: Readonly<Record<SourceId, string | null>>): Readonly<Record<SourceId, Waveform>> {
  const [loaded, setLoaded] = useState<Readonly<Record<SourceId, Waveform>>>({});
  useEffect(() => {
    let live = true;
    const entries = Object.entries(urls).filter((e): e is [SourceId, string] => typeof e[1] === "string");
    void Promise.all(entries.map(async ([id, url]) => [id, await loadWaveform(url)] as const)).then((pairs) => {
      if (!live) return;
      const next: Record<SourceId, Waveform> = {};
      for (const [id, w] of pairs) if (w) next[id] = w;
      setLoaded((prev) => (sameWaveforms(prev, next) ? prev : next));
    });
    return () => {
      live = false;
    };
  }, [urls]);
  return loaded;
}

function sameWaveforms(a: Readonly<Record<SourceId, Waveform>>, b: Readonly<Record<SourceId, Waveform>>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/** Mean loudness over a stretch of a source, from its waveform; shaped so quiet speech still shows. */
export function loudnessFrom(waveforms: Readonly<Record<SourceId, Waveform>>): Loudness {
  return (sourceId, from, to) => {
    const w = waveforms[sourceId];
    if (!w || w.values.length === 0) return null;
    const vps = w.header.valuesPerSecond;
    const i0 = Math.max(0, Math.floor((from / 1_000_000) * vps));
    const i1 = Math.min(w.values.length, Math.max(i0 + 1, Math.ceil((to / 1_000_000) * vps)));
    if (i0 >= w.values.length) return null;
    let sum = 0;
    for (let i = i0; i < i1; i++) sum += w.values[i]!;
    return Math.sqrt(sum / (i1 - i0) / 255);
  };
}

/* ---- model from the store ----------------------------------------------------------------- */

/** How far each source's transcript reaches (its whole length once complete). */
function overviewSources(refs: readonly SourceRef[], state: RoughcutState["sources"], frameRate: Rational): OverviewSource[] {
  return refs.map((ref) => {
    const end = firstClipEnd(ref.media.duration, frameRate) ?? 0;
    const entry = state[ref.id];
    const complete = entry?.transcript?.complete === true || entry?.assets?.transcript === "complete";
    if (complete) return { id: ref.id, end, transcribedTo: Number.POSITIVE_INFINITY };
    let transcribedTo = 0;
    for (const u of entry?.transcript?.utterances ?? []) transcribedTo = Math.max(transcribedTo, u.end);
    return { id: ref.id, end, transcribedTo };
  });
}

/** The overview model for the open project. */
function useOverviewModel(): OverviewModel {
  const clips = useRoughcut(selectClips);
  const refs = useRoughcut((s) => s.project?.sources ?? NO_SOURCES);
  const frameRate = useRoughcut((s) => s.project?.frameRate ?? null);
  const sources = useRoughcut((s) => s.sources);
  const pending = useRoughcut(selectPendingSuggestions);
  return useMemo(
    () =>
      buildOverview({
        clips,
        sources: frameRate ? overviewSources(refs, sources, frameRate) : [],
        suggestions: pending.map((v) => v.suggestion.range),
      }),
    [clips, refs, frameRate, sources, pending],
  );
}

function readColors(el: Element | null): OverviewColors {
  if (!el || typeof getComputedStyle !== "function") return FALLBACK_COLORS;
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return { ink: v("--o-ink", FALLBACK_COLORS.ink), accent: v("--accent", FALLBACK_COLORS.accent), pending: v("--wave-pending", FALLBACK_COLORS.pending) };
}

/* ---- component ---------------------------------------------------------------------------- */

/** The playhead line; its own component so only it re-renders on every frame. */
function StripPlayhead({ model, width }: { model: OverviewModel; width: number }) {
  const time = useRoughcut((s) => s.playhead.time);
  if (model.length <= 0 || width <= 0) return null;
  const x = fractionOfTime(model, time) * width;
  return <i className="rc-strip__ph" style={{ left: `${x}px` }} aria-hidden="true" data-testid="strip-playhead" />;
}

/** The overview strip. Reads the store; a click or drag dispatches `ui.seek`. */
export function OverviewStrip() {
  const model = useOverviewModel();
  const urls = useRoughcut(selectWaveformUrls);
  const waveforms = useWaveforms(urls);
  const dispatch = useDispatch();
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);
  const [width, setWidth] = useState(0);

  // Follow the strip's width.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => setWidth(Math.floor(el.clientWidth));
    measure();
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const count = Math.floor(width / BAR_PITCH);
  const barsWidth = count * BAR_PITCH;

  // Draw the bars whenever the material, the waveforms or the size change.
  useEffect(() => {
    const c = canvas.current;
    if (!c || width <= 0) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(STRIP_HEIGHT * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawOverview(ctx, overviewBars(model, count, loudnessFrom(waveforms)), width, STRIP_HEIGHT, readColors(c));
  }, [model, waveforms, width, count]);

  const seekAt = (clientX: number) => {
    const el = host.current;
    if (!el || model.length <= 0) return;
    const rect = el.getBoundingClientRect();
    const span = barsWidth > 0 ? barsWidth : rect.width;
    if (span <= 0) return;
    void dispatch("ui.seek", { time: timeAtFraction(model, (clientX - rect.left) / span) });
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    seekAt(e.clientX);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging.current) seekAt(e.clientX);
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div className="rc-oled rc-strip" data-testid="overview-strip">
      <div
        ref={host}
        className="rc-strip__in"
        aria-label={`Sequence overview, ${formatTimecode(model.sequenceLength)} kept. Click to move the playhead.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <canvas ref={canvas} className="rc-strip__canvas" style={{ width: `${width}px`, height: `${STRIP_HEIGHT}px` }} />
        <StripPlayhead model={model} width={barsWidth} />
      </div>
    </div>
  );
}
