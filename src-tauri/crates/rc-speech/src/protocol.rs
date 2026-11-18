//! The transcriber protocol: one JSON object per line on the transcriber's standard output.
//!
//! All times are whole microseconds from the start of the audio. The field names are fixed
//! by the protocol text shared with the `transcriber` program (spec 3.5.7).

use rc_types::Micros;
use serde::{Deserialize, Serialize};

/// The device the transcriber reports it actually used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceUsed {
    Gpu,
    Cpu,
}

/// One timed word inside a `segment` message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WordMsg {
    pub text: String,
    pub start: Micros,
    pub end: Micros,
}

/// One speech range in a `done` message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RangeMsg {
    pub start: Micros,
    pub end: Micros,
}

/// One line of transcriber output.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Message {
    /// Loaded. `fallback` is true when the GPU was asked for or auto-selected but the processor is used.
    Ready { model: String, device: DeviceUsed, fallback: bool },
    /// One stretch of speech found by the voice detector, with its words.
    Segment { start: Micros, end: Micros, words: Vec<WordMsg> },
    /// The detector heard speech, the model returned nothing.
    SpeechWithoutWords { start: Micros, end: Micros },
    /// Seconds of audio consumed so far.
    Progress {
        #[serde(rename = "audioSeconds")]
        audio_seconds: f64,
    },
    /// Input ended and everything was transcribed; every speech range the detector found.
    Done {
        #[serde(rename = "speechRanges")]
        speech_ranges: Vec<RangeMsg>,
    },
    /// A failure; the transcriber exits with a non-zero code afterwards.
    Error { code: String, message: String },
}

impl Message {
    /// Parses one output line. Fails on anything that is not exactly one well-formed message:
    /// bad JSON, an unknown `type`, a missing field, a fractional time, a negative time, or an
    /// end before its start.
    pub fn parse_line(line: &str) -> Result<Message, String> {
        let msg: Message = serde_json::from_str(line.trim()).map_err(|e| e.to_string())?;
        msg.validate()?;
        Ok(msg)
    }

    /// Serializes this message as one protocol line, without the newline.
    pub fn to_line(&self) -> String {
        serde_json::to_string(self).expect("protocol messages always serialize")
    }

    fn validate(&self) -> Result<(), String> {
        fn range(what: &str, start: Micros, end: Micros) -> Result<(), String> {
            if start < 0 || end < start {
                return Err(format!("{what} has an invalid time range {start}..{end}"));
            }
            Ok(())
        }
        match self {
            Message::Segment { start, end, words } => {
                range("segment", *start, *end)?;
                for w in words {
                    range("word", w.start, w.end)?;
                }
                Ok(())
            }
            Message::SpeechWithoutWords { start, end } => range("speech_without_words", *start, *end),
            Message::Progress { audio_seconds } => {
                if audio_seconds.is_finite() && *audio_seconds >= 0.0 {
                    Ok(())
                } else {
                    Err(format!("progress has an invalid audioSeconds {audio_seconds}"))
                }
            }
            Message::Done { speech_ranges } => {
                for r in speech_ranges {
                    range("speech range", r.start, r.end)?;
                }
                Ok(())
            }
            Message::Ready { .. } | Message::Error { .. } => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_message_of_the_protocol() {
        let lines = [
            r#"{"type":"ready","model":"parakeet v2","device":"gpu","fallback":false}"#,
            r#"{"type":"segment","start":123,"end":456,"words":[{"text":"Hello","start":123,"end":300}]}"#,
            r#"{"type":"speech_without_words","start":123,"end":456}"#,
            r#"{"type":"progress","audioSeconds":12.5}"#,
            r#"{"type":"done","speechRanges":[{"start":123,"end":456}]}"#,
            r#"{"type":"error","code":"model_missing","message":"no model"}"#,
        ];
        let parsed: Vec<Message> = lines.iter().map(|l| Message::parse_line(l).unwrap()).collect();
        assert_eq!(parsed[0], Message::Ready { model: "parakeet v2".into(), device: DeviceUsed::Gpu, fallback: false });
        assert_eq!(
            parsed[1],
            Message::Segment { start: 123, end: 456, words: vec![WordMsg { text: "Hello".into(), start: 123, end: 300 }] }
        );
        assert_eq!(parsed[3], Message::Progress { audio_seconds: 12.5 });
        // Round trip: what we write is what we read.
        for m in &parsed {
            assert_eq!(&Message::parse_line(&m.to_line()).unwrap(), m);
        }
    }

    #[test]
    fn rejects_malformed_lines() {
        for bad in [
            "",
            "not json",
            r#"{"type":"segment","start":1.5,"end":2,"words":[]}"#,
            r#"{"type":"segment","start":10,"end":2,"words":[]}"#,
            r#"{"type":"segment","start":-1,"end":2,"words":[]}"#,
            r#"{"type":"segment","start":1,"end":2}"#,
            r#"{"type":"wobble"}"#,
            r#"{"type":"ready","model":"m","device":"tpu","fallback":false}"#,
            r#"{"type":"progress","audio_seconds":1}"#,
        ] {
            assert!(Message::parse_line(bad).is_err(), "accepted {bad:?}");
        }
    }
}
