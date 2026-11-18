//! The ports: the small traits through which the runner reaches `media`, `speech`, `suggest`
//! and `cache` (spec 3.3, 3.6). `rc-jobs` does not depend on those crates; the app writes one
//! adapter per trait.
//!
//! Rules every port method follows:
//! - It watches `cancel` and, once it fires, stops its process promptly, removes anything
//!   half-written, and returns (any `Err`; the runner ignores results of cancelled jobs).
//! - It reports progress only through the `Progress` it is given (calls after cancellation
//!   are dropped by the runner, so it does not need to check).
//! - It never starts work on its own: only the runner calls these (spec 3.6 rule 4).

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use rc_types::{
    AppError, ExportRequest, ExportResult, OutputFormat, SourceId, SourceRef, Suggestion,
    SuggestionSet, Transcript,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::import::UtteranceSink;
use crate::runner::Progress;

/// A boxed, sendable future: what every async port method returns (keeps the traits object safe).
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A piece of speech audio: raw PCM, signed 16-bit little-endian, 16 kHz, mono (spec 3.5.7).
pub type AudioChunk = Vec<u8>;
/// Where `extract_speech_audio` writes the audio as it is decoded. A failed `send` means the
/// transcriber has stopped; treat it as cancellation.
pub type AudioSender = mpsc::Sender<AudioChunk>;
/// What `transcribe` reads. It ends (`recv` returns `None`) when extraction has finished.
pub type AudioStream = mpsc::Receiver<AudioChunk>;
/// How many chunks may wait between extraction and transcription.
pub const AUDIO_CHANNEL_CHUNKS: usize = 64;

/// A cached file the runner checks before making it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CacheItem {
    /// The 720p proxy video.
    Proxy,
    /// The waveform file (`rc_types::write_waveform` layout).
    Waveform,
}

/// FFmpeg tasks (spec 3.5.9), implemented over `rc-media`.
pub trait MediaPort: Send + Sync + 'static {
    /// Make the proxy of `source` and leave it complete at `out` (write elsewhere, then move).
    fn make_proxy<'a>(
        &'a self,
        source: &'a SourceRef,
        out: PathBuf,
        progress: Progress,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<(), AppError>>;

    /// Decode the speech track of `source` to 16 kHz mono s16le and send it to `audio` as it
    /// is read. Return when the whole track has been sent (dropping `audio` ends the stream).
    fn extract_speech_audio<'a>(
        &'a self,
        source: &'a SourceRef,
        audio: AudioSender,
        progress: Progress,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<(), AppError>>;

    /// Make the waveform file of `source` and leave it complete at `out`.
    fn make_waveform<'a>(
        &'a self,
        source: &'a SourceRef,
        out: PathBuf,
        progress: Progress,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<(), AppError>>;

    /// Run a whole export (encode each clip, render audio, join, move into place). On
    /// cancellation or failure nothing may be left at the destination.
    fn run_export<'a>(
        &'a self,
        export: &'a ExportInput,
        progress: Progress,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<ExportResult, AppError>>;
}

/// The transcriber client, implemented over `rc-speech`.
pub trait SpeechPort: Send + Sync + 'static {
    /// Transcribe `audio` as it arrives. Call `batches.append` with each stretch of finished
    /// utterances (it returns false once the job is cancelled). When the stream ends, return
    /// the finished transcript (`complete: true`), containing every appended utterance.
    /// A transcriber crash is an `Err` with code `transcriber_failed`.
    fn transcribe<'a>(
        &'a self,
        source: &'a SourceRef,
        audio: AudioStream,
        batches: UtteranceSink,
        progress: Progress,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<Transcript, AppError>>;
}

/// Claude's answer for one source.
#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeAnswer {
    /// The model that answered; becomes `SuggestionSet.claudeModel`.
    pub model: String,
    /// Located suggestions, `origin: 'claude'`.
    pub suggestions: Vec<Suggestion>,
}

/// Suggestions, implemented over `rc-suggest`.
pub trait SuggestPort: Send + Sync + 'static {
    /// Dead air found locally (`kind: 'dead_air'`, `origin: 'local'`). Never needs Claude.
    fn dead_air<'a>(
        &'a self,
        source: &'a SourceRef,
        transcript: &'a Transcript,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<Vec<Suggestion>, AppError>>;

    /// One Claude call for the source. Errors carry the `claude_*` codes of spec 3.5.8.
    fn claude<'a>(
        &'a self,
        source: &'a SourceRef,
        transcript: &'a Transcript,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<ClaudeAnswer, AppError>>;

    /// The final list from the dead air and Claude's suggestions, in time order. The default
    /// puts both together; an adapter that knows how to resolve overlaps (rc-suggest's
    /// `merge_suggestions`) overrides it.
    fn merge(&self, dead_air: Vec<Suggestion>, claude: Vec<Suggestion>) -> Vec<Suggestion> {
        let mut all = dead_air;
        all.extend(claude);
        all.sort_by_key(|s| s.range.start);
        all
    }
}

/// The per-source cache, implemented over `rc-cache`. Calls are quick and synchronous.
pub trait CachePort: Send + Sync + 'static {
    /// Whether `item` is complete in the cache for `source`.
    fn is_ready(&self, source: &SourceId, item: CacheItem) -> bool;
    /// Where `item` for `source` goes (the cache chooses; spec 3.6 rule 5).
    fn path_for(&self, source: &SourceId, item: CacheItem) -> Result<PathBuf, AppError>;
    /// Record that `item` is now complete at `path_for`.
    fn mark_finished(&self, source: &SourceId, item: CacheItem) -> Result<(), AppError>;
    /// The cached transcript, if any and readable (complete or not).
    fn read_transcript(&self, source: &SourceId) -> Option<Transcript>;
    /// Save the finished transcript.
    fn write_transcript(&self, transcript: &Transcript) -> Result<(), AppError>;
    /// The cached suggestion set, if any and readable.
    fn read_suggestions(&self, source: &SourceId) -> Option<SuggestionSet>;
    /// Save a suggestion set (dead air alone, then dead air plus Claude).
    fn write_suggestions(&self, set: &SuggestionSet) -> Result<(), AppError>;
}

/// Everything an export needs, assembled by `api` from the project and `plan_export`.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportInput {
    /// What to export and where.
    pub request: ExportRequest,
    /// The output format `plan_export` chose.
    pub format: OutputFormat,
    /// Every source the clips use, with its current path.
    pub sources: Vec<SourceRef>,
}

/// The four ports, as handed to `JobRunner::new`.
#[derive(Clone)]
pub struct Ports {
    /// FFmpeg tasks (adapter over `rc-media`).
    pub media: Arc<dyn MediaPort>,
    /// Transcription (adapter over `rc-speech`).
    pub speech: Arc<dyn SpeechPort>,
    /// Dead air and Claude (adapter over `rc-suggest`).
    pub suggest: Arc<dyn SuggestPort>,
    /// The per-source cache (adapter over `rc-cache`).
    pub cache: Arc<dyn CachePort>,
}
