//! Turning Claude's answer into `Suggestion`s (spec 3.4, 3.5.8): locate each quote among
//! the words of the utterances it names, turn the located words into a `SourceRange`
//! using the tokens' `cutBefore` points, and drop anything that cannot be located.

use rc_types::{
    Micros, Rational, SourceRange, Suggestion, SuggestionKind, SuggestionOrigin, Token, Transcript,
    snap_to_frame,
};

use crate::answer::{ClaudeKind, ClaudeSuggestion};
use crate::request::{utterance_by_number, utterance_number};

/// Every token of the transcript in order, with the number Claude knows its utterance by
/// (its position from 1, see [`utterance_number`]).
pub(crate) fn flat_tokens(transcript: &Transcript) -> Vec<(u32, &Token)> {
    transcript
        .utterances
        .iter()
        .enumerate()
        .flat_map(|(p, u)| u.tokens.iter().map(move |t| (utterance_number(p), t)))
        .collect()
}

/// Splits text into comparable words: lower case, curly apostrophes made straight, every
/// character that is not a letter, digit or apostrophe treated as a separator, and
/// apostrophes at the edges of a word dropped. "Wait—let's" gives `["wait", "let's"]`.
pub fn normalise_words(text: &str) -> Vec<String> {
    let cleaned: String = text
        .chars()
        .map(|c| match c {
            '\u{2019}' | '\u{2018}' | '\u{02BC}' => '\'',
            c if c.is_alphanumeric() || c == '\'' => c,
            _ => ' ',
        })
        .collect();
    cleaned
        .split_whitespace()
        .map(|w| w.trim_matches('\'').to_lowercase())
        .filter(|w| !w.is_empty())
        .collect()
}

/// Finds `quote` among the word tokens of utterances `first..=last` (by the number the
/// request gave them, see [`utterance_number`]), tolerant of punctuation and case. Returns the positions, in
/// [`flat_tokens`] order, of the first and last word token of the earliest match.
/// A match that starts or ends inside a token takes the whole token.
pub fn locate_quote(
    transcript: &Transcript,
    first: u32,
    last: u32,
    quote: &str,
) -> Option<(usize, usize)> {
    if first > last {
        return None;
    }
    let wanted = normalise_words(quote);
    if wanted.is_empty() {
        return None;
    }
    let flat = flat_tokens(transcript);
    let mut words: Vec<(String, usize)> = Vec::new();
    for (i, (utt, tok)) in flat.iter().enumerate() {
        if *utt < first || *utt > last {
            continue;
        }
        if let Token::Word(w) = tok {
            words.extend(normalise_words(&w.text).into_iter().map(|p| (p, i)));
        }
    }
    if words.len() < wanted.len() {
        return None;
    }
    (0..=words.len() - wanted.len())
        .find(|&s| wanted.iter().enumerate().all(|(k, q)| words[s + k].0 == *q))
        .map(|s| (words[s].1, words[s + wanted.len() - 1].1))
}

/// The source range that cutting flat tokens `i..=j` removes: from token `i`'s cut point to
/// the next token's cut point, or to the end of token `j` when it is the last token.
/// With a frame rate, both ends are snapped to that grid. `None` if the range is empty.
pub(crate) fn cut_range(
    transcript: &Transcript,
    i: usize,
    j: usize,
    frame_rate: Option<Rational>,
) -> Option<(Micros, Micros)> {
    let flat = flat_tokens(transcript);
    let (_, first) = flat.get(i)?;
    let (_, last) = flat.get(j)?;
    let mut start = first.cut_before();
    let mut end = flat.get(j + 1).map_or(last.end(), |(_, t)| t.cut_before());
    if let Some(rate) = frame_rate {
        start = snap_to_frame(start, rate);
        end = snap_to_frame(end, rate);
    }
    (end > start).then_some((start, end))
}

/// A stable id for a suggestion: derived from its source and range only, so the same
/// range always gets the same id (FNV-1a 64 of `sourceId`, start and end).
pub fn suggestion_id(range: &SourceRange) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let key = format!("{}\u{0}{}\u{0}{}", range.source_id, range.start, range.end);
    for b in key.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("sg-{h:016x}")
}

/// One line, trimmed, single spaces.
fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Maps Claude's suggestions to spec 3.4 `Suggestion`s (origin `claude`), in answer order.
/// Any whose quote cannot be located inside the stated utterances is dropped. Retakes get
/// `keptVersionAt`: the start of `keep_utterance`, or the end of the cut when Claude named
/// no valid utterance to keep. Overlaps are not resolved here (see `merge_suggestions`).
pub fn map_suggestions(
    transcript: &Transcript,
    answer: &[ClaudeSuggestion],
    frame_rate: Option<Rational>,
) -> Vec<Suggestion> {
    let mut out = Vec::new();
    for s in answer {
        let Some((i, j)) = locate_quote(transcript, s.first_utterance, s.last_utterance, &s.quote)
        else {
            continue;
        };
        let Some((start, end)) = cut_range(transcript, i, j, frame_rate) else {
            continue;
        };
        let range = SourceRange {
            source_id: transcript.source_id.clone(),
            start,
            end,
        };
        let kept_version_at = (s.kind == ClaudeKind::Retake).then(|| {
            s.keep_utterance
                .and_then(|k| utterance_by_number(transcript, k))
                .map(|u| u.start)
                .filter(|&at| at >= end)
                .map(|at| frame_rate.map_or(at, |r| snap_to_frame(at, r)))
                .unwrap_or(end)
        });
        let kind: SuggestionKind = s.kind.into();
        out.push(Suggestion {
            id: suggestion_id(&range),
            kind,
            origin: SuggestionOrigin::Claude,
            range,
            reason: one_line(&s.reason),
            kept_version_at,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use rc_types::{PauseToken, Utterance, WordToken};

    /// Utterances of words, 0.5 s per word with 0.1 s gaps, cut points 50 ms before each word.
    fn transcript(utts: &[&str]) -> Transcript {
        let mut t = 1_000_000;
        let mut utterances = Vec::new();
        for (n, text) in utts.iter().enumerate() {
            let mut tokens = Vec::new();
            let start = t;
            for w in text.split(' ') {
                if w == "[P]" {
                    tokens.push(Token::Pause(PauseToken {
                        start: t,
                        end: t + 3_000_000,
                        cut_before: t - 50_000,
                    }));
                    t += 3_100_000;
                    continue;
                }
                tokens.push(Token::Word(WordToken {
                    start: t,
                    end: t + 500_000,
                    cut_before: t - 50_000,
                    text: w.into(),
                }));
                t += 600_000;
            }
            utterances.push(Utterance {
                index: n as u32 + 1,
                start,
                end: t - 100_000,
                tokens,
            });
            t += 400_000;
        }
        Transcript {
            schema_version: 1,
            source_id: "src".into(),
            model: "m".into(),
            complete: true,
            utterances,
        }
    }

    fn sug(
        kind: ClaudeKind,
        first: u32,
        last: u32,
        quote: &str,
        keep: Option<u32>,
    ) -> ClaudeSuggestion {
        ClaudeSuggestion {
            kind,
            first_utterance: first,
            last_utterance: last,
            quote: quote.into(),
            reason: " A  reason\n".into(),
            keep_utterance: keep,
        }
    }

    #[test]
    fn normalises_punctuation_case_and_apostrophes() {
        assert_eq!(
            normalise_words("Wait—let\u{2019}s GO, now!"),
            vec!["wait", "let's", "go", "now"]
        );
        assert_eq!(normalise_words("'cause ... (um)"), vec!["cause", "um"]);
        assert!(normalise_words(" -- ").is_empty());
    }

    #[test]
    fn locates_quotes_tolerantly() {
        let t = transcript(&[
            "Hello there, everyone.",
            "So the, the plan is simple.",
            "Okay. Let's go!",
        ]);
        // Exact, across two utterances.
        assert_eq!(locate_quote(&t, 1, 2, "everyone. So the,"), Some((2, 4)));
        // Different punctuation and case.
        assert_eq!(locate_quote(&t, 2, 2, "so THE the plan"), Some((3, 6)));
        // Curly apostrophe against a straight one.
        assert_eq!(locate_quote(&t, 3, 3, "let\u{2019}s go"), Some((10, 11)));
        // The first of several matches.
        assert_eq!(locate_quote(&t, 2, 2, "the"), Some((4, 4)));
    }

    #[test]
    fn unlocatable_quotes_are_none() {
        let t = transcript(&["Hello there, everyone.", "So the plan is simple."]);
        assert_eq!(
            locate_quote(&t, 1, 1, "So the plan"),
            None,
            "outside the stated utterances"
        );
        assert_eq!(
            locate_quote(&t, 2, 2, "the plan was simple"),
            None,
            "a changed word"
        );
        assert_eq!(locate_quote(&t, 2, 1, "So"), None, "reversed range");
        assert_eq!(locate_quote(&t, 7, 9, "So"), None, "no such utterance");
        assert_eq!(locate_quote(&t, 1, 2, "..."), None, "no words");
    }

    #[test]
    fn match_inside_a_hyphenated_token_takes_the_whole_token() {
        let t = transcript(&["the home-screen widget"]);
        assert_eq!(locate_quote(&t, 1, 1, "screen widget"), Some((1, 2)));
        assert_eq!(locate_quote(&t, 1, 1, "home screen"), Some((1, 1)));
    }

    #[test]
    fn maps_to_ranges_from_cut_points_and_drops_the_unlocatable() {
        let t = transcript(&[
            "I want to, I want to say this.",
            "I want to say this clearly.",
            "Done [P] now.",
        ]);
        let flat = flat_tokens(&t);
        let answer = vec![
            sug(ClaudeKind::FalseStart, 1, 1, "I want to,", None),
            sug(ClaudeKind::Retake, 1, 1, "I want to say this.", Some(2)),
            sug(ClaudeKind::Aside, 1, 1, "not in the transcript", None),
            sug(ClaudeKind::Aside, 3, 3, "now.", None),
        ];
        let m = map_suggestions(&t, &answer, None);
        assert_eq!(m.len(), 3);
        // False start: words 0..=2, ends at word 3's cut point.
        assert_eq!(m[0].range.start, flat[0].1.cut_before());
        assert_eq!(m[0].range.end, flat[3].1.cut_before());
        assert_eq!(m[0].kind, SuggestionKind::FalseStart);
        assert_eq!(m[0].origin, SuggestionOrigin::Claude);
        assert_eq!(m[0].kept_version_at, None);
        assert_eq!(m[0].reason, "A reason");
        // Retake: words 3..=7, ends at the first token of utterance 2; kept version at utterance 2.
        assert_eq!(m[1].range.end, flat[8].1.cut_before());
        assert_eq!(m[1].kept_version_at, Some(t.utterances[1].start));
        // The last word of the transcript: the range ends at its end.
        let last = flat.len() - 1;
        assert_eq!(m[2].range.end, flat[last].1.end());
        assert_eq!(m[2].range.start, flat[last].1.cut_before());
    }

    #[test]
    fn utterances_are_found_by_position_when_index_counts_from_zero() {
        let mut t = transcript(&["Take one.", "Take one again.", "Bye."]);
        for (p, u) in t.utterances.iter_mut().enumerate() {
            u.index = p as u32;
        }
        // Number 1 is the first utterance, as the request showed it.
        assert_eq!(locate_quote(&t, 1, 1, "Take one"), Some((0, 1)));
        assert_eq!(locate_quote(&t, 2, 2, "Take one"), Some((2, 3)));
        assert_eq!(locate_quote(&t, 4, 4, "Bye"), None);
        let m = map_suggestions(
            &t,
            &[sug(ClaudeKind::Retake, 1, 1, "Take one.", Some(2))],
            None,
        );
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].range.start, t.utterances[0].tokens[0].cut_before());
        assert_eq!(m[0].kept_version_at, Some(t.utterances[1].start));
    }

    #[test]
    fn retake_without_a_valid_keep_falls_back_to_the_end_of_the_cut() {
        let t = transcript(&["Take one.", "Take one again."]);
        let m = map_suggestions(
            &t,
            &[sug(ClaudeKind::Retake, 1, 1, "Take one.", Some(99))],
            None,
        );
        assert_eq!(m[0].kept_version_at, Some(m[0].range.end));
    }

    #[test]
    fn ranges_snap_to_the_frame_grid_when_given_one() {
        let t = transcript(&["one two three"]);
        let rate = Rational {
            num: 30000,
            den: 1001,
        };
        let m = map_suggestions(
            &t,
            &[sug(ClaudeKind::FalseStart, 1, 1, "two", None)],
            Some(rate),
        );
        assert!(rc_types::is_on_frame_grid(m[0].range.start, rate));
        assert!(rc_types::is_on_frame_grid(m[0].range.end, rate));
    }

    #[test]
    fn ids_are_stable_and_depend_on_source_and_range() {
        let r = SourceRange {
            source_id: "a".into(),
            start: 1,
            end: 2,
        };
        assert_eq!(suggestion_id(&r), suggestion_id(&r.clone()));
        assert_eq!(suggestion_id(&r).len(), 19);
        assert_ne!(
            suggestion_id(&r),
            suggestion_id(&SourceRange {
                end: 3,
                ..r.clone()
            })
        );
        assert_ne!(
            suggestion_id(&r),
            suggestion_id(&SourceRange {
                source_id: "b".into(),
                ..r
            })
        );
    }
}
