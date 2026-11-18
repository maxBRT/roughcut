//! The transcriber's output messages (spec 3.5.7) and the line writer that sends them.
//!
//! One JSON object per line on standard output, UTF-8, flushed after each line.
//! All times are whole microseconds from the start of the audio.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Whole microseconds from the start of the audio.
pub type Micros = u64;

/// The processor the model runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Device {
    Gpu,
    Cpu,
}

/// Machine-readable reason carried by an `error` message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    ModelMissing,
    ModelLoadFailed,
    BadArguments,
    Internal,
}

/// One recognised word, times relative to the whole audio.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Word {
    pub text: String,
    pub start: Micros,
    pub end: Micros,
}

/// A half-open stretch of audio `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Range {
    pub start: Micros,
    pub end: Micros,
}

/// Every message the transcriber writes, tagged by `"type"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Message {
    /// The model is loaded. `fallback` is true when the GPU was wanted but the processor is used.
    Ready { model: String, device: Device, fallback: bool },
    /// One stretch of speech, transcribed.
    Segment { start: Micros, end: Micros, words: Vec<Word> },
    /// The voice detector heard speech; the model returned no words for it.
    SpeechWithoutWords { start: Micros, end: Micros },
    /// Seconds of audio consumed so far.
    #[serde(rename_all = "camelCase")]
    Progress { audio_seconds: f64 },
    /// Input ended and everything was transcribed. Every speech range the detector found.
    #[serde(rename_all = "camelCase")]
    Done { speech_ranges: Vec<Range> },
    /// Fatal problem; the program exits with a non-zero code after it.
    Error { code: ErrorCode, message: String },
}

impl Message {
    /// The message as one line of compact JSON, without the newline.
    pub fn to_line(&self) -> String {
        // Serialising these plain structs cannot fail.
        serde_json::to_string(self).unwrap_or_else(|_| {
            r#"{"type":"error","code":"internal","message":"serialisation failed"}"#.to_string()
        })
    }
}

/// Exit code used when standard output has gone away (the reader closed it or died).
pub const EXIT_OUTPUT_CLOSED: i32 = 3;

/// Thread-safe line writer for the protocol. Each message is written and flushed whole.
/// A failed write means nobody is listening any more, so the process exits at once.
pub struct Output {
    sink: Mutex<Box<dyn Write + Send>>,
    /// When the last progress line went out, and the seconds it reported.
    last_progress: Mutex<(Option<Instant>, f64)>,
    progress_every: Duration,
}

impl Output {
    /// Writer over any sink (standard output in the program, a buffer in tests).
    pub fn new(sink: Box<dyn Write + Send>, progress_every: Duration) -> Self {
        Output { sink: Mutex::new(sink), last_progress: Mutex::new((None, 0.0)), progress_every }
    }

    /// Writes one message as a line and flushes. Exits the process if the sink is closed.
    pub fn emit(&self, msg: &Message) {
        let mut line = msg.to_line();
        line.push('\n');
        let mut sink = match self.sink.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if sink.write_all(line.as_bytes()).and_then(|_| sink.flush()).is_err() {
            std::process::exit(EXIT_OUTPUT_CLOSED);
        }
    }

    /// Writes a `progress` message if at least `progress_every` has passed since the last one.
    /// Reported seconds never go back, even when two threads report at once.
    pub fn maybe_progress(&self, consumed_samples: u64, sample_rate: u32) {
        let now = Instant::now();
        // The lock is held while writing, so two reports cannot swap order on the way out.
        let mut last = match self.last_progress.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        match last.0 {
            Some(t) if now.duration_since(t) < self.progress_every => return,
            None => {
                // Start the clock at the first call: the first report comes one interval in.
                last.0 = Some(now);
                return;
            }
            _ => last.0 = Some(now),
        }
        let secs = (consumed_samples as f64 / f64::from(sample_rate) * 1000.0).round() / 1000.0;
        let secs = secs.max(last.1);
        last.1 = secs;
        self.emit(&Message::Progress { audio_seconds: secs });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_names_match_the_protocol() {
        let ready = Message::Ready { model: "m".into(), device: Device::Gpu, fallback: false };
        assert_eq!(ready.to_line(), r#"{"type":"ready","model":"m","device":"gpu","fallback":false}"#);
        let seg = Message::Segment {
            start: 123,
            end: 456,
            words: vec![Word { text: "Hello".into(), start: 123, end: 300 }],
        };
        assert_eq!(
            seg.to_line(),
            r#"{"type":"segment","start":123,"end":456,"words":[{"text":"Hello","start":123,"end":300}]}"#
        );
        assert_eq!(
            Message::SpeechWithoutWords { start: 1, end: 2 }.to_line(),
            r#"{"type":"speech_without_words","start":1,"end":2}"#
        );
        assert_eq!(
            Message::Progress { audio_seconds: 12.5 }.to_line(),
            r#"{"type":"progress","audioSeconds":12.5}"#
        );
        assert_eq!(
            Message::Done { speech_ranges: vec![Range { start: 123, end: 456 }] }.to_line(),
            r#"{"type":"done","speechRanges":[{"start":123,"end":456}]}"#
        );
        assert_eq!(
            Message::Error { code: ErrorCode::ModelLoadFailed, message: "x".into() }.to_line(),
            r#"{"type":"error","code":"model_load_failed","message":"x"}"#
        );
    }

    #[test]
    fn lines_round_trip() {
        let m = Message::Done { speech_ranges: vec![] };
        let back: Message = serde_json::from_str(&m.to_line()).unwrap();
        assert_eq!(back, m);
    }
}

#[cfg(test)]
mod progress_tests {
    use super::*;
    use std::sync::Arc;

    #[derive(Clone, Default)]
    struct Shared(Arc<Mutex<Vec<u8>>>);
    impl Write for Shared {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn progress_is_rate_limited_and_never_goes_back() {
        let buf = Shared::default();
        let out = Output::new(Box::new(buf.clone()), Duration::ZERO);
        out.maybe_progress(16_000, 16_000); // starts the clock, writes nothing
        out.maybe_progress(32_000, 16_000);
        out.maybe_progress(8_000, 16_000); // a late report of less audio
        out.maybe_progress(40_000, 16_000);
        let text = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
        let secs: Vec<f64> = text
            .lines()
            .map(|l| match serde_json::from_str::<Message>(l).unwrap() {
                Message::Progress { audio_seconds } => audio_seconds,
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(secs, [2.0, 2.0, 2.5]);

        let slow = Output::new(Box::new(buf.clone()), Duration::from_secs(3600));
        let before = buf.0.lock().unwrap().len();
        slow.maybe_progress(1, 16_000);
        slow.maybe_progress(2, 16_000);
        assert_eq!(buf.0.lock().unwrap().len(), before, "at most one line per interval");
    }
}
