//! rc-jobs with stand-in tasks (spec 3.7, the `jobs` row): import order as in 2.4.10, cached
//! results not recomputed, cancel stops the work and cleans up, an interrupted job restarts
//! cleanly on reopening; plus resource limits, failure isolation, and that nothing is
//! published for a job after it was cancelled.

mod standins;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use rc_jobs::*;
use rc_types::*;
use standins::*;

fn job_id(sink: &Collect, kind: JobKind, source: Option<&str>) -> JobId {
    sink.statuses(kind, source).first().expect("job was queued").id.clone()
}

/// After the job's first non-active status, nothing more about it is published.
fn assert_nothing_after_end(sink: &Collect, id: &str) {
    let all = sink.all();
    let end = all
        .iter()
        .position(|e| matches!(e, JobEvent::JobUpdated(s) if s.id == id && !matches!(s.state, JobState::Queued | JobState::Running)))
        .expect("the job ended");
    let later = all[end + 1..]
        .iter()
        .filter(|e| matches!(e, JobEvent::JobUpdated(s) if s.id == id))
        .count();
    assert_eq!(later, 0, "job {id} published {later} status events after it ended");
}

fn no_part_files(fakes: &Fakes) -> bool {
    std::fs::read_dir(&fakes.dir)
        .unwrap()
        .all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".part"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn import_runs_in_the_order_of_spec_2_4_10() {
    let fakes = Fakes::new();
    let (runner, sink) = new_runner(&fakes);

    let assets = runner.import("p1", vec![input("a")]);
    // Probe is done by then: the player starts on the original.
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0].playback, PlaybackSource::Original);
    assert_eq!(assets[0].playback_url.as_deref(), Some(media_url(BASE, TOKEN, "a", MediaItem::Original).as_str()));
    assert_eq!(assets[0].transcript, TranscriptProgress::None);
    idle(&runner).await;

    let ev = sink.all();
    // Everything that can start at once is queued at once, in this order.
    let queued: Vec<JobKind> = ev
        .iter()
        .filter_map(|e| match e {
            JobEvent::JobUpdated(s) if s.state == JobState::Queued => Some(s.kind),
            _ => None,
        })
        .collect();
    assert_eq!(
        queued,
        vec![JobKind::Proxy, JobKind::Audio, JobKind::Waveform, JobKind::Transcribe, JobKind::Suggest]
    );

    let at = |pred: &dyn Fn(&JobEvent) -> bool| ev.iter().position(pred).expect("event present");
    let proxy_running = at(&|e| is_status(e, JobKind::Proxy, "a", JobState::Running));
    let audio_running = at(&|e| is_status(e, JobKind::Audio, "a", JobState::Running));
    let proxy_done = at(&|e| is_status(e, JobKind::Proxy, "a", JobState::Done));
    let audio_done = at(&|e| is_status(e, JobKind::Audio, "a", JobState::Done));
    let transcribe_done = at(&|e| is_status(e, JobKind::Transcribe, "a", JobState::Done));
    let first_appended = at(&|e| matches!(e, JobEvent::TranscriptAppended(_)));
    let completed = at(&|e| matches!(e, JobEvent::TranscriptCompleted(p) if p.source_id == "a"));
    let suggest_queued = at(&|e| is_status(e, JobKind::Suggest, "a", JobState::Queued));
    let ready: Vec<usize> = ev
        .iter()
        .enumerate()
        .filter(|(_, e)| matches!(e, JobEvent::SuggestionsReady(_)))
        .map(|(i, _)| i)
        .collect();

    // Proxy and audio extraction in parallel.
    assert!(proxy_running < audio_done && audio_running < proxy_done, "proxy and audio overlap");
    let (ps, pe) = (fakes.log.at("proxy:start:a").unwrap(), fakes.log.at("proxy:end:a").unwrap());
    let (as_, ae) = (fakes.log.at("audio:start:a").unwrap(), fakes.log.at("audio:end:a").unwrap());
    assert!(ps < ae && as_ < pe, "proxy {ps:?}-{pe:?} and audio {as_:?}-{ae:?} overlap in time");
    // Transcription streams while audio is still being extracted.
    assert!(first_appended < audio_done, "first utterances arrive before the audio is finished");
    assert!(fakes.log.at("transcribe:first_batch:a").unwrap() < ae);
    // Suggestions only once the transcript is complete; dead air first, then Claude.
    assert!(completed < transcribe_done);
    assert!(completed < suggest_queued);
    assert_eq!(ready.len(), 2);
    assert!(suggest_queued < ready[0]);
    match (&ev[ready[0]], &ev[ready[1]]) {
        (JobEvent::SuggestionsReady(dead), JobEvent::SuggestionsReady(full)) => {
            assert_eq!(dead.claude_model, None);
            assert_eq!(dead.suggestions.len(), 1);
            assert_eq!(dead.suggestions[0].kind, SuggestionKind::DeadAir);
            assert_eq!(full.claude_model.as_deref(), Some("opus-standin"));
            assert_eq!(full.suggestions.len(), 2);
            assert!(full.suggestions.windows(2).all(|w| w[0].range.start <= w[1].range.start));
        }
        _ => unreachable!(),
    }
    assert!(fakes.log.at("dead_air:a").unwrap() < fakes.log.at("claude:start:a").unwrap());

    // Every job finished, and the appended utterances are exactly the transcript.
    for kind in [JobKind::Proxy, JobKind::Audio, JobKind::Waveform, JobKind::Transcribe, JobKind::Suggest] {
        assert_eq!(sink.last_state(kind, Some("a")), Some(JobState::Done), "{kind:?}");
    }
    let appended: Vec<u32> = ev
        .iter()
        .filter_map(|e| match e {
            JobEvent::TranscriptAppended(p) => Some(p.utterances.iter().map(|u| u.index).collect::<Vec<_>>()),
            _ => None,
        })
        .flatten()
        .collect();
    let cached = fakes.read_transcript(&"a".to_string()).unwrap();
    assert!(cached.complete);
    assert_eq!(appended, cached.utterances.iter().map(|u| u.index).collect::<Vec<_>>());
    assert_eq!(appended, vec![0, 1, 2, 3]);

    // Progress was reported between queued and done.
    assert!(sink.statuses(JobKind::Proxy, Some("a")).iter().any(|s| s.state == JobState::Running && s.progress > 0.0 && s.progress < 1.0));

    let a = runner.assets("a").unwrap();
    assert_eq!(a.playback, PlaybackSource::Proxy);
    assert_eq!(a.playback_url.as_deref(), Some(media_url(BASE, TOKEN, "a", MediaItem::Proxy).as_str()));
    assert_eq!(a.waveform_url.as_deref(), Some(media_url(BASE, TOKEN, "a", MediaItem::Waveform).as_str()));
    assert_eq!(a.transcript, TranscriptProgress::Complete);
    assert_eq!(a.suggestions, SuggestionsProgress::Ready);
    // The last assets event agrees with assets().
    let last_assets = ev.iter().rev().find_map(|e| match e {
        JobEvent::SourceAssetsChanged(s) => Some(s.clone()),
        _ => None,
    });
    assert_eq!(last_assets, Some(a));
    assert!(runner.partial_transcript("a").is_none());
    assert!(no_part_files(&fakes));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cached_result_is_not_recomputed() {
    // Everything cached: nothing runs at all.
    let fakes = Fakes::new();
    let a = "a".to_string();
    fakes.ready.lock().unwrap().insert((a.clone(), CacheItem::Proxy));
    fakes.ready.lock().unwrap().insert((a.clone(), CacheItem::Waveform));
    fakes.transcripts.lock().unwrap().insert(a.clone(), transcript("a", 3));
    fakes.suggestions.lock().unwrap().insert(
        a.clone(),
        SuggestionSet {
            schema_version: SUGGESTION_SET_SCHEMA_VERSION,
            source_id: a.clone(),
            claude_model: Some("opus".into()),
            suggestions: vec![],
        },
    );
    let (runner, sink) = new_runner(&fakes);
    let assets = runner.import("p1", vec![input("a")]);
    idle(&runner).await;
    assert_eq!(sink.count(|e| matches!(e, JobEvent::JobUpdated(_))), 0, "no job was started");
    for what in ["proxy:a", "waveform:a", "audio:a", "transcribe:a", "dead_air:a", "claude:a"] {
        assert_eq!(fakes.calls(what), 0, "{what}");
    }
    assert_eq!(assets[0].playback, PlaybackSource::Proxy);
    assert!(assets[0].waveform_url.is_some());
    assert_eq!(assets[0].transcript, TranscriptProgress::Complete);
    assert_eq!(assets[0].suggestions, SuggestionsProgress::Ready);

    // Transcript and dead air cached, Claude not yet: only Claude runs.
    let fakes = Fakes::new();
    fakes.ready.lock().unwrap().insert((a.clone(), CacheItem::Proxy));
    fakes.ready.lock().unwrap().insert((a.clone(), CacheItem::Waveform));
    fakes.transcripts.lock().unwrap().insert(a.clone(), transcript("a", 3));
    fakes.suggestions.lock().unwrap().insert(
        a.clone(),
        SuggestionSet {
            schema_version: SUGGESTION_SET_SCHEMA_VERSION,
            source_id: a.clone(),
            claude_model: None,
            suggestions: vec![suggestion("a", "pause", SuggestionKind::DeadAir, SuggestionOrigin::Local, 2_000_000)],
        },
    );
    let (runner, sink) = new_runner(&fakes);
    runner.import("p1", vec![input("a")]);
    idle(&runner).await;
    let kinds: Vec<JobKind> = sink
        .all()
        .iter()
        .filter_map(|e| match e {
            JobEvent::JobUpdated(s) if s.state == JobState::Queued => Some(s.kind),
            _ => None,
        })
        .collect();
    assert_eq!(kinds, vec![JobKind::Suggest]);
    assert_eq!(fakes.calls("dead_air:a"), 0, "cached dead air reused");
    assert_eq!(fakes.calls("claude:a"), 1);
    let set = fakes.read_suggestions(&a).unwrap();
    assert_eq!(set.claude_model.as_deref(), Some("opus-standin"));
    assert_eq!(set.suggestions.len(), 2, "cached dead air kept alongside Claude's answer");

    // A finished import imported again does nothing more.
    let before = sink.all().len();
    runner.import("p1", vec![input("a")]);
    idle(&runner).await;
    let after = sink.all();
    assert_eq!(after[before..].iter().filter(|e| matches!(e, JobEvent::JobUpdated(_))).count(), 0);
    assert_eq!(fakes.calls("claude:a"), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_stops_the_work_promptly_and_cleans_up() {
    let fakes = Fakes::new();
    fakes.knobs.proxy_steps.store(2000, Ordering::SeqCst); // 10 s if never cancelled
    let (runner, sink) = new_runner(&fakes);
    runner.import("p1", vec![input("a")]);
    until(|| sink.statuses(JobKind::Proxy, Some("a")).iter().any(|s| s.progress > 0.0)).await;
    assert!(fakes.dir.join("a.proxy.part").exists(), "the proxy is being written");

    let proxy = job_id(&sink, JobKind::Proxy, Some("a"));
    let t = Instant::now();
    assert!(runner.cancel(&proxy));
    assert!(!runner.cancel(&proxy), "a second cancel finds nothing to do");
    let st = runner.wait(&proxy).await.unwrap();
    assert_eq!(st.state, JobState::Cancelled);
    until(|| fakes.log.has("proxy:cleaned:a")).await;
    assert!(t.elapsed() < Duration::from_millis(500), "stopped in {:?}", t.elapsed());
    idle(&runner).await;

    assert!(!fakes.dir.join("a.proxy.part").exists(), "half-written proxy removed");
    assert!(!fakes.dir.join("a.proxy.mp4").exists());
    assert!(!fakes.is_ready(&"a".to_string(), CacheItem::Proxy));
    assert!(!fakes.log.has("proxy:end:a"));
    assert_nothing_after_end(&sink, &proxy);
    // The rest of the import was not affected.
    assert_eq!(sink.last_state(JobKind::Transcribe, Some("a")), Some(JobState::Done));
    assert_eq!(sink.last_state(JobKind::Suggest, Some("a")), Some(JobState::Done));
    let a = runner.assets("a").unwrap();
    assert_eq!(a.playback, PlaybackSource::Original, "the player stays on the original");
    assert_eq!(a.transcript, TranscriptProgress::Complete);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelling_transcription_stops_its_audio_and_publishes_nothing_after() {
    let fakes = Fakes::new();
    fakes.knobs.audio_chunks.store(2000, Ordering::SeqCst);
    let (runner, sink) = new_runner(&fakes);
    runner.import("p1", vec![input("a")]);
    until(|| sink.count(|e| matches!(e, JobEvent::TranscriptAppended(_))) >= 2).await;
    assert!(runner.partial_transcript("a").is_some_and(|t| t.utterances.len() >= 2 && !t.complete));

    let transcribe = job_id(&sink, JobKind::Transcribe, Some("a"));
    let audio = job_id(&sink, JobKind::Audio, Some("a"));
    assert!(runner.cancel(&transcribe));
    let cancelled_at = sink.all().len();
    assert_eq!(runner.status(&audio).unwrap().state, JobState::Cancelled, "its audio is cancelled with it");
    idle(&runner).await;

    assert!(fakes.log.has("transcribe:cleaned:a"));
    assert!(fakes.log.has("audio:cleaned:a"));
    assert!(!fakes.log.has("audio:end:a"));
    let after = &sink.all()[cancelled_at..];
    assert!(
        !after.iter().any(|e| matches!(e,
            JobEvent::TranscriptAppended(_) | JobEvent::TranscriptCompleted(_) | JobEvent::SuggestionsReady(_))),
        "no transcript event after cancel: {after:?}"
    );
    assert_nothing_after_end(&sink, &transcribe);
    assert_nothing_after_end(&sink, &audio);
    assert!(sink.statuses(JobKind::Suggest, Some("a")).is_empty(), "no suggestions without a transcript");
    assert!(fakes.read_transcript(&"a".to_string()).is_none());
    assert_eq!(sink.last_state(JobKind::Proxy, Some("a")), Some(JobState::Done));
}

/// The last `SourceAssets` published for `id`.
fn last_assets(sink: &Collect, id: &str) -> Option<SourceAssets> {
    sink.all().into_iter().rev().find_map(|e| match e {
        JobEvent::SourceAssetsChanged(s) if s.source_id == id => Some(s),
        _ => None,
    })
}

/// A transcription that ends without a transcript (the transcriber crashed, or it was
/// cancelled) after some utterances arrived must not leave the source saying its transcript
/// is still arriving: no job works on it any more. The interface hears it through
/// `source_assets_changed`; `get_transcript` no longer returns the abandoned partial one.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_transcription_that_ends_without_a_transcript_leaves_no_partial_state() {
    // Crash after the first batch.
    let fakes = Fakes::new();
    fakes.knobs.fail_transcribe.store(true, Ordering::SeqCst);
    fakes.knobs.audio_chunks.store(200, Ordering::SeqCst);
    let (runner, sink) = new_runner(&fakes);
    runner.import("p1", vec![input("a")]);
    idle(&runner).await;
    assert_eq!(sink.last_state(JobKind::Transcribe, Some("a")), Some(JobState::Failed));
    assert!(sink.count(|e| matches!(e, JobEvent::TranscriptAppended(_))) >= 1, "some speech arrived first");
    assert_eq!(runner.assets("a").unwrap().transcript, TranscriptProgress::None);
    assert_eq!(last_assets(&sink, "a").unwrap().transcript, TranscriptProgress::None, "the change is published");
    assert!(runner.partial_transcript("a").is_none());

    // Cancelled part-way.
    let fakes = Fakes::new();
    fakes.knobs.audio_chunks.store(2000, Ordering::SeqCst);
    let (runner, sink) = new_runner(&fakes);
    runner.import("p1", vec![input("a")]);
    until(|| sink.count(|e| matches!(e, JobEvent::TranscriptAppended(_))) >= 2).await;
    assert_eq!(runner.assets("a").unwrap().transcript, TranscriptProgress::Partial);
    assert!(runner.cancel(&job_id(&sink, JobKind::Transcribe, Some("a"))));
    idle(&runner).await;
    assert_eq!(runner.assets("a").unwrap().transcript, TranscriptProgress::None);
    assert_eq!(last_assets(&sink, "a").unwrap().transcript, TranscriptProgress::None, "the change is published");
    assert!(runner.partial_transcript("a").is_none());

    // Reopening transcribes again from the start (a shorter recording, to keep this quick).
    fakes.knobs.audio_chunks.store(16, Ordering::SeqCst);
    runner.import("p1", vec![input("a")]);
    idle(&runner).await;
    assert_eq!(runner.assets("a").unwrap().transcript, TranscriptProgress::Complete);
}

/// Found in the real app: when the transcriber program dies, the client stops taking audio
/// before it reports the exit, so the audio task ends "cancelled" first. The transcription must
/// still fail with the transcriber's own error, not "cancelled" (which the interface would show
/// as "Transcription failed: cancelled").
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_transcriber_that_dies_reports_its_own_error_not_the_audio_cancel() {
    let fakes = Fakes::new();
    fakes.knobs.fail_transcribe.store(true, Ordering::SeqCst);
    fakes.knobs.transcribe_drops_audio_first.store(true, Ordering::SeqCst);
    fakes.knobs.audio_chunks.store(200, Ordering::SeqCst);
    let (runner, sink) = new_runner(&fakes);
    runner.import("p1", vec![input("a")]);
    idle(&runner).await;
    let last = sink.statuses(JobKind::Transcribe, Some("a")).pop().unwrap();
    assert_eq!(last.state, JobState::Failed);
    assert_eq!(last.error.as_ref().map(|e| e.code), Some(ErrorCode::TranscriberFailed), "{:?}", last.error);
    let audio = sink.statuses(JobKind::Audio, Some("a")).pop().unwrap();
    assert_ne!(audio.state, JobState::Done, "the audio did not all reach the transcriber");
    assert_eq!(runner.assets("a").unwrap().transcript, TranscriptProgress::None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn export_reports_progress_finishes_and_cancels_without_leaving_a_file() {
    let fakes = Fakes::new();
    let out = fakes.dir.join("exports");
    std::fs::create_dir_all(&out).unwrap();
    let (runner, sink) = new_runner(&fakes);
    let export = |name: &str| ExportInput {
        request: ExportRequest {
            project_id: "p1".into(),
            clips: vec![Clip { id: "c1".into(), source_id: "a".into(), start: 0, end: 2_000_000 }],
            folder: out.to_string_lossy().into_owned(),
            file_name: name.into(),
        },
        format: OutputFormat {
            codec: OutputCodec::H264,
            width: 3840,
            height: 2160,
            frame_rate: Rational { num: 30, den: 1 },
            bit_depth: BitDepth::Eight,
            hdr: false,
            audio_tracks: 1,
        },
        sources: vec![source("a")],
    };

    // One finished export.
    let id = runner.start_export(export("one.mp4"));
    let st = runner.wait(&id).await.unwrap();
    assert_eq!(st.state, JobState::Done);
    assert_eq!(st.project_id.as_deref(), Some("p1"));
    let ev = sink.all();
    let finished = ev.iter().position(|e| matches!(e, JobEvent::ExportFinished(r) if r.path.ends_with("one.mp4"))).unwrap();
    let done = ev.iter().position(|e| matches!(e, JobEvent::JobUpdated(s) if s.id == id && s.state == JobState::Done)).unwrap();
    assert!(finished < done, "export_finished comes with the job's completion");
    let progress: Vec<f64> = sink.statuses(JobKind::Export, None).iter().map(|s| s.progress).collect();
    assert!(progress.iter().any(|p| *p > 0.0 && *p < 1.0));
    assert!(progress.windows(2).all(|w| w[0] <= w[1]), "progress never goes back: {progress:?}");
    assert!(out.join("one.mp4").exists());

    // A long export, and a second one queued behind it (one GPU encode at a time).
    fakes.knobs.export_steps.store(2000, Ordering::SeqCst);
    let long = runner.start_export(export("long.mp4"));
    let queued = runner.start_export(export("queued.mp4"));
    until(|| runner.status(&long).is_some_and(|s| s.progress > 0.0)).await;
    assert_eq!(runner.status(&queued).unwrap().state, JobState::Queued);
    // Cancelling a queued job: its work never starts.
    assert!(runner.cancel(&queued));
    // Cancelling the running one: it stops, cleans up, publishes nothing more.
    assert!(runner.cancel(&long));
    idle(&runner).await;
    assert_eq!(fakes.calls("export:queued.mp4"), 0);
    assert!(fakes.log.has("export:cleaned:long.mp4"));
    assert!(!out.join("long.mp4").exists() && !out.join("long.part").exists(), "nothing at the destination");
    assert_nothing_after_end(&sink, &long);
    assert_nothing_after_end(&sink, &queued);
    assert_eq!(sink.count(|e| matches!(e, JobEvent::ExportFinished(_))), 1);
    let list = runner.list();
    assert_eq!(list.iter().filter(|s| s.kind == JobKind::Export).count(), 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_interrupted_import_restarts_cleanly_on_reopening() {
    let fakes = Fakes::new();
    fakes.knobs.proxy_steps.store(2000, Ordering::SeqCst);
    fakes.knobs.audio_chunks.store(2000, Ordering::SeqCst);
    {
        let (first, sink) = new_runner(&fakes);
        first.import("p1", vec![input("a")]);
        until(|| {
            sink.count(|e| matches!(e, JobEvent::TranscriptAppended(_))) >= 2
                && sink.last_state(JobKind::Waveform, Some("a")) == Some(JobState::Done)
        })
        .await;
        // The app closes mid-import.
        tokio::time::timeout(Duration::from_secs(5), first.shutdown()).await.unwrap();
        assert!(sink.all().iter().all(|e| !matches!(e, JobEvent::TranscriptCompleted(_))));
    }
    let a = "a".to_string();
    assert!(fakes.is_ready(&a, CacheItem::Waveform));
    assert!(!fakes.is_ready(&a, CacheItem::Proxy));
    assert!(fakes.read_transcript(&a).is_none());
    assert!(no_part_files(&fakes), "interrupted work left nothing half-written");

    // Reopen with a fresh runner on the same cache.
    fakes.knobs.proxy_steps.store(20, Ordering::SeqCst);
    fakes.knobs.audio_chunks.store(16, Ordering::SeqCst);
    let (second, sink) = new_runner(&fakes);
    let assets = second.import("p1", vec![input("a")]);
    assert_eq!(assets[0].transcript, TranscriptProgress::None, "a partial transcript is not trusted");
    assert!(assets[0].waveform_url.is_some(), "the finished waveform is kept");
    idle(&second).await;

    let queued: Vec<JobKind> = sink
        .all()
        .iter()
        .filter_map(|e| match e {
            JobEvent::JobUpdated(s) if s.state == JobState::Queued => Some(s.kind),
            _ => None,
        })
        .collect();
    assert_eq!(queued, vec![JobKind::Proxy, JobKind::Audio, JobKind::Transcribe, JobKind::Suggest]);
    assert_eq!(fakes.calls("waveform:a"), 1, "the waveform is not made twice");
    let appended: Vec<u32> = sink
        .all()
        .iter()
        .filter_map(|e| match e {
            JobEvent::TranscriptAppended(p) => Some(p.utterances.iter().map(|u| u.index).collect::<Vec<_>>()),
            _ => None,
        })
        .flatten()
        .collect();
    assert_eq!(appended, vec![0, 1, 2, 3], "the transcript streams again from the start, once");
    let t = fakes.read_transcript(&a).unwrap();
    assert!(t.complete);
    assert_eq!(t.utterances.len(), 4);
    let assets = second.assets("a").unwrap();
    assert_eq!(assets.playback, PlaybackSource::Proxy);
    assert_eq!(assets.transcript, TranscriptProgress::Complete);
    assert_eq!(assets.suggestions, SuggestionsProgress::Ready);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resource_limits_keep_two_imports_from_thrashing() {
    let fakes = Fakes::new();
    let (runner, sink) = new_runner(&fakes);
    runner.import("p1", vec![input("a"), input("b")]);
    // While a proxy encodes, the other source's proxy waits.
    until(|| sink.statuses(JobKind::Proxy, Some("a")).iter().any(|s| s.state == JobState::Running)
        || sink.statuses(JobKind::Proxy, Some("b")).iter().any(|s| s.state == JobState::Running)).await;
    let states: Vec<JobState> = ["a", "b"].iter().map(|s| runner.list().into_iter().find(|j| j.kind == JobKind::Proxy && j.source_id.as_deref() == Some(*s)).unwrap().state).collect();
    assert!(states.contains(&JobState::Queued), "one proxy waits: {states:?}");
    idle(&runner).await;

    assert_eq!(fakes.gpu.max(), 1, "one GPU encode at a time");
    assert_eq!(fakes.speech.max(), 1, "one transcription at a time");
    for s in ["a", "b"] {
        for kind in [JobKind::Proxy, JobKind::Audio, JobKind::Waveform, JobKind::Transcribe, JobKind::Suggest] {
            assert_eq!(sink.last_state(kind, Some(s)), Some(JobState::Done), "{kind:?} {s}");
        }
    }
    // The proxies ran one after the other...
    let l = &fakes.log;
    let (a0, a1, b0, b1) = (
        l.at("proxy:start:a").unwrap(),
        l.at("proxy:end:a").unwrap(),
        l.at("proxy:start:b").unwrap(),
        l.at("proxy:end:b").unwrap(),
    );
    assert!(a1 <= b0 || b1 <= a0, "proxies did not overlap: a {a0:?}-{a1:?}, b {b0:?}-{b1:?}");
    // ...while transcription overlapped the GPU encode.
    let (t0, t1) = (l.at("transcribe:start:a").unwrap(), l.at("transcribe:end:a").unwrap());
    let first_proxy = if a0 < b0 { (a0, a1) } else { (b0, b1) };
    assert!(t0 < first_proxy.1 && first_proxy.0 < t1, "transcription overlaps the proxy encode");

    // The limit is what serialises them: with two GPU slots both proxies run together.
    let fakes = Fakes::new();
    let (runner, _sink) = runner_with(&fakes, Limits { gpu_encode: 2, ..Limits::default() });
    runner.import("p1", vec![input("a"), input("b")]);
    idle(&runner).await;
    assert_eq!(fakes.gpu.max(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_claude_call_leaves_everything_else_working_and_can_be_retried() {
    let fakes = Fakes::new();
    *fakes.knobs.claude_error.lock().unwrap() =
        Some(AppError::new(ErrorCode::ClaudeSignedOut, "Claude Code is signed out."));
    let (runner, sink) = new_runner(&fakes);
    runner.import("p1", vec![input("a")]);
    idle(&runner).await;

    let suggest = sink.statuses(JobKind::Suggest, Some("a"));
    let last = suggest.last().unwrap();
    assert_eq!(last.state, JobState::Failed);
    assert_eq!(last.error.as_ref().unwrap().code, ErrorCode::ClaudeSignedOut);
    let unavailable: Vec<SuggestionsUnavailablePayload> = sink
        .all()
        .into_iter()
        .filter_map(|e| match e {
            JobEvent::SuggestionsUnavailable(p) => Some(p),
            _ => None,
        })
        .collect();
    assert_eq!(unavailable.len(), 1);
    assert_eq!(unavailable[0].source_id, "a");
    assert_eq!(unavailable[0].error.code, ErrorCode::ClaudeSignedOut);
    // Dead air still arrived and is cached.
    assert_eq!(sink.count(|e| matches!(e, JobEvent::SuggestionsReady(s) if s.claude_model.is_none())), 1);
    assert_eq!(fakes.read_suggestions(&"a".to_string()).unwrap().suggestions.len(), 1);
    for kind in [JobKind::Proxy, JobKind::Audio, JobKind::Waveform, JobKind::Transcribe] {
        assert_eq!(sink.last_state(kind, Some("a")), Some(JobState::Done), "{kind:?}");
    }
    let a = runner.assets("a").unwrap();
    assert_eq!(a.suggestions, SuggestionsProgress::Unavailable);
    assert_eq!(a.transcript, TranscriptProgress::Complete);
    assert_eq!(a.playback, PlaybackSource::Proxy);

    // Retry once Claude is back: dead air is not recomputed.
    *fakes.knobs.claude_error.lock().unwrap() = None;
    let retry = runner.retry_suggestions("a").unwrap();
    let st = runner.wait(&retry).await.unwrap();
    assert_eq!(st.state, JobState::Done);
    idle(&runner).await;
    assert_eq!(fakes.calls("dead_air:a"), 1);
    assert_eq!(fakes.calls("claude:a"), 2);
    let set = fakes.read_suggestions(&"a".to_string()).unwrap();
    assert_eq!(set.claude_model.as_deref(), Some("opus-standin"));
    assert_eq!(set.suggestions.len(), 2);
    assert_eq!(runner.assets("a").unwrap().suggestions, SuggestionsProgress::Ready);
    assert!(matches!(sink.all().last(), Some(JobEvent::JobUpdated(s)) if s.id == retry && s.state == JobState::Done));

    // Retrying a source with no complete transcript is refused.
    assert!(runner.retry_suggestions("unknown").is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_step_fails_only_what_depends_on_it() {
    // Proxy fails: transcript and suggestions are unaffected; playback stays on the original.
    let fakes = Fakes::new();
    fakes.knobs.fail_proxy.store(true, Ordering::SeqCst);
    let (runner, sink) = new_runner(&fakes);
    runner.import("p1", vec![input("a")]);
    idle(&runner).await;
    let proxy = sink.statuses(JobKind::Proxy, Some("a"));
    assert_eq!(proxy.last().unwrap().state, JobState::Failed);
    assert_eq!(proxy.last().unwrap().error.as_ref().unwrap().code, ErrorCode::SourceUnreadable);
    for kind in [JobKind::Waveform, JobKind::Audio, JobKind::Transcribe, JobKind::Suggest] {
        assert_eq!(sink.last_state(kind, Some("a")), Some(JobState::Done), "{kind:?}");
    }
    let a = runner.assets("a").unwrap();
    assert_eq!(a.playback, PlaybackSource::Original);
    assert_eq!(a.suggestions, SuggestionsProgress::Ready);
    assert!(no_part_files(&fakes));

    // Transcriber crash: no transcript, no suggestions; proxy and waveform finish.
    let fakes = Fakes::new();
    fakes.knobs.fail_transcribe.store(true, Ordering::SeqCst);
    fakes.knobs.audio_chunks.store(200, Ordering::SeqCst);
    let (runner, sink) = new_runner(&fakes);
    runner.import("p1", vec![input("a")]);
    idle(&runner).await;
    let t = sink.statuses(JobKind::Transcribe, Some("a"));
    assert_eq!(t.last().unwrap().state, JobState::Failed);
    assert_eq!(t.last().unwrap().error.as_ref().unwrap().code, ErrorCode::TranscriberFailed);
    assert_eq!(sink.last_state(JobKind::Audio, Some("a")), Some(JobState::Cancelled), "its audio is stopped");
    assert!(fakes.log.has("audio:cleaned:a"));
    assert!(sink.statuses(JobKind::Suggest, Some("a")).is_empty());
    assert_eq!(sink.count(|e| matches!(e, JobEvent::TranscriptCompleted(_))), 0);
    assert_eq!(sink.last_state(JobKind::Proxy, Some("a")), Some(JobState::Done));
    assert_eq!(sink.last_state(JobKind::Waveform, Some("a")), Some(JobState::Done));
    assert!(runner.retry_suggestions("a").is_err(), "no suggestions without a complete transcript");

    // Audio extraction fails: transcription fails with it; the rest finishes.
    let fakes = Fakes::new();
    fakes.knobs.fail_audio.store(true, Ordering::SeqCst);
    let (runner, sink) = new_runner(&fakes);
    runner.import("p1", vec![input("a")]);
    idle(&runner).await;
    let audio = sink.statuses(JobKind::Audio, Some("a"));
    assert_eq!(audio.last().unwrap().state, JobState::Failed);
    let t = sink.statuses(JobKind::Transcribe, Some("a"));
    assert_eq!(t.last().unwrap().state, JobState::Failed);
    assert_eq!(t.last().unwrap().error.as_ref().unwrap().code, ErrorCode::SourceUnreadable);
    assert!(fakes.read_transcript(&"a".to_string()).is_none());
    assert_eq!(sink.last_state(JobKind::Proxy, Some("a")), Some(JobState::Done));
    assert_eq!(sink.last_state(JobKind::Waveform, Some("a")), Some(JobState::Done));
    for id in [&audio[0].id, &t[0].id] {
        assert_nothing_after_end(&sink, id);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn offline_sources_start_no_work_until_found() {
    let fakes = Fakes::new();
    let (runner, sink) = new_runner(&fakes);
    let assets = runner.import("p1", vec![SourceInput { source: source("a"), online: false }]);
    idle(&runner).await;
    assert!(!assets[0].online);
    assert_eq!(assets[0].playback, PlaybackSource::None);
    assert_eq!(assets[0].playback_url, None);
    assert_eq!(sink.count(|e| matches!(e, JobEvent::JobUpdated(_))), 0);

    let found = runner.set_online("a", true).unwrap();
    assert!(found.online);
    assert_eq!(found.playback, PlaybackSource::Original);
    assert!(matches!(sink.all().last(), Some(JobEvent::SourceAssetsChanged(s)) if s.online));
    runner.import("p1", vec![input("a")]);
    idle(&runner).await;
    assert_eq!(runner.assets("a").unwrap().transcript, TranscriptProgress::Complete);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn spawn_wait_list_and_cancel_project() {
    let fakes = Fakes::new();
    let (runner, sink) = new_runner(&fakes);
    let ok = runner.spawn(
        JobSpec { kind: JobKind::Probe, class: ResourceClass::Light, source_id: Some("a".into()), project_id: Some("p1".into()) },
        |job| async move {
            job.progress().set(0.5, Some(1.0));
            Ok(())
        },
    );
    let bad = runner.spawn(
        JobSpec { kind: JobKind::Probe, class: ResourceClass::Light, source_id: Some("b".into()), project_id: None },
        |_job| async move { Err(AppError::new(ErrorCode::SourceUnreadable, "not a video")) },
    );
    assert_eq!(runner.wait(&ok).await.unwrap().state, JobState::Done);
    let failed = runner.wait(&bad).await.unwrap();
    assert_eq!(failed.state, JobState::Failed);
    assert_eq!(failed.error.unwrap().code, ErrorCode::SourceUnreadable);
    assert!(sink.statuses(JobKind::Probe, Some("a")).iter().any(|s| s.progress == 0.5 && s.seconds_left == Some(1.0)));
    assert!(runner.wait("job-unknown").await.is_none());

    // A job that ignores nothing: it waits on its token, then cleans up.
    let cleaned = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let c2 = cleaned.clone();
    let long = runner.spawn(
        JobSpec { kind: JobKind::Probe, class: ResourceClass::Light, source_id: None, project_id: Some("p2".into()) },
        move |job| async move {
            job.cancel_token().cancelled().await;
            c2.store(true, Ordering::SeqCst);
            Err(AppError::new(ErrorCode::Cancelled, "cancelled"))
        },
    );
    until(|| runner.status(&long).is_some_and(|s| s.state == JobState::Running)).await;
    assert_eq!(runner.cancel_project("p2"), 1);
    idle(&runner).await;
    assert!(cleaned.load(Ordering::SeqCst));
    assert_eq!(runner.status(&long).unwrap().state, JobState::Cancelled);
    assert!(runner.status(&long).unwrap().error.is_none());
    assert_nothing_after_end(&sink, &long);
    assert_eq!(runner.list().len(), 3);
}

#[test]
fn events_carry_spec_names_and_camel_case_payloads() {
    let ev = JobEvent::TranscriptCompleted(TranscriptCompletedPayload { source_id: "a".into() });
    assert_eq!(ev.name(), "transcript_completed");
    assert_eq!(ev.payload_json(), serde_json::json!({ "sourceId": "a" }));
    let ev = JobEvent::JobUpdated(JobStatus {
        id: "job-1".into(),
        kind: JobKind::Transcribe,
        source_id: Some("a".into()),
        project_id: None,
        state: JobState::Running,
        progress: 0.25,
        seconds_left: Some(3.0),
        error: None,
    });
    assert_eq!(ev.name(), "job_updated");
    assert_eq!(
        ev.payload_json(),
        serde_json::json!({ "id": "job-1", "kind": "transcribe", "sourceId": "a", "state": "running", "progress": 0.25, "secondsLeft": 3.0 })
    );
}
