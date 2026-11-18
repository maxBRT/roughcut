//! Property checks of transcript building on generated transcriber output: whatever the
//! messages (overlapping, unsorted or empty words, words outside their segment or the
//! source, speech without words, ranges only in `done`) and whatever the sound, tokens never
//! overlap, every `cutBefore` lies between the previous token's end and the token's start,
//! every time stays inside the source, and utterances are numbered and handed on exactly once.
//! Streaming the same audio and messages gives the same transcript as building afterwards.
//!
//! Cases come from a seeded generator, so a failure names its seed and replays exactly.

mod common;

use common::*;
use rc_speech::{BuildOptions, LevelTrack, Message, RangeMsg, TranscriptBuilder, WordMsg};
use rc_types::{Micros, Rational, Transcript, Utterance};

/// SplitMix64: small, seedable, good enough for test cases.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in `lo..=hi`.
    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        if hi <= lo {
            return lo;
        }
        lo + (self.next() % ((hi - lo + 1) as u64)) as i64
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[(self.next() % items.len() as u64) as usize]
    }
}

const TEXTS: &[&str] = &["so", "the", "Hello,", "um", "plan.", "really?", "wait!", "and", "(aside)", "uh", " ", ""];

/// A run of transcriber output over a source of `duration`.
struct Case {
    duration: Micros,
    messages: Vec<Message>,
    /// 16 kHz PCM, one constant sample value per 10 ms window.
    pcm: Vec<u8>,
    opts: BuildOptions,
}

fn gen_case(rng: &mut Rng, in_order: bool) -> Case {
    let duration = rng.range(1, 120) * 1_000_000 + rng.range(0, 999_999);
    let mut messages = vec![Message::Ready { model: "gen".into(), device: rc_speech::DeviceUsed::Cpu, fallback: false }];
    let mut ranges = Vec::new();
    let mut t = rng.range(0, 3_000_000);
    while t < duration + 2_000_000 {
        let len = rng.range(1, 8_000_000);
        let (start, end) = (t, t + len);
        if rng.chance(15) {
            messages.push(Message::SpeechWithoutWords { start, end });
        } else {
            let mut words = Vec::new();
            let mut w = start - rng.range(0, 300_000);
            let n = rng.range(0, 25);
            for _ in 0..n {
                let ws = w.max(0);
                let we = ws + rng.range(0, 900_000);
                words.push(WordMsg { text: rng.pick(TEXTS).to_string(), start: ws, end: we });
                // Words may overlap, touch or leave gaps of any size.
                w = ws + rng.range(-200_000, 1_600_000);
            }
            if rng.chance(20) {
                // Unsorted words.
                let k = words.len();
                if k > 1 {
                    words.swap(0, k - 1);
                }
            }
            messages.push(Message::Segment { start, end, words });
        }
        if rng.chance(80) {
            ranges.push(RangeMsg { start, end });
        }
        if rng.chance(10) {
            // A range only `done` reports.
            let s = end + rng.range(0, 500_000);
            ranges.push(RangeMsg { start: s, end: s + rng.range(1, 2_000_000) });
        }
        t = end + rng.range(-500_000, 4_000_000).max(if in_order { 0 } else { -500_000 });
        if rng.chance(10) {
            messages.push(Message::Progress { audio_seconds: t as f64 / 1e6 });
        }
    }
    if !in_order && messages.len() > 3 && rng.chance(50) {
        let k = messages.len();
        messages.swap(1, k - 1);
    }
    messages.push(Message::Done { speech_ranges: ranges });

    // Sound: speech-like loudness inside segments, a noise floor elsewhere, some digital silence.
    let windows = (duration / 10_000) as usize + rng.range(-50, 50).max(0) as usize;
    let floor = *rng.pick(&[0i16, 3, 30, 300]);
    let mut pcm = Vec::with_capacity(windows * 320);
    for i in 0..windows {
        let at = i as Micros * 10_000;
        let in_speech = messages.iter().any(|m| match m {
            Message::Segment { start, end, .. } | Message::SpeechWithoutWords { start, end } => {
                *start <= at && at < *end
            }
            _ => false,
        });
        let v: i16 = if in_speech && !rng.chance(25) { rng.range(1000, 20000) as i16 } else { floor };
        for _ in 0..160 {
            pcm.extend_from_slice(&v.to_le_bytes());
        }
    }
    let grid = *rng.pick(&[
        None,
        Some(Rational { num: 30, den: 1 }),
        Some(Rational { num: 30000, den: 1001 }),
        Some(Rational { num: 25, den: 1 }),
        Some(Rational { num: 60, den: 1 }),
    ]);
    let opts = BuildOptions {
        pause_min: rng.range(300_000, 2_000_000),
        pause_margin: rng.range(0, 300_000),
        soft_max_words: rng.range(1, 40) as usize,
        hard_max_words: rng.range(40, 80) as usize,
        cut_grid: grid,
        ..BuildOptions::default()
    };
    Case { duration, messages, pcm, opts }
}

/// Builds with the whole sound known from the start; returns the transcript and the batches.
fn build_offline(c: &Case, levels: &LevelTrack) -> (Transcript, Vec<Vec<Utterance>>) {
    let mut b = TranscriptBuilder::new("src", c.duration, c.opts.clone());
    let mut batches = Vec::new();
    for m in &c.messages {
        b.push_message(m, levels);
        let batch = b.take_final_utterances();
        if !batch.is_empty() {
            batches.push(batch);
        }
    }
    assert!(b.is_complete());
    (b.into_transcript(), batches)
}

/// Builds while the sound arrives, as the client does: each message only once the audio up
/// to its end has been fed (plus a random lead), with `advance` at random moments.
fn build_streaming(c: &Case, rng: &mut Rng) -> Transcript {
    let mut levels = LevelTrack::new();
    let mut fed = 0usize;
    let mut feed_until = |levels: &mut LevelTrack, t: Micros| {
        let want = ((t.max(0) as usize / 10_000) * 320).min(c.pcm.len());
        if want > fed {
            levels.push_pcm(&c.pcm[fed..want]);
            fed = want;
        }
    };
    let mut b = TranscriptBuilder::new("src", c.duration, c.opts.clone());
    let mut released = Vec::new();
    for m in &c.messages {
        match m {
            Message::Segment { end, .. } | Message::SpeechWithoutWords { end, .. } => {
                feed_until(&mut levels, *end + rng.range(0, 1_000_000));
            }
            Message::Done { .. } => {
                feed_until(&mut levels, Micros::MAX / 2);
                levels.mark_ended();
            }
            _ => {}
        }
        b.push_message(m, &levels);
        if rng.chance(30) {
            b.advance(&levels);
        }
        released.extend(b.take_final_utterances());
    }
    let t = b.into_transcript();
    assert_eq!(released, t.utterances, "batches differ from the transcript");
    t
}

#[test]
fn tokens_never_overlap_and_cuts_lie_in_the_gap() {
    for seed in 0..400u64 {
        let mut rng = Rng(seed);
        let c = gen_case(&mut rng, false);
        for levels in [LevelTrack::from_pcm(&c.pcm), LevelTrack::from_levels([])] {
            let (t, batches) = std::panic::catch_unwind(|| build_offline(&c, &levels))
                .unwrap_or_else(|_| panic!("seed {seed}: the builder panicked"));
            let r = std::panic::catch_unwind(|| check_invariants(&t, c.duration));
            assert!(r.is_ok(), "seed {seed} breaks an invariant");
            assert!(t.complete);
            let all: Vec<Utterance> = batches.into_iter().flatten().collect();
            assert_eq!(all, t.utterances, "seed {seed}: batches differ from the transcript");
            if let Some(rate) = c.opts.cut_grid {
                // Pause chips edges sit on the grid wherever there is room for it.
                for tok in tokens(&t) {
                    if let rc_types::Token::Pause(p) = tok
                        && p.start > 0
                        && p.end < c.duration
                    {
                        let room = rc_types::ceil_to_frame(p.start, rate) < p.end;
                        assert!(!room || rc_types::is_on_frame_grid(p.cut_before, rate), "seed {seed}: {p:?}");
                    }
                }
            }
        }
    }
}

#[test]
fn streaming_gives_the_same_transcript_as_building_afterwards() {
    for seed in 1000..1300u64 {
        let mut rng = Rng(seed);
        let c = gen_case(&mut rng, true);
        let (offline, _) = build_offline(&c, &LevelTrack::from_pcm(&c.pcm));
        let streamed = build_streaming(&c, &mut rng);
        assert_eq!(streamed, offline, "seed {seed}");
        check_invariants(&streamed, c.duration);
    }
}

