//! Review tests (track jobs-review): defects found in an independent review of rc-jobs.
//! These are expected to FAIL until the defects are fixed.

mod standins;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use rc_jobs::*;
use rc_types::*;
use standins::*;

/// After `locate_source`, `import` is documented to "resume unfinished work". If the source's
/// pipeline is still busy with something else (here: the Claude call for an offline source
/// whose transcript was cached), the second `import` is swallowed and the proxy, waveform
/// (and any transcript) for the now-online file are never made in this session.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review_import_after_locate_while_pipeline_busy_starts_the_missing_work() {
    let fakes = Fakes::new();
    fakes.knobs.step_ms.store(50, Ordering::SeqCst); // Claude takes ~200 ms
    fakes.transcripts.lock().unwrap().insert("a".into(), transcript("a", 3));
    let (runner, sink) = new_runner(&fakes);

    // Open the project: the file is missing, but the transcript is cached, so Claude runs.
    runner.import("p1", vec![SourceInput { source: source("a"), online: false }]);
    until(|| sink.last_state(JobKind::Suggest, Some("a")) == Some(JobState::Running)).await;

    // The user locates the file while Claude is still answering; api calls import again.
    let found = runner.import("p1", vec![input("a")]);
    assert!(found[0].online);
    idle(&runner).await;

    assert_eq!(sink.last_state(JobKind::Suggest, Some("a")), Some(JobState::Done));
    assert_eq!(fakes.calls("proxy:a"), 1, "the proxy for the located file was never started");
    assert_eq!(fakes.calls("waveform:a"), 1, "the waveform for the located file was never started");
    let a = runner.assets("a").unwrap();
    assert_eq!(a.playback, PlaybackSource::Proxy);
    assert!(a.waveform_url.is_some());
}

/// A media port whose waveform task panics for source "b"; everything else is the stand-in.
struct PanicWaveform(Arc<Fakes>);

impl MediaPort for PanicWaveform {
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
        if source.id == "b" {
            Box::pin(async move { panic!("adapter bug in make_waveform") })
        } else {
            self.0.make_waveform(source, out, progress, cancel)
        }
    }
    fn run_export<'a>(
        &'a self,
        export: &'a ExportInput,
        progress: Progress,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<ExportResult, AppError>> {
        self.0.run_export(export, progress, cancel)
    }
}

/// The runner promises "a panic in the work marks the job failed with internal" and "a failed
/// step fails only what depends on it". But all steps of one source run in one task
/// (`tokio::join!`), so a panic in one port call unwinds the whole pipeline: the sibling
/// jobs (proxy, audio, transcribe) stay queued/running forever, and a job left in its class's
/// FIFO queue blocks that class for every other source for the rest of the session.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review_a_panicking_step_does_not_strand_siblings_or_block_other_sources() {
    let fakes = Fakes::new();
    fakes.knobs.audio_chunks.store(60, Ordering::SeqCst); // a's transcription ~300 ms
    let sink = Arc::new(Collect::default());
    let mut ports = fakes.ports();
    ports.media = Arc::new(PanicWaveform(fakes.clone()));
    let runner = JobRunner::new(
        RunnerConfig { media_base: BASE.into(), media_token: TOKEN.into(), limits: Limits::default() },
        ports,
        sink.clone(),
        tokio::runtime::Handle::current(),
    );

    // a transcribes first; b's transcription waits in the Speech queue when b's waveform panics.
    runner.import("p1", vec![input("a"), input("b")]);
    until(|| sink.last_state(JobKind::Waveform, Some("b")) == Some(JobState::Failed)).await;
    // A third source imported afterwards must still get transcribed.
    runner.import("p1", vec![input("c")]);

    let done = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if sink.last_state(JobKind::Transcribe, Some("c")) == Some(JobState::Done) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    let stuck: Vec<(JobKind, Option<String>, JobState)> = runner
        .list()
        .into_iter()
        .filter(|s| matches!(s.state, JobState::Queued | JobState::Running))
        .map(|s| (s.kind, s.source_id, s.state))
        .collect();
    runner.shutdown().await;
    assert!(done.is_ok(), "source c was never transcribed; jobs still active: {stuck:?}");
    assert!(
        stuck.iter().all(|(_, s, _)| s.as_deref() != Some("b")),
        "b's other jobs are stranded as active forever: {stuck:?}"
    );
}
