//! Test helper: a stand-in for the `claude` program (spec 3.7, the `suggest` row). It
//! replays the envelopes recorded by the milestone-0 experiment and records how it was
//! started. Never used by the app. Driven by variables the test passes through
//! `ClaudeConfig::extra_env`:
//!
//! - `RC_STANDIN_LOG`: append one JSON line per run: `args`, the full `env`, `cwd`, the
//!   names in `cwd` (`cwdEntries`), `stdin`, and whether the `--system-prompt-file` exists.
//! - `RC_STANDIN_VERSION`: what `--version` prints (default `2.1.323 (Claude Code)`).
//! - `RC_STANDIN_AUTH` / `RC_STANDIN_AUTH_EXIT`: the file `auth status` prints and its exit
//!   code (default: a signed-in subscription, exit 0). With `ANTHROPIC_API_KEY` set it
//!   reports API-key auth, as the real program does.
//! - `RC_STANDIN_REPLIES`: `file|exit;file|exit;...`: the n-th `-p` call prints the n-th
//!   file (the last one repeats) and exits with its code. `RC_STANDIN_COUNTER` is the file
//!   that counts calls.
//! - `RC_STANDIN_SLEEP_MS`: wait this long before answering a `-p` call.

use std::io::{Read, Write};
use std::path::Path;

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn print_file(path: &str) {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("stand-in: cannot read {path}: {e}"));
    std::io::stdout()
        .write_all(&bytes)
        .expect("stand-in: write stdout");
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut stdin = String::new();
    if args.first().map(String::as_str) == Some("-p") {
        std::io::stdin()
            .read_to_string(&mut stdin)
            .expect("stand-in: read stdin");
    }

    if let Some(log) = var("RC_STANDIN_LOG") {
        let cwd = std::env::current_dir().expect("cwd");
        let entries: Vec<String> = std::fs::read_dir(&cwd)
            .map(|d| {
                d.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        let prompt_file = args
            .iter()
            .position(|a| a == "--system-prompt-file")
            .and_then(|i| args.get(i + 1));
        let env: serde_json::Map<String, serde_json::Value> = std::env::vars()
            .map(|(k, v)| (k, serde_json::Value::String(v)))
            .collect();
        let line = serde_json::json!({
            "args": args,
            "env": env,
            "cwd": cwd.to_string_lossy(),
            "cwdEntries": entries,
            "stdin": stdin,
            "promptFileExists": prompt_file.is_some_and(|p| Path::new(p).is_file()),
            "promptFile": prompt_file,
        });
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log)
            .expect("stand-in: open log");
        writeln!(f, "{line}").expect("stand-in: write log");
    }

    match args.first().map(String::as_str) {
        Some("--version") => {
            println!(
                "{}",
                var("RC_STANDIN_VERSION").unwrap_or_else(|| "2.1.323 (Claude Code)".into())
            );
        }
        Some("auth") => {
            if std::env::var_os("ANTHROPIC_API_KEY").is_some() {
                println!(
                    r#"{{"loggedIn": true, "authMethod": "api_key", "apiProvider": "firstParty", "apiKeySource": "ANTHROPIC_API_KEY"}}"#
                );
                return;
            }
            match var("RC_STANDIN_AUTH") {
                Some(path) => print_file(&path),
                None => println!(
                    r#"{{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "max"}}"#
                ),
            }
            let code: i32 = var("RC_STANDIN_AUTH_EXIT")
                .and_then(|c| c.parse().ok())
                .unwrap_or(0);
            std::process::exit(code);
        }
        Some("-p") => {
            if let Some(ms) = var("RC_STANDIN_SLEEP_MS").and_then(|m| m.parse::<u64>().ok()) {
                std::thread::sleep(std::time::Duration::from_millis(ms));
            }
            let replies =
                var("RC_STANDIN_REPLIES").expect("stand-in: RC_STANDIN_REPLIES is not set");
            let replies: Vec<&str> = replies.split(';').filter(|r| !r.is_empty()).collect();
            let n = match var("RC_STANDIN_COUNTER") {
                Some(counter) => {
                    let n: usize = std::fs::read_to_string(&counter)
                        .ok()
                        .and_then(|s| s.trim().parse().ok())
                        .unwrap_or(0);
                    std::fs::write(&counter, (n + 1).to_string()).expect("stand-in: write counter");
                    n
                }
                None => 0,
            };
            let reply = replies[n.min(replies.len() - 1)];
            let (file, code) = reply.rsplit_once('|').unwrap_or((reply, "0"));
            print_file(file);
            std::process::exit(code.parse().unwrap_or(0));
        }
        other => {
            eprintln!("stand-in claude: unexpected arguments {other:?}");
            std::process::exit(2);
        }
    }
}
