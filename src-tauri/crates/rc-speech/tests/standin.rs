//! The transcriber client against the stand-in transcriber (`src/bin/standin.rs`), which
//! speaks the protocol and replays recorded output while reading real PCM (spec 3.7, speech
//! row): the normal run, a transcriber that writes a lot before reading, a slow reader, a
//! crash mid-stream, malformed output, reported errors, cancellation. Every failure must be
//! `transcriber_failed` (or `cancelled`), never a panic or a hang.

mod common;

use std::io::{Cursor, Read};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use common::*;
use rc_speech::{
    transcribe, BuildOptions, CancelToken, DeviceUsed, LevelTrack, SpeechEvent, TranscribeJob, TranscriberCommand,
};
use rc_types::{AppError, ErrorCode, SpeechDevice, Transcript};

const RECORDING: &str = "speech-2min.v2-int8.cpu.jsonl";

/// A model folder holding the stand-in's `standin.json`.
fn model_dir(test: &str, config: serde_json::Value) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rc-speech-standin-{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("standin.json"), config.to_string()).unwrap();
    dir
}

fn command(dir: PathBuf) -> TranscriberCommand {
    TranscriberCommand {
        program: PathBuf::from(env!("CARGO_BIN_EXE_rc-speech-standin")),
        model_dir: dir,
        device: SpeechDevice::Auto,
        vad_model: None,
    }
}

fn config(scenario: &str) -> serde_json::Value {
    serde_json::json!({ "scenario": scenario, "recording": data(RECORDING).to_string_lossy() })
}

struct Run {
    result: Result<Transcript, AppError>,
    events: Vec<SpeechEvent>,
    took: Duration,
}

/// Runs a transcription on its own thread and fails the test if it does not return within
/// `limit` (a deadlock or a hang).
fn run<R: Read + Send + 'static>(
    cmd: TranscriberCommand,
    duration: i64,
    audio: R,
    cancel: CancelToken,
    cancel_after_ready: Option<Duration>,
    limit: Duration,
) -> Run {
    let (tx, rx) = mpsc::channel();
    let job = TranscribeJob { source_id: "src".into(), duration, options: BuildOptions::default() };
    std::thread::spawn(move || {
        let started = Instant::now();
        let mut events = Vec::new();
        let c = cancel.clone();
        let result = transcribe(&cmd, &job, audio, &cancel, |e| {
            if matches!(e, SpeechEvent::Ready { .. })
                && let Some(after) = cancel_after_ready
            {
                let c = c.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(after);
                    c.cancel();
                });
            }
            events.push(e);
        });
        let _ = tx.send(Run { result, events, took: started.elapsed() });
    });
    rx.recv_timeout(limit).unwrap_or_else(|_| panic!("transcribe did not return within {limit:?}: deadlock or hang"))
}

fn speech_pcm() -> Vec<u8> {
    wav_pcm(&speech_2min_wav())
}

fn duration() -> i64 {
    speech_2min_manifest()["durationUs"].as_i64().unwrap()
}

fn offline(pcm: &[u8]) -> Transcript {
    build(&recording(RECORDING), &LevelTrack::from_pcm(pcm), duration(), BuildOptions::default())
}

fn utterance_events(events: &[SpeechEvent]) -> Vec<rc_types::Utterance> {
    events
        .iter()
        .flat_map(|e| match e {
            SpeechEvent::Utterances(u) => u.clone(),
            _ => vec![],
        })
        .collect()
}

fn expect_failure(r: &Run, needle: &str) -> AppError {
    let err = r.result.clone().expect_err("the run should fail");
    assert_eq!(err.code, ErrorCode::TranscriberFailed, "{err:?}");
    let detail = err.detail.clone().unwrap_or_default();
    assert!(detail.contains(needle) || err.message.contains(needle), "{needle:?} not in {err:?}");
    err
}

/// True while a process with this id exists.
fn process_alive(pid: u32) -> bool {
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .output()
        .expect("tasklist");
    String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
}

fn assert_gone(dir: &std::path::Path) {
    let pid: u32 = std::fs::read_to_string(dir.join("pid.txt")).expect("pid file").trim().parse().unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    while process_alive(pid) {
        assert!(Instant::now() < until, "the transcriber (pid {pid}) is still running");
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn replays_the_speech_fixture_and_streams_utterances() {
    let pcm = speech_pcm();
    let mut cfg = config("replay");
    cfg["expectBytes"] = pcm.len().into();
    let dir = model_dir("replay", cfg);
    let r = run(command(dir.clone()), duration(), Cursor::new(pcm.clone()), CancelToken::new(), None, Duration::from_secs(120));
    let t = r.result.expect("transcription");
    check_invariants(&t, duration());
    assert!(t.complete);
    assert_eq!(t.model, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");
    // Streaming gives exactly what building from the finished audio gives.
    assert_eq!(t, offline(&pcm));
    // Events: ready first, progress as a fraction of the source, utterances in batches.
    assert!(matches!(&r.events[0], SpeechEvent::Ready { device: DeviceUsed::Cpu, fallback: false, .. }), "{:?}", r.events[0]);
    let fractions: Vec<f64> = r
        .events
        .iter()
        .filter_map(|e| match e {
            SpeechEvent::Progress { fraction, .. } => Some(*fraction),
            _ => None,
        })
        .collect();
    assert!(fractions.len() >= 10, "{fractions:?}");
    assert!(fractions.windows(2).all(|w| w[0] <= w[1]) && *fractions.last().unwrap() > 0.99, "{fractions:?}");
    let batches = r.events.iter().filter(|e| matches!(e, SpeechEvent::Utterances(_))).count();
    assert!(batches >= 10, "{batches} batches");
    assert_eq!(utterance_events(&r.events), t.utterances);
    println!("replay of {} bytes took {:?}", pcm.len(), r.took);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_transcriber_that_writes_a_lot_before_reading_does_not_deadlock() {
    let pcm = speech_pcm();
    let mut cfg = config("flood");
    cfg["floodBytes"] = 4_000_000.into();
    cfg["expectBytes"] = pcm.len().into();
    let dir = model_dir("flood", cfg);
    let r = run(command(dir.clone()), duration(), Cursor::new(pcm.clone()), CancelToken::new(), None, Duration::from_secs(120));
    let t = r.result.expect("transcription");
    assert_eq!(t, offline(&pcm));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_slow_reader_still_gets_all_the_audio() {
    let pcm = speech_pcm();
    let mut cfg = config("slow_reader");
    cfg["readDelayMs"] = 1.into();
    cfg["expectBytes"] = pcm.len().into();
    let dir = model_dir("slow", cfg);
    let r = run(command(dir.clone()), duration(), Cursor::new(pcm.clone()), CancelToken::new(), None, Duration::from_secs(180));
    let t = r.result.expect("transcription");
    assert_eq!(t, offline(&pcm));
    println!("slow reader run took {:?}", r.took);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_crash_mid_stream_is_transcriber_failed() {
    let mut cfg = config("crash");
    cfg["afterSegments"] = 8.into();
    cfg["exitCode"] = 3.into();
    let dir = model_dir("crash", cfg);
    let r = run(command(dir.clone()), duration(), Cursor::new(speech_pcm()), CancelToken::new(), None, Duration::from_secs(60));
    let err = expect_failure(&r, "crashing on purpose");
    assert!(err.detail.as_deref().unwrap_or("").contains("before finishing"), "{err:?}");
    // What was final before the crash had already been handed on.
    assert!(!utterance_events(&r.events).is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_malformed_line_is_transcriber_failed() {
    let mut cfg = config("malformed");
    cfg["afterSegments"] = 3.into();
    let dir = model_dir("malformed", cfg);
    let r = run(command(dir.clone()), duration(), Cursor::new(speech_pcm()), CancelToken::new(), None, Duration::from_secs(60));
    expect_failure(&r, "not part of its protocol");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn an_error_message_is_transcriber_failed_with_its_code() {
    let dir = model_dir("error", config("error"));
    let r = run(command(dir.clone()), duration(), Cursor::new(speech_pcm()), CancelToken::new(), None, Duration::from_secs(60));
    let err = expect_failure(&r, "model_load_failed");
    assert!(err.detail.unwrap().contains("failing on purpose"), "standard error is in the detail");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_missing_model_is_transcriber_failed() {
    let dir = model_dir("nomodel", config("replay"));
    std::fs::remove_file(dir.join("standin.json")).unwrap();
    let r = run(command(dir.clone()), duration(), Cursor::new(vec![0u8; 3200]), CancelToken::new(), None, Duration::from_secs(60));
    expect_failure(&r, "model_missing");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn exiting_without_done_is_transcriber_failed() {
    let dir = model_dir("nodone", config("no_done"));
    let r = run(command(dir.clone()), duration(), Cursor::new(speech_pcm()), CancelToken::new(), None, Duration::from_secs(60));
    expect_failure(&r, "before finishing");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_non_zero_exit_after_done_is_transcriber_failed() {
    let mut cfg = config("exit_after_done");
    cfg["exitCode"] = 5.into();
    let dir = model_dir("exitafter", cfg);
    let r = run(command(dir.clone()), duration(), Cursor::new(speech_pcm()), CancelToken::new(), None, Duration::from_secs(60));
    expect_failure(&r, "after finishing");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_program_that_cannot_start_is_transcriber_failed() {
    let mut cmd = command(std::env::temp_dir());
    cmd.program = std::env::temp_dir().join("no-such-transcriber-here.exe");
    let r = run(cmd, duration(), Cursor::new(vec![0u8; 100]), CancelToken::new(), None, Duration::from_secs(30));
    expect_failure(&r, "no-such-transcriber-here");
}

/// Audio that fails after a while, like an FFmpeg pipe that breaks.
struct BrokenAudio {
    left: usize,
}

impl Read for BrokenAudio {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.left == 0 {
            return Err(std::io::Error::other("the audio pipe broke"));
        }
        let n = buf.len().min(self.left);
        buf[..n].fill(0);
        self.left -= n;
        Ok(n)
    }
}

#[test]
fn an_audio_read_error_is_transcriber_failed() {
    let dir = model_dir("brokenaudio", config("replay"));
    let r = run(command(dir.clone()), duration(), BrokenAudio { left: 320_000 }, CancelToken::new(), None, Duration::from_secs(60));
    expect_failure(&r, "the audio pipe broke");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn cancel_stops_a_transcriber_that_never_finishes() {
    let mut cfg = config("hang");
    cfg["pidFile"] = "pid.txt".into();
    let dir = model_dir("hang", cfg);
    let r = run(
        command(dir.clone()),
        duration(),
        Cursor::new(speech_pcm()),
        CancelToken::new(),
        Some(Duration::from_millis(1500)),
        Duration::from_secs(30),
    );
    assert_eq!(r.result.unwrap_err().code, ErrorCode::Cancelled);
    assert!(r.took < Duration::from_secs(10), "{:?}", r.took);
    assert_gone(&dir);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn cancel_stops_a_transcriber_that_never_reads() {
    let mut cfg = config("hang_no_read");
    cfg["pidFile"] = "pid.txt".into();
    let dir = model_dir("hangnoread", cfg);
    let cancel = CancelToken::new();
    let c = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        c.cancel();
    });
    // Far more audio than a pipe holds: the copying thread is blocked writing when cancelled.
    let r = run(command(dir.clone()), duration(), Cursor::new(speech_pcm()), cancel, None, Duration::from_secs(30));
    assert_eq!(r.result.unwrap_err().code, ErrorCode::Cancelled);
    assert_gone(&dir);
    let _ = std::fs::remove_dir_all(dir);
}
