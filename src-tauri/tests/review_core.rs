//! Review tests (core-review track): checks of the joined-up core that the author's e2e tests
//! do not make. Same set-up as `e2e.rs`: the real FFmpeg and transcriber, the stand-in claude,
//! temporary data and cache folders.

mod common;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use common::*;
use rc_jobs::JobEvent;
use rc_types::{
    Clip, ErrorCode, ExportRequest, JobKind, JobState, MediaItem, PlaybackSource, SuggestionsProgress, TranscriptProgress,
};
use roughcut_lib::{AppConfig, AppCore};

const LONG: u64 = 600;

fn start_with(config: AppConfig) -> (Arc<AppCore>, Arc<Collect>) {
    let sink = Collect::new();
    let core = AppCore::start(config, sink.clone(), tokio::runtime::Handle::current()).expect("the core starts");
    (core, sink)
}

/// Waits for an event published after the first `after` events (the sink keeps the whole history).
async fn wait_after(sink: &Arc<Collect>, after: usize, what: &str, secs: u64, pred: impl Fn(&JobEvent) -> bool) -> JobEvent {
    let deadline = std::time::Instant::now() + Duration::from_secs(secs);
    loop {
        if let Some(e) = sink.all().into_iter().skip(after).find(|e| pred(e)) {
            return e;
        }
        assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn is_job(e: &JobEvent, kind: JobKind, id: &str, state: JobState) -> bool {
    matches!(e, JobEvent::JobUpdated(s) if s.kind == kind && s.state == state && s.source_id.as_deref() == Some(id))
}

/// Files under the source's cache folder whose names say they are unfinished.
fn unfinished_files(core: &AppCore, id: &str) -> Vec<PathBuf> {
    files_under(&core.cache().source_dir(id).unwrap())
        .into_iter()
        .filter(|p| {
            let n = p.file_name().unwrap().to_string_lossy().to_ascii_lowercase();
            n.contains("part") || n.contains("tmp")
        })
        .collect()
}

/// The utterances published in `transcript_appended`, in order, must add up to exactly the
/// transcript `get_transcript` returns once it is complete (same numbering from 1, same tokens);
/// otherwise the interface, which builds its transcript from the batches, shows something other
/// than what was saved and what Claude's suggestions refer to. Every terminal job state is
/// published once, and `transcript_completed` once per source.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review_appended_batches_add_up_to_the_final_transcript_and_events_are_not_doubled() {
    let _g = serial();
    let dir = Scratch::new("review-batches");
    let (core, sink) = start_with(config(dir.path()));
    let project = core.create_project(vec![fixture("speech-2min").display().to_string()]).await.unwrap();
    let id = project.sources[0].id.clone();
    let s = id.clone();
    wait_for(&sink, "Claude's suggestions", LONG, move |e| {
        matches!(e, JobEvent::SuggestionsReady(x) if x.source_id == s && x.claude_model.is_some())
    })
    .await;
    tokio::time::timeout(Duration::from_secs(120), core.runner().wait_idle()).await.expect("idle");

    let streamed: Vec<rc_types::Utterance> = sink
        .all()
        .into_iter()
        .filter_map(|e| match e {
            JobEvent::TranscriptAppended(p) if p.source_id == id => Some(p.utterances),
            _ => None,
        })
        .flatten()
        .collect();
    let t = core.get_transcript(id.clone()).await.unwrap();
    assert!(t.complete);
    assert_eq!(streamed.len(), t.utterances.len(), "as many utterances streamed as saved");
    for (a, b) in streamed.iter().zip(&t.utterances) {
        assert_eq!(a, b, "streamed utterance {} differs from the saved one", a.index);
    }

    assert_eq!(sink.count(|e| matches!(e, JobEvent::TranscriptCompleted(p) if p.source_id == id)), 1);
    assert_eq!(sink.count(|e| matches!(e, JobEvent::SuggestionsReady(x) if x.source_id == id)), 2, "dead air, then Claude");
    let mut terminal: HashMap<String, usize> = HashMap::new();
    for e in sink.all() {
        if let JobEvent::JobUpdated(j) = e
            && matches!(j.state, JobState::Done | JobState::Failed | JobState::Cancelled)
        {
            *terminal.entry(j.id).or_default() += 1;
        }
    }
    let doubled: Vec<_> = terminal.iter().filter(|(_, n)| **n > 1).collect();
    assert!(doubled.is_empty(), "jobs that ended more than once: {doubled:?}");
    let failed: Vec<_> = core.list_jobs().await.unwrap().into_iter().filter(|j| j.state != JobState::Done).collect();
    assert!(failed.is_empty(), "every import job finished: {failed:?}");
    core.shutdown().await;
    assert_no_workers(5);
}

/// Closing the app while a 4K import is running (proxy encoding, transcriber working) must stop
/// FFmpeg and the transcriber, leave no unfinished file that is later taken for a finished one,
/// and the next launch must redo the work whole. The same for an export in progress: nothing at
/// the destination.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review_shutdown_mid_import_and_mid_export_leaves_nothing_running_or_half_written() {
    let _g = serial();
    let dir = Scratch::new("review-shutdown");
    let (core, sink) = start_with(config(dir.path()));
    let project = core.create_project(vec![fixture("numbered-4k-h264").display().to_string()]).await.unwrap();
    let id = project.sources[0].id.clone();
    let s = id.clone();
    wait_for(&sink, "the proxy making progress", LONG, move |e| {
        matches!(e, JobEvent::JobUpdated(j) if j.kind == JobKind::Proxy && j.source_id.as_deref() == Some(s.as_str())
            && j.state == JobState::Running && j.progress > 0.05 && j.progress < 0.8)
    })
    .await;
    assert!(!worker_processes().is_empty(), "FFmpeg is running before the shutdown");
    tokio::time::timeout(Duration::from_secs(60), core.shutdown()).await.expect("shutdown returns");
    assert_no_workers(5);
    assert!(!core.cache().has(&id, rc_cache::CacheItem::Proxy), "a cut-off proxy is not finished");
    let left = unfinished_files(&core, &id);
    assert!(left.is_empty(), "unfinished files left after shutdown: {left:?}");
    assert_eq!(sink.count(|e| is_job(e, JobKind::Proxy, &id, JobState::Done)), 0);
    drop(core);

    let (core, sink) = start_with(config(dir.path()));
    let opened = core.open_project(project.id.clone()).await.unwrap();
    assert_ne!(opened.assets[0].playback, PlaybackSource::Proxy, "no proxy yet after the interrupted run");
    let s = id.clone();
    wait_for(&sink, "the proxy made again", LONG, move |e| is_job(e, JobKind::Proxy, &s, JobState::Done)).await;
    assert_eq!(video_frames(&core.cache().item_path(&id, rc_cache::CacheItem::Proxy).unwrap()), 900);
    tokio::time::timeout(Duration::from_secs(300), core.runner().wait_idle()).await.expect("import finishes");

    let out = dir.path().join("out");
    let request = ExportRequest {
        project_id: project.id.clone(),
        clips: vec![Clip { id: "clip-1".into(), source_id: id.clone(), start: 0, end: 30_000_000 }],
        folder: out.display().to_string(),
        file_name: "closing".into(),
    };
    let job = core.start_export(request).await.unwrap();
    let j = job.clone();
    wait_for(&sink, "the export making progress", LONG, move |e| {
        matches!(e, JobEvent::JobUpdated(s) if s.id == j && s.state == JobState::Running && s.progress > 0.05)
    })
    .await;
    tokio::time::timeout(Duration::from_secs(60), core.shutdown()).await.expect("shutdown returns");
    assert_no_workers(5);
    assert_eq!(sink.count(|e| matches!(e, JobEvent::ExportFinished(_))), 0);
    assert!(files_under(&out).is_empty(), "nothing at the destination: {:?}", files_under(&out));
    assert!(files_under(&core.cache().work_dir()).is_empty(), "no pieces left: {:?}", files_under(&core.cache().work_dir()));
}

/// After `clear_cache` removes a closed project's proxy, the media server must stop serving it
/// and opening that project must make it again (the runner must not keep trusting its own
/// "proxy ready").
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review_clear_cache_then_reopen_rebuilds_the_closed_projects_files() {
    let _g = serial();
    let dir = Scratch::new("review-clear");
    let (core, sink) = start_with(config(dir.path()));
    let a = core.create_project(vec![fixture("speech-2min").display().to_string()]).await.unwrap();
    let a_id = a.sources[0].id.clone();
    let s = a_id.clone();
    wait_for(&sink, "A's suggestions", LONG, move |e| {
        matches!(e, JobEvent::SuggestionsReady(x) if x.source_id == s && x.claude_model.is_some())
    })
    .await;
    tokio::time::timeout(Duration::from_secs(120), core.runner().wait_idle()).await.unwrap();
    let a_proxy = core.runner().assets(&a_id).unwrap().playback_url.unwrap();
    assert_eq!(http_get(&a_proxy, Some("bytes=0-9")).0, 206);

    // Another project becomes the open one; A's cache is no longer in use.
    let b = core.create_project(vec![fixture("numbered-4k-h264").display().to_string()]).await.unwrap();
    let b_id = b.sources[0].id.clone();
    let s = b_id.clone();
    wait_for(&sink, "B's proxy", LONG, move |e| is_job(e, JobKind::Proxy, &s, JobState::Done)).await;
    tokio::time::timeout(Duration::from_secs(300), core.runner().wait_idle()).await.unwrap();
    core.clear_cache().await.unwrap();
    assert!(!core.cache().has(&a_id, rc_cache::CacheItem::Proxy), "A's proxy is removed");
    assert!(core.cache().has(&b_id, rc_cache::CacheItem::Proxy), "the open project's proxy is kept");
    assert_eq!(http_get(&a_proxy, None).0, 404, "a removed proxy is not served");

    let before = sink.all().len();
    let opened = core.open_project(a.id.clone()).await.unwrap();
    assert_eq!(opened.assets[0].playback, PlaybackSource::Original, "A plays from the original until its proxy is made again");
    let s = a_id.clone();
    wait_after(&sink, before, "A's proxy made again", LONG, move |e| is_job(e, JobKind::Proxy, &s, JobState::Done)).await;
    let s = a_id.clone();
    wait_after(&sink, before, "A's transcript made again", LONG, move |e| {
        matches!(e, JobEvent::TranscriptCompleted(p) if p.source_id == s)
    })
    .await;
    assert!(sink.all().len() > before);
    assert_eq!(http_get(&a_proxy, Some("bytes=0-9")).0, 206, "served again");
    tokio::time::timeout(Duration::from_secs(120), core.runner().wait_idle()).await.unwrap();
    core.shutdown().await;
    assert_no_workers(5);
}

/// The interface may open a project again while its import is still running (going Home and
/// back). That must not start a second proxy, waveform, audio or transcription job for the same
/// source.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review_reopening_during_import_starts_no_second_job_per_step() {
    let _g = serial();
    let dir = Scratch::new("review-reopen");
    let (core, sink) = start_with(config(dir.path()));
    let project = core.create_project(vec![fixture("numbered-4k-h264").display().to_string()]).await.unwrap();
    let id = project.sources[0].id.clone();
    core.open_project(project.id.clone()).await.unwrap();
    let s = id.clone();
    wait_for(&sink, "the proxy running", LONG, move |e| is_job(e, JobKind::Proxy, &s, JobState::Running)).await;
    core.open_project(project.id.clone()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(300), core.runner().wait_idle()).await.unwrap();
    let jobs = core.list_jobs().await.unwrap();
    for kind in [JobKind::Proxy, JobKind::Waveform, JobKind::Audio, JobKind::Transcribe, JobKind::Suggest] {
        let n = jobs.iter().filter(|j| j.kind == kind && j.source_id.as_deref() == Some(id.as_str())).count();
        assert_eq!(n, 1, "{kind:?} jobs for the source: {:?}", jobs.iter().filter(|j| j.kind == kind).collect::<Vec<_>>());
    }
    core.shutdown().await;
    assert_no_workers(5);
}

/// The transcriber program is not where the configuration says (the built app without
/// ROUGHCUT_TRANSCRIBER_DIR looks in `transcriber\` next to roughcut.exe). The transcription must
/// fail with a transcriber error the interface can show, the audio job must not keep FFmpeg
/// running, and the source must not be left looking as if a transcript were still coming.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review_a_missing_transcriber_fails_cleanly() {
    let _g = serial();
    let dir = Scratch::new("review-no-transcriber");
    let mut cfg = config(dir.path());
    cfg.transcriber_dir = dir.path().join("no-transcriber-here");
    let (core, sink) = start_with(cfg);
    let project = core.create_project(vec![fixture("speech-2min").display().to_string()]).await.unwrap();
    let id = project.sources[0].id.clone();
    let s = id.clone();
    let failed =
        wait_for(&sink, "the transcription failing", 120, move |e| is_job(e, JobKind::Transcribe, &s, JobState::Failed)).await;
    let JobEvent::JobUpdated(j) = failed else { unreachable!() };
    let err = j.error.expect("an error");
    assert_eq!(err.code, ErrorCode::TranscriberFailed, "{err:?}");
    tokio::time::timeout(Duration::from_secs(120), core.runner().wait_idle()).await.expect("nothing hangs");
    assert_no_workers(5);
    let audio = core.list_jobs().await.unwrap().into_iter().find(|j| j.kind == JobKind::Audio).unwrap();
    assert_ne!(audio.state, JobState::Running);
    let assets = core.runner().assets(&id).unwrap();
    assert_eq!(assets.playback, PlaybackSource::Proxy, "the proxy is unaffected");
    assert_ne!(assets.transcript, TranscriptProgress::Partial, "no transcript is coming");
    assert_ne!(assets.suggestions, SuggestionsProgress::Working);
    core.shutdown().await;
    assert_no_workers(5);
}

/// Claude fails on the first call; `retry_suggestions` asks again and the second answer lands:
/// `suggestions_unavailable` first, then `suggestions_ready` with Claude's model, and the source's
/// assets say ready.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review_claude_failure_then_retry_suggestions_recovers() {
    let _g = serial();
    let dir = Scratch::new("review-retry");
    let mut cfg = config(dir.path());
    let bad = recorded_claude("recorded/print-offline-retries2.stdout.txt");
    let good = recorded_claude("recorded/success-150.stdout.txt");
    cfg.claude_extra_env = vec![
        ("RC_STANDIN_REPLIES".into(), format!("{}|1;{}|0", bad.display(), good.display())),
        ("RC_STANDIN_COUNTER".into(), dir.path().join("claude-counter").display().to_string()),
        ("RC_STANDIN_LOG".into(), dir.path().join("claude-calls.jsonl").display().to_string()),
    ];
    let (core, sink) = start_with(cfg);
    let unknown = core.retry_suggestions("ffffffffffffffffffffffffffffffff".into()).await.unwrap_err();
    assert_ne!(unknown.code, ErrorCode::Cancelled);
    let project = core.create_project(vec![fixture("speech-2min").display().to_string()]).await.unwrap();
    let id = project.sources[0].id.clone();
    let s = id.clone();
    let un = wait_for(&sink, "suggestions unavailable", LONG, move |e| {
        matches!(e, JobEvent::SuggestionsUnavailable(p) if p.source_id == s)
    })
    .await;
    let JobEvent::SuggestionsUnavailable(p) = un else { unreachable!() };
    assert!(
        matches!(p.error.code, ErrorCode::ClaudeOffline | ErrorCode::ClaudeBadAnswer | ErrorCode::ClaudeLimit | ErrorCode::ClaudeSignedOut),
        "{:?}",
        p.error
    );
    tokio::time::timeout(Duration::from_secs(120), core.runner().wait_idle()).await.unwrap();
    assert_eq!(core.runner().assets(&id).unwrap().suggestions, SuggestionsProgress::Unavailable);
    let dead_air = core.get_suggestions(id.clone()).await.unwrap();
    assert!(dead_air.claude_model.is_none() && !dead_air.suggestions.is_empty(), "dead air stays");

    let job = core.retry_suggestions(id.clone()).await.unwrap();
    let st = core.runner().wait(&job).await.unwrap();
    assert_eq!(st.state, JobState::Done, "{:?}", st.error);
    assert!(sink.count(|e| matches!(e, JobEvent::SuggestionsReady(x) if x.source_id == id && x.claude_model.is_some())) == 1);
    assert_eq!(core.runner().assets(&id).unwrap().suggestions, SuggestionsProgress::Ready);
    assert!(core.get_suggestions(id.clone()).await.unwrap().claude_model.is_some());
    core.shutdown().await;
    assert_no_workers(5);
}

/// Removing a project while its import runs stops its work (FFmpeg, the transcriber).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review_removing_a_project_mid_import_stops_its_work() {
    let _g = serial();
    let dir = Scratch::new("review-remove");
    let (core, sink) = start_with(config(dir.path()));
    let project = core.create_project(vec![fixture("numbered-4k-h264").display().to_string()]).await.unwrap();
    let id = project.sources[0].id.clone();
    let s = id.clone();
    wait_for(&sink, "the proxy running", LONG, move |e| {
        matches!(e, JobEvent::JobUpdated(j) if j.kind == JobKind::Proxy && j.source_id.as_deref() == Some(s.as_str())
            && j.state == JobState::Running && j.progress > 0.02)
    })
    .await;
    core.remove_project(project.id.clone()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(60), core.runner().wait_idle()).await.expect("the work stops");
    assert_no_workers(5);
    assert!(core.list_projects().await.unwrap().is_empty());
    assert!(core.list_jobs().await.unwrap().iter().all(|j| j.state != JobState::Running && j.state != JobState::Queued));
    let _ = MediaItem::Proxy;
    let _ = Path::new("");
    core.shutdown().await;
    assert_no_workers(5);
}

/// The transcriber dies part-way (after three stretches of speech). The transcription fails, and
/// the source must not keep saying a transcript is still arriving (`partial`) while nothing is
/// working on it; reopening the project must transcribe it again from the start.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review_a_transcriber_crash_does_not_leave_the_transcript_partial() {
    let _g = serial();
    let dir = Scratch::new("review-crash");
    let tdir = dir.path().join("transcriber");
    let models = dir.path().join("models");
    std::fs::create_dir_all(&tdir).unwrap();
    std::fs::create_dir_all(&models).unwrap();
    std::fs::copy(standin_transcriber(), tdir.join("transcriber.exe")).unwrap();
    std::fs::copy(root().join("src-tauri/crates/rc-speech/tests/data/speech-2min.v2-int8.cpu.jsonl"), models.join("speech.jsonl"))
        .unwrap();
    std::fs::write(models.join("silero_vad.onnx"), b"stand-in").unwrap();
    std::fs::write(models.join("standin.json"), br#"{"scenario":"crash","recording":"speech.jsonl","afterSegments":3,"exitCode":9}"#)
        .unwrap();
    let mut cfg = config(dir.path());
    cfg.transcriber_dir = tdir;
    cfg.model_dir = models.clone();
    // The stand-in "model" counts as installed.
    cfg.model_packages = Some(Vec::new());
    let (core, sink) = start_with(cfg);
    let project = core.create_project(vec![fixture("speech-2min").display().to_string()]).await.unwrap();
    let id = project.sources[0].id.clone();
    let s = id.clone();
    wait_for(&sink, "the transcription failing", 120, move |e| is_job(e, JobKind::Transcribe, &s, JobState::Failed)).await;
    tokio::time::timeout(Duration::from_secs(120), core.runner().wait_idle()).await.unwrap();
    assert!(sink.count(|e| matches!(e, JobEvent::TranscriptAppended(p) if p.source_id == id)) >= 1, "some speech arrived first");
    let assets = core.runner().assets(&id).unwrap();
    assert_ne!(
        assets.transcript,
        TranscriptProgress::Partial,
        "no job is transcribing, yet the source says its transcript is still arriving"
    );

    // Fixed transcriber: reopening transcribes again, numbered from 1.
    std::fs::write(models.join("standin.json"), br#"{"scenario":"replay","recording":"speech.jsonl"}"#).unwrap();
    let before = sink.all().len();
    core.open_project(project.id.clone()).await.unwrap();
    let s = id.clone();
    wait_after(&sink, before, "the transcript", 120, move |e| matches!(e, JobEvent::TranscriptCompleted(p) if p.source_id == s)).await;
    let t = core.get_transcript(id.clone()).await.unwrap();
    assert!(t.complete && t.utterances[0].index == 1);
    core.shutdown().await;
    assert_no_workers(5);
}

/// Every fixture kind through the joined-up core: import (no job may fail), then an export of
/// two kept ranges on the sequence grid. The output has exactly the kept frames, every audio
/// track of the source, and the codec the export rules give (10-bit HDR stays HEVC).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review_every_fixture_imports_and_exports_frame_exact_with_all_audio_tracks() {
    use rc_types::grid::{frame_to_micros, micros_to_frame_floor, snap_to_frame};
    let _g = serial();
    let dir = Scratch::new("review-fixtures");
    let (core, sink) = start_with(config(dir.path()));
    let mut problems = Vec::new();
    for name in ["numbered-3audio", "numbered-1080p60", "numbered-vfr", "numbered-4k-hevc10-hdr", "silence-only"] {
        let before = sink.all().len();
        let project = core.create_project(vec![fixture(name).display().to_string()]).await.unwrap();
        let src = project.sources[0].clone();
        let id = src.id.clone();
        let s = id.clone();
        wait_after(&sink, before, &format!("{name}: suggestions settled"), LONG, move |e| {
            matches!(e, JobEvent::SuggestionsReady(x) if x.source_id == s && x.claude_model.is_some())
                || matches!(e, JobEvent::SuggestionsUnavailable(p) if p.source_id == s)
                || matches!(e, JobEvent::JobUpdated(j) if j.source_id.as_deref() == Some(s.as_str()) && j.state == JobState::Failed)
        })
        .await;
        tokio::time::timeout(Duration::from_secs(300), core.runner().wait_idle()).await.expect("import settles");
        let failed: Vec<_> = core
            .list_jobs()
            .await
            .unwrap()
            .into_iter()
            .filter(|j| j.source_id.as_deref() == Some(id.as_str()) && j.state != JobState::Done)
            .map(|j| format!("{:?} {:?} {:?}", j.kind, j.state, j.error.map(|e| (e.code, e.message, e.detail))))
            .collect();
        if !failed.is_empty() {
            problems.push(format!("{name}: import jobs not done: {failed:?}"));
            continue;
        }
        let a = core.runner().assets(&id).unwrap();
        if a.playback != PlaybackSource::Proxy || a.waveform_url.is_none() || a.transcript != TranscriptProgress::Complete {
            problems.push(format!("{name}: assets after import {a:?}"));
        }

        let rate = project.frame_rate;
        let snap = |us: i64| snap_to_frame(us, rate);
        let clips = vec![
            Clip { id: "c1".into(), source_id: id.clone(), start: 0, end: snap(5_000_000) },
            Clip { id: "c2".into(), source_id: id.clone(), start: snap(10_000_000), end: snap(17_500_000) },
        ];
        let want_frames: i64 = clips.iter().map(|c| micros_to_frame_floor(c.end, rate) - micros_to_frame_floor(c.start, rate)).sum();
        let out = dir.path().join("out");
        let request = ExportRequest { project_id: project.id.clone(), clips, folder: out.display().to_string(), file_name: name.into() };
        let plan = core.plan_export(request.clone()).await.unwrap();
        if let Some(b) = &plan.blocked_by {
            problems.push(format!("{name}: export blocked: {b:?}"));
            continue;
        }
        let job = core.start_export(request).await.unwrap();
        let st = tokio::time::timeout(Duration::from_secs(LONG), core.runner().wait(&job)).await.unwrap().unwrap();
        if st.state != JobState::Done {
            problems.push(format!("{name}: export {:?} {:?}", st.state, st.error));
            continue;
        }
        let file = out.join(format!("{name}.mp4"));
        let out_rate = plan.format.frame_rate;
        // Frames of the output, on its own rate (the sequence frames times the rate multiple).
        let want_out = micros_to_frame_floor(frame_to_micros(want_frames, rate), out_rate);
        let got = video_frames(&file) as i64;
        if got != want_out {
            problems.push(format!("{name}: {got} frames, want {want_out} (sequence {rate:?}, output {out_rate:?})"));
        }
        let streams = streams(&file);
        let audio_out = streams.iter().filter(|s| s.0 == "audio").count();
        let audio_in = src.media.audio_tracks.len();
        if audio_out != audio_in || audio_out as u32 != plan.format.audio_tracks {
            problems.push(format!("{name}: {audio_out} audio tracks out, {audio_in} in the source, plan {}", plan.format.audio_tracks));
        }
        let vcodec = streams.iter().find(|s| s.0 == "video").map(|s| s.1.clone()).unwrap_or_default();
        if name.contains("hevc10") && vcodec != "hevc" {
            problems.push(format!("{name}: video codec {vcodec}"));
        }
        eprintln!("{name}: frames {got}/{want_out}, audio {audio_out}/{audio_in}, {vcodec}, notices {:?}", plan.notices);
    }
    core.shutdown().await;
    assert_no_workers(5);
    assert!(problems.is_empty(), "{problems:#?}");
}

/// Files that are not footage: a missing path, a text file, an audio-only file. Each is refused
/// with a source error the interface can show, and no half-made project is left in the list.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review_create_project_refuses_files_that_are_not_footage() {
    let _g = serial();
    let dir = Scratch::new("review-bad-files");
    let (core, _sink) = start_with(config(dir.path()));
    let text = dir.path().join("notes.mp4");
    std::fs::write(&text, b"this is not a video").unwrap();
    let wav = root().join("fixtures").join("out").join("speech-2min.wav");
    let cases = [
        ("missing", dir.path().join("nope.mp4")),
        ("text", text),
        ("audio only", wav),
    ];
    let mut problems = Vec::new();
    for (what, path) in cases {
        match core.create_project(vec![path.display().to_string()]).await {
            Ok(p) => problems.push(format!("{what}: accepted as project {} with {:?}", p.id, p.sources[0].media.video)),
            Err(e) => {
                if !matches!(e.code, ErrorCode::SourceMissing | ErrorCode::SourceUnreadable) {
                    problems.push(format!("{what}: error code {:?} ({})", e.code, e.message));
                }
            }
        }
    }
    tokio::time::timeout(Duration::from_secs(60), core.runner().wait_idle()).await.unwrap();
    let listed = core.list_projects().await.unwrap();
    if !listed.is_empty() {
        problems.push(format!("projects left in the list: {}", listed.len()));
    }
    core.shutdown().await;
    assert_no_workers(5);
    assert!(problems.is_empty(), "{problems:#?}");
}

/// The file at a source's path was replaced by a different recording while the app was closed
/// (same name, other content). Opening reports the source offline, so the core knows it is not
/// the project's file: the export must not cut the other recording with the project's clip times,
/// and the media server must not hand it out as the source's original.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review_a_replaced_source_file_is_neither_exported_nor_served() {
    let _g = serial();
    let dir = Scratch::new("review-replaced");
    let path = dir.path().join("footage").join("talk.mp4");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::copy(fixture("speech-2min"), &path).unwrap();
    let (core, _sink) = start_with(config(dir.path()));
    let project = core.create_project(vec![path.display().to_string()]).await.unwrap();
    let id = project.sources[0].id.clone();
    core.shutdown().await;
    drop(core);
    assert_no_workers(5);

    std::fs::remove_file(&path).unwrap();
    std::fs::copy(fixture("numbered-4k-h264"), &path).unwrap();

    let (core, _sink) = start_with(config(dir.path()));
    let opened = core.open_project(project.id.clone()).await.unwrap();
    assert!(!opened.assets[0].online, "the replaced file is not the project's source");
    let mut problems = Vec::new();
    let request = ExportRequest {
        project_id: project.id.clone(),
        clips: vec![Clip { id: "c".into(), source_id: id.clone(), start: 0, end: 10_000_000 }],
        folder: dir.path().join("out").display().to_string(),
        file_name: "replaced".into(),
    };
    let plan = core.plan_export(request.clone()).await.unwrap();
    if plan.blocked_by.is_none() {
        problems.push(format!("plan_export is not blocked; it would export the other recording ({}x{})", plan.format.width, plan.format.height));
    }
    match core.start_export(request).await {
        Ok(job) => {
            let st = core.runner().wait(&job).await.unwrap();
            problems.push(format!("start_export ran on the other file: {:?}", st.state));
        }
        Err(_) => {}
    }
    let url = rc_types::media_url(core.media_base(), core.media_token(), &id, MediaItem::Original);
    let status = http_get(&url, Some("bytes=0-99")).0;
    if status != 404 {
        problems.push(format!("the media server serves the replaced file as the original: {status}"));
    }
    tokio::time::timeout(Duration::from_secs(120), core.runner().wait_idle()).await.unwrap();
    core.shutdown().await;
    assert_no_workers(5);
    assert!(problems.is_empty(), "{problems:#?}");
}

/// Found in the real app (e2e "edge-cache"): the cache limit was applied only when a project
/// was made or opened. Opening A again (its cache removed earlier by the limit) found the cache
/// under the limit, A's files were then made again and B's cache, no longer in use, stayed
/// although the cache was now over its limit. The limit must hold as the cache grows.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn review_the_cache_limit_holds_while_an_open_project_rebuilds_its_files() {
    let _g = serial();
    let dir = Scratch::new("review-limit");
    let (core, sink) = start_with(config(dir.path()));
    let limit: u64 = 5 * 1024 * 1024;
    let patch: roughcut_lib::api::types::SettingsPatch = serde_json::from_str(&format!(r#"{{"cacheLimitBytes":{limit}}}"#)).unwrap();
    core.update_settings(patch).await.unwrap();

    let a = core.create_project(vec![fixture("speech-2min").display().to_string()]).await.unwrap();
    let a_id = a.sources[0].id.clone();
    tokio::time::timeout(Duration::from_secs(LONG), core.runner().wait_idle()).await.unwrap();
    let b = core.create_project(vec![fixture("numbered-1080p60").display().to_string()]).await.unwrap();
    let b_id = b.sources[0].id.clone();
    tokio::time::timeout(Duration::from_secs(LONG), core.runner().wait_idle()).await.unwrap();
    assert!(!core.cache().has(&a_id, rc_cache::CacheItem::Proxy), "A (not in use, over the limit) is removed when B is made");
    let b_bytes = core.cache().source_bytes(&b_id).unwrap();
    assert!(b_bytes > 0 && b_bytes < limit, "B's cache alone is under the limit ({b_bytes} bytes), so opening A removes nothing yet");

    let before = sink.all().len();
    core.open_project(a.id.clone()).await.unwrap();
    assert!(core.cache().has(&b_id, rc_cache::CacheItem::Proxy), "B is kept while the cache is under the limit");
    let s = a_id.clone();
    wait_after(&sink, before, "A's proxy made again", LONG, move |e| is_job(e, JobKind::Proxy, &s, JobState::Done)).await;
    tokio::time::timeout(Duration::from_secs(LONG), core.runner().wait_idle()).await.unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while core.cache().source_bytes(&b_id).unwrap_or(0) > 0 && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(core.cache().has(&a_id, rc_cache::CacheItem::Proxy), "A, open, keeps its rebuilt proxy although it is over the limit");
    assert!(
        !core.cache().has(&b_id, rc_cache::CacheItem::Proxy),
        "B's cache stays although A's rebuilt files took the cache over its limit ({} bytes used)",
        core.cache().usage_bytes().unwrap()
    );
    core.shutdown().await;
    assert_no_workers(5);
}
