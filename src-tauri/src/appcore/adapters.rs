//! The adapters the job runner and the other modules ask for (spec 3.6): the runner's media,
//! transcription, suggestions and cache ports onto rc-media, rc-speech, rc-suggest and
//! rc-cache; rc-source's probe onto rc-media's; the media server's file locator onto the cache
//! and the projects' sources.
//!
//! Every media, speech and Claude task is blocking; it runs on a blocking thread and is told to
//! stop (its own cancel token) when the job's token fires. The port then waits for the task
//! to clean up before it returns, so after a cancelled job's port call has returned, no
//! FFmpeg, transcriber or claude process of it is left.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use rc_cache::{Cache, CacheItem as CacheFile};
use rc_jobs::{
    AudioSender, AudioStream, BoxFuture, CacheItem, CachePort, CancellationToken, ClaudeAnswer, ExportInput, MediaPort,
    Progress, SpeechPort, SuggestPort, UtteranceSink,
};
use rc_media::{ExportOptions, ExportSource, ExportSpec, FfmpegTools};
use rc_project::ProjectStore;
use rc_settings::SettingsStore;
use rc_types::{
    AppError, ErrorCode, ExportResult, MediaInfo, MediaItem, Rational, SourceId, SourceRef, Suggestion, SuggestionSet,
    Transcript,
};

use super::config::AppConfig;
use super::models::ModelManager;

// ---------------------------------------------------------------- running blocking work

fn joined<T>(r: Result<Result<T, AppError>, tokio::task::JoinError>) -> Result<T, AppError> {
    r.unwrap_or_else(|e| Err(AppError::internal("A background task stopped unexpectedly.").with_detail(e.to_string())))
}

/// Runs `f` on a blocking thread.
pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, AppError> + Send + 'static) -> Result<T, AppError> {
    joined(tokio::task::spawn_blocking(f).await)
}

/// Runs blocking `work`; when `cancel` fires, calls `on_cancel` (which tells the work to stop)
/// and still waits for the work to return, so its cleanup is done when this returns.
pub(crate) async fn with_cancel<T: Send + 'static>(
    cancel: CancellationToken,
    on_cancel: impl FnOnce(),
    work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let mut task = tokio::task::spawn_blocking(work);
    tokio::select! {
        r = &mut task => joined(r),
        () = cancel.cancelled() => {
            on_cancel();
            joined(task.await)
        }
    }
}

/// [`with_cancel`] for an rc-media task.
async fn media_task<T: Send + 'static>(
    cancel: CancellationToken,
    work: impl FnOnce(&rc_media::CancelToken) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let token = rc_media::CancelToken::new();
    let inner = token.clone();
    with_cancel(cancel, move || token.cancel(), move || work(&inner)).await
}

fn cancelled() -> AppError {
    AppError::new(ErrorCode::Cancelled, "Cancelled.")
}

/// The sequence grid a source's transcript and suggestions snap to: its own frame rate (the
/// transcript is cached per source and shared by every project that uses it).
fn source_grid(media: &MediaInfo) -> Option<Rational> {
    let r = media.video.frame_rate;
    (r.num > 0 && r.den > 0).then_some(r)
}

// ---------------------------------------------------------------- FFmpeg

/// FFmpeg and ffprobe, found once on first use (a missing FFmpeg is reported by the task
/// that needed it, not at start-up).
pub(crate) struct Tools {
    dir: Option<PathBuf>,
    found: OnceLock<Arc<FfmpegTools>>,
}

impl Tools {
    pub(crate) fn new(dir: Option<PathBuf>) -> Tools {
        Tools { dir, found: OnceLock::new() }
    }

    pub(crate) fn get(&self) -> Result<Arc<FfmpegTools>, AppError> {
        if let Some(t) = self.found.get() {
            return Ok(Arc::clone(t));
        }
        let t = Arc::new(FfmpegTools::locate(self.dir.as_deref())?);
        Ok(Arc::clone(self.found.get_or_init(|| t)))
    }
}

/// rc-source's probe, onto rc-media's.
pub(crate) struct MediaProbe(pub(crate) Arc<FfmpegTools>);

impl rc_source::Probe for MediaProbe {
    fn probe(&self, path: &Path) -> Result<MediaInfo, AppError> {
        rc_media::probe(&self.0, path, &rc_media::CancelToken::new())
    }
}

// ---------------------------------------------------------------- cache

fn cache_file(item: CacheItem) -> CacheFile {
    match item {
        CacheItem::Proxy => CacheFile::Proxy,
        CacheItem::Waveform => CacheFile::Waveform,
    }
}

/// The runner's cache port onto rc-cache. The cache names every file: a task writes the
/// cache's in-progress name (`path_for` is `Cache::partial_path`) and `mark_finished` is
/// `Cache::finish`, so a half-written item is never taken for a finished one.
pub(crate) struct CacheAdapter(pub(crate) Cache);

impl CachePort for CacheAdapter {
    fn is_ready(&self, source: &SourceId, item: CacheItem) -> bool {
        self.0.has(source, cache_file(item))
    }
    fn path_for(&self, source: &SourceId, item: CacheItem) -> Result<PathBuf, AppError> {
        self.0.partial_path(source, cache_file(item))
    }
    fn mark_finished(&self, source: &SourceId, item: CacheItem) -> Result<(), AppError> {
        self.0.finish(source, cache_file(item)).map(|_| ())
    }
    fn read_transcript(&self, source: &SourceId) -> Option<Transcript> {
        self.0.read_transcript(source).ok().flatten()
    }
    fn write_transcript(&self, transcript: &Transcript) -> Result<(), AppError> {
        self.0.write_transcript(transcript).map(|_| ())
    }
    fn read_suggestions(&self, source: &SourceId) -> Option<SuggestionSet> {
        self.0.read_suggestions(source).ok().flatten()
    }
    fn write_suggestions(&self, set: &SuggestionSet) -> Result<(), AppError> {
        self.0.write_suggestions(set).map(|_| ())
    }
}

// ---------------------------------------------------------------- media

/// The runner's media port onto rc-media.
pub(crate) struct MediaAdapter {
    pub(crate) tools: Arc<Tools>,
    pub(crate) cache: Cache,
    pub(crate) projects: Arc<ProjectStore>,
    /// Export choices from the configuration (the free-space test hook).
    pub(crate) export_options: ExportOptions,
}

/// Every source of a project as rc-media's export wants it.
pub(crate) fn export_sources(sources: &[SourceRef]) -> HashMap<SourceId, ExportSource> {
    sources.iter().map(|s| (s.id.clone(), ExportSource { path: PathBuf::from(&s.path), media: s.media.clone() })).collect()
}

const AUDIO_CHUNK_BYTES: usize = 64 * 1024;

impl MediaPort for MediaAdapter {
    fn make_proxy<'a>(
        &'a self,
        source: &'a SourceRef,
        out: PathBuf,
        progress: Progress,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<(), AppError>> {
        Box::pin(async move {
            let tools = self.tools.get()?;
            let src = source.clone();
            media_task(cancel, move |token| {
                let path = PathBuf::from(&src.path);
                let mut req = rc_media::ProxyRequest::new(&path, &src.media, &out);
                // `out` is the cache's in-progress name; the runner then calls `finish`.
                req.in_place = true;
                rc_media::make_proxy(&tools, &req, token, &mut |p| progress.set(p.fraction, p.seconds_left)).map(|_| ())
            })
            .await
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
            let tools = self.tools.get()?;
            let src = source.clone();
            media_task(cancel, move |token| {
                let path = PathBuf::from(&src.path);
                let req = rc_media::SpeechAudioRequest::new(&path, &src.media);
                let mut stream = rc_media::start_speech_audio(&tools, &req, token)?;
                let mut buf = vec![0u8; AUDIO_CHUNK_BYTES];
                loop {
                    let n = match stream.read(&mut buf) {
                        Ok(n) => n,
                        Err(_) if token.is_cancelled() => return Err(cancelled()),
                        // `finish` reports what went wrong with FFmpeg.
                        Err(_) => break,
                    };
                    if n == 0 {
                        break;
                    }
                    if audio.blocking_send(buf[..n].to_vec()).is_err() {
                        // The transcriber has stopped: nothing wants the rest.
                        stream.cancel();
                        return Err(cancelled());
                    }
                    let p = stream.progress();
                    progress.set(p.fraction, p.seconds_left);
                }
                stream.finish().map(|_| ())
            })
            .await
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
            let tools = self.tools.get()?;
            let src = source.clone();
            media_task(cancel, move |token| {
                let path = PathBuf::from(&src.path);
                let req = rc_media::WaveformRequest { in_place: true, ..rc_media::WaveformRequest::new(&path, &src.media, &src.id, &out) };
                rc_media::make_waveform(&tools, &req, token, &mut |p| progress.set(p.fraction, p.seconds_left)).map(|_| ())
            })
            .await
        })
    }

    fn run_export<'a>(
        &'a self,
        export: &'a ExportInput,
        progress: Progress,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<ExportResult, AppError>> {
        Box::pin(async move {
            let tools = self.tools.get()?;
            let projects = Arc::clone(&self.projects);
            let request = export.request.clone();
            let sources = export_sources(&export.sources);
            let work_root = self.cache.work_dir();
            let export_options = self.export_options.clone();
            media_task(cancel, move |token| {
                // The sequence grid is the project's (its first source's frame rate).
                let project = projects.read(&request.project_id)?;
                let spec = ExportSpec {
                    request: &request,
                    sources: &sources,
                    frame_rate: project.frame_rate,
                    work_root: &work_root,
                    options: export_options.clone(),
                };
                let result = rc_media::run_export(&tools, &spec, token, &mut |p| progress.set(p.fraction, p.seconds_left))?;
                // Shown on the Home list; the file is complete either way.
                if let Err(e) = projects.record_export(&request.project_id, result.clone()) {
                    eprintln!("roughcut: could not record the export in the project: {e}");
                }
                Ok(result)
            })
            .await
        })
    }
}

// ---------------------------------------------------------------- speech

/// Reads the audio channel as a byte stream for the transcriber's input.
struct ChannelReader {
    rx: AudioStream,
    chunk: Vec<u8>,
    at: usize,
}

impl Read for ChannelReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        while self.at >= self.chunk.len() {
            match self.rx.blocking_recv() {
                Some(c) => {
                    self.chunk = c;
                    self.at = 0;
                }
                None => return Ok(0),
            }
        }
        let n = buf.len().min(self.chunk.len() - self.at);
        buf[..n].copy_from_slice(&self.chunk[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}

/// `transcriber_failed` for a transcriber program that is not where the app looks for it.
pub(crate) fn missing_transcriber(program: &Path) -> AppError {
    AppError::new(ErrorCode::TranscriberFailed, "The transcriber is not installed, so no transcript can be made.").with_detail(format!(
        "{} not found (set {} to the folder holding transcriber.exe and its runtime files)",
        program.display(),
        super::config::TRANSCRIBER_DIR_ENV
    ))
}

/// The runner's transcription port onto rc-speech, which runs the transcriber program.
pub(crate) struct SpeechAdapter {
    pub(crate) config: Arc<AppConfig>,
    pub(crate) settings: Arc<SettingsStore>,
    pub(crate) models: Arc<ModelManager>,
}

impl SpeechPort for SpeechAdapter {
    fn transcribe<'a>(
        &'a self,
        source: &'a SourceRef,
        audio: AudioStream,
        batches: UtteranceSink,
        progress: Progress,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<Transcript, AppError>> {
        Box::pin(async move {
            let settings = self.settings.get().unwrap_or_else(|_| rc_settings::defaults());
            // No download for a transcription that could not run anyway.
            let program = self.config.transcriber_exe();
            if !program.is_file() {
                return Err(missing_transcriber(&program));
            }
            // First run: the model is downloaded (its own job) before the transcriber starts.
            self.models.ensure(&settings, &cancel).await?;
            let command = rc_speech::TranscriberCommand {
                program,
                model_dir: self.models.model_dir(),
                device: settings.speech_device,
                vad_model: Some(self.models.vad_model()),
            };
            let job = rc_speech::TranscribeJob {
                source_id: source.id.clone(),
                duration: source.media.duration,
                options: rc_speech::BuildOptions { cut_grid: source_grid(&source.media), ..rc_speech::BuildOptions::default() },
            };
            let token = rc_speech::CancelToken::new();
            let inner = token.clone();
            with_cancel(cancel, move || token.cancel(), move || {
                let reader = ChannelReader { rx: audio, chunk: Vec::new(), at: 0 };
                let stop = inner.clone();
                rc_speech::transcribe(&command, &job, reader, &inner, move |ev| match ev {
                    rc_speech::SpeechEvent::Utterances(batch) => {
                        if !batches.append(batch) {
                            stop.cancel();
                        }
                    }
                    rc_speech::SpeechEvent::Progress { fraction, .. } => progress.set(fraction, None),
                    // One line in the app's log: which model and device the transcript uses.
                    rc_speech::SpeechEvent::Ready { model, device, fallback } => {
                        eprintln!("roughcut: transcriber ready: model {model}, device {device:?}, fallback {fallback}");
                    }
                })
            })
            .await
        })
    }
}

// ---------------------------------------------------------------- suggestions

/// The runner's suggestions port onto rc-suggest: dead air locally, then one Claude call.
pub(crate) struct SuggestAdapter {
    pub(crate) config: Arc<AppConfig>,
    pub(crate) settings: Arc<SettingsStore>,
}

impl SuggestAdapter {
    /// How to run `claude` with the current settings.
    pub(crate) fn claude_config(&self) -> rc_suggest::ClaudeConfig {
        claude_config(&self.config, &self.settings)
    }
}

/// How to run `claude`: the settings' model and sign-in method, the configured program.
pub(crate) fn claude_config(config: &AppConfig, settings: &SettingsStore) -> rc_suggest::ClaudeConfig {
    let s = settings.get().unwrap_or_else(|_| rc_settings::defaults());
    // A key is only ever read when the user chose the API-key method (spec 2.4.6).
    let key = if s.claude_auth == rc_types::ClaudeAuth::ApiKey {
        rc_settings::ApiKeyStore::new(rc_settings::DEFAULT_API_KEY_TARGET).get().ok().flatten()
    } else {
        None
    };
    let mut cfg = rc_suggest::ClaudeConfig::from_settings(&s, key);
    cfg.program = config.claude_program.clone();
    cfg.extra_env = config.claude_extra_env.clone();
    cfg
}

impl SuggestPort for SuggestAdapter {
    fn dead_air<'a>(
        &'a self,
        source: &'a SourceRef,
        transcript: &'a Transcript,
        _cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<Vec<Suggestion>, AppError>> {
        Box::pin(async move { Ok(rc_suggest::find_dead_air(transcript, source_grid(&source.media))) })
    }

    fn claude<'a>(
        &'a self,
        source: &'a SourceRef,
        transcript: &'a Transcript,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<ClaudeAnswer, AppError>> {
        Box::pin(async move {
            let cfg = self.claude_config();
            if !rc_suggest::request::has_words(transcript) {
                // Nothing was said: there is nothing to ask Claude about.
                return Ok(ClaudeAnswer { model: cfg.model, suggestions: Vec::new() });
            }
            let t = transcript.clone();
            let grid = source_grid(&source.media);
            let flag = Arc::new(AtomicBool::new(false));
            let inner = Arc::clone(&flag);
            with_cancel(cancel, move || flag.store(true, Ordering::SeqCst), move || {
                let answer = rc_suggest::ask_claude(&rc_suggest::build_request(&t), &cfg, &inner)?;
                let suggestions = rc_suggest::map_suggestions(&t, &answer.suggestions, grid);
                Ok(ClaudeAnswer { model: answer.model.unwrap_or_else(|| cfg.model.clone()), suggestions })
            })
            .await
        })
    }

    fn merge(&self, dead_air: Vec<Suggestion>, claude: Vec<Suggestion>) -> Vec<Suggestion> {
        rc_suggest::merge_suggestions(dead_air, claude)
    }
}

// ---------------------------------------------------------------- media server

/// Where each open source's original file is, and whether the file there was last found to be
/// the source's own (its fingerprint matched), for the media server (`/original`).
#[derive(Default)]
pub(crate) struct SourcePaths(RwLock<HashMap<SourceId, (PathBuf, bool)>>);

impl SourcePaths {
    /// Records the source's path and whether the file there is the source (checked by the caller).
    pub(crate) fn set(&self, id: &str, path: &Path, online: bool) {
        self.0.write().unwrap_or_else(|p| p.into_inner()).insert(id.to_string(), (path.to_path_buf(), online));
    }
    /// Records a new check of a known source.
    pub(crate) fn set_online(&self, id: &str, online: bool) {
        if let Some(e) = self.0.write().unwrap_or_else(|p| p.into_inner()).get_mut(id) {
            e.1 = online;
        }
    }
    /// The source's path, only while it is known to hold the source's own file.
    pub(crate) fn online_path(&self, id: &str) -> Option<PathBuf> {
        self.0.read().unwrap_or_else(|p| p.into_inner()).get(id).filter(|e| e.1).map(|e| e.0.clone())
    }
}

/// The media server's file locator: proxies and waveforms from the cache (only when finished),
/// originals from the projects' sources (only when the file there was verified to be the
/// source's own and is still there; a different recording at the same path is never served).
pub(crate) fn locator(cache: Cache, paths: Arc<SourcePaths>) -> impl Fn(&str, MediaItem) -> Option<PathBuf> + Send + Sync + 'static {
    move |id: &str, item: MediaItem| match item {
        MediaItem::Proxy | MediaItem::Waveform => {
            let file = if item == MediaItem::Proxy { CacheFile::Proxy } else { CacheFile::Waveform };
            if cache.has(id, file) { cache.item_path(id, file).ok() } else { None }
        }
        MediaItem::Original => paths.online_path(id).filter(|p| p.is_file()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_channel_reader_returns_every_byte_in_order_then_ends() {
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        let feeder = std::thread::spawn(move || {
            for i in 0..10u8 {
                tx.blocking_send(vec![i; (i as usize) * 3 + 1]).unwrap();
            }
        });
        let mut r = ChannelReader { rx, chunk: Vec::new(), at: 0 };
        let mut all = Vec::new();
        let mut small = [0u8; 5];
        loop {
            let n = r.read(&mut small).unwrap();
            if n == 0 {
                break;
            }
            all.extend_from_slice(&small[..n]);
        }
        feeder.join().unwrap();
        let want: Vec<u8> = (0..10u8).flat_map(|i| vec![i; (i as usize) * 3 + 1]).collect();
        assert_eq!(all, want);
    }

    #[test]
    fn the_locator_serves_only_finished_cache_items_and_present_originals() {
        let dir = std::env::temp_dir().join(format!("rc-app-locator-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let cache = Cache::new(dir.join("cache"));
        let paths = Arc::new(SourcePaths::default());
        let id = "0123456789abcdef0123456789abcdef";
        let find = locator(cache.clone(), Arc::clone(&paths));
        assert_eq!(find(id, MediaItem::Proxy), None);
        // An in-progress proxy is never served.
        let part = cache.partial_path(id, CacheFile::Proxy).unwrap();
        std::fs::write(&part, b"half").unwrap();
        assert_eq!(find(id, MediaItem::Proxy), None);
        let done = cache.finish(id, CacheFile::Proxy).unwrap();
        assert_eq!(find(id, MediaItem::Proxy), Some(done));
        assert_eq!(find(id, MediaItem::Waveform), None);
        // Originals: only a registered file that exists and was found to be the source's own.
        assert_eq!(find(id, MediaItem::Original), None);
        let original = dir.join("a.mp4");
        paths.set(id, &original, true);
        assert_eq!(find(id, MediaItem::Original), None);
        std::fs::write(&original, b"x").unwrap();
        assert_eq!(find(id, MediaItem::Original), Some(original.clone()));
        // A file that is there but is not the source (replaced, or offline) is not served.
        paths.set_online(id, false);
        assert_eq!(find(id, MediaItem::Original), None);
        paths.set_online(id, true);
        assert_eq!(find(id, MediaItem::Original), Some(original.clone()));
        paths.set(id, &original, false);
        assert_eq!(find(id, MediaItem::Original), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
