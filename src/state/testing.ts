/**
 * Stand-ins for tests of the store and of the screens: a player that does the sequence
 * arithmetic without any video, and a helper that builds a store on a fresh stand-in core.
 */
import { clipAt, sequenceDuration, sourcePositionAt } from "../edit";
import type { PlaybackRate, PlayerEvent, PlayerFrame, PlayerInput, ShuttleKey, StepAmount } from "../player";
import type { EditState, SequenceTime } from "../types";
import { frameToMicros, microsToFrameFloor } from "../types";
import { createStandinCore, type StandinCore, type StandinOptions } from "./core";
import { createRoughcutStore, type RoughcutStore, type StoreOptions } from "./store";
import type { PlayerLike } from "./types";

/** One call the store made on the player. */
export type FakePlayerCall =
  | { method: "load"; clips: number }
  | { method: "play" | "pause" | "toggle" }
  | { method: "seek"; t: SequenceTime }
  | { method: "step"; amount: StepAmount }
  | { method: "setRate"; rate: PlaybackRate }
  | { method: "shuttle"; key: ShuttleKey }
  | { method: "previewCut"; at: SequenceTime };

/**
 * A player with no video: it keeps a sequence time, answers every control at once with a
 * frame event, and plays only when told to `advance`. Positions come from the `edit` queries,
 * so frames carry the same source positions the real player reports.
 */
export class FakePlayer implements PlayerLike {
  readonly calls: FakePlayerCall[] = [];
  input: PlayerInput | null = null;
  rate: PlaybackRate = 1;
  private time: SequenceTime = 0;
  private playing = false;
  private speed = 0;
  private stopAt: SequenceTime | null = null;
  private listeners = new Set<(e: PlayerEvent) => void>();
  private lastErrorKey: string | null = null;

  subscribe(listener: (e: PlayerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get frame(): PlayerFrame {
    return { time: this.time, position: this.state ? sourcePositionAt(this.state, this.time) : null, playing: this.playing, speed: this.speed };
  }

  /** Length of the loaded sequence. */
  get duration(): number {
    return this.state ? sequenceDuration(this.state) : 0;
  }

  /** The playback address last loaded for a source (undefined when the source was not given). */
  urlOf(sourceId: string): string | null | undefined {
    const sources = this.input?.sources;
    if (!sources) return undefined;
    if (sources instanceof Map) return (sources as ReadonlyMap<string, { url: string | null }>).get(sourceId)?.url;
    return (sources as Readonly<Record<string, { url: string | null }>>)[sourceId]?.url;
  }

  /** Calls of one method. */
  callsOf<M extends FakePlayerCall["method"]>(method: M): Extract<FakePlayerCall, { method: M }>[] {
    return this.calls.filter((c): c is Extract<FakePlayerCall, { method: M }> => c.method === method);
  }

  load(input: PlayerInput): void {
    const before = this.frame.position;
    this.input = input;
    this.calls.push({ method: "load", clips: input.clips.length });
    // Keep the source moment when it is still in the sequence, else the sequence time.
    let t = this.time;
    if (before && this.state) {
      let start = 0;
      for (const c of this.state.clips) {
        if (c.sourceId === before.sourceId && c.start <= before.at && before.at < c.end) {
          t = start + (before.at - c.start);
          break;
        }
        start += c.end - c.start;
      }
    }
    this.time = Math.max(0, Math.min(this.duration, t));
    this.lastErrorKey = null;
    this.emitFrame();
    this.reportMissingAddress();
  }

  async play(): Promise<void> {
    this.calls.push({ method: "play" });
    if (!this.playing) this.lastErrorKey = null;
    if (this.reportMissingAddress()) return;
    this.start(this.rate);
  }

  pause(): void {
    this.calls.push({ method: "pause" });
    this.stop();
  }

  async toggle(): Promise<void> {
    this.calls.push({ method: "toggle" });
    if (this.playing) return this.stop();
    this.lastErrorKey = null;
    if (this.reportMissingAddress()) return;
    this.start(this.rate);
  }

  async seek(t: SequenceTime): Promise<void> {
    this.calls.push({ method: "seek", t });
    this.time = Math.max(0, Math.min(this.duration, Math.round(t)));
    this.emitFrame();
    this.reportMissingAddress();
  }

  async step(amount: StepAmount): Promise<void> {
    this.calls.push({ method: "step", amount });
    this.playing = false;
    this.speed = 0;
    const rate = this.input?.frameRate ?? { num: 30, den: 1 };
    const t =
      "frames" in amount
        ? frameToMicros(microsToFrameFloor(this.time, rate) + amount.frames, rate)
        : this.time + amount.seconds * 1_000_000;
    this.time = Math.max(0, Math.min(this.duration, t));
    this.emitFrame();
  }

  setRate(rate: PlaybackRate): void {
    this.calls.push({ method: "setRate", rate });
    this.rate = rate;
    if (this.playing && this.speed > 0) this.speed = rate;
  }

  async shuttle(key: ShuttleKey): Promise<void> {
    this.calls.push({ method: "shuttle", key });
    if (key === "K") this.stop();
    else if (key === "L") this.start(this.playing && this.speed > 0 ? Math.min(4, this.speed * 2) : 1);
    else this.start(this.playing && this.speed < 0 ? Math.max(-4, this.speed * 2) : -1);
  }

  async previewCut(at: SequenceTime): Promise<void> {
    this.calls.push({ method: "previewCut", at });
    this.time = Math.max(0, at - 2_000_000);
    this.stopAt = Math.min(this.duration, at + 2_000_000);
    this.start(this.rate);
  }

  /** Plays on for `ms` of wall time (at the current speed), reporting one frame; stops at the end. */
  advance(ms: number): void {
    if (!this.playing) return;
    const end = this.stopAt ?? this.duration;
    let t = this.time + Math.round(ms * 1000 * this.speed);
    let ended = false;
    if (t >= end) {
      t = end;
      ended = true;
    }
    this.time = Math.max(0, t);
    if (ended || this.time === 0) {
      this.playing = false;
      this.speed = 0;
      this.stopAt = null;
    }
    this.emitFrame();
    if (ended) this.emit({ type: "ended" });
  }

  /** Sends an event as if the real player had (an error, buffering). */
  emit(e: PlayerEvent): void {
    for (const l of [...this.listeners]) l(e);
  }

  private get state(): EditState | null {
    return this.input ? { clips: [...this.input.clips], dismissed: [] } : null;
  }

  private start(speed: number): void {
    if (!this.state || this.state.clips.length === 0) return;
    if (speed > 0 && this.time >= this.duration) this.time = 0;
    this.playing = true;
    this.speed = speed;
    this.emitFrame();
  }

  private stop(): void {
    this.playing = false;
    this.speed = 0;
    this.stopAt = null;
    this.emitFrame();
  }

  /**
   * As the real player does (Player.showAt): a position inside a clip whose source has no
   * playback address reports no_address, once per load or press of play. True when reported.
   */
  private reportMissingAddress(): boolean {
    const pos = this.frame.position;
    if (!pos || this.urlOf(pos.sourceId)) return false;
    const key = `no_address:${pos.sourceId}`;
    if (key === this.lastErrorKey) return true;
    this.lastErrorKey = key;
    this.emit({ type: "error", error: { code: "no_address", sourceId: pos.sourceId, message: "this source has no playable video yet" } });
    return true;
  }

  private emitFrame(): void {
    this.emit({ type: "frame", frame: this.frame });
  }

  /** The clip playing now (for assertions). */
  get currentClipId(): string | null {
    return this.state ? clipAt(this.state, this.time)?.clip.id ?? null : null;
  }
}

/** A store on a fresh stand-in core and a `FakePlayer`, for tests. */
export interface TestRig {
  store: RoughcutStore;
  core: StandinCore;
  player: FakePlayer;
}

/** Builds a test rig. Core options and store options can be overridden. */
export function createTestRig(
  coreOptions: StandinOptions = {},
  storeOptions: Partial<Omit<StoreOptions, "core" | "player">> = {},
): TestRig {
  const core = createStandinCore(coreOptions);
  const player = new FakePlayer();
  const store = createRoughcutStore({ core, player, ...storeOptions });
  return { store, core, player };
}

/** The keydown event init for a canonical chord ("Ctrl+Shift+Z", "Shift+/", "Space", ","). */
export function keyEventInit(chord: string): KeyboardEventInit {
  const parts = chord === "+" ? ["+"] : chord.split("+");
  let key = parts[parts.length - 1] ?? "";
  if (chord.endsWith("++")) key = "+";
  const mods = new Set(parts.slice(0, -1));
  if (key === "Space") key = " ";
  else if (key.length === 1) key = key.toLowerCase();
  return {
    key,
    ctrlKey: mods.has("Ctrl"),
    altKey: mods.has("Alt"),
    shiftKey: mods.has("Shift"),
    bubbles: true,
    cancelable: true,
  };
}

/** Sends one keydown for `chord` to `target` (default: `window`), as a keyboard would. */
export function pressKey(chord: string, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent("keydown", keyEventInit(chord));
  target.dispatchEvent(event);
  return event;
}
