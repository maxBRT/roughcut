//! Helpers shared by the integration tests: locating the built program, the models and the
//! fixtures, running the program with a feeding schedule, and checking the protocol strictly.
#![allow(dead_code)]

use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use transcriber::protocol::Message;

/// Serialises the tests that load a model, so they do not compete for the processor and GPU.
pub static HEAVY: Mutex<()> = Mutex::new(());

pub fn heavy_lock() -> std::sync::MutexGuard<'static, ()> {
    HEAVY.lock().unwrap_or_else(|p| p.into_inner())
}

/// The project root (`roughcut/`).
pub fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

/// The program under test: `TRANSCRIBER_EXE` if set (to test a deployed folder), else the one
/// cargo built for these tests.
pub fn exe() -> PathBuf {
    std::env::var_os("TRANSCRIBER_EXE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_transcriber")))
}

/// The model folder from the speech experiment.
pub fn model_dir() -> PathBuf {
    std::env::var_os("TRANSCRIBER_MODEL_DIR").map(PathBuf::from).unwrap_or_else(|| root().join(".cache-dev/speech/models"))
}

/// Raw PCM bytes of the data chunk of a 16-bit PCM WAV file.
pub fn wav_pcm(path: &Path) -> Vec<u8> {
    let b = std::fs::read(path).unwrap_or_else(|e| panic!("cannot read {}: {e} (run `npm run fixtures`)", path.display()));
    assert_eq!(&b[0..4], b"RIFF");
    assert_eq!(&b[8..12], b"WAVE");
    let mut i = 12;
    let mut fmt_ok = false;
    while i + 8 <= b.len() {
        let id = &b[i..i + 4];
        let len = u32::from_le_bytes(b[i + 4..i + 8].try_into().unwrap()) as usize;
        let body = &b[i + 8..(i + 8 + len).min(b.len())];
        if id == b"fmt " {
            let channels = u16::from_le_bytes([body[2], body[3]]);
            let rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
            let bits = u16::from_le_bytes([body[14], body[15]]);
            assert_eq!((channels, rate, bits), (1, 16_000, 16), "fixture must be 16 kHz mono 16-bit");
            fmt_ok = true;
        }
        if id == b"data" {
            assert!(fmt_ok);
            return body.to_vec();
        }
        i += 8 + len + (len & 1);
    }
    panic!("no data chunk in {}", path.display());
}

/// The speech fixture's PCM.
pub fn speech_pcm() -> Vec<u8> {
    wav_pcm(&root().join("fixtures/out/speech-2min.wav"))
}

/// The fixtures manifest entry for the speech fixture (`fixtures.speech-2min`).
pub fn speech_manifest() -> Value {
    let p = root().join("fixtures/out/manifest.json");
    let m: Value = serde_json::from_slice(&std::fs::read(&p).expect("manifest (run `npm run fixtures`)")).unwrap();
    m["fixtures"]["speech-2min"].clone()
}

/// One line received from the program, with when it arrived.
pub struct Received {
    pub at: Instant,
    pub msg: Message,
}

/// Everything one run produced.
pub struct Run {
    pub messages: Vec<Received>,
    pub status: ExitStatus,
    pub stderr: String,
    pub started: Instant,
    /// When standard input was closed by the feeder.
    pub input_closed: Option<Instant>,
}

impl Run {
    pub fn msgs(&self) -> impl Iterator<Item = &Message> {
        self.messages.iter().map(|r| &r.msg)
    }
}

/// Parses one output line strictly: valid JSON, a known message, and no extra or renamed fields
/// (re-serialising the parsed message gives back the same JSON).
pub fn parse_line(line: &str) -> Message {
    let raw: Value = serde_json::from_str(line).unwrap_or_else(|e| panic!("not JSON: {line:?}: {e}"));
    let msg: Message = serde_json::from_value(raw.clone()).unwrap_or_else(|e| panic!("not a protocol message: {line}: {e}"));
    let again: Value = serde_json::to_value(&msg).unwrap();
    assert_eq!(again, raw, "line has fields outside the protocol: {line}");
    msg
}

/// How the feeder writes standard input.
#[derive(Clone, Copy)]
pub enum Feed {
    /// Everything as fast as the program reads it.
    AllAtOnce,
    /// `chunk` bytes, then a pause of `every`, repeated.
    Paced { chunk: usize, every: Duration },
}

/// Hook called on the reading thread for every message, with the child's handle.
pub type OnMessage = Box<dyn FnMut(&Message, &Child) + Send>;

/// Starts the program with `args`, feeds `input` per `feed`, collects every line until it exits.
pub fn run(args: &[&str], input: Vec<u8>, feed: Feed) -> Run {
    run_with(args, input, feed, None)
}

pub fn run_with(args: &[&str], input: Vec<u8>, feed: Feed, mut on_message: Option<OnMessage>) -> Run {
    let started = Instant::now();
    let mut child = Command::new(exe())
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|e| panic!("cannot start {}: {e}", exe().display()));
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let closed: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
    let feeder = {
        let closed = Arc::clone(&closed);
        std::thread::spawn(move || {
            match feed {
                Feed::AllAtOnce => {
                    let _ = stdin.write_all(&input);
                }
                Feed::Paced { chunk, every } => {
                    for c in input.chunks(chunk.max(1)) {
                        if stdin.write_all(c).is_err() {
                            break;
                        }
                        let _ = stdin.flush();
                        std::thread::sleep(every);
                    }
                }
            }
            drop(stdin);
            *closed.lock().unwrap() = Some(Instant::now());
        })
    };
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let child = Arc::new(Mutex::new(child));
    let mut messages = Vec::new();
    for line in BufReader::new(stdout).lines() {
        let line = line.expect("stdout is UTF-8 text");
        let msg = parse_line(&line);
        if let Some(cb) = on_message.as_mut() {
            cb(&msg, &child.lock().unwrap());
        }
        messages.push(Received { at: Instant::now(), msg });
    }
    let status = child.lock().unwrap().wait().unwrap();
    feeder.join().unwrap();
    let stderr = err_reader.join().unwrap();
    let input_closed = *closed.lock().unwrap();
    Run { messages, status, stderr, started, input_closed }
}

/// Lower-case letters, digits and apostrophes only.
pub fn norm(word: &str) -> String {
    word.chars().filter(|c| c.is_alphanumeric() || *c == '\'').flat_map(char::to_lowercase).collect()
}

/// How many times the word sequence `needle` occurs in `hay`.
pub fn count_phrase(hay: &[String], needle: &str) -> usize {
    let n: Vec<&str> = needle.split_whitespace().collect();
    if n.is_empty() || hay.len() < n.len() {
        return 0;
    }
    hay.windows(n.len()).filter(|w| w.iter().zip(&n).all(|(a, b)| a == b)).count()
}

/// Length of the longest common subsequence of two word lists.
pub fn lcs(a: &[String], b: &[String]) -> usize {
    let mut prev = vec![0usize; b.len() + 1];
    for x in a {
        let mut cur = vec![0usize; b.len() + 1];
        for (j, y) in b.iter().enumerate() {
            cur[j + 1] = if x == y { prev[j] + 1 } else { prev[j + 1].max(cur[j]) };
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Memory of a running (or exited, still open) process: (private bytes, working set, peak private).
#[cfg(windows)]
pub fn process_memory(child: &Child) -> Option<(u64, u64, u64)> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    #[derive(Default)]
    struct Counters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set: usize,
        working_set: usize,
        quota_peak_paged: usize,
        quota_paged: usize,
        quota_peak_nonpaged: usize,
        quota_nonpaged: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn K32GetProcessMemoryInfo(process: *mut std::ffi::c_void, counters: *mut Counters, cb: u32) -> i32;
    }
    let mut c = Counters { cb: std::mem::size_of::<Counters>() as u32, ..Default::default() };
    // SAFETY: the handle belongs to `child`, which is alive for the call; `c` is a valid out-pointer.
    let ok = unsafe { K32GetProcessMemoryInfo(child.as_raw_handle() as *mut _, &mut c, c.cb) };
    (ok != 0).then_some((c.pagefile_usage as u64, c.working_set as u64, c.peak_pagefile_usage as u64))
}

/// A fresh empty folder under the system temp folder.
pub fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("rc-transcriber-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Hard-links (or copies) `src` to `dst`.
pub fn link(src: &Path, dst: &Path) {
    if std::fs::hard_link(src, dst).is_err() {
        std::fs::copy(src, dst).unwrap_or_else(|e| panic!("copy {} -> {}: {e}", src.display(), dst.display()));
    }
}

/// Checks the invariants every successful run must satisfy and returns all words in order.
pub fn check_well_formed(run: &Run) -> Vec<transcriber::protocol::Word> {
    use transcriber::protocol::Message as M;
    let msgs: Vec<&M> = run.msgs().collect();
    assert!(run.status.success(), "exit {:?}; stderr:\n{}", run.status, run.stderr);
    assert!(matches!(msgs.first(), Some(M::Ready { .. })), "first message must be ready");
    assert!(matches!(msgs.last(), Some(M::Done { .. })), "last message must be done");
    assert_eq!(msgs.iter().filter(|m| matches!(m, M::Ready { .. })).count(), 1);
    assert_eq!(msgs.iter().filter(|m| matches!(m, M::Done { .. })).count(), 1);
    assert!(!msgs.iter().any(|m| matches!(m, M::Error { .. })));
    let mut words = Vec::new();
    let mut last_seg_end = 0u64;
    let mut last_word_end = 0u64;
    let mut last_progress = 0f64;
    for m in &msgs {
        match m {
            M::Segment { start, end, words: ws } => {
                assert!(start <= end, "segment {start}..{end}");
                assert!(*start >= last_seg_end, "segments overlap: {start} < {last_seg_end}");
                assert!(!ws.is_empty(), "a segment without words must be speech_without_words");
                for w in ws {
                    assert!(w.start <= w.end, "word {w:?}");
                    assert!(w.start >= last_word_end, "word times go back: {w:?} after {last_word_end}");
                    assert!(w.start >= *start && w.end <= *end, "word {w:?} outside its segment {start}..{end}");
                    assert!(!w.text.trim().is_empty());
                    last_word_end = w.end;
                    words.push(w.clone());
                }
                last_seg_end = *end;
            }
            M::SpeechWithoutWords { start, end } => {
                assert!(start <= end);
                assert!(*start >= last_seg_end);
                last_seg_end = *end;
            }
            M::Progress { audio_seconds } => {
                assert!(*audio_seconds >= last_progress, "progress goes back");
                last_progress = *audio_seconds;
            }
            M::Done { speech_ranges } => {
                for w in speech_ranges.windows(2) {
                    assert!(w[0].start < w[0].end && w[0].end <= w[1].start, "speech ranges {w:?}");
                }
            }
            _ => {}
        }
    }
    words
}
