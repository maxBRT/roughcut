//! Helpers shared by rc-speech's integration tests.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use rc_speech::{BuildOptions, LevelTrack, Message, TranscriptBuilder, WordMsg};
use rc_types::{Micros, Token, Transcript};

/// `tests/data/<name>`.
pub fn data(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("data").join(name)
}

/// The project root (`roughcut/`).
pub fn project_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().expect("project root")
}

/// The generated speech fixture's exact 16 kHz signal.
pub fn speech_2min_wav() -> PathBuf {
    let p = project_root().join("fixtures").join("out").join("speech-2min.wav");
    assert!(p.is_file(), "{} is missing: run `npm run fixtures` in the project root", p.display());
    p
}

/// The fixtures manifest entry for speech-2min.
pub fn speech_2min_manifest() -> serde_json::Value {
    let p = project_root().join("fixtures").join("out").join("manifest.json");
    let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e} (run `npm run fixtures`)", p.display()));
    let v: serde_json::Value = serde_json::from_str(&text).expect("manifest JSON");
    let entry = v.get("fixtures").and_then(|f| f.get("speech-2min")).cloned();
    entry.unwrap_or_else(|| {
        v.as_object()
            .and_then(|o| o.values().find_map(|x| x.get("speech-2min").cloned()))
            .expect("speech-2min in the manifest")
    })
}

/// One recorded transcriber run in protocol form.
pub fn recording(name: &str) -> Vec<Message> {
    let text = std::fs::read_to_string(data(name)).expect("recording");
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| Message::parse_line(l).expect("protocol line")).collect()
}

/// Every word of every segment, in order.
pub fn recorded_words(msgs: &[Message]) -> Vec<WordMsg> {
    msgs.iter()
        .flat_map(|m| match m {
            Message::Segment { words, .. } => words.clone(),
            _ => vec![],
        })
        .collect()
}

/// The PCM samples of a 16 kHz mono s16le WAV file (its `data` chunk).
pub fn wav_pcm(path: &Path) -> Vec<u8> {
    let bytes = std::fs::read(path).expect("wav");
    assert_eq!(&bytes[0..4], b"RIFF");
    assert_eq!(&bytes[8..12], b"WAVE");
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let len = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
        let body = at + 8;
        if id == b"fmt " {
            let channels = u16::from_le_bytes(bytes[body + 2..body + 4].try_into().unwrap());
            let rate = u32::from_le_bytes(bytes[body + 4..body + 8].try_into().unwrap());
            let bits = u16::from_le_bytes(bytes[body + 14..body + 16].try_into().unwrap());
            assert_eq!((channels, rate, bits), (1, 16_000, 16), "{}", path.display());
        }
        if id == b"data" {
            return bytes[body..(body + len).min(bytes.len())].to_vec();
        }
        at = body + len + (len & 1);
    }
    panic!("no data chunk in {}", path.display());
}

/// Builds a transcript from recorded messages, offline.
pub fn build(msgs: &[Message], levels: &LevelTrack, duration: Micros, opts: BuildOptions) -> Transcript {
    let mut b = TranscriptBuilder::new("src", duration, opts);
    for m in msgs {
        b.push_message(m, levels);
    }
    assert!(b.is_complete(), "the recording has no done message");
    b.into_transcript()
}

/// Every token, in order.
pub fn tokens(t: &Transcript) -> Vec<Token> {
    t.utterances.iter().flat_map(|u| u.tokens.clone()).collect()
}

/// The word tokens' texts, in order.
pub fn word_texts(t: &Transcript) -> Vec<String> {
    tokens(t)
        .into_iter()
        .filter_map(|tok| match tok {
            Token::Word(w) => Some(w.text),
            _ => None,
        })
        .collect()
}

/// The rules every transcript obeys: utterances numbered from 1 (spec 3.4), never empty, spanning
/// their tokens; tokens strictly ordered, never overlapping, never empty, inside the source;
/// every `cutBefore` between the previous token's end (0 for the first) and the token's start.
pub fn check_invariants(t: &Transcript, duration: Micros) {
    let mut prev_end: Micros = 0;
    for (i, u) in t.utterances.iter().enumerate() {
        assert_eq!(u.index as usize, i + 1, "utterance numbering (from 1)");
        assert!(!u.tokens.is_empty(), "utterance {i} is empty");
        assert_eq!(u.start, u.tokens[0].start(), "utterance {i} start");
        assert_eq!(u.end, u.tokens.last().unwrap().end(), "utterance {i} end");
        for tok in &u.tokens {
            let (s, e, c) = (tok.start(), tok.end(), tok.cut_before());
            assert!(s < e, "empty token {tok:?}");
            assert!(e <= duration, "token past the source end {tok:?}");
            assert!(prev_end <= c && c <= s, "cutBefore outside the gap: previous end {prev_end}, {tok:?}");
            if let Token::Word(w) = tok {
                assert!(!w.text.trim().is_empty(), "word without text {tok:?}");
            }
            prev_end = e;
        }
    }
}
