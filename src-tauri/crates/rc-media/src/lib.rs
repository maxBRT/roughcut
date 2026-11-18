//! Roughcut core module `media` (every FFmpeg task).
//!
//! Responsibility (spec 3.3): One task per FFmpeg use: probe, proxy, audio for speech, waveform, encode one clip, render audio, join.
//!
//! Public surface: Media tasks (spec 3.5.9).
//! May use: `cache` (spec 3.3, 3.6). Shared data types come from `rc-types`.
//!
//! Modules (see README.md in this crate):
//! - [`tools`]: finding FFmpeg and ffprobe.
//! - [`process`]: the process runner every task uses (no console window, progress, cancel,
//!   error output for `AppError.detail`, children always reaped).
//! - [`probe`]: a file to `MediaInfo`.
//! - [`proxy`]: the 720p playback proxy.
//! - [`speech_audio`]: 16 kHz mono PCM for the transcriber, streamed.
//! - [`waveform`]: the loudness file for the timeline.
//! - [`export`]: the export plan, encode clip, render audio, join, and the whole export.
//!
//! Every task takes explicit output paths; the `cache` crate decides them. Every task is
//! blocking: `jobs` runs it on a worker thread and cancels it with a [`CancelToken`].
//! Time zero for every task is the source's first video frame.

pub mod export;
pub mod probe;
pub mod process;
pub mod proxy;
pub mod speech_audio;
pub mod tools;
pub mod waveform;

pub use export::{
    AudioRenderRequest, ClipFrames, DecodeChoice, EXPORT_AUDIO_RATE, EXPORT_CQ, EXPORT_GOP, EXPORT_PARALLEL_PIECES, EXPORT_PRESET,
    EXPORT_RAMP_SECONDS, ExportOptions, ExportSource, ExportSpec, JoinPiece, JoinRequest, OutputColor, PieceOutcome, PieceRequest,
    PreparedSource, SequenceClip, encode_clip, export_destination, format_bytes, join, output_format, plan_export, prepare_source,
    render_audio, run_export,
};
pub use probe::{choose_speech_track, probe};
pub use process::{CancelToken, RunFailure, RunSpec, TaskProgress, in_progress_path, run_ffmpeg};
pub use proxy::{EncoderChoice, PROXY_HEIGHT, PROXY_KEYFRAME_SECONDS, PROXY_WIDTH, ProxyOutcome, ProxyRequest, make_proxy};
pub use speech_audio::{
    SPEECH_BYTES_PER_SAMPLE, SPEECH_SAMPLE_RATE, SpeechAudioRequest, SpeechAudioStream, SpeechAudioSummary, speech_samples_for,
    start_speech_audio,
};
pub use tools::{FFMPEG_DIR_ENV, FfmpegTools};
pub use waveform::{WAVEFORM_VALUES_PER_SECOND, WaveformRequest, make_waveform, waveform_value_count};

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::PathBuf;

    /// A fresh, empty folder for one test.
    pub(crate) fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("rc-media-tests").join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
