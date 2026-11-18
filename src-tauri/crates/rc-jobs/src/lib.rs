//! Roughcut core module `jobs` (the job runner).
//!
//! Responsibility (spec 3.3): queues, runs, reports and cancels all long work. Decides order
//! and what may run at once. Skips work whose result is already cached.
//!
//! - [`JobRunner`]: the runner. `import` (the per-source pipeline of spec 2.4.10 / 2.5),
//!   `retry_suggestions`, `start_export`, `spawn` (any other long work), `list`, `cancel`,
//!   `wait`, `shutdown`, plus the per-source `SourceAssets` it keeps.
//! - [`EventSink`] / [`JobEvent`]: everything the runner publishes (spec 3.5.5).
//! - Ports ([`MediaPort`], [`SpeechPort`], [`SuggestPort`], [`CachePort`]): how it reaches
//!   `media`, `speech`, `suggest` and `cache` without depending on those crates. The app
//!   supplies adapters.
//!
//! Guarantees: a job publishes nothing after its final status (done, failed, cancelled);
//! cancelling tells the work to stop and waits for nothing; at most `Limits` jobs of each
//! [`ResourceClass`] run at once; a failed step fails only what depends on it.

mod events;
mod export;
mod import;
mod ports;
mod runner;

pub use events::{EventSink, JobEvent};
pub use import::{SourceInput, UtteranceSink};
pub use ports::{
    AUDIO_CHANNEL_CHUNKS, AudioChunk, AudioSender, AudioStream, BoxFuture, CacheItem, CachePort,
    ClaudeAnswer, ExportInput, MediaPort, Ports, SpeechPort, SuggestPort,
};
pub use runner::{JobHandle, JobRunner, JobSpec, Limits, Progress, ResourceClass, RunnerConfig};

/// Re-exported so adapters and callers use the same cancellation type.
pub use tokio_util::sync::CancellationToken;
