//! The import pipeline for one source (spec 2.4.10, 2.5), suggestions, and the per-source
//! `SourceAssets` the runner keeps up to date.
//!
//! Order: proxy, speech audio and waveform start together (each under its resource limit);
//! transcription consumes the audio as it is extracted and publishes utterances as they come;
//! once the transcript is complete and cached, the suggest job finds dead air, publishes it,
//! then asks Claude. Each step whose result is already cached is skipped, and a failed step
//! only stops what depends on it.

use std::sync::Arc;

use rc_types::{
    AppError, ErrorCode, JobId, JobKind, MediaItem, PlaybackSource, ProjectId, SourceAssets, SourceId,
    SourceRef, Suggestion, SuggestionOrigin, SuggestionSet, SuggestionsProgress, SuggestionsUnavailablePayload,
    SUGGESTION_SET_SCHEMA_VERSION, TRANSCRIPT_SCHEMA_VERSION, Transcript,
    TranscriptAppendedPayload, TranscriptCompletedPayload, TranscriptProgress, Utterance, media_url,
};
use tokio::sync::mpsc;

use crate::events::JobEvent;
use crate::ports::{AUDIO_CHANNEL_CHUNKS, CacheItem};
use crate::runner::{EndGuard, Inner, JobHandle, JobRunner, JobSpec, Outcome, ResourceClass, State};

/// A source to import or resume: its project entry and whether the original is reachable.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceInput {
    /// The source as the project records it (id, current path, probe result).
    pub source: SourceRef,
    /// The original file is where the project expects it. Work that reads the original
    /// (proxy, waveform, speech audio) is not started while it is offline.
    pub online: bool,
}

/// What the runner knows about one source.
pub(crate) struct SourceEntry {
    pub(crate) source: SourceRef,
    pub(crate) project_id: ProjectId,
    pub(crate) online: bool,
    pub(crate) proxy_ready: bool,
    pub(crate) waveform_ready: bool,
    pub(crate) transcript: TranscriptProgress,
    pub(crate) suggestions: SuggestionsProgress,
    /// The transcript so far, while transcription runs.
    pub(crate) partial: Option<Transcript>,
}

pub(crate) fn assets_of(st: &State, id: &str) -> Option<SourceAssets> {
    let e = st.sources.get(id)?;
    let playback = if e.proxy_ready {
        PlaybackSource::Proxy
    } else if e.online && e.source.media.direct_playable {
        PlaybackSource::Original
    } else {
        PlaybackSource::None
    };
    let url = |item| Some(media_url(&st.media_base, &st.media_token, id, item));
    Some(SourceAssets {
        source_id: id.to_string(),
        online: e.online,
        playback,
        playback_url: match playback {
            PlaybackSource::None => None,
            PlaybackSource::Original => url(MediaItem::Original),
            PlaybackSource::Proxy => url(MediaItem::Proxy),
        },
        waveform_url: if e.waveform_ready { url(MediaItem::Waveform) } else { None },
        transcript: e.transcript,
        suggestions: e.suggestions,
    })
}

fn assets_event(st: &State, id: &str) -> Vec<JobEvent> {
    assets_of(st, id).map(JobEvent::SourceAssetsChanged).into_iter().collect()
}

/// Hands finished utterances from the transcriber to the runner, which keeps the partial
/// transcript and publishes `transcript_appended`.
#[derive(Clone)]
pub struct UtteranceSink {
    job: Option<JobHandle>,
    source_id: SourceId,
}

impl UtteranceSink {
    /// A sink attached to no job (for testing a port on its own); `append` does nothing.
    pub fn detached(source_id: SourceId) -> Self {
        UtteranceSink { job: None, source_id }
    }

    /// Publish newly finished utterances. Returns false once the job has ended (stop then).
    pub fn append(&self, utterances: Vec<Utterance>) -> bool {
        let Some(job) = &self.job else { return true };
        if utterances.is_empty() {
            return !job.is_cancelled();
        }
        let id = self.source_id.clone();
        job.emit_with(|st| {
            let Some(e) = st.sources.get_mut(&id) else {
                return vec![JobEvent::TranscriptAppended(TranscriptAppendedPayload {
                    source_id: id.clone(),
                    utterances,
                })];
            };
            let first = e.transcript == TranscriptProgress::None;
            e.transcript = TranscriptProgress::Partial;
            e.partial
                .get_or_insert_with(|| Transcript {
                    schema_version: TRANSCRIPT_SCHEMA_VERSION,
                    source_id: id.clone(),
                    model: String::new(),
                    complete: false,
                    utterances: Vec::new(),
                })
                .utterances
                .extend(utterances.iter().cloned());
            let mut evs = vec![JobEvent::TranscriptAppended(TranscriptAppendedPayload {
                source_id: id.clone(),
                utterances,
            })];
            if first {
                evs.extend(assets_event(st, &id));
            }
            evs
        })
    }
}

/// The jobs `import` queued for one source, each with the guard that ends it if its task
/// goes away, and what the cache already holds.
struct Started {
    proxy: Option<EndGuard>,
    waveform: Option<EndGuard>,
    /// Speech audio and its transcription, linked.
    speech: Option<(EndGuard, EndGuard)>,
    /// A suggest job for a transcript that is already complete in the cache.
    suggest: Option<(EndGuard, Transcript)>,
    /// The cached suggestion set (its dead air is reused).
    suggestions: Option<SuggestionSet>,
    /// Whether Claude's answer is still missing (run suggest after a fresh transcript).
    need_suggestions: bool,
}

impl JobRunner {
    /// Start (or resume) the import of each source (`create_project`, `add_sources`,
    /// `open_project`, and after `locate_source`). Cached results are skipped; whatever is
    /// unfinished restarts from the beginning (a partial transcript is discarded and
    /// re-streamed). The "not started twice" rule is per step: a step that already has an
    /// active job for the source is left to it, and every other missing step starts now, even
    /// while other steps of the source's earlier import are still running.
    /// Publishes and returns each source's `SourceAssets`.
    pub fn import(&self, project_id: &str, sources: Vec<SourceInput>) -> Vec<SourceAssets> {
        let mut out = Vec::with_capacity(sources.len());
        for input in sources {
            let id = input.source.id.clone();
            let online = input.online;
            // Cache reads stay outside the runner lock; results that land between these
            // reads and the lock are caught by the entry flags, set under the lock when a
            // step finishes.
            let cache = &self.inner.ports.cache;
            let cached_proxy = cache.is_ready(&id, CacheItem::Proxy);
            let cached_waveform = cache.is_ready(&id, CacheItem::Waveform);
            let cached_transcript = cache.read_transcript(&id).filter(|t| t.complete);
            let cached_suggestions = cached_transcript.as_ref().and_then(|_| cache.read_suggestions(&id));
            let cached_claude = cached_suggestions.as_ref().is_some_and(|s| s.claude_model.is_some());

            let mut st = self.inner.lock();
            let active = |st: &State, kind| st.active_job(kind, &id).is_some();
            let proxy_active = active(&st, JobKind::Proxy);
            let waveform_active = active(&st, JobKind::Waveform);
            let transcribing = active(&st, JobKind::Transcribe) || active(&st, JobKind::Audio);
            let suggesting = active(&st, JobKind::Suggest);
            let prev = st.sources.remove(&id);

            let proxy_ready = cached_proxy || prev.as_ref().is_some_and(|e| e.proxy_ready);
            let waveform_ready = cached_waveform || prev.as_ref().is_some_and(|e| e.waveform_ready);
            let transcript_complete = cached_transcript.is_some()
                || prev.as_ref().is_some_and(|e| e.transcript == TranscriptProgress::Complete);
            let claude_done =
                cached_claude || prev.as_ref().is_some_and(|e| e.suggestions == SuggestionsProgress::Ready);
            let (transcript, partial) = match prev {
                _ if transcript_complete => (TranscriptProgress::Complete, None),
                Some(e) if transcribing => (e.transcript, e.partial),
                _ => (TranscriptProgress::None, None),
            };
            st.sources.insert(
                id.clone(),
                SourceEntry {
                    source: input.source.clone(),
                    project_id: project_id.to_string(),
                    online,
                    proxy_ready,
                    waveform_ready,
                    transcript,
                    suggestions: if claude_done {
                        SuggestionsProgress::Ready
                    } else if suggesting {
                        SuggestionsProgress::Working
                    } else {
                        SuggestionsProgress::None
                    },
                    partial,
                },
            );

            // Queue every missing step now, under the lock, in the stand-in core's order:
            // proxy, audio, waveform, transcribe (then suggest when the transcript is cached).
            let inner = &self.inner;
            let job = |st: &mut State, kind, class| {
                inner.create_job_locked(st, &spec(kind, class, project_id, &id)).end_guard()
            };
            let need_proxy = online && !proxy_ready && !proxy_active;
            let need_waveform = online && !waveform_ready && !waveform_active;
            let need_speech = online && !transcript_complete && !transcribing;
            let proxy = need_proxy.then(|| job(&mut st, JobKind::Proxy, ResourceClass::GpuEncode));
            let audio = need_speech.then(|| {
                inner
                    .create_paired_job_locked(&mut st, &spec(JobKind::Audio, ResourceClass::Speech, project_id, &id))
                    .end_guard()
            });
            let waveform = need_waveform.then(|| job(&mut st, JobKind::Waveform, ResourceClass::Light));
            let speech = audio.map(|audio| {
                let transcribe = job(&mut st, JobKind::Transcribe, ResourceClass::Speech);
                inner.link_locked(&mut st, &audio.0, &transcribe.0);
                (audio, transcribe)
            });
            let suggest = match cached_transcript {
                Some(t) if !claude_done && !suggesting && !transcribing => {
                    create_suggest_job_locked(inner, &mut st, project_id, &id).ok().map(|h| (h.end_guard(), t))
                }
                _ => None,
            };

            if let Some(a) = assets_of(&st, &id) {
                self.inner.publish(&st, JobEvent::SourceAssetsChanged(a.clone()));
                out.push(a);
            }
            drop(st);
            let started = Started {
                proxy,
                waveform,
                speech,
                suggest,
                suggestions: cached_suggestions,
                need_suggestions: !claude_done,
            };
            start_steps(&self.inner, project_id, &input.source, started);
        }
        out
    }

    /// The sources that have an active job (their cache must not be removed now).
    pub fn busy_sources(&self) -> Vec<SourceId> {
        let st = self.inner.lock();
        let mut ids: Vec<SourceId> = st
            .jobs
            .iter()
            .filter(|j| crate::runner::is_active(j.status.state))
            .filter_map(|j| j.status.source_id.clone())
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    /// Forgets what the runner knows about sources whose cached files were removed
    /// (`clear_cache`, the size limit), so the next `import` looks at the cache again instead
    /// of trusting its own "proxy ready" flags. A source with an active job is kept. Returns
    /// the ids forgotten.
    pub fn forget_sources(&self, ids: &[SourceId]) -> Vec<SourceId> {
        let mut st = self.inner.lock();
        let mut out = Vec::new();
        for id in ids {
            let busy = st
                .jobs
                .iter()
                .any(|j| crate::runner::is_active(j.status.state) && j.status.source_id.as_deref() == Some(id.as_str()));
            if !busy && st.sources.remove(id).is_some() {
                out.push(id.clone());
            }
        }
        out
    }

    /// What is ready for a source, if it has been imported in this session.
    pub fn assets(&self, source_id: &str) -> Option<SourceAssets> {
        assets_of(&self.inner.lock(), source_id)
    }

    /// Record that the original went missing or was found again, and publish the change.
    /// (After `locate_source`, call `import` with the new path to resume unfinished work.)
    pub fn set_online(&self, source_id: &str, online: bool) -> Option<SourceAssets> {
        let mut st = self.inner.lock();
        let e = st.sources.get_mut(source_id)?;
        if e.online == online {
            return assets_of(&st, source_id);
        }
        e.online = online;
        let a = assets_of(&st, source_id)?;
        self.inner.publish(&st, JobEvent::SourceAssetsChanged(a.clone()));
        Some(a)
    }

    /// The transcript while it is still being made (`get_transcript` "as far as it has got").
    /// `None` when no transcription is in progress: read the cache then.
    pub fn partial_transcript(&self, source_id: &str) -> Option<Transcript> {
        let st = self.inner.lock();
        let e = st.sources.get(source_id)?;
        if e.transcript == TranscriptProgress::Partial { e.partial.clone() } else { None }
    }

    /// Ask for suggestions again (`retry_suggestions`). Dead air already in the cache is
    /// reused; Claude is called again. Returns the running suggest job if there is one.
    /// Fails if the source is unknown or its transcript is not complete.
    pub fn retry_suggestions(&self, source_id: &str) -> Result<JobId, AppError> {
        let (source, project_id) = {
            let st = self.inner.lock();
            let Some(e) = st.sources.get(source_id) else {
                return Err(AppError::internal("This source is not open."));
            };
            if let Some(id) = st.active_job(JobKind::Suggest, source_id) {
                return Ok(id);
            }
            (e.source.clone(), e.project_id.clone())
        };
        let cache = &self.inner.ports.cache;
        let transcript = cache
            .read_transcript(&source.id)
            .filter(|t| t.complete)
            .ok_or_else(|| AppError::internal("The transcript is not complete yet."))?;
        let cached = cache.read_suggestions(&source.id);
        let h = match create_suggest_job(&self.inner, &project_id, &source.id) {
            Ok(h) => h,
            Err(existing) => return Ok(existing),
        };
        let id = h.id.clone();
        let end = h.end_guard();
        self.inner.spawn_task(async move {
            run_suggest(end, source, transcript, cached).await;
        });
        Ok(id)
    }
}

fn spec(kind: JobKind, class: ResourceClass, project_id: &str, source_id: &str) -> JobSpec {
    JobSpec {
        kind,
        class,
        source_id: Some(source_id.to_string()),
        project_id: Some(project_id.to_string()),
    }
}

/// Run each queued step in a task of its own, so a panic in one port call fails only that
/// step's jobs (through their `EndGuard`s) and never strands its siblings.
fn start_steps(inner: &Arc<Inner>, project_id: &str, src: &SourceRef, s: Started) {
    for (guard, item) in [(s.proxy, CacheItem::Proxy), (s.waveform, CacheItem::Waveform)] {
        if let Some(guard) = guard {
            let (inner2, src) = (Arc::clone(inner), src.clone());
            inner.spawn_task(async move { file_step(&inner2, &src, guard, item).await });
        }
    }
    if let Some((audio, transcribe)) = s.speech {
        let (inner2, src, project) = (Arc::clone(inner), src.clone(), project_id.to_string());
        let (need_suggestions, cached) = (s.need_suggestions, s.suggestions.clone());
        inner.spawn_task(async move {
            let Some(t) = transcribe_step(&inner2, &src, audio, transcribe).await else { return };
            if need_suggestions && let Ok(h) = create_suggest_job(&inner2, &project, &src.id) {
                run_suggest(h.end_guard(), src, t, cached).await;
            }
        });
    }
    if let Some((guard, t)) = s.suggest {
        let (src, cached) = (src.clone(), s.suggestions);
        inner.spawn_task(async move { run_suggest(guard, src, t, cached).await });
    }
}

/// Proxy or waveform: make the file at its cache path, mark it finished, publish assets.
async fn file_step(inner: &Arc<Inner>, src: &SourceRef, end: EndGuard, item: CacheItem) {
    let h = &end.0;
    let Some(_slot) = inner.acquire(h).await else { return };
    inner.set_running(&[h]);
    let cache = &inner.ports.cache;
    let out = match cache.path_for(&src.id, item) {
        Ok(p) => p,
        Err(e) => {
            h.fail(e);
            return;
        }
    };
    let media = &inner.ports.media;
    let work = match item {
        CacheItem::Proxy => media.make_proxy(src, out, h.progress(), h.cancel_token()),
        CacheItem::Waveform => media.make_waveform(src, out, h.progress(), h.cancel_token()),
    };
    if let Outcome::Done(()) = h.run(work).await {
        if let Err(e) = cache.mark_finished(&src.id, item) {
            h.fail(e);
            return;
        }
        let id = src.id.clone();
        h.complete_with(|st| {
            if let Some(e) = st.sources.get_mut(&id) {
                match item {
                    CacheItem::Proxy => e.proxy_ready = true,
                    CacheItem::Waveform => e.waveform_ready = true,
                }
            }
            assets_event(st, &id)
        });
    }
}

/// Owned by a transcription step: when it ends without a finished transcript (failed,
/// cancelled, or its task went away), the source must not keep saying a transcript is
/// arriving (`partial`) while no job works on it. The partial transcript is dropped (the next
/// import transcribes from the start) and the change is published, so the interface removes
/// its progress line; the job's own status carries the reason.
struct TranscriptEnd {
    inner: Arc<Inner>,
    source_id: SourceId,
    finished: bool,
}

impl Drop for TranscriptEnd {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let mut st = self.inner.lock();
        let id = self.source_id.as_str();
        // A newer import may already be transcribing the source again: leave its state alone.
        if st.active_job(JobKind::Transcribe, id).is_some() || st.active_job(JobKind::Audio, id).is_some() {
            return;
        }
        let Some(e) = st.sources.get_mut(id) else { return };
        e.partial = None;
        if e.transcript != TranscriptProgress::Partial {
            return;
        }
        e.transcript = TranscriptProgress::None;
        for ev in assets_event(&st, id) {
            self.inner.publish(&st, ev);
        }
    }
}

/// Speech audio and transcription, run as a linked pair under one `Speech` slot. Returns the
/// finished, cached transcript.
async fn transcribe_step(
    inner: &Arc<Inner>,
    src: &SourceRef,
    audio_end: EndGuard,
    transcribe_end: EndGuard,
) -> Option<Transcript> {
    let mut end = TranscriptEnd { inner: Arc::clone(inner), source_id: src.id.clone(), finished: false };
    // The job guards are moved in and dropped there, so both jobs have ended by the time
    // `end` looks at the source.
    let t = transcribe_jobs(inner, src, audio_end, transcribe_end).await;
    end.finished = t.is_some();
    t
}

async fn transcribe_jobs(
    inner: &Arc<Inner>,
    src: &SourceRef,
    audio_end: EndGuard,
    transcribe_end: EndGuard,
) -> Option<Transcript> {
    let (audio, transcribe) = (audio_end.0.clone(), transcribe_end.0.clone());
    let _slot = inner.acquire(&transcribe).await?;
    if audio.is_cancelled() || transcribe.is_cancelled() {
        return None;
    }
    inner.set_running(&[&audio, &transcribe]);
    let (tx, rx) = mpsc::channel(AUDIO_CHANNEL_CHUNKS);

    let audio_fut = async {
        let work =
            inner.ports.media.extract_speech_audio(src, tx, audio.progress(), audio.cancel_token());
        match audio.run(work).await {
            Outcome::Done(()) => audio.complete_with(|_| Vec::new()),
            Outcome::Failed => {
                let err = inner
                    .lock()
                    .job(&audio.id)
                    .and_then(|e| e.status.error.clone())
                    .unwrap_or_else(|| AppError::internal("Reading the speech audio failed."));
                // "Cancelled" here means the transcriber stopped taking audio (it died or gave
                // up): its own job reports why, so its error is not replaced by this one.
                if err.code != ErrorCode::Cancelled {
                    // Without all the audio there can be no complete transcript.
                    transcribe.fail_and_stop(err);
                }
                false
            }
            Outcome::Cancelled => false,
        }
    };
    let transcribe_fut = async {
        let sink = UtteranceSink { job: Some(transcribe.clone()), source_id: src.id.clone() };
        let work = inner.ports.speech.transcribe(
            src,
            rx,
            sink,
            transcribe.progress(),
            transcribe.cancel_token(),
        );
        match transcribe.run(work).await {
            Outcome::Done(t) => Some(t),
            Outcome::Failed => {
                // The audio has nowhere to go any more.
                audio.stop();
                None
            }
            Outcome::Cancelled => None,
        }
    };
    let (audio_ok, transcript) = tokio::join!(audio_fut, transcribe_fut);
    let mut t = transcript?;
    if !audio_ok || transcribe.is_cancelled() {
        if !audio_ok {
            transcribe.fail_and_stop(AppError::internal("The speech audio did not finish."));
        }
        return None;
    }
    t.complete = true;
    t.source_id = src.id.clone();
    if let Err(e) = inner.ports.cache.write_transcript(&t) {
        transcribe.fail(e);
        return None;
    }
    let id = src.id.clone();
    let done = transcribe.complete_with(|st| {
        if let Some(e) = st.sources.get_mut(&id) {
            e.transcript = TranscriptProgress::Complete;
            e.partial = None;
        }
        let mut evs = vec![JobEvent::TranscriptCompleted(TranscriptCompletedPayload {
            source_id: id.clone(),
        })];
        evs.extend(assets_event(st, &id));
        evs
    });
    done.then_some(t)
}

/// Queue a suggest job for a source, unless one is active (then `Err(its id)`), and publish
/// the source's assets ("working").
fn create_suggest_job(inner: &Arc<Inner>, project_id: &str, source_id: &str) -> Result<JobHandle, JobId> {
    let mut st = inner.lock();
    let h = create_suggest_job_locked(inner, &mut st, project_id, source_id)?;
    for ev in assets_event(&st, source_id) {
        inner.publish(&st, ev);
    }
    Ok(h)
}

/// `create_suggest_job` without publishing the assets (the caller does).
fn create_suggest_job_locked(
    inner: &Arc<Inner>,
    st: &mut State,
    project_id: &str,
    source_id: &str,
) -> Result<JobHandle, JobId> {
    if let Some(existing) = st.active_job(JobKind::Suggest, source_id) {
        return Err(existing);
    }
    let h = inner.create_job_locked(st, &spec(JobKind::Suggest, ResourceClass::Claude, project_id, source_id));
    if let Some(e) = st.sources.get_mut(source_id) {
        e.suggestions = SuggestionsProgress::Working;
    }
    Ok(h)
}

/// Owned by a suggest task: however it ends, assets never keep saying "working" once no
/// suggest job is active for the source. Declared before the job's `EndGuard`, so it runs
/// after the job has been ended.
struct SuggestEnd {
    inner: Arc<Inner>,
    source_id: SourceId,
}

impl Drop for SuggestEnd {
    fn drop(&mut self) {
        let working = self
            .inner
            .lock()
            .sources
            .get(&self.source_id)
            .is_some_and(|e| e.suggestions == SuggestionsProgress::Working);
        if working {
            reset_after_cancel(&self.inner, &self.source_id);
        }
    }
}

fn set_suggestions(st: &mut State, id: &str, p: SuggestionsProgress) {
    if let Some(e) = st.sources.get_mut(id) {
        e.suggestions = p;
    }
}

/// Dead air first (or from the cache), published at once; then Claude. A Claude failure
/// publishes `suggestions_unavailable` and fails the job, leaving dead air in place. A dead-air
/// failure does not stop Claude; the job then ends failed with the dead-air error.
async fn run_suggest(end: EndGuard, src: SourceRef, transcript: Transcript, cached: Option<SuggestionSet>) {
    let h = end.0.clone();
    let inner = Arc::clone(&h.inner);
    let id = src.id.clone();
    let _quiet = SuggestEnd { inner: Arc::clone(&inner), source_id: id.clone() };
    let _end = end;
    let Some(_slot) = inner.acquire(&h).await else {
        reset_after_cancel(&inner, &id);
        return;
    };
    inner.set_running(&[&h]);
    let suggest = &inner.ports.suggest;
    let cache = &inner.ports.cache;

    let mut dead_err = None;
    let dead: Vec<Suggestion> = match cached {
        Some(set) => set.suggestions.into_iter().filter(|s| s.origin == SuggestionOrigin::Local).collect(),
        None => {
            let work = suggest.dead_air(&src, &transcript, h.cancel_token());
            // Run the dead-air step without failing the job yet.
            let r = async { Ok::<_, AppError>(work.await) };
            match h.run(r).await {
                Outcome::Done(Ok(found)) => {
                    let set = SuggestionSet {
                        schema_version: SUGGESTION_SET_SCHEMA_VERSION,
                        source_id: id.clone(),
                        claude_model: None,
                        suggestions: found.clone(),
                    };
                    if let Err(e) = cache.write_suggestions(&set) {
                        dead_err = Some(e);
                    }
                    h.emit_with(|_| vec![JobEvent::SuggestionsReady(set)]);
                    found
                }
                Outcome::Done(Err(e)) => {
                    dead_err = Some(e);
                    Vec::new()
                }
                Outcome::Failed | Outcome::Cancelled => {
                    reset_after_cancel(&inner, &id);
                    return;
                }
            }
        }
    };
    h.progress().set(0.2, None);

    let work = suggest.claude(&src, &transcript, h.cancel_token());
    let r = async { Ok::<_, AppError>(work.await) };
    match h.run(r).await {
        Outcome::Done(Ok(answer)) => {
            let all = suggest.merge(dead, answer.suggestions);
            let set = SuggestionSet {
                schema_version: SUGGESTION_SET_SCHEMA_VERSION,
                source_id: id.clone(),
                claude_model: Some(answer.model),
                suggestions: all,
            };
            if let Err(e) = cache.write_suggestions(&set) {
                dead_err.get_or_insert(e);
            }
            let publish = |st: &mut State| {
                set_suggestions(st, &id, SuggestionsProgress::Ready);
                let mut evs = vec![JobEvent::SuggestionsReady(set)];
                evs.extend(assets_event(st, &id));
                evs
            };
            match dead_err {
                None => {
                    h.complete_with(publish);
                }
                Some(e) => {
                    h.emit_with(publish);
                    h.fail(e);
                }
            }
        }
        Outcome::Done(Err(error)) => {
            h.emit_with(|st| {
                set_suggestions(st, &id, SuggestionsProgress::Unavailable);
                let mut evs = vec![JobEvent::SuggestionsUnavailable(SuggestionsUnavailablePayload {
                    source_id: id.clone(),
                    error: error.clone(),
                })];
                evs.extend(assets_event(st, &id));
                evs
            });
            h.fail(error);
        }
        Outcome::Failed | Outcome::Cancelled => reset_after_cancel(&inner, &id),
    }
}

/// A cancelled suggest job publishes nothing more; fix the recorded state quietly so later
/// `assets` calls do not say "working".
fn reset_after_cancel(inner: &Inner, id: &str) {
    let next = match inner.ports.cache.read_suggestions(&id.to_string()) {
        Some(s) if s.claude_model.is_some() => SuggestionsProgress::Ready,
        _ => SuggestionsProgress::None,
    };
    let mut st = inner.lock();
    if st.active_job(JobKind::Suggest, id).is_none() {
        set_suggestions(&mut st, id, next);
    }
}
