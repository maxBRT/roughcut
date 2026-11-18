//! Stand-in transcriber for rc-speech's tests. It speaks the transcriber protocol exactly
//! (`--model-dir <folder> --device <auto|gpu|cpu> [--vad-model <file>]`, s16le 16 kHz mono on
//! standard input, JSON lines on standard output) and replays a recorded protocol file,
//! releasing each segment only once the audio up to its end has been read.
//!
//! What it does is set by `<model-dir>/standin.json`:
//! `{"scenario": "...", "recording": "<protocol jsonl>", ...}`. Scenarios:
//! - `replay`: the normal run.
//! - `flood`: writes `floodBytes` to standard output and to standard error before reading any input.
//! - `slow_reader`: sleeps `readDelayMs` after every 4 KB read.
//! - `crash`: exits with `exitCode` after `afterSegments` segments, without `done`.
//! - `malformed`: writes a broken line after `afterSegments` segments.
//! - `error`: reports `{"type":"error","code":"model_load_failed"}` and exits with 3.
//! - `no_done`: reads everything, then exits 0 without `done`.
//! - `exit_after_done`: a full replay, then exits with `exitCode`.
//! - `hang`: reads all input, then never finishes.
//! - `hang_no_read`: never reads its input and never finishes.
//!
//! `expectBytes`, when set, makes it report an error if the audio length differs.
//! `pidFile`, when set, names a file in the model folder that receives the process id.
//! A missing `standin.json` is reported as `model_missing`.

use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use rc_speech::Message;
use serde::Deserialize;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Config {
    scenario: String,
    recording: Option<String>,
    flood_bytes: usize,
    read_delay_ms: u64,
    after_segments: usize,
    exit_code: i32,
    expect_bytes: Option<u64>,
    /// When set, the stand-in writes its process id here first (tests check it was killed).
    pid_file: Option<String>,
}

fn emit(out: &mut impl Write, msg: &Message) {
    // A closed output means the client is gone; exit like a real program would.
    if writeln!(out, "{}", msg.to_line()).and_then(|_| out.flush()).is_err() {
        std::process::exit(1);
    }
}

fn fail(code: &str, message: &str, exit: i32) -> ! {
    let mut out = std::io::stdout().lock();
    emit(&mut out, &Message::Error { code: code.into(), message: message.into() });
    std::process::exit(exit);
}

fn parse_args() -> PathBuf {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut model_dir = None;
    let mut device = None;
    let mut i = 0;
    while i < args.len() {
        let value = args.get(i + 1).cloned();
        match (args[i].as_str(), value) {
            ("--model-dir", Some(v)) => model_dir = Some(PathBuf::from(v)),
            ("--device", Some(v)) => device = Some(v),
            ("--vad-model", Some(v)) => {
                if !Path::new(&v).is_file() {
                    fail("model_missing", &format!("no voice detector at {v}"), 2);
                }
            }
            (other, _) => fail("bad_arguments", &format!("unexpected argument {other}"), 2),
        }
        i += 2;
    }
    match device.as_deref() {
        Some("auto" | "gpu" | "cpu") => {}
        other => fail("bad_arguments", &format!("bad --device {other:?}"), 2),
    }
    model_dir.unwrap_or_else(|| fail("bad_arguments", "missing --model-dir", 2))
}

fn main() {
    let model_dir = parse_args();
    let config: Config = match std::fs::read_to_string(model_dir.join("standin.json")) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| fail("model_load_failed", &e.to_string(), 3)),
        Err(_) => fail("model_missing", &format!("no model in {}", model_dir.display()), 2),
    };
    if let Some(p) = &config.pid_file {
        let _ = std::fs::write(model_dir.join(p), std::process::id().to_string());
    }
    let mut messages: Vec<Message> = match &config.recording {
        Some(rec) => {
            let path = if Path::new(rec).is_absolute() { PathBuf::from(rec) } else { model_dir.join(rec) };
            let text = std::fs::read_to_string(&path).unwrap_or_else(|e| fail("model_load_failed", &e.to_string(), 3));
            text.lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| Message::parse_line(l).unwrap_or_else(|e| fail("internal", &e, 3)))
                .collect()
        }
        None => vec![Message::Ready { model: "standin".into(), device: rc_speech::DeviceUsed::Cpu, fallback: false }],
    };
    let mut out = BufWriter::new(std::io::stdout().lock());
    let mut err = std::io::stderr().lock();

    if config.scenario == "error" {
        let _ = writeln!(err, "stand-in: failing on purpose");
        fail("model_load_failed", "the model could not be loaded", 3);
    }
    if config.scenario == "hang_no_read" {
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }

    // ready first
    let ready_at = messages.iter().position(|m| matches!(m, Message::Ready { .. }));
    if let Some(i) = ready_at {
        let ready = messages.remove(i);
        emit(&mut out, &ready);
    }
    let done = messages.iter().position(|m| matches!(m, Message::Done { .. })).map(|i| messages.remove(i));
    messages.retain(|m| matches!(m, Message::Segment { .. } | Message::SpeechWithoutWords { .. }));

    if config.scenario == "flood" {
        // Lots of output before reading any input: a client that writes all audio before
        // reading would deadlock here.
        let mut written = 0;
        let mut k = 0u64;
        while written < config.flood_bytes {
            let msg = Message::Progress { audio_seconds: 0.0 };
            let line = msg.to_line();
            emit(&mut out, &msg);
            let _ = writeln!(err, "stand-in diagnostic line {k} padding padding padding padding padding");
            written += line.len() + 1;
            k += 1;
        }
    }

    let mut stdin = std::io::stdin().lock();
    let mut buf = vec![0u8; if config.scenario == "slow_reader" { 4096 } else { 32 * 1024 }];
    let mut bytes: u64 = 0;
    let mut odd = false;
    let mut next_progress = 10.0;
    let mut segments_sent = 0usize;
    let mut queue = messages.into_iter().peekable();
    let release = |m: &Message| match m {
        Message::Segment { end, .. } | Message::SpeechWithoutWords { end, .. } => *end,
        _ => 0,
    };
    let send = |out: &mut BufWriter<_>, m: Message, segments_sent: &mut usize| {
        emit(out, &m);
        *segments_sent += 1;
        if config.scenario == "crash" && *segments_sent >= config.after_segments {
            let _ = out.flush();
            let _ = writeln!(std::io::stderr(), "stand-in: crashing on purpose");
            std::process::exit(config.exit_code);
        }
        if config.scenario == "malformed" && *segments_sent == config.after_segments {
            let _ = writeln!(out, "{{\"type\":\"segment\",\"start\":");
            let _ = out.flush();
        }
    };
    loop {
        let n = match stdin.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => fail("internal", &format!("reading audio: {e}"), 4),
        };
        bytes += n as u64;
        odd = bytes % 2 == 1;
        let heard_us = (bytes / 2) as i64 * 1_000_000 / 16_000;
        while queue.peek().is_some_and(|m| release(m) <= heard_us) {
            let m = queue.next().expect("peeked");
            send(&mut out, m, &mut segments_sent);
        }
        let seconds = heard_us as f64 / 1e6;
        if seconds >= next_progress {
            emit(&mut out, &Message::Progress { audio_seconds: seconds });
            next_progress += 10.0;
        }
        if config.scenario == "slow_reader" {
            std::thread::sleep(Duration::from_millis(config.read_delay_ms));
        }
    }
    let _ = writeln!(err, "stand-in: read {bytes} bytes of audio");
    if odd {
        fail("internal", "audio ended in the middle of a sample", 4);
    }
    if let Some(expect) = config.expect_bytes
        && expect != bytes
    {
        fail("internal", &format!("expected {expect} bytes of audio, got {bytes}"), 4);
    }
    for m in queue {
        send(&mut out, m, &mut segments_sent);
    }
    emit(&mut out, &Message::Progress { audio_seconds: (bytes / 2) as f64 / 16_000.0 });
    match config.scenario.as_str() {
        "hang" => loop {
            std::thread::sleep(Duration::from_secs(1));
        },
        "no_done" => {
            let _ = out.flush();
            std::process::exit(0);
        }
        _ => {}
    }
    let done = done.unwrap_or(Message::Done { speech_ranges: vec![] });
    emit(&mut out, &done);
    if config.scenario == "exit_after_done" {
        let _ = out.flush();
        std::process::exit(config.exit_code);
    }
}
