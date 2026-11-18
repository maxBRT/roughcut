//! Review findings (speech-review track). Each test here fails on the code as reviewed and
//! states the spec rule it checks.
mod common;

use common::*;
use rc_speech::{BuildOptions, LevelTrack};
use rc_types::{Micros, Token};

/// Spec 1.8 rule 8 ("cuts land in the silence between words, not flush against a syllable")
/// and 2.4.5 ("a cut lands in the quietest point of the gap"). In speech-2min, wherever the
/// audio has a real silence (at least 50 ms at or below -60 dBFS) right before a word's true
/// start (fixture ground truth), the cut point before that word must lie in quiet audio
/// (at or below -50 dBFS), not inside the word's first syllable.
#[test]
fn review_cut_points_at_word_boundaries_land_in_the_silence() {
    let m = speech_2min_manifest();
    let duration = m["durationUs"].as_i64().unwrap();
    let mut truth_starts: Vec<(Micros, String)> = Vec::new();
    for s in m["speech"]["sentences"].as_array().unwrap() {
        for (i, w) in s["words"].as_array().unwrap().iter().enumerate() {
            if i > 0 {
                truth_starts.push(((w["startSec"].as_f64().unwrap() * 1e6).round() as Micros, w["norm"].as_str().unwrap().into()));
            }
        }
    }
    let pcm = wav_pcm(&speech_2min_wav());
    let levels = LevelTrack::from_pcm(&pcm);
    let lv = |t: Micros| levels.level((t.max(0) / 10_000) as usize).unwrap_or(-100.0);
    let t = build(&recording("speech-2min.v2-int8.cpu.jsonl"), &levels, duration, BuildOptions::default());
    let words: Vec<Token> = tokens(&t).into_iter().filter(|t| matches!(t, Token::Word(_))).collect();
    let mut checked = 0;
    let mut bad = Vec::new();
    for (ts, text) in truth_starts {
        // A silence of 5 or more consecutive windows at or below -60 dB within 250 ms before
        // the start that reaches to within 40 ms of the start (the onset ramp of the word).
        // (Fixer's correction: the silence must lie in the gap before this word. A silence
        // followed by 100 ms or more of sound before the true start lies before the previous,
        // short word, and the spec places the cut in the gap before the token, not there.)
        let mut run = 0;
        let mut adjacent = false;
        let mut k = ts - 250_000;
        while k <= ts {
            if lv(k) <= -60.0 { run += 1; } else { run = 0; }
            if run >= 5 && k >= ts - 40_000 {
                adjacent = true;
            }
            k += 10_000;
        }
        if !adjacent {
            continue;
        }
        // The token of this word: same text, nearest in time. (Fixer's correction: the
        // nearest token of any text can be the next word when the model's times are early.)
        let Some(tok) = words
            .iter()
            .filter(|w| matches!(w, Token::Word(x) if norm(&x.text) == text))
            .min_by_key(|w| (w.start() - ts).abs())
        else {
            continue;
        };
        if (tok.start() - ts).abs() > 150_000 {
            continue;
        }
        checked += 1;
        let c = tok.cut_before();
        if lv(c) > -50.0 {
            bad.push(format!("before {text:?} (true start {ts}): cut at {c} is at {:.0} dBFS; {tok:?}", lv(c)));
        }
    }
    assert!(checked >= 20, "{checked}");
    assert!(bad.is_empty(), "{} of {checked} cut points land on sound next to a silence:\n{}", bad.len(), bad.join("\n"));
}

/// Lower case, letters and digits only (the manifest's `norm`).
fn norm(text: &str) -> String {
    text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}
