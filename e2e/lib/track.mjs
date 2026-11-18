// Reading the Timeline view as drawn: the track canvas's pixels (clips, gaps, the outlined
// clip, waveform bars, the playhead), the caption and the cut counter, and the picture the
// player shows (its burned-in frame number). Compared with the store's clip list by the
// callers, so a drawing that disagrees with the edit fails.

import { check, fail } from "./app.mjs";
import { stripOfImage } from "./frames.mjs";

/** Geometry of the canvas (src/views/timeline/geometry.ts, draw.ts). */
const RULER_H = 22;
const TRACK_TOP = RULER_H + 8;
const TRACK_H = 92;
const TRACK_BOTTOM = TRACK_TOP + TRACK_H;
const HEADER_H = 24;
const WAVE_TOP = TRACK_TOP + HEADER_H + 4;
const WAVE_H = TRACK_BOTTOM - 8 - WAVE_TOP;

/**
 * Runs in the page: the track as drawn. Returns {width, dpr, playheadX, clips:[{x0,x1,outlined,
 * bars:[[x,h]...]}], counter, caption:{text,bold}, zoomText}. Positions are CSS pixels.
 */
function readTrackInPage(g) {
  const canvas = document.querySelector('canvas[data-part="track"]');
  if (!canvas) return null;
  const cssW = parseFloat(canvas.style.width) || canvas.clientWidth;
  const dpr = canvas.width / cssW;
  // A copy, so reading never changes how the app's own canvas is backed.
  const copy = document.createElement("canvas");
  copy.width = canvas.width;
  copy.height = canvas.height;
  const ctx = copy.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = (x, y) => {
    const i = (Math.round(y) * img.width + Math.round(x)) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
  };
  const probe = document.createElement("canvas").getContext("2d");
  const rgb = (css) => {
    probe.fillStyle = "#000";
    probe.fillStyle = css;
    const h = probe.fillStyle;
    return h.startsWith("#") ? [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16)) : h.match(/\d+/g).slice(0, 3).map(Number);
  };
  const cs = getComputedStyle(canvas);
  const accent = rgb(cs.getPropertyValue("--accent").trim() || "#FF4D00");
  const near = (p, c, tol = 40) => p[3] > 200 && Math.abs(p[0] - c[0]) + Math.abs(p[1] - c[1]) + Math.abs(p[2] - c[2]) < tol;
  const lum = (p) => (p[0] * 0.3 + p[1] * 0.59 + p[2] * 0.11) * (p[3] / 255);

  // The playhead: accent pixels in the strip between the ruler and the track.
  const yHead = (g.RULER_H + 4) * dpr;
  const head = [];
  for (let x = 0; x < img.width; x++) if (near(px(x, yHead), accent)) head.push(x);
  const playheadX = head.length ? (head[0] + head[head.length - 1] + 1) / 2 / dpr : null;

  // Clips: opaque runs on a row inside the clip boxes (below the corner rounding), the playhead
  // column excepted (it is drawn over gaps too).
  const yClip = (g.TRACK_TOP + 10) * dpr;
  const opaque = (x) => {
    const p = px(x, yClip);
    if (p[3] < 128) return false;
    if (near(p, accent) && head.includes(x)) {
      // Under the playhead: a clip if the pixel two rows into the clip's header area is not
      // the gap (look at the neighbours, which are clip or gap).
      const l = x > 0 ? px(x - 1, yClip)[3] : 0;
      const r = x < img.width - 1 ? px(x + 1, yClip)[3] : 0;
      return l >= 128 && r >= 128;
    }
    return true;
  };
  const runs = [];
  let start = -1;
  for (let x = 0; x <= img.width; x++) {
    const o = x < img.width && opaque(x);
    if (o && start < 0) start = x;
    if (!o && start >= 0) {
      runs.push([start, x]);
      start = -1;
    }
  }
  const yMid = (g.TRACK_TOP + g.TRACK_H / 2) * dpr;
  const clips = runs.map(([a, b]) => {
    // The clip under the playhead has a 1 px light border inside its box: its top row is light
    // along the clip (other clips' top row is the clip colour).
    let light = 0;
    let seen = 0;
    for (let x = a + 6 * dpr; x < b - 6 * dpr; x += Math.max(1, Math.floor((b - a) / 40))) {
      if (head.includes(x)) continue;
      seen++;
      if (lum(px(x, g.TRACK_TOP * dpr)) > 150) light++;
    }
    const outlined = seen > 0 && light / seen > 0.8;
    // Waveform bars: light columns in the wave band.
    const bars = [];
    for (let x = a + 3 * dpr; x < b - 3 * dpr; x++) {
      if (head.includes(x)) continue;
      let h = 0;
      for (let y = g.WAVE_TOP * dpr; y < (g.WAVE_TOP + g.WAVE_H) * dpr; y++) if (lum(px(x, y)) > 150) h++;
      if (h > 0) bars.push([x / dpr, h / dpr]);
    }
    return { x0: a / dpr, x1: b / dpr, outlined, bars };
  });
  const status = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
  const cap = document.querySelector('[data-part="caption"]');
  return {
    width: cssW,
    dpr,
    playheadX,
    clips,
    counter: status('[data-part="cut-counter"]'),
    zoomText: status(".tlv-zoom"),
    caption: { text: cap?.textContent?.trim() ?? null, bold: cap?.querySelector("b")?.textContent ?? null },
  };
}

export function readTrack(app) {
  return app.eval(readTrackInPage, { RULER_H, TRACK_TOP, TRACK_H, WAVE_TOP, WAVE_H });
}

/** Store facts the drawing is checked against. */
export function timelineState(app) {
  return app.state((s) => {
    const clips = s.edit.current.clips.map((c) => ({ id: c.id, sourceId: c.sourceId, start: c.start, end: c.end }));
    const starts = [0];
    for (const c of clips) starts.push(starts[starts.length - 1] + (c.end - c.start));
    return {
      clips,
      starts,
      duration: starts[starts.length - 1],
      playhead: s.playhead.time,
      position: s.playhead.position,
      zoom: s.zoom,
      view: s.session.view,
      selection: { ...s.selection },
    };
  });
}

/** Index of the clip under sequence time t (the one starting there at a boundary). */
export function clipIndexAt(st, t) {
  for (let i = 0; i < st.clips.length; i++) if (t < st.starts[i + 1] - 1) return i;
  return st.clips.length - 1;
}

/** Source frame shown at sequence time t (CFR source at `fps`). */
export function sourceFrameAt(st, t, fps = 30) {
  const i = clipIndexAt(st, t);
  const c = st.clips[i];
  const src = c.start + Math.max(0, t - st.starts[i]);
  return { index: i, sourceId: c.sourceId, frame: Math.floor((src * fps) / 1e6 + 1e-3) };
}

/**
 * Checks the drawing against the store at fit zoom (or, when zoomed, the relative clip widths
 * and that the playhead is on screen): clip count and edges within 1.5 px, exactly one outlined
 * clip and it is the one under the playhead, waveform bars in every clip wide enough, the
 * playhead line at its time, and the cut counter.
 */
export function checkDrawing(tr, st, what, { waveform = true } = {}) {
  check(tr, `${what}: the timeline canvas is not on screen`);
  const fit = st.zoom <= 1;
  const scale = (tr.width * Math.max(1, st.zoom)) / st.duration;
  if (fit) {
    // Clips narrower than a few pixels may merge with their gap; the fixtures here keep clips wide.
    check(tr.clips.length === st.clips.length, `${what}: ${tr.clips.length} clips drawn, the edit has ${st.clips.length}`, { drawn: tr.clips.map((c) => [c.x0, c.x1]), clips: st.clips });
    st.clips.forEach((c, i) => {
      const x0 = st.starts[i] * scale;
      const x1 = st.starts[i + 1] * scale;
      const d = tr.clips[i];
      check(Math.abs(d.x0 - x0) <= 1.5, `${what}: clip ${i + 1} starts at ${d.x0} px, expected ${x0.toFixed(1)}`, { drawn: d, clip: c });
      // The drawn box ends 2 px before the next clip (the gap); the last ends at the width.
      check(Math.abs(d.x1 - (x1 - (i < st.clips.length - 1 ? 2 : 2))) <= 1.5 || Math.abs(d.x1 - x1) <= 1.5, `${what}: clip ${i + 1} ends at ${d.x1} px, expected about ${x1.toFixed(1)}`, { drawn: d, clip: c });
    });
  } else {
    // Zoomed: every clip fully on screen is `zoom` times its fit width.
    const full = tr.clips.filter((d) => d.x0 > 1 && d.x1 < tr.width - 1);
    for (const d of full) {
      const w = d.x1 - d.x0 + 2;
      const match = st.clips.some((c) => Math.abs((c.end - c.start) * scale - w) <= 2);
      check(match, `${what}: a clip ${w.toFixed(1)} px wide is drawn, which matches no clip at zoom ${st.zoom}`, { drawn: tr.clips, clips: st.clips, scale });
    }
  }
  const under = clipIndexAt(st, st.playhead);
  const outlined = tr.clips.map((d, i) => (d.outlined ? i : -1)).filter((i) => i >= 0);
  if (fit) check(outlined.length === 1 && outlined[0] === under, `${what}: the outlined clip is ${JSON.stringify(outlined)}, the playhead is in clip ${under}`, tr.clips.map((c) => [c.x0, c.x1, c.outlined]));
  else check(outlined.length === 1, `${what}: ${outlined.length} clips are outlined`, tr.clips.map((c) => [c.x0, c.x1, c.outlined]));
  check(tr.playheadX !== null, `${what}: no playhead is drawn`);
  if (fit) check(Math.abs(tr.playheadX - st.playhead * scale) <= 1.5, `${what}: the playhead is drawn at ${tr.playheadX} px, expected ${(st.playhead * scale).toFixed(1)}`);
  else check(tr.playheadX >= 0 && tr.playheadX <= tr.width, `${what}: the playhead is off screen when zoomed (${tr.playheadX})`);
  if (waveform) {
    for (const [i, d] of tr.clips.entries()) {
      if (d.x1 - d.x0 < 20) continue;
      check(d.bars.length > 0, `${what}: clip ${i + 1} is drawn without its waveform`);
    }
  }
  const cuts = st.clips.length - 1;
  const passed = st.starts.slice(1, -1).filter((s) => s <= st.playhead + 1000).length;
  const want = cuts === 0 ? "no cuts" : passed === 0 ? `${cuts} ${cuts === 1 ? "cut" : "cuts"}` : `cut ${passed} of ${cuts}`;
  check(tr.counter === want, `${what}: the cut counter says "${tr.counter}", expected "${want}"`);
}

/** The frame number the player shows (read from its picture), with the reader's confidence. */
export async function pictureFrame(app, reader) {
  const png = await app.playerPicture();
  const r = reader.read(stripOfImage(png));
  return r;
}

/** Fails unless the player shows source frame `want` (read from the picture). */
export async function expectPicture(app, reader, want, what) {
  // The frame may still be on its way after a seek: give it a moment.
  let got;
  for (let i = 0; i < 20; i++) {
    got = await pictureFrame(app, reader);
    if (got.value === want) return got;
    await new Promise((r) => setTimeout(r, 100));
  }
  fail(`${what}: the player shows frame ${got.value ?? `unreadable (${got.guess})`}, expected ${want}`, got);
}
