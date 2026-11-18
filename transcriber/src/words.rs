//! Turning the model's tokens into timed words.
//!
//! Parakeet TDT through sherpa-onnx gives one start time per token (seconds from the start of
//! the decoded window) and one duration per token; sherpa's own word list stays empty for this
//! model. A token beginning with a space (or SentencePiece's "▁") opens a new word; any other
//! token (a word piece or punctuation) extends the current word.

use crate::protocol::{Micros, Word};

fn secs_to_micros(s: f32) -> i64 {
    (f64::from(s) * 1_000_000.0).round() as i64
}

/// Groups `tokens` into words. `offset` is the absolute time of the decoded window's first
/// sample. A word starts at its first token's start and ends at the latest token end
/// (start + duration) inside it. Missing durations count as zero. Words with no visible text
/// are dropped.
pub fn tokens_to_words(tokens: &[String], starts: &[f32], durations: &[f32], offset: Micros) -> Vec<Word> {
    let mut words: Vec<Word> = Vec::new();
    for (i, tok) in tokens.iter().enumerate() {
        let s_rel = starts.get(i).copied().map(secs_to_micros).unwrap_or(0).max(0);
        let d_rel = durations.get(i).copied().map(secs_to_micros).unwrap_or(0).max(0);
        let s = offset + s_rel as u64;
        let e = s + d_rel as u64;
        let opens = tok.starts_with(' ') || tok.starts_with('\u{2581}');
        let text = tok.trim_start_matches([' ', '\u{2581}']);
        match words.last_mut() {
            Some(w) if !opens => {
                w.text.push_str(text);
                w.end = w.end.max(e);
            }
            _ => words.push(Word { text: text.to_string(), start: s, end: e }),
        }
    }
    words.retain(|w| !w.text.trim().is_empty());
    for w in &mut words {
        w.text = w.text.trim().to_string();
    }
    words
}

/// Makes word times safe to publish: every word lies inside `[lo, hi]`, starts no earlier
/// than the previous word ended, and ends no later than the next word starts (a word's end
/// may stretch into the following silence, never across the next word). Returns the words
/// in order with `start <= end`.
pub fn tidy_words(mut words: Vec<Word>, lo: Micros, hi: Micros) -> Vec<Word> {
    let hi = hi.max(lo);
    let mut floor = lo;
    for w in &mut words {
        w.start = w.start.clamp(floor, hi);
        w.end = w.end.clamp(w.start, hi);
        floor = w.start;
    }
    // Pull each end back to the next start.
    for i in 0..words.len().saturating_sub(1) {
        let next_start = words[i + 1].start;
        if words[i].end > next_start {
            words[i].end = next_start.max(words[i].start);
        }
    }
    words
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toks(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn groups_pieces_and_punctuation() {
        // Recorded from the speech experiment (v2 int8): "Hi everyone, and welcome".
        let t = toks(&[" H", "i", " every", "one", ",", " and", " we", "l", "c", "ome"]);
        let s = [1.74, 1.98, 2.38, 2.62, 2.86, 3.18, 3.42, 3.50, 3.58, 3.74];
        let d = [0.24, 0.24, 0.24, 0.24, 0.32, 0.24, 0.08, 0.08, 0.16, 0.08];
        let w = tokens_to_words(&t, &s, &d, 1_000_000);
        let texts: Vec<&str> = w.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(texts, ["Hi", "everyone,", "and", "welcome"]);
        assert_eq!(w[0].start, 2_740_000);
        assert_eq!(w[0].end, 3_220_000);
        assert_eq!(w[1].end, 4_180_000); // the comma's end
        assert_eq!(w[3].start, 4_420_000);
        assert_eq!(w[3].end, 4_820_000);
    }

    #[test]
    fn sentencepiece_marker_and_leading_piece() {
        let t = toks(&["ab", "\u{2581}cd", "\u{2581}"]);
        let w = tokens_to_words(&t, &[0.0, 0.5, 0.9], &[0.1, 0.1, 0.1], 0);
        let texts: Vec<&str> = w.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(texts, ["ab", "cd"]);
    }

    #[test]
    fn empty_and_missing_times() {
        assert!(tokens_to_words(&[], &[], &[], 5).is_empty());
        let w = tokens_to_words(&toks(&[" a", " b"]), &[0.1], &[], 0);
        assert_eq!(w.len(), 2);
        assert_eq!(w[1].start, 0);
    }

    #[test]
    fn tidy_keeps_order_and_bounds() {
        let w = vec![
            Word { text: "a".into(), start: 50, end: 400 },
            Word { text: "b".into(), start: 300, end: 350 },
            Word { text: "c".into(), start: 900, end: 5_000 },
        ];
        let t = tidy_words(w, 100, 1_000);
        assert_eq!((t[0].start, t[0].end), (100, 300));
        assert_eq!((t[1].start, t[1].end), (300, 350));
        assert_eq!((t[2].start, t[2].end), (900, 1_000));
        for p in t.windows(2) {
            assert!(p[0].end <= p[1].start);
        }
    }
}
