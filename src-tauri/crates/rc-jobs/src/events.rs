//! What the runner publishes (spec 3.5.5) and the sink the caller supplies to receive it.

use rc_types::{
    ExportResult, JobStatus, SourceAssets, SuggestionSet, SuggestionsUnavailablePayload,
    TranscriptAppendedPayload, TranscriptCompletedPayload, events,
};

/// One core-to-interface event produced by a job. The app forwards it as
/// `emit(event.name(), event.payload_json())`.
#[derive(Debug, Clone, PartialEq)]
pub enum JobEvent {
    /// `job_updated`: a job was queued, made progress, finished, failed or was cancelled.
    JobUpdated(JobStatus),
    /// `source_assets_changed`: what is ready for a source changed.
    SourceAssetsChanged(SourceAssets),
    /// `transcript_appended`: the transcriber finished a stretch of speech.
    TranscriptAppended(TranscriptAppendedPayload),
    /// `transcript_completed`: the whole source is transcribed (and cached).
    TranscriptCompleted(TranscriptCompletedPayload),
    /// `suggestions_ready`: dead air was found, and again when Claude answered.
    SuggestionsReady(SuggestionSet),
    /// `suggestions_unavailable`: the Claude step failed; dead air (if any) still stands.
    SuggestionsUnavailable(SuggestionsUnavailablePayload),
    /// `export_finished`: the exported file is complete at its destination.
    ExportFinished(ExportResult),
}

impl JobEvent {
    /// The event name of spec 3.5.5 (the `rc_types::events` constant).
    pub fn name(&self) -> &'static str {
        match self {
            JobEvent::JobUpdated(_) => events::JOB_UPDATED,
            JobEvent::SourceAssetsChanged(_) => events::SOURCE_ASSETS_CHANGED,
            JobEvent::TranscriptAppended(_) => events::TRANSCRIPT_APPENDED,
            JobEvent::TranscriptCompleted(_) => events::TRANSCRIPT_COMPLETED,
            JobEvent::SuggestionsReady(_) => events::SUGGESTIONS_READY,
            JobEvent::SuggestionsUnavailable(_) => events::SUGGESTIONS_UNAVAILABLE,
            JobEvent::ExportFinished(_) => events::EXPORT_FINISHED,
        }
    }

    /// The payload as camelCase JSON, exactly the shape `EventPayloads[name]` has in TypeScript.
    pub fn payload_json(&self) -> serde_json::Value {
        let v = match self {
            JobEvent::JobUpdated(p) => serde_json::to_value(p),
            JobEvent::SourceAssetsChanged(p) => serde_json::to_value(p),
            JobEvent::TranscriptAppended(p) => serde_json::to_value(p),
            JobEvent::TranscriptCompleted(p) => serde_json::to_value(p),
            JobEvent::SuggestionsReady(p) => serde_json::to_value(p),
            JobEvent::SuggestionsUnavailable(p) => serde_json::to_value(p),
            JobEvent::ExportFinished(p) => serde_json::to_value(p),
        };
        v.unwrap_or(serde_json::Value::Null)
    }
}

/// Receives every event the runner publishes, in order.
///
/// `publish` is called while the runner holds its internal lock (this is what guarantees
/// that nothing from a job is published after its `cancelled` status). It must therefore
/// return quickly and must not call back into the `JobRunner`; the Tauri adapter only
/// calls `AppHandle::emit`.
pub trait EventSink: Send + Sync + 'static {
    /// Deliver one event.
    fn publish(&self, event: JobEvent);
}

impl<F> EventSink for F
where
    F: Fn(JobEvent) + Send + Sync + 'static,
{
    fn publish(&self, event: JobEvent) {
        self(event)
    }
}
