/**
 * `player`: plays a sequence from the proxy or the original, skips cuts, reports the current time (spec 3.3, 3.5.3). May use: `edit` (queries only).
 *
 * Stand-ins for tests (fake clock, video elements, audio) are in `./testing`.
 */
export { Player, PREVIEW_MARGIN_US, SHUTTLE_SPEEDS } from "./Player";
export type { PlayerOptions } from "./Player";
export { PlayerView } from "./PlayerView";
export type { PlayerViewProps } from "./PlayerView";
export type {
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
export type { AudioOut, Clock, FrameMetadata, PlayerEnvironment, VideoLike } from "./env";
export { browserClock, browserEnvironment, VolumeAudioOut, WebAudioOut } from "./env";
