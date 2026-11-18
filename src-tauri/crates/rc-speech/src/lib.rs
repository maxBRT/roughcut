//! Roughcut core module `speech` (transcriber client and transcript building).
//!
//! Responsibility (spec 3.3): starts the transcriber, feeds it audio, turns its output into the
//! saved transcript (tightened word ends, cut points, utterances, unrecognised blocks), and
//! keeps the speech model and its runtime installed in the app's data folder.
//!
//! Public surface:
//! - [`transcribe`]: run the transcriber over 16 kHz mono PCM and get the [`rc_types::Transcript`],
//!   with [`SpeechEvent`]s for readiness, progress and each batch of final utterances.
//! - [`TranscriptBuilder`]: the transcript building on its own, fed with protocol [`Message`]s
//!   and the [`LevelTrack`] (sound level) of the same audio; streaming and building
//!   afterwards give the same transcript.
//! - [`SpeechHome`] and the [`cpu_package`] / [`gpu_package`] definitions: where the model
//!   lives, whether it is installed, downloading it with resume, and the command to start
//!   the transcriber with.
//!
//! May use: `cache` (spec 3.3, 3.6). Shared data types come from `rc-types`.

mod builder;
mod client;
mod levels;
mod models;
mod protocol;

pub use builder::{BuildOptions, TranscriptBuilder};
pub use client::{transcribe, CancelToken, SpeechEvent, TranscribeJob, TranscriberCommand};
pub use levels::{LevelTrack, SAMPLE_RATE, WINDOW_MICROS};
pub use models::{
    cpu_package, gpu_package, model_only, nvidia_gpu_present, Download, DownloadPhase, DownloadProgress, LaunchPlan, Member,
    Package, PackageKind, SpeechHome, Unpack, MODEL_NAME,
};
pub use protocol::{DeviceUsed, Message, RangeMsg, WordMsg};
