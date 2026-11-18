//! Core-to-interface events (spec 3.5.5): their names and payloads.
//!
//! The core emits each event with the name below and the payload type next to it.
//! The TypeScript side gets the same names as `EVENTS` and the map `EventPayloads`
//! in `src/types/generated.ts`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::basics::*;
use crate::cache::{SuggestionSet, Utterance};
use crate::runtime::{AppError, ExportResult, JobStatus, SourceAssets};

/// Payload: [`JobUpdatedPayload`] (= `JobStatus`). A job is queued, makes progress, finishes, fails or is cancelled.
pub const JOB_UPDATED: &str = "job_updated";
/// Payload: [`SourceAssetsChangedPayload`] (= `SourceAssets`). The proxy or waveform becomes ready, or a source goes missing or is found.
pub const SOURCE_ASSETS_CHANGED: &str = "source_assets_changed";
/// Payload: [`TranscriptAppendedPayload`]. The transcriber finishes a stretch of speech.
pub const TRANSCRIPT_APPENDED: &str = "transcript_appended";
/// Payload: [`TranscriptCompletedPayload`]. The whole source is transcribed.
pub const TRANSCRIPT_COMPLETED: &str = "transcript_completed";
/// Payload: [`SuggestionsReadyPayload`] (= `SuggestionSet`). Dead air has been found, and again when Claude has answered.
pub const SUGGESTIONS_READY: &str = "suggestions_ready";
/// Payload: [`SuggestionsUnavailablePayload`]. Claude is signed out, over its limit, offline or gave an unusable answer.
pub const SUGGESTIONS_UNAVAILABLE: &str = "suggestions_unavailable";
/// Payload: [`ExportFinishedPayload`] (= `ExportResult`). The exported file is complete at its destination.
pub const EXPORT_FINISHED: &str = "export_finished";

/// Every event name, in spec order.
pub const ALL_EVENTS: [&str; 7] = [
    JOB_UPDATED,
    SOURCE_ASSETS_CHANGED,
    TRANSCRIPT_APPENDED,
    TRANSCRIPT_COMPLETED,
    SUGGESTIONS_READY,
    SUGGESTIONS_UNAVAILABLE,
    EXPORT_FINISHED,
];

pub type JobUpdatedPayload = JobStatus;
pub type SourceAssetsChangedPayload = SourceAssets;
pub type SuggestionsReadyPayload = SuggestionSet;
pub type ExportFinishedPayload = ExportResult;

/// `transcript_appended`: source id, new `Utterance[]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptAppendedPayload {
    #[ts(type = "SourceId")]
    pub source_id: SourceId,
    pub utterances: Vec<Utterance>,
}

/// `transcript_completed`: source id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptCompletedPayload {
    #[ts(type = "SourceId")]
    pub source_id: SourceId,
}

/// `suggestions_unavailable`: source id, `AppError`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionsUnavailablePayload {
    #[ts(type = "SourceId")]
    pub source_id: SourceId,
    pub error: AppError,
}
