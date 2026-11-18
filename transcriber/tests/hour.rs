//! One hour of audio (the speech fixture looped) through the transcriber on the GPU and on the
//! processor: speed, bounded memory, and the same words in every loop.
//! Takes a few minutes; prints the measurements (run with `--nocapture` to see them).

mod common;

use common::*;
use std::sync::{Arc, Mutex};
use transcriber::protocol::{Device, Message};

const HOUR_SECS: usize = 3600;

fn hour_of_audio() -> (Vec<u8>, usize, f64) {
    let one = speech_pcm();
    let bytes = HOUR_SECS * 16_000 * 2;
    let mut pcm = Vec::with_capacity(bytes);
    while pcm.len() < bytes {
        let take = (bytes - pcm.len()).min(one.len());
        pcm.extend_from_slice(&one[..take]);
    }
    let loop_secs = one.len() as f64 / 32_000.0;
    let full_loops = bytes / one.len();
    (pcm, full_loops, loop_secs)
}

/// The largest one-off rise allowed above the plateau: one CUDA arena step (measured 1.11 to
/// 1.13 GB) plus allocator noise. On the processor nothing comes near it.
const ONE_ARENA_STEP: u64 = 1_250_000_000;

/// The middle value (0 when there is none).
fn median(mut v: Vec<u64>) -> u64 {
    v.sort_unstable();
    v.get(v.len() / 2).copied().unwrap_or(0)
}

/// The memory samples summarised per 5 minutes of audio: `start-min: min/median/max MB`.
fn buckets(s: &[(f64, u64, u64)]) -> String {
    let mut out = Vec::new();
    for b in 0..12 {
        let mut v: Vec<u64> =
            s.iter().filter(|x| x.0 >= b as f64 * 300.0 && x.0 < (b + 1) as f64 * 300.0).map(|x| x.1 / 1_000_000).collect();
        if v.is_empty() {
            continue;
        }
        v.sort_unstable();
        out.push(format!("{}m {}/{}/{}", b * 5, v[0], v[v.len() / 2], v[v.len() - 1]));
    }
    out.join(", ")
}

fn hour_run(device: &str, expect: Device) {
    let _g = heavy_lock();
    let (pcm, full_loops, loop_secs) = hour_of_audio();
    let dir = model_dir();
    // Memory samples: (audio seconds reported, private bytes, working set).
    let samples: Arc<Mutex<Vec<(f64, u64, u64)>>> = Arc::new(Mutex::new(Vec::new()));
    let peak: Arc<Mutex<u64>> = Arc::new(Mutex::new(0));
    let hook: OnMessage = {
        let samples = Arc::clone(&samples);
        let peak = Arc::clone(&peak);
        Box::new(move |m: &Message, child| {
            if let Some((private, ws, pk)) = process_memory(child) {
                *peak.lock().unwrap() = pk;
                if let Message::Progress { audio_seconds } = m {
                    samples.lock().unwrap().push((*audio_seconds, private, ws));
                }
            }
        })
    };
    let run = run_with(
        &["--model-dir", dir.to_str().unwrap(), "--device", device],
        pcm,
        Feed::AllAtOnce,
        Some(hook),
    );
    let words = check_well_formed(&run);
    let Some(Message::Ready { device: d, .. }) = run.msgs().next() else { panic!() };
    assert_eq!(*d, expect, "stderr:\n{}", run.stderr);

    let ready_at = run.messages[0].at;
    let done_at = run.messages.last().unwrap().at;
    let wall = done_at.duration_since(run.started).as_secs_f64();
    let after_load = done_at.duration_since(ready_at).as_secs_f64();

    // Same words in every loop: the first full loop's word count, times the loops, within 3 %.
    let loop_us = (loop_secs * 1e6) as u64;
    let first_loop = words.iter().filter(|w| w.start < loop_us).count();
    let in_full_loops = words.iter().filter(|w| w.end <= loop_us * full_loops as u64).count();
    let expected = first_loop * full_loops;
    let ratio = in_full_loops as f64 / expected as f64;
    assert!((0.97..=1.03).contains(&ratio), "{in_full_loops} words in {full_loops} loops vs {expected} expected");
    let last = words.last().unwrap();
    assert!(last.end > (HOUR_SECS as u64 - 300) * 1_000_000, "words stop at {} µs", last.end);
    assert!(last.end <= HOUR_SECS as u64 * 1_000_000);
    let speech = match run.msgs().last() {
        Some(Message::Done { speech_ranges }) => speech_ranges.len(),
        _ => unreachable!(),
    };

    // Bounded memory: what the process holds late in the hour is not more than it held in the
    // first half (plus a margin for allocator noise).
    //
    // How the GPU process's memory behaves (measured 2026-11-15, private bytes logged per 5 min
    // of audio over repeated runs): onnxruntime's CUDA arena grows in steps of about 1.1 GB
    // (4.9 -> 6.0 -> 7.1 GB) whenever a batch (up to 4 pieces of up to 20 s, `--batch` default)
    // needs a bigger shape than any before; it reached its plateau within the first 10 minutes
    // in every run, then drifted by under 30 MB to the end. At the end of the input the voice
    // detector's flush queues every remaining piece at once, so full batches of long pieces are
    // decoded together and a further one-off step of about 1.1 GB can appear right there (seen
    // in 2 of 3 runs alone, and in a whole-workspace run). Comparing the single largest late
    // sample therefore failed intermittently without any leak. So: `late` is the median of the
    // samples from 45 minutes up to just before the end of the input (a leak raises every one
    // of them; one spike does not move the median), compared with the largest sample of the
    // first half (which includes the warm-up steps); and the peak is bounded separately to the
    // plateau plus at most one more arena step, so a second growth or a large leak still fails.
    let s = samples.lock().unwrap().clone();
    assert!(s.len() >= 10, "too few memory samples: {}", s.len());
    let early = s.iter().filter(|x| x.0 >= 300.0 && x.0 < 1800.0).map(|x| x.1).max().unwrap_or(0);
    let late = median(s.iter().filter(|x| x.0 >= 2700.0 && x.0 < HOUR_SECS as f64 - 60.0).map(|x| x.1).collect());
    let peak = *peak.lock().unwrap();
    println!(
        "HOUR {device}: {:.0} s audio, wall {wall:.1} s ({:.1}x real time), after load {after_load:.1} s ({:.1}x), \
         {} words, {speech} speech ranges, private bytes early {:.0} MB late {:.0} MB peak {:.0} MB",
        HOUR_SECS as f64,
        HOUR_SECS as f64 / wall,
        HOUR_SECS as f64 / after_load,
        words.len(),
        early as f64 / 1e6,
        late as f64 / 1e6,
        peak as f64 / 1e6
    );
    println!("HOUR {device} private MB per 5 min of audio (min/median/max): {}", buckets(&s));
    let tail: Vec<String> =
        s.iter().filter(|x| x.0 >= HOUR_SECS as f64 - 60.0).map(|x| format!("{:.0}s {} MB", x.0, x.1 / 1_000_000)).collect();
    println!("HOUR {device} last minute of input: {}", tail.join(", "));
    println!("HOUR {device} stderr:\n{}", run.stderr);
    if early > 0 && late > 0 {
        assert!(late <= early + 150_000_000, "memory grew from {early} to {late} bytes (median of the last quarter)");
        assert!(peak <= early + ONE_ARENA_STEP, "peak {peak} bytes is more than one arena step above the plateau {early}");
    } else {
        panic!("memory samples missing: early {early}, late {late}");
    }
}

#[test]
fn one_hour_on_the_gpu() {
    hour_run("gpu", Device::Gpu);
}

#[test]
fn one_hour_on_the_processor() {
    hour_run("cpu", Device::Cpu);
}
