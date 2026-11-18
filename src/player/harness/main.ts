/**
 * Instrumented run of THIS module's `Player` in a real browser (spec 3.7, player row). Built by
 * `run.mjs` and opened in Microsoft Edge. Measures, with the experiment's method
 * (spikes/player/RESULT.md): which frame the top video element shows on every animation
 * frame (a 13-bit marker drawn in every test frame), and the level of a continuous tone.
 *
 * Scenarios, each posted to the page server as JSON:
 * - `seq_<set>_r<rate>`: play a 25-clip sequence through at 1x, 1.5x, 2x; `<set>` is `one`
 *   (one source) or `mix` (two sources, so the waiting element changes address at cuts);
 * - `switch_play`: the original replaced by the proxy (and back) while playing;
 * - `switch_paused`: the same while paused, position kept;
 * - `steps`: frame steps across cuts, both ways.
 */
import { Player } from "../Player";
import { browserEnvironment, WebAudioOut } from "../env";
import type { PlayerEvent, PlayerSource } from "../types";
import type { Clip, Rational, SourceId } from "../../types";
import { frameToMicros } from "../../types";

const q = new URLSearchParams(location.search);
const MEDIA = q.get("media") ?? "http://127.0.0.1:8772";
const TOKEN = q.get("token") ?? "harness";
const FPS = 30;
const R: Rational = { num: FPS, den: 1 };
const us = (f: number) => frameToMicros(f, R);
const mediaUrl = (src: SourceId, item: "proxy" | "original") => `${MEDIA}/media/${src}/${item}?token=${TOKEN}`;
/** Source B is source A from 60 s on: B's frame f carries marker f + 1800. */
const MARKER_OFFSET: Record<string, number> = { A: 0, B: 1800 };

// The experiment's 25 clips (24 cuts), in frames of source A.
const TEST_CLIPS: [number, number][] = [
  [1800, 1860], [1950, 1995], [1500, 1530], [2100, 2115], [2130, 2136],
  [2200, 2290], [1200, 1210], [1230, 1234], [1300, 1360], [2400, 2424],
  [900, 912], [960, 1020], [2600, 2608], [2620, 2680], [600, 645],
  [700, 705], [3000, 3090], [300, 330], [3300, 3315], [3400, 3460],
  [100, 120], [150, 153], [3500, 3560], [2800, 2830], [1600, 1660],
];

interface ClipSpec { src: SourceId; f0: number; f1: number }

function oneSource(): ClipSpec[] {
  return TEST_CLIPS.map(([f0, f1]) => ({ src: "A", f0, f1 }));
}
/** Every clip past 60 s comes from source B instead (same pictures, other file). */
function mixed(): ClipSpec[] {
  return TEST_CLIPS.map(([f0, f1]) => (f0 >= 1800 ? { src: "B", f0: f0 - 1800, f1: f1 - 1800 } : { src: "A", f0, f1 }));
}
function toClips(specs: ClipSpec[]): Clip[] {
  return specs.map((s, i) => ({ id: `c${i}`, sourceId: s.src, start: us(s.f0), end: us(s.f1) }));
}
function expectedMarkers(specs: ClipSpec[]): { expected: number[]; cum: number[] } {
  const expected: number[] = [];
  const cum: number[] = [];
  for (const s of specs) {
    cum.push(expected.length);
    for (let f = s.f0; f < s.f1; f++) expected.push(f + MARKER_OFFSET[s.src]!);
  }
  return { expected, cum };
}

/** Sequence time of sequence frame `k` (clip lengths summed in microseconds, as `edit` does). */
function seqTimeOfFrame(clips: Clip[], cum: number[], k: number): number {
  let i = 0;
  while (i + 1 < cum.length && cum[i + 1]! <= k) i++;
  let t = 0;
  for (let j = 0; j < i; j++) t += clips[j]!.end - clips[j]!.start;
  const f0 = Math.round((clips[i]!.start * FPS) / 1e6);
  return t + (us(f0 + (k - cum[i]!)) - clips[i]!.start);
}

// ---- measurement helpers (from the experiment's harness.js)

const BITS = 13;
const cv = document.createElement("canvas");
cv.width = BITS * 10;
cv.height = 20;
const cx = cv.getContext("2d", { willReadFrequently: true })!;

/** Frame number drawn in the frame `video` shows, or -1 if unreadable. */
function readMarker(video: HTMLVideoElement): number {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w) return -1;
  cx.drawImage(video, 0, 0, (w * BITS * 120) / 3840, (h * 240) / 2160, 0, 0, cv.width, cv.height);
  const d = cx.getImageData(0, 0, cv.width, cv.height).data;
  let v = 0;
  for (let k = 0; k < BITS; k++) {
    const a = d[(5 * cv.width + k * 10 + 5) * 4]!;
    const b = d[(15 * cv.width + k * 10 + 5) * 4]!;
    if (Math.abs(a - b) < 100) return -1;
    v = v * 2 + (a > b ? 1 : 0);
  }
  return v;
}

const stage = document.getElementById("stage")!;
const logEl = document.getElementById("log")!;
const log = (s: string) => {
  logEl.textContent += s + "\n";
  console.log(s);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

function topVideo(): HTMLVideoElement | null {
  for (const v of stage.querySelectorAll("video")) if (v.style.zIndex === "2" && v.style.opacity !== "0") return v;
  return null;
}

/** On every animation frame (after the player's own), what the top element shows. */
class Sampler {
  log: [number, number, number][] = [];
  private on = false;
  start() {
    this.on = true;
    this.log = [];
    const f = (t: number) => {
      if (!this.on) return;
      const v = topVideo();
      const kind = v ? (v.currentSrc.includes("/original") ? 0 : 1) : -1;
      this.log.push([+t.toFixed(2), v ? readMarker(v) : -2, kind]);
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  }
  stop() {
    this.on = false;
    return this.log;
  }
}

/** RMS of the right channel (the 440 Hz tone) per 128-sample quantum, on the master bus. */
class AudioTap {
  private node!: AudioWorkletNode;
  private batches: { frame0: number; rms: number[] }[] = [];
  private stamp: { contextTime: number; performanceTime: number } | null = null;
  constructor(private readonly audio: WebAudioOut) {}
  async init() {
    const ctx = this.audio.context;
    await ctx.audioWorklet.addModule("audio-tap.js");
    this.node = new AudioWorkletNode(ctx, "tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    const sink = ctx.createGain();
    sink.gain.value = 0; // silent: nothing is played out loud during automated runs
    this.audio.output.disconnect();
    this.audio.output.connect(this.node);
    this.node.connect(sink);
    sink.connect(ctx.destination);
    this.node.port.onmessage = (e: MessageEvent<{ frame0: number; rms: Float32Array }>) =>
      this.batches.push({ frame0: e.data.frame0, rms: Array.from(e.data.rms, (x) => +x.toFixed(4)) });
  }
  start() {
    this.batches = [];
    const ts = this.audio.context.getOutputTimestamp();
    this.stamp = { contextTime: ts.contextTime ?? 0, performanceTime: ts.performanceTime ?? 0 };
    this.node.port.postMessage("start");
  }
  async stop() {
    this.node.port.postMessage("stop");
    await sleep(100);
    return { sampleRate: this.audio.context.sampleRate, stamp: this.stamp, batches: this.batches };
  }
}

async function post(name: string, data: unknown) {
  await fetch("/results/" + name, { method: "POST", body: JSON.stringify(data) });
}

function env() {
  return { ua: navigator.userAgent, dpr: devicePixelRatio, screen: [screen.width, screen.height] };
}

// ---- the player under test

const environment = browserEnvironment(stage);
const audio = environment.audio as WebAudioOut;
const player = new Player({ environment });
const events: { t: number; e: PlayerEvent }[] = [];
player.subscribe((e) => {
  if (e.type !== "frame") events.push({ t: performance.now(), e });
});

function sources(kindA: "proxy" | "original"): Record<string, PlayerSource> {
  return {
    A: { url: mediaUrl("A", kindA), duration: 120_000_000 },
    B: { url: mediaUrl("B", "proxy"), duration: 60_000_000 },
  };
}

function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const f = () => {
      if (pred()) resolve(true);
      else if (performance.now() - t0 > ms) resolve(false);
      else requestAnimationFrame(f);
    };
    f();
  });
}

async function runSequence(set: "one" | "mix", rate: 1 | 1.5 | 2, tap: AudioTap) {
  const specs = set === "one" ? oneSource() : mixed();
  const clips = toClips(specs);
  player.load({ clips, sources: sources("proxy"), frameRate: R });
  player.setRate(rate);
  await player.seek(0);
  await sleep(500);
  const sampler = new Sampler();
  events.length = 0;
  tap.start();
  sampler.start();
  const t0 = performance.now();
  await player.play();
  const ended = await waitFor(() => events.some((x) => x.e.type === "ended"), 120_000);
  await sleep(300);
  const samples = sampler.stop();
  const tone = await tap.stop();
  return {
    kind: "sequence", set, rate, fps: FPS, ended, t0, refreshMs: player.refreshMs, ...expectedMarkers(specs),
    clips: specs, samples, events, audio: tone, env: env(),
  };
}

async function runSwitchPlaying() {
  const specs: ClipSpec[] = [{ src: "A", f0: 300, f1: 2700 }];
  const clips = toClips(specs);
  player.setRate(1);
  player.load({ clips, sources: sources("original"), frameRate: R });
  await player.seek(0);
  await sleep(1000);
  const sampler = new Sampler();
  events.length = 0;
  sampler.start();
  await player.play();
  const loads: { t: number; to: string }[] = [];
  for (const to of ["proxy", "original", "proxy", "original", "proxy"] as const) {
    await sleep(2500);
    loads.push({ t: performance.now(), to });
    player.load({ clips, sources: sources(to), frameRate: R });
  }
  await sleep(2500);
  player.pause();
  await sleep(300);
  return { kind: "switch_play", fps: FPS, refreshMs: player.refreshMs, clips: specs, loads, samples: sampler.stop(), events, env: env() };
}

async function runSwitchPaused() {
  const specs: ClipSpec[] = [{ src: "A", f0: 0, f1: 3600 }];
  const clips = toClips(specs);
  const out: { frame: number; before: number; after: number; ms: number; reportedSame: boolean }[] = [];
  for (const frame of [123, 1234, 2345, 3001]) {
    player.load({ clips, sources: sources("original"), frameRate: R });
    await player.seek(us(frame));
    await sleep(400);
    await nextFrame();
    const before = readMarker(topVideo()!);
    const reported = player.frame.position?.at;
    const t0 = performance.now();
    player.load({ clips, sources: sources("proxy"), frameRate: R });
    await waitFor(() => topVideo()?.currentSrc.includes("/proxy") === true, 5000);
    const ms = performance.now() - t0;
    await nextFrame();
    out.push({ frame, before, after: readMarker(topVideo()!), ms: +ms.toFixed(1), reportedSame: player.frame.position?.at === reported });
  }
  return { kind: "switch_paused", results: out, env: env() };
}

async function runSteps() {
  const specs = mixed();
  const clips = toClips(specs);
  const { expected, cum } = expectedMarkers(specs);
  player.load({ clips, sources: sources("proxy"), frameRate: R });
  const out: { dir: number; index: number; want: number; got: number; ms: number }[] = [];
  for (const cutClip of [3, 7, 15, 12]) {
    const start = cum[cutClip]! - 6;
    await player.seek(seqTimeOfFrame(clips, cum, start));
    await nextFrame();
    for (const dir of [1, -1]) {
      for (let i = 0; i < 12; i++) {
        const t0 = performance.now();
        await player.step({ frames: dir });
        const ms = performance.now() - t0;
        await nextFrame();
        const index = Math.round((player.frame.time * FPS) / 1e6);
        out.push({ dir, index, want: expected[index]!, got: readMarker(topVideo()!), ms: +ms.toFixed(1) });
      }
    }
  }
  return { kind: "steps", steps: out, env: env() };
}

// ---- run everything: ?tag=<label>&rates=1,1.5,2&sets=one,mix

const tag = q.get("tag") ?? "manual";
document.title = "running";
try {
  await audio.resume();
  log("audio context: " + audio.context.state);
  const tap = new AudioTap(audio);
  await tap.init();
  const rates = (q.get("rates") ?? "1,1.5,2").split(",").map(Number) as (1 | 1.5 | 2)[];
  for (const set of (q.get("sets") ?? "one,mix").split(",") as ("one" | "mix")[]) {
    for (const rate of rates) {
      log(`sequence ${set} ${rate}x ...`);
      const r = await runSequence(set, rate, tap);
      await post(`${tag}_seq_${set}_r${rate}`, r);
      log(`  ${r.samples.length} samples, ended ${r.ended}`);
    }
  }
  if (q.get("switch") !== "0") {
    log("switch while playing ...");
    await post(`${tag}_switch_play`, await runSwitchPlaying());
    log("switch while paused ...");
    await post(`${tag}_switch_paused`, await runSwitchPaused());
  }
  log("steps ...");
  await post(`${tag}_steps`, await runSteps());
  await post(`${tag}_done`, { ok: true });
} catch (e) {
  const err = e instanceof Error ? e.stack ?? e.message : String(e);
  log("FAILED " + err);
  await post(`${tag}_done`, { ok: false, error: err });
}
document.title = "done";
