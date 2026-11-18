//! The export job (spec 2.4.8, 3.6 "Exporting"): one GPU-encode slot, progress, cancel,
//! then `export_finished`.

use std::sync::Arc;

use rc_types::{JobId, JobKind};

use crate::events::JobEvent;
use crate::ports::ExportInput;
use crate::runner::{JobRunner, JobSpec, Outcome, ResourceClass};

impl JobRunner {
    /// Queue an export (`start_export`). It waits for the GPU-encode slot (one at a time,
    /// shared with proxies), reports progress, and on success publishes `export_finished`
    /// before its `done` status. Cancelling it leaves nothing at the destination (the media
    /// port's duty) and publishes nothing after `cancelled`.
    pub fn start_export(&self, input: ExportInput) -> JobId {
        let spec = JobSpec {
            kind: JobKind::Export,
            class: ResourceClass::GpuEncode,
            source_id: None,
            project_id: Some(input.request.project_id.clone()),
        };
        let h = self.inner.create_job(&spec);
        let id = h.id.clone();
        let inner = Arc::clone(&self.inner);
        let end = h.end_guard();
        self.inner.spawn_task(async move {
            let _end = end;
            let Some(_slot) = inner.acquire(&h).await else { return };
            inner.set_running(&[&h]);
            let work = inner.ports.media.run_export(&input, h.progress(), h.cancel_token());
            if let Outcome::Done(result) = h.run(work).await {
                h.complete_with(|_| vec![JobEvent::ExportFinished(result)]);
            }
        });
        id
    }
}
