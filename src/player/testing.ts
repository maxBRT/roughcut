/**
 * Stand-ins for the player's surroundings, for unit tests (here and in `state`): a clock with
 * a display refresh, video elements that seek, play and present frames on that refresh, a
 * recording audio output, and a "screen" that records what is on top at every refresh.
 *
 * Display model, per refresh at time T (the next picture reaches the screen at T + refresh):
 * 1. every playing element picks the frame due at T + refresh and runs its frame callbacks
 *    with `expectedDisplayTime = T + refresh`;
 * 2. animation-frame callbacks run (the player decides swaps there);
 * 3. the screen records the top element (z-index 2, not transparent) and its frame, as
 *    shown at T + refresh.
 * Promises are flushed between steps, so the player's async code runs as in a browser.
 */
import type { AudioOut, Clock, FrameMetadata, PlayerEnvironment, VideoLike } from "./env";

/** Lets pending promise callbacks run. */
export async function flushMicrotasks(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

interface Timer {
  id: number;
  at: number;
  cb: () => void;
}

/** A manual clock with a display refresh of `refreshMs`. */
export class FakeClock implements Clock {
  t = 0;
  private nextId = 1;
  private timers: Timer[] = [];
  private rafs = new Map<number, (t: number) => void>();
  private nextVsync: number;
  /** Called at every refresh before animation frames: elements present frames. */
  readonly beforeFrame: ((t: number) => void)[] = [];
  /** Called at every refresh after animation frames: the screen samples. */
  readonly afterFrame: ((t: number) => void)[] = [];

  constructor(public refreshMs = 1000 / 60) {
    this.nextVsync = refreshMs;
  }

  now(): number {
    return this.t;
  }
  requestAnimationFrame(cb: (t: number) => void): number {
    const id = this.nextId++;
    this.rafs.set(id, cb);
    return id;
  }
  cancelAnimationFrame(handle: number): void {
    this.rafs.delete(handle);
  }
  setTimeout(cb: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.push({ id, at: this.t + Math.max(0, ms), cb });
    return id;
  }
  clearTimeout(handle: number): void {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }

  /** Runs everything due in the next `ms` milliseconds, in time order. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    await flushMicrotasks();
    for (;;) {
      const timer = this.timers.reduce<Timer | null>((a, b) => (a === null || b.at < a.at ? b : a), null);
      const nextAt = Math.min(timer ? timer.at : Infinity, this.nextVsync);
      if (nextAt > end) break;
      this.t = nextAt;
      if (timer && timer.at <= this.nextVsync) {
        this.timers = this.timers.filter((x) => x !== timer);
        timer.cb();
        await flushMicrotasks();
        continue;
      }
      const vt = this.nextVsync;
      this.nextVsync += this.refreshMs;
      for (const f of this.beforeFrame) f(vt);
      await flushMicrotasks();
      const rafs = [...this.rafs.values()];
      this.rafs.clear();
      for (const cb of rafs) cb(vt);
      await flushMicrotasks();
      for (const f of this.afterFrame) f(vt);
    }
    this.t = end;
    await flushMicrotasks();
  }

  /** Advances until `done()` is true or `maxMs` passed; returns whether it became true. */
  async advanceUntil(done: () => boolean, maxMs = 10_000, stepMs = 1): Promise<boolean> {
    const end = this.t + maxMs;
    while (!done()) {
      if (this.t >= end) return false;
      await this.advance(stepMs);
    }
    return true;
  }
}

/** A media file known to the stand-in elements. */
export interface FakeMedia {
  fps: number;
  durationS: number;
  /** How long a seek takes to land, in ms (may depend on the target). */
  seekMs?: number | ((seconds: number) => number);
  /** How long a change of `src` takes before the first seek can land, in ms. */
  loadMs?: number;
}

type Listener = { fn: () => void; once: boolean };

/** A stand-in `<video>` element following the display model above. */
export class FakeVideo implements VideoLike {
  readonly style = { zIndex: "", opacity: "" };
  paused = true;
  seeking = false;
  readyState = 0;
  error: { code: number; message: string } | null = null;
  playbackRate = 1;
  preservesPitch = true;
  /** The frame index on screen, or -1. */
  shownFrame = -1;
  seekCount = 0;
  srcChanges = 0;
  playCalls = 0;
  private url = "";
  private media: FakeMedia | null = null;
  private mediaTime = 0;
  private playStart: { now: number; media: number } | null = null;
  private seekTimer = 0;
  private loadedAt = 0;
  private listeners = new Map<string, Listener[]>();
  private rvfc = new Map<number, (now: number, md: FrameMetadata) => void>();
  private nextRvfc = 1;

  constructor(
    readonly index: number,
    private readonly clock: FakeClock,
    private readonly library: Map<string, FakeMedia>,
  ) {
    clock.beforeFrame.push((t) => this.onRefresh(t));
  }

  get src(): string {
    return this.url;
  }
  set src(url: string) {
    this.url = url;
    this.srcChanges++;
    this.paused = true;
    this.playStart = null;
    this.shownFrame = -1;
    this.readyState = 0;
    this.error = null;
    this.media = this.library.get(url) ?? null;
    this.loadedAt = this.clock.now() + (this.media?.loadMs ?? 20);
    if (!this.media) {
      this.clock.setTimeout(() => {
        if (this.url !== url) return;
        this.error = { code: 4, message: "MEDIA_ERR_SRC_NOT_SUPPORTED" };
        this.dispatch("error");
      }, 5);
    }
  }

  get currentTime(): number {
    if (this.playStart && !this.paused) return this.timeAt(this.clock.now());
    return this.mediaTime;
  }
  set currentTime(s: number) {
    this.seekCount++;
    this.seeking = true;
    if (this.playStart && !this.paused) this.playStart = null;
    this.mediaTime = s;
    if (this.seekTimer) this.clock.clearTimeout(this.seekTimer);
    const media = this.media;
    if (!media) return;
    const cost = typeof media.seekMs === "function" ? media.seekMs(s) : (media.seekMs ?? 10);
    const wait = Math.max(cost, this.loadedAt - this.clock.now());
    this.seekTimer = this.clock.setTimeout(() => {
      this.seekTimer = 0;
      this.seeking = false;
      this.readyState = 4;
      this.shownFrame = this.frameOf(this.mediaTime);
      if (!this.paused) this.playStart = { now: this.clock.now(), media: this.mediaTime };
      this.dispatch("seeked");
    }, wait);
  }

  play(): Promise<void> {
    this.playCalls++;
    if (!this.media) return Promise.reject(new Error("no media"));
    if (this.paused) {
      this.paused = false;
      if (!this.seeking) this.playStart = { now: this.clock.now(), media: this.mediaTime };
    }
    return Promise.resolve();
  }
  pause(): void {
    if (this.paused) return;
    if (this.playStart) this.mediaTime = this.timeAt(this.clock.now());
    this.playStart = null;
    this.paused = true;
  }
  removeAttribute(name: string): void {
    if (name === "src") {
      this.url = "";
      this.media = null;
      this.shownFrame = -1;
    }
  }
  load(): void {}
  addEventListener(type: string, fn: () => void, options?: { once?: boolean }): void {
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, once: !!options?.once });
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter((l) => l.fn !== fn));
  }
  requestVideoFrameCallback(cb: (now: number, md: FrameMetadata) => void): number {
    const id = this.nextRvfc++;
    this.rvfc.set(id, cb);
    return id;
  }
  cancelVideoFrameCallback(handle: number): void {
    this.rvfc.delete(handle);
  }

  /** Fires an event as the browser would (for tests of `waiting`, `error`, ...). */
  dispatch(type: string): void {
    const list = this.listeners.get(type);
    if (!list) return;
    this.listeners.set(type, list.filter((l) => !l.once));
    for (const l of list) l.fn();
  }

  private timeAt(now: number): number {
    const ps = this.playStart!;
    return ps.media + ((now - ps.now) / 1000) * this.playbackRate;
  }

  private frameOf(s: number): number {
    return Math.floor(s * this.media!.fps + 1e-6);
  }

  private onRefresh(t: number): void {
    if (this.paused || this.seeking || !this.playStart || !this.media) return;
    const display = t + this.clock.refreshMs;
    const s = this.timeAt(display);
    if (s >= this.media.durationS) {
      this.mediaTime = this.media.durationS;
      this.playStart = null;
      this.paused = true;
      this.dispatch("ended");
      return;
    }
    const f = this.frameOf(s);
    if (f === this.shownFrame) return;
    this.shownFrame = f;
    const cbs = [...this.rvfc.values()];
    this.rvfc.clear();
    for (const cb of cbs) cb(t, { mediaTime: f / this.media.fps, expectedDisplayTime: display });
  }
}

/** One gain change recorded by `FakeAudio`. */
export interface AudioCall {
  t: number;
  op: "ramp" | "set" | "mute";
  index: number;
  value: number;
  ms: number;
}

/** A recording audio output. `gain(i)` is the level element i ends at. */
export class FakeAudio implements AudioOut {
  readonly calls: AudioCall[] = [];
  muted = false;
  resumed = 0;
  disposed = false;
  private readonly levels: number[] = [0, 0];
  constructor(private readonly clock: Clock) {}
  attach(index: number): void {
    this.levels[index] = 0;
  }
  ramp(index: number, to: number, ms: number): void {
    this.levels[index] = to;
    this.calls.push({ t: this.clock.now(), op: "ramp", index, value: to, ms });
  }
  set(index: number, value: number): void {
    this.levels[index] = value;
    this.calls.push({ t: this.clock.now(), op: "set", index, value, ms: 0 });
  }
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.calls.push({ t: this.clock.now(), op: "mute", index: -1, value: muted ? 1 : 0, ms: 0 });
  }
  async resume(): Promise<void> {
    this.resumed++;
  }
  dispose(): void {
    this.disposed = true;
  }
  gain(index: number): number {
    return this.levels[index] ?? 0;
  }
}

/** What the screen showed at one refresh. */
export interface ScreenSample {
  t: number;
  url: string | null;
  frame: number;
}

/** A complete stand-in environment for `new Player({ environment })`. */
export class FakeEnvironment implements PlayerEnvironment {
  readonly clock: FakeClock;
  readonly audio: FakeAudio;
  readonly library = new Map<string, FakeMedia>();
  readonly videos: FakeVideo[] = [];
  readonly screen: ScreenSample[] = [];
  recording = false;

  constructor(refreshMs = 1000 / 60) {
    this.clock = new FakeClock(refreshMs);
    this.audio = new FakeAudio(this.clock);
    this.clock.afterFrame.push((t) => {
      if (!this.recording) return;
      const top = this.top();
      this.screen.push({ t: t + this.clock.refreshMs, url: top ? top.src || null : null, frame: top ? top.shownFrame : -1 });
    });
  }

  createVideo(index: number): VideoLike {
    const v = new FakeVideo(index, this.clock, this.library);
    this.videos[index] = v;
    return v;
  }

  /** The element on top, or null when the picture is blanked. */
  top(): FakeVideo | null {
    const v = this.videos.find((x) => x.style.zIndex === "2");
    if (!v || v.style.opacity === "0") return null;
    return v;
  }
}
