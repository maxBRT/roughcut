//! The runner core: the job table, resource limits, progress, cancellation and the
//! publishing rule (nothing from a job after it has finished, failed or been cancelled).

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use rc_types::{AppError, JobId, JobKind, JobState, JobStatus, ProjectId, SourceId};
use tokio::runtime::Handle;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::events::{EventSink, JobEvent};
use crate::import::SourceEntry;
use crate::ports::Ports;

/// What a job mainly uses; each class has its own limit on how many run at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ResourceClass {
    /// GPU video encoding: proxy and export.
    GpuEncode,
    /// Speech-audio extraction plus transcription (they run as a pair; may overlap GpuEncode).
    Speech,
    /// Short FFmpeg work: waveform, probe.
    Light,
    /// Suggestions: dead air plus one Claude call.
    Claude,
}

impl ResourceClass {
    const ALL: [ResourceClass; 4] =
        [ResourceClass::GpuEncode, ResourceClass::Speech, ResourceClass::Light, ResourceClass::Claude];

    fn index(self) -> usize {
        match self {
            ResourceClass::GpuEncode => 0,
            ResourceClass::Speech => 1,
            ResourceClass::Light => 2,
            ResourceClass::Claude => 3,
        }
    }
}

/// How many jobs of each class may run at once (0 is treated as 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Proxy and export encodes at once.
    pub gpu_encode: usize,
    /// Transcriptions (each with its audio extraction) at once.
    pub speech: usize,
    /// Waveforms, probes and other short work at once.
    pub light: usize,
    /// Suggestion jobs at once.
    pub claude: usize,
}

impl Default for Limits {
    /// One GPU encode and one transcription at a time (spec 2.4.10: they share the GPU and
    /// may overlap each other), two light FFmpeg tasks, two suggestion jobs.
    fn default() -> Self {
        Limits { gpu_encode: 1, speech: 1, light: 2, claude: 2 }
    }
}

impl Limits {
    fn get(&self, class: ResourceClass) -> usize {
        let n = match class {
            ResourceClass::GpuEncode => self.gpu_encode,
            ResourceClass::Speech => self.speech,
            ResourceClass::Light => self.light,
            ResourceClass::Claude => self.claude,
        };
        n.max(1)
    }
}

/// How the runner is set up.
#[derive(Debug, Clone)]
pub struct RunnerConfig {
    /// The media server's origin, e.g. `http://127.0.0.1:51234` (for `SourceAssets` URLs).
    pub media_base: String,
    /// The media server's per-launch token.
    pub media_token: String,
    /// Concurrency limits per resource class.
    pub limits: Limits,
}

/// Describes a job for `JobRunner::spawn`.
#[derive(Debug, Clone)]
pub struct JobSpec {
    /// What the job is, as shown in `JobStatus.kind`.
    pub kind: JobKind,
    /// Which concurrency limit it counts against.
    pub class: ResourceClass,
    /// The source it works on, if any.
    pub source_id: Option<SourceId>,
    /// The project it belongs to, if any (used by `cancel_project`).
    pub project_id: Option<ProjectId>,
}

/// Finished jobs kept for `list` (active ones are always kept).
const KEEP_FINISHED_JOBS: usize = 200;
/// A progress change at least this large is published at once...
const PROGRESS_STEP: f64 = 0.01;
/// ...and any change at least this often.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

pub(crate) fn is_active(state: JobState) -> bool {
    matches!(state, JobState::Queued | JobState::Running)
}

pub(crate) struct JobEntry {
    pub(crate) status: JobStatus,
    cancel: CancellationToken,
    /// Jobs cancelled together with this one (speech audio and its transcription).
    linked: Vec<JobId>,
    started: Option<Instant>,
    last_emit: Option<Instant>,
    last_progress: f64,
}

/// The run slots of one resource class. Jobs get a slot strictly in the order they were queued.
struct Slots {
    limit: usize,
    running: usize,
    waiting: VecDeque<JobId>,
}

pub(crate) struct State {
    pub(crate) jobs: Vec<JobEntry>,
    slots: Vec<Slots>,
    pub(crate) sources: HashMap<SourceId, SourceEntry>,
    pub(crate) media_base: String,
    pub(crate) media_token: String,
}

impl State {
    pub(crate) fn job(&self, id: &str) -> Option<&JobEntry> {
        self.jobs.iter().find(|j| j.status.id == id)
    }

    fn job_mut(&mut self, id: &str) -> Option<&mut JobEntry> {
        self.jobs.iter_mut().find(|j| j.status.id == id)
    }

    /// The active job of `kind` for `source`, if any.
    pub(crate) fn active_job(&self, kind: JobKind, source: &str) -> Option<JobId> {
        self.jobs
            .iter()
            .find(|j| {
                j.status.kind == kind
                    && is_active(j.status.state)
                    && j.status.source_id.as_deref() == Some(source)
            })
            .map(|j| j.status.id.clone())
    }

    fn prune(&mut self) {
        let finished = self.jobs.iter().filter(|j| !is_active(j.status.state)).count();
        if finished <= KEEP_FINISHED_JOBS {
            return;
        }
        let mut excess = finished - KEEP_FINISHED_JOBS;
        self.jobs.retain(|j| {
            if excess > 0 && !is_active(j.status.state) {
                excess -= 1;
                false
            } else {
                true
            }
        });
    }
}

pub(crate) struct Inner {
    pub(crate) ports: Ports,
    sink: Arc<dyn EventSink>,
    handle: Handle,
    state: Mutex<State>,
    tracker: TaskTracker,
    next_id: AtomicU64,
    changed: Notify,
}

impl Inner {
    pub(crate) fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Publish while the lock is held (the `&State` proves it), so publication order and the
    /// "nothing after cancel" rule hold across threads.
    pub(crate) fn publish(&self, _held: &State, event: JobEvent) {
        self.sink.publish(event);
    }

    /// Register a queued job and publish it. It takes its place in its class's queue now, so
    /// jobs of one class start in the order they were created.
    pub(crate) fn create_job_locked(self: &Arc<Self>, st: &mut State, spec: &JobSpec) -> JobHandle {
        let h = self.create_unqueued_locked(st, spec);
        st.slots[spec.class.index()].waiting.push_back(h.id.clone());
        h
    }

    /// Register a job that never takes a slot of its own (it runs under its partner's).
    pub(crate) fn create_paired_job_locked(self: &Arc<Self>, st: &mut State, spec: &JobSpec) -> JobHandle {
        self.create_unqueued_locked(st, spec)
    }

    fn create_unqueued_locked(self: &Arc<Self>, st: &mut State, spec: &JobSpec) -> JobHandle {
        let n = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let id = format!("job-{n}");
        let cancel = CancellationToken::new();
        let status = JobStatus {
            id: id.clone(),
            kind: spec.kind,
            source_id: spec.source_id.clone(),
            project_id: spec.project_id.clone(),
            state: JobState::Queued,
            progress: 0.0,
            seconds_left: None,
            error: None,
        };
        st.jobs.push(JobEntry {
            status: status.clone(),
            cancel: cancel.clone(),
            linked: Vec::new(),
            started: None,
            last_emit: None,
            last_progress: 0.0,
        });
        self.publish(st, JobEvent::JobUpdated(status));
        JobHandle { inner: Arc::clone(self), id, cancel, class: spec.class }
    }

    pub(crate) fn create_job(self: &Arc<Self>, spec: &JobSpec) -> JobHandle {
        let mut st = self.lock();
        self.create_job_locked(&mut st, spec)
    }

    /// Cancelling either of `a` and `b` cancels both.
    pub(crate) fn link_locked(&self, st: &mut State, a: &JobHandle, b: &JobHandle) {
        if let Some(e) = st.job_mut(&a.id) {
            e.linked.push(b.id.clone());
        }
        if let Some(e) = st.job_mut(&b.id) {
            e.linked.push(a.id.clone());
        }
    }

    pub(crate) fn spawn_task(&self, fut: impl Future<Output = ()> + Send + 'static) {
        self.tracker.spawn_on(fut, &self.handle);
    }

    /// Wait for the job's turn in its class (first queued, first run) and a free slot; `None`
    /// if the job is cancelled first. The slot is released when the returned value is dropped.
    pub(crate) async fn acquire(self: &Arc<Self>, h: &JobHandle) -> Option<Slot> {
        let class = h.class.index();
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut st = self.lock();
                let ended = !st.job(&h.id).is_some_and(|e| is_active(e.status.state));
                let slots = &mut st.slots[class];
                if h.is_cancelled() || ended {
                    slots.waiting.retain(|j| j != &h.id);
                    self.changed.notify_waiters();
                    return None;
                }
                if !slots.waiting.contains(&h.id) {
                    slots.waiting.push_back(h.id.clone());
                }
                if slots.waiting.front() == Some(&h.id) && slots.running < slots.limit {
                    slots.waiting.pop_front();
                    slots.running += 1;
                    // The next in line may fit too.
                    self.changed.notify_waiters();
                    return Some(Slot { inner: Arc::clone(self), class });
                }
            }
            tokio::select! {
                biased;
                () = h.cancel.cancelled() => {}
                () = &mut notified => {}
            }
        }
    }

    /// Queued jobs become running.
    pub(crate) fn set_running(&self, jobs: &[&JobHandle]) {
        let mut st = self.lock();
        let now = Instant::now();
        for h in jobs {
            let Some(e) = st.job_mut(&h.id) else { continue };
            if e.status.state != JobState::Queued {
                continue;
            }
            e.status.state = JobState::Running;
            e.started = Some(now);
            e.last_emit = Some(now);
            let status = e.status.clone();
            self.publish(&st, JobEvent::JobUpdated(status));
        }
    }

    fn finish_locked(&self, st: &mut State, id: &str, state: JobState, error: Option<AppError>) -> bool {
        let Some(e) = st.job_mut(id) else { return false };
        if !is_active(e.status.state) {
            return false;
        }
        e.status.state = state;
        e.status.seconds_left = None;
        if state == JobState::Done {
            e.status.progress = 1.0;
        }
        e.status.error = error;
        let status = e.status.clone();
        // A job that has ended never waits for a slot again: leaving its id in a queue would
        // block every later job of that class.
        for slots in &mut st.slots {
            slots.waiting.retain(|w| w != id);
        }
        self.publish(st, JobEvent::JobUpdated(status));
        st.prune();
        self.changed.notify_waiters();
        true
    }

    /// Cancel `id` and the jobs linked to it. True if anything was still active.
    pub(crate) fn cancel_locked(&self, st: &mut State, id: &str) -> bool {
        let mut todo = vec![id.to_string()];
        let mut any = false;
        while let Some(j) = todo.pop() {
            let Some(e) = st.job(&j) else { continue };
            if !is_active(e.status.state) {
                continue;
            }
            let token = e.cancel.clone();
            let linked = e.linked.clone();
            any |= self.finish_locked(st, &j, JobState::Cancelled, None);
            token.cancel();
            todo.extend(linked);
        }
        any
    }

    fn set_progress(&self, id: &str, fraction: f64, seconds_left: Option<f64>) {
        if !fraction.is_finite() {
            return;
        }
        let mut st = self.lock();
        let Some(e) = st.job_mut(id) else { return };
        if e.status.state != JobState::Running {
            return;
        }
        let p = fraction.clamp(0.0, 1.0);
        let now = Instant::now();
        let estimate = || {
            let elapsed = now.duration_since(e.started?).as_secs_f64();
            (0.01..1.0).contains(&p).then(|| elapsed * (1.0 - p) / p)
        };
        let secs = seconds_left.filter(|s| s.is_finite() && *s >= 0.0).or_else(estimate);
        e.status.progress = p;
        e.status.seconds_left = secs;
        let due = e.last_emit.is_none_or(|t| now.duration_since(t) >= PROGRESS_INTERVAL)
            || (p - e.last_progress).abs() >= PROGRESS_STEP;
        if due {
            e.last_emit = Some(now);
            e.last_progress = p;
            let status = e.status.clone();
            self.publish(&st, JobEvent::JobUpdated(status));
        }
    }
}

/// A held run slot; dropping it frees the slot for the next queued job of its class.
pub(crate) struct Slot {
    inner: Arc<Inner>,
    class: usize,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut st = self.inner.lock();
        st.slots[self.class].running -= 1;
        self.inner.changed.notify_waiters();
    }
}

/// The result of running one job's work.
pub(crate) enum Outcome<T> {
    Done(T),
    Failed,
    Cancelled,
}

/// A running job, as seen by its work: its id, its cancellation, its progress.
#[derive(Clone)]
pub struct JobHandle {
    pub(crate) inner: Arc<Inner>,
    pub(crate) id: JobId,
    cancel: CancellationToken,
    pub(crate) class: ResourceClass,
}

impl JobHandle {
    /// The job's id.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Fires when the job is cancelled; pass it to the work so it can stop and clean up.
    pub fn cancel_token(&self) -> CancellationToken {
        self.cancel.clone()
    }

    /// Whether the job has been cancelled (or stopped because a job it depends on failed).
    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// The progress reporter for this job.
    pub fn progress(&self) -> Progress {
        Progress { job: Some(self.clone()) }
    }

    /// Run `f` and publish what it returns, only while the job is still active.
    pub(crate) fn emit_with(&self, f: impl FnOnce(&mut State) -> Vec<JobEvent>) -> bool {
        let mut st = self.inner.lock();
        if !st.job(&self.id).is_some_and(|e| is_active(e.status.state)) {
            return false;
        }
        for ev in f(&mut st) {
            self.inner.publish(&st, ev);
        }
        true
    }

    /// Like `emit_with`, then mark the job done, atomically.
    pub(crate) fn complete_with(&self, f: impl FnOnce(&mut State) -> Vec<JobEvent>) -> bool {
        let mut st = self.inner.lock();
        if !st.job(&self.id).is_some_and(|e| is_active(e.status.state)) {
            return false;
        }
        for ev in f(&mut st) {
            self.inner.publish(&st, ev);
        }
        self.inner.finish_locked(&mut st, &self.id, JobState::Done, None)
    }

    /// Mark the job failed with `error`.
    pub(crate) fn fail(&self, error: AppError) -> bool {
        let mut st = self.inner.lock();
        self.inner.finish_locked(&mut st, &self.id, JobState::Failed, Some(error))
    }

    /// Mark the job failed because something it depends on failed, and stop its work.
    pub(crate) fn fail_and_stop(&self, error: AppError) {
        self.fail(error);
        self.cancel.cancel();
    }

    /// Mark the job cancelled (its purpose is gone) and stop its work.
    pub(crate) fn stop(&self) {
        let mut st = self.inner.lock();
        self.inner.cancel_locked(&mut st, &self.id);
    }

    /// Await `fut` as this job's work. A failure is recorded on the job; a panic in the work
    /// marks the job failed with `internal`.
    pub(crate) async fn run<T>(&self, fut: impl Future<Output = Result<T, AppError>>) -> Outcome<T> {
        if self.is_cancelled() {
            return Outcome::Cancelled;
        }
        let mut guard = FailOnPanic(Some(self));
        let result = fut.await;
        guard.0 = None;
        if self.is_cancelled() {
            return Outcome::Cancelled;
        }
        match result {
            Ok(v) => Outcome::Done(v),
            Err(e) => {
                self.fail(e);
                Outcome::Failed
            }
        }
    }
}

/// Owned by the task that runs a job. If the task ends (returns, panics, or is dropped
/// unpolled) while the job is still queued or running, the job is failed with `internal`, so
/// no job is ever left active (or waiting in a queue) without work behind it.
pub(crate) struct EndGuard(pub(crate) JobHandle);

impl JobHandle {
    /// A guard that ends this job if its task goes away first. Create it before spawning
    /// the task and move it in.
    pub(crate) fn end_guard(&self) -> EndGuard {
        EndGuard(self.clone())
    }
}

impl Drop for EndGuard {
    fn drop(&mut self) {
        self.0.fail(AppError::internal("The job stopped unexpectedly."));
    }
}

struct FailOnPanic<'a>(Option<&'a JobHandle>);

impl Drop for FailOnPanic<'_> {
    fn drop(&mut self) {
        if let Some(h) = self.0
            && std::thread::panicking()
        {
            h.fail(AppError::internal("The job stopped unexpectedly."));
        }
    }
}

/// Reports a job's progress. Cheap to clone; calls after the job ended are ignored, and
/// events are throttled (every 1% or 250 ms). Without `seconds_left`, the runner estimates
/// it from the elapsed time.
#[derive(Clone)]
pub struct Progress {
    job: Option<JobHandle>,
}

impl Progress {
    /// A reporter attached to no job (for testing a port on its own).
    pub fn detached() -> Self {
        Progress { job: None }
    }

    /// Report `fraction` (0 to 1) done and, if known, the seconds left.
    pub fn set(&self, fraction: f64, seconds_left: Option<f64>) {
        if let Some(job) = &self.job {
            job.inner.set_progress(&job.id, fraction, seconds_left);
        }
    }
}

/// The one job runner. Cheap to clone; all clones share the same jobs.
#[derive(Clone)]
pub struct JobRunner {
    pub(crate) inner: Arc<Inner>,
}

impl JobRunner {
    /// A runner that spawns its work on `handle` (in the app:
    /// `tauri::async_runtime::handle().inner().clone()`).
    pub fn new(config: RunnerConfig, ports: Ports, sink: Arc<dyn EventSink>, handle: Handle) -> Self {
        let slots = ResourceClass::ALL
            .iter()
            .map(|c| Slots { limit: config.limits.get(*c), running: 0, waiting: VecDeque::new() })
            .collect();
        JobRunner {
            inner: Arc::new(Inner {
                ports,
                sink,
                handle,
                state: Mutex::new(State {
                    jobs: Vec::new(),
                    slots,
                    sources: HashMap::new(),
                    media_base: config.media_base,
                    media_token: config.media_token,
                }),
                tracker: TaskTracker::new(),
                next_id: AtomicU64::new(0),
                changed: Notify::new(),
            }),
        }
    }

    /// Queue any other long work (for example a probe) under the runner's limits, progress
    /// and cancellation. `work` gets the job's handle; its `Err` fails the job.
    pub fn spawn<F, Fut>(&self, spec: JobSpec, work: F) -> JobId
    where
        F: FnOnce(JobHandle) -> Fut + Send + 'static,
        Fut: Future<Output = Result<(), AppError>> + Send + 'static,
    {
        let h = self.inner.create_job(&spec);
        let id = h.id.clone();
        let inner = Arc::clone(&self.inner);
        let end = h.end_guard();
        self.inner.spawn_task(async move {
            let _end = end;
            let Some(_slot) = inner.acquire(&h).await else { return };
            inner.set_running(&[&h]);
            if let Outcome::Done(()) = h.run(work(h.clone())).await {
                h.complete_with(|_| Vec::new());
            }
        });
        id
    }

    /// Every job: active ones and the most recent finished ones, oldest first (`list_jobs`).
    pub fn list(&self) -> Vec<JobStatus> {
        self.inner.lock().jobs.iter().map(|j| j.status.clone()).collect()
    }

    /// One job's status.
    pub fn status(&self, id: &str) -> Option<JobStatus> {
        self.inner.lock().job(id).map(|j| j.status.clone())
    }

    /// Cancel a job (`cancel_job`). Its work is told to stop and clean up; its `cancelled`
    /// status is the last event it publishes. False if it had already ended or is unknown.
    pub fn cancel(&self, id: &str) -> bool {
        let mut st = self.inner.lock();
        self.inner.cancel_locked(&mut st, id)
    }

    /// Cancel every active job of a project (`remove_project`). Returns how many were cancelled.
    pub fn cancel_project(&self, project_id: &str) -> usize {
        let mut st = self.inner.lock();
        let ids: Vec<JobId> = st
            .jobs
            .iter()
            .filter(|j| is_active(j.status.state) && j.status.project_id.as_deref() == Some(project_id))
            .map(|j| j.status.id.clone())
            .collect();
        ids.iter().filter(|id| self.inner.cancel_locked(&mut st, id)).count()
    }

    /// Wait until the job has ended; its final status (`None` if unknown).
    pub async fn wait(&self, id: &str) -> Option<JobStatus> {
        loop {
            let notified = self.inner.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let st = self.inner.lock();
                match st.job(id) {
                    None => return None,
                    Some(e) if !is_active(e.status.state) => return Some(e.status.clone()),
                    Some(_) => {}
                }
            }
            notified.await;
        }
    }

    /// Wait until every task the runner started has returned (including cleanup after cancel).
    pub async fn wait_idle(&self) {
        self.inner.tracker.close();
        self.inner.tracker.wait().await;
        self.inner.tracker.reopen();
    }

    /// Cancel everything and wait for the work to clean up (call on app exit).
    pub async fn shutdown(&self) {
        {
            let mut st = self.inner.lock();
            let ids: Vec<JobId> = st
                .jobs
                .iter()
                .filter(|j| is_active(j.status.state))
                .map(|j| j.status.id.clone())
                .collect();
            for id in ids {
                self.inner.cancel_locked(&mut st, &id);
            }
        }
        self.wait_idle().await;
    }
}
