//! The application object: one [`AppCore`] owns the data and cache locations, the settings,
//! the project store, the cache, the job runner, the media server (started with its token at
//! launch) and where the outside programs are. Every command of spec 3.5.4 is a method here
//! that needs no window, so tests call them directly; `api::commands` only forwards to them.
//! Events (spec 3.5.5) leave through the [`EventSink`] given at start-up: the app turns them
//! into Tauri events, tests collect them.
//!
//! Start-up ([`AppCore::start`]) reads nothing slow: it opens the stores, empties the cache's
//! work folder, starts the media server and the runner. Unfinished work restarts when a
//! project is opened (spec 2.4.10: the runner skips whatever the cache already holds).
//! Shut-down ([`AppCore::shutdown`]) cancels every job, waits until their FFmpeg, transcriber
//! and claude processes are gone, then stops the media server. Every child process is also in
//! a kill-on-close job object, so none outlives the app even if it crashes.

pub mod adapters;
pub mod config;
pub(crate) mod models;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use rc_cache::Cache;
use rc_jobs::{CancellationToken, EventSink, ExportInput, JobEvent, JobRunner, Ports, RunnerConfig, SourceInput};
use rc_project::ProjectStore;
use rc_server::MediaServer;
use rc_settings::SettingsStore;
use rc_source::SourceStatus;
use rc_types::{
    AppError, CacheUsage, ClaudeStatus, EditDocument, ErrorCode, ExportPlan, ExportRequest, JobId, JobState, JobStatus, OpenedProject,
    Project, ProjectId, ProjectSummary, SUGGESTION_SET_SCHEMA_VERSION, SessionState, Settings, SourceAssets, SourceId,
    SourceRef, SuggestionSet, TRANSCRIPT_SCHEMA_VERSION, Transcript,
};

use crate::api::types::SettingsPatch;
use adapters::{
    CacheAdapter, MediaAdapter, MediaProbe, SourcePaths, SpeechAdapter, SuggestAdapter, Tools, blocking, export_sources,
};
pub use config::AppConfig;
use models::ModelManager;

/// The core of the app. Create it once with [`AppCore::start`]; share it as `Arc<AppCore>`.
pub struct AppCore {
    config: Arc<AppConfig>,
    settings: Arc<SettingsStore>,
    projects: Arc<ProjectStore>,
    cache: Cache,
    runner: JobRunner,
    server: Mutex<Option<MediaServer>>,
    media_base: String,
    media_token: String,
    tools: Arc<Tools>,
    paths: Arc<SourcePaths>,
    suggest: Arc<SuggestAdapter>,
    models: Arc<ModelManager>,
    /// The project the interface has open (its sources count as in use for the cache).
    open: Mutex<Option<ProjectId>>,
    /// Fires at shut-down: stops the periodic source check.
    stopping: CancellationToken,
}

/// How often the open project's sources are checked while the app runs (a drive unplugged,
/// a file moved or replaced in Explorer). Each check reads at most a fingerprint's worth
/// (about 256 KB for a large file) per source.
pub const SOURCE_CHECK_INTERVAL: Duration = Duration::from_secs(5);

/// The error that blocks an export of a source that is not usable where the project expects it.
fn source_problem(source: &SourceRef, status: SourceStatus) -> Option<AppError> {
    let name = Path::new(&source.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| source.path.clone());
    let (code, message) = match status {
        SourceStatus::Online => return None,
        SourceStatus::Missing => (ErrorCode::SourceMissing, format!("A source file is missing: {name}. Locate it first.")),
        SourceStatus::Changed => (
            ErrorCode::SourceMismatch,
            format!("The file at {name} is not the recording this project uses. Locate the original file first."),
        ),
        SourceStatus::Unreadable => {
            (ErrorCode::SourceUnreadable, format!("A source file could not be read: {name}. Check the drive, or locate it again."))
        }
    };
    Some(AppError::new(code, message).with_detail(source.path.clone()))
}

fn not_found(what: &str) -> AppError {
    AppError::internal(what.to_string())
}

/// Passes every event on, and wakes the cache-limit check whenever a job that writes into a
/// source's cache folder has finished: the cache grows while a project is open (a proxy of an
/// hour of 4K is several GB), not only when one is made or opened.
pub(crate) struct CacheLimitSink {
    inner: Arc<dyn EventSink>,
    wake: Arc<tokio::sync::Notify>,
}

impl CacheLimitSink {
    pub(crate) fn new(inner: Arc<dyn EventSink>, wake: Arc<tokio::sync::Notify>) -> CacheLimitSink {
        CacheLimitSink { inner, wake }
    }
}

impl EventSink for CacheLimitSink {
    fn publish(&self, event: JobEvent) {
        let wrote = matches!(&event, JobEvent::JobUpdated(j) if j.state == JobState::Done && j.source_id.is_some());
        self.inner.publish(event);
        if wrote {
            // Coalesces: several jobs finishing together give one check.
            self.wake.notify_one();
        }
    }
}

impl AppCore {
    /// Starts the core: stores, cache, media server (on 127.0.0.1, with a fresh token), job
    /// runner. Must be called inside a Tokio runtime; jobs run on `handle`.
    pub fn start(config: AppConfig, sink: Arc<dyn EventSink>, handle: tokio::runtime::Handle) -> Result<Arc<AppCore>, AppError> {
        let config = Arc::new(config);
        let settings = Arc::new(SettingsStore::new(config.settings_path()));
        // Read once now so an unreadable settings file is reported at launch; every reader
        // falls back to the defaults (spec 1.12) and the interface gets the error from
        // `get_settings`.
        if let Err(e) = settings.get() {
            eprintln!("roughcut: the settings could not be read, defaults are used: {}", e.message);
        }
        let projects = Arc::new(ProjectStore::new(config.projects_dir()));
        let cache = Cache::new(&config.cache_dir);
        // Pieces of an export the last run could not finish (nothing is running yet).
        if let Err(e) = cache.clear_work_dir() {
            eprintln!("roughcut: could not empty the cache's work folder: {e}");
        }
        let paths = Arc::new(SourcePaths::default());
        let server = MediaServer::start(Arc::new(adapters::locator(cache.clone(), Arc::clone(&paths))))
            .map_err(|e| AppError::internal("The media server could not start.").with_detail(e.to_string()))?;
        let media_base = server.base().to_string();
        let media_token = server.token().to_string();
        let tools = Arc::new(Tools::new(config.ffmpeg_dir.clone()));
        let models = Arc::new(ModelManager::new(
            config.model_dir.clone(),
            config.transcriber_dir.clone(),
            config.model_packages.clone(),
        ));
        let suggest = Arc::new(SuggestAdapter { config: Arc::clone(&config), settings: Arc::clone(&settings) });
        let ports = Ports {
            media: Arc::new(MediaAdapter {
                tools: Arc::clone(&tools),
                cache: cache.clone(),
                projects: Arc::clone(&projects),
                export_options: config.export_options(),
            }),
            speech: Arc::new(SpeechAdapter {
                config: Arc::clone(&config),
                settings: Arc::clone(&settings),
                models: Arc::clone(&models),
            }),
            suggest: suggest.clone(),
            cache: Arc::new(CacheAdapter(cache.clone())),
        };
        let limit_wake = Arc::new(tokio::sync::Notify::new());
        let sink: Arc<dyn EventSink> = Arc::new(CacheLimitSink::new(sink, Arc::clone(&limit_wake)));
        let runner = JobRunner::new(
            RunnerConfig { media_base: media_base.clone(), media_token: media_token.clone(), limits: config.limits },
            ports,
            sink,
            handle.clone(),
        );
        models.attach(runner.clone());
        let core = Arc::new(AppCore {
            config,
            settings,
            projects,
            cache,
            runner,
            server: Mutex::new(Some(server)),
            media_base,
            media_token,
            tools,
            paths,
            suggest,
            models,
            open: Mutex::new(None),
            stopping: CancellationToken::new(),
        });
        core.watch_sources(handle.clone(), Arc::downgrade(&core));
        core.watch_cache_limit(handle, limit_wake, Arc::downgrade(&core));
        Ok(core)
    }

    /// Keeps the cache within its limit as it grows: checked each time a job that writes into
    /// the cache has finished (see [`CacheLimitSink`]), until shut-down.
    fn watch_cache_limit(&self, handle: tokio::runtime::Handle, wake: Arc<tokio::sync::Notify>, core: Weak<AppCore>) {
        let stopping = self.stopping.clone();
        handle.spawn(async move {
            loop {
                tokio::select! {
                    () = stopping.cancelled() => return,
                    () = wake.notified() => {}
                }
                let Some(core) = core.upgrade() else { return };
                core.enforce_cache_limit().await;
            }
        });
    }

    /// Re-checks the open project's sources every [`SOURCE_CHECK_INTERVAL`] until shut-down,
    /// so a file that goes missing, is replaced or comes back while the project is open is
    /// noticed without reopening it (spec 3.5.5 `source_assets_changed`).
    fn watch_sources(&self, handle: tokio::runtime::Handle, core: Weak<AppCore>) {
        let stopping = self.stopping.clone();
        handle.spawn(async move {
            loop {
                tokio::select! {
                    () = stopping.cancelled() => return,
                    () = tokio::time::sleep(SOURCE_CHECK_INTERVAL) => {}
                }
                let Some(core) = core.upgrade() else { return };
                core.recheck_sources().await;
            }
        });
    }

    /// Cancels every job, waits until their processes have exited and their half-written
    /// files are removed, then stops the media server. Safe to call twice.
    pub async fn shutdown(&self) {
        self.stopping.cancel();
        self.runner.shutdown().await;
        let server = self.server.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(s) = server {
            s.shutdown();
        }
    }

    /// The media server's address (`http://127.0.0.1:<port>`).
    pub fn media_base(&self) -> &str {
        &self.media_base
    }

    /// The media server's per-launch token.
    pub fn media_token(&self) -> &str {
        &self.media_token
    }

    /// The locations and programs in use.
    pub fn config(&self) -> &AppConfig {
        &self.config
    }

    /// The job runner (for waiting on jobs in tests).
    pub fn runner(&self) -> &JobRunner {
        &self.runner
    }

    /// The cache.
    pub fn cache(&self) -> &Cache {
        &self.cache
    }

    /// Whether the speech model a transcription needs is installed.
    pub fn speech_model_ready(&self) -> bool {
        self.models.is_ready(&self.settings.get().unwrap_or_else(|_| rc_settings::defaults()))
    }

    fn set_open(&self, id: Option<&str>) {
        *self.open.lock().unwrap_or_else(|p| p.into_inner()) = id.map(str::to_string);
    }

    fn open_id(&self) -> Option<ProjectId> {
        self.open.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// The sources whose cache must not be removed now: those of the open project and those
    /// with an active job.
    async fn in_use(&self) -> Vec<SourceId> {
        let mut ids = self.runner.busy_sources();
        if let Some(id) = self.open_id() {
            let projects = Arc::clone(&self.projects);
            if let Ok(p) = blocking(move || projects.read(&id)).await {
                ids.extend(p.sources.into_iter().map(|s| s.id));
            }
        }
        ids.sort();
        ids.dedup();
        ids
    }

    /// Keeps the cache within the settings' limit (least recently used sources first, never
    /// those in use), and makes the runner forget what was removed.
    async fn enforce_cache_limit(&self) {
        let limit = match self.settings.get() {
            Ok(s) => s.cache_limit_bytes,
            Err(_) => return,
        };
        let in_use = self.in_use().await;
        let cache = self.cache.clone();
        match blocking(move || cache.enforce_limit(limit, &in_use)).await {
            Ok(removed) => {
                self.runner.forget_sources(&removed);
            }
            Err(e) => eprintln!("roughcut: could not keep the cache within its limit: {e}"),
        }
    }

    /// Records where each source is and whether the file there is the source's own (only
    /// such files are served as originals).
    fn register(&self, sources: &[SourceRef], online: impl Fn(usize) -> bool) {
        for (i, s) in sources.iter().enumerate() {
            self.paths.set(&s.id, Path::new(&s.path), online(i));
        }
    }

    /// Checks each source at its recorded path (fingerprint), and records the result: the media
    /// server serves only originals found online, the runner publishes `source_assets_changed`
    /// when a source goes missing or is found, and a source found again resumes its unfinished
    /// work. Returns each source's status, in order.
    async fn check_sources(&self, project_id: &str, sources: &[SourceRef]) -> Vec<SourceStatus> {
        let list = sources.to_vec();
        let statuses = blocking(move || Ok(list.iter().map(rc_source::check_source).collect::<Vec<_>>()))
            .await
            .unwrap_or_else(|_| vec![SourceStatus::Unreadable; sources.len()]);
        let mut found = Vec::new();
        for (s, st) in sources.iter().zip(&statuses) {
            let online = *st == SourceStatus::Online;
            self.paths.set_online(&s.id, online);
            let was = self.runner.assets(&s.id).map(|a| a.online);
            self.runner.set_online(&s.id, online);
            if online && was == Some(false) {
                found.push(SourceInput { source: s.clone(), online: true });
            }
        }
        if !found.is_empty() {
            self.import(project_id, found);
        }
        statuses
    }

    /// Checks the open project's sources now (also run on a timer, and when the window gets
    /// the focus back): see [`AppCore::check_sources`].
    pub async fn recheck_sources(&self) {
        let Some(id) = self.open_id() else { return };
        let projects = Arc::clone(&self.projects);
        let Ok(project) = blocking(move || projects.read(&id)).await else { return };
        self.check_sources(&project.id, &project.sources).await;
    }

    fn import(&self, project_id: &str, sources: Vec<SourceInput>) -> Vec<SourceAssets> {
        self.runner.import(project_id, sources)
    }

    fn probe(&self) -> Result<MediaProbe, AppError> {
        Ok(MediaProbe(self.tools.get()?))
    }

    // ---------------------------------------------------------------- projects

    /// `list_projects`: one row per project on the Home screen.
    pub async fn list_projects(&self) -> Result<Vec<ProjectSummary>, AppError> {
        let projects = Arc::clone(&self.projects);
        blocking(move || projects.list()).await
    }

    /// `create_project`: fingerprints and probes the files, saves the project (one clip per
    /// source) and starts their import jobs.
    pub async fn create_project(&self, paths: Vec<String>) -> Result<Project, AppError> {
        if paths.iter().all(|p| p.trim().is_empty()) {
            return Err(AppError::new(ErrorCode::SourceMissing, "No files were given."));
        }
        let probe = self.probe()?;
        let projects = Arc::clone(&self.projects);
        let files: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
        let project = blocking(move || projects.create_from_paths(&files, &probe)).await?;
        // Just fingerprinted: each is the file the project records.
        self.register(&project.sources, |_| true);
        self.set_open(Some(&project.id));
        let inputs = project.sources.iter().map(|s| SourceInput { source: s.clone(), online: true }).collect();
        self.import(&project.id, inputs);
        self.enforce_cache_limit().await;
        Ok(project)
    }

    /// `open_project`: the project and a `SourceAssets` per source. Checks each source is
    /// still where it was (a missing one is reported `online: false`) and restarts whatever
    /// work is unfinished.
    pub async fn open_project(&self, project_id: ProjectId) -> Result<OpenedProject, AppError> {
        let projects = Arc::clone(&self.projects);
        let id = project_id.clone();
        let cache = self.cache.clone();
        let (project, statuses) = blocking(move || {
            let p = projects.read(&id)?;
            let statuses: Vec<SourceStatus> = p.sources.iter().map(rc_source::check_source).collect();
            for s in &p.sources {
                // Only an existing cache folder is touched; best effort.
                if cache.source_dir(&s.id).is_ok_and(|d| d.is_dir()) {
                    let _ = cache.touch(&s.id);
                }
            }
            Ok((p, statuses))
        })
        .await?;
        self.register(&project.sources, |i| statuses[i] == SourceStatus::Online);
        self.set_open(Some(&project.id));
        let inputs = project
            .sources
            .iter()
            .zip(&statuses)
            .map(|(s, st)| SourceInput { source: s.clone(), online: *st == SourceStatus::Online })
            .collect();
        let assets = self.import(&project.id, inputs);
        self.enforce_cache_limit().await;
        Ok(OpenedProject { project, assets })
    }

    /// `save_edit`: the interface-owned parts of the project file, written atomically.
    pub async fn save_edit(&self, project_id: ProjectId, edit: EditDocument, session: SessionState) -> Result<(), AppError> {
        let projects = Arc::clone(&self.projects);
        blocking(move || projects.save_edit(&project_id, edit, session)).await
    }

    /// `rename_project`.
    pub async fn rename_project(&self, project_id: ProjectId, name: String) -> Result<(), AppError> {
        let projects = Arc::clone(&self.projects);
        blocking(move || projects.rename(&project_id, &name).map(|_| ())).await
    }

    /// `remove_project`: cancels its jobs and removes it from the list; footage is untouched.
    pub async fn remove_project(&self, project_id: ProjectId) -> Result<(), AppError> {
        self.runner.cancel_project(&project_id);
        if self.open_id().as_deref() == Some(project_id.as_str()) {
            self.set_open(None);
        }
        let projects = Arc::clone(&self.projects);
        blocking(move || projects.remove(&project_id)).await
    }

    // ---------------------------------------------------------------- sources

    /// `add_sources`: adds the files (those not already in the project) and starts their
    /// import jobs. The interface appends their clips (spec 3.4 rule 5).
    pub async fn add_sources(&self, project_id: ProjectId, paths: Vec<String>) -> Result<Vec<SourceRef>, AppError> {
        let probe = self.probe()?;
        let projects = Arc::clone(&self.projects);
        let id = project_id.clone();
        let files: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
        let added = blocking(move || projects.add_sources_from_paths(&id, &files, &probe)).await?;
        self.register(&added, |_| true);
        let inputs = added.iter().map(|s| SourceInput { source: s.clone(), online: true }).collect();
        self.import(&project_id, inputs);
        Ok(added)
    }

    /// `locate_source`: accepts `new_path` only when it holds the same file
    /// (`source_mismatch` otherwise, and nothing changes), records it, and resumes the
    /// source's unfinished work.
    pub async fn locate_source(&self, project_id: ProjectId, source_id: SourceId, new_path: String) -> Result<SourceAssets, AppError> {
        let projects = Arc::clone(&self.projects);
        let (pid, sid) = (project_id.clone(), source_id.clone());
        let updated = blocking(move || projects.update_source_path(&pid, &sid, Path::new(&new_path))).await?;
        self.register(std::slice::from_ref(&updated), |_| true);
        let mut assets = self.import(&project_id, vec![SourceInput { source: updated, online: true }]);
        assets.pop().ok_or_else(|| not_found("The source is not in this project."))
    }

    /// `get_transcript`: the transcript as far as it has got (empty when nothing is there yet).
    pub async fn get_transcript(&self, source_id: SourceId) -> Result<Transcript, AppError> {
        if let Some(t) = self.runner.partial_transcript(&source_id) {
            return Ok(t);
        }
        let cache = self.cache.clone();
        let id = source_id.clone();
        let cached = blocking(move || cache.read_transcript(&id)).await?;
        Ok(cached.unwrap_or(Transcript {
            schema_version: TRANSCRIPT_SCHEMA_VERSION,
            source_id,
            model: String::new(),
            complete: false,
            utterances: Vec::new(),
        }))
    }

    /// `get_suggestions`: the cached suggestion set (empty when there is none yet).
    pub async fn get_suggestions(&self, source_id: SourceId) -> Result<SuggestionSet, AppError> {
        let cache = self.cache.clone();
        let id = source_id.clone();
        let cached = blocking(move || cache.read_suggestions(&id)).await?;
        Ok(cached.unwrap_or(SuggestionSet {
            schema_version: SUGGESTION_SET_SCHEMA_VERSION,
            source_id,
            claude_model: None,
            suggestions: Vec::new(),
        }))
    }

    /// `retry_suggestions`: a new suggest job for the source (Claude is asked again).
    pub async fn retry_suggestions(&self, source_id: SourceId) -> Result<JobId, AppError> {
        self.runner.retry_suggestions(&source_id)
    }

    // ---------------------------------------------------------------- jobs

    /// `list_jobs`.
    pub async fn list_jobs(&self) -> Result<Vec<JobStatus>, AppError> {
        Ok(self.runner.list())
    }

    /// `cancel_job`: the job is told to stop and clean up; an unknown or finished job is
    /// left as it is.
    pub async fn cancel_job(&self, job_id: JobId) -> Result<(), AppError> {
        self.runner.cancel(&job_id);
        Ok(())
    }

    // ---------------------------------------------------------------- export

    /// `plan_export`: length, format, size and time estimates, free space, notices, and
    /// `blockedBy` when the export cannot run.
    pub async fn plan_export(&self, request: ExportRequest) -> Result<ExportPlan, AppError> {
        Ok(self.plan(request).await?.0)
    }

    /// Plans the export. Every source a clip uses is checked first (its fingerprint, not just
    /// that some file is at the path): a source that is missing, unreadable or replaced by a
    /// different recording blocks the export with the Locate-file error, because cutting
    /// another file with this project's clip times would give the wrong footage.
    async fn plan(&self, request: ExportRequest) -> Result<(ExportPlan, Project, ExportRequest), AppError> {
        let tools = self.tools.get()?;
        let projects = Arc::clone(&self.projects);
        let id = request.project_id.clone();
        let project = blocking(move || projects.read(&id)).await?;
        let used: Vec<SourceRef> =
            project.sources.iter().filter(|s| request.clips.iter().any(|c| c.source_id == s.id)).cloned().collect();
        let statuses = self.check_sources(&project.id, &used).await;
        let problem = used.iter().zip(&statuses).find_map(|(s, st)| source_problem(s, *st));
        let work_root = self.cache.work_dir();
        let export_options = self.config.export_options();
        let (mut plan, project, request) = blocking(move || {
            let sources = export_sources(&project.sources);
            let spec = rc_media::ExportSpec {
                request: &request,
                sources: &sources,
                frame_rate: project.frame_rate,
                work_root: &work_root,
                options: export_options,
            };
            let plan = rc_media::plan_export(&tools, &spec, &rc_media::CancelToken::new())?;
            Ok((plan, project, request))
        })
        .await?;
        if let Some(e) = problem {
            // Locating the file comes before anything else the plan may say.
            plan.blocked_by = Some(e);
        }
        Ok((plan, project, request))
    }

    /// `start_export`: plans again and, unless the plan is blocked (its `blockedBy` is the
    /// error), queues the export job. Its progress comes as `job_updated`, then
    /// `export_finished`.
    pub async fn start_export(&self, request: ExportRequest) -> Result<JobId, AppError> {
        let (plan, project, request) = self.plan(request).await?;
        if let Some(e) = plan.blocked_by {
            return Err(e);
        }
        Ok(self.runner.start_export(ExportInput { request, format: plan.format, sources: project.sources }))
    }

    /// `reveal_file`: opens the folder with the file selected.
    pub async fn reveal_file(&self, path: String) -> Result<(), AppError> {
        let p = PathBuf::from(&path);
        if !p.exists() {
            return Err(AppError::internal("That file is not there any more.").with_detail(path));
        }
        reveal_in_explorer(&p)
    }

    // ---------------------------------------------------------------- Claude

    /// `claude_status`: installed, version, whether that version was tested, signed in.
    pub async fn claude_status(&self) -> Result<ClaudeStatus, AppError> {
        let cfg = self.suggest.claude_config();
        blocking(move || Ok(rc_suggest::claude_status(&cfg))).await
    }

    // ---------------------------------------------------------------- settings

    /// `get_settings`.
    pub async fn get_settings(&self) -> Result<Settings, AppError> {
        let settings = Arc::clone(&self.settings);
        blocking(move || settings.get()).await
    }

    /// `update_settings`: applies the fields present and returns the full settings. A new
    /// cache limit is applied at once.
    pub async fn update_settings(&self, changes: SettingsPatch) -> Result<Settings, AppError> {
        let settings = Arc::clone(&self.settings);
        let limit_changed = changes.cache_limit_bytes.is_some();
        let next = blocking(move || settings.update_with(|s| *s = changes.apply_to(s))).await?;
        if limit_changed {
            self.enforce_cache_limit().await;
        }
        Ok(next)
    }

    // ---------------------------------------------------------------- cache

    /// `cache_usage`: bytes used and the limit.
    pub async fn cache_usage(&self) -> Result<CacheUsage, AppError> {
        let cache = self.cache.clone();
        let used_bytes = blocking(move || cache.usage_bytes()).await?;
        let limit_bytes = self.get_settings().await?.cache_limit_bytes;
        Ok(CacheUsage { used_bytes, limit_bytes })
    }

    /// `clear_cache`: removes every source's cached files except those in use (the open
    /// project's, and any with a running job); they are rebuilt when needed.
    pub async fn clear_cache(&self) -> Result<(), AppError> {
        let in_use = self.in_use().await;
        let cache = self.cache.clone();
        let removed = blocking(move || cache.clear(&in_use)).await?;
        self.runner.forget_sources(&removed);
        Ok(())
    }
}

#[cfg(windows)]
fn reveal_in_explorer(path: &Path) -> Result<(), AppError> {
    use std::os::windows::process::CommandExt;
    let abs = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let argument = format!("/select,\"{}\"", abs.display());
    // Test hook (`ROUGHCUT_TEST_REVEAL_LOG`): the end-to-end tests run where no screen is shown,
    // so instead of opening a File Explorer window the argument is appended to this file.
    if let Some(log) = std::env::var_os(config::TEST_REVEAL_LOG_ENV).filter(|v| !v.is_empty()) {
        use std::io::Write;
        return std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
            .and_then(|mut f| writeln!(f, "{argument}"))
            .map_err(|e| AppError::internal("Could not open the folder.").with_detail(e.to_string()));
    }
    std::process::Command::new("explorer.exe")
        .raw_arg(argument)
        .spawn()
        .map(|_| ())
        .map_err(|e| AppError::internal("Could not open the folder.").with_detail(e.to_string()))
}

#[cfg(not(windows))]
fn reveal_in_explorer(path: &Path) -> Result<(), AppError> {
    let dir = path.parent().unwrap_or(path);
    std::process::Command::new("xdg-open")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| AppError::internal("Could not open the folder.").with_detail(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rc_types::JobKind;

    fn job(kind: JobKind, state: JobState, source: Option<&str>) -> JobEvent {
        JobEvent::JobUpdated(JobStatus {
            id: "j1".into(),
            kind,
            source_id: source.map(str::to_string),
            project_id: None,
            state,
            progress: 1.0,
            seconds_left: None,
            error: None,
        })
    }

    /// Found in the real app (e2e "edge-cache"): the limit was applied only when a project was
    /// made or opened, so a cache that grew past it while a project was open (its proxy and
    /// transcript being made) stayed over it. A finished cache-writing job must wake the check.
    #[tokio::test]
    async fn a_finished_source_job_wakes_the_cache_limit_check_and_other_events_do_not() {
        let seen = Arc::new(Mutex::new(0usize));
        let s = Arc::clone(&seen);
        let inner: Arc<dyn EventSink> = Arc::new(move |_e: JobEvent| *s.lock().unwrap() += 1);
        let wake = Arc::new(tokio::sync::Notify::new());
        let sink = CacheLimitSink::new(inner, Arc::clone(&wake));
        let woken = || async {
            tokio::time::timeout(Duration::from_millis(50), wake.notified()).await.is_ok()
        };

        sink.publish(job(JobKind::Proxy, JobState::Running, Some("a")));
        sink.publish(job(JobKind::Proxy, JobState::Failed, Some("a")));
        sink.publish(job(JobKind::Export, JobState::Done, None));
        assert!(!woken().await, "only a finished job of a source wakes the check");

        sink.publish(job(JobKind::Proxy, JobState::Done, Some("a")));
        sink.publish(job(JobKind::Transcribe, JobState::Done, Some("a")));
        assert!(woken().await, "a finished proxy wakes the check");
        assert!(!woken().await, "two jobs finishing together give one check");
        assert_eq!(*seen.lock().unwrap(), 5, "every event is passed on");
    }
}
