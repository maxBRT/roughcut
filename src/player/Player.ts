/**
 * The sequence player (spec 2.4.3, 3.5.3), built on the technique the player experiment
 * measured (spikes/player/RESULT.md):
 *
 * - Two video elements are stacked; the one on top plays the current clip, the other is
 *   paused on the first frame of whatever comes next ("prepared": seek to the frame start
 *   plus 1 ms, ready on `seeked`).
 * - Each frame callback of the playing element gives the frame's media time and when it is
 *   expected on screen; from that the player computes when the first frame past the clip
 *   would reach the screen (the "swap target").
 * - An animation-frame loop applies the swap early by one display refresh plus a few
 *   milliseconds (`swapExtraMs`), the refresh being measured at run time: z-index flip,
 *   `play()` on the incoming element, a 5 ms gain ramp on each side.
 * - A source switch on the playing clip (original replaced by the proxy) is a handover at the
 *   same source moment, done the same way a short time ahead of the playhead.
 * - Seeks are coalesced: the next one is issued only after the previous one landed, always
 *   to the latest position (scrubbing, silent backwards play).
 *
 * Times are microseconds (`SequenceTime` in the sequence, `Micros` in a source).
 */
import type { Clip, Micros, SequenceTime, SourceId } from "../types";
import { ceilToFrame } from "../types";
import type { AudioOut, Clock, FrameMetadata, PlayerEnvironment, VideoLike } from "./env";
import { browserEnvironment } from "./env";
import type { FrameLocation } from "./timeline";
import { MEDIA_TIME_TOLERANCE_US, Timeline } from "./timeline";
import type {
  PlaybackRate,
  PlayerError,
  PlayerErrorCode,
  PlayerEvent,
  PlayerFrame,
  PlayerInput,
  PlayerSource,
  ShuttleKey,
  StepAmount,
} from "./types";

/** Options for `new Player`. Give `container` (real elements) or `environment` (stand-ins). */
export interface PlayerOptions {
  /** A positioned element; the player creates its two `<video>` elements inside it. */
  container?: HTMLElement;
  /** Elements, clock and audio to use instead of the browser's. */
  environment?: PlayerEnvironment;
  /** Sound ramp on each side of a cut, in ms (5, as measured). */
  rampMs?: number;
  /** How much earlier than one refresh ahead the swap is applied, in ms (10). */
  swapExtraMs?: number;
  /** A source switch while playing is made this far ahead of the playhead, in ms (400). */
  switchLeadMs?: number;
  /** Report buffering when needed media has not arrived after this long, in ms (250). */
  bufferingAfterMs?: number;
  /**
   * Start the incoming element on the animation frame after the swap, when its picture
   * reaches the screen (true), or at the swap itself as the experiment did (false).
   */
  startOnNextFrame?: boolean;
}

/** Speeds `L` steps through; the first `L` plays at the chosen rate. */
export const SHUTTLE_SPEEDS = [1, 1.5, 2, 4] as const;

/** How far `previewCut` plays on each side of the cut. */
export const PREVIEW_MARGIN_US = 2_000_000;

/** Where an element is parked: 1 ms past the frame start (exactly k/fps can round into k-1). */
const PARK_OFFSET_S = 0.001;

const SHOWN = "2";
const WAITING = "1";

interface Slot {
  index: number;
  el: VideoLike;
  url: string | null;
  sourceId: SourceId | null;
  /** Source time the element is parked on (or was last told to show). */
  at: Micros | null;
  ready: boolean;
  token: number;
  pending: Promise<boolean> | null;
  settle: ((ok: boolean) => void) | null;
}

type Action =
  | { kind: "cut"; clipIndex: number; at: Micros; url: string; sourceId: SourceId; switchSource: boolean }
  | { kind: "stop"; reason: "end" | "preview" | "no_address" | "media_error"; sourceId: SourceId | null };

interface Segment {
  clipIndex: number;
  /** Source time (exclusive) where the playing element must hand over. */
  endAt: Micros;
  action: Action;
}

type Mode = "stopped" | "playing" | "back";

export class Player {
  private readonly env: PlayerEnvironment;
  private readonly clock: Clock;
  private readonly audio: AudioOut;
  private readonly slots: Slot[];
  private readonly listeners = new Set<(e: PlayerEvent) => void>();
  private readonly rampMs: number;
  private readonly swapExtraMs: number;
  private readonly switchLeadMs: number;
  private readonly bufferingAfterMs: number;

  private timeline: Timeline;
  private sources = new Map<SourceId, PlayerSource>();
  private pos: FrameLocation | null = null;
  private cur = 0;
  private mode: Mode = "stopped";
  private baseRate: PlaybackRate = 1;
  private speed = 1;
  private gen = 0;
  private seg: Segment | null = null;
  private swapTarget: number | null = null;
  private handing = false;
  private pendingSwitch: { sourceId: SourceId; url: string; at: Micros } | null = null;
  private stopAt: SequenceTime | null = null;
  private watchToken = 0;
  private watchHandle: { el: VideoLike; id: number } | null = null;
  /** The second half of a cut, run on the next animation frame. */
  private deferred: (() => void) | null = null;
  private readonly startOnNextFrame: boolean;

  private seekWanted: SequenceTime | null = null;
  private seekInFlight: SequenceTime | null = null;
  private seekLoop: Promise<void> | null = null;
  private resumeAfterSeek = false;
  /** The preview end to use when playback resumes after the seek. */
  private resumeStopAt: SequenceTime | null = null;

  private back: { t0: number; from: SequenceTime; speed: number; lastFrame: number } | null = null;

  private buffering = false;
  private lastErrorKey: string | null = null;
  /**
   * Addresses an element failed to load or decode. They are not tried again while `load`
   * keeps giving them (an element in the error state never seeks, so waiting on it would
   * hang); one that leaves the sources and comes back later is tried afresh.
   */
  private readonly failed = new Set<string>();
  private blanked = false;

  private readonly deltas: number[] = [];
  private refresh = 1000 / 60;
  private lastRaf = 0;
  private rafHandle = 0;
  private disposed = false;

  constructor(options: PlayerOptions) {
    const env = options.environment ?? (options.container ? browserEnvironment(options.container) : null);
    if (!env) throw new Error("Player needs a container or an environment");
    this.env = env;
    this.clock = env.clock;
    this.audio = env.audio;
    this.rampMs = options.rampMs ?? 5;
    this.swapExtraMs = options.swapExtraMs ?? 10;
    this.switchLeadMs = options.switchLeadMs ?? 400;
    this.bufferingAfterMs = options.bufferingAfterMs ?? 250;
    this.startOnNextFrame = options.startOnNextFrame ?? true;
    this.timeline = new Timeline([], { num: 30, den: 1 });
    this.slots = [0, 1].map((index) => {
      const el = env.createVideo(index);
      el.preservesPitch = true;
      el.style.zIndex = index === 0 ? SHOWN : WAITING;
      const slot: Slot = { index, el, url: null, sourceId: null, at: null, ready: false, token: 0, pending: null, settle: null };
      this.audio.attach(index, el);
      el.addEventListener("error", () => this.onElementError(slot));
      el.addEventListener("waiting", () => {
        if (this.mode === "playing" && slot.index === this.cur && !this.handing) this.setBuffering(true);
      });
      el.addEventListener("playing", () => {
        if (slot.index === this.cur && !this.handing) this.setBuffering(false);
      });
      el.addEventListener("ended", () => {
        if (this.mode === "playing" && slot.index === this.cur) void this.handover();
      });
      return slot;
    });
    const loop = (t: number) => {
      if (this.disposed) return;
      this.tick(t);
      this.rafHandle = this.clock.requestAnimationFrame(loop);
    };
    this.rafHandle = this.clock.requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- public surface

  /** Listens to frames, ended, buffering and errors; returns the unsubscribe function. */
  subscribe(listener: (e: PlayerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** What is on screen now. */
  get frame(): PlayerFrame {
    return this.makeFrame();
  }

  /** The chosen rate (1, 1.5 or 2). */
  get rate(): PlaybackRate {
    return this.baseRate;
  }

  /** Length of the loaded sequence. */
  get duration(): Micros {
    return this.timeline.duration;
  }

  /** The display refresh period measured from animation frames, in ms. */
  get refreshMs(): number {
    return this.refresh;
  }

  /**
   * Takes the clips, each source's playback address and duration, and the frame rate. Call
   * it again whenever any of them changes: the position is kept (the same source moment if
   * it is still in the sequence, otherwise the same sequence time). A new address for the
   * source playing now (the proxy replacing the original) is switched to at the same moment,
   * without stopping playback.
   */
  load(input: PlayerInput): void {
    if (this.disposed) return;
    const oldTimeline = this.timeline;
    const oldPos = this.pos;
    const oldClip = oldPos ? oldTimeline.clip(oldPos.clipIndex) : undefined;
    this.timeline = new Timeline(input.clips, input.frameRate);
    this.sources = toMap(input.sources);
    this.lastErrorKey = null;
    const inUse = new Set<string>();
    for (const s of this.sources.values()) if (s.url) inUse.add(s.url);
    for (const u of [...this.failed]) if (!inUse.has(u)) this.failed.delete(u);
    // A seek or prepare waiting on an address no longer in use would wait on media nobody
    // needs (or forever, on a failed element): settle it so the latest request goes ahead.
    for (const s of this.slots) if (s.settle && s.url && !inUse.has(s.url)) this.release(s);
    const tl = this.timeline;

    if (tl.empty) {
      this.stopPlayback(false);
      this.stopBack();
      this.seekWanted = null;
      this.resumeAfterSeek = false;
      this.pos = null;
      this.blank();
      this.emitFrame();
      return;
    }

    /**
     * Where a position on the old sequence is on the new one: the same source moment if it is
     * still in the sequence (`kept`), otherwise the same sequence time.
     */
    const relocate = (old: FrameLocation, oldClipRef: Clip): { loc: FrameLocation | null; kept: boolean } => {
      let found: FrameLocation | null = null;
      const sameId = tl.indexOfClip(oldClipRef.id);
      const keepsMoment = (i: number) => {
        const c = tl.clip(i)!;
        return c.sourceId === oldClipRef.sourceId && c.start <= old.at && old.at < c.end;
      };
      if (sameId >= 0 && keepsMoment(sameId)) found = tl.frameIn(sameId, old.at);
      else {
        for (let i = 0; i < tl.clips.length && !found; i++) if (keepsMoment(i)) found = tl.frameIn(i, old.at);
      }
      return { loc: found ?? tl.frameAt(old.time), kept: found !== null };
    };

    let loc: FrameLocation | null = null;
    /** True when the source moment on screen is still in the sequence (`loc` shows it). */
    let kept = false;
    if (oldPos && oldClip) ({ loc, kept } = relocate(oldPos, oldClip));
    loc ??= tl.frame(0)!;

    if (this.seekLoop) {
      // A seek is in flight on the old sequence: land it, then go where the latest seek asked
      // for, moved onto the new sequence (not back to the frame on screen when it was asked).
      const asked = this.seekWanted ?? this.seekInFlight;
      const askedOld = asked !== null ? oldTimeline.frameAt(asked) : null;
      const askedClip = askedOld ? oldTimeline.clip(askedOld.clipIndex) : undefined;
      const moved = askedOld && askedClip ? relocate(askedOld, askedClip).loc : null;
      this.seekWanted = (moved ?? loc).time;
      this.pos = loc;
      return;
    }

    const clip = tl.clip(loc.clipIndex)!;
    const url = this.urlOf(clip.sourceId);
    const vis = this.slots[this.cur]!;

    if (this.mode === "back" && this.back) {
      this.pos = loc;
      this.back = { ...this.back, t0: this.clock.now(), from: loc.time, lastFrame: loc.index };
      return;
    }

    if (
      this.mode === "playing" &&
      !this.handing &&
      this.seg &&
      kept &&
      url &&
      !this.failed.has(url) &&
      vis.sourceId === clip.sourceId
    ) {
      // The moment playing is still in the sequence: keep playing on the visible element;
      // only what comes next changes. (When the edit removed it, the element would play on
      // through the removed material, so that case seeks to the kept time below instead.)
      this.pos = loc;
      this.pendingSwitch = null;
      if (url !== vis.url) {
        // The proxy replaced the original (or the address changed): hand over to the new
        // address at the same source moment, a little ahead of the playhead.
        const at = ceilToFrame(loc.at + this.switchLeadMs * 1000, tl.rate);
        if (at < clip.end) this.pendingSwitch = { sourceId: clip.sourceId, url, at };
      }
      this.seg = this.segmentFrom(loc.clipIndex, loc.at);
      this.swapTarget = null;
      this.prepareNext();
      this.emitFrame();
      return;
    }

    if (this.mode === "stopped" && url && vis.url === url && vis.ready && vis.at === loc.at && !this.blanked) {
      this.pos = loc;
      this.emitFrame();
      this.prepareNext();
      return;
    }

    const resume = this.mode === "playing";
    this.stopPlayback(true);
    this.pos = loc;
    if (resume) this.resumeAfterSeek = true;
    void this.requestSeek(loc.time);
  }

  /** Starts playing forwards at the chosen rate from the current position. */
  play(): Promise<void> {
    if (this.disposed || this.timeline.empty) return Promise.resolve();
    void this.audio.resume().catch(() => undefined);
    if (this.mode === "back") this.stopBack();
    this.speed = this.baseRate;
    // Each press of play is told again why it cannot play (no address, a failed source).
    if (this.mode === "stopped") this.lastErrorKey = null;
    if (this.seekLoop) {
      this.resumeAfterSeek = true;
      return this.seekLoop;
    }
    if (this.mode === "playing") {
      this.applySpeed();
      return Promise.resolve();
    }
    const pos = this.pos ?? this.timeline.frame(0)!;
    if (pos.index >= this.timeline.totalFrames - 1) {
      this.resumeAfterSeek = true;
      return this.requestSeek(0);
    }
    return this.startPlaying();
  }

  /** Pauses (also stops silent backwards play). */
  pause(): void {
    this.resumeAfterSeek = false;
    this.resumeStopAt = null;
    this.stopAt = null;
    if (this.mode === "back") {
      this.stopBack();
      this.emitFrame();
      return;
    }
    if (this.mode !== "playing") return;
    this.stopPlayback(true);
    this.emitFrame();
  }

  /** Play or pause (`Space`). */
  toggle(): Promise<void> {
    if (this.mode === "stopped" && !this.resumeAfterSeek) return this.play();
    this.pause();
    return Promise.resolve();
  }

  /**
   * Shows the frame at sequence time `t` (clamped into the sequence). Keeps playing if it
   * was playing. Resolves once the latest requested position is on screen.
   */
  seek(t: SequenceTime): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.mode === "back") this.stopBack();
    if (this.mode === "playing") {
      this.stopPlayback(true);
      this.resumeAfterSeek = true;
    }
    return this.requestSeek(t);
  }

  /** Pauses, then moves by whole frames or by seconds (negative = backwards), across cuts. */
  step(amount: StepAmount): Promise<void> {
    if (this.disposed || this.timeline.empty) return Promise.resolve();
    this.resumeAfterSeek = false;
    this.stopAt = null;
    if (this.mode === "back") this.stopBack();
    if (this.mode === "playing") this.stopPlayback(true);
    const base = this.seekWanted ?? this.seekInFlight ?? this.pos?.time ?? 0;
    const from = this.timeline.frameAt(base)!;
    if ("frames" in amount) {
      const to = this.timeline.frame(from.index + Math.trunc(amount.frames))!;
      return this.requestSeek(to.time);
    }
    return this.requestSeek(Math.max(0, from.time + Math.round(amount.seconds * 1_000_000)));
  }

  /** Sets the playback rate (pitch preserved); applies at once while playing. */
  setRate(rate: PlaybackRate): void {
    this.baseRate = rate;
    if (this.mode === "playing") {
      this.speed = rate;
      this.applySpeed();
      this.emitFrame();
    } else if (this.mode === "back" && this.back) {
      this.restartBack(rate);
    }
  }

  /**
   * `J` `K` `L`: `L` plays forwards and each further `L` goes faster (`SHUTTLE_SPEEDS`);
   * `K` pauses; `J` plays backwards without sound as rapid steps, each further `J` faster.
   */
  shuttle(key: ShuttleKey): Promise<void> {
    if (key === "K") {
      this.pause();
      return Promise.resolve();
    }
    if (this.timeline.empty) return Promise.resolve();
    if (key === "L") {
      if (this.mode === "playing") {
        this.speed = nextSpeed(this.speed);
        this.applySpeed();
        this.emitFrame();
        return Promise.resolve();
      }
      return this.play();
    }
    if (this.mode === "back" && this.back) {
      this.restartBack(nextSpeed(this.back.speed));
      return Promise.resolve();
    }
    this.resumeAfterSeek = false;
    this.stopAt = null;
    if (this.mode === "playing") this.stopPlayback(true);
    void this.audio.resume().catch(() => undefined);
    this.startBack(this.baseRate);
    return Promise.resolve();
  }

  /** Plays from two seconds before sequence time `at` (a cut) to two seconds after. */
  async previewCut(at: SequenceTime): Promise<void> {
    if (this.disposed || this.timeline.empty) return;
    this.resumeAfterSeek = false;
    if (this.mode === "back") this.stopBack();
    if (this.mode === "playing") this.stopPlayback(true);
    const stop = Math.min(this.timeline.duration, at + PREVIEW_MARGIN_US);
    await this.requestSeek(Math.max(0, at - PREVIEW_MARGIN_US));
    if (this.disposed || this.mode !== "stopped" || this.seekLoop) return;
    this.speed = this.baseRate;
    await this.startPlaying(stop);
  }

  /** Stops everything and releases the elements and the audio output. */
  dispose(): void {
    if (this.disposed) return;
    this.stopPlayback(false);
    this.stopBack();
    this.disposed = true;
    this.clock.cancelAnimationFrame(this.rafHandle);
    for (const s of this.slots) {
      this.release(s);
      s.el.pause();
      s.el.removeAttribute("src");
      s.el.load();
      this.env.destroyVideo?.(s.el);
    }
    this.audio.dispose();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------- reporting

  private makeFrame(): PlayerFrame {
    const pos = this.pos;
    const clip = pos ? this.timeline.clip(pos.clipIndex) : undefined;
    const playing = this.mode !== "stopped";
    const speed = this.mode === "playing" ? this.speed : this.mode === "back" && this.back ? -this.back.speed : 0;
    return {
      time: pos ? pos.time : 0,
      position: pos && clip ? { sourceId: clip.sourceId, at: pos.at } : null,
      playing,
      speed,
    };
  }

  private emit(e: PlayerEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        console.error("player listener failed", err);
      }
    }
  }

  private emitFrame(): void {
    this.emit({ type: "frame", frame: this.makeFrame() });
  }

  private setBuffering(on: boolean): void {
    if (this.buffering === on) return;
    this.buffering = on;
    this.emit({ type: "buffering", buffering: on });
  }

  private emitError(code: PlayerErrorCode, sourceId: SourceId | null, message: string): void {
    const key = `${code}:${sourceId ?? ""}`;
    if (key === this.lastErrorKey) return;
    this.lastErrorKey = key;
    const error: PlayerError = { code, sourceId, message };
    this.emit({ type: "error", error });
  }

  // ---------------------------------------------------------------- elements

  private urlOf(sourceId: SourceId): string | null {
    return this.sources.get(sourceId)?.url ?? null;
  }

  private show(index: number): void {
    const inn = this.slots[index]!;
    const out = this.slots[1 - index]!;
    inn.el.style.zIndex = SHOWN;
    out.el.style.zIndex = WAITING;
    if (this.blanked) {
      inn.el.style.opacity = "";
      out.el.style.opacity = "";
      this.blanked = false;
    }
    this.cur = index;
  }

  /** Nothing to show (empty sequence, or a source with no address): hide both pictures. */
  private blank(): void {
    for (const s of this.slots) s.el.style.opacity = "0";
    this.blanked = true;
  }

  private release(slot: Slot): void {
    const settle = slot.settle;
    slot.settle = null;
    if (settle) settle(false);
  }

  /** Parks `slot` on source time `at` of `url`, paused. Resolves true once it is ready. */
  private prepare(slot: Slot, url: string, sourceId: SourceId, at: Micros): Promise<boolean> {
    // An address that failed is not waited on: an element in the error state never seeks.
    if (this.failed.has(url)) return Promise.resolve(false);
    if (slot.url === url && slot.at === at && slot.pending) return slot.pending;
    const token = ++slot.token;
    this.release(slot);
    slot.ready = false;
    slot.at = at;
    slot.sourceId = sourceId;
    const el = slot.el;
    if (slot.url !== url || el.error) {
      // A new address, or the same one tried afresh after an earlier failure.
      slot.url = url;
      el.src = url;
    }
    if (!el.paused) el.pause();
    const seconds = at / 1_000_000 + PARK_OFFSET_S;
    const pending = new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        el.removeEventListener("seeked", onSeeked);
        if (slot.settle === finish) slot.settle = null;
        if (slot.token === token) {
          slot.ready = ok;
          if (!ok) slot.pending = null;
        }
        resolve(ok);
      };
      const onSeeked = () => {
        // A late `seeked` of an earlier seek arrives while the newer one still runs.
        if (slot.token !== token || el.seeking) return;
        done(true);
      };
      const finish = (ok: boolean) => done(ok);
      slot.settle = finish;
      el.addEventListener("seeked", onSeeked);
    });
    slot.pending = pending;
    el.currentTime = seconds;
    return pending;
  }

  private onElementError(slot: Slot): void {
    if (!slot.url) return;
    const url = slot.url;
    const err = slot.el.error;
    const sourceId = slot.sourceId;
    // Remember the address as failed before settling, so whatever was waiting on this
    // element (a seek, a handover) sees the failure instead of trying the same address again.
    this.failed.add(url);
    slot.at = null;
    slot.ready = false;
    slot.pending = null;
    this.release(slot);
    const visible = slot.index === this.cur;
    if (visible && this.mode === "playing") {
      this.stopPlayback(false);
      this.emitFrame();
    } else if (this.mode === "playing" && this.seg && this.pos) {
      // The waiting element failed: what comes after the current segment changes (playback
      // stops at a cut into this source; a switch to this address is dropped).
      const a = this.seg.action;
      if (a.kind === "cut" && a.url === url) {
        if (a.switchSource) {
          // The segment now runs on to the clip's end: the next frame callback sets the target.
          this.pendingSwitch = null;
          this.swapTarget = null;
        }
        this.seg = this.segmentFrom(this.seg.clipIndex, this.pos.at);
      }
    }
    this.emitError("media_error", sourceId, err ? `video error ${err.code}: ${err.message}` : "the video could not be loaded");
  }

  // ---------------------------------------------------------------- seeking

  /** Coalesced seek: one in flight at a time, the latest position wins. */
  private requestSeek(t: SequenceTime): Promise<void> {
    if (this.timeline.empty) {
      this.pos = null;
      this.emitFrame();
      return Promise.resolve();
    }
    this.seekWanted = Math.max(0, Math.round(t));
    if (!this.seekLoop) this.seekLoop = this.runSeeks();
    return this.seekLoop;
  }

  private async runSeeks(): Promise<void> {
    try {
      while (this.seekWanted !== null && !this.disposed) {
        const t = this.seekWanted;
        this.seekWanted = null;
        this.seekInFlight = t;
        await this.showAt(t);
        this.seekInFlight = null;
      }
    } finally {
      this.seekInFlight = null;
      this.seekLoop = null;
    }
    if (this.disposed) return;
    if (this.back) {
      // Silent backwards play goes on; the next animation frame asks for the next frame.
      return;
    }
    const stopAt = this.resumeStopAt;
    this.resumeStopAt = null;
    if (this.resumeAfterSeek && this.mode === "stopped") {
      this.resumeAfterSeek = false;
      await this.startPlaying(stopAt);
    } else {
      this.resumeAfterSeek = false;
      this.prepareNext();
    }
  }

  private async showAt(t: SequenceTime): Promise<void> {
    const tl = this.timeline;
    const loc = tl.frameAt(t);
    if (!loc) return;
    const clip = tl.clip(loc.clipIndex)!;
    const url = this.urlOf(clip.sourceId);
    if (!url) {
      this.pos = loc;
      this.blank();
      this.emitFrame();
      this.emitError("no_address", clip.sourceId, "this source has no playable video yet");
      return;
    }
    const vis = this.slots[this.cur]!;
    const hid = this.slots[1 - this.cur]!;
    let target: Slot;
    if (hid.url === url && hid.at === loc.at && hid.pending) target = hid;
    else if (vis.url === url) target = vis;
    else target = hid;
    if (target === vis && vis.ready && vis.at === loc.at && !this.blanked) {
      this.pos = loc;
      this.emitFrame();
      return;
    }
    const timer = this.clock.setTimeout(() => this.setBuffering(true), this.bufferingAfterMs);
    const ok = await this.prepare(target, url, clip.sourceId, loc.at);
    this.clock.clearTimeout(timer);
    this.setBuffering(false);
    if (this.disposed || this.timeline !== tl) return;
    if (!ok) {
      if (this.failed.has(url) && this.seekWanted === null) {
        // The source cannot be shown: the position moves there, the picture is blanked,
        // like a source with no address (a newer request, if any, goes ahead instead).
        this.pos = loc;
        this.blank();
        this.emitFrame();
        this.emitError("media_error", clip.sourceId, "this source's video could not be loaded");
      }
      return;
    }
    if (target.index !== this.cur || this.blanked) this.show(target.index);
    this.pos = loc;
    this.lastErrorKey = null;
    this.emitFrame();
  }

  // ---------------------------------------------------------------- playing

  private applySpeed(): void {
    for (const s of this.slots) {
      s.el.playbackRate = this.speed;
      s.el.preservesPitch = true;
    }
    this.swapTarget = null;
  }

  /** Where the segment starting at `fromAt` in clip `clipIndex` ends, and what follows. */
  private segmentFrom(clipIndex: number, fromAt: Micros): Segment {
    const tl = this.timeline;
    const clip = tl.clip(clipIndex)!;
    if (this.stopAt !== null && tl.timeOf(clipIndex, clip.end) >= this.stopAt) {
      const endAt = clip.start + (this.stopAt - tl.clipStart(clipIndex));
      if (endAt > fromAt) return { clipIndex, endAt, action: { kind: "stop", reason: clipIndex === tl.clips.length - 1 && endAt >= clip.end ? "end" : "preview", sourceId: null } };
    }
    const sw = this.pendingSwitch;
    if (sw && this.failed.has(sw.url)) this.pendingSwitch = null;
    else if (sw && sw.sourceId === clip.sourceId && sw.at > fromAt && sw.at < clip.end) {
      return { clipIndex, endAt: sw.at, action: { kind: "cut", clipIndex, at: sw.at, url: sw.url, sourceId: sw.sourceId, switchSource: true } };
    }
    const next = tl.clip(clipIndex + 1);
    if (!next) return { clipIndex, endAt: clip.end, action: { kind: "stop", reason: "end", sourceId: null } };
    const url = this.urlOf(next.sourceId);
    if (!url) return { clipIndex, endAt: clip.end, action: { kind: "stop", reason: "no_address", sourceId: next.sourceId } };
    if (this.failed.has(url)) return { clipIndex, endAt: clip.end, action: { kind: "stop", reason: "media_error", sourceId: next.sourceId } };
    return { clipIndex, endAt: clip.end, action: { kind: "cut", clipIndex: clipIndex + 1, at: next.start, url, sourceId: next.sourceId, switchSource: false } };
  }

  /** Keeps the waiting element ready for what comes after the current clip or segment. */
  private prepareNext(): void {
    if (this.seekLoop || this.disposed || this.back) return;
    const hid = this.slots[1 - this.cur]!;
    if (this.mode === "playing") {
      const a = this.seg?.action;
      if (a && a.kind === "cut") void this.prepare(hid, a.url, a.sourceId, a.at);
      return;
    }
    const pos = this.pos;
    if (!pos) return;
    const next = this.timeline.clip(pos.clipIndex + 1);
    if (!next) return;
    const url = this.urlOf(next.sourceId);
    if (url) void this.prepare(hid, url, next.sourceId, next.start);
  }

  private async startPlaying(stopAt: SequenceTime | null = null): Promise<void> {
    const tl = this.timeline;
    const pos = this.pos ?? tl.frame(0);
    if (!pos || this.disposed) return;
    const clip = tl.clip(pos.clipIndex)!;
    const url = this.urlOf(clip.sourceId);
    if (!url) {
      this.emitError("no_address", clip.sourceId, "this source has no playable video yet");
      return;
    }
    if (this.failed.has(url)) {
      this.resumeAfterSeek = false;
      this.emitError("media_error", clip.sourceId, "this source's video could not be loaded");
      return;
    }
    const vis = this.slots[this.cur]!;
    if (!(vis.url === url && vis.ready && vis.at === pos.at) || this.blanked) {
      // The picture on screen is not the position (it moved, or the address changed).
      this.resumeAfterSeek = true;
      this.resumeStopAt = stopAt;
      await this.requestSeek(pos.time);
      return;
    }
    this.gen++;
    const g = this.gen;
    this.mode = "playing";
    this.stopAt = stopAt;
    this.pendingSwitch = null;
    this.seg = this.segmentFrom(pos.clipIndex, pos.at);
    this.swapTarget = null;
    this.applySpeed();
    this.audio.setMuted(false);
    this.audio.ramp(this.cur, 1, this.rampMs);
    this.watch(this.cur);
    this.swapTarget = this.targetFromStart(pos.at);
    this.emitFrame();
    this.prepareNext();
    try {
      await vis.el.play();
    } catch (err) {
      if (g !== this.gen) return;
      this.stopPlayback(false);
      this.emitFrame();
      this.emitError("play_rejected", clip.sourceId, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Stops forward playback. `ramp`: fade the sound out before pausing the element, but pause
   * it before the frame due at `boundary` (a screen time, by default the swap target) could
   * be picked for display, so a frame past a cut or the end is never shown.
   */
  private stopPlayback(ramp: boolean, boundary: number | null = this.swapTarget): void {
    if (this.mode !== "playing") {
      this.handing = false;
      return;
    }
    this.gen++;
    const g = this.gen;
    this.mode = "stopped";
    this.seg = null;
    this.swapTarget = null;
    this.handing = false;
    this.pendingSwitch = null;
    this.stopAt = null;
    this.unwatch();
    this.setBuffering(false);
    const vis = this.slots[this.cur]!;
    const hid = this.slots[1 - this.cur]!;
    hid.el.pause();
    this.audio.set(hid.index, 0);
    vis.at = this.pos?.at ?? vis.at;
    vis.ready = vis.at !== null;
    vis.pending = vis.ready ? Promise.resolve(true) : null;
    if (!ramp) {
      vis.el.pause();
      this.audio.set(vis.index, 0);
      return;
    }
    let delay = this.rampMs + 2;
    if (boundary !== null) delay = Math.min(delay, Math.max(0, boundary - this.clock.now() - this.refresh - 2));
    if (delay <= 0) {
      vis.el.pause();
      this.audio.set(vis.index, 0);
      return;
    }
    this.audio.ramp(vis.index, 0, Math.min(this.rampMs, delay));
    this.clock.setTimeout(() => {
      if (this.mode === "playing" && vis.index === this.cur) return;
      vis.el.pause();
      this.audio.set(vis.index, 0);
      if (g !== this.gen || this.seekLoop || this.disposed) return;
      const pos = this.pos;
      if (!pos || vis.index !== this.cur || !vis.url || !vis.sourceId) return;
      // The element's clock may sit a frame away from the frame last shown and reported
      // (it ran on while the sound faded, or its clock lags the picture): park it exactly
      // on the reported frame, so what is on screen and what is reported agree.
      const clock = this.timeline.frameFromMedia(pos.clipIndex, vis.el.currentTime * 1_000_000);
      if (!clock || clock.index !== pos.index) {
        vis.pending = null;
        void this.prepare(vis, vis.url, vis.sourceId, pos.at).then((ok) => {
          if (ok && g === this.gen && !this.seekLoop) this.prepareNext();
        });
        return;
      }
      this.prepareNext();
    }, delay);
  }

  private unwatch(): void {
    this.watchToken++;
    if (this.watchHandle) {
      this.watchHandle.el.cancelVideoFrameCallback(this.watchHandle.id);
      this.watchHandle = null;
    }
  }

  /** Frame callbacks of the playing element: report the position, compute the swap target. */
  private watch(index: number): void {
    this.unwatch();
    const token = this.watchToken;
    const el = this.slots[index]!.el;
    const cb = (_now: number, md: FrameMetadata) => {
      if (token !== this.watchToken || this.mode !== "playing" || !this.seg) return;
      const seg = this.seg;
      const m = md.mediaTime * 1_000_000;
      if (m + MEDIA_TIME_TOLERANCE_US >= seg.endAt) {
        // Late: a frame past the boundary is already up. Hand over now.
        this.watchHandle = null;
        void this.handover();
        return;
      }
      const loc = this.timeline.frameFromMedia(seg.clipIndex, m);
      if (loc && loc.index !== this.pos?.index) {
        this.pos = loc;
        this.emitFrame();
      }
      // When the first frame past the boundary reaches the screen: from the frame just
      // presented (as the experiment did), or earlier if the element's media clock says so
      // (a frame can be presented up to one refresh after its time came).
      // A source switch is not a cut: the frames on both sides are the same pictures, so an
      // extra frame of the old element is harmless, while swapping on the clock of an element
      // whose picture lags it (a 4K original) would skip the frame it has not shown yet.
      const fromFrame = md.expectedDisplayTime + (seg.endAt - m) / 1000 / this.speed;
      const isSwitch = seg.action.kind === "cut" && seg.action.switchSource;
      const clock = el.currentTime * 1_000_000;
      const fromClock =
        !isSwitch && Math.abs(clock - m) < 100_000 ? this.clock.now() + (seg.endAt - clock) / 1000 / this.speed : Infinity;
      this.swapTarget = Math.min(fromFrame, fromClock);
      this.watchHandle = { el, id: el.requestVideoFrameCallback(cb) };
    };
    this.watchHandle = { el, id: el.requestVideoFrameCallback(cb) };
  }

  /**
   * The swap target for an element starting to play now from source time `at` (parked 1 ms
   * into the frame): known before its first frame callback, which a one-frame clip at 2x
   * may never get in time.
   */
  private targetFromStart(at: Micros): number | null {
    const seg = this.seg;
    if (!seg) return null;
    return this.clock.now() + (seg.endAt - at - PARK_OFFSET_S * 1_000_000) / 1000 / this.speed;
  }

  private tick(t: number): void {
    const deferred = this.deferred;
    this.deferred = null;
    if (deferred) deferred();
    if (this.lastRaf) {
      const d = t - this.lastRaf;
      if (d > 3 && d < 60) {
        this.deltas.push(d);
        if (this.deltas.length > 32) this.deltas.shift();
        if (this.deltas.length >= 4) this.refresh = median(this.deltas);
      }
    }
    this.lastRaf = t;
    if (this.mode === "playing" && this.swapTarget !== null && !this.handing) {
      // A change made now reaches the screen about one refresh later. Swap early by one
      // measured refresh plus `swapExtraMs`, so the outgoing clip's next frame is never shown
      // (the experiment's "2 refreshes" at 144 Hz, expressed so it also holds at 60 Hz).
      // Pausing (the end, a preview's end, or holding the last frame because the next clip
      // is not ready) cannot recall a frame the element already queued: one refresh earlier.
      const a = this.seg?.action;
      const hid = this.slots[1 - this.cur]!;
      const swaps = a?.kind === "cut" && hid.ready && hid.url === a.url && hid.at === a.at;
      const lead = this.refresh * (swaps ? 1 : 2) + this.swapExtraMs;
      if (t + lead >= this.swapTarget) void this.handover();
    } else if (this.mode === "back" && this.back) {
      this.backTick();
    }
  }

  /** Crosses the boundary of the current segment: a cut, a source switch, or the end. */
  private async handover(): Promise<void> {
    if (this.handing || this.mode !== "playing" || !this.seg) return;
    const seg = this.seg;
    const action = seg.action;
    const target = this.swapTarget;
    this.swapTarget = null;
    const g = this.gen;
    if (action.kind === "stop") {
      this.stopPlayback(true, target);
      // Pausing early enough never shows a frame past the boundary, but may stop a frame or
      // two short of it: park on the segment's last frame so the position is exact.
      const last = this.timeline.frameIn(seg.clipIndex, seg.endAt - 1);
      if (last.index !== this.pos?.index) void this.requestSeek(last.time);
      this.emitFrame();
      if (action.reason === "end") this.emit({ type: "ended" });
      if (action.reason === "no_address" || action.reason === "media_error") {
        // Playback stopped because of it: say so now, even if it was reported before.
        this.lastErrorKey = null;
        if (action.reason === "no_address") this.emitError("no_address", action.sourceId, "the next clip's source has no playable video yet");
        else this.emitError("media_error", action.sourceId, "the next clip's video could not be loaded");
      }
      return;
    }
    this.handing = true;
    const out = this.slots[this.cur]!;
    const inn = this.slots[1 - this.cur]!;
    if (!(inn.ready && inn.url === action.url && inn.at === action.at)) {
      // Not prepared in time (a clip shorter than its prepare): hold the last frame.
      out.el.pause();
      this.unwatch();
      const timer = this.clock.setTimeout(() => {
        if (g === this.gen) this.setBuffering(true);
      }, this.bufferingAfterMs);
      const ok = await this.prepare(inn, action.url, action.sourceId, action.at);
      this.clock.clearTimeout(timer);
      if (g !== this.gen) return;
      this.setBuffering(false);
      if (!ok) {
        this.handing = false;
        this.stopPlayback(false);
        this.emitFrame();
        if (this.failed.has(action.url)) {
          this.lastErrorKey = null;
          this.emitError("media_error", action.sourceId, "the next clip's video could not be loaded");
        }
        return;
      }
    }
    if (action.switchSource) this.pendingSwitch = null;
    this.show(inn.index);
    inn.el.playbackRate = this.speed;
    inn.el.preservesPitch = true;
    this.seg = this.segmentFrom(action.clipIndex, action.at);
    this.pos = this.timeline.frameIn(action.clipIndex, action.at);
    this.emitFrame();
    // The incoming frame reaches the screen one refresh from now. Its clock starts then too
    // (on the next animation frame), so its first frame is held for its full length; the
    // outgoing element plays on underneath, sound included, until that moment.
    const begin = () => this.beginIncoming(g, out, inn, action);
    if (this.startOnNextFrame) this.deferred = begin;
    else begin();
  }

  /** Second half of a cut: start the incoming element and release the outgoing one. */
  private beginIncoming(g: number, out: Slot, inn: Slot, action: Extract<Action, { kind: "cut" }>): void {
    if (g !== this.gen || !this.seg) {
      this.handing = false;
      return;
    }
    const lengthMs = (this.seg.endAt - action.at) / 1000 / this.speed;
    let playing: Promise<void>;
    if (lengthMs < 2 * this.refresh) {
      // Shorter than two refreshes (a one-frame clip at 2x on 60 Hz): playing it would run
      // past its end before it is even shown, so show its frame as a still for its length.
      this.unwatch();
      this.swapTarget = this.clock.now() + lengthMs;
      playing = Promise.resolve();
      this.audio.ramp(out.index, 0, this.rampMs);
    } else {
      this.watch(inn.index);
      playing = inn.el.play();
      this.swapTarget = this.targetFromStart(action.at);
      this.audio.ramp(out.index, 0, this.rampMs);
      this.audio.ramp(inn.index, 1, this.rampMs);
    }
    this.handing = false;
    // The outgoing element is no longer parked anywhere; it plays on, silent, for the ramp.
    out.at = null;
    out.ready = false;
    out.pending = null;
    const outToken = out.token;
    this.clock.setTimeout(() => {
      // Unless it was already re-prepared (a very short clip came next) or is on top again.
      if (out.index !== this.cur && out.token === outToken) {
        out.el.pause();
        this.audio.set(out.index, 0);
      }
      if (g === this.gen) this.prepareNext();
    }, this.rampMs + 2);
    playing.catch((err: unknown) => {
      if (g !== this.gen) return;
      this.stopPlayback(false);
      this.emitFrame();
      this.emitError("play_rejected", action.sourceId, err instanceof Error ? err.message : String(err));
    });
  }

  // ---------------------------------------------------------------- backwards

  private startBack(speed: number): void {
    const pos = this.pos ?? this.timeline.frame(0)!;
    this.mode = "back";
    this.audio.setMuted(true);
    this.back = { t0: this.clock.now(), from: pos.time, speed, lastFrame: pos.index };
    this.emitFrame();
  }

  private restartBack(speed: number): void {
    const pos = this.pos ?? this.timeline.frame(0)!;
    this.back = { t0: this.clock.now(), from: pos.time, speed, lastFrame: pos.index };
    this.emitFrame();
  }

  private stopBack(): void {
    if (this.mode !== "back") return;
    this.mode = "stopped";
    this.back = null;
    this.audio.setMuted(false);
    if (!this.seekLoop) this.prepareNext();
  }

  private backTick(): void {
    const b = this.back!;
    const elapsedUs = (this.clock.now() - b.t0) * 1000 * b.speed;
    const target = Math.max(0, Math.round(b.from - elapsedUs));
    const loc = this.timeline.frameAt(target);
    if (!loc) return;
    if (loc.index !== b.lastFrame) {
      b.lastFrame = loc.index;
      if (this.seekLoop) this.seekWanted = loc.time;
      else void this.requestSeek(loc.time);
      return;
    }
    if (loc.index === 0 && !this.seekLoop && this.pos?.index === 0) {
      this.stopBack();
      this.emitFrame();
    }
  }
}

function nextSpeed(s: number): number {
  for (const v of SHUTTLE_SPEEDS) if (v > s + 1e-9) return v;
  return SHUTTLE_SPEEDS[SHUTTLE_SPEEDS.length - 1]!;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function toMap(
  sources: ReadonlyMap<SourceId, PlayerSource> | Readonly<Record<SourceId, PlayerSource>>,
): Map<SourceId, PlayerSource> {
  if (sources instanceof Map) return new Map(sources);
  return new Map(Object.entries(sources as Record<SourceId, PlayerSource>));
}
