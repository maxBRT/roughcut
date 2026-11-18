// Measurement harness for the player spike. Not part of the technique: it watches the player.
//   * readMarker(video)   decodes the 13-bit frame number drawn in every test frame
//   * Sampler             on every animation frame, records which frame the TOP element shows
//   * AudioTap            RMS of the continuous tone, per 128-sample quantum
//   * runSequence / runSteps / runShuttle / runSeekFile  the scenarios; each returns raw data
// Raw data is POSTed to the server (results/<name>.json) and summarised by analyze.py.

export const FPS = 30;

// 25 clips, 24 cuts: forward and backward jumps, normal clips and clips of 3..15 frames.
export const TEST_CLIPS = [
  [1800, 1860], [1950, 1995], [1500, 1530], [2100, 2115], [2130, 2136],
  [2200, 2290], [1200, 1210], [1230, 1234], [1300, 1360], [2400, 2424],
  [900, 912], [960, 1020], [2600, 2608], [2620, 2680], [600, 645],
  [700, 705], [3000, 3090], [300, 330], [3300, 3315], [3400, 3460],
  [100, 120], [150, 153], [3500, 3560], [2800, 2830], [1600, 1660],
];

const BITS = 13;
const cv = document.createElement('canvas');
cv.width = BITS * 10; cv.height = 20;
const cx = cv.getContext('2d', { willReadFrequently: true });

/** Frame number shown by `video`, or -1 if the marker is not readable (blend, blank, not decoded). */
export function readMarker(video) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w) return -1;   // during a seek readyState drops, but the element still shows (and draws) the old frame
  cx.drawImage(video, 0, 0, w * BITS * 120 / 3840, h * 240 / 2160, 0, 0, cv.width, cv.height);
  const d = cx.getImageData(0, 0, cv.width, cv.height).data;
  let v = 0;
  for (let k = 0; k < BITS; k++) {
    const a = d[(5 * cv.width + k * 10 + 5) * 4], b = d[(15 * cv.width + k * 10 + 5) * 4];
    if (Math.abs(a - b) < 100) return -1;
    v = v * 2 + (a > b ? 1 : 0);
  }
  return v;
}

export class Sampler {
  constructor(player) { this.player = player; this.log = []; this.on = false; }
  start() {
    this.on = true; this.log = [];
    // Registered after the player's own rAF loop, so it sees the state that will be composited.
    const f = (t) => {
      if (!this.on) return;
      const v = this.player.visible;
      this.log.push([+t.toFixed(2), this.player.cur, readMarker(v)]);
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  }
  stop() { this.on = false; return this.log; }
}

export class AudioTap {
  static async create(player) {
    const ctx = player.ctx;
    await ctx.audioWorklet.addModule('audio-tap.js');
    const t = new AudioTap();
    t.node = new AudioWorkletNode(ctx, 'tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    const sink = ctx.createGain(); sink.gain.value = 0;
    // Automated runs are silent: the master bus feeds the tap and a zero-gain sink, not the speakers.
    // The graph still renders in real time because the sink is connected to the destination.
    player.master.disconnect();
    player.master.connect(t.node); t.node.connect(sink); sink.connect(ctx.destination);
    t.batches = [];
    t.node.port.onmessage = (e) => t.batches.push({ frame0: e.data.frame0, rms: Array.from(e.data.rms, x => +x.toFixed(4)) });
    t.sampleRate = ctx.sampleRate;
    return t;
  }
  start() { this.batches = []; this.node.port.postMessage('start'); }
  async stop() { this.node.port.postMessage('stop'); await sleep(100); return { sampleRate: this.sampleRate, batches: this.batches }; }
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nextFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

export async function post(name, data) {
  await fetch('/results/' + name, { method: 'POST', body: JSON.stringify(data) });
}

function env() {
  return { ua: navigator.userAgent, dpr: devicePixelRatio, screen: [screen.width, screen.height] };
}

// ---- Scenario: play the whole test sequence at `rate` and record what is shown and heard.
export async function runSequence(player, tap, src, rate, extra = {}) {
  const clips = TEST_CLIPS.map(([start, end]) => ({ src, start, end }));
  const events = [];
  player.onEvent = (name, d) => events.push({ name, t: performance.now(), ...d, ts: d.ts ? { c: d.ts.contextTime, p: d.ts.performanceTime } : undefined });
  Object.assign(player, extra);
  player.setRate(rate);
  await player.load(clips);
  await player.seek(0);
  await sleep(500);
  const sampler = new Sampler(player);
  tap.start();
  sampler.start();
  const t0 = performance.now();
  const ended = new Promise(r => { const prev = player.onEvent; player.onEvent = (n, d) => { prev(n, d); if (n === 'end') r(); }; });
  await player.play();
  await Promise.race([ended, sleep(120000)]);
  await sleep(300);
  const samples = sampler.stop();
  const audio = await tap.stop();
  return { kind: 'sequence', src, rate, swapLead: player.swapLead, rampMs: player.rampMs, fps: FPS, clips: TEST_CLIPS,
           t0, vsync: player.vsync, audioState: player.ctx.state, outputLatency: player.ctx.outputLatency,
           samples, events, audio, env: env() };
}

// ---- Scenario: frame stepping across cuts, forwards then backwards.
export async function runSteps(player, src) {
  const clips = TEST_CLIPS.map(([start, end]) => ({ src, start, end }));
  await player.load(clips);
  const out = [];
  for (const cutClip of [3, 7, 15]) {            // around three cuts, two of them into tiny clips
    await player.seek(player.seqStart[cutClip] - 6);
    await nextFrame();
    for (const dir of [1, -1]) {
      for (let i = 0; i < 12; i++) {
        const t0 = performance.now();
        await player.step(dir);
        const ms = performance.now() - t0;
        await nextFrame();
        const want = player.locate(player.seqFrame).srcFrame;
        out.push({ dir, seqFrame: player.seqFrame, want, got: readMarker(player.visible), ms: +ms.toFixed(1) });
      }
    }
  }
  return { kind: 'steps', src, steps: out, env: env() };
}

// ---- Scenario: silent backwards play (J) for a few seconds.
export async function runShuttle(player, src, rate = 1, seconds = 4) {
  const clips = TEST_CLIPS.map(([start, end]) => ({ src, start, end }));
  await player.load(clips);
  await player.seek(player.duration - 1);
  await nextFrame();
  const sampler = new Sampler(player);
  sampler.start();
  const p = player.shuttleBack(rate);
  await sleep(seconds * 1000);
  player.stopShuttle();
  const res = await p;
  const samples = sampler.stop();
  return { kind: 'shuttle', src, rate, seconds, clips: TEST_CLIPS, result: res, samples, env: env() };
}

// ---- Scenario: one file in one element: can it play, how fast do seeks land, does playback keep up.
export async function runSeekFile(stage, file, nSeeks = 20) {
  const types = {
    h264_8bit: 'video/mp4; codecs="avc1.640033"', h264_10bit: 'video/mp4; codecs="avc1.6E0033"',
    hevc_8bit: 'video/mp4; codecs="hvc1.1.6.L153.B0"', hevc_10bit: 'video/mp4; codecs="hvc1.2.4.L153.B0"',
  };
  const key = Object.keys(types).find(k => file.includes(k));
  const el = document.createElement('video');
  el.muted = true; el.preload = 'auto'; el.playsInline = true;
  el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:5;background:#000';
  stage.appendChild(el);
  const r = { kind: 'seekfile', file, canPlayType: el.canPlayType(types[key]),
              mediaCapabilities: null, env: env() };
  try {
    const mc = await navigator.mediaCapabilities.decodingInfo({ type: 'file', video: {
      contentType: types[key], width: 3840, height: 2160, bitrate: 50e6, framerate: 30 } });
    r.mediaCapabilities = { supported: mc.supported, smooth: mc.smooth, powerEfficient: mc.powerEfficient };
  } catch (e) { r.mediaCapabilities = String(e); }
  const t0 = performance.now();
  el.src = '/media/' + file;
  const ok = await Promise.race([
    new Promise(res => el.addEventListener('loadeddata', () => res(true), { once: true })),
    new Promise(res => el.addEventListener('error', () => res(false), { once: true })),
    sleep(15000).then(() => false)]);
  r.loadeddataMs = +(performance.now() - t0).toFixed(1);
  if (!ok) { r.error = el.error ? `${el.error.code} ${el.error.message}` : 'timeout'; el.remove(); return r; }
  r.videoSize = [el.videoWidth, el.videoHeight];
  const dur = el.duration;
  // Random seeks (seeded), timed to 'seeked' and to the frame callback of the new frame.
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  r.seeks = [];
  for (let i = 0; i < nSeeks; i++) {
    const f = Math.floor(rnd() * (dur * FPS - 2));
    const s0 = performance.now();
    let seekedMs = null;
    el.addEventListener('seeked', () => { seekedMs = performance.now() - s0; }, { once: true });
    const shown = new Promise(res => el.requestVideoFrameCallback((now, md) => res({ now, mediaFrame: Math.round(md.mediaTime * FPS) })));
    el.currentTime = (f + 0.5) / FPS;
    const v = await Promise.race([shown, sleep(5000).then(() => null)]);
    await nextFrame();
    r.seeks.push({ frame: f, seekedMs: seekedMs && +seekedMs.toFixed(1), frameMs: v && +(v.now - s0).toFixed(1),
                   mediaFrame: v && v.mediaFrame, marker: readMarker(el) });
  }
  // Scrub: a new seek target every animation frame for 2 s, moving 10 s of source per second.
  {
    let presented = 0; const seen = new Set();
    const count = (now, md) => { presented++; seen.add(Math.round(md.mediaTime * FPS)); if (scrubbing) el.requestVideoFrameCallback(count); };
    let scrubbing = true; el.requestVideoFrameCallback(count);
    const s0 = performance.now(), start = 20;
    while (performance.now() - s0 < 2000) {
      el.currentTime = start + (performance.now() - s0) / 1000 * 10;
      await new Promise(res => requestAnimationFrame(res));
    }
    scrubbing = false;
    r.scrub = { seconds: 2, framesPresented: presented, distinctFrames: seen.size };
  }
  // Throttled scrub: same drag, but a new seek is issued only after the previous one landed
  // ('seeked'), always to the latest drag position. This is how the app should scrub.
  {
    const s0 = performance.now(), start = 40;
    let landed = 0;
    while (performance.now() - s0 < 2000) {
      el.currentTime = start + (performance.now() - s0) / 1000 * 10;
      await new Promise(res => el.addEventListener('seeked', res, { once: true }));
      landed++;
    }
    r.scrubThrottled = { seconds: 2, seeksLanded: landed };
  }
  // Playback: 4 s at 1x from 30 s, frame callbacks counted, dropped frames from the element.
  {
    el.currentTime = 30 + 0.5 / FPS;
    await new Promise(res => el.addEventListener('seeked', res, { once: true }));
    const q0 = el.getVideoPlaybackQuality();
    const frames = [];
    let on = true;
    const cb = (now, md) => { frames.push(Math.round(md.mediaTime * FPS)); if (on) el.requestVideoFrameCallback(cb); };
    el.requestVideoFrameCallback(cb);
    const p0 = performance.now();
    await el.play();
    const startMs = performance.now() - p0;
    await sleep(4000);
    on = false; el.pause();
    const q1 = el.getVideoPlaybackQuality();
    let skipped = 0;
    for (let i = 1; i < frames.length; i++) if (frames[i] - frames[i - 1] > 1) skipped += frames[i] - frames[i - 1] - 1;
    r.play = { playStartMs: +startMs.toFixed(1), callbacks: frames.length, framesSkippedInCallbacks: skipped,
               droppedFrames: q1.droppedVideoFrames - q0.droppedVideoFrames, totalFrames: q1.totalVideoFrames - q0.totalVideoFrames };
  }
  el.remove();
  return r;
}
