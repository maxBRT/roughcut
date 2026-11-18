//! The joined-up core, without a window (spec 3.7, the `api` and "whole app" rows): the 21
//! commands called on `AppCore` directly, with the real FFmpeg, the real transcriber program
//! and model, the stand-in `claude`, and temporary data and cache folders. Events are collected
//! from the sink the app would turn into Tauri events.
//!
//! The transcriber is found in `ROUGHCUT_TRANSCRIBER_DIR` (default `.cache-dev/speech/dist/gpu`,
//! built from `transcriber/` by `transcriber/scripts/build.sh gpu`), the model in
//! `ROUGHCUT_MODEL_DIR` (default `.cache-dev/speech/models`).

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use common::*;
use rc_jobs::JobEvent;
use rc_types::grid::{first_clip_end, snap_to_frame};
use rc_types::{
    Clip, EditDocument, EditState, ErrorCode, ExportRequest, JobKind, JobState, MediaItem, PlaybackRate, PlaybackSource,
    Project, SessionState, SessionView, SourceAssets, SourcePosition, SuggestionsProgress, Token, TranscriptProgress,
};
use roughcut_lib::AppCore;

const LONG: u64 = 600;

fn start(dir: &Path) -> (Arc<AppCore>, Arc<Collect>) {
    let sink = Collect::new();
    let core = AppCore::start(config(dir), sink.clone(), tokio::runtime::Handle::current()).expect("the core starts");
    (core, sink)
}

fn is_assets(e: &JobEvent, id: &str, pred: impl Fn(&SourceAssets) -> bool) -> bool {
    matches!(e, JobEvent::SourceAssetsChanged(a) if a.source_id == id && pred(a))
}

fn is_job(e: &JobEvent, kind: JobKind, id: Option<&str>, state: JobState) -> bool {
    matches!(e, JobEvent::JobUpdated(s) if s.kind == kind && s.state == state && (id.is_none() || s.source_id.as_deref() == id))
}

/// Waits for the whole import of one source (spec 2.5) through the events and checks their
/// order: the proxy and the waveform become ready, the transcript arrives in batches and then
/// completes, suggestions are ready (dead air first, then with Claude's model). Returns the
/// final assets.
async fn wait_for_import(sink: &Arc<Collect>, id: &str) -> SourceAssets {
    let sid = id.to_string();
    let s = sid.clone();
    wait_for(sink, "proxy ready", LONG, move |e| is_assets(e, &s, |a| a.playback == PlaybackSource::Proxy)).await;
    let s = sid.clone();
    wait_for(sink, "waveform ready", LONG, move |e| is_assets(e, &s, |a| a.waveform_url.is_some())).await;
    let s = sid.clone();
    wait_for(sink, "transcript complete", LONG, move |e| matches!(e, JobEvent::TranscriptCompleted(p) if p.source_id == s)).await;
    let s = sid.clone();
    wait_for(sink, "Claude's suggestions", LONG, move |e| matches!(e, JobEvent::SuggestionsReady(x) if x.source_id == s && x.claude_model.is_some()))
        .await;
    let s = sid.clone();
    let last = wait_for(sink, "assets with suggestions ready", LONG, move |e| {
        is_assets(e, &s, |a| a.suggestions == SuggestionsProgress::Ready && a.transcript == TranscriptProgress::Complete)
    })
    .await;

    let ev = sink.all();
    let pos = |pred: &dyn Fn(&JobEvent) -> bool| ev.iter().position(pred);
    let appended: Vec<usize> = ev
        .iter()
        .enumerate()
        .filter(|(_, e)| matches!(e, JobEvent::TranscriptAppended(p) if p.source_id == sid))
        .map(|(i, _)| i)
        .collect();
    let completed = pos(&|e| matches!(e, JobEvent::TranscriptCompleted(p) if p.source_id == sid)).unwrap();
    let dead_air = pos(&|e| matches!(e, JobEvent::SuggestionsReady(x) if x.source_id == sid && x.claude_model.is_none()));
    let claude = pos(&|e| matches!(e, JobEvent::SuggestionsReady(x) if x.source_id == sid && x.claude_model.is_some())).unwrap();
    assert!(appended.iter().all(|&i| i < completed), "every batch arrives before transcript_completed");
    if let Some(d) = dead_air {
        assert!(completed < d && d < claude, "dead air after the transcript, before Claude");
    }
    let JobEvent::SourceAssetsChanged(a) = last else { unreachable!() };
    a
}

fn appended_batches(sink: &Collect, id: &str) -> usize {
    sink.count(|e| matches!(e, JobEvent::TranscriptAppended(p) if p.source_id == id && !p.utterances.is_empty()))
}

/// Two ranges to cut, taken from the transcript's own cut points (each covers two words), on
/// the frame grid.
fn two_cuts(core: &AppCore, project: &Project, t: &rc_types::Transcript) -> Vec<(i64, i64)> {
    let rate = project.frame_rate;
    let tokens: Vec<&Token> = t.utterances.iter().flat_map(|u| u.tokens.iter()).collect();
    let words: Vec<usize> = (0..tokens.len()).filter(|&i| matches!(tokens[i], Token::Word(_))).collect();
    assert!(words.len() > 40, "the speech fixture has words: {}", words.len());
    let range = |w: usize| {
        let (a, b) = (words[w], words[w + 2]);
        (snap_to_frame(tokens[a].cut_before(), rate), snap_to_frame(tokens[b].cut_before(), rate))
    };
    let cuts = vec![range(5), range(words.len() / 2)];
    for (a, b) in &cuts {
        assert!(a < b, "a cut covers something");
    }
    let _ = core;
    cuts
}

/// The clips left after cutting `cuts` out of the whole source.
fn clips_without(source: &str, end: i64, cuts: &[(i64, i64)]) -> Vec<Clip> {
    let mut clips = Vec::new();
    let mut at = 0;
    for (n, (a, b)) in cuts.iter().enumerate() {
        clips.push(Clip { id: format!("clip-{}", n + 1), source_id: source.into(), start: at, end: *a });
        at = *b;
    }
    clips.push(Clip { id: format!("clip-{}", cuts.len() + 1), source_id: source.into(), start: at, end });
    clips
}

fn kept(clips: &[Clip]) -> i64 {
    clips.iter().map(|c| c.end - c.start).sum()
}

/// The frames the clips keep on the grid of `rate`: each clip's ends are grid points, so it
/// holds exactly `frame(end) - frame(start)` frames. (Dividing the kept microseconds by the
/// frame length instead is off by one whenever the rounded grid points sum to just under a
/// whole frame, e.g. 3777.99996 frames at 30 fps.)
fn kept_frames(clips: &[Clip], rate: rc_types::Rational) -> u64 {
    use rc_types::grid::{is_on_frame_grid, micros_to_frame_floor};
    clips
        .iter()
        .map(|c| {
            assert!(is_on_frame_grid(c.start, rate) && is_on_frame_grid(c.end, rate), "clip {c:?} is on the grid");
            (micros_to_frame_floor(c.end, rate) - micros_to_frame_floor(c.start, rate)) as u64
        })
        .sum()
}

#[test]
fn kept_frames_counts_grid_frames_not_rounded_micros() {
    let rate = rc_types::Rational { num: 30, den: 1 };
    let f = |k| rc_types::grid::frame_to_micros(k, rate);
    // Two one-frame clips of 33_333 micros each: 66_666 micros is 1.99998 frames, which
    // truncation would call 1.
    let clips = vec![
        Clip { id: "a".into(), source_id: "s".into(), start: f(0), end: f(1) },
        Clip { id: "b".into(), source_id: "s".into(), start: f(2), end: f(3) },
    ];
    assert_eq!(kept(&clips), 66_666);
    assert_eq!(kept_frames(&clips, rate), 2);
    let three = vec![
        Clip { id: "a".into(), source_id: "s".into(), start: f(0), end: f(1) },
        Clip { id: "b".into(), source_id: "s".into(), start: f(3), end: f(4) },
        Clip { id: "c".into(), source_id: "s".into(), start: f(6), end: f(7) },
    ];
    assert_eq!(kept(&three), 99_999);
    assert_eq!(kept_frames(&three, rate), 3);
}

fn check_media_server(core: &AppCore, assets: &SourceAssets, id: &str) {
    let proxy_url = assets.playback_url.clone().expect("a playback address");
    assert!(proxy_url.starts_with(core.media_base()), "{proxy_url}");
    assert!(proxy_url.contains(&format!("/media/{id}/proxy")), "{proxy_url}");
    assert!(proxy_url.contains(core.media_token()), "the address carries the token");
    let proxy_file = core.cache().item_path(id, rc_cache::CacheItem::Proxy).unwrap();
    let (status, headers, body) = http_get(&proxy_url, None);
    assert_eq!(status, 200);
    assert_eq!(body.len() as u64, std::fs::metadata(&proxy_file).unwrap().len(), "the whole proxy");
    assert!(headers.iter().any(|(k, v)| k == "content-type" && v.contains("video/mp4")), "{headers:?}");
    let (status, _, body) = http_get(&proxy_url, Some("bytes=0-99"));
    assert_eq!((status, body.len()), (206, 100), "byte ranges are honoured");
    assert_eq!(http_get(&with_token(&proxy_url, None), None).0, 401, "no token, no data");
    assert_eq!(http_get(&with_token(&proxy_url, Some("wrong")), None).0, 401, "wrong token, no data");

    let wave_url = assets.waveform_url.clone().expect("a waveform address");
    assert!(wave_url.starts_with(core.media_base()) && wave_url.contains(&format!("/media/{id}/waveform")));
    let (status, _, body) = http_get(&wave_url, None);
    assert_eq!(status, 200);
    let (head, values) = rc_types::read_waveform(&body).expect("a waveform file");
    assert_eq!(head.source_id, id);
    assert!(values.iter().any(|&v| v > 0));
    assert_eq!(http_get(&with_token(&wave_url, None), None).0, 401);
    // An unknown source is 404 (with the token).
    let unknown = rc_types::media_url(core.media_base(), core.media_token(), "00000000000000000000000000000000", MediaItem::Proxy);
    assert_eq!(http_get(&unknown, None).0, 404);
}

async fn export_and_check(core: &AppCore, sink: &Arc<Collect>, project: &Project, clips: Vec<Clip>, out: &Path, name: &str) -> PathBuf {
    let request = ExportRequest {
        project_id: project.id.clone(),
        clips: clips.clone(),
        folder: out.display().to_string(),
        file_name: name.into(),
    };
    let plan = core.plan_export(request.clone()).await.unwrap();
    assert!(plan.blocked_by.is_none(), "{:?}", plan.blocked_by);
    assert_eq!(plan.duration, kept(&clips));
    let required = plan.required_bytes.expect("the amount needed is given");
    assert!(required >= plan.estimated_bytes && plan.free_bytes > required, "{required} {}", plan.free_bytes);
    let job = core.start_export(request).await.unwrap();
    let j = job.clone();
    let done = wait_for(sink, "export_finished", LONG, move |e| matches!(e, JobEvent::ExportFinished(_))).await;
    let JobEvent::ExportFinished(result) = done else { unreachable!() };
    let st = core.runner().wait(&j).await.unwrap();
    assert_eq!(st.state, JobState::Done, "{:?}", st.error);
    let file = PathBuf::from(&result.path);
    assert_eq!(file, out.join(format!("{name}.mp4")));
    assert!(file.is_file());
    assert!(!out.join(format!("{name}.mp4.part")).exists());
    assert_eq!(result.bytes, std::fs::metadata(&file).unwrap().len());
    assert_eq!(result.duration, kept(&clips));
    // The frame count equals the kept length.
    let want = kept_frames(&clips, plan.format.frame_rate);
    assert_eq!(video_frames(&file), want, "frames in {}", file.display());
    // Every audio track of the first clip's source is there.
    let s = streams(&file);
    let audio = s.iter().filter(|x| x.0 == "audio").count() as u32;
    assert_eq!(audio, plan.format.audio_tracks);
    assert!(audio >= 1);
    let video: Vec<_> = s.iter().filter(|x| x.0 == "video").collect();
    assert_eq!((video.len(), video[0].2, video[0].3), (1, plan.format.width as u64, plan.format.height as u64));
    // The project remembers it (Home list).
    let p = core.list_projects().await.unwrap().into_iter().find(|p| p.id == project.id).unwrap();
    assert!(p.last_exported_at.is_some());
    file
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn import_edit_reopen_and_export_the_speech_fixture() {
    let _g = serial();
    let dir = Scratch::new("e2e-speech");
    let (core, sink) = start(dir.path());

    // Nothing is there yet; the model in ROUGHCUT_MODEL_DIR counts as installed, so nothing
    // is downloaded.
    assert!(core.list_projects().await.unwrap().is_empty());
    assert!(core.speech_model_ready(), "the model in {} is found", core.config().model_dir.display());
    let status = core.claude_status().await.unwrap();
    assert!(status.installed && status.signed_in && status.version_tested, "{status:?}");

    let src = fixture("speech-2min");
    let project = core.create_project(vec![src.display().to_string()]).await.unwrap();
    assert_eq!(project.sources.len(), 1);
    let source = project.sources[0].clone();
    let id = source.id.clone();
    assert_eq!(project.edit.current.clips.len(), 1, "one clip per source");
    // The import jobs exist as soon as the project does.
    let kinds: Vec<JobKind> = core.list_jobs().await.unwrap().iter().map(|j| j.kind).collect();
    for k in [JobKind::Proxy, JobKind::Audio, JobKind::Waveform, JobKind::Transcribe] {
        assert!(kinds.contains(&k), "{k:?} queued: {kinds:?}");
    }

    let assets = wait_for_import(&sink, &id).await;
    assert!(appended_batches(&sink, &id) >= 2, "the transcript arrives in batches");
    assert_eq!(sink.count(|e| matches!(e, JobEvent::JobUpdated(j) if j.kind == JobKind::ModelDownload)), 0, "no download");
    assert!(assets.online);
    check_media_server(&core, &assets, &id);

    let t = core.get_transcript(id.clone()).await.unwrap();
    assert!(t.complete && !t.utterances.is_empty());
    assert_eq!(t.utterances[0].index, 1, "utterances are numbered from 1");
    assert!(t.utterances.iter().enumerate().all(|(i, u)| u.index as usize == i + 1));
    let set = core.get_suggestions(id.clone()).await.unwrap();
    assert!(set.claude_model.is_some());
    assert!(set.suggestions.iter().any(|s| s.kind == rc_types::SuggestionKind::DeadAir), "the fixture's long pauses are dead air");
    let calls = std::fs::read_to_string(dir.path().join("claude-calls.jsonl")).unwrap();
    assert!(calls.lines().any(|l| l.contains("\"-p\"")), "the stand-in claude was asked");

    // Cut two ranges at the transcript's own cut points and save.
    let end = first_clip_end(source.media.duration, project.frame_rate).unwrap();
    let cuts = two_cuts(&core, &project, &t);
    let clips = clips_without(&id, end, &cuts);
    let edit = EditDocument {
        current: EditState { clips: clips.clone(), dismissed: vec![] },
        undo: vec![project.edit.current.clone()],
        redo: vec![],
    };
    let session = SessionState {
        view: SessionView::Timeline,
        playhead: Some(SourcePosition { source_id: id.clone(), at: cuts[0].1 }),
        playback_rate: PlaybackRate::X1_5,
        cut_text_hidden: true,
    };
    core.save_edit(project.id.clone(), edit.clone(), session.clone()).await.unwrap();
    core.rename_project(project.id.clone(), "Weekly update".into()).await.unwrap();
    core.shutdown().await;
    drop(core);
    assert_no_workers(5);

    // Reopen with a fresh core on the same folders: the edit and the session are restored and
    // nothing is recomputed.
    let (core, sink) = start(dir.path());
    let listed = core.list_projects().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "Weekly update");
    assert_eq!(listed[0].kept_duration, kept(&clips));
    let opened = core.open_project(project.id.clone()).await.unwrap();
    assert_eq!(opened.project.edit, edit);
    assert_eq!(opened.project.session, session);
    let a = &opened.assets[0];
    assert_eq!((a.playback, a.transcript, a.suggestions), (PlaybackSource::Proxy, TranscriptProgress::Complete, SuggestionsProgress::Ready));
    assert!(a.waveform_url.is_some());
    check_media_server(&core, a, &id);
    let recomputed = sink.count(|e| matches!(e, JobEvent::JobUpdated(s) if s.source_id.as_deref() == Some(id.as_str())));
    assert_eq!(recomputed, 0, "cached results are not recomputed");

    // Export the edit.
    let out = dir.path().join("exports");
    let file = export_and_check(&core, &sink, &opened.project, clips, &out, "weekly cut").await;
    eprintln!("exported {} ({} bytes)", file.display(), std::fs::metadata(&file).unwrap().len());

    // Settings and cache commands.
    let settings = core.get_settings().await.unwrap();
    assert_eq!(settings.claude_model, "opus");
    let patch: roughcut_lib::api::types::SettingsPatch = serde_json::from_str(r#"{"claudeModel":"sonnet"}"#).unwrap();
    assert_eq!(core.update_settings(patch).await.unwrap().claude_model, "sonnet");
    assert_eq!(core.get_settings().await.unwrap().claude_model, "sonnet");
    let usage = core.cache_usage().await.unwrap();
    assert!(usage.used_bytes > 0 && usage.limit_bytes == settings.cache_limit_bytes);
    // The open project's cache is in use and survives clear_cache.
    core.clear_cache().await.unwrap();
    assert!(core.cache().has(&id, rc_cache::CacheItem::Proxy));
    let e = core.reveal_file(dir.path().join("nope.mp4").display().to_string()).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Internal);

    core.remove_project(project.id.clone()).await.unwrap();
    assert!(core.list_projects().await.unwrap().is_empty());
    assert!(src.is_file(), "footage is untouched");
    core.shutdown().await;
    assert_no_workers(5);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_second_4k_source_is_imported_and_exported_after_the_first() {
    let _g = serial();
    let dir = Scratch::new("e2e-two");
    let (core, sink) = start(dir.path());
    let project = core.create_project(vec![fixture("speech-2min").display().to_string()]).await.unwrap();
    let first = project.sources[0].id.clone();
    let added = core.add_sources(project.id.clone(), vec![fixture("numbered-4k-h264").display().to_string()]).await.unwrap();
    assert_eq!(added.len(), 1);
    let second = added[0].clone();
    assert_eq!((second.media.video.width, second.media.video.height), (3840, 2160));
    // Adding the same file again adds nothing.
    let again = core.add_sources(project.id.clone(), vec![fixture("numbered-4k-h264").display().to_string()]).await.unwrap();
    assert!(again.is_empty());

    wait_for_import(&sink, &first).await;
    let assets = wait_for_import(&sink, &second.id).await;
    check_media_server(&core, &assets, &second.id);

    // Ten seconds of speech, then the whole numbered clip: the export follows the first clip.
    let clips = vec![
        Clip { id: "clip-1".into(), source_id: first.clone(), start: 0, end: 10_000_000 },
        Clip { id: "clip-2".into(), source_id: second.id.clone(), start: 0, end: 30_000_000 },
    ];
    let request = ExportRequest {
        project_id: project.id.clone(),
        clips: clips.clone(),
        folder: dir.path().join("out").display().to_string(),
        file_name: "two".into(),
    };
    let plan = core.plan_export(request).await.unwrap();
    assert!(plan.notices.iter().any(|n| n.starts_with("Sources differ")), "{:?}", plan.notices);
    assert_eq!((plan.format.width, plan.format.height), (1920, 1080));
    let reopened = core.open_project(project.id.clone()).await.unwrap().project;
    let file = export_and_check(&core, &sink, &reopened, clips, &dir.path().join("out"), "two").await;
    assert_eq!(video_frames(&file), 1200);
    core.shutdown().await;
    assert_no_workers(5);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelling_an_import_and_an_export_leaves_nothing_running_or_half_written() {
    let _g = serial();
    let dir = Scratch::new("e2e-cancel");
    let (core, sink) = start(dir.path());
    let project = core.create_project(vec![fixture("numbered-4k-h264").display().to_string()]).await.unwrap();
    let id = project.sources[0].id.clone();

    // The proxy, part-way.
    let s = id.clone();
    let running = wait_for(&sink, "the proxy making progress", LONG, move |e| {
        matches!(e, JobEvent::JobUpdated(j) if j.kind == JobKind::Proxy && j.source_id.as_deref() == Some(s.as_str())
            && j.state == JobState::Running && j.progress > 0.02 && j.progress < 0.9)
    })
    .await;
    let JobEvent::JobUpdated(proxy) = running else { unreachable!() };
    core.cancel_job(proxy.id.clone()).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(120), core.runner().wait_idle()).await.expect("the work stops");
    assert_no_workers(5);

    let state = |job: &str| core.runner().status(job).unwrap().state;
    assert_eq!(state(&proxy.id), JobState::Cancelled);
    // Nothing half-written is left, and nothing is taken for a finished proxy.
    assert!(!core.cache().has(&id, rc_cache::CacheItem::Proxy));
    let leftovers: Vec<PathBuf> =
        files_under(&core.cache().source_dir(&id).unwrap()).into_iter().filter(|p| p.to_string_lossy().contains("proxy")).collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    assert_eq!(core.runner().assets(&id).unwrap().playback, PlaybackSource::Original);
    assert!(sink.count(|e| is_job(e, JobKind::Proxy, Some(&id), JobState::Done)) == 0);

    // Reopening restarts the cancelled work cleanly; the proxy is whole.
    core.open_project(project.id.clone()).await.unwrap();
    let s = id.clone();
    wait_for(&sink, "the proxy made again", LONG, move |e| is_job(e, JobKind::Proxy, Some(&s), JobState::Done)).await;
    let proxy_file = core.cache().item_path(&id, rc_cache::CacheItem::Proxy).unwrap();
    assert_eq!(video_frames(&proxy_file), 900);
    let s = id.clone();
    wait_for(&sink, "the transcript", LONG, move |e| matches!(e, JobEvent::TranscriptCompleted(p) if p.source_id == s)).await;
    tokio::time::timeout(std::time::Duration::from_secs(120), core.runner().wait_idle()).await.unwrap();

    // The export, part-way.
    let out = dir.path().join("out");
    let request = ExportRequest {
        project_id: project.id.clone(),
        clips: vec![Clip { id: "clip-1".into(), source_id: id.clone(), start: 0, end: 30_000_000 }],
        folder: out.display().to_string(),
        file_name: "cancelled".into(),
    };
    let job = core.start_export(request).await.unwrap();
    let j = job.clone();
    wait_for(&sink, "the export making progress", LONG, move |e| {
        matches!(e, JobEvent::JobUpdated(s) if s.id == j && s.state == JobState::Running && s.progress > 0.05)
    })
    .await;
    core.cancel_job(job.clone()).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(60), core.runner().wait_idle()).await.expect("the export stops");
    assert_no_workers(5);
    assert_eq!(core.runner().status(&job).unwrap().state, JobState::Cancelled);
    assert_eq!(sink.count(|e| matches!(e, JobEvent::ExportFinished(_))), 0);
    assert!(files_under(&out).is_empty(), "nothing at the destination: {:?}", files_under(&out));
    assert!(files_under(&core.cache().work_dir()).is_empty(), "no pieces left: {:?}", files_under(&core.cache().work_dir()));

    // The transcription, cancelled while it is known to be working: after its first batch of
    // speech. On the processor, so the two minutes take long enough to cancel part-way.
    let patch: roughcut_lib::api::types::SettingsPatch = serde_json::from_str(r#"{"speechDevice":"cpu"}"#).unwrap();
    core.update_settings(patch).await.unwrap();
    let speech = core.create_project(vec![fixture("speech-2min").display().to_string()]).await.unwrap();
    let sid = speech.sources[0].id.clone();
    let s = sid.clone();
    wait_for(&sink, "the first batch of speech", LONG, move |e| matches!(e, JobEvent::TranscriptAppended(p) if p.source_id == s))
        .await;
    let transcribe = core
        .list_jobs()
        .await
        .unwrap()
        .into_iter()
        .find(|j| j.kind == JobKind::Transcribe && j.source_id.as_deref() == Some(sid.as_str()))
        .unwrap();
    assert_eq!(transcribe.state, JobState::Running, "cancelled part-way");
    core.cancel_job(transcribe.id.clone()).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(120), core.runner().wait_idle()).await.expect("the work stops");
    assert_no_workers(5);
    assert_eq!(state(&transcribe.id), JobState::Cancelled);
    let audio = core
        .list_jobs()
        .await
        .unwrap()
        .into_iter()
        .find(|j| j.kind == JobKind::Audio && j.source_id.as_deref() == Some(sid.as_str()))
        .unwrap();
    assert_eq!(audio.state, JobState::Cancelled, "the linked audio job stops too");
    assert!(core.cache().read_transcript(&sid).unwrap().is_none(), "no transcript from a cancelled run");
    assert_eq!(sink.count(|e| matches!(e, JobEvent::TranscriptCompleted(p) if p.source_id == sid)), 0);
    let a = core.runner().assets(&sid).unwrap();
    assert_eq!(a.transcript, TranscriptProgress::None, "no transcript is said to be arriving");
    let t = core.get_transcript(sid.clone()).await.unwrap();
    assert!(!t.complete && t.utterances.is_empty(), "the abandoned partial transcript is not handed out");
    assert!(sink.count(|e| matches!(e, JobEvent::JobUpdated(j) if j.kind == JobKind::Suggest && j.source_id.as_deref() == Some(sid.as_str()))) == 0);
    core.shutdown().await;
    assert_no_workers(5);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_moved_source_is_reported_missing_and_relocated_only_to_the_same_file() {
    let _g = serial();
    let dir = Scratch::new("e2e-moved");
    let original = dir.path().join("footage").join("talk.mp4");
    std::fs::create_dir_all(original.parent().unwrap()).unwrap();
    std::fs::copy(fixture("speech-2min"), &original).unwrap();

    let (core, _sink) = start(dir.path());
    let project = core.create_project(vec![original.display().to_string()]).await.unwrap();
    let id = project.sources[0].id.clone();
    core.shutdown().await;
    drop(core);
    assert_no_workers(5);

    // The file is moved while the app is closed.
    let moved = dir.path().join("elsewhere").join("talk renamed.mp4");
    std::fs::create_dir_all(moved.parent().unwrap()).unwrap();
    std::fs::rename(&original, &moved).unwrap();

    let (core, sink) = start(dir.path());
    assert_eq!(core.list_projects().await.unwrap()[0].missing_sources, 1);
    let opened = core.open_project(project.id.clone()).await.unwrap();
    let a = &opened.assets[0];
    assert!(!a.online, "missing is reported");
    assert_ne!(a.playback, PlaybackSource::Original);
    assert!(sink.count(|e| is_assets(e, &id, |a| !a.online)) >= 1, "and sent as source_assets_changed");

    // A different file is refused, and nothing changes.
    let e = core
        .locate_source(project.id.clone(), id.clone(), fixture("numbered-4k-h264").display().to_string())
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::SourceMismatch);
    let still = core.open_project(project.id.clone()).await.unwrap();
    assert_eq!(still.project.sources[0].path, original.display().to_string());

    // The same file at its new path is accepted.
    let a = core.locate_source(project.id.clone(), id.clone(), moved.display().to_string()).await.unwrap();
    assert!(a.online);
    let reread = core.open_project(project.id.clone()).await.unwrap();
    assert!(PathBuf::from(&reread.project.sources[0].path).ends_with("talk renamed.mp4"));
    assert!(reread.assets[0].online);
    assert_eq!(core.list_projects().await.unwrap()[0].missing_sources, 0);
    // The original is served from its new place.
    let url = rc_types::media_url(core.media_base(), core.media_token(), &id, MediaItem::Original);
    let (status, _, body) = http_get(&url, Some("bytes=0-1023"));
    assert_eq!((status, body.len()), (206, 1024));
    core.shutdown().await;
    assert_no_workers(5);
}

/// While a project is open, its source file is moved away, put back, then replaced by another
/// recording (a drive unplugged, Explorer). The periodic check notices each change by itself
/// (no reopening, no call from the interface): `source_assets_changed` says offline or online,
/// the original is served only while it is the source's own file, and the export is blocked
/// with the Locate-file error while it is not.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_source_that_goes_missing_or_is_replaced_while_open_is_noticed() {
    let _g = serial();
    let dir = Scratch::new("e2e-watch");
    let path = dir.path().join("footage").join("talk.mp4");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::copy(fixture("speech-2min"), &path).unwrap();
    let (core, sink) = start(dir.path());
    let project = core.create_project(vec![path.display().to_string()]).await.unwrap();
    let id = project.sources[0].id.clone();
    tokio::time::timeout(std::time::Duration::from_secs(LONG), core.runner().wait_idle()).await.expect("the import finishes");
    let url = rc_types::media_url(core.media_base(), core.media_token(), &id, MediaItem::Original);
    assert_eq!(http_get(&url, Some("bytes=0-99")).0, 206);
    let request = ExportRequest {
        project_id: project.id.clone(),
        clips: vec![Clip { id: "c".into(), source_id: id.clone(), start: 0, end: 5_000_000 }],
        folder: dir.path().join("out").display().to_string(),
        file_name: "watched".into(),
    };
    assert!(core.plan_export(request.clone()).await.unwrap().blocked_by.is_none());
    let wait_secs = 3 * roughcut_lib::appcore::SOURCE_CHECK_INTERVAL.as_secs();

    // Moved away.
    let away = dir.path().join("away.mp4");
    std::fs::rename(&path, &away).unwrap();
    let before = sink.all().len();
    let s = id.clone();
    wait_for(&sink, "offline noticed", wait_secs, move |e| is_assets(e, &s, |a| !a.online)).await;
    assert!(sink.all().len() > before);
    assert!(!core.runner().assets(&id).unwrap().online);
    assert_eq!(http_get(&url, Some("bytes=0-99")).0, 404);
    let plan = core.plan_export(request.clone()).await.unwrap();
    assert_eq!(plan.blocked_by.map(|e| e.code), Some(ErrorCode::SourceMissing));
    assert_eq!(core.start_export(request.clone()).await.unwrap_err().code, ErrorCode::SourceMissing);

    // Put back: found again.
    std::fs::rename(&away, &path).unwrap();
    let n = sink.all().len();
    let s = id.clone();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(wait_secs);
    while !sink.all()[n..].iter().any(|e| is_assets(e, &s, |a| a.online)) {
        assert!(std::time::Instant::now() < deadline, "the source coming back was not noticed");
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(http_get(&url, Some("bytes=0-99")).0, 206);
    assert!(core.plan_export(request.clone()).await.unwrap().blocked_by.is_none());

    // Replaced by a different recording at the same path.
    std::fs::remove_file(&path).unwrap();
    std::fs::copy(fixture("numbered-4k-h264"), &path).unwrap();
    let n = sink.all().len();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(wait_secs);
    while !sink.all()[n..].iter().any(|e| is_assets(e, &s, |a| !a.online)) {
        assert!(std::time::Instant::now() < deadline, "the replaced file was not noticed");
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(http_get(&url, Some("bytes=0-99")).0, 404, "the other recording is not served as the original");
    let plan = core.plan_export(request.clone()).await.unwrap();
    assert_eq!(plan.blocked_by.map(|e| e.code), Some(ErrorCode::SourceMismatch));
    assert!(files_under(&dir.path().join("out")).is_empty());
    core.shutdown().await;
    assert_no_workers(5);
}
