//! Failure isolation when port code panics, and per-step resumption on a repeated `import`.

mod standins;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use rc_jobs::*;
use rc_types::*;
use standins::*;

fn runner_on(fakes: &Arc<Fakes>, ports: Ports) -> (JobRunner, Arc<Collect>) {
    let _ = fakes;
    let sink = Arc::new(Collect::default());
    let runner = JobRunner::new(
        RunnerConfig { media_base: BASE.into(), media_token: TOKEN.into(), limits: Limits::default() },
        ports,
        sink.clone(),
        tokio::runtime::Handle::current(),
    );
    (runner, sink)
}

/// Every status event of `id` after its first final one.
fn events_after_end(sink: &Collect, id: &str) -> usize {
    let all = sink.all();
    let Some(end) = all.iter().position(
        |e| matches!(e, JobEvent::JobUpdated(s) if s.id == id && !matches!(s.state, JobState::Queued | JobState::Running)),
    ) else {
        return usize::MAX;
    };
    all[end + 1..].iter().filter(|e| matches!(e, JobEvent::JobUpdated(s) if s.id == id)).count()
}

fn last(sink: &Collect, kind: JobKind, source: Option<&str>) -> JobStatus {
    sink.statuses(kind, source).last().cloned().expect("job was published")
}

async fn idle_within(runner: &JobRunner, secs: u64) {
    tokio::time::timeout(Duration::from_secs(secs), runner.wait_idle())
        .await
        .expect("the runner went idle (no stranded task)");
}

/// The stand-in transcriber, panicking for source "b".
struct PanicSpeech(Arc<Fakes>);

impl SpeechPort for PanicSpeech {
    fn transcribe<'a>(
        &'a self,
        source: &'a SourceRef,
        audio: AudioStream,
        batches: UtteranceSink,
        progress: Progress,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<Transcript, AppError>> {
        if source.id == "b" {
            Box::pin(async move {
                let _keep = audio;
                tokio::time::sleep(Duration::from_millis(10)).await;
                panic!("adapter bug in transcribe");
            })
        } else {
            self.0.transcribe(source, audio, batches, progress, cancel)
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_panicking_transcriber_fails_only_its_own_jobs() {
    let fakes = Fakes::new();
    let mut ports = fakes.ports();
    ports.speech = Arc::new(PanicSpeech(fakes.clone()));
    let (runner, sink) = runner_on(&fakes, ports);

    runner.import("p1", vec![input("a"), input("b")]);
    until(|| sink.last_state(JobKind::Transcribe, Some("b")) == Some(JobState::Failed)).await;
    runner.import("p1", vec![input("c")]);
    idle_within(&runner, 10).await;

    // b's speech pair ended failed with `internal`; nothing about it was published afterwards.
    for kind in [JobKind::Audio, JobKind::Transcribe] {
        let s = last(&sink, kind, Some("b"));
        assert_eq!(s.state, JobState::Failed, "{kind:?}");
        assert_eq!(s.error.as_ref().map(|e| e.code), Some(ErrorCode::Internal), "{kind:?}");
        assert_eq!(events_after_end(&sink, &s.id), 0, "{kind:?}");
    }
    // b's other steps were not dragged down with it: they ran to the end.
    assert_eq!(sink.last_state(JobKind::Proxy, Some("b")), Some(JobState::Done));
    assert_eq!(sink.last_state(JobKind::Waveform, Some("b")), Some(JobState::Done));
    assert_eq!(sink.last_state(JobKind::Suggest, Some("b")), None, "no transcript, no suggestions");
    // Other sources, before and after, are fully imported.
    for src in ["a", "c"] {
        for kind in [JobKind::Proxy, JobKind::Audio, JobKind::Waveform, JobKind::Transcribe, JobKind::Suggest] {
            assert_eq!(sink.last_state(kind, Some(src)), Some(JobState::Done), "{kind:?} {src}");
        }
    }
    assert!(runner.list().iter().all(|s| !matches!(s.state, JobState::Queued | JobState::Running)));
}

/// The stand-in media, whose export panics for "boom.mp4".
struct PanicExport(Arc<Fakes>);

impl MediaPort for PanicExport {
    fn make_proxy<'a>(
        &'a self,
        source: &'a SourceRef,
        out: PathBuf,
        progress: Progress,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<(), AppError>> {
        self.0.make_proxy(source, out, progress, cancel)
    }
    fn extract_speech_audio<'a>(
        &'a self,
        source: &'a SourceRef,
        audio: AudioSender,
        progress: Progress,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<(), AppError>> {
        self.0.extract_speech_audio(source, audio, progress, cancel)
    }
    fn make_waveform<'a>(
        &'a self,
        source: &'a SourceRef,
        out: PathBuf,
        progress: Progress,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<(), AppError>> {
        self.0.make_waveform(source, out, progress, cancel)
    }
    fn run_export<'a>(
        &'a self,
        export: &'a ExportInput,
        progress: Progress,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<ExportResult, AppError>> {
        if export.request.file_name == "boom.mp4" {
            Box::pin(async move { panic!("adapter bug in run_export") })
        } else {
            self.0.run_export(export, progress, cancel)
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_panicking_export_does_not_block_the_gpu_queue() {
    let fakes = Fakes::new();
    let out = fakes.dir.join("exports");
    std::fs::create_dir_all(&out).unwrap();
    let mut ports = fakes.ports();
    ports.media = Arc::new(PanicExport(fakes.clone()));
    let (runner, sink) = runner_on(&fakes, ports);
    let export = |name: &str| ExportInput {
        request: ExportRequest {
            project_id: "p1".into(),
            clips: vec![Clip { id: "c1".into(), source_id: "a".into(), start: 0, end: 2_000_000 }],
            folder: out.to_string_lossy().into_owned(),
            file_name: name.into(),
        },
        format: OutputFormat {
            codec: OutputCodec::H264,
            width: 1920,
            height: 1080,
            frame_rate: Rational { num: 30, den: 1 },
            bit_depth: BitDepth::Eight,
            hdr: false,
            audio_tracks: 1,
        },
        sources: vec![source("a")],
    };

    let boom = runner.start_export(export("boom.mp4"));
    let fine = runner.start_export(export("fine.mp4"));
    runner.import("p1", vec![input("a")]);
    idle_within(&runner, 10).await;

    let b = runner.status(&boom).unwrap();
    assert_eq!(b.state, JobState::Failed);
    assert_eq!(b.error.map(|e| e.code), Some(ErrorCode::Internal));
    assert_eq!(events_after_end(&sink, &boom), 0);
    assert_eq!(runner.status(&fine).unwrap().state, JobState::Done);
    assert_eq!(sink.last_state(JobKind::Proxy, Some("a")), Some(JobState::Done));
    assert_eq!(sink.count(|e| matches!(e, JobEvent::ExportFinished(_))), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn importing_again_starts_only_the_missing_steps() {
    let fakes = Fakes::new();
    fakes.knobs.audio_chunks.store(200, Ordering::SeqCst); // transcription ~1 s
    fakes.knobs.fail_proxy.store(true, Ordering::SeqCst);
    let (runner, sink) = new_runner(&fakes);

    runner.import("p1", vec![input("a")]);
    // The proxy fails (say the drive dropped out) while transcription carries on.
    until(|| sink.last_state(JobKind::Proxy, Some("a")) == Some(JobState::Failed)).await;
    until(|| sink.last_state(JobKind::Waveform, Some("a")) == Some(JobState::Done)).await;
    assert_eq!(sink.last_state(JobKind::Transcribe, Some("a")), Some(JobState::Running));
    let partial_before = runner.partial_transcript("a").map(|t| t.utterances.len());

    // The file is back: import again while transcription is still running.
    fakes.knobs.fail_proxy.store(false, Ordering::SeqCst);
    let again = runner.import("p1", vec![input("a")]);
    assert_eq!(again[0].transcript, TranscriptProgress::Partial, "the running transcription is kept");
    assert!(runner.partial_transcript("a").map(|t| t.utterances.len()) >= partial_before);
    // A third call at once starts nothing new either.
    runner.import("p1", vec![input("a")]);
    idle_within(&runner, 10).await;

    assert_eq!(fakes.calls("proxy:a"), 2, "the missing proxy was started again, once");
    assert_eq!(fakes.calls("waveform:a"), 1, "the cached waveform was not redone");
    assert_eq!(fakes.calls("audio:a"), 1, "the running transcription was not started twice");
    assert_eq!(fakes.calls("transcribe:a"), 1);
    assert_eq!(fakes.calls("claude:a"), 1);
    let a = runner.assets("a").unwrap();
    assert_eq!(a.playback, PlaybackSource::Proxy);
    assert_eq!(a.transcript, TranscriptProgress::Complete);
    assert_eq!(a.suggestions, SuggestionsProgress::Ready);
}
