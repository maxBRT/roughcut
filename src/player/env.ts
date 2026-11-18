/**
 * What the player needs from the browser, as small interfaces, so tests can supply stand-ins:
 * two video elements, a clock (time, animation frames, timers) and an audio output that can
 * ramp each element's sound. `browserEnvironment` builds the real ones.
 */

/** The metadata `requestVideoFrameCallback` passes (the fields the player reads). */
export interface FrameMetadata {
  /** Presentation time of the frame, in seconds of the source file. */
  mediaTime: number;
  /** When the frame is expected on screen, on the `Clock.now` timeline (ms). */
  expectedDisplayTime: number;
}

/** The subset of `HTMLVideoElement` the player uses. */
export interface VideoLike {
  src: string;
  currentTime: number;
  readonly paused: boolean;
  readonly seeking: boolean;
  readonly readyState: number;
  readonly error: { code: number; message: string } | null;
  playbackRate: number;
  preservesPitch: boolean;
  readonly style: { zIndex: string; opacity: string };
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
  load(): void;
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: () => void): void;
  requestVideoFrameCallback(cb: (now: number, metadata: FrameMetadata) => void): number;
  cancelVideoFrameCallback(handle: number): void;
}

/** Time and scheduling. `now` and animation-frame timestamps share one timeline (ms). */
export interface Clock {
  now(): number;
  requestAnimationFrame(cb: (t: number) => void): number;
  cancelAnimationFrame(handle: number): void;
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

/** Sound output with a gain per element; ramps avoid clicks at cuts (spec 2.4.3). */
export interface AudioOut {
  /** Routes element `index` (0 or 1) through its own gain, starting silent. */
  attach(index: number, el: VideoLike): void;
  /** Ramps element `index`'s gain linearly from its current value to `to` over `ms`. */
  ramp(index: number, to: number, ms: number): void;
  /** Sets element `index`'s gain at once. */
  set(index: number, value: number): void;
  /** Mutes or unmutes everything (silent backwards play). */
  setMuted(muted: boolean): void;
  /** Starts the output if the browser suspended it; call from a user gesture. */
  resume(): Promise<void>;
  /** Releases the output. */
  dispose(): void;
}

/** Everything the player takes from its surroundings. */
export interface PlayerEnvironment {
  /** Makes video element `index` (0 or 1); the player appends nothing itself. */
  createVideo(index: number): VideoLike;
  /** Removes an element `createVideo` made, when the player is disposed. */
  destroyVideo?(el: VideoLike): void;
  clock: Clock;
  audio: AudioOut;
}

/** The real clock: `performance.now`, `requestAnimationFrame` and timers. */
export function browserClock(): Clock {
  const raf =
    typeof requestAnimationFrame === "function"
      ? (cb: (t: number) => void) => requestAnimationFrame(cb)
      : (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
  const caf =
    typeof cancelAnimationFrame === "function"
      ? (h: number) => cancelAnimationFrame(h)
      : (h: number) => clearTimeout(h);
  return {
    now: () => performance.now(),
    requestAnimationFrame: raf,
    cancelAnimationFrame: caf,
    setTimeout: (cb, ms) => setTimeout(cb, ms) as unknown as number,
    clearTimeout: (h) => clearTimeout(h),
  };
}

/**
 * Web Audio output: element -> its own GainNode -> `output` (master) -> speakers, as the
 * player experiment did it. Gains are sample-accurate, so the ramps are clean.
 * `output` is exposed so a measurement harness can tap the master bus.
 */
export class WebAudioOut implements AudioOut {
  readonly context: AudioContext;
  readonly output: GainNode;
  private readonly gains: GainNode[] = [];

  constructor(context?: AudioContext) {
    this.context = context ?? new AudioContext({ latencyHint: "interactive" });
    this.output = this.context.createGain();
    this.output.connect(this.context.destination);
  }

  attach(index: number, el: VideoLike): void {
    const g = this.context.createGain();
    g.gain.value = 0;
    this.context.createMediaElementSource(el as unknown as HTMLMediaElement).connect(g);
    g.connect(this.output);
    this.gains[index] = g;
  }

  ramp(index: number, to: number, ms: number): void {
    const g = this.gains[index];
    if (!g) return;
    const t = this.context.currentTime;
    const from = g.gain.value;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(from, t);
    g.gain.linearRampToValueAtTime(to, t + Math.max(ms, 0.5) / 1000);
  }

  set(index: number, value: number): void {
    const g = this.gains[index];
    if (!g) return;
    g.gain.cancelScheduledValues(this.context.currentTime);
    g.gain.value = value;
  }

  setMuted(muted: boolean): void {
    this.output.gain.value = muted ? 0 : 1;
  }

  async resume(): Promise<void> {
    if (this.context.state !== "running") await this.context.resume();
  }

  dispose(): void {
    void this.context.close().catch(() => undefined);
  }
}

/** Fallback when Web Audio is missing: element volume, switched without a ramp. */
export class VolumeAudioOut implements AudioOut {
  private readonly els: (VideoLike & { volume?: number; muted?: boolean })[] = [];
  private readonly levels: number[] = [];
  private muted = false;

  attach(index: number, el: VideoLike): void {
    this.els[index] = el;
    this.levels[index] = 0;
    this.apply(index);
  }
  ramp(index: number, to: number): void {
    this.set(index, to);
  }
  set(index: number, value: number): void {
    this.levels[index] = value;
    this.apply(index);
  }
  setMuted(muted: boolean): void {
    this.muted = muted;
    for (let i = 0; i < this.els.length; i++) this.apply(i);
  }
  async resume(): Promise<void> {}
  dispose(): void {}
  private apply(index: number): void {
    const el = this.els[index];
    if (el) el.volume = this.muted ? 0 : (this.levels[index] ?? 0);
  }
}

/**
 * The real environment: two `<video>` elements stacked in `container` (both visible and in
 * layout; the playing one on top), the browser clock and Web Audio. The media server sends
 * `Access-Control-Allow-Origin: *`, and the elements use `crossOrigin = "anonymous"`, which
 * Web Audio needs to hear media from another origin.
 */
export function browserEnvironment(container: HTMLElement): PlayerEnvironment {
  const audio: AudioOut = typeof AudioContext === "function" ? new WebAudioOut() : new VolumeAudioOut();
  return {
    createVideo(index: number): VideoLike {
      const v = document.createElement("video");
      v.crossOrigin = "anonymous";
      v.preload = "auto";
      v.playsInline = true;
      v.disablePictureInPicture = true;
      v.preservesPitch = true;
      v.setAttribute("data-player-slot", String(index));
      v.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000";
      container.appendChild(v);
      return v as unknown as VideoLike;
    },
    destroyVideo(el: VideoLike): void {
      (el as unknown as HTMLVideoElement).remove();
    },
    clock: browserClock(),
    audio,
  };
}
