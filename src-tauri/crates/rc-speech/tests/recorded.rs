//! Transcript building on recorded transcriber output (spec 3.7, speech row): word ends are
//! tightened, cut points fall in the gap, utterances split where expected, speech without
//! words becomes a block.
//!
//! Recordings (`tests/data/*.jsonl`) are real Parakeet output from the speech experiment,
//! converted to protocol form (times in whole microseconds, `done` carrying `speechRanges`).
//! `speech-2min` was recorded from `fixtures/out/speech-2min.wav`, whose ground truth is in
//! the fixtures manifest; the monologue recordings come with `monologue_truth.json`.

mod common;

use common::*;
use rc_speech::{BuildOptions, LevelTrack, Message, TranscriptBuilder, WordMsg};
use rc_types::{Micros, Rational, Token, Transcript};

struct Sentence {
    start: Micros,
    end: Micros,
    text: String,
}

fn speech_2min_truth() -> (Micros, Vec<Sentence>, Vec<(Micros, Micros)>) {
    let m = speech_2min_manifest();
    let duration = m["durationUs"].as_i64().expect("durationUs");
    let speech = &m["speech"];
    let sentences = speech["sentences"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| Sentence {
            start: s["startUs"].as_i64().unwrap(),
            end: s["endUs"].as_i64().unwrap(),
            text: s["text"].as_str().unwrap().to_string(),
        })
        .collect();
    let long = speech["longPauses"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            let s = (p["startSec"].as_f64().unwrap() * 1e6).round() as Micros;
            let e = (p["endSec"].as_f64().unwrap() * 1e6).round() as Micros;
            (s, e)
        })
        .collect();
    (duration, sentences, long)
}

fn monologue_truth() -> (Micros, Vec<Sentence>) {
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(data("monologue_truth.json")).unwrap()).unwrap();
    let lines = v["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| Sentence {
            start: l["start"].as_i64().unwrap(),
            end: l["end"].as_i64().unwrap(),
            text: l["text"].as_str().unwrap().to_string(),
        })
        .collect();
    (v["duration"].as_i64().unwrap(), lines)
}

/// Pairs each word token with the recorded word it came from (the builder keeps every word
/// of a recording that lies inside the source, in order).
fn paired<'a>(t: &'a Transcript, raw: &'a [WordMsg]) -> Vec<(usize, Token, &'a WordMsg)> {
    let toks = tokens(t);
    let words: Vec<(usize, Token)> =
        toks.into_iter().enumerate().filter(|(_, tok)| matches!(tok, Token::Word(_))).collect();
    assert_eq!(words.len(), raw.len(), "every recorded word is in the transcript");
    words.into_iter().zip(raw).map(|((i, tok), w)| (i, tok, w)).collect()
}

/// For each truth sentence, the index (into `pairs`) of its last word: the last word whose
/// recorded start lies before the sentence end and after the previous sentence end.
fn last_words(pairs: &[(usize, Token, &WordMsg)], truth: &[Sentence]) -> Vec<Option<usize>> {
    truth
        .iter()
        .enumerate()
        .map(|(k, s)| {
            let lo = if k == 0 { 0 } else { truth[k - 1].end };
            pairs.iter().rposition(|(_, _, w)| w.start >= lo - 100_000 && w.start < s.end - 50_000)
        })
        .collect()
}

struct Report {
    raw_overshoot: Vec<Micros>,
    tight_overshoot: Vec<Micros>,
    cuts_outside: Vec<String>,
}

/// Measures word-end tightening and cut placement at every sentence boundary followed by a
/// gap of at least `min_gap`.
fn measure(t: &Transcript, raw: &[WordMsg], truth: &[Sentence], min_gap: Micros) -> Report {
    let toks = tokens(t);
    let pairs = paired(t, raw);
    let last = last_words(&pairs, truth);
    let mut r = Report { raw_overshoot: vec![], tight_overshoot: vec![], cuts_outside: vec![] };
    for k in 0..truth.len().saturating_sub(1) {
        let (end, next_start) = (truth[k].end, truth[k + 1].start);
        if next_start - end < min_gap {
            continue;
        }
        let Some(p) = last[k] else { panic!("no word found for sentence {:?}", truth[k].text) };
        let (ti, tok, w) = &pairs[p];
        r.raw_overshoot.push(w.end - end);
        r.tight_overshoot.push(tok.end() - end);
        // Every cut point between this word and the next word lands in the true silence.
        for after in &toks[ti + 1..] {
            let c = after.cut_before();
            if !(end..=next_start).contains(&c) {
                r.cuts_outside.push(format!(
                    "after {:?}: cut at {c}, silence is {end}..{next_start}",
                    truth[k].text
                ));
            }
            if matches!(after, Token::Word(_) | Token::Unrecognised(_)) {
                break;
            }
        }
    }
    r
}

fn mean(v: &[Micros]) -> f64 {
    v.iter().sum::<Micros>() as f64 / v.len().max(1) as f64
}

#[test]
fn speech_2min_with_its_real_audio() {
    let (duration, truth, long_pauses) = speech_2min_truth();
    let msgs = recording("speech-2min.v2-int8.cpu.jsonl");
    let levels = LevelTrack::from_pcm(&wav_pcm(&speech_2min_wav()));
    let t = build(&msgs, &levels, duration, BuildOptions::default());
    check_invariants(&t, duration);
    assert!(t.complete);
    assert_eq!(t.model, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");
    let raw = recorded_words(&msgs);
    assert_eq!(word_texts(&t), raw.iter().map(|w| w.text.clone()).collect::<Vec<_>>());

    // Word ends are tightened: the last word of each sentence ran on into the following
    // silence in the recording; after building it ends close to where the speech stops.
    let r = measure(&t, &raw, &truth, 400_000);
    let (raw_mean, tight_mean) = (mean(&r.raw_overshoot), mean(&r.tight_overshoot));
    println!(
        "speech-2min: {} sentence ends; overshoot into the pause, recorded mean {:.0} us max {}, built mean {:.0} us max {} min {}",
        r.raw_overshoot.len(),
        raw_mean,
        r.raw_overshoot.iter().max().unwrap(),
        tight_mean,
        r.tight_overshoot.iter().max().unwrap(),
        r.tight_overshoot.iter().min().unwrap(),
    );
    assert!(r.raw_overshoot.len() >= 20);
    assert!(raw_mean > 150_000.0, "the recording should overshoot (mean {raw_mean})");
    assert!(tight_mean < 80_000.0, "built ends overshoot by {tight_mean:.0} us on average");
    assert!(*r.tight_overshoot.iter().max().unwrap() < 150_000, "{:?}", r.tight_overshoot);
    // ...without cutting into the speech itself.
    assert!(*r.tight_overshoot.iter().min().unwrap() > -60_000, "{:?}", r.tight_overshoot);

    // Cut points fall in the true silence between sentences.
    assert!(r.cuts_outside.is_empty(), "{:#?}", r.cuts_outside);

    // Utterances split where expected: every sentence-final word ends an utterance.
    for u in &t.utterances {
        for (i, tok) in u.tokens.iter().enumerate() {
            if let Token::Word(w) = tok
                && w.text.ends_with(['.', '?', '!'])
            {
                assert!(
                    u.tokens[i + 1..].iter().all(|t| matches!(t, Token::Pause(_))),
                    "utterance {} continues after {:?}",
                    u.index,
                    w.text
                );
            }
        }
    }
    // Pause chips: exactly the planted long pauses, plus the 1.5 s of silence at the end.
    let pauses: Vec<(Micros, Micros)> = tokens(&t)
        .iter()
        .filter_map(|tok| match tok {
            Token::Pause(p) => Some((p.start, p.end)),
            _ => None,
        })
        .collect();
    println!("speech-2min pauses: {pauses:?}");
    assert_eq!(pauses.len(), long_pauses.len() + 1, "{pauses:?}");
    for (p, truth) in pauses.iter().zip(&long_pauses) {
        assert!(truth.0 <= p.0 && p.1 <= truth.1, "pause {p:?} is not inside the silence {truth:?}");
        // Tight against the speech, with breathing room on each side.
        assert!(p.0 - truth.0 <= 300_000 && truth.1 - p.1 <= 300_000, "pause {p:?} vs silence {truth:?}");
        assert!(p.0 - truth.0 >= 100_000 && truth.1 - p.1 >= 100_000, "pause {p:?} vs silence {truth:?}");
    }
    let trailing = pauses.last().unwrap();
    assert_eq!(trailing.1, duration);
    println!("speech-2min: {} utterances", t.utterances.len());
}

#[test]
fn speech_2min_cut_points_on_the_frame_grid() {
    let (duration, truth, _) = speech_2min_truth();
    let msgs = recording("speech-2min.v2-int8.cpu.jsonl");
    let levels = LevelTrack::from_pcm(&wav_pcm(&speech_2min_wav()));
    let rate = Rational { num: 30, den: 1 };
    let t = build(&msgs, &levels, duration, BuildOptions { cut_grid: Some(rate), ..BuildOptions::default() });
    check_invariants(&t, duration);
    // Wherever the gap before a token holds a frame boundary, the cut is on one. (Words
    // that touch leave no gap; the interface snaps those cuts when it makes clips.)
    let mut prev_end = 0;
    let mut on_grid = 0;
    for tok in tokens(&t) {
        let room = rc_types::ceil_to_frame(prev_end, rate) <= tok.start();
        if room {
            assert!(rc_types::is_on_frame_grid(tok.cut_before(), rate), "{tok:?}");
            on_grid += 1;
        }
        prev_end = tok.end();
    }
    assert!(on_grid > 50, "{on_grid}");
    let r = measure(&t, &recorded_words(&msgs), &truth, 400_000);
    assert!(r.cuts_outside.is_empty(), "{:#?}", r.cuts_outside);
}

/// A level track drawn from the truth: `speech` dB inside each line, `floor` dB elsewhere.
fn truth_levels(lines: &[Sentence], duration: Micros, speech: f32, floor: f32) -> LevelTrack {
    let n = (duration / 10_000) as usize;
    LevelTrack::from_levels((0..n).map(|i| {
        let t = i as Micros * 10_000 + 5_000;
        if lines.iter().any(|l| l.start <= t && t < l.end) { speech } else { floor }
    }))
}

#[test]
fn monologue_recordings_with_levels_from_the_truth() {
    let (duration, lines) = monologue_truth();
    for (name, floor) in [
        ("monologue_clean.v2-int8.cpu.jsonl", -70.0),
        ("monologue_noisy.v2-int8.cpu.jsonl", -45.0),
        ("monologue_noisy.v2.gpu.jsonl", -45.0),
    ] {
        let msgs = recording(name);
        let raw = recorded_words(&msgs);
        let t = build(&msgs, &truth_levels(&lines, duration, -20.0, floor), duration, BuildOptions::default());
        check_invariants(&t, duration);
        assert_eq!(word_texts(&t).len(), raw.len(), "{name}");
        let r = measure(&t, &raw, &lines, 900_000);
        let (raw_mean, tight_mean) = (mean(&r.raw_overshoot), mean(&r.tight_overshoot));
        println!(
            "{name}: {} line ends; overshoot recorded mean {raw_mean:.0} us max {}, built mean {tight_mean:.0} us max {}",
            r.raw_overshoot.len(),
            r.raw_overshoot.iter().max().unwrap(),
            r.tight_overshoot.iter().max().unwrap()
        );
        assert!(raw_mean > 150_000.0, "{name}: {raw_mean}");
        assert!(tight_mean < 60_000.0, "{name}: {tight_mean}");
        assert!(r.cuts_outside.is_empty(), "{name}: {:#?}", r.cuts_outside);
        // Without any sound level, the detector's segment end still limits the overshoot.
        let t0 = build(&msgs, &LevelTrack::from_levels([]), duration, BuildOptions::default());
        check_invariants(&t0, duration);
        let r0 = measure(&t0, &raw, &lines, 900_000);
        assert!(mean(&r0.tight_overshoot) <= raw_mean, "{name}");
    }
}

#[test]
fn real_meeting_speech_keeps_every_word_in_order() {
    for name in ["ami_300_600.v2-int8.cpu.jsonl", "ami_300_600.v3-int8.cpu.jsonl"] {
        let msgs = recording(name);
        let duration = 300_000_000;
        let raw = recorded_words(&msgs);
        let t = build(&msgs, &LevelTrack::from_levels([]), duration, BuildOptions::default());
        check_invariants(&t, duration);
        assert_eq!(word_texts(&t), raw.iter().map(|w| w.text.clone()).collect::<Vec<_>>(), "{name}");
        // Long talk is split: no utterance runs past the hard limits.
        let opts = BuildOptions::default();
        for u in &t.utterances {
            let words = u.tokens.iter().filter(|t| matches!(t, Token::Word(_))).count();
            assert!(words <= opts.hard_max_words, "{name}: utterance {} has {words} words", u.index);
            assert!(u.end - u.start <= opts.hard_max_duration + 2_000_000, "{name}: utterance {}", u.index);
        }
        println!("{name}: {} words in {} utterances", raw.len(), t.utterances.len());
    }
}

#[test]
fn speech_without_words_becomes_an_unrecognised_block() {
    let (duration, _) = monologue_truth();
    let mut msgs = recording("monologue_clean.v2-int8.cpu.jsonl");
    // As in the speech experiment's one-hour run: the detector heard speech, the model
    // returned nothing. Replace the 5th segment by speech_without_words, and empty the
    // words of the 10th.
    let mut seg = 0;
    let mut dropped = Vec::new();
    for m in msgs.iter_mut() {
        if let Message::Segment { start, end, words } = m {
            seg += 1;
            if seg == 5 {
                dropped.push((*start, *end));
                *m = Message::SpeechWithoutWords { start: *start, end: *end };
            } else if seg == 10 {
                dropped.push((*start, *end));
                words.clear();
            }
        }
    }
    let t = build(&msgs, &LevelTrack::from_levels([]), duration, BuildOptions::default());
    check_invariants(&t, duration);
    let blocks: Vec<&rc_types::Utterance> =
        t.utterances.iter().filter(|u| u.tokens.iter().any(|t| matches!(t, Token::Unrecognised(_)))).collect();
    assert_eq!(blocks.len(), 2);
    for (u, (s, e)) in blocks.iter().zip(&dropped) {
        // A paragraph of its own (a pause chip may follow it), covering the detector's range.
        assert!(matches!(u.tokens[0], Token::Unrecognised(_)), "{u:?}");
        assert!(u.tokens[1..].iter().all(|t| matches!(t, Token::Pause(_))), "{u:?}");
        let tok = &u.tokens[0];
        assert!(tok.start() <= *s + 1 && tok.end() >= *e - 1, "{tok:?} vs {s}..{e}");
    }
}

#[test]
fn utterances_are_handed_on_in_batches_as_they_become_final() {
    let (duration, truth, _) = speech_2min_truth();
    let msgs = recording("speech-2min.v2-int8.cpu.jsonl");
    let levels = LevelTrack::from_pcm(&wav_pcm(&speech_2min_wav()));
    let whole = build(&msgs, &levels, duration, BuildOptions::default());
    let mut b = TranscriptBuilder::new("src", duration, BuildOptions::default());
    let mut batches = Vec::new();
    for m in &msgs {
        b.push_message(m, &levels);
        let batch = b.take_final_utterances();
        if !batch.is_empty() {
            batches.push((matches!(m, Message::Done { .. }), batch));
        }
    }
    // Most utterances are final before the end; together the batches are the transcript.
    let before_done: usize = batches.iter().filter(|(d, _)| !d).map(|(_, b)| b.len()).sum();
    assert!(before_done * 10 >= whole.utterances.len() * 8, "{before_done} of {}", whole.utterances.len());
    let all: Vec<rc_types::Utterance> = batches.into_iter().flat_map(|(_, b)| b).collect();
    assert_eq!(all, whole.utterances);
    assert!(truth.len() > 20);
}
