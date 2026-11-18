//! The process runner every media task uses.
//!
//! - Every child is started without a console window (`CREATE_NO_WINDOW`), with stdin closed,
//!   and is placed in a job object that kills it if the app itself dies (Windows).
//! - [`CancelToken`]: cancelling kills the process at once; [`ManagedChild::wait`] then reports
//!   [`RunFailure::Cancelled`]. Partial output files given to [`run_ffmpeg`] are removed.
//! - The last lines of the error output are kept for `AppError.detail`.
//! - Progress is reported as [`TaskProgress`]: a fraction from 0 to 1 and the seconds left.
//! - A child is always waited for (also when its handle is dropped), so none is left behind.

use std::collections::VecDeque;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rc_types::{AppError, ErrorCode, Micros};

use crate::tools::FfmpegTools;

/// Shared cancel flag. Clone it freely; cancelling any clone cancels the task.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    /// A token that is not cancelled.
    pub fn new() -> CancelToken {
        CancelToken::default()
    }
    /// Asks the task to stop: its process is killed and its partial output removed.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    /// Whether [`CancelToken::cancel`] was called.
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Progress of one task.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TaskProgress {
    /// 0 to 1.
    pub fraction: f64,
    /// Estimated seconds until done; `None` until there is enough to go on.
    pub seconds_left: Option<f64>,
}

/// Turns "how far along" into [`TaskProgress`] with a time-left estimate, and throttles reports.
#[derive(Debug)]
pub(crate) struct ProgressClock {
    started: Instant,
    last_report: Option<Instant>,
    last_fraction: f64,
}

impl ProgressClock {
    pub(crate) fn new() -> ProgressClock {
        ProgressClock { started: Instant::now(), last_report: None, last_fraction: -1.0 }
    }

    /// The progress for `fraction` (clamped to 0..1).
    pub(crate) fn at(&self, fraction: f64) -> TaskProgress {
        let fraction = if fraction.is_finite() { fraction.clamp(0.0, 1.0) } else { 0.0 };
        let elapsed = self.started.elapsed().as_secs_f64();
        let seconds_left = if fraction >= 1.0 {
            Some(0.0)
        } else if fraction >= 0.01 && elapsed >= 0.5 {
            Some(elapsed * (1.0 - fraction) / fraction)
        } else {
            None
        };
        TaskProgress { fraction, seconds_left }
    }

    /// `Some(progress)` when a report is due: at most every 200 ms, always for the first and for 1.
    pub(crate) fn report(&mut self, fraction: f64) -> Option<TaskProgress> {
        let p = self.at(fraction);
        let first = self.last_report.is_none();
        let finishing = p.fraction >= 1.0 && self.last_fraction < 1.0;
        let interval_passed = self.last_report.is_some_and(|t| t.elapsed() >= Duration::from_millis(200));
        if !(first || finishing || (interval_passed && p.fraction > self.last_fraction)) {
            return None;
        }
        self.last_report = Some(Instant::now());
        self.last_fraction = p.fraction;
        Some(p)
    }
}

/// Why a process did not finish successfully.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunFailure {
    /// The [`CancelToken`] was cancelled and the process was killed.
    Cancelled,
    /// The program could not be started.
    Spawn(String),
    /// The program ended with an error.
    Failed {
        /// The exit status, as text.
        status: String,
        /// The last lines of its error output.
        stderr_tail: String,
    },
}

impl RunFailure {
    /// The error to report: `cancelled` for a cancel, `disk_full` when FFmpeg ran out of space,
    /// otherwise `code` with `message`, and the end of the error output as the detail.
    pub fn into_app_error(self, code: ErrorCode, message: &str) -> AppError {
        match self {
            RunFailure::Cancelled => AppError::new(ErrorCode::Cancelled, "Cancelled"),
            RunFailure::Spawn(e) => AppError::internal("FFmpeg could not be started").with_detail(e),
            RunFailure::Failed { status, stderr_tail } => {
                let lower = stderr_tail.to_ascii_lowercase();
                let code = if lower.contains("no space left") || lower.contains("disk full") {
                    ErrorCode::DiskFull
                } else {
                    code
                };
                let detail = if stderr_tail.trim().is_empty() { status } else { format!("{status}: {stderr_tail}") };
                AppError::new(code, message).with_detail(detail)
            }
        }
    }
}

/// A `Command` that opens no console window and has stdin closed.
pub(crate) fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[cfg(windows)]
mod job {
    //! One job object for the whole app, with "kill on close": when the app exits or crashes,
    //! Windows closes the handle and ends every FFmpeg still running.
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
    };

    static JOB: OnceLock<usize> = OnceLock::new();

    fn job_handle() -> usize {
        *JOB.get_or_init(|| {
            // SAFETY: plain Win32 calls with valid arguments; the handle is kept for the
            // lifetime of the process on purpose (closing it is what kills the children).
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return 0;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                h as usize
            }
        })
    }

    /// Puts the child in the app's job object. Failure is ignored: the child still runs and is
    /// still killed on cancel and on drop; only the crash safety net is missing.
    pub(super) fn adopt(child: &std::process::Child) {
        let job = job_handle();
        if job == 0 {
            return;
        }
        // SAFETY: both handles are valid for the duration of the call.
        unsafe {
            AssignProcessToJobObject(job as *mut core::ffi::c_void, child.as_raw_handle());
        }
    }
}

const STDERR_TAIL_LINES: usize = 25;
const STDERR_TAIL_CHARS: usize = 4000;

/// The last lines of a stream, for error details.
#[derive(Debug, Default)]
pub(crate) struct Tail {
    lines: VecDeque<String>,
}

impl Tail {
    pub(crate) fn push(&mut self, line: &str) {
        let line = line.trim_end();
        if line.is_empty() {
            return;
        }
        self.lines.push_back(line.to_string());
        while self.lines.len() > STDERR_TAIL_LINES {
            self.lines.pop_front();
        }
    }
    pub(crate) fn text(&self) -> String {
        let joined = self.lines.iter().cloned().collect::<Vec<_>>().join("\n");
        if joined.len() <= STDERR_TAIL_CHARS {
            return joined;
        }
        let mut start = joined.len() - STDERR_TAIL_CHARS;
        while !joined.is_char_boundary(start) {
            start += 1;
        }
        joined[start..].to_string()
    }
}

/// A running child process, killed on cancel and always reaped.
pub struct ManagedChild {
    child: Arc<Mutex<Child>>,
    stdout: Option<ChildStdout>,
    tail: Arc<Mutex<Tail>>,
    stderr_thread: Option<JoinHandle<()>>,
    watchdog: Option<JoinHandle<()>>,
    finished: Arc<AtomicBool>,
    killed_for_cancel: Arc<AtomicBool>,
    cancel: CancelToken,
}

impl ManagedChild {
    /// Starts `cmd` (made with [`hidden_command`]) with stdout piped and stderr captured.
    pub(crate) fn spawn(mut cmd: Command, cancel: CancelToken) -> Result<ManagedChild, RunFailure> {
        if cancel.is_cancelled() {
            return Err(RunFailure::Cancelled);
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| RunFailure::Spawn(format!("{:?}: {e}", cmd.get_program())))?;
        #[cfg(windows)]
        job::adopt(&child);

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let tail = Arc::new(Mutex::new(Tail::default()));
        let stderr_thread = stderr.map(|s| {
            let tail = Arc::clone(&tail);
            std::thread::spawn(move || {
                let mut reader = BufReader::new(s);
                let mut buf = Vec::new();
                loop {
                    buf.clear();
                    match reader.read_until(b'\n', &mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let text = String::from_utf8_lossy(&buf);
                            for part in text.split('\r') {
                                if let Ok(mut t) = tail.lock() {
                                    t.push(part);
                                }
                            }
                        }
                    }
                }
            })
        });

        let child = Arc::new(Mutex::new(child));
        let finished = Arc::new(AtomicBool::new(false));
        let killed_for_cancel = Arc::new(AtomicBool::new(false));
        let watchdog = {
            let child = Arc::clone(&child);
            let finished = Arc::clone(&finished);
            let killed = Arc::clone(&killed_for_cancel);
            let cancel = cancel.clone();
            std::thread::spawn(move || {
                while !finished.load(Ordering::SeqCst) {
                    if cancel.is_cancelled() {
                        if let Ok(mut c) = child.lock()
                            && matches!(c.try_wait(), Ok(None))
                        {
                            killed.store(true, Ordering::SeqCst);
                            let _ = c.kill();
                        }
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
            })
        };

        Ok(ManagedChild {
            child,
            stdout,
            tail,
            stderr_thread,
            watchdog: Some(watchdog),
            finished,
            killed_for_cancel,
            cancel,
        })
    }

    /// The child's stdout, once.
    pub(crate) fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.stdout.take()
    }

    /// Kills the process now (it is still reaped by [`ManagedChild::wait`] or on drop).
    pub(crate) fn kill(&self) {
        if let Ok(mut c) = self.child.lock()
            && matches!(c.try_wait(), Ok(None))
        {
            let _ = c.kill();
        }
    }

    fn reap(&mut self) -> std::io::Result<ExitStatus> {
        let status = loop {
            {
                let mut c = self.child.lock().map_err(|_| std::io::Error::other("child lock poisoned"))?;
                if let Some(s) = c.try_wait()? {
                    break s;
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        self.finished.store(true, Ordering::SeqCst);
        if let Some(w) = self.watchdog.take() {
            let _ = w.join();
        }
        if let Some(t) = self.stderr_thread.take() {
            let _ = t.join();
        }
        Ok(status)
    }

    /// Waits for the process to end. Cancelled if the token was cancelled while it ran
    /// (or before it ended); `Failed` with the end of the error output if it exited non-zero.
    pub(crate) fn wait(self) -> Result<(), RunFailure> {
        self.wait_with_tail().map(|_| ())
    }

    /// Like [`ManagedChild::wait`], and on success returns the last lines of stderr (for a
    /// process whose answer is in its log, such as a `showinfo` run).
    pub(crate) fn wait_with_tail(mut self) -> Result<String, RunFailure> {
        drop(self.stdout.take());
        let status = self.reap().map_err(|e| RunFailure::Failed { status: e.to_string(), stderr_tail: String::new() })?;
        if self.killed_for_cancel.load(Ordering::SeqCst) || (self.cancel.is_cancelled() && !status.success()) {
            return Err(RunFailure::Cancelled);
        }
        if status.success() {
            Ok(self.stderr_tail())
        } else {
            Err(RunFailure::Failed { status: format!("FFmpeg {status}"), stderr_tail: self.stderr_tail() })
        }
    }

    /// The last lines written to stderr so far.
    pub(crate) fn stderr_tail(&self) -> String {
        self.tail.lock().map(|t| t.text()).unwrap_or_default()
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        if !self.finished.load(Ordering::SeqCst) {
            self.kill();
            drop(self.stdout.take());
            let _ = self.reap();
        }
    }
}

/// Removes files, ignoring ones that do not exist.
pub(crate) fn remove_files(paths: &[PathBuf]) {
    for p in paths {
        let _ = std::fs::remove_file(p);
    }
}

/// The name a task writes to while it runs: `<output>.part`. Renamed to `output` when complete.
pub fn in_progress_path(output: &Path) -> PathBuf {
    let mut name = output.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".part");
    output.with_file_name(name)
}

/// Renames the finished in-progress file onto its final name (replacing an older one).
pub(crate) fn commit(part: &Path, output: &Path) -> Result<(), AppError> {
    std::fs::rename(part, output).map_err(|e| {
        let _ = std::fs::remove_file(part);
        AppError::internal("Could not move the finished file into place")
            .with_detail(format!("{} -> {}: {e}", part.display(), output.display()))
    })
}

/// Creates the folder an output file goes in.
pub(crate) fn ensure_parent(output: &Path) -> Result<(), AppError> {
    if let Some(dir) = output.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| {
            AppError::internal("Could not create the output folder").with_detail(format!("{}: {e}", dir.display()))
        })?;
    }
    Ok(())
}

/// What [`run_ffmpeg`] needs besides the arguments.
pub struct RunSpec<'a> {
    /// The length of the output being made, for progress (`out_time / duration`).
    pub duration: Micros,
    /// Cancels the run.
    pub cancel: &'a CancelToken,
    /// Files removed if the run fails or is cancelled.
    pub partial_outputs: Vec<PathBuf>,
}

/// One `key=value` line of FFmpeg's `-progress` output, as a time in microseconds when it is
/// `out_time_us` (or the older `out_time_ms`, which also holds microseconds), and whether it
/// is the final `progress=end`.
pub(crate) fn parse_progress_line(line: &str) -> (Option<i64>, bool) {
    let line = line.trim();
    if let Some(v) = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms=")) {
        return (v.trim().parse::<i64>().ok().filter(|t| *t >= 0), false);
    }
    (None, line == "progress=end")
}

/// Runs one FFmpeg process to completion with machine-readable progress on stdout.
/// `args` are everything after the global options this adds (`-hide_banner -nostdin
/// -loglevel error -nostats -progress pipe:1`). On failure or cancel, `spec.partial_outputs`
/// are removed.
pub fn run_ffmpeg<I, S>(
    tools: &FfmpegTools,
    args: I,
    spec: RunSpec<'_>,
    on_progress: &mut dyn FnMut(TaskProgress),
) -> Result<(), RunFailure>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut cmd = hidden_command(&tools.ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-loglevel", "error", "-nostats", "-stats_period", "0.25", "-progress", "pipe:1"]);
    cmd.args(args);
    let result = (|| {
        let mut child = ManagedChild::spawn(cmd, spec.cancel.clone())?;
        let mut clock = ProgressClock::new();
        if let Some(p) = clock.report(0.0) {
            on_progress(p);
        }
        if let Some(stdout) = child.take_stdout() {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let (time, end) = parse_progress_line(&line);
                let fraction = if end {
                    Some(1.0)
                } else {
                    time.filter(|_| spec.duration > 0).map(|t| t as f64 / spec.duration as f64)
                };
                // Hold back 1.0 until FFmpeg says it has finished (the trailer is still being written).
                if let Some(f) = fraction.map(|f| if end { f } else { f.min(0.999) })
                    && let Some(p) = clock.report(f)
                {
                    on_progress(p);
                }
            }
        }
        child.wait()
    })();
    if result.is_err() {
        remove_files(&spec.partial_outputs);
    }
    result
}

/// Reads up to `buf.len()` bytes, retrying short reads, so callers see whole sample frames.
/// Returns the number read; less than `buf.len()` only at the end of the stream.
pub(crate) fn read_full(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_lines_are_parsed() {
        assert_eq!(parse_progress_line("out_time_us=1500000\n"), (Some(1_500_000), false));
        assert_eq!(parse_progress_line("out_time_ms=2000"), (Some(2000), false));
        assert_eq!(parse_progress_line("out_time_us=N/A"), (None, false));
        assert_eq!(parse_progress_line("out_time_us=-23220"), (None, false));
        assert_eq!(parse_progress_line("progress=end"), (None, true));
        assert_eq!(parse_progress_line("progress=continue"), (None, false));
        assert_eq!(parse_progress_line("frame=12"), (None, false));
    }

    #[test]
    fn progress_clock_estimates_time_left_and_throttles() {
        let mut clock = ProgressClock::new();
        assert_eq!(clock.report(0.0).unwrap().seconds_left, None);
        assert!(clock.report(0.1).is_none(), "second report within 200 ms is held back");
        assert_eq!(clock.report(1.0).unwrap().fraction, 1.0, "completion is always reported");
        clock.started -= Duration::from_secs(10);
        let p = clock.at(0.25);
        let left = p.seconds_left.unwrap();
        assert!((left - 30.0).abs() < 0.5, "10 s for 25 % leaves about 30 s, got {left}");
        assert_eq!(clock.at(7.0).fraction, 1.0);
    }

    #[test]
    fn stderr_tail_keeps_the_last_lines() {
        let mut t = Tail::default();
        for i in 0..100 {
            t.push(&format!("line {i}"));
        }
        let text = t.text();
        assert!(text.ends_with("line 99"));
        assert!(!text.contains("line 74\n"));
        assert_eq!(text.lines().count(), STDERR_TAIL_LINES);
    }

    #[test]
    fn failure_maps_disk_full_and_cancel() {
        let f = RunFailure::Failed { status: "exit 1".into(), stderr_tail: "Error writing: No space left on device".into() };
        assert_eq!(f.into_app_error(ErrorCode::Internal, "x").code, ErrorCode::DiskFull);
        assert_eq!(RunFailure::Cancelled.into_app_error(ErrorCode::Internal, "x").code, ErrorCode::Cancelled);
        let f = RunFailure::Failed { status: "exit 1".into(), stderr_tail: "Invalid data".into() };
        let e = f.into_app_error(ErrorCode::SourceUnreadable, "bad");
        assert_eq!(e.code, ErrorCode::SourceUnreadable);
        assert!(e.detail.unwrap().contains("Invalid data"));
    }

    #[test]
    fn in_progress_name_sits_next_to_the_output() {
        assert_eq!(in_progress_path(Path::new("C:/c/proxy.mp4")), PathBuf::from("C:/c/proxy.mp4.part"));
    }

    #[test]
    fn a_failing_ffmpeg_reports_its_error_output_and_removes_partials() {
        let tools = FfmpegTools::locate(None).unwrap();
        let dir = crate::test_support::scratch_dir("runner-fail");
        let partial = dir.join("x.part");
        std::fs::write(&partial, b"half").unwrap();
        let cancel = CancelToken::new();
        let err = run_ffmpeg(
            &tools,
            ["-i", "C:/no/such/file.mp4", "-f", "null", "-"],
            RunSpec { duration: 1_000_000, cancel: &cancel, partial_outputs: vec![partial.clone()] },
            &mut |_| {},
        )
        .unwrap_err();
        match err {
            RunFailure::Failed { stderr_tail, .. } => assert!(stderr_tail.contains("such file") || stderr_tail.contains("No such"), "{stderr_tail}"),
            other => panic!("expected Failed, got {other:?}"),
        }
        assert!(!partial.exists());
    }

    #[test]
    fn cancel_kills_a_running_ffmpeg_quickly() {
        let tools = FfmpegTools::locate(None).unwrap();
        let cancel = CancelToken::new();
        let c2 = cancel.clone();
        let started = Instant::now();
        let mut seen = 0;
        let res = run_ffmpeg(
            &tools,
            ["-re", "-f", "lavfi", "-i", "sine=frequency=440:duration=60", "-f", "null", "-"],
            RunSpec { duration: 60_000_000, cancel: &cancel, partial_outputs: vec![] },
            &mut |p| {
                seen += 1;
                if p.fraction > 0.0 {
                    c2.cancel();
                }
            },
        );
        assert_eq!(res, Err(RunFailure::Cancelled));
        assert!(seen >= 1);
        assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
    }
}
