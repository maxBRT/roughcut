//! The core-to-interface events (spec 3.5.5).
//!
//! The core never calls the interface (spec 3.6 rule 6): everything the core reports leaves
//! through one [`rc_jobs::EventSink`], and this sink turns each event into a Tauri event to
//! every window. Names and payloads come from `rc_types::events` (through
//! [`rc_jobs::JobEvent::name`] and [`rc_jobs::JobEvent::payload_json`]), so they match
//! `EVENTS` / `EventPayloads` in `src/types`. Tests use a sink that collects the events.

use rc_jobs::{EventSink, JobEvent};
use tauri::{AppHandle, Emitter, Runtime};

/// Emits every core event to the interface.
pub struct TauriSink<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> TauriSink<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        TauriSink { app }
    }
}

impl<R: Runtime> EventSink for TauriSink<R> {
    fn publish(&self, event: JobEvent) {
        // Called under the job runner's lock: emitting only queues the message for the window.
        if let Err(e) = self.app.emit(event.name(), event.payload_json()) {
            eprintln!("roughcut: could not send {} to the interface: {e}", event.name());
        }
    }
}

#[cfg(test)]
mod tests {
    use rc_jobs::JobEvent;
    use rc_types::events::{EXPORT_FINISHED, JOB_UPDATED, TRANSCRIPT_COMPLETED};
    use rc_types::{ExportResult, JobKind, JobState, JobStatus, TranscriptCompletedPayload};

    #[test]
    fn events_carry_the_spec_names_and_camel_case_payloads() {
        let job = JobEvent::JobUpdated(JobStatus {
            id: "job-1".into(),
            kind: JobKind::ModelDownload,
            source_id: None,
            project_id: None,
            state: JobState::Running,
            progress: 0.5,
            seconds_left: Some(3.0),
            error: None,
        });
        assert_eq!(job.name(), JOB_UPDATED);
        let v = job.payload_json();
        assert_eq!(v["kind"], "model_download");
        assert_eq!(v["secondsLeft"], 3.0);
        assert!(v.get("sourceId").is_none());
        let done = JobEvent::TranscriptCompleted(TranscriptCompletedPayload { source_id: "s".into() });
        assert_eq!((done.name(), done.payload_json()["sourceId"].as_str()), (TRANSCRIPT_COMPLETED, Some("s")));
        let exported = JobEvent::ExportFinished(ExportResult {
            path: "C:/v/a.mp4".into(),
            duration: 1,
            bytes: 2,
            took_seconds: 3.0,
            finished_at: "2026-11-15T00:00:00.000Z".into(),
        });
        assert_eq!(exported.name(), EXPORT_FINISHED);
        assert_eq!(exported.payload_json()["tookSeconds"], 3.0);
    }
}
