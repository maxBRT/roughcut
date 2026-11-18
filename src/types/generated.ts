// GENERATED FILE - DO NOT EDIT.
// Source: src-tauri/crates/rc-types (Rust). Regenerate with `npm run gen:types`.
// Types follow spec section 3.4; event names and payloads follow spec section 3.5.5.

/** Whole microseconds. A position in a source file unless the type says otherwise. */
export type Micros = number;
/** A position in the edited sequence, not in a source. */
export type SequenceTime = Micros;

export type ProjectId = string;
/** The source's fingerprint (spec 2.4.9). */
export type SourceId = string;
export type ClipId = string;
export type SuggestionId = string;
export type JobId = string;
/** One per row of spec 1.10, e.g. 'timeline.split'. */
export type ActionId = string;

export type BitDepth = 8 | 10;
export type PlaybackRate = 1 | 1.5 | 2;

// ---- Basics ----

/**
 * A frame rate, e.g. 30000 / 1001.
 */
export type Rational = { num: number, den: number, };

/**
 * A stretch of one source. `start` is included, `end` is not.
 */
export type SourceRange = { sourceId: SourceId, start: Micros, end: Micros, };

export type SourcePosition = { sourceId: SourceId, at: Micros, };

// ---- The project file ----

export type Project = { schemaVersion: number, id: ProjectId, name: string, 
/**
 * ISO 8601
 */
createdAt: string, updatedAt: string, 
/**
 * The sequence's frame grid, taken from the first source. Frame k starts at
 * round_half_up(k * 1e6 * den / num) microseconds: see `rc_types::grid` and its twin
 * src/types/grid.ts, which every module uses to snap times.
 */
frameRate: Rational, sources: Array<SourceRef>, edit: EditDocument, session: SessionState, lastExport?: ExportResult, };

export type SourceRef = { id: SourceId, 
/**
 * Last known location of the file.
 */
path: string, addedAt: string, 
/**
 * Copy of the probe result, so a project opens even when the file is missing.
 */
media: MediaInfo, };

export type MediaInfo = { duration: Micros, container: string, video: VideoInfo, audioTracks: Array<AudioTrackInfo>, 
/**
 * Which audio track the transcript is made from.
 */
speechTrack: number, 
/**
 * Whether the player can use the original before the proxy exists.
 */
directPlayable: boolean, };

export type VideoInfo = { 
/**
 * 'h264', 'hevc', ...
 */
codec: string, width: number, height: number, frameRate: Rational, variableFrameRate: boolean, bitDepth: BitDepth, hdr: boolean, };

export type AudioTrackInfo = { index: number, codec: string, channels: number, sampleRate: number, title?: string, };

export type EditDocument = { current: EditState, 
/**
 * Oldest first.
 */
undo: Array<EditState>, redo: Array<EditState>, };

export type EditState = { 
/**
 * The sequence, in playing order.
 */
clips: Array<Clip>, 
/**
 * Suggestions you chose to keep.
 */
dismissed: Array<SourceRange>, };

/**
 * A kept stretch of one source: `start` is included, `end` is not. Never empty, and both
 * edges on the sequence's frame grid (spec 3.4 rule 1).
 *
 * The one clip per source that `create_project` makes is `[0, floorToFrame(media.duration,
 * frameRate))`: the duration floored to the grid (`first_clip_end`), so it never runs past
 * the end of the file. A source shorter than one frame gets no clip.
 */
export type Clip = { id: ClipId, sourceId: SourceId, start: Micros, end: Micros, };

/**
 * Where you were, restored on reopening.
 */
export type SessionState = { view: "transcript" | "timeline", playhead: SourcePosition | null, playbackRate: PlaybackRate, cutTextHidden: boolean, };

/**
 * `SessionState.view`: `'transcript' | 'timeline'`.
 */
export type SessionView = "transcript" | "timeline";

/**
 * One row of the Home screen.
 */
export type ProjectSummary = { id: ProjectId, name: string, rawDuration: Micros, keptDuration: Micros, updatedAt: string, lastExportedAt?: string, missingSources: number, };

// ---- The cache, per source ----

export type Transcript = { schemaVersion: number, sourceId: SourceId, 
/**
 * Name and version of the speech model that made it.
 */
model: string, complete: boolean, utterances: Array<Utterance>, };

/**
 * One paragraph in the Transcript view.
 */
export type Utterance = { 
/**
 * The number Claude uses to refer to it.
 */
index: number, start: Micros, end: Micros, tokens: Array<Token>, };

/**
 * The fields shared by every token.
 */
export type TokenBase = { start: Micros, end: Micros, 
/**
 * Where a cut between the previous token and this one lands (spec 2.4.5).
 */
cutBefore: Micros, };

/** `WordToken | PauseToken | UnrecognisedToken`, tagged by `kind`. */
export type Token = WordToken | PauseToken | UnrecognisedToken;

export type WordToken = TokenBase & { kind: "word"; text: string };

/** The pause chip. */
export type PauseToken = TokenBase & { kind: "pause" };

/** Speech with no words. */
export type UnrecognisedToken = TokenBase & { kind: "unrecognised" };

export type SuggestionSet = { schemaVersion: number, sourceId: SourceId, 
/**
 * Absent when only dead air was found.
 */
claudeModel?: string, suggestions: Array<Suggestion>, };

export type Suggestion = { id: SuggestionId, kind: "retake" | "false_start" | "aside" | "dead_air", origin: "claude" | "local", 
/**
 * What accepting it cuts.
 */
range: SourceRange, 
/**
 * The one line shown under the block.
 */
reason: string, 
/**
 * Retakes only: where the version to keep starts.
 */
keptVersionAt?: Micros, };

/**
 * `Suggestion.kind`.
 */
export type SuggestionKind = "retake" | "false_start" | "aside" | "dead_air";

/**
 * `Suggestion.origin`.
 */
export type SuggestionOrigin = "claude" | "local";

/**
 * Followed in the same file by `count` loudness values. File layout: this header as compact
 * UTF-8 JSON ending in one line feed (0x0A), then exactly `count` bytes, each a u8 peak
 * loudness on a linear scale (0 = silence, 255 = full scale); value i covers
 * [i / valuesPerSecond, (i + 1) / valuesPerSecond) seconds. Served as
 * application/octet-stream. Written by `rc_types::write_waveform`, read by
 * `parseWaveform` (src/types/waveform.ts).
 */
export type WaveformHeader = { sourceId: SourceId, valuesPerSecond: number, count: number, };

// ---- Runtime only (never saved) ----

export type JobKind = "probe" | "proxy" | "waveform" | "audio" | "transcribe" | "suggest" | "export" | "model_download";

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export type JobStatus = { id: JobId, kind: JobKind, sourceId?: SourceId, projectId?: ProjectId, state: JobState, 
/**
 * 0 to 1.
 */
progress: number, secondsLeft?: number, error?: AppError, };

/**
 * What is ready for one source, as the interface sees it.
 */
export type SourceAssets = { sourceId: SourceId, 
/**
 * The original file is where the project expects it.
 */
online: boolean, playback: "none" | "original" | "proxy", 
/**
 * The address the player loads, ready to use: `<video src>` takes it verbatim.
 * Built by the core with `media_url` as
 * `http://127.0.0.1:{port}/media/{sourceId}/{proxy|original}?token={token}` (the item
 * matches `playback`). The interface never edits it and never adds headers: the
 * per-launch token travels in the `token` query parameter (spec 3.5.6). Null when
 * `playback` is `'none'`.
 */
playbackUrl: string | null, 
/**
 * The waveform file's address, ready to use with `fetch` as is:
 * `http://127.0.0.1:{port}/media/{sourceId}/waveform?token={token}`. The body is
 * `application/octet-stream` in the layout of `WaveformHeader` (read it with
 * `parseWaveform`). Null until the waveform is ready.
 */
waveformUrl: string | null, transcript: "none" | "partial" | "complete", suggestions: "none" | "working" | "ready" | "unavailable", };

/**
 * One of the files the media server serves for a source (spec 3.5.6): the last path
 * segment of `/media/{sourceId}/{item}`.
 *
 * The media server contract, which the core's `server` and the interface rely on:
 * - It listens on `http://127.0.0.1:{port}` only, on a port chosen at launch.
 * - Every request carries the per-launch token in the `token` query parameter
 *   (`MEDIA_TOKEN_PARAM`); a missing or wrong token gets 401, an unknown source or an item
 *   that is not ready gets 404. No header is needed or read for the token, because
 *   `<video src>` cannot send one.
 * - Every response, including 401 and 404 and the answer to a CORS preflight, carries
 *   `Access-Control-Allow-Origin: *` (the token is the guard), so that `fetch` works from
 *   the app's origin (`http://tauri.localhost`) and from the dev server
 *   (`http://localhost:1420`).
 * - `proxy` and `original` support byte ranges; `proxy` is `video/mp4`; `waveform` is
 *   `application/octet-stream` (layout: `WaveformHeader`).
 *
 * The core builds every address with `media_url` (TypeScript twin: `mediaUrl`) and the
 * interface uses them verbatim.
 */
export type MediaItem = "proxy" | "original" | "waveform";

/**
 * `SourceAssets.playback`: `'none' | 'original' | 'proxy'`.
 */
export type PlaybackSource = "none" | "original" | "proxy";

/**
 * `SourceAssets.transcript`: `'none' | 'partial' | 'complete'`.
 */
export type TranscriptProgress = "none" | "partial" | "complete";

/**
 * `SourceAssets.suggestions`: `'none' | 'working' | 'ready' | 'unavailable'`.
 */
export type SuggestionsProgress = "none" | "working" | "ready" | "unavailable";

export type ExportRequest = { projectId: ProjectId, clips: Array<Clip>, folder: string, fileName: string, };

/**
 * What the Export dialog shows before you confirm.
 */
export type ExportPlan = { duration: Micros, format: OutputFormat, estimatedBytes: number, estimatedSeconds: number, freeBytes: number, 
/**
 * E.g. "sources differ; the export follows the first clip".
 */
notices: Array<string>, 
/**
 * Nothing to export, not enough disk space, a source is missing.
 */
blockedBy?: AppError, 
/**
 * Bytes of free space the export needs on the destination's drive (the finished file,
 * plus the temporary pieces when they are on the same drive), so the dialog can show
 * the amount needed. Added after spec 3.4; absent when it could not be worked out.
 */
requiredBytes?: number, };

export type OutputFormat = { codec: "h264" | "hevc", width: number, height: number, frameRate: Rational, bitDepth: BitDepth, hdr: boolean, audioTracks: number, };

/**
 * `OutputFormat.codec`: `'h264' | 'hevc'`.
 */
export type OutputCodec = "h264" | "hevc";

export type ExportResult = { path: string, duration: Micros, bytes: number, tookSeconds: number, finishedAt: string, };

export type ClaudeStatus = { installed: boolean, version?: string, 
/**
 * False when Claude Code has changed since the app was last checked against it.
 */
versionTested: boolean, signedIn: boolean, authMethod?: string, };

/**
 * The error every core command and failed job reports.
 */
export type AppError = { code: ErrorCode, message: string, detail?: string, };

export type ErrorCode = "source_missing" | "source_unreadable" | "source_mismatch" | "disk_full" | "nothing_to_export" | "export_failed" | "gpu_unavailable" | "transcriber_failed" | "claude_missing" | "claude_signed_out" | "claude_limit" | "claude_offline" | "claude_bad_answer" | "cancelled" | "internal";

// ---- Settings ----

export type Settings = { schemaVersion: number, exportFolder: string, 
/**
 * Only those changed from the defaults.
 */
keyBindings: Array<KeyBinding>, speechModel: string, speechDevice: "auto" | "gpu" | "cpu", 
/**
 * `'opus'` by default.
 */
claudeModel: string, claudeAuth: "subscription" | "api_key", claudeCodeVersionTested: string, cacheLimitBytes: number, };

/**
 * `Settings.speechDevice`: `'auto' | 'gpu' | 'cpu'`.
 */
export type SpeechDevice = "auto" | "gpu" | "cpu";

/**
 * `Settings.claudeAuth`: `'subscription' | 'api_key'`.
 */
export type ClaudeAuth = "subscription" | "api_key";

export type KeyContext = "everywhere" | "home" | "transcript" | "timeline" | "export";

export type KeyBinding = { action: ActionId, context: KeyContext, chord: string, };

// ---- Command results (spec 3.5.4) ----

/**
 * Result of `open_project`: the project and a `SourceAssets` per source.
 */
export type OpenedProject = { project: Project, assets: Array<SourceAssets>, };

/**
 * Result of `cache_usage`: bytes used, limit.
 */
export type CacheUsage = { usedBytes: number, limitBytes: number, };

// ---- Core-to-interface events (spec 3.5.5) ----

/**
 * `transcript_appended`: source id, new `Utterance[]`.
 */
export type TranscriptAppendedPayload = { sourceId: SourceId, utterances: Array<Utterance>, };

/**
 * `transcript_completed`: source id.
 */
export type TranscriptCompletedPayload = { sourceId: SourceId, };

/**
 * `suggestions_unavailable`: source id, `AppError`.
 */
export type SuggestionsUnavailablePayload = { sourceId: SourceId, error: AppError, };

export type JobUpdatedPayload = JobStatus;
export type SourceAssetsChangedPayload = SourceAssets;
export type SuggestionsReadyPayload = SuggestionSet;
export type ExportFinishedPayload = ExportResult;

/** Event names, as emitted by the core. */
export const EVENTS = {
  jobUpdated: "job_updated",
  sourceAssetsChanged: "source_assets_changed",
  transcriptAppended: "transcript_appended",
  transcriptCompleted: "transcript_completed",
  suggestionsReady: "suggestions_ready",
  suggestionsUnavailable: "suggestions_unavailable",
  exportFinished: "export_finished",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/** The payload carried by each event. */
export interface EventPayloads {
  job_updated: JobUpdatedPayload;
  source_assets_changed: SourceAssetsChangedPayload;
  transcript_appended: TranscriptAppendedPayload;
  transcript_completed: TranscriptCompletedPayload;
  suggestions_ready: SuggestionsReadyPayload;
  suggestions_unavailable: SuggestionsUnavailablePayload;
  export_finished: ExportFinishedPayload;
}
