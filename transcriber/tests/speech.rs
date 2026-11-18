//! Integration tests: the built transcriber on the two-minute speech fixture, on both devices,
//! fed slowly, and on the error and edge cases of the protocol (spec 3.5.7).

mod common;

use common::*;
use std::time::Duration;
use transcriber::protocol::{Device, ErrorCode, Message, Word};

const PAUSE_SLACK_BEFORE_US: i64 = 400_000; // a first word may start up to ~0.25 s early (padding)
const PAUSE_SLACK_AFTER_US: i64 = 1_000_000; // a last word's end may run up to ~0.9 s into a pause

fn model_args<'a>(device: &'a str, dir: &'a str) -> Vec<&'a str> {
    vec!["--model-dir", dir, "--device", device]
}

fn sentences(manifest: &serde_json::Value) -> Vec<(String, i64, i64)> {
    manifest["speech"]["sentences"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["id"].as_str().unwrap().to_string(), s["startUs"].as_i64().unwrap(), s["endUs"].as_i64().unwrap()))
        .collect()
}

/// Everything the speech fixture must produce on one device.
fn check_speech_run(run: &Run, device: Device) {
    let manifest = speech_manifest();
    let words = check_well_formed(run);
    match run.msgs().next() {
        Some(Message::Ready { device: d, fallback, model }) => {
            assert_eq!(*d, device, "stderr:\n{}", run.stderr);
            assert!(!fallback);
            assert!(model.contains("parakeet-tdt-0.6b-v2") && model.contains("sherpa-onnx 2.0.1"), "{model}");
        }
        other => panic!("first message {other:?}"),
    }
    let segments = run.msgs().filter(|m| matches!(m, Message::Segment { .. })).count();
    assert!(segments >= 10, "only {segments} segments");

    // Every word falls inside a sentence of the script (with the known timing slack).
    let sents = sentences(&manifest);
    for w in &words {
        let inside = sents.iter().any(|(_, s, e)| {
            w.start as i64 >= s - PAUSE_SLACK_BEFORE_US && w.end as i64 <= e + PAUSE_SLACK_AFTER_US
        });
        assert!(inside, "word {w:?} is not inside any known sentence range");
    }
    // Every sentence (including false starts and asides) has words.
    for (id, s, e) in &sents {
        assert!(
            words.iter().any(|w| (w.start as i64) < *e && (w.end as i64) > *s),
            "sentence {id} ({s}..{e}) has no words"
        );
    }
    // The 6-second pause holds no words and no detected speech.
    let six = manifest["speech"]["longPauses"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| (p["durationSec"].as_f64().unwrap() - 6.0).abs() < 0.01)
        .expect("the 6 s pause is in the manifest");
    let p0 = (six["startSec"].as_f64().unwrap() * 1e6) as i64 + PAUSE_SLACK_AFTER_US;
    let p1 = (six["endSec"].as_f64().unwrap() * 1e6) as i64 - PAUSE_SLACK_BEFORE_US;
    assert!(p1 - p0 > 4_000_000);
    for w in &words {
        assert!((w.end as i64) <= p0 || (w.start as i64) >= p1, "word {w:?} inside the 6 s pause");
    }
    let Some(Message::Done { speech_ranges }) = run.msgs().last() else { unreachable!() };
    for r in speech_ranges {
        assert!((r.end as i64) <= p0 || (r.start as i64) >= p1, "speech range {r:?} inside the 6 s pause");
    }
    for (id, s, e) in &sents {
        assert!(
            speech_ranges.iter().any(|r| (r.start as i64) < *e && (r.end as i64) > *s),
            "sentence {id} is not in any speech range"
        );
    }

    // Text: retakes, false starts, asides and fillers are kept.
    let text: Vec<String> = words.iter().map(|w| norm(&w.text)).filter(|w| !w.is_empty()).collect();
    let joined = text.join(" ");
    let expect = [
        ("early numbers show completion going", 2),     // retake group A
        ("the redesign is blocked on the", 2),          // retake group B
        ("we have two open roles", 3),                  // retake group C
        ("the offsite is on", 3),                       // false start + retake group D
        ("so the onboarding", 2),                       // false start
        ("and in the mean", 1),                         // false start
        ("and in the meantime", 1),                     // ...and the full line
        ("wait let me redo that", 1),                   // aside
        ("sorry hang on i lost my notes", 1),           // aside
        ("you know", 1),                                // filler
        ("so like we are waiting", 1),                  // fillers
        ("okay hiring", 1),                             // filler
    ];
    for (phrase, n) in expect {
        let got = count_phrase(&text, phrase);
        assert!(got >= n, "\"{phrase}\" found {got} times, expected at least {n}\n{joined}");
    }
    let um = text.iter().filter(|w| *w == "um").count();
    let uh = text.iter().filter(|w| *w == "uh").count();
    // The script plants 4 "um" and 3 "uh". The speech experiment found the recogniser
    // occasionally hears an "uh" as "a"; allow one such miss.
    assert!(um >= 4, "um: {um}\n{joined}");
    assert!(um + uh >= 6, "um {um} + uh {uh} < 6\n{joined}");

    // Overall recall of the script's words (numbers excluded: "sixty one" is written "61").
    let numbers = ["sixty", "one", "eight", "twentieth", "fourth", "two", "three", "percent"];
    let expected: Vec<String> = manifest["speech"]["expectedWords"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| norm(w["text"].as_str().unwrap()))
        .filter(|w| !w.is_empty() && !numbers.contains(&w.as_str()))
        .collect();
    let got: Vec<String> = text.iter().filter(|w| !numbers.contains(&w.as_str())).cloned().collect();
    let recall = lcs(&expected, &got) as f64 / expected.len() as f64;
    assert!(recall >= 0.95, "word recall {recall:.3}\n{joined}");
    println!(
        "{device:?}: {segments} segments, {} words, recall {recall:.3}, um {um}, uh {uh}, wall {:.1} s",
        words.len(),
        run.messages.last().unwrap().at.duration_since(run.started).as_secs_f64()
    );
}

#[test]
fn speech_fixture_on_the_processor() {
    let _g = heavy_lock();
    let dir = model_dir();
    let run = run(&model_args("cpu", dir.to_str().unwrap()), speech_pcm(), Feed::AllAtOnce);
    check_speech_run(&run, Device::Cpu);
}

#[test]
fn speech_fixture_on_the_gpu() {
    let _g = heavy_lock();
    let dir = model_dir();
    let run = run(&model_args("gpu", dir.to_str().unwrap()), speech_pcm(), Feed::AllAtOnce);
    check_speech_run(&run, Device::Gpu);
}

#[test]
fn auto_picks_the_gpu_here() {
    let _g = heavy_lock();
    let dir = model_dir();
    // A few seconds of audio are enough to see the choice.
    let pcm = speech_pcm()[..16_000 * 2 * 8].to_vec();
    let run = run(&model_args("auto", dir.to_str().unwrap()), pcm, Feed::AllAtOnce);
    check_well_formed(&run);
    assert_eq!(
        run.msgs().next(),
        Some(&Message::Ready {
            model: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2 (sherpa-onnx 2.0.1)".into(),
            device: Device::Gpu,
            fallback: false
        })
    );
}

#[test]
fn words_arrive_while_input_is_still_being_read() {
    let _g = heavy_lock();
    let dir = model_dir();
    // One second of audio every 100 ms: 127.6 s of audio over about 13 s.
    let feed = Feed::Paced { chunk: 32_000, every: Duration::from_millis(100) };
    let run = run(&model_args("cpu", dir.to_str().unwrap()), speech_pcm(), feed);
    let words = check_well_formed(&run);
    assert!(words.len() > 200);
    let closed = run.input_closed.expect("input was closed");
    let early: Vec<_> = run
        .messages
        .iter()
        .filter(|r| matches!(r.msg, Message::Segment { .. }) && r.at < closed)
        .collect();
    let total = run.msgs().filter(|m| matches!(m, Message::Segment { .. })).count();
    println!(
        "slow feed: {} of {total} segments arrived before input ended; input took {:.1} s",
        early.len(),
        closed.duration_since(run.started).as_secs_f64()
    );
    assert!(early.len() * 2 >= total, "only {} of {total} segments before input ended", early.len());
    assert!(run.msgs().any(|m| matches!(m, Message::Progress { .. })), "no progress messages");
}

fn expect_error(run: &Run, code: ErrorCode) {
    let msgs: Vec<&Message> = run.msgs().collect();
    assert_eq!(msgs.len(), 1, "expected exactly one error line, got {msgs:?}; stderr:\n{}", run.stderr);
    match msgs[0] {
        Message::Error { code: c, message } => {
            assert_eq!(*c, code, "{message}");
            assert!(!message.is_empty());
        }
        other => panic!("expected an error, got {other:?}"),
    }
    assert!(!run.status.success());
    assert_eq!(run.status.code(), Some(1));
}

#[test]
fn bad_arguments() {
    for args in [
        vec![],
        vec!["--model-dir"],
        vec!["--model-dir", "x", "--device", "tpu"],
        vec!["--model-dir", "x", "--device", "cpu", "--colour", "blue"],
        vec!["--device", "cpu"],
    ] {
        let r = run(&args, Vec::new(), Feed::AllAtOnce);
        expect_error(&r, ErrorCode::BadArguments);
    }
}

#[test]
fn missing_model_folder() {
    let missing = root().join(".cache-dev/speech/no-such-folder");
    let r = run(&model_args("auto", missing.to_str().unwrap()), vec![0; 3200], Feed::AllAtOnce);
    expect_error(&r, ErrorCode::ModelMissing);
}

#[test]
fn folder_without_the_model() {
    let d = temp_dir("empty-models");
    link(&model_dir().join("silero_vad.onnx"), &d.join("silero_vad.onnx"));
    let r = run(&model_args("cpu", d.to_str().unwrap()), vec![0; 3200], Feed::AllAtOnce);
    expect_error(&r, ErrorCode::ModelMissing);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn missing_voice_detector_model() {
    let dir = model_dir();
    let r = run(
        &["--model-dir", dir.to_str().unwrap(), "--device", "cpu", "--vad-model", "C:/no/such/silero.onnx"],
        Vec::new(),
        Feed::AllAtOnce,
    );
    expect_error(&r, ErrorCode::ModelMissing);
}

#[test]
fn broken_voice_detector_model() {
    let d = temp_dir("broken-vad");
    std::fs::write(d.join("silero_vad.onnx"), b"this is not an onnx model").unwrap();
    let dir = model_dir();
    let vad = d.join("silero_vad.onnx");
    let r = run(
        &["--model-dir", dir.to_str().unwrap(), "--device", "cpu", "--vad-model", vad.to_str().unwrap()],
        Vec::new(),
        Feed::AllAtOnce,
    );
    expect_error(&r, ErrorCode::ModelLoadFailed);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn broken_model_files() {
    let _g = heavy_lock();
    let src = model_dir().join("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");
    let d = temp_dir("broken-model");
    let fam = d.join("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");
    std::fs::create_dir_all(&fam).unwrap();
    link(&model_dir().join("silero_vad.onnx"), &d.join("silero_vad.onnx"));
    for f in ["decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"] {
        link(&src.join(f), &fam.join(f));
    }
    // A truncated encoder, as after an interrupted download.
    let mut enc = std::fs::File::open(src.join("encoder.int8.onnx")).unwrap();
    let mut head = vec![0u8; 1_000_000];
    std::io::Read::read_exact(&mut enc, &mut head).unwrap();
    std::fs::write(fam.join("encoder.int8.onnx"), &head).unwrap();
    for device in ["cpu", "auto", "gpu"] {
        let r = run(&model_args(device, d.to_str().unwrap()), vec![0; 3200], Feed::AllAtOnce);
        expect_error(&r, ErrorCode::ModelLoadFailed);
    }
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn gpu_requested_without_the_gpu_model_falls_back() {
    let _g = heavy_lock();
    let src = model_dir().join("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");
    let d = temp_dir("int8-only");
    let fam = d.join("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");
    std::fs::create_dir_all(&fam).unwrap();
    link(&model_dir().join("silero_vad.onnx"), &d.join("silero_vad.onnx"));
    for f in ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"] {
        link(&src.join(f), &fam.join(f));
    }
    let r = run(&model_args("gpu", d.to_str().unwrap()), Vec::new(), Feed::AllAtOnce);
    check_well_formed(&r);
    match r.msgs().next() {
        Some(Message::Ready { device, fallback, .. }) => {
            assert_eq!(*device, Device::Cpu);
            assert!(*fallback, "gpu was asked for, the processor is used");
        }
        other => panic!("{other:?}"),
    }
    let _ = std::fs::remove_dir_all(&d);
}

/// The fp32 (GPU) model's tokens.txt was cut short, the int8 model is intact: the program must
/// not die inside sherpa-onnx but use int8 on the processor and say it fell back.
#[test]
fn damaged_gpu_model_falls_back_to_the_intact_processor_model() {
    let _g = heavy_lock();
    let fp32_src = model_dir().join("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2");
    let int8_src = model_dir().join("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");
    let d = temp_dir("fp32-broken-tokens");
    let fp32 = d.join("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2");
    let int8 = d.join("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");
    std::fs::create_dir_all(&fp32).unwrap();
    std::fs::create_dir_all(&int8).unwrap();
    link(&model_dir().join("silero_vad.onnx"), &d.join("silero_vad.onnx"));
    for f in ["encoder.onnx", "encoder.weights", "decoder.onnx", "joiner.onnx"] {
        link(&fp32_src.join(f), &fp32.join(f));
    }
    let tokens = std::fs::read(fp32_src.join("tokens.txt")).unwrap();
    std::fs::write(fp32.join("tokens.txt"), &tokens[..tokens.len() * 2 / 3]).unwrap();
    for f in ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"] {
        link(&int8_src.join(f), &int8.join(f));
    }
    let pcm = speech_pcm()[..16_000 * 2 * 20].to_vec();
    for device in ["gpu", "auto"] {
        let r = run(&model_args(device, d.to_str().unwrap()), pcm.clone(), Feed::AllAtOnce);
        let words = check_well_formed(&r);
        match r.msgs().next() {
            Some(Message::Ready { device: used, fallback, model }) => {
                assert_eq!((*used, *fallback), (Device::Cpu, true), "--device {device}");
                assert!(model.contains("-int8"), "{model}");
            }
            other => panic!("{other:?}"),
        }
        assert!(!words.is_empty(), "the int8 model transcribed nothing; stderr:\n{}", r.stderr);
        assert!(
            r.stderr.contains("fp32 model not usable") && r.stderr.contains("tokens.txt"),
            "the reason is on standard error:\n{}",
            r.stderr
        );
    }
    let _ = std::fs::remove_dir_all(&d);
}

fn check_no_speech(run: &Run) {
    let words: Vec<Word> = check_well_formed(run);
    assert!(words.is_empty(), "{words:?}");
    assert!(!run.msgs().any(|m| matches!(m, Message::SpeechWithoutWords { .. })));
    assert_eq!(run.msgs().last(), Some(&Message::Done { speech_ranges: vec![] }));
}

#[test]
fn empty_input() {
    let _g = heavy_lock();
    let dir = model_dir();
    let r = run(&model_args("cpu", dir.to_str().unwrap()), Vec::new(), Feed::AllAtOnce);
    check_no_speech(&r);
    assert_eq!(r.messages.len(), 2, "ready then done");
}

#[test]
fn input_ending_mid_sample() {
    let _g = heavy_lock();
    let dir = model_dir();
    for input in [vec![7u8], vec![0u8; 16_001]] {
        let r = run(&model_args("cpu", dir.to_str().unwrap()), input, Feed::AllAtOnce);
        check_no_speech(&r);
    }
    // Speech that ends mid-sample is still transcribed.
    let mut pcm = speech_pcm()[..16_000 * 2 * 5].to_vec();
    pcm.push(0x55);
    let r = run(&model_args("cpu", dir.to_str().unwrap()), pcm, Feed::AllAtOnce);
    let words = check_well_formed(&r);
    let text: Vec<String> = words.iter().map(|w| norm(&w.text)).collect();
    assert!(count_phrase(&text, "this is the weekly update") == 1, "{text:?}");
}

#[test]
fn silence_only() {
    let _g = heavy_lock();
    let dir = model_dir();
    let r = run(&model_args("cpu", dir.to_str().unwrap()), vec![0u8; 16_000 * 2 * 30], Feed::AllAtOnce);
    check_no_speech(&r);
}

#[test]
fn exits_when_its_output_is_closed() {
    let _g = heavy_lock();
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    let dir = model_dir();
    let mut child = Command::new(exe())
        .args(model_args("cpu", dir.to_str().unwrap()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let mut first = String::new();
    out.read_line(&mut first).unwrap();
    assert!(matches!(parse_line(first.trim()), Message::Ready { .. }));
    drop(out); // the reader goes away
    let pcm = speech_pcm();
    let feeder = std::thread::spawn(move || {
        // Keep feeding (looping the audio) until the program stops reading.
        for _ in 0..20 {
            if stdin.write_all(&pcm).is_err() {
                return true;
            }
        }
        false
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(std::time::Instant::now() < deadline, "the transcriber kept running with nobody reading");
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(status.code(), Some(transcriber::protocol::EXIT_OUTPUT_CLOSED));
    assert!(feeder.join().unwrap(), "input was still accepted after exit");
}

#[test]
fn can_be_killed_at_any_time() {
    let _g = heavy_lock();
    use std::io::Write;
    use std::process::{Command, Stdio};
    let dir = model_dir();
    for delay_ms in [0u64, 300, 4_000] {
        let mut child = Command::new(exe())
            .args(model_args("cpu", dir.to_str().unwrap()))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let pcm = speech_pcm();
        let feeder = std::thread::spawn(move || {
            let _ = stdin.write_all(&pcm);
        });
        std::thread::sleep(Duration::from_millis(delay_ms));
        child.kill().unwrap();
        let status = child.wait().unwrap();
        assert!(!status.success());
        feeder.join().unwrap();
    }
}

/// Every line of the script joined with no pause at all: about 97 s of speech the voice
/// detector cannot close at a pause. It must still come out in bounded segments, with every
/// word once (no words repeated where a long stretch was cut).
#[test]
fn long_speech_without_pauses_is_split_into_bounded_segments() {
    let _g = heavy_lock();
    let manifest = speech_manifest();
    let pcm = speech_pcm();
    let mut joined = Vec::new();
    for s in manifest["speech"]["sentences"].as_array().unwrap() {
        let a = s["startSample16k"].as_u64().unwrap() as usize * 2;
        let b = s["endSample16k"].as_u64().unwrap() as usize * 2;
        joined.extend_from_slice(&pcm[a..b.min(pcm.len())]);
    }
    let total_us = joined.len() as u64 / 2 * 125 / 2;
    assert!(total_us > 80_000_000, "{total_us}");
    let dir = model_dir();
    let run = run(&model_args("cpu", dir.to_str().unwrap()), joined, Feed::AllAtOnce);
    let words = check_well_formed(&run);
    let mut longest = 0u64;
    let mut segments = 0;
    for m in run.msgs() {
        if let Message::Segment { start, end, .. } | Message::SpeechWithoutWords { start, end } = m {
            longest = longest.max(end - start);
            segments += 1;
        }
    }
    // The detector cuts at 20 s and the transcriber at 24 s at the latest; words may reach
    // up to the 250 ms padding beyond a stretch.
    assert!(longest <= 24_600_000, "a segment of {longest} µs");
    assert!(segments >= 5, "{segments} segments for {total_us} µs of speech");
    let Some(Message::Done { speech_ranges }) = run.msgs().last() else { unreachable!() };
    let covered: u64 = speech_ranges.iter().map(|r| r.end - r.start).sum();
    assert!(covered * 10 >= total_us * 9, "speech ranges cover {covered} of {total_us} µs");
    let last = words.last().expect("words").end;
    assert!(last <= total_us);

    let text: Vec<String> = words.iter().map(|w| norm(&w.text)).filter(|w| !w.is_empty()).collect();
    let numbers = ["sixty", "one", "eight", "twentieth", "fourth", "two", "three", "percent"];
    let expected: Vec<String> = manifest["speech"]["expectedWords"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| norm(w["text"].as_str().unwrap()))
        .filter(|w| !w.is_empty() && !numbers.contains(&w.as_str()))
        .collect();
    let got: Vec<String> = text.iter().filter(|w| !numbers.contains(&w.as_str())).cloned().collect();
    let common = lcs(&expected, &got);
    let recall = common as f64 / expected.len() as f64;
    let extra = got.len().saturating_sub(common);
    println!(
        "no pauses: {segments} segments, longest {:.1} s, {} words, recall {recall:.3}, {extra} extra words",
        longest as f64 / 1e6,
        words.len()
    );
    assert!(recall >= 0.9, "word recall {recall:.3}\n{}", text.join(" "));
    // Words cut in two at a split may come out as two pieces; anything more would mean words
    // decoded twice.
    assert!(extra <= segments + 5, "{extra} words beyond the script\n{}", text.join(" "));
    assert_eq!(count_phrase(&text, "we have two open roles"), 3, "{}", text.join(" "));
}
