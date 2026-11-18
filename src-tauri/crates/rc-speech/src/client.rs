//! The transcriber client: starts the transcriber program, feeds it audio, reads its lines.
//!
//! Three threads keep the pipes moving so neither side can block the other: one copies the
//! audio into the transcriber's standard input (and measures its sound level on the way),
//! one reads standard output line by line, one drains standard error. The calling thread
//! turns lines into transcript updates and watches for cancellation.
//!
//! Every failure of the transcriber (it cannot start, crashes, exits non-zero, writes a line
//! outside the protocol, or reports an `error`) becomes `AppError` `transcriber_failed` with
//! the details, never a panic.

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use rc_types::{AppError, ErrorCode, Micros, SpeechDevice, Transcript, Utterance};

use crate::builder::{BuildOptions, TranscriptBuilder};
use crate::levels::LevelTrack;
use crate::protocol::{DeviceUsed, Message};

/// How to start the transcriber (protocol command line:
/// `transcriber --model-dir <folder> --device <auto|gpu|cpu> [--vad-model <file>]`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriberCommand {
    pub program: PathBuf,
    pub model_dir: PathBuf,
    pub device: SpeechDevice,
    pub vad_model: Option<PathBuf>,
}

impl TranscriberCommand {
    /// The command-line arguments, in protocol order.
    pub fn args(&self) -> Vec<OsString> {
        let device = match self.device {
            SpeechDevice::Auto => "auto",
            SpeechDevice::Gpu => "gpu",
            SpeechDevice::Cpu => "cpu",
        };
        let mut args: Vec<OsString> =
            vec!["--model-dir".into(), self.model_dir.clone().into_os_string(), "--device".into(), device.into()];
        if let Some(vad) = &self.vad_model {
            args.push("--vad-model".into());
            args.push(vad.clone().into_os_string());
        }
        args
    }
}

/// A flag another thread sets to stop a transcription (or a download). Clones share the flag.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    /// A token that is not cancelled.
    pub fn new() -> Self {
        Self::default()
    }
    /// Asks the work to stop. It stops within about a tenth of a second.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    /// True once [`cancel`](Self::cancel) was called.
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// What a running transcription reports to its caller.
#[derive(Debug, Clone, PartialEq)]
pub enum SpeechEvent {
    /// The transcriber loaded its model. `fallback`: the GPU was wanted but the processor is used.
    Ready { model: String, device: DeviceUsed, fallback: bool },
    /// Seconds of audio transcribed so far, and that as a fraction (0 to 1) of the source.
    Progress { audio_seconds: f64, fraction: f64 },
    /// Utterances that became final, in order; the caller emits `transcript_appended`.
    Utterances(Vec<Utterance>),
}

/// What one transcription is about.
#[derive(Debug, Clone)]
pub struct TranscribeJob {
    pub source_id: String,
    /// Length of the source; every time in the transcript stays inside it.
    pub duration: Micros,
    pub options: BuildOptions,
}

const STDERR_KEEP: usize = 4096;
const POLL: Duration = Duration::from_millis(50);

enum Incoming {
    Line(Vec<u8>),
    StdoutClosed(Option<String>),
}

enum WriterEnd {
    /// All audio was written and standard input closed.
    Finished,
    /// The transcriber closed its input early (it exited or crashed).
    PipeClosed(String),
    /// Reading the audio failed.
    AudioError(String),
    Cancelled,
}

/// Kills the child if the transcription ends early for any reason, including a panic in a callback.
struct ChildGuard(Option<Child>);

impl ChildGuard {
    fn kill(&mut self) {
        if let Some(c) = self.0.as_mut() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        self.kill();
    }
}

fn failed(message: &str, detail: String) -> AppError {
    AppError::new(ErrorCode::TranscriberFailed, message).with_detail(detail)
}

/// Runs the transcriber over `audio` (16 kHz mono s16le PCM) and returns the finished transcript.
///
/// `on_event` receives readiness, progress and each batch of final utterances as they happen.
/// Returns `cancelled` when `cancel` is set, and `transcriber_failed` for every transcriber
/// failure. The transcriber process is always gone when this returns. If `audio` blocks on a
/// read when cancelled, its copying thread is left to end when `audio` does.
pub fn transcribe<R>(
    command: &TranscriberCommand,
    job: &TranscribeJob,
    audio: R,
    cancel: &CancelToken,
    mut on_event: impl FnMut(SpeechEvent),
) -> Result<Transcript, AppError>
where
    R: Read + Send + 'static,
{
    let mut cmd = Command::new(&command.program);
    cmd.args(command.args()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| {
        failed("Could not start the transcriber.", format!("{}: {e}", command.program.display()))
    })?;
    // If the app exits or crashes, Windows ends the transcriber with it.
    job::adopt(&child);
    let stdin = child.stdin.take().expect("stdin is piped");
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let mut guard = ChildGuard(Some(child));

    let levels = Arc::new(Mutex::new(LevelTrack::new()));
    let audio_error = Arc::new(Mutex::new(None::<String>));
    let writer = spawn_writer(audio, stdin, Arc::clone(&levels), cancel.clone(), Arc::clone(&audio_error));

    let (tx, rx) = mpsc::channel::<Incoming>();
    let reader = std::thread::Builder::new()
        .name("transcriber-stdout".into())
        .spawn(move || {
            let mut r = BufReader::with_capacity(64 * 1024, stdout);
            loop {
                let mut line = Vec::new();
                match r.read_until(b'\n', &mut line) {
                    Ok(0) => {
                        let _ = tx.send(Incoming::StdoutClosed(None));
                        return;
                    }
                    Ok(_) => {
                        if tx.send(Incoming::Line(line)).is_err() {
                            return;
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Incoming::StdoutClosed(Some(e.to_string())));
                        return;
                    }
                }
            }
        })
        .expect("spawn reader thread");

    let stderr_tail = Arc::new(Mutex::new(Vec::<u8>::new()));
    let err_reader = {
        let tail = Arc::clone(&stderr_tail);
        std::thread::Builder::new()
            .name("transcriber-stderr".into())
            .spawn(move || {
                let mut r = stderr;
                let mut buf = [0u8; 8192];
                while let Ok(n) = r.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let mut t = tail.lock().unwrap_or_else(|p| p.into_inner());
                    t.extend_from_slice(&buf[..n]);
                    if t.len() > 2 * STDERR_KEEP {
                        let cut = t.len() - STDERR_KEEP;
                        t.drain(..cut);
                    }
                }
            })
            .expect("spawn stderr thread")
    };

    let tail = || {
        let t = stderr_tail.lock().unwrap_or_else(|p| p.into_inner());
        let start = t.len().saturating_sub(STDERR_KEEP);
        String::from_utf8_lossy(&t[start..]).trim().to_string()
    };
    let with_stderr = |detail: String, tail: String| {
        if tail.is_empty() { detail } else { format!("{detail}\nstderr: {tail}") }
    };

    let mut builder = TranscriptBuilder::new(job.source_id.clone(), job.duration, job.options.clone());
    let mut done_seen = false;
    let mut stdout_error = None;

    // Read lines until standard output closes.
    let outcome: Result<(), AppError> = loop {
        if cancel.is_cancelled() {
            break Err(AppError::new(ErrorCode::Cancelled, "Transcription was cancelled."));
        }
        let incoming = match rx.recv_timeout(POLL) {
            Ok(i) => i,
            Err(RecvTimeoutError::Timeout) => {
                if let Some(e) = audio_error.lock().unwrap_or_else(|p| p.into_inner()).clone() {
                    break Err(failed("Could not read the audio for transcription.", e));
                }
                // More audio may have been measured: release what waited for its sound level.
                {
                    let lv = levels.lock().unwrap_or_else(|p| p.into_inner());
                    builder.advance(&lv);
                }
                let batch = builder.take_final_utterances();
                if !batch.is_empty() {
                    on_event(SpeechEvent::Utterances(batch));
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break Ok(()),
        };
        let line = match incoming {
            Incoming::StdoutClosed(err) => {
                stdout_error = err;
                break Ok(());
            }
            Incoming::Line(bytes) => bytes,
        };
        let text = match String::from_utf8(line) {
            Ok(t) => t,
            Err(e) => {
                break Err(failed(
                    "The transcriber sent output that is not part of its protocol.",
                    format!("line is not UTF-8: {e}"),
                ));
            }
        };
        if text.trim().is_empty() {
            continue;
        }
        let msg = match Message::parse_line(&text) {
            Ok(m) => m,
            Err(e) => {
                let shown: String = text.trim().chars().take(300).collect();
                break Err(failed(
                    "The transcriber sent output that is not part of its protocol.",
                    format!("{e}; line: {shown}"),
                ));
            }
        };
        if done_seen {
            // Nothing may follow "done" but the end of output.
            break Err(failed("The transcriber sent output after finishing.", text.trim().chars().take(300).collect()));
        }
        match &msg {
            Message::Ready { model, device, fallback } => {
                builder.set_model(model.clone());
                on_event(SpeechEvent::Ready { model: model.clone(), device: *device, fallback: *fallback });
            }
            Message::Progress { audio_seconds } => {
                let fraction = if job.duration > 0 {
                    (audio_seconds * 1e6 / job.duration as f64).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                on_event(SpeechEvent::Progress { audio_seconds: *audio_seconds, fraction });
            }
            Message::Error { code, message } => {
                break Err(failed("The transcriber reported an error.", format!("{code}: {message}")));
            }
            Message::Segment { .. } | Message::SpeechWithoutWords { .. } | Message::Done { .. } => {
                {
                    let lv = levels.lock().unwrap_or_else(|p| p.into_inner());
                    builder.push_message(&msg, &lv);
                }
                if matches!(msg, Message::Done { .. }) {
                    done_seen = true;
                }
                let batch = builder.take_final_utterances();
                if !batch.is_empty() {
                    on_event(SpeechEvent::Utterances(batch));
                }
            }
        }
    };

    if let Err(e) = outcome {
        guard.kill();
        let _ = reader.join();
        let _ = err_reader.join();
        if writer.is_finished() {
            let _ = writer.join();
        }
        let e = if e.code == ErrorCode::TranscriberFailed {
            let detail = e.detail.clone().unwrap_or_default();
            AppError { detail: Some(with_stderr(detail, tail())), ..e }
        } else {
            e
        };
        return Err(e);
    }

    // Standard output closed: wait for the exit, still honouring cancel.
    let status: ExitStatus = loop {
        if cancel.is_cancelled() {
            guard.kill();
            return Err(AppError::new(ErrorCode::Cancelled, "Transcription was cancelled."));
        }
        let child = guard.0.as_mut().expect("child present");
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => std::thread::sleep(POLL),
            Err(e) => {
                guard.kill();
                return Err(failed("Lost track of the transcriber.", e.to_string()));
            }
        }
    };
    guard.0 = None;
    let _ = reader.join();
    let _ = err_reader.join();
    // The transcriber is gone, so the copying thread ends at its next write; give it a moment
    // (it can only stay blocked inside a read of `audio`).
    for _ in 0..40 {
        if writer.is_finished() {
            break;
        }
        std::thread::sleep(POLL);
    }
    let writer_end = if writer.is_finished() { writer.join().ok() } else { None };
    if let Some(e) = audio_error.lock().unwrap_or_else(|p| p.into_inner()).clone() {
        return Err(failed("Could not read the audio for transcription.", e));
    }

    if !done_seen {
        let mut detail = format!("exited with {status} before finishing");
        if let Some(e) = stdout_error {
            detail.push_str(&format!("; reading its output failed: {e}"));
        }
        match writer_end {
            Some(WriterEnd::AudioError(e)) => return Err(failed("Could not read the audio for transcription.", e)),
            Some(WriterEnd::PipeClosed(e)) => detail.push_str(&format!("; it stopped reading its input ({e})")),
            _ => {}
        }
        return Err(failed("The transcriber stopped unexpectedly.", with_stderr(detail, tail())));
    }
    if !status.success() {
        return Err(failed(
            "The transcriber stopped unexpectedly.",
            with_stderr(format!("exited with {status} after finishing"), tail()),
        ));
    }
    match writer_end {
        Some(WriterEnd::AudioError(e)) => return Err(failed("Could not read the audio for transcription.", e)),
        Some(WriterEnd::Cancelled) => return Err(AppError::new(ErrorCode::Cancelled, "Transcription was cancelled.")),
        Some(WriterEnd::Finished) | Some(WriterEnd::PipeClosed(_)) | None => {}
    }
    Ok(builder.into_transcript())
}

/// Copies `audio` into the transcriber's input, measuring its level on the way. An audio read
/// error is also stored in `audio_error` so the reading side can stop at once.
fn spawn_writer<R>(
    mut audio: R,
    mut stdin: ChildStdin,
    levels: Arc<Mutex<LevelTrack>>,
    cancel: CancelToken,
    audio_error: Arc<Mutex<Option<String>>>,
) -> JoinHandle<WriterEnd>
where
    R: Read + Send + 'static,
{
    std::thread::Builder::new()
        .name("transcriber-stdin".into())
        .spawn(move || {
            let end = (|| {
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    if cancel.is_cancelled() {
                        return WriterEnd::Cancelled;
                    }
                    let n = match audio.read(&mut buf) {
                        Ok(0) => return WriterEnd::Finished,
                        Ok(n) => n,
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(e) => {
                            // Stored before the pipe closes, so the reading side sees it first.
                            *audio_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(e.to_string());
                            return WriterEnd::AudioError(e.to_string());
                        }
                    };
                    // Measured before it is written: the transcriber never hears audio whose
                    // level is not known yet.
                    levels.lock().unwrap_or_else(|p| p.into_inner()).push_pcm(&buf[..n]);
                    if let Err(e) = stdin.write_all(&buf[..n]) {
                        return WriterEnd::PipeClosed(e.to_string());
                    }
                }
            })();
            levels.lock().unwrap_or_else(|p| p.into_inner()).mark_ended();
            drop(stdin); // closes the transcriber's input: end of audio
            end
        })
        .expect("spawn writer thread")
}

#[cfg(windows)]
mod job {
    //! One job object for the whole app, with "kill on close": when the app exits or crashes,
    //! Windows closes the handle and ends every child still running (same as rc-media's).
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

    /// Puts the child in the app's job object. Failure is ignored: the child is still killed
    /// on cancel and on drop; only the crash safety net is missing.
    pub(crate) fn adopt(child: &std::process::Child) {
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

#[cfg(not(windows))]
mod job {
    pub(crate) fn adopt(_child: &std::process::Child) {}
}
