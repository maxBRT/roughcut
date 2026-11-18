//! Dead air found locally, without Claude (spec 1.9, 2.4.6), from the transcript's pause
//! tokens (the pause chips `speech` makes from the voice detector's silences).
//!
//! **Rule.** A run of consecutive pause tokens is one silence. It reaches from the end of
//! the token before it to the start of the token after it (or the pause tokens' own edges
//! at the very start or end of the transcript). A silence of at least
//! [`DEAD_AIR_MIN_SILENCE`] (2.5 s) is dead air. The suggestion cuts the middle of it and
//! leaves [`DEAD_AIR_KEEP_EACH_SIDE`] (0.35 s) of silence in place on each side, so after
//! accepting it 0.7 s of quiet remains: a natural beat, not a jump cut. With a frame rate,
//! the cut's edges are moved inwards onto the frame grid, so the silence left in place is
//! never shorter than the margin. Ordinary pause chips (about 1 to 2 s) are left alone.

use rc_types::{
    Micros, Rational, SourceRange, Suggestion, SuggestionKind, SuggestionOrigin, Token, Transcript,
    ceil_to_frame, floor_to_frame,
};

use crate::mapping::{flat_tokens, suggestion_id};

/// The shortest silence suggested as dead air: 2.5 s.
pub const DEAD_AIR_MIN_SILENCE: Micros = 2_500_000;
/// Silence left in place on each side of a dead-air cut: 0.35 s.
pub const DEAD_AIR_KEEP_EACH_SIDE: Micros = 350_000;

fn seconds(us: Micros) -> String {
    format!("{:.1}", us as f64 / 1_000_000.0)
}

/// Every dead-air suggestion in the transcript (origin `local`, kind `dead_air`), in order.
pub fn find_dead_air(transcript: &Transcript, frame_rate: Option<Rational>) -> Vec<Suggestion> {
    let flat = flat_tokens(transcript);
    let mut out = Vec::new();
    let mut i = 0;
    while i < flat.len() {
        if !matches!(flat[i].1, Token::Pause(_)) {
            i += 1;
            continue;
        }
        let mut j = i;
        while j + 1 < flat.len() && matches!(flat[j + 1].1, Token::Pause(_)) {
            j += 1;
        }
        let silence_start = if i > 0 {
            flat[i - 1].1.end()
        } else {
            flat[i].1.start()
        };
        let silence_end = flat.get(j + 1).map_or(flat[j].1.end(), |(_, t)| t.start());
        i = j + 1;
        let silence = silence_end - silence_start;
        if silence < DEAD_AIR_MIN_SILENCE {
            continue;
        }
        let mut start = silence_start + DEAD_AIR_KEEP_EACH_SIDE;
        let mut end = silence_end - DEAD_AIR_KEEP_EACH_SIDE;
        if let Some(rate) = frame_rate {
            start = ceil_to_frame(start, rate);
            end = floor_to_frame(end, rate);
        }
        if end <= start {
            continue;
        }
        let range = SourceRange {
            source_id: transcript.source_id.clone(),
            start,
            end,
        };
        out.push(Suggestion {
            id: suggestion_id(&range),
            kind: SuggestionKind::DeadAir,
            origin: SuggestionOrigin::Local,
            reason: format!(
                "{} s of silence; {} s left in place",
                seconds(silence),
                seconds(silence - (end - start))
            ),
            range,
            kept_version_at: None,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use rc_types::{PauseToken, Utterance, WordToken, is_on_frame_grid};

    fn w(text: &str, start: Micros, end: Micros) -> Token {
        Token::Word(WordToken {
            start,
            end,
            cut_before: start,
            text: text.into(),
        })
    }
    fn p(start: Micros, end: Micros) -> Token {
        Token::Pause(PauseToken {
            start,
            end,
            cut_before: start,
        })
    }
    fn t(utts: Vec<Vec<Token>>) -> Transcript {
        let utterances = utts
            .into_iter()
            .enumerate()
            .map(|(n, tokens)| Utterance {
                index: n as u32 + 1,
                start: tokens[0].start(),
                end: tokens.last().unwrap().end(),
                tokens,
            })
            .collect();
        Transcript {
            schema_version: 1,
            source_id: "src".into(),
            model: "m".into(),
            complete: true,
            utterances,
        }
    }

    #[test]
    fn long_pause_is_dead_air_with_silence_left_on_each_side() {
        // Word ends at 2.0 s, pause chip 2.1..5.0, next word (next utterance) at 5.2 s: 3.2 s of silence.
        let tr = t(vec![
            vec![w("one", 1_000_000, 2_000_000), p(2_100_000, 5_000_000)],
            vec![w("two", 5_200_000, 5_600_000)],
        ]);
        let d = find_dead_air(&tr, None);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].range.start, 2_000_000 + DEAD_AIR_KEEP_EACH_SIDE);
        assert_eq!(d[0].range.end, 5_200_000 - DEAD_AIR_KEEP_EACH_SIDE);
        assert_eq!(d[0].kind, SuggestionKind::DeadAir);
        assert_eq!(d[0].origin, SuggestionOrigin::Local);
        assert_eq!(d[0].kept_version_at, None);
        assert_eq!(d[0].reason, "3.2 s of silence; 0.7 s left in place");
        assert_eq!(d[0].range.source_id, "src");
    }

    #[test]
    fn ordinary_pauses_and_gaps_without_a_pause_token_are_left_alone() {
        // 2.4 s silence with a chip: below the minimum. 4 s gap with no pause token: not considered.
        let tr = t(vec![
            vec![w("a", 0, 1_000_000), p(1_100_000, 3_300_000)],
            vec![w("b", 3_400_000, 4_000_000)],
            vec![w("c", 8_000_000, 8_500_000)],
        ]);
        assert!(find_dead_air(&tr, None).is_empty());
    }

    #[test]
    fn exactly_the_minimum_counts() {
        let tr = t(vec![vec![
            w("a", 0, 1_000_000),
            p(1_000_000, 3_500_000),
            w("b", 3_500_000, 4_000_000),
        ]]);
        assert_eq!(find_dead_air(&tr, None).len(), 1);
    }

    #[test]
    fn consecutive_pauses_and_transcript_edges() {
        // Leading silence (pause first), two chips in a row in the middle, trailing silence.
        let tr = t(vec![
            vec![
                p(0, 3_000_000),
                w("a", 3_000_000, 3_500_000),
                p(3_600_000, 5_000_000),
                p(5_000_000, 6_500_000),
            ],
            vec![w("b", 6_600_000, 7_000_000), p(7_100_000, 12_000_000)],
        ]);
        let d = find_dead_air(&tr, None);
        assert_eq!(d.len(), 3);
        assert_eq!((d[0].range.start, d[0].range.end), (350_000, 2_650_000));
        assert_eq!((d[1].range.start, d[1].range.end), (3_850_000, 6_250_000));
        assert_eq!((d[2].range.start, d[2].range.end), (7_350_000, 11_650_000));
        assert_ne!(d[0].id, d[1].id);
    }

    #[test]
    fn edges_move_inwards_onto_the_frame_grid() {
        let rate = Rational {
            num: 30000,
            den: 1001,
        };
        let tr = t(vec![
            vec![w("a", 0, 1_010_101), p(1_100_000, 4_000_000)],
            vec![w("b", 4_123_457, 4_500_000)],
        ]);
        let d = find_dead_air(&tr, Some(rate));
        assert_eq!(d.len(), 1);
        let r = &d[0].range;
        assert!(is_on_frame_grid(r.start, rate) && is_on_frame_grid(r.end, rate));
        assert!(r.start >= 1_010_101 + DEAD_AIR_KEEP_EACH_SIDE);
        assert!(r.end <= 4_123_457 - DEAD_AIR_KEEP_EACH_SIDE);
        assert!(r.start - (1_010_101 + DEAD_AIR_KEEP_EACH_SIDE) < 33_367);
    }
}
