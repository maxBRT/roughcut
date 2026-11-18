//! Shared helpers for the integration tests: test data paths and a stand-in `claude` setup.
#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use rc_suggest::{ClaudeAuthMode, ClaudeConfig};
use rc_types::Transcript;
use serde_json::Value;

/// Absolute path of a file under tests/data.
pub fn data(rel: &str) -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("data")
        .join(rel)
        .to_string_lossy()
        .into_owned()
}

pub fn transcript(name: &str) -> Transcript {
    serde_json::from_str(&std::fs::read_to_string(data(name)).unwrap()).unwrap()
}

/// The envelope in a recorded stdout file: the object itself, or the `result` message of a
/// `--verbose` message array.
pub fn envelope(rel: &str) -> Value {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(data(rel)).unwrap()).unwrap();
    match v {
        Value::Array(items) => items.into_iter().rfind(|m| m["type"] == "result").unwrap(),
        other => other,
    }
}

/// One stand-in scenario: a private folder holding the stand-in's log and call counter.
pub struct Standin {
    pub dir: PathBuf,
    pub cfg: ClaudeConfig,
}

impl Standin {
    /// A stand-in whose `-p` calls reply with `replies` (`(file under tests/data, exit code)`) in turn.
    pub fn new(replies: &[(&str, i32)]) -> Standin {
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "rc-suggest-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let replies: Vec<String> = replies
            .iter()
            .map(|(f, c)| format!("{}|{c}", data(f)))
            .collect();
        let cfg = ClaudeConfig {
            program: Some(PathBuf::from(env!(
                "CARGO_BIN_EXE_rc-suggest-standin-claude"
            ))),
            model: "opus".into(),
            auth: ClaudeAuthMode::Subscription,
            version_tested: "2.1.323".into(),
            call_time_limit: std::time::Duration::from_secs(60),
            status_time_limit: std::time::Duration::from_secs(30),
            extra_env: vec![
                (
                    "RC_STANDIN_LOG".into(),
                    dir.join("log.jsonl").to_string_lossy().into_owned(),
                ),
                (
                    "RC_STANDIN_COUNTER".into(),
                    dir.join("counter.txt").to_string_lossy().into_owned(),
                ),
                ("RC_STANDIN_REPLIES".into(), replies.join(";")),
            ],
        };
        Standin { dir, cfg }
    }

    /// Adds or replaces one stand-in variable.
    pub fn set(mut self, k: &str, v: &str) -> Standin {
        self.cfg.extra_env.retain(|(n, _)| n != k);
        self.cfg.extra_env.push((k.into(), v.into()));
        self
    }

    /// `auth status` prints this recorded file with this exit code.
    pub fn auth(self, rel: &str, code: i32) -> Standin {
        self.set("RC_STANDIN_AUTH", &data(rel))
            .set("RC_STANDIN_AUTH_EXIT", &code.to_string())
    }

    /// Every run the stand-in logged, in order.
    pub fn log(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.join("log.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    /// The logged `-p` calls.
    pub fn calls(&self) -> Vec<Value> {
        self.log()
            .into_iter()
            .filter(|r| r["args"][0] == "-p")
            .collect()
    }
}

impl Drop for Standin {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
