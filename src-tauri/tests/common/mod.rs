//! Shared helpers for the app's windowless integration tests: a sink that collects the core's
//! events, temporary folders, the fixtures, the real programs and their stand-ins, a tiny HTTP
//! client for the media server, ffprobe, and the list of this process's child processes.
#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use rc_jobs::{EventSink, JobEvent};
use roughcut_lib::AppConfig;

/// The project root (`roughcut/`).
pub fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

/// A generated fixture, `fixtures/out/<name>.mp4`.
pub fn fixture(name: &str) -> PathBuf {
    let p = root().join("fixtures").join("out").join(format!("{name}.mp4"));
    assert!(p.is_file(), "missing fixture {} (run `npm run fixtures`)", p.display());
    p
}

/// The tests in one binary share the GPU and look at this process's children: one at a time.
pub fn serial() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

/// A temporary folder removed when dropped.
pub struct Scratch(pub PathBuf);

impl Scratch {
    pub fn new(tag: &str) -> Scratch {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!("rc-app-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Scratch(p)
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    /// Removes the folder, retrying for up to 20 s while files in it are still held (a child
    /// process that is exiting, the virus scanner). If it still cannot, says so on stderr with
    /// the reason and what is left, so a leaked folder is never silent.
    fn drop(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let err = match std::fs::remove_dir_all(&self.0) {
                Ok(()) => return,
                Err(_) if !self.0.exists() => return,
                Err(e) => e,
            };
            if Instant::now() >= deadline {
                let left = files_under(&self.0);
                eprintln!(
                    "WARNING: could not remove the test folder {} ({err}); {} file(s) left, first: {:?}",
                    self.0.display(),
                    left.len(),
                    left.iter().take(5).collect::<Vec<_>>()
                );
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

/// The folder holding the real transcriber and its runtime: `ROUGHCUT_TRANSCRIBER_DIR`, or
/// `.cache-dev/speech/dist/gpu` (built from `transcriber/` by `transcriber/scripts/build.sh gpu`).
pub fn transcriber_dir() -> PathBuf {
    let d = std::env::var_os("ROUGHCUT_TRANSCRIBER_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root().join(".cache-dev").join("speech").join("dist").join("gpu"));
    assert!(d.join("transcriber.exe").is_file(), "no transcriber.exe in {} (build it with transcriber/scripts/build.sh gpu)", d.display());
    d
}

/// The speech model folder: `ROUGHCUT_MODEL_DIR`, or `.cache-dev/speech/models`.
pub fn model_dir() -> PathBuf {
    std::env::var_os("ROUGHCUT_MODEL_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root().join(".cache-dev").join("speech").join("models"))
}

/// rc-suggest's stand-in `claude`, built as a binary of this crate.
pub fn standin_claude() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_rc-test-standin-claude"))
}

/// rc-speech's stand-in transcriber, built as a binary of this crate.
pub fn standin_transcriber() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_rc-test-standin-transcriber"))
}

/// A recorded Claude answer from rc-suggest's test data.
pub fn recorded_claude(name: &str) -> PathBuf {
    root().join("src-tauri").join("crates").join("rc-suggest").join("tests").join("data").join(name)
}

/// The configuration of a test: data and cache in `dir`, the real ffmpeg (as rc-media finds
/// it), the real transcriber and model, the stand-in claude answering with a recorded success.
pub fn config(dir: &Path) -> AppConfig {
    let reply = recorded_claude("recorded/success-150.stdout.txt");
    AppConfig {
        data_dir: dir.join("data"),
        cache_dir: dir.join("cache"),
        ffmpeg_dir: None,
        transcriber_dir: transcriber_dir(),
        model_dir: model_dir(),
        claude_program: Some(standin_claude()),
        claude_extra_env: vec![
            ("RC_STANDIN_REPLIES".into(), format!("{}|0", reply.display())),
            ("RC_STANDIN_LOG".into(), dir.join("claude-calls.jsonl").display().to_string()),
        ],
        limits: rc_jobs::Limits::default(),
        model_packages: None,
        export_free_bytes: None,
    }
}

// ---------------------------------------------------------------- events

/// Collects every event the core publishes, and lets a test wait for one.
#[derive(Default)]
pub struct Collect {
    events: Mutex<Vec<JobEvent>>,
    changed: Condvar,
}

impl EventSink for Collect {
    fn publish(&self, event: JobEvent) {
        self.events.lock().unwrap().push(event);
        self.changed.notify_all();
    }
}

impl Collect {
    pub fn new() -> Arc<Collect> {
        Arc::new(Collect::default())
    }

    pub fn all(&self) -> Vec<JobEvent> {
        self.events.lock().unwrap().clone()
    }

    pub fn count(&self, pred: impl Fn(&JobEvent) -> bool) -> usize {
        self.events.lock().unwrap().iter().filter(|e| pred(e)).count()
    }

    /// Waits (blocking; call it from `spawn_blocking` or a plain thread) until an event
    /// matches, and returns it. Panics after `timeout`, listing what was seen.
    pub fn wait_for(&self, what: &str, timeout: Duration, pred: impl Fn(&JobEvent) -> bool) -> JobEvent {
        let deadline = Instant::now() + timeout;
        let mut ev = self.events.lock().unwrap();
        loop {
            if let Some(e) = ev.iter().find(|e| pred(e)) {
                return e.clone();
            }
            let now = Instant::now();
            if now >= deadline {
                let names: Vec<String> = ev.iter().rev().take(40).map(describe).collect();
                panic!("timed out after {timeout:?} waiting for {what}; last events (newest first):\n{}", names.join("\n"));
            }
            ev = self.changed.wait_timeout(ev, deadline - now).unwrap().0;
        }
    }
}

/// One line per event, for failure messages.
pub fn describe(e: &JobEvent) -> String {
    match e {
        JobEvent::JobUpdated(s) => format!(
            "job_updated {} {:?} {:?} {:.2} {:?}",
            s.id,
            s.kind,
            s.state,
            s.progress,
            s.error.as_ref().map(|e| format!("{}: {} {:?}", e.code, e.message, e.detail))
        ),
        JobEvent::SourceAssetsChanged(a) => {
            format!("source_assets_changed {:?} {:?} {:?} {:?}", a.playback, a.waveform_url.is_some(), a.transcript, a.suggestions)
        }
        JobEvent::TranscriptAppended(p) => format!("transcript_appended {}", p.utterances.len()),
        JobEvent::TranscriptCompleted(_) => "transcript_completed".into(),
        JobEvent::SuggestionsReady(s) => format!("suggestions_ready {:?} {}", s.claude_model, s.suggestions.len()),
        JobEvent::SuggestionsUnavailable(p) => format!("suggestions_unavailable {:?}", p.error),
        JobEvent::ExportFinished(r) => format!("export_finished {}", r.path),
    }
}

/// Runs a blocking wait from an async test.
pub async fn wait_for(sink: &Arc<Collect>, what: &str, secs: u64, pred: impl Fn(&JobEvent) -> bool + Send + 'static) -> JobEvent {
    let sink = Arc::clone(sink);
    let what = what.to_string();
    tokio::task::spawn_blocking(move || sink.wait_for(&what, Duration::from_secs(secs), pred)).await.unwrap()
}

// ---------------------------------------------------------------- HTTP

/// One GET to the media server: status, headers (lower-case names), body.
pub fn http_get(url: &str, range: Option<&str>) -> (u16, Vec<(String, String)>, Vec<u8>) {
    let rest = url.strip_prefix("http://").expect("http url");
    let (host, path) = rest.split_once('/').map(|(h, p)| (h, format!("/{p}"))).unwrap_or((rest, "/".into()));
    let mut s = TcpStream::connect(host).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
    let mut req = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
    if let Some(r) = range {
        req.push_str(&format!("Range: {r}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).unwrap();
    let mut all = Vec::new();
    s.read_to_end(&mut all).unwrap();
    let split = all.windows(4).position(|w| w == b"\r\n\r\n").expect("a response head");
    let head = String::from_utf8_lossy(&all[..split]).into_owned();
    let body = all[split + 4..].to_vec();
    let mut lines = head.lines();
    let status: u16 = lines.next().unwrap().split_whitespace().nth(1).unwrap().parse().unwrap();
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    (status, headers, body)
}

/// `url` with its `token` query parameter removed or replaced.
pub fn with_token(url: &str, token: Option<&str>) -> String {
    let (base, _) = url.split_once("?token=").expect("a token in the url");
    match token {
        Some(t) => format!("{base}?token={t}"),
        None => base.to_string(),
    }
}

// ---------------------------------------------------------------- ffprobe

fn ffprobe_exe() -> PathBuf {
    rc_media::FfmpegTools::locate(None).expect("ffprobe").ffprobe
}

/// ffprobe's JSON for `args` plus the file.
pub fn ffprobe_json(file: &Path, args: &[&str]) -> serde_json::Value {
    let out = Command::new(ffprobe_exe()).args(["-v", "error", "-of", "json"]).args(args).arg(file).output().unwrap();
    assert!(out.status.success(), "ffprobe failed: {}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).unwrap()
}

/// The video frames in the file (every packet counted).
pub fn video_frames(file: &Path) -> u64 {
    let v = ffprobe_json(file, &["-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets"]);
    v["streams"][0]["nb_read_packets"].as_str().unwrap().parse().unwrap()
}

/// Every stream of the file: (codec_type, codec_name, width, height).
pub fn streams(file: &Path) -> Vec<(String, String, u64, u64)> {
    let v = ffprobe_json(file, &["-show_entries", "stream=codec_type,codec_name,width,height"]);
    v["streams"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["codec_type"].as_str().unwrap_or("").to_string(),
                s["codec_name"].as_str().unwrap_or("").to_string(),
                s["width"].as_u64().unwrap_or(0),
                s["height"].as_u64().unwrap_or(0),
            )
        })
        .collect()
}

// ---------------------------------------------------------------- child processes

/// The executable names of this process's live child processes.
#[cfg(windows)]
pub fn child_processes() -> Vec<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    };
    let me = std::process::id();
    let mut out = Vec::new();
    // SAFETY: plain Win32 calls; the entry's size is set before use and the handle is closed.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut e) != 0;
        while ok {
            if e.th32ParentProcessID == me && e.th32ProcessID != me {
                let len = e.szExeFile.iter().position(|c| *c == 0).unwrap_or(e.szExeFile.len());
                out.push(String::from_utf16_lossy(&e.szExeFile[..len]));
            }
            ok = Process32NextW(snap, &mut e) != 0;
        }
        CloseHandle(snap);
    }
    out
}

/// Child processes that are FFmpeg, the transcriber or claude (the programs the core starts).
pub fn worker_processes() -> Vec<String> {
    child_processes()
        .into_iter()
        .filter(|n| {
            let n = n.to_ascii_lowercase();
            n.starts_with("ffmpeg") || n.starts_with("ffprobe") || n.contains("transcriber") || n.contains("claude")
        })
        .collect()
}

/// Waits up to `secs` for every worker process to be gone; panics with their names otherwise.
pub fn assert_no_workers(secs: u64) {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        let left = worker_processes();
        if left.is_empty() {
            return;
        }
        assert!(Instant::now() < deadline, "still running: {left:?}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Every file under `dir`, recursively.
pub fn files_under(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(files_under(&p));
        } else {
            out.push(p);
        }
    }
    out
}
