/**
 * The Timeline view (spec 1.7 D, drawn as mockups/roughcut-mockups.html "timeline"): the caption
 * of words around the playhead and the single track drawn on a canvas (clips end to end with name
 * and waveform, the clip under the playhead outlined, the ruler and the playhead; zoom and
 * scrolling that keeps the playhead in view). The editor screen hosts the player; its timeline
 * layout places the caption between the player and the transport, as the mockup does.
 * The cut counter ("cut 2 of 14") and the clip info line of the spec's earlier text diagram are
 * not in the mockup, which wins (spec 1.7): they are kept for screen readers only.
 * Reads the store and dispatches actions only (spec 3.6 rule 1); the mouse is handled in
 * ./controller.
 */
import { useEffect, useMemo, useRef } from "react";
import {
  fileNameOf,
  selectCaption,
  selectClips,
  selectCurrentClip,
  selectCutCounter,
  selectWaveformUrls,
  useDispatch,
  useRoughcut,
  useRoughcutShallow,
  useRoughcutStore,
  type RoughcutState,
} from "../../state";
import { TimelineController } from "./controller";
import { formatTime } from "./geometry";
import { fetchWaveformBytes, useWaveformPeaks, type WaveformFetcher } from "./waveforms";
import "./timeline.css";

export { formatTime } from "./geometry";
export type { WaveformFetcher } from "./waveforms";

/** Optional: how waveform bytes are fetched (default: `fetch` of the address as given). */
export interface TimelineViewProps {
  fetchWaveform?: WaveformFetcher;
}

/** The sequence as one track of clips, with its caption and info line. */
export function TimelineView({ fetchWaveform = fetchWaveformBytes }: TimelineViewProps = {}) {
  return (
    <section className="tlv" data-view="timeline" aria-label="Timeline">
      <Caption />
      <div className="rc-oled tlv-panel">
        <TimelineTrack fetchWaveform={fetchWaveform} />
      </div>
      <div className="tlv-status">
        <CutCounter />
        <ClipInfo />
      </div>
    </section>
  );
}

const NO_CAPTION = ["", null, ""] as const;

/** "...notice is the new **signup** form, which is down to two fields". */
function Caption() {
  const [before, current, after] = useRoughcutShallow((s) => {
    const c = selectCaption(s);
    return c ? ([c.before, c.current, c.after] as const) : NO_CAPTION;
  });
  return (
    <p className="tlv-caption" data-part="caption">
      {before}
      {before && current !== null ? " " : ""}
      {current !== null ? <b>{current}</b> : null}
      {(before || current !== null) && after ? " " : ""}
      {after}
    </p>
  );
}

/** "cut 2 of 14": cut points at or before the playhead, of all of them. */
function CutCounter() {
  const { index, count } = useRoughcutShallow(selectCutCounter);
  const text = count === 0 ? "no cuts" : index === 0 ? `${count} ${count === 1 ? "cut" : "cuts"}` : `cut ${index} of ${count}`;
  return (
    <span className="tlv-meta" data-part="cut-counter">
      {text}
    </span>
  );
}

/** The fields of the info line, as primitives so a shallow compare skips unchanged frames. */
function clipInfo(s: RoughcutState) {
  const placed = selectCurrentClip(s);
  const count = selectClips(s).length;
  if (!placed) return { index: -1, count, name: "", start: 0, end: 0 };
  const ref = s.project?.sources.find((r) => r.id === placed.clip.sourceId);
  return { index: placed.index, count, name: ref ? fileNameOf(ref.path) : "", start: placed.clip.start, end: placed.clip.end };
}

/** "Clip 2 of 4   from take-1.mp4 0:24.1 to 3:02.7   length 2:38.6   zoom: fit". */
function ClipInfo() {
  const info = useRoughcutShallow(clipInfo);
  const zoom = useRoughcut((s) => s.zoom);
  const zoomText = zoom <= 1 ? "fit" : `${Number.isInteger(zoom) ? zoom : zoom.toFixed(1)}×`;
  return (
    <div className="tlv-info" data-part="clip-info">
      {info.index < 0 ? (
        <span>{info.count === 0 ? "No clips: everything is cut" : ""}</span>
      ) : (
        <>
          <span>
            Clip <b>{info.index + 1}</b> of {info.count}
          </span>
          <span>
            from {info.name} <b>{formatTime(info.start)}</b> to <b>{formatTime(info.end)}</b>
          </span>
          <span>
            length <b>{formatTime(info.end - info.start)}</b>
          </span>
        </>
      )}
      <span className="tlv-zoom">zoom: {zoomText}</span>
    </div>
  );
}

/** The canvas: drawn from the store by a `TimelineController`, which also handles the mouse. */
function TimelineTrack({ fetchWaveform }: { fetchWaveform: WaveformFetcher }) {
  const store = useRoughcutStore();
  const dispatch = useDispatch();
  const urls = useRoughcut(selectWaveformUrls);
  const peaks = useWaveformPeaks(urls, fetchWaveform);
  const clipCount = useRoughcut((s) => selectClips(s).length);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controller = useMemo(() => new TimelineController(store, dispatch), [store, dispatch]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    return controller.attach(canvas, wrap);
  }, [controller]);

  useEffect(() => controller.setPeaks(peaks), [controller, peaks]);

  return (
    <div className="tlv-track" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Timeline track, ${clipCount} ${clipCount === 1 ? "clip" : "clips"}`}
        data-part="track"
      />
    </div>
  );
}
