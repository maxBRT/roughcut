//! The request sent to `claude` on standard input, and the system prompt and answer schema
//! that go with it (spec 3.5.8; format settled in spikes/claude/RESULT.md section 1).

use rc_types::{Token, Transcript, Utterance};

/// The final system prompt from the experiment (v2), passed with `--system-prompt-file`.
pub const SYSTEM_PROMPT: &str = include_str!("../assets/system-prompt.txt");

/// The answer schema from the experiment (compact JSON, one line), passed to `--json-schema`.
pub const ANSWER_SCHEMA: &str = include_str!("../assets/suggestions.schema.json");

/// The text of an utterance as Claude sees it: its word tokens joined by single spaces.
/// Pause and unrecognised tokens are left out.
pub fn utterance_text(u: &Utterance) -> String {
    let joined = u
        .tokens
        .iter()
        .filter_map(|t| match t {
            Token::Word(w) => Some(w.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(" ");
    joined.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `h:mm:ss.s`, computed with the same floating-point steps as the experiment's
/// `build_request.py`, so the output matches its recorded requests byte for byte.
fn fmt_time(us: i64) -> String {
    let s = us as f64 / 1_000_000.0;
    let h = (s / 3600.0).floor();
    let m = ((s % 3600.0) / 60.0).floor();
    let sec = s - h * 3600.0 - m * 60.0;
    format!("{}:{:02}:{:04.1}", h as i64, m as i64, sec)
}

/// The number Claude sees for the utterance at `position` (counted from 0) in
/// `transcript.utterances`: positions are numbered 1..=n, whatever `Utterance.index` holds,
/// because the answer schema requires utterance numbers of at least 1 and producers may
/// count `index` from 0. [`utterance_by_number`] is its inverse; the request and the
/// mapping of the answer both go through these two functions.
pub fn utterance_number(position: usize) -> u32 {
    position as u32 + 1
}

/// The utterance Claude means by `number` (see [`utterance_number`]), if there is one.
pub fn utterance_by_number(transcript: &Transcript, number: u32) -> Option<&Utterance> {
    let position = (number as usize).checked_sub(1)?;
    transcript.utterances.get(position)
}

/// Where the speech of an utterance ends: the end of its last word or unrecognised token
/// when pause chips follow it inside the utterance (as `speech` places them), otherwise
/// the utterance's own end. An utterance with no speech at all ends its speech at its start.
fn speech_end(u: &Utterance) -> i64 {
    if !matches!(u.tokens.last(), Some(Token::Pause(_))) {
        return u.end;
    }
    u.tokens
        .iter()
        .rev()
        .find(|t| !matches!(t, Token::Pause(_)))
        .map_or(u.start, Token::end)
}

/// Where the speech of an utterance starts: the start of its first word or unrecognised
/// token when pause chips lead it, otherwise the utterance's own start. An utterance with
/// no speech at all is silence throughout, so its speech "starts" at its end.
fn speech_start(u: &Utterance) -> i64 {
    if !matches!(u.tokens.first(), Some(Token::Pause(_))) {
        return u.start;
    }
    u.tokens
        .iter()
        .find(|t| !matches!(t, Token::Pause(_)))
        .map_or(u.end, Token::start)
}

/// Builds the standard input for one call: a two-line header, a blank line, then one
/// tab-separated line per utterance (number by position from 1, start time, pause after in
/// seconds, text). The pause after is the silence from the end of the utterance's speech to
/// the start of the next utterance's speech, so pause chips inside an utterance count as
/// silence. The pause after the last utterance is 0.
pub fn build_request(transcript: &Transcript) -> String {
    let utts = &transcript.utterances;
    let mut out = String::with_capacity(utts.len() * 96 + 200);
    out.push_str(&format!(
        "Transcript to review: {} utterances.\n",
        utts.len()
    ));
    out.push_str(
        "Each line is tab-separated: utterance number, start time (h:mm:ss.s), \
         pause after the utterance in seconds, text.\n",
    );
    out.push('\n');
    for (i, u) in utts.iter().enumerate() {
        let pause = utts.get(i + 1).map_or(0, |n| (speech_start(n) - speech_end(u)).max(0));
        let pause = pause as f64 / 1_000_000.0;
        out.push_str(&format!(
            "{}\t{}\t{:.1}\t{}\n",
            utterance_number(i),
            fmt_time(u.start),
            pause,
            utterance_text(u)
        ));
    }
    out
}

/// Whether the transcript has any words at all (no words: Claude is not called).
pub fn has_words(transcript: &Transcript) -> bool {
    transcript
        .utterances
        .iter()
        .any(|u| u.tokens.iter().any(|t| matches!(t, Token::Word(_))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rc_types::{PauseToken, WordToken};

    fn word(text: &str, start: i64, end: i64) -> Token {
        Token::Word(WordToken {
            start,
            end,
            cut_before: start,
            text: text.into(),
        })
    }

    #[test]
    fn schema_is_one_line_json() {
        let v: serde_json::Value = serde_json::from_str(ANSWER_SCHEMA).unwrap();
        assert_eq!(v["required"][0], "suggestions");
        assert!(!ANSWER_SCHEMA.trim_end().contains('\n'));
        assert!(SYSTEM_PROMPT.contains("Give your answer only through the structured output"));
    }

    #[test]
    fn times_format_like_the_experiment() {
        assert_eq!(fmt_time(2_400_000), "0:00:02.4");
        assert_eq!(fmt_time(3_725_960_000), "1:02:06.0");
        // Same quirk as the experiment's Python: seconds round up to 60.0 without a carry.
        assert_eq!(fmt_time(59_960_000), "0:00:60.0");
    }

    #[test]
    fn request_lines_skip_pauses_and_report_the_gap() {
        let t = Transcript {
            schema_version: 1,
            source_id: "s".into(),
            model: "m".into(),
            complete: true,
            utterances: vec![
                Utterance {
                    index: 1,
                    start: 1_000_000,
                    end: 2_000_000,
                    tokens: vec![
                        word("Hello", 1_000_000, 1_400_000),
                        word("there.", 1_500_000, 2_000_000),
                        Token::Pause(PauseToken {
                            start: 2_100_000,
                            end: 3_000_000,
                            cut_before: 2_050_000,
                        }),
                    ],
                },
                Utterance {
                    index: 2,
                    start: 3_250_000,
                    end: 4_000_000,
                    tokens: vec![word("Bye", 3_250_000, 4_000_000)],
                },
            ],
        };
        let r = build_request(&t);
        let lines: Vec<&str> = r.lines().collect();
        assert_eq!(lines[0], "Transcript to review: 2 utterances.");
        assert_eq!(lines[2], "");
        assert_eq!(lines[3], "1\t0:00:01.0\t1.2\tHello there.");
        assert_eq!(lines[4], "2\t0:00:03.2\t0.0\tBye");
        assert!(r.ends_with('\n'));
        assert!(has_words(&t));
    }

    fn pause(start: i64, end: i64) -> Token {
        Token::Pause(PauseToken {
            start,
            end,
            cut_before: start,
        })
    }

    /// Shaped the way `speech` builds transcripts: `index` from 0, a leading pause-only
    /// utterance, and pause chips (150 ms inside the silence) as the last tokens of the
    /// utterance they follow, so `Utterance.end` is the chip's end.
    fn speech_shaped() -> Transcript {
        let utt = |index, tokens: Vec<Token>| Utterance {
            index,
            start: tokens.first().unwrap().start(),
            end: tokens.last().unwrap().end(),
            tokens,
        };
        Transcript {
            schema_version: 1,
            source_id: "s".into(),
            model: "m".into(),
            complete: true,
            utterances: vec![
                utt(0, vec![pause(0, 2_850_000)]),
                utt(
                    1,
                    vec![
                        word("So", 3_000_000, 3_400_000),
                        word("um", 3_500_000, 4_000_000),
                        pause(4_150_000, 7_850_000),
                    ],
                ),
                utt(2, vec![word("Hello.", 8_000_000, 8_500_000)]),
            ],
        }
    }

    #[test]
    fn lines_are_numbered_by_position_from_one_whatever_the_index() {
        let t = speech_shaped();
        let r = build_request(&t);
        let numbers: Vec<&str> = r.lines().skip(3).map(|l| l.split('\t').next().unwrap()).collect();
        assert_eq!(numbers, ["1", "2", "3"]);
        for (p, u) in t.utterances.iter().enumerate() {
            assert_eq!(utterance_by_number(&t, utterance_number(p)), Some(u));
        }
        assert_eq!(utterance_by_number(&t, 0), None);
        assert_eq!(utterance_by_number(&t, 4), None);
    }

    #[test]
    fn pause_after_counts_pause_chips_as_silence() {
        let r = build_request(&speech_shaped());
        let lines: Vec<&str> = r.lines().skip(3).collect();
        // Silence from 0.0 s (no speech) to the first word at 3.0 s.
        assert_eq!(lines[0], "1\t0:00:00.0\t3.0\t");
        // "um" ends at 4.0 s, "Hello." starts at 8.0 s: the chip inside counts as silence.
        assert_eq!(lines[1], "2\t0:00:03.0\t4.0\tSo um");
        assert_eq!(lines[2], "3\t0:00:08.0\t0.0\tHello.");
    }
}
