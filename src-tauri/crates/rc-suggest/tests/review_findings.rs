//! Review tests (track suggest-review). Each one reproduces a defect found in review, using
//! transcripts shaped the way rc-speech's builder actually makes them
//! (src-tauri/crates/rc-speech/src/builder.rs): utterance `index` counted from 0
//! (`close_current`: `index = self.finished.len()`), and a pause chip pushed as the LAST
//! token of the utterance it follows, so that utterance's `end` is the pause chip's end
//! (`place` pushes the chip, then `close_current` takes `end` from the last token).

use rc_suggest::{build_request, map_suggestions, read_answer};
use rc_types::{PauseToken, Token, Transcript, Utterance, WordToken};

fn word(text: &str, start: i64, end: i64) -> Token {
    Token::Word(WordToken {
        start,
        end,
        cut_before: start,
        text: text.into(),
    })
}

/// Two utterances as rc-speech numbers them (0 and 1), with a 4 s silence between them that
/// rc-speech represents as a pause chip at the end of utterance 0 (150 ms margin each side).
fn speech_shaped_transcript() -> Transcript {
    let pause = Token::Pause(PauseToken {
        start: 2_150_000,
        end: 5_850_000,
        cut_before: 2_150_000,
    });
    Transcript {
        schema_version: 1,
        source_id: "src".into(),
        model: "parakeet".into(),
        complete: true,
        utterances: vec![
            Utterance {
                index: 0,
                start: 1_000_000,
                end: 5_850_000,
                tokens: vec![
                    word("So", 1_000_000, 1_400_000),
                    word("um", 1_500_000, 2_000_000),
                    pause,
                ],
            },
            Utterance {
                index: 1,
                start: 6_000_000,
                end: 7_000_000,
                tokens: vec![
                    Token::Word(WordToken {
                        start: 6_000_000,
                        end: 6_400_000,
                        cut_before: 5_850_000,
                        text: "Hello".into(),
                    }),
                    word("everyone.", 6_500_000, 7_000_000),
                ],
            },
        ],
    }
}

/// The request's data lines: (number as Claude sees it, pause after, text).
fn lines(request: &str) -> Vec<(String, String, String)> {
    request
        .lines()
        .skip(3)
        .map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            (f[0].to_string(), f[2].to_string(), f[3].to_string())
        })
        .collect()
}

#[test]
fn review_a_suggestion_in_the_first_utterance_of_a_zero_based_transcript_is_usable() {
    // Claude answers with the utterance number it was shown in the request. For a transcript
    // from rc-speech that number is 0, which the embedded schema forbids (minimum 1), so the
    // whole answer becomes claude_bad_answer (and after the retry, no Claude suggestions).
    let t = speech_shaped_transcript();
    let request = build_request(&t);
    let (n, _, text) = lines(&request)[0].clone();
    let n: u32 = n.parse().unwrap();
    let envelope = serde_json::json!({
        "type": "result", "subtype": "success", "is_error": false,
        "terminal_reason": "completed", "result": "",
        "structured_output": {"suggestions": [{
            "kind": "false_start", "first_utterance": n, "last_utterance": n,
            "quote": text, "reason": "Abandoned start"
        }]},
        "modelUsage": {"claude-opus-5-5": {}}
    });
    let answer = read_answer(Some(0), &envelope.to_string(), "")
        .unwrap_or_else(|e| panic!("answer about utterance {n} rejected: {e:?}"));
    let mapped = map_suggestions(&t, &answer.suggestions, None);
    assert_eq!(mapped.len(), 1, "the suggestion maps back to the first utterance");
    assert_eq!(mapped[0].range.start, 1_000_000);
}

#[test]
fn review_pause_after_reports_the_silence_when_the_utterance_ends_with_a_pause_chip() {
    // 4 s of silence follows "So um" (2.0 s to 6.0 s). rc-speech puts the pause chip inside
    // utterance 0, so utterance.end = 5.85 s and the request says the pause after is 0.1 s.
    let t = speech_shaped_transcript();
    let request = build_request(&t);
    let pause_after: f64 = lines(&request)[0].1.parse().unwrap();
    assert!(
        pause_after >= 3.5,
        "request reports {pause_after} s of pause after an utterance followed by 4 s of silence:\n{request}"
    );
}
