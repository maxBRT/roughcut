//! Splitting very long stretches of speech so no segment sent to the model is unbounded.
//!
//! The voice detector already cuts speech at about 20 s (`max_speech_duration`), but it can
//! hand back longer stretches when it finds no quieter spot. Anything longer than
//! [`SplitRule::max_len`] is cut at the quietest short frame inside a search window.

/// Where and how to cut a long stretch.
#[derive(Debug, Clone, Copy)]
pub struct SplitRule {
    /// Stretches up to this many samples are left whole.
    pub max_len: usize,
    /// A cut is searched from this many samples after the previous cut...
    pub search_from: usize,
    /// ...up to this many samples after it (inclusive of the frame ending there).
    pub search_to: usize,
    /// Length in samples of the frames whose energy is compared.
    pub frame: usize,
}

impl SplitRule {
    /// The rule the transcriber uses at 16 kHz: whole up to 24 s, otherwise cut between
    /// 8 s and 20 s into the piece at the quietest 20 ms.
    pub const DEFAULT: SplitRule =
        SplitRule { max_len: 24 * 16_000, search_from: 8 * 16_000, search_to: 20 * 16_000, frame: 320 };
}

/// Offsets (relative to `samples`) at which to cut. Empty when no cut is needed.
/// Every resulting piece is at most `max_len` long and, except possibly the last, at least
/// `search_from` long.
pub fn split_points(samples: &[f32], rule: SplitRule) -> Vec<usize> {
    assert!(rule.frame > 0 && rule.search_from > 0 && rule.search_from + rule.frame <= rule.search_to);
    assert!(rule.search_to <= rule.max_len);
    let mut cuts = Vec::new();
    let mut pos = 0usize;
    while samples.len() - pos > rule.max_len {
        let lo = pos + rule.search_from;
        let hi = pos + rule.search_to; // frames must end at or before hi
        let mut best = lo;
        let mut best_energy = f64::INFINITY;
        let mut f = lo;
        while f + rule.frame <= hi {
            let e: f64 = samples[f..f + rule.frame].iter().map(|&x| f64::from(x) * f64::from(x)).sum();
            if e < best_energy {
                best_energy = e;
                best = f;
            }
            f += rule.frame;
        }
        let cut = best + rule.frame / 2;
        cuts.push(cut);
        pos = cut;
    }
    cuts
}

#[cfg(test)]
mod tests {
    use super::*;

    const RULE: SplitRule = SplitRule { max_len: 100, search_from: 30, search_to: 80, frame: 10 };

    fn loud(n: usize) -> Vec<f32> {
        (0..n).map(|i| if i % 2 == 0 { 0.5 } else { -0.5 }).collect()
    }

    #[test]
    fn short_stretches_are_not_cut() {
        assert!(split_points(&loud(100), RULE).is_empty());
        assert!(split_points(&[], RULE).is_empty());
    }

    #[test]
    fn cuts_land_in_the_quiet_frame() {
        let mut s = loud(150);
        for x in &mut s[50..60] {
            *x = 0.0;
        }
        assert_eq!(split_points(&s, RULE), vec![55]);
    }

    #[test]
    fn pieces_are_bounded_for_any_length() {
        for n in [101usize, 250, 1000, 12_345] {
            let s = loud(n);
            let cuts = split_points(&s, RULE);
            let mut edges = vec![0];
            edges.extend(&cuts);
            edges.push(n);
            for w in edges.windows(2) {
                let len = w[1] - w[0];
                assert!(len <= RULE.max_len, "piece of {len} in {n}");
                assert!(len > 0);
            }
            for w in edges.windows(2).take(edges.len().saturating_sub(2)) {
                assert!(w[1] - w[0] >= RULE.search_from);
            }
        }
    }

    #[test]
    fn default_rule_is_consistent() {
        let s = vec![0.1f32; 16_000 * 61];
        let cuts = split_points(&s, SplitRule::DEFAULT);
        assert!(cuts.len() >= 2);
        assert!(cuts.iter().zip(cuts.iter().skip(1)).all(|(a, b)| b > a));
    }
}
