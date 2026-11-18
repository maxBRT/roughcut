//! Runtime only, never saved (spec 3.4 "Runtime only").

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::basics::*;
use crate::project::Clip;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    Probe,
    Proxy,
    Waveform,
    Audio,
    Transcribe,
    Suggest,
    Export,
    /// Downloading the speech model on first run (added after spec 3.4; the interface
    /// shows it like any other job).
    ModelDownload,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    #[ts(type = "JobId")]
    pub id: JobId,
    pub kind: JobKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "SourceId")]
    pub source_id: Option<SourceId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "ProjectId")]
    pub project_id: Option<ProjectId>,
    pub state: JobState,
    /// 0 to 1.
    pub progress: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub seconds_left: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<AppError>,
}

/// What is ready for one source, as the interface sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SourceAssets {
    #[ts(type = "SourceId")]
    pub source_id: SourceId,
    /// The original file is where the project expects it.
    pub online: bool,
    #[ts(inline)]
    pub playback: PlaybackSource,
    /// The address the player loads, ready to use: `<video src>` takes it verbatim.
    /// Built by the core with `media_url` as
    /// `http://127.0.0.1:{port}/media/{sourceId}/{proxy|original}?token={token}` (the item
    /// matches `playback`). The interface never edits it and never adds headers: the
    /// per-launch token travels in the `token` query parameter (spec 3.5.6). Null when
    /// `playback` is `'none'`.
    pub playback_url: Option<String>,
    /// The waveform file's address, ready to use with `fetch` as is:
    /// `http://127.0.0.1:{port}/media/{sourceId}/waveform?token={token}`. The body is
    /// `application/octet-stream` in the layout of `WaveformHeader` (read it with
    /// `parseWaveform`). Null until the waveform is ready.
    pub waveform_url: Option<String>,
    #[ts(inline)]
    pub transcript: TranscriptProgress,
    #[ts(inline)]
    pub suggestions: SuggestionsProgress,
}

/// One of the files the media server serves for a source (spec 3.5.6): the last path
/// segment of `/media/{sourceId}/{item}`.
///
/// The media server contract, which the core's `server` and the interface rely on:
/// - It listens on `http://127.0.0.1:{port}` only, on a port chosen at launch.
/// - Every request carries the per-launch token in the `token` query parameter
///   (`MEDIA_TOKEN_PARAM`); a missing or wrong token gets 401, an unknown source or an item
///   that is not ready gets 404. No header is needed or read for the token, because
///   `<video src>` cannot send one.
/// - Every response, including 401 and 404 and the answer to a CORS preflight, carries
///   `Access-Control-Allow-Origin: *` (the token is the guard), so that `fetch` works from
///   the app's origin (`http://tauri.localhost`) and from the dev server
///   (`http://localhost:1420`).
/// - `proxy` and `original` support byte ranges; `proxy` is `video/mp4`; `waveform` is
///   `application/octet-stream` (layout: `WaveformHeader`).
///
/// The core builds every address with `media_url` (TypeScript twin: `mediaUrl`) and the
/// interface uses them verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MediaItem {
    Proxy,
    Original,
    Waveform,
}

impl MediaItem {
    /// The path segment, e.g. `"proxy"`.
    pub fn as_str(self) -> &'static str {
        match self {
            MediaItem::Proxy => "proxy",
            MediaItem::Original => "original",
            MediaItem::Waveform => "waveform",
        }
    }

    /// The item for a path segment.
    pub fn parse(segment: &str) -> Option<MediaItem> {
        match segment {
            "proxy" => Some(MediaItem::Proxy),
            "original" => Some(MediaItem::Original),
            "waveform" => Some(MediaItem::Waveform),
            _ => None,
        }
    }
}

/// The query parameter that carries the media server's per-launch token.
pub const MEDIA_TOKEN_PARAM: &str = "token";

/// The complete address of one media item:
/// `{base}/media/{sourceId}/{item}?token={token}`, where `base` is the server's origin,
/// e.g. `http://127.0.0.1:51234` (a trailing `/` is ignored). `sourceId` and `token` are
/// percent-encoded (every byte except `A-Z a-z 0-9 - . _ ~`). The interface's twin is
/// `mediaUrl` in `src/types/media.ts`.
pub fn media_url(base: &str, token: &str, source_id: &str, item: MediaItem) -> String {
    format!(
        "{}/media/{}/{}?{}={}",
        base.trim_end_matches('/'),
        percent_encode(source_id),
        item.as_str(),
        MEDIA_TOKEN_PARAM,
        percent_encode(token)
    )
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `SourceAssets.playback`: `'none' | 'original' | 'proxy'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackSource {
    None,
    Original,
    Proxy,
}

/// `SourceAssets.transcript`: `'none' | 'partial' | 'complete'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptProgress {
    None,
    Partial,
    Complete,
}

/// `SourceAssets.suggestions`: `'none' | 'working' | 'ready' | 'unavailable'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionsProgress {
    None,
    Working,
    Ready,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    #[ts(type = "ProjectId")]
    pub project_id: ProjectId,
    pub clips: Vec<Clip>,
    pub folder: String,
    pub file_name: String,
}

/// What the Export dialog shows before you confirm.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    #[ts(type = "Micros")]
    pub duration: Micros,
    pub format: OutputFormat,
    pub estimated_bytes: u64,
    pub estimated_seconds: f64,
    pub free_bytes: u64,
    /// E.g. "sources differ; the export follows the first clip".
    pub notices: Vec<String>,
    /// Nothing to export, not enough disk space, a source is missing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub blocked_by: Option<AppError>,
    /// Bytes of free space the export needs on the destination's drive (the finished file,
    /// plus the temporary pieces when they are on the same drive), so the dialog can show
    /// the amount needed. Added after spec 3.4; absent when it could not be worked out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub required_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OutputFormat {
    #[ts(inline)]
    pub codec: OutputCodec,
    pub width: u32,
    pub height: u32,
    pub frame_rate: Rational,
    #[ts(type = "BitDepth")]
    pub bit_depth: BitDepth,
    pub hdr: bool,
    pub audio_tracks: u32,
}

/// `OutputFormat.codec`: `'h264' | 'hevc'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum OutputCodec {
    H264,
    Hevc,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    #[ts(type = "Micros")]
    pub duration: Micros,
    pub bytes: u64,
    pub took_seconds: f64,
    pub finished_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    pub installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub version: Option<String>,
    /// False when Claude Code has changed since the app was last checked against it.
    pub version_tested: bool,
    pub signed_in: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub auth_method: Option<String>,
}

/// The error every core command and failed job reports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{code}: {message}")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        AppError { code, message: message.into(), detail: None }
    }
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
    pub fn internal(message: impl Into<String>) -> Self {
        AppError::new(ErrorCode::Internal, message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    SourceMissing,
    SourceUnreadable,
    SourceMismatch,
    DiskFull,
    NothingToExport,
    ExportFailed,
    GpuUnavailable,
    TranscriberFailed,
    ClaudeMissing,
    ClaudeSignedOut,
    ClaudeLimit,
    ClaudeOffline,
    ClaudeBadAnswer,
    Cancelled,
    Internal,
}

impl ErrorCode {
    /// The string used on the wire, e.g. `"source_missing"`.
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::SourceMissing => "source_missing",
            ErrorCode::SourceUnreadable => "source_unreadable",
            ErrorCode::SourceMismatch => "source_mismatch",
            ErrorCode::DiskFull => "disk_full",
            ErrorCode::NothingToExport => "nothing_to_export",
            ErrorCode::ExportFailed => "export_failed",
            ErrorCode::GpuUnavailable => "gpu_unavailable",
            ErrorCode::TranscriberFailed => "transcriber_failed",
            ErrorCode::ClaudeMissing => "claude_missing",
            ErrorCode::ClaudeSignedOut => "claude_signed_out",
            ErrorCode::ClaudeLimit => "claude_limit",
            ErrorCode::ClaudeOffline => "claude_offline",
            ErrorCode::ClaudeBadAnswer => "claude_bad_answer",
            ErrorCode::Cancelled => "cancelled",
            ErrorCode::Internal => "internal",
        }
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}
