//! Running the installed `claude` program exactly as the experiment settled
//! (spikes/claude/RESULT.md section 2): argv list, never a shell; a new empty working folder
//! removed afterwards; credential, mode and nesting variables removed from the child's
//! environment; `ENABLE_CLAUDEAI_MCP_SERVERS=false` and `CLAUDE_CODE_MAX_RETRIES=2` added;
//! the child killed after a time limit.

use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rc_types::{AppError, ClaudeAuth, ClaudeStatus, ErrorCode, Settings};
use serde_json::Value;

use crate::answer::{ClaudeAnswer, notice, read_answer};
use crate::request::{ANSWER_SCHEMA, SYSTEM_PROMPT};

/// Variables removed from the child by name (RESULT.md section 2), on top of every other
/// `CLAUDE*` and `ANTHROPIC_*` variable except [`KEPT_VARIABLE`].
pub const REMOVED_VARIABLES: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_PROFILE",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_SIMPLE",
];
/// The one `CLAUDE*` variable passed through: the user's own choice of config folder.
pub const KEPT_VARIABLE: &str = "CLAUDE_CONFIG_DIR";
/// Default time limit for the suggestion call (RESULT.md: an hour of speech takes ~1 min).
pub const DEFAULT_CALL_TIME_LIMIT: Duration = Duration::from_secs(180);
/// Default time limit for `claude --version` and `claude auth status` (they take ~1 s).
pub const DEFAULT_STATUS_TIME_LIMIT: Duration = Duration::from_secs(30);

/// Which credential the child uses.
#[derive(Clone, PartialEq, Eq)]
pub enum ClaudeAuthMode {
    /// The user's own Claude subscription login (the default, spec 1.9).
    Subscription,
    /// The risk-3 fallback (spec 2.8): this API key is put in the child's environment as
    /// `ANTHROPIC_API_KEY`, and nowhere else. The caller reads it from Credential Manager.
    ApiKey(String),
}

impl std::fmt::Debug for ClaudeAuthMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClaudeAuthMode::Subscription => f.write_str("Subscription"),
            ClaudeAuthMode::ApiKey(_) => f.write_str("ApiKey(<hidden>)"),
        }
    }
}

/// How to run `claude`. Build it with [`ClaudeConfig::from_settings`].
#[derive(Debug, Clone)]
pub struct ClaudeConfig {
    /// The program to run; `None` finds the installed `claude.exe` (see [`find_claude`]).
    pub program: Option<PathBuf>,
    /// `--model`, from `Settings.claudeModel` (`opus` by default).
    pub model: String,
    pub auth: ClaudeAuthMode,
    /// `Settings.claudeCodeVersionTested`: the version the app was last checked against.
    pub version_tested: String,
    /// Kill the suggestion call after this long and report `claude_offline`.
    pub call_time_limit: Duration,
    /// Time limit for `--version` and `auth status`.
    pub status_time_limit: Duration,
    /// Added to the child's environment after the filtering (a proxy setting, or a test
    /// stand-in's instructions). Not used by the app by default.
    pub extra_env: Vec<(String, String)>,
}

impl ClaudeConfig {
    /// The configuration for `settings`. `api_key` is used only when
    /// `settings.claudeAuth` is `api_key`; without a key that mode falls back to the subscription.
    pub fn from_settings(settings: &Settings, api_key: Option<String>) -> Self {
        let auth = match (settings.claude_auth, api_key) {
            (ClaudeAuth::ApiKey, Some(k)) if !k.trim().is_empty() => ClaudeAuthMode::ApiKey(k),
            _ => ClaudeAuthMode::Subscription,
        };
        let model = if settings.claude_model.trim().is_empty() {
            "opus".to_string()
        } else {
            settings.claude_model.clone()
        };
        ClaudeConfig {
            program: None,
            model,
            auth,
            version_tested: settings.claude_code_version_tested.clone(),
            call_time_limit: DEFAULT_CALL_TIME_LIMIT,
            status_time_limit: DEFAULT_STATUS_TIME_LIMIT,
            extra_env: Vec::new(),
        }
    }
}

/// Finds the installed `claude.exe`: `%USERPROFILE%\.local\bin\claude.exe` (the native
/// installer's location), then each folder on `PATH`. Only a real executable is accepted,
/// never a `.cmd` shim, so arguments are never re-parsed by a shell.
pub fn find_claude() -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    let mut candidates: Vec<PathBuf> = home
        .into_iter()
        .map(|h| PathBuf::from(h).join(".local").join("bin").join(exe))
        .collect();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|d| d.join(exe)));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// The child's environment, built from `parent`: drops [`REMOVED_VARIABLES`] and every
/// other `CLAUDE*` / `ANTHROPIC_*` name except [`KEPT_VARIABLE`] (compared without regard to
/// case, as Windows does), sets `ENABLE_CLAUDEAI_MCP_SERVERS=false` and
/// `CLAUDE_CODE_MAX_RETRIES=2`, adds `ANTHROPIC_API_KEY` only in API-key mode, then `extra`.
pub fn child_environment(
    parent: impl IntoIterator<Item = (OsString, OsString)>,
    auth: &ClaudeAuthMode,
    extra: &[(String, String)],
) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = parent
        .into_iter()
        .filter(|(k, _)| {
            !is_removed_variable(k)
                && !k
                    .to_string_lossy()
                    .eq_ignore_ascii_case("ENABLE_CLAUDEAI_MCP_SERVERS")
        })
        .collect();
    env.push(("ENABLE_CLAUDEAI_MCP_SERVERS".into(), "false".into()));
    env.push(("CLAUDE_CODE_MAX_RETRIES".into(), "2".into()));
    if let ClaudeAuthMode::ApiKey(key) = auth {
        env.push(("ANTHROPIC_API_KEY".into(), key.into()));
    }
    for (k, v) in extra {
        env.retain(|(name, _)| !name.to_string_lossy().eq_ignore_ascii_case(k));
        env.push((k.into(), v.into()));
    }
    env
}

/// The suggestion call's arguments (after the program), exactly the experiment's command.
pub fn call_arguments(model: &str, system_prompt_file: &Path) -> Vec<OsString> {
    let schema: Value = serde_json::from_str(ANSWER_SCHEMA).expect("embedded schema is valid JSON");
    vec![
        "-p".into(),
        "--output-format".into(),
        "json".into(),
        "--json-schema".into(),
        schema.to_string().into(),
        "--tools".into(),
        "".into(),
        "--system-prompt-file".into(),
        system_prompt_file.as_os_str().to_owned(),
        "--no-session-persistence".into(),
        "--setting-sources".into(),
        "".into(),
        "--strict-mcp-config".into(),
        "--disable-slash-commands".into(),
        "--model".into(),
        model.into(),
    ]
}

/// A new private folder under the system temp folder, removed when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> std::io::Result<TempDir> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "roughcut-claude-{}-{nanos}-{n}",
            std::process::id()
        ));
        std::fs::create_dir(&path)?;
        Ok(TempDir(path))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// What a finished (or stopped) child produced.
pub(crate) struct Finished {
    /// `None` when the child was killed.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub(crate) enum RunError {
    /// The program could not be started because it does not exist.
    Missing(String),
    /// It could not be started for another reason.
    Spawn(String),
    TimedOut,
    Cancelled,
}

/// Runs `program args` in `cwd` with exactly `env`, feeding `stdin`, until it exits, the
/// time limit passes or `cancel` is set (both kill it).
pub(crate) fn run(
    program: &Path,
    args: &[OsString],
    cwd: &Path,
    env: &[(OsString, OsString)],
    stdin: Option<&str>,
    limit: Duration,
    cancel: &AtomicBool,
) -> Result<Finished, RunError> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k.as_os_str(), v.as_os_str())))
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let spawned = cmd.spawn();
    if let Ok(c) = &spawned {
        // If the app exits or crashes, Windows ends `claude` with it.
        job::adopt(c);
    }
    let mut child = spawned.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            RunError::Missing(format!("{}: {e}", program.display()))
        } else {
            RunError::Spawn(format!("{}: {e}", program.display()))
        }
    })?;

    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        let bytes = text.as_bytes().to_vec();
        // A child that exits early closes the pipe; that write error is expected and ignored.
        thread::spawn(move || {
            let _ = pipe.write_all(&bytes);
        });
    }
    let reader = |pipe: Option<Box<dyn Read + Send>>| {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        if let Some(mut p) = pipe {
            thread::spawn(move || {
                let mut buf = Vec::new();
                let _ = p.read_to_end(&mut buf);
                let _ = tx.send(buf);
            });
        }
        rx
    };
    let out_rx = reader(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let err_rx = reader(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );

    let started = Instant::now();
    let stop = loop {
        match child.try_wait() {
            Ok(Some(_)) => break None,
            Ok(None) => {}
            Err(e) => {
                break Some(RunError::Spawn(format!(
                    "waiting for {}: {e}",
                    program.display()
                )));
            }
        }
        if cancel.load(Ordering::Relaxed) {
            break Some(RunError::Cancelled);
        }
        if started.elapsed() >= limit {
            break Some(RunError::TimedOut);
        }
        thread::sleep(Duration::from_millis(20));
    };
    if let Some(e) = stop {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }
    let status = child.wait().map_err(|e| RunError::Spawn(e.to_string()))?;
    // Grace period: a grandchild could keep a pipe open; never hang on it.
    let grace = Duration::from_secs(5);
    let stdout = out_rx.recv_timeout(grace).unwrap_or_default();
    let stderr = err_rx.recv_timeout(grace).unwrap_or_default();
    Ok(Finished {
        code: status.code(),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

/// Runs a short status command (`--version`, `auth status --json`) in an empty temp folder.
fn run_short(program: &Path, args: &[&str], cfg: &ClaudeConfig) -> Result<Finished, RunError> {
    let dir = TempDir::new().map_err(|e| RunError::Spawn(format!("temporary folder: {e}")))?;
    let env = child_environment(std::env::vars_os(), &cfg.auth, &cfg.extra_env);
    let args: Vec<OsString> = args.iter().map(OsString::from).collect();
    let never = AtomicBool::new(false);
    run(
        program,
        &args,
        &dir.0,
        &env,
        None,
        cfg.status_time_limit,
        &never,
    )
}

/// The version number from `claude --version` output (`2.1.323 (Claude Code)` → `2.1.323`).
pub fn parse_version(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .next()
        .filter(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(str::to_string)
}

/// The program to run for `cfg`, if any.
fn program_for(cfg: &ClaudeConfig) -> Option<PathBuf> {
    match &cfg.program {
        Some(p) => Some(p.clone()),
        None => find_claude(),
    }
}

/// Claude's status (spec 3.4 `ClaudeStatus`) without a model call: whether `claude` is
/// installed, its version (`claude --version`), whether that equals the version tested,
/// and whether it is signed in and how (`claude auth status --json`, which needs no network).
pub fn claude_status(cfg: &ClaudeConfig) -> ClaudeStatus {
    let not_installed = ClaudeStatus {
        installed: false,
        version: None,
        version_tested: false,
        signed_in: false,
        auth_method: None,
    };
    let Some(program) = program_for(cfg) else {
        return not_installed;
    };
    let version = match run_short(&program, &["--version"], cfg) {
        Ok(f) if f.code == Some(0) => parse_version(&f.stdout),
        Ok(_) | Err(RunError::TimedOut | RunError::Cancelled | RunError::Spawn(_)) => None,
        Err(RunError::Missing(_)) => return not_installed,
    };
    let (signed_in, auth_method) = match run_short(&program, &["auth", "status", "--json"], cfg) {
        Ok(f) => match serde_json::from_str::<Value>(f.stdout.trim()) {
            Ok(v) => {
                let logged_in = v.get("loggedIn").and_then(Value::as_bool).unwrap_or(false);
                let method = v
                    .get("authMethod")
                    .and_then(Value::as_str)
                    .filter(|m| *m != "none")
                    .map(str::to_string);
                (logged_in, method)
            }
            Err(_) => (false, None),
        },
        Err(RunError::Missing(_)) => return not_installed,
        Err(_) => (false, None),
    };
    ClaudeStatus {
        installed: true,
        version_tested: version
            .as_deref()
            .is_some_and(|v| v == cfg.version_tested.trim()),
        version,
        signed_in,
        auth_method,
    }
}

fn missing_error(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::ClaudeMissing, notice::MISSING).with_detail(detail)
}

/// One suggestion call: writes the system prompt next to a new empty working folder, runs
/// the command with `request` on standard input, removes both afterwards, and reads the answer.
fn call_once(
    program: &Path,
    request: &str,
    cfg: &ClaudeConfig,
    cancel: &AtomicBool,
) -> Result<ClaudeAnswer, AppError> {
    let dir = TempDir::new().map_err(|e| {
        AppError::internal("Could not create a temporary folder for Claude.")
            .with_detail(e.to_string())
    })?;
    let prompt = dir.0.join("system-prompt.txt");
    let work = dir.0.join("work");
    std::fs::write(&prompt, SYSTEM_PROMPT)
        .and_then(|_| std::fs::create_dir(&work))
        .map_err(|e| {
            AppError::internal("Could not prepare the temporary folder for Claude.")
                .with_detail(e.to_string())
        })?;
    let env = child_environment(std::env::vars_os(), &cfg.auth, &cfg.extra_env);
    let args = call_arguments(&cfg.model, &prompt);
    let finished = run(
        program,
        &args,
        &work,
        &env,
        Some(request),
        cfg.call_time_limit,
        cancel,
    );
    drop(dir);
    match finished {
        Ok(f) => read_answer(f.code, &f.stdout, &f.stderr),
        Err(RunError::Missing(d)) => Err(missing_error(d)),
        Err(RunError::Spawn(d)) => {
            Err(AppError::internal("Claude Code could not be started.").with_detail(d))
        }
        Err(RunError::TimedOut) => Err(AppError::new(ErrorCode::ClaudeOffline, notice::OFFLINE)
            .with_detail(format!(
                "no answer within {} s; the call was stopped",
                cfg.call_time_limit.as_secs()
            ))),
        Err(RunError::Cancelled) => Err(AppError::new(ErrorCode::Cancelled, "Cancelled.")),
    }
}

/// Asks Claude for suggestions on `request` (built by `build_request`). Checks
/// `claude auth status` first (spec 2.4.6), then makes the call; an unusable answer is
/// retried once before `claude_bad_answer` (spec 3.5.8). Setting `cancel` stops the child
/// and returns `cancelled`. Errors: `claude_missing`, `claude_signed_out`, `claude_limit`,
/// `claude_offline`, `claude_bad_answer`, `cancelled`, `internal`.
pub fn ask_claude(
    request: &str,
    cfg: &ClaudeConfig,
    cancel: &AtomicBool,
) -> Result<ClaudeAnswer, AppError> {
    let Some(program) = program_for(cfg) else {
        return Err(missing_error(
            "claude.exe was not found in %USERPROFILE%\\.local\\bin or on PATH",
        ));
    };
    let status = claude_status(cfg);
    if !status.installed {
        return Err(missing_error(program.display().to_string()));
    }
    if !status.signed_in {
        return Err(
            AppError::new(ErrorCode::ClaudeSignedOut, notice::SIGNED_OUT)
                .with_detail("`claude auth status` reports not logged in"),
        );
    }
    let mut attempt = 0;
    loop {
        attempt += 1;
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::new(ErrorCode::Cancelled, "Cancelled."));
        }
        match call_once(&program, request, cfg, cancel) {
            Err(e) if e.code == ErrorCode::ClaudeBadAnswer && attempt < 2 => continue,
            Err(mut e) if e.code == ErrorCode::ClaudeSignedOut => {
                // auth status said signed in, but the call was refused: the signature of bare
                // mode becoming the `-p` default (spec 2.8 risk 3, RESULT.md section 7).
                let was = e.detail.take().unwrap_or_default();
                e.detail = Some(format!(
                    "{was} (`claude auth status` says signed in, so Claude Code {} may now ignore the subscription login in scripted calls; the API-key setting is the fallback)",
                    status.version.as_deref().unwrap_or("?")
                ));
                return Err(e);
            }
            other => return other,
        }
    }
}

/// Whether a parent variable is kept out of the child (compared without regard to case).
pub fn is_removed_variable(name: &OsStr) -> bool {
    let up = name.to_string_lossy().to_uppercase();
    REMOVED_VARIABLES.contains(&up.as_str())
        || ((up.starts_with("CLAUDE") || up.starts_with("ANTHROPIC_")) && up != KEPT_VARIABLE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }

    fn names(e: &[(OsString, OsString)]) -> Vec<String> {
        e.iter()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn child_environment_strips_credentials_and_nesting_markers() {
        let parent = env(&[
            ("PATH", "C:\\bin"),
            ("ANTHROPIC_API_KEY", "sk-secret"),
            ("anthropic_auth_token", "t"),
            ("ANTHROPIC_BASE_URL", "http://x"),
            ("CLAUDECODE", "1"),
            ("CLAUDE_CODE_SESSION_ID", "abc"),
            ("CLAUDE_CODE_SIMPLE", "1"),
            ("CLAUDE_CONFIG_DIR", "D:\\cfg"),
            ("ENABLE_CLAUDEAI_MCP_SERVERS", "true"),
            ("USERPROFILE", "C:\\Users\\me"),
        ]);
        let e = child_environment(parent, &ClaudeAuthMode::Subscription, &[]);
        let n = names(&e);
        assert_eq!(
            n,
            vec![
                "PATH",
                "CLAUDE_CONFIG_DIR",
                "USERPROFILE",
                "ENABLE_CLAUDEAI_MCP_SERVERS",
                "CLAUDE_CODE_MAX_RETRIES"
            ]
        );
        assert!(e.contains(&("ENABLE_CLAUDEAI_MCP_SERVERS".into(), "false".into())));
        assert!(e.contains(&("CLAUDE_CODE_MAX_RETRIES".into(), "2".into())));
        assert!(!e.iter().any(|(_, v)| v == "sk-secret"));
    }

    #[test]
    fn api_key_mode_passes_the_given_key_only() {
        let parent = env(&[("ANTHROPIC_API_KEY", "parent-key")]);
        let e = child_environment(parent, &ClaudeAuthMode::ApiKey("given-key".into()), &[]);
        let keys: Vec<_> = e.iter().filter(|(k, _)| k == "ANTHROPIC_API_KEY").collect();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].1, "given-key");
        assert_eq!(
            format!("{:?}", ClaudeAuthMode::ApiKey("given-key".into())),
            "ApiKey(<hidden>)"
        );
    }

    #[test]
    fn extra_env_replaces_same_name() {
        let e = child_environment(
            env(&[("HTTPS_PROXY", "a")]),
            &ClaudeAuthMode::Subscription,
            &[("https_proxy".into(), "b".into())],
        );
        assert_eq!(
            e.iter()
                .filter(|(k, _)| k.to_string_lossy().eq_ignore_ascii_case("https_proxy"))
                .count(),
            1
        );
        assert!(e.contains(&("https_proxy".into(), "b".into())));
    }

    #[test]
    fn arguments_match_the_experiment() {
        let a = call_arguments("opus", Path::new("C:\\t\\system-prompt.txt"));
        let s: Vec<String> = a.iter().map(|x| x.to_string_lossy().into_owned()).collect();
        assert_eq!(s[0], "-p");
        assert_eq!(&s[1..3], ["--output-format", "json"]);
        assert_eq!(s[3], "--json-schema");
        assert_eq!(
            serde_json::from_str::<Value>(&s[4]).unwrap(),
            serde_json::from_str::<Value>(ANSWER_SCHEMA).unwrap()
        );
        assert!(!s[4].contains(' ') && !s[4].contains('\n'));
        assert_eq!(&s[5..7], ["--tools", ""]);
        assert_eq!(
            &s[7..9],
            ["--system-prompt-file", "C:\\t\\system-prompt.txt"]
        );
        assert_eq!(
            &s[9..],
            [
                "--no-session-persistence",
                "--setting-sources",
                "",
                "--strict-mcp-config",
                "--disable-slash-commands",
                "--model",
                "opus"
            ]
        );
        assert!(
            !s.iter()
                .any(|x| x == "--bare" || x == "--verbose" || x == "--effort")
        );
    }

    #[test]
    fn version_parsing() {
        assert_eq!(
            parse_version("2.1.323 (Claude Code)\n").as_deref(),
            Some("2.1.323")
        );
        assert_eq!(parse_version("").as_deref(), None);
        assert_eq!(parse_version("error: unknown").as_deref(), None);
    }

    #[test]
    fn config_from_settings() {
        let mut s = Settings {
            schema_version: 1,
            export_folder: String::new(),
            key_bindings: vec![],
            speech_model: String::new(),
            speech_device: Default::default(),
            claude_model: "sonnet".into(),
            claude_auth: ClaudeAuth::Subscription,
            claude_code_version_tested: "2.1.323".into(),
            cache_limit_bytes: 0,
        };
        let c = ClaudeConfig::from_settings(&s, Some("k".into()));
        assert_eq!(c.model, "sonnet");
        assert_eq!(c.auth, ClaudeAuthMode::Subscription);
        assert_eq!(c.version_tested, "2.1.323");
        assert_eq!(c.call_time_limit, DEFAULT_CALL_TIME_LIMIT);
        s.claude_auth = ClaudeAuth::ApiKey;
        assert_eq!(
            ClaudeConfig::from_settings(&s, Some("k".into())).auth,
            ClaudeAuthMode::ApiKey("k".into())
        );
        assert_eq!(
            ClaudeConfig::from_settings(&s, None).auth,
            ClaudeAuthMode::Subscription
        );
        s.claude_model = " ".into();
        assert_eq!(ClaudeConfig::from_settings(&s, None).model, "opus");
        assert!(is_removed_variable(OsStr::new("claudecode")));
        assert!(!is_removed_variable(OsStr::new("CLAUDE_CONFIG_DIR")));
    }
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
