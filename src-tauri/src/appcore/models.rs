//! The first-run speech model download (spec 2.4.9), as a job the interface sees like any
//! other (`job_updated`, kind `model_download`). It is started when a transcription needs a
//! model that is not there; the transcription waits for the packages it cannot run without.
//!
//! What is downloaded: the model files alone (rc-speech's `model_only`), because the
//! transcriber's folder (`ROUGHCUT_TRANSCRIBER_DIR`) already holds its runtime. The processor
//! package (int8 model and voice detector) is required. The GPU package (fp32 model) is
//! fetched too when the GPU can be used (an NVIDIA driver, the CUDA runtime beside the
//! transcriber, and a speech device other than `cpu`), but nothing waits for it: until it is
//! there the transcriber runs on the processor.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use rc_jobs::{CancellationToken, JobRunner, JobSpec, ResourceClass};
use rc_speech::{Package, PackageKind, SpeechHome};
use rc_types::{AppError, ErrorCode, JobId, JobKind, JobState, Settings, SpeechDevice};

use super::adapters::with_cancel;

use super::config::CUDA_PROVIDER_DLL;

pub(crate) struct ModelManager {
    home: SpeechHome,
    transcriber_dir: PathBuf,
    packages: Option<Vec<(Package, bool)>>,
    runner: OnceLock<JobRunner>,
    /// The download job per package, while it may still be running.
    jobs: Mutex<Vec<(PackageKind, JobId)>>,
}

impl ModelManager {
    pub(crate) fn new(model_dir: PathBuf, transcriber_dir: PathBuf, packages: Option<Vec<(Package, bool)>>) -> ModelManager {
        ModelManager {
            home: SpeechHome::with_model_dir(model_dir),
            transcriber_dir,
            packages,
            runner: OnceLock::new(),
            jobs: Mutex::new(Vec::new()),
        }
    }

    /// The runner owns the ports that own this manager, so it is handed over after creation.
    pub(crate) fn attach(&self, runner: JobRunner) {
        let _ = self.runner.set(runner);
    }

    pub(crate) fn model_dir(&self) -> PathBuf {
        self.home.model_dir()
    }

    pub(crate) fn vad_model(&self) -> PathBuf {
        self.home.vad_model()
    }

    /// The packages to have, in install order, each with whether transcription waits for it.
    pub(crate) fn wanted(&self, settings: &Settings) -> Vec<(Package, bool)> {
        if let Some(p) = &self.packages {
            return p.clone();
        }
        let mut out = vec![(rc_speech::model_only(&rc_speech::cpu_package()), true)];
        let gpu_usable = settings.speech_device != SpeechDevice::Cpu
            && rc_speech::nvidia_gpu_present()
            && self.transcriber_dir.join(CUDA_PROVIDER_DLL).is_file();
        if gpu_usable {
            out.push((rc_speech::model_only(&rc_speech::gpu_package()), false));
        }
        out
    }

    /// Whether everything a transcription needs is installed.
    pub(crate) fn is_ready(&self, settings: &Settings) -> bool {
        self.wanted(settings).iter().filter(|(_, required)| *required).all(|(p, _)| self.home.is_installed(p))
    }

    /// Makes sure the model is there: starts a download job for each missing package (unless
    /// one is already running) and waits for those transcription cannot run without. A
    /// cancelled caller stops waiting; the download goes on as its own job.
    pub(crate) async fn ensure(&self, settings: &Settings, cancel: &CancellationToken) -> Result<(), AppError> {
        let mut waits = Vec::new();
        for (pkg, required) in self.wanted(settings) {
            if self.home.is_installed(&pkg) {
                continue;
            }
            let id = self.download(pkg)?;
            if required {
                waits.push(id);
            }
        }
        let runner = self.runner()?;
        for id in waits {
            let status = tokio::select! {
                s = runner.wait(&id) => s,
                () = cancel.cancelled() => return Err(AppError::new(ErrorCode::Cancelled, "Cancelled.")),
            };
            match status {
                Some(s) if s.state == JobState::Done => {}
                Some(s) if s.state == JobState::Cancelled => {
                    return Err(AppError::new(
                        ErrorCode::TranscriberFailed,
                        "The speech model download was cancelled, so the transcript cannot be made.",
                    ));
                }
                Some(s) => {
                    return Err(s.error.unwrap_or_else(|| {
                        AppError::new(ErrorCode::TranscriberFailed, "The speech model could not be downloaded.")
                    }));
                }
                None => return Err(AppError::internal("The speech model download job disappeared.")),
            }
        }
        Ok(())
    }

    fn runner(&self) -> Result<&JobRunner, AppError> {
        self.runner.get().ok_or_else(|| AppError::internal("The job runner is not ready."))
    }

    /// The active download job of `pkg`, or a new one.
    fn download(&self, pkg: Package) -> Result<JobId, AppError> {
        let runner = self.runner()?;
        let mut jobs = self.jobs.lock().unwrap_or_else(|p| p.into_inner());
        jobs.retain(|(_, id)| runner.status(id).is_some_and(|s| matches!(s.state, JobState::Queued | JobState::Running)));
        if let Some((_, id)) = jobs.iter().find(|(k, _)| *k == pkg.kind) {
            return Ok(id.clone());
        }
        let home = self.home.clone();
        let kind = pkg.kind;
        let spec = JobSpec { kind: JobKind::ModelDownload, class: ResourceClass::Light, source_id: None, project_id: None };
        let id = runner.spawn(spec, move |h| async move {
            let progress = h.progress();
            let token = rc_speech::CancelToken::new();
            let inner = token.clone();
            with_cancel(h.cancel_token(), move || token.cancel(), move || {
                home.install(&pkg, &inner, |p| {
                    if p.total_bytes > 0 {
                        progress.set(p.done_bytes as f64 / p.total_bytes as f64, None);
                    }
                })
            })
            .await
        });
        jobs.push((kind, id.clone()));
        Ok(id)
    }
}
