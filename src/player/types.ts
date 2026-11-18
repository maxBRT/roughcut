/**
 * Public types of the player (spec 3.5.3): what `load` takes and what the player reports.
 */
import type { Clip, Micros, Rational, SequenceTime, SourceId, SourcePosition } from "../types";

/** The playback rates the app offers (spec 1.10: keys 1, 2, 3). */
export type PlaybackRate = 1 | 1.5 | 2;

/** One source as the player needs it. */
export interface PlayerSource {
  /** `SourceAssets.playbackUrl`, used verbatim; null while nothing is playable yet. */
  url: string | null;
  /** The probed duration of the file. */
  duration: Micros;
}

/** Everything `load` takes. Calling `load` again keeps the position (see `Player.load`). */
export interface PlayerInput {
  /** The sequence, in playing order (`EditState.clips`). Edges are on the frame grid. */
  clips: readonly Clip[];
  /** Playback address and duration of each source, by id. A source missing here has no address. */
  sources: ReadonlyMap<SourceId, PlayerSource> | Readonly<Record<SourceId, PlayerSource>>;
  /** The sequence frame rate (`Project.frameRate`). */
  frameRate: Rational;
}

/** What is on screen, reported on every displayed frame and after every seek or load. */
export interface PlayerFrame {
  /** Position in the sequence: the start of the frame shown. */
  time: SequenceTime;
  /** The source moment shown (frame start); null when the sequence is empty. */
  position: SourcePosition | null;
  /** True while playing forwards or shuttling backwards. */
  playing: boolean;
  /** Current speed: positive forwards, negative for silent backwards play, 0 when stopped. */
  speed: number;
}

/** Why the player reports an error. */
export type PlayerErrorCode =
  /** The clip at the position comes from a source with no playback address yet. */
  | "no_address"
  /** The video element could not load or decode the source. */
  | "media_error"
  /** The browser refused to start playback (for example autoplay without a gesture). */
  | "play_rejected";

/** An error the player reports; playback is paused when it happens. */
export interface PlayerError {
  code: PlayerErrorCode;
  sourceId: SourceId | null;
  message: string;
}

/** What subscribers receive. */
export type PlayerEvent =
  | { type: "frame"; frame: PlayerFrame }
  /** Playback reached the end of the sequence and stopped on its last frame. */
  | { type: "ended" }
  /** True while the player waits for media it needs now (a slow seek, a stalled stream). */
  | { type: "buffering"; buffering: boolean }
  | { type: "error"; error: PlayerError };

/** A step for `Player.step`: whole frames or seconds, negative for backwards. */
export type StepAmount = { frames: number } | { seconds: number };

/** The `J` `K` `L` keys. */
export type ShuttleKey = "J" | "K" | "L";
