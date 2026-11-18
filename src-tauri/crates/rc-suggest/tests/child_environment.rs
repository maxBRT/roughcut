//! Spec 3.7, `suggest` row: `ANTHROPIC_API_KEY` is absent from the child's environment.
//! This file is its own test binary with a single test, because it sets variables in the
//! test process's own environment (as an app started from a shell with a key would have).

mod common;

use std::sync::atomic::AtomicBool;

use common::{Standin, transcript};
use rc_suggest::{ClaudeAuthMode, ask_claude, build_request, claude_status};

const SUCCESS: &str = "recorded/success-150.stdout.txt";

#[test]
fn credentials_in_the_parent_never_reach_the_child_and_an_api_key_only_when_asked() {
    // SAFETY: this test binary runs this one test only, so no other thread reads the
    // environment while it is changed.
    unsafe {
        std::env::set_var("ANTHROPIC_API_KEY", "sk-ant-parent-should-not-leak");
        std::env::set_var("ANTHROPIC_AUTH_TOKEN", "parent-token");
        std::env::set_var("CLAUDE_CODE_SIMPLE", "1");
        std::env::set_var("CLAUDECODE", "1");
        std::env::set_var("CLAUDE_CODE_MAX_RETRIES", "10");
    }
    let request = build_request(&transcript("transcript-150.json"));

    // Subscription mode: nothing from the parent's credentials reaches status or call.
    let s = Standin::new(&[(SUCCESS, 0)]);
    let st = claude_status(&s.cfg);
    assert_eq!(
        st.auth_method.as_deref(),
        Some("claude.ai"),
        "the stand-in saw an API key"
    );
    ask_claude(&request, &s.cfg, &AtomicBool::new(false)).unwrap();
    let log = s.log();
    assert_eq!(
        log.len(),
        5,
        "version + auth (status), version + auth (pre-check), call"
    );
    for run in &log {
        let env = run["env"].as_object().unwrap();
        for k in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_SIMPLE",
            "CLAUDECODE",
        ] {
            assert!(
                !env.keys().any(|n| n.eq_ignore_ascii_case(k)),
                "{k} reached the child in {:?}",
                run["args"]
            );
        }
        assert_eq!(env["CLAUDE_CODE_MAX_RETRIES"], "2");
        assert!(!run.to_string().contains("sk-ant-parent-should-not-leak"));
    }

    // API-key mode: the key the caller gives goes to the child, and only that key.
    let mut s = Standin::new(&[(SUCCESS, 0)]);
    s.cfg.auth = ClaudeAuthMode::ApiKey("sk-ant-given-by-caller".into());
    assert_eq!(
        claude_status(&s.cfg).auth_method.as_deref(),
        Some("api_key")
    );
    ask_claude(&request, &s.cfg, &AtomicBool::new(false)).unwrap();
    let call = &s.calls()[0];
    assert_eq!(call["env"]["ANTHROPIC_API_KEY"], "sk-ant-given-by-caller");
    assert!(!call.to_string().contains("sk-ant-parent-should-not-leak"));
    // The parent's own environment is unchanged by the call.
    assert_eq!(
        std::env::var("ANTHROPIC_API_KEY").unwrap(),
        "sk-ant-parent-should-not-leak"
    );
}
