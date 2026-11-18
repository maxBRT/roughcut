//! Stand-in implementations of the four ports, an event collector, and helpers.
//! Every stand-in task runs in small timed steps, watches its cancellation token, and on
//! cancellation removes the half-written file it made, as the real adapters must.

#![allow(dead_code, clippy::too_many_arguments)]

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rc_jobs::*;
use rc_types::*;

// ---------------------------------------------------------------- log and counters

/// Timestamped marks ("proxy:start:a", ...) written by the stand-ins.
pub struct Log {
    t0: Instant,
    marks: Mutex<Vec<(String, Duration)>>,
}

impl Log {
    fn new() -> Self {
        Log { t0: Instant::now(), marks: Mutex::new(Vec::new()) }
    }
    pub fn mark(&self, s: impl Into<String>) {
        self.marks.lock().unwrap().push((s.into(), self.t0.elapsed()));
    }
    /// When `s` was first marked.
    pub fn at(&self, s: &str) -> Option<Duration> {
        self.marks.lock().unwrap().iter().find(|(m, _)| m == s).map(|(_, t)| *t)
    }
    pub fn has(&self, s: &str) -> bool {
        self.at(s).is_some()
    }
}

/// Counts how many run at once.
#[derive(Default)]
pub struct Concurrency {
    now: AtomicUsize,
    max: AtomicUsize,
}

pub struct Entered<'a>(&'a Concurrency);

impl Concurrency {
    pub fn enter(&self) -> Entered<'_> {
        let n = self.now.fetch_add(1, Ordering::SeqCst) + 1;
        self.max.fetch_max(n, Ordering::SeqCst);
        Entered(self)
    }
    pub fn max(&self) -> usize {
        self.max.load(Ordering::SeqCst)
    }
}

impl Drop for Entered<'_> {
    fn drop(&mut self) {
        self.0.now.fetch_sub(1, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------- knobs

pub struct Knobs {
    pub step_ms: AtomicU64,
    pub proxy_steps: AtomicU64,
    pub waveform_steps: AtomicU64,
    pub audio_chunks: AtomicU64,
    pub chunks_per_batch: AtomicU64,
    pub export_steps: AtomicU64,
    pub fail_proxy: AtomicBool,
    pub fail_waveform: AtomicBool,
    pub fail_audio: AtomicBool,
    pub fail_transcribe: AtomicBool,
    /// With `fail_transcribe`: the audio stream is dropped first and the failure reported later.
    pub transcribe_drops_audio_first: AtomicBool,
    pub fail_dead_air: AtomicBool,
    pub claude_error: Mutex<Option<AppError>>,
}

impl Default for Knobs {
    fn default() -> Self {
        Knobs {
            step_ms: AtomicU64::new(5),
            proxy_steps: AtomicU64::new(20),
            waveform_steps: AtomicU64::new(4),
            audio_chunks: AtomicU64::new(16),
            chunks_per_batch: AtomicU64::new(4),
            export_steps: AtomicU64::new(20),
            fail_proxy: AtomicBool::new(false),
            fail_waveform: AtomicBool::new(false),
            fail_audio: AtomicBool::new(false),
            fail_transcribe: AtomicBool::new(false),
            transcribe_drops_audio_first: AtomicBool::new(false),
            fail_dead_air: AtomicBool::new(false),
            claude_error: Mutex::new(None),
        }
    }
}

fn get(a: &AtomicU64) -> u64 {
    a.load(Ordering::SeqCst)
}
fn on(a: &AtomicBool) -> bool {
    a.load(Ordering::SeqCst)
}

fn cancelled() -> AppError {
    AppError::new(ErrorCode::Cancelled, "cancelled")
}

// ---------------------------------------------------------------- the stand-in

/// One object standing in for media, speech, suggest and cache.
pub struct Fakes {
    pub log: Log,
    pub knobs: Knobs,
    pub gpu: Concurrency,
    pub speech: Concurrency,
    pub light: Concurrency,
    calls: Mutex<HashMap<String, usize>>,
    pub dir: PathBuf,
    // cache contents
    pub ready: Mutex<HashSet<(SourceId, CacheItem)>>,
    pub transcripts: Mutex<HashMap<SourceId, Transcript>>,
    pub suggestions: Mutex<HashMap<SourceId, SuggestionSet>>,
}

static DIRS: AtomicU64 = AtomicU64::new(0);

impl Fakes {
    pub fn new() -> Arc<Self> {
        let n = DIRS.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("rc-jobs-test-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Arc::new(Fakes {
            log: Log::new(),
            knobs: Knobs::default(),
            gpu: Concurrency::default(),
            speech: Concurrency::default(),
            light: Concurrency::default(),
            calls: Mutex::new(HashMap::new()),
            dir,
            ready: Mutex::new(HashSet::new()),
            transcripts: Mutex::new(HashMap::new()),
            suggestions: Mutex::new(HashMap::new()),
        })
    }

    pub fn ports(self: &Arc<Self>) -> Ports {
        Ports {
            media: self.clone(),
            speech: self.clone(),
            suggest: self.clone(),
            cache: self.clone(),
        }
    }

    fn count(&self, what: String) {
        *self.calls.lock().unwrap().entry(what).or_default() += 1;
    }

    /// How many times `what` (e.g. "proxy:a") was called.
    pub fn calls(&self, what: &str) -> usize {
        self.calls.lock().unwrap().get(what).copied().unwrap_or(0)
    }

    fn step(&self) -> Duration {
        Duration::from_millis(get(&self.knobs.step_ms))
    }

    /// Sleep one step, or less if cancelled. Returns true if cancelled.
    async fn wait_step(&self, cancel: &CancellationToken) -> bool {
        tokio::select! {
            () = tokio::time::sleep(self.step()) => cancel.is_cancelled(),
            () = cancel.cancelled() => true,
        }
    }

    /// A file task in steps: writes `<out>.part`, removes it on cancel or failure, moves it
    /// to `out` when done.
    async fn file_task(
        &self,
        name: &str,
        id: &str,
        out: &Path,
        steps: u64,
        fail: bool,
        progress: &Progress,
        cancel: &CancellationToken,
    ) -> Result<(), AppError> {
        self.log.mark(format!("{name}:start:{id}"));
        let part = out.with_extension("part");
        std::fs::write(&part, b"partial").map_err(|e| AppError::internal(e.to_string()))?;
        for i in 0..steps {
            if fail && i == 2 {
                let _ = std::fs::remove_file(&part);
                self.log.mark(format!("{name}:failed:{id}"));
                return Err(AppError::new(ErrorCode::SourceUnreadable, format!("{name} failed")));
            }
            if self.wait_step(cancel).await {
                let _ = std::fs::remove_file(&part);
                self.log.mark(format!("{name}:cleaned:{id}"));
                return Err(cancelled());
            }
            progress.set((i + 1) as f64 / steps as f64, None);
        }
        std::fs::rename(&part, out).map_err(|e| AppError::internal(e.to_string()))?;
        self.log.mark(format!("{name}:end:{id}"));
        Ok(())
    }
}

impl Drop for Fakes {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub fn utterance(index: u32) -> Utterance {
    let start = index as i64 * 1_000_000;
    Utterance {
        index,
        start,
        end: start + 900_000,
        tokens: vec![Token::Word(WordToken {
            start,
            end: start + 900_000,
            cut_before: start,
            text: format!("word{index}"),
        })],
    }
}

pub fn transcript(id: &str, count: u32) -> Transcript {
    Transcript {
        schema_version: TRANSCRIPT_SCHEMA_VERSION,
        source_id: id.to_string(),
        model: "standin-asr".into(),
        complete: true,
        utterances: (0..count).map(utterance).collect(),
    }
}

pub fn suggestion(id: &str, n: &str, kind: SuggestionKind, origin: SuggestionOrigin, start: i64) -> Suggestion {
    Suggestion {
        id: format!("{id}-{n}"),
        kind,
        origin,
        range: SourceRange { source_id: id.to_string(), start, end: start + 500_000 },
        reason: format!("{n} reason"),
        kept_version_at: None,
    }
}

impl MediaPort for Fakes {
    fn make_proxy<'a>(
        &'a self,
        source: &'a SourceRef,
        out: PathBuf,
        progress: Progress,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<(), AppError>> {
        Box::pin(async move {
            self.count(format!("proxy:{}", source.id));
            let _g = self.gpu.enter();
            let steps = get(&self.knobs.proxy_steps);
            let fail = on(&self.knobs.fail_proxy);
            self.file_task("proxy", &source.id, &out, steps, fail, &progress, &cancel).await
        })
    }

    fn extract_speech_audio<'a>(
        &'a self,
        source: &'a SourceRef,
        audio: AudioSender,
        progress: Progress,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<(), AppError>> {
        Box::pin(async move {
            let id = &source.id;
            self.count(format!("audio:{id}"));
            self.log.mark(format!("audio:start:{id}"));
            let chunks = get(&self.knobs.audio_chunks);
            for i in 0..chunks {
                if on(&self.knobs.fail_audio) && i == 3 {
                    self.log.mark(format!("audio:failed:{id}"));
                    return Err(AppError::new(ErrorCode::SourceUnreadable, "audio failed"));
                }
                // 0.1 s of 16 kHz mono s16le.
                if audio.send(vec![0u8; 3200]).await.is_err() {
                    self.log.mark(format!("audio:cleaned:{id}"));
                    return Err(cancelled());
                }
                if self.wait_step(&cancel).await {
                    self.log.mark(format!("audio:cleaned:{id}"));
                    return Err(cancelled());
                }
                progress.set((i + 1) as f64 / chunks as f64, None);
            }
            self.log.mark(format!("audio:end:{id}"));
            Ok(())
        })
    }

    fn make_waveform<'a>(
        &'a self,
        source: &'a SourceRef,
        out: PathBuf,
        progress: Progress,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<(), AppError>> {
        Box::pin(async move {
            self.count(format!("waveform:{}", source.id));
            let _g = self.light.enter();
            let steps = get(&self.knobs.waveform_steps);
            let fail = on(&self.knobs.fail_waveform);
            self.file_task("waveform", &source.id, &out, steps, fail, &progress, &cancel).await
        })
    }

    fn run_export<'a>(
        &'a self,
        export: &'a ExportInput,
        progress: Progress,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<ExportResult, AppError>> {
        Box::pin(async move {
            let name = export.request.file_name.clone();
            self.count(format!("export:{name}"));
            let _g = self.gpu.enter();
            let out = Path::new(&export.request.folder).join(&name);
            let steps = get(&self.knobs.export_steps);
            self.file_task("export", &name, &out, steps, false, &progress, &cancel).await?;
            Ok(ExportResult {
                path: out.to_string_lossy().into_owned(),
                duration: export.request.clips.iter().map(|c| c.end - c.start).sum(),
                bytes: 7,
                took_seconds: 0.1,
                finished_at: "2026-11-13T12:00:00Z".into(),
            })
        })
    }
}

impl SpeechPort for Fakes {
    fn transcribe<'a>(
        &'a self,
        source: &'a SourceRef,
        mut audio: AudioStream,
        batches: UtteranceSink,
        progress: Progress,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<Transcript, AppError>> {
        Box::pin(async move {
            let id = &source.id;
            self.count(format!("transcribe:{id}"));
            let _g = self.speech.enter();
            self.log.mark(format!("transcribe:start:{id}"));
            let per_batch = get(&self.knobs.chunks_per_batch).max(1);
            let total = get(&self.knobs.audio_chunks).max(1);
            let mut chunks = 0u64;
            let mut all = Vec::new();
            let mut pending = 0u64;
            loop {
                let chunk = tokio::select! {
                    biased;
                    () = cancel.cancelled() => None,
                    c = audio.recv() => c,
                };
                // The audio may end because it was cancelled too: check before finishing.
                if cancel.is_cancelled() {
                    self.log.mark(format!("transcribe:cleaned:{id}"));
                    return Err(cancelled());
                }
                let Some(_chunk) = chunk else { break };
                chunks += 1;
                pending += 1;
                if pending == per_batch {
                    pending = 0;
                    let u = utterance(all.len() as u32);
                    all.push(u.clone());
                    if all.len() == 1 {
                        self.log.mark(format!("transcribe:first_batch:{id}"));
                    }
                    batches.append(vec![u]);
                    if on(&self.knobs.fail_transcribe) {
                        if on(&self.knobs.transcribe_drops_audio_first) {
                            // As the real client does when the program dies: its writer stops
                            // taking audio at once, and the exit is reported a moment later.
                            drop(audio);
                            for _ in 0..4 {
                                let _ = self.wait_step(&CancellationToken::new()).await;
                            }
                        }
                        self.log.mark(format!("transcribe:failed:{id}"));
                        return Err(AppError::new(ErrorCode::TranscriberFailed, "transcriber crashed"));
                    }
                }
                progress.set(chunks as f64 / total as f64, None);
            }
            if pending > 0 {
                let u = utterance(all.len() as u32);
                all.push(u.clone());
                batches.append(vec![u]);
            }
            self.log.mark(format!("transcribe:end:{id}"));
            Ok(Transcript {
                schema_version: TRANSCRIPT_SCHEMA_VERSION,
                source_id: id.clone(),
                model: "standin-asr".into(),
                complete: true,
                utterances: all,
            })
        })
    }
}

impl SuggestPort for Fakes {
    fn dead_air<'a>(
        &'a self,
        source: &'a SourceRef,
        _transcript: &'a Transcript,
        _cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<Vec<Suggestion>, AppError>> {
        Box::pin(async move {
            let id = &source.id;
            self.count(format!("dead_air:{id}"));
            self.log.mark(format!("dead_air:{id}"));
            if on(&self.knobs.fail_dead_air) {
                return Err(AppError::internal("dead air failed"));
            }
            Ok(vec![suggestion(id, "pause", SuggestionKind::DeadAir, SuggestionOrigin::Local, 2_000_000)])
        })
    }

    fn claude<'a>(
        &'a self,
        source: &'a SourceRef,
        _transcript: &'a Transcript,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<ClaudeAnswer, AppError>> {
        Box::pin(async move {
            let id = &source.id;
            self.count(format!("claude:{id}"));
            self.log.mark(format!("claude:start:{id}"));
            for _ in 0..4 {
                if self.wait_step(&cancel).await {
                    self.log.mark(format!("claude:cleaned:{id}"));
                    return Err(cancelled());
                }
            }
            if let Some(e) = self.knobs.claude_error.lock().unwrap().clone() {
                return Err(e);
            }
            Ok(ClaudeAnswer {
                model: "opus-standin".into(),
                suggestions: vec![suggestion(
                    id,
                    "retake",
                    SuggestionKind::Retake,
                    SuggestionOrigin::Claude,
                    1_000_000,
                )],
            })
        })
    }
}

impl CachePort for Fakes {
    fn is_ready(&self, source: &SourceId, item: CacheItem) -> bool {
        self.ready.lock().unwrap().contains(&(source.clone(), item))
    }
    fn path_for(&self, source: &SourceId, item: CacheItem) -> Result<PathBuf, AppError> {
        Ok(self.dir.join(format!("{source}.{}", match item {
            CacheItem::Proxy => "proxy.mp4",
            CacheItem::Waveform => "waveform.bin",
        })))
    }
    fn mark_finished(&self, source: &SourceId, item: CacheItem) -> Result<(), AppError> {
        self.ready.lock().unwrap().insert((source.clone(), item));
        Ok(())
    }
    fn read_transcript(&self, source: &SourceId) -> Option<Transcript> {
        self.transcripts.lock().unwrap().get(source).cloned()
    }
    fn write_transcript(&self, transcript: &Transcript) -> Result<(), AppError> {
        self.count(format!("write_transcript:{}", transcript.source_id));
        self.transcripts.lock().unwrap().insert(transcript.source_id.clone(), transcript.clone());
        Ok(())
    }
    fn read_suggestions(&self, source: &SourceId) -> Option<SuggestionSet> {
        self.suggestions.lock().unwrap().get(source).cloned()
    }
    fn write_suggestions(&self, set: &SuggestionSet) -> Result<(), AppError> {
        self.suggestions.lock().unwrap().insert(set.source_id.clone(), set.clone());
        Ok(())
    }
}

// ---------------------------------------------------------------- events

#[derive(Default)]
pub struct Collect {
    pub events: Mutex<Vec<JobEvent>>,
}

impl EventSink for Collect {
    fn publish(&self, event: JobEvent) {
        self.events.lock().unwrap().push(event);
    }
}

impl Collect {
    pub fn all(&self) -> Vec<JobEvent> {
        self.events.lock().unwrap().clone()
    }

    /// Every status published for `kind` and `source`.
    pub fn statuses(&self, kind: JobKind, source: Option<&str>) -> Vec<JobStatus> {
        self.all()
            .into_iter()
            .filter_map(|e| match e {
                JobEvent::JobUpdated(s) if s.kind == kind && s.source_id.as_deref() == source => Some(s),
                _ => None,
            })
            .collect()
    }

    /// The final published state of the (first) job of `kind` for `source`.
    pub fn last_state(&self, kind: JobKind, source: Option<&str>) -> Option<JobState> {
        self.statuses(kind, source).last().map(|s| s.state)
    }

    /// Index of the first event matching `pred`.
    pub fn index_of(&self, pred: impl Fn(&JobEvent) -> bool) -> Option<usize> {
        self.all().iter().position(pred)
    }

    pub fn count(&self, pred: impl Fn(&JobEvent) -> bool) -> usize {
        self.all().iter().filter(|e| pred(e)).count()
    }
}

pub fn is_status(e: &JobEvent, kind: JobKind, source: &str, state: JobState) -> bool {
    matches!(e, JobEvent::JobUpdated(s) if s.kind == kind && s.source_id.as_deref() == Some(source) && s.state == state)
}

// ---------------------------------------------------------------- setup

pub fn source(id: &str) -> SourceRef {
    SourceRef {
        id: id.to_string(),
        path: format!("C:/footage/{id}.mp4"),
        added_at: "2026-11-13T10:00:00Z".into(),
        media: MediaInfo {
            duration: 30_000_000,
            container: "mp4".into(),
            video: VideoInfo {
                codec: "h264".into(),
                width: 3840,
                height: 2160,
                frame_rate: Rational { num: 30, den: 1 },
                variable_frame_rate: false,
                bit_depth: BitDepth::Eight,
                hdr: false,
            },
            audio_tracks: vec![AudioTrackInfo {
                index: 0,
                codec: "aac".into(),
                channels: 2,
                sample_rate: 48_000,
                title: None,
            }],
            speech_track: 0,
            direct_playable: true,
        },
    }
}

pub fn input(id: &str) -> SourceInput {
    SourceInput { source: source(id), online: true }
}

pub const BASE: &str = "http://127.0.0.1:5000";
pub const TOKEN: &str = "tok";

pub fn runner_with(fakes: &Arc<Fakes>, limits: Limits) -> (JobRunner, Arc<Collect>) {
    let sink = Arc::new(Collect::default());
    let runner = JobRunner::new(
        RunnerConfig { media_base: BASE.into(), media_token: TOKEN.into(), limits },
        fakes.ports(),
        sink.clone(),
        tokio::runtime::Handle::current(),
    );
    (runner, sink)
}

pub fn new_runner(fakes: &Arc<Fakes>) -> (JobRunner, Arc<Collect>) {
    runner_with(fakes, Limits::default())
}

/// Wait for every task, failing the test after 10 s instead of hanging.
pub async fn idle(runner: &JobRunner) {
    tokio::time::timeout(Duration::from_secs(10), runner.wait_idle())
        .await
        .expect("the runner did not become idle within 10 s");
}

/// Poll until `cond` holds (up to 5 s).
pub async fn until(mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !cond() {
        assert!(Instant::now() < deadline, "condition not met within 5 s");
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}
