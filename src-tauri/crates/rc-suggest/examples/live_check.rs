//! The manual per-release check of spec 3.7 ("one manual check per release confirms the
//! real call still works on your subscription"). Makes ONE real model call with the
//! installed `claude` on the 150-utterance fixture and prints what came back.
//!
//! Run by hand only:
//!   cargo run -p rc-suggest --example live_check            (status and one call)
//!   cargo run -p rc-suggest --example live_check -- status  (status only, no model call)

use std::sync::atomic::AtomicBool;
use std::time::Instant;

use rc_suggest::{ClaudeAuthMode, ClaudeConfig, claude_status, suggest_for_source};
use rc_types::Transcript;

fn main() {
    let cfg = ClaudeConfig {
        program: None,
        model: "opus".into(),
        auth: ClaudeAuthMode::Subscription,
        version_tested: "2.1.323".into(),
        call_time_limit: rc_suggest::runner::DEFAULT_CALL_TIME_LIMIT,
        status_time_limit: rc_suggest::runner::DEFAULT_STATUS_TIME_LIMIT,
        extra_env: Vec::new(),
    };
    println!("program: {:?}", rc_suggest::find_claude());
    let t0 = Instant::now();
    let status = claude_status(&cfg);
    println!(
        "status ({:.1} s): {}",
        t0.elapsed().as_secs_f64(),
        serde_json::to_string(&status).unwrap()
    );
    if std::env::args().nth(1).as_deref() == Some("status") {
        return;
    }
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/data/transcript-150.json"
    );
    let transcript: Transcript =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let t0 = Instant::now();
    let out = suggest_for_source(&transcript, None, &cfg, &AtomicBool::new(false), |d| {
        println!("dead air: {} suggestions", d.suggestions.len())
    });
    println!("call took {:.1} s", t0.elapsed().as_secs_f64());
    match out.claude_error {
        Some(e) => println!("claude error: {}", serde_json::to_string(&e).unwrap()),
        None => {
            println!(
                "model: {:?}, {} suggestions",
                out.set.claude_model,
                out.set.suggestions.len()
            );
            for s in &out.set.suggestions {
                println!(
                    "  {:?} {:.2}-{:.2} s keep {:?}: {}",
                    s.kind,
                    s.range.start as f64 / 1e6,
                    s.range.end as f64 / 1e6,
                    s.kept_version_at.map(|k| k as f64 / 1e6),
                    s.reason
                );
            }
        }
    }
}
