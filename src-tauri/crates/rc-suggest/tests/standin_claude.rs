//! Spec 3.7, `suggest` row: integration tests with a stand-in `claude` program that replays
//! the envelopes recorded in milestone 0. Each outcome of spec 3.5.8 gives the right error;
//! a changed Claude Code version is flagged; the call is made exactly as the experiment's.

mod common;

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use common::{Standin, data, transcript};
use rc_suggest::{ask_claude, build_request, claude_status, suggest_for_source};
use rc_types::{
    AppError, ErrorCode, PauseToken, SuggestionKind, SuggestionOrigin, Token, Transcript,
};

const SUCCESS: &str = "recorded/success-150.stdout.txt";
const SIGNED_OUT_CALL: &str = "recorded/print-signed-out.stdout.txt";
const OFFLINE: &str = "recorded/print-offline-retries2.stdout.txt";
const AUTH_SIGNED_OUT: &str = "recorded/auth-status-signed-out.json.stdout.txt";
const AUTH_SIGNED_IN: &str = "recorded/auth-status-signed-in.json.stdout.txt";
const LIMIT: &str = "synthetic/limit.stdout.txt";
const NO_ANSWER: &str = "synthetic/no-structured-output.stdout.txt";
const SCHEMA_BAD: &str = "synthetic/schema-violation.stdout.txt";
const GARBAGE: &str = "synthetic/garbage.stdout.txt";

fn ask(s: &Standin) -> Result<rc_suggest::ClaudeAnswer, AppError> {
    let request = build_request(&transcript("transcript-150.json"));
    ask_claude(&request, &s.cfg, &AtomicBool::new(false))
}

fn code(r: Result<rc_suggest::ClaudeAnswer, AppError>) -> ErrorCode {
    match r {
        Ok(a) => panic!("expected an error, got {} suggestions", a.suggestions.len()),
        Err(e) => e.code,
    }
}

#[test]
fn success_replays_the_recorded_answer() {
    let s = Standin::new(&[(SUCCESS, 0)]).auth(AUTH_SIGNED_IN, 0);
    let a = ask(&s).unwrap();
    assert_eq!(a.suggestions.len(), 21);
    assert_eq!(a.model.as_deref(), Some("claude-opus-5-5"));
    assert_eq!(s.calls().len(), 1);
}

#[test]
fn the_call_is_made_exactly_as_the_experiment_settled() {
    let s = Standin::new(&[(SUCCESS, 0)]);
    ask(&s).unwrap();
    let log = s.log();
    // Status first (version, auth status), then one call.
    let kinds: Vec<String> = log
        .iter()
        .map(|r| r["args"][0].as_str().unwrap().to_string())
        .collect();
    assert_eq!(kinds, ["--version", "auth", "-p"]);
    assert_eq!(
        log[1]["args"],
        serde_json::json!(["auth", "status", "--json"])
    );

    let call = &s.calls()[0];
    let args: Vec<&str> = call["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a.as_str().unwrap())
        .collect();
    assert_eq!(args.len(), 16);
    assert_eq!(
        &args[..4],
        ["-p", "--output-format", "json", "--json-schema"]
    );
    let schema: serde_json::Value = serde_json::from_str(args[4]).unwrap();
    assert_eq!(
        schema,
        serde_json::from_str::<serde_json::Value>(rc_suggest::ANSWER_SCHEMA).unwrap()
    );
    // Empty arguments arrive as real empty arguments.
    assert_eq!(&args[5..7], ["--tools", ""]);
    assert_eq!(args[7], "--system-prompt-file");
    assert_eq!(
        &args[9..],
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
    assert_eq!(call["promptFileExists"], true);

    // Standard input is the request, byte for byte the experiment's recorded request.
    let recorded = std::fs::read_to_string(data("recorded/request-150.txt")).unwrap();
    assert_eq!(call["stdin"].as_str().unwrap(), recorded);

    // The working folder was new and empty, and it and the prompt file are gone afterwards.
    assert_eq!(call["cwdEntries"], serde_json::json!([]));
    let cwd = PathBuf::from(call["cwd"].as_str().unwrap());
    assert!(
        !cwd.exists(),
        "working folder left behind: {}",
        cwd.display()
    );
    assert!(
        !Path::new(args[8]).exists(),
        "system prompt file left behind"
    );
    assert!(
        cwd.to_string_lossy().contains("roughcut-claude-"),
        "{}",
        cwd.display()
    );

    // Environment: retries and connectors set; nothing CLAUDE*/ANTHROPIC_* but those (and the config dir).
    let env = call["env"].as_object().unwrap();
    assert_eq!(
        env.get("CLAUDE_CODE_MAX_RETRIES").and_then(|v| v.as_str()),
        Some("2")
    );
    assert_eq!(
        env.get("ENABLE_CLAUDEAI_MCP_SERVERS")
            .and_then(|v| v.as_str()),
        Some("false")
    );
    for k in env.keys() {
        let up = k.to_uppercase();
        if up.starts_with("CLAUDE") || up.starts_with("ANTHROPIC_") {
            assert!(
                up == "CLAUDE_CODE_MAX_RETRIES" || up == "CLAUDE_CONFIG_DIR",
                "{k} reached the child"
            );
        }
    }
}

#[test]
fn model_comes_from_the_config() {
    let mut s = Standin::new(&[(SUCCESS, 0)]);
    s.cfg.model = "sonnet".into();
    ask(&s).unwrap();
    let args = s.calls()[0]["args"].clone();
    assert_eq!(args[15], "sonnet");
}

#[test]
fn signed_out_in_auth_status_stops_before_any_call() {
    let s = Standin::new(&[(SUCCESS, 0)]).auth(AUTH_SIGNED_OUT, 1);
    assert_eq!(code(ask(&s)), ErrorCode::ClaudeSignedOut);
    assert!(s.calls().is_empty(), "no model call when signed out");
}

#[test]
fn signed_out_in_the_call_is_flagged_as_the_bare_mode_signature() {
    let s = Standin::new(&[(SIGNED_OUT_CALL, 1)]);
    let e = ask(&s).unwrap_err();
    assert_eq!(e.code, ErrorCode::ClaudeSignedOut);
    let detail = e.detail.unwrap();
    assert!(detail.starts_with("Not logged in"), "{detail}");
    assert!(detail.contains("auth status"), "{detail}");
    assert_eq!(s.calls().len(), 1, "signed out is not retried");
}

#[test]
fn offline_is_claude_offline() {
    let s = Standin::new(&[(OFFLINE, 1)]);
    let e = ask(&s).unwrap_err();
    assert_eq!(e.code, ErrorCode::ClaudeOffline);
    assert!(e.detail.unwrap().contains("ECONNREFUSED"));
    assert_eq!(s.calls().len(), 1);
}

#[test]
fn usage_limit_is_claude_limit() {
    let s = Standin::new(&[(LIMIT, 1)]);
    assert_eq!(code(ask(&s)), ErrorCode::ClaudeLimit);
    assert_eq!(s.calls().len(), 1, "a limit is not retried");
}

#[test]
fn malformed_answers_are_retried_once_then_bad_answer() {
    for bad in [NO_ANSWER, SCHEMA_BAD, GARBAGE] {
        let s = Standin::new(&[(bad, 0)]);
        assert_eq!(code(ask(&s)), ErrorCode::ClaudeBadAnswer, "{bad}");
        assert_eq!(s.calls().len(), 2, "{bad}: exactly one automatic retry");
    }
}

#[test]
fn a_bad_answer_then_a_good_one_succeeds() {
    let s = Standin::new(&[(NO_ANSWER, 0), (SUCCESS, 0)]);
    assert_eq!(ask(&s).unwrap().suggestions.len(), 21);
    assert_eq!(s.calls().len(), 2);
}

#[test]
fn a_call_past_the_time_limit_is_stopped_and_offline() {
    let mut s = Standin::new(&[(SUCCESS, 0)]).set("RC_STANDIN_SLEEP_MS", "20000");
    s.cfg.call_time_limit = Duration::from_millis(1500);
    let t0 = Instant::now();
    let e = ask(&s).unwrap_err();
    assert_eq!(e.code, ErrorCode::ClaudeOffline);
    assert!(
        t0.elapsed() < Duration::from_secs(10),
        "took {:?}",
        t0.elapsed()
    );
    let cwd = PathBuf::from(s.calls()[0]["cwd"].as_str().unwrap());
    assert!(!cwd.exists(), "working folder left behind after a kill");
}

#[test]
fn cancel_stops_the_call() {
    let s = Standin::new(&[(SUCCESS, 0)]).set("RC_STANDIN_SLEEP_MS", "20000");
    let cancel = std::sync::Arc::new(AtomicBool::new(false));
    let c2 = cancel.clone();
    let t = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        c2.store(true, std::sync::atomic::Ordering::Relaxed);
    });
    let t0 = Instant::now();
    let r = ask_claude(
        &build_request(&transcript("transcript-150.json")),
        &s.cfg,
        &cancel,
    );
    t.join().unwrap();
    assert_eq!(r.unwrap_err().code, ErrorCode::Cancelled);
    assert!(t0.elapsed() < Duration::from_secs(10));
}

#[test]
fn missing_program_is_claude_missing() {
    let mut s = Standin::new(&[(SUCCESS, 0)]);
    s.cfg.program = Some(PathBuf::from("C:/definitely/not/here/claude.exe"));
    assert_eq!(code(ask(&s)), ErrorCode::ClaudeMissing);
    let st = claude_status(&s.cfg);
    assert!(!st.installed && !st.signed_in && !st.version_tested);
    assert_eq!(st.version, None);
}

#[test]
fn status_reports_version_sign_in_and_method() {
    let s = Standin::new(&[]).auth(AUTH_SIGNED_IN, 0);
    let st = claude_status(&s.cfg);
    assert!(st.installed);
    assert_eq!(st.version.as_deref(), Some("2.1.323"));
    assert!(st.version_tested);
    assert!(st.signed_in);
    assert_eq!(st.auth_method.as_deref(), Some("claude.ai"));
    assert!(s.calls().is_empty(), "status makes no model call");

    let s = Standin::new(&[]).auth(AUTH_SIGNED_OUT, 1);
    let st = claude_status(&s.cfg);
    assert!(st.installed && !st.signed_in);
    assert_eq!(st.auth_method, None);
}

#[test]
fn a_changed_claude_code_version_is_flagged() {
    let s = Standin::new(&[]).set("RC_STANDIN_VERSION", "2.2.0 (Claude Code)");
    let st = claude_status(&s.cfg);
    assert_eq!(st.version.as_deref(), Some("2.2.0"));
    assert!(!st.version_tested);
    assert!(st.signed_in);
}

fn with_long_pause(mut t: Transcript) -> Transcript {
    // Put a 4 s silence after utterance 1 by shifting everything after it.
    let shift = 4_000_000;
    let u1_end = t.utterances[0].end;
    for u in t.utterances.iter_mut().skip(1) {
        u.start += shift;
        u.end += shift;
        for tok in u.tokens.iter_mut() {
            match tok {
                Token::Word(w) => {
                    w.start += shift;
                    w.end += shift;
                    w.cut_before += shift;
                }
                Token::Pause(p) => {
                    p.start += shift;
                    p.end += shift;
                    p.cut_before += shift;
                }
                Token::Unrecognised(x) => {
                    x.start += shift;
                    x.end += shift;
                    x.cut_before += shift;
                }
            }
        }
    }
    let next_start = t.utterances[1].start;
    t.utterances[0].tokens.push(Token::Pause(PauseToken {
        start: u1_end + 100_000,
        end: next_start - 100_000,
        cut_before: u1_end + 50_000,
    }));
    t.utterances[0].end = next_start - 100_000;
    t
}

#[test]
fn suggest_for_source_sends_dead_air_first_then_merges_claude() {
    let s = Standin::new(&[(SUCCESS, 0)]);
    let tr = with_long_pause(transcript("transcript-150.json"));
    let mut first = None;
    let out = suggest_for_source(&tr, None, &s.cfg, &AtomicBool::new(false), |set| {
        first = Some(set.clone())
    });
    let first = first.expect("dead air reported first");
    assert_eq!(first.claude_model, None);
    assert_eq!(first.suggestions.len(), 1);
    assert_eq!(first.suggestions[0].kind, SuggestionKind::DeadAir);
    assert_eq!(out.claude_error, None);
    assert_eq!(out.set.claude_model.as_deref(), Some("claude-opus-5-5"));
    assert_eq!(out.set.suggestions.len(), 22);
    assert_eq!(
        out.set
            .suggestions
            .iter()
            .filter(|x| x.origin == SuggestionOrigin::Local)
            .count(),
        1
    );
    let starts: Vec<i64> = out.set.suggestions.iter().map(|x| x.range.start).collect();
    assert!(starts.windows(2).all(|w| w[0] <= w[1]), "sorted by start");
    for w in out.set.suggestions.windows(2) {
        assert!(w[0].range.end <= w[1].range.start, "no overlaps");
    }
    let mut ids: Vec<&str> = out.set.suggestions.iter().map(|x| x.id.as_str()).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 22, "ids are unique");
}

#[test]
fn suggest_for_source_on_failure_keeps_dead_air_and_reports_the_error() {
    let s = Standin::new(&[(OFFLINE, 1)]);
    let tr = with_long_pause(transcript("transcript-150.json"));
    let out = suggest_for_source(&tr, None, &s.cfg, &AtomicBool::new(false), |_| {});
    assert_eq!(
        out.claude_error.as_ref().map(|e| e.code),
        Some(ErrorCode::ClaudeOffline)
    );
    assert_eq!(
        out.set.claude_model, None,
        "a failure is not presented as Claude's answer"
    );
    assert_eq!(out.set.suggestions.len(), 1);
    assert_eq!(out.set.suggestions[0].kind, SuggestionKind::DeadAir);
}

#[test]
fn suggest_for_source_skips_claude_without_words_or_before_the_transcript_is_complete() {
    let s = Standin::new(&[(SUCCESS, 0)]);
    let mut empty = transcript("transcript-150.json");
    empty.utterances.clear();
    let out = suggest_for_source(&empty, None, &s.cfg, &AtomicBool::new(false), |_| {});
    assert_eq!(out.claude_error, None);
    assert!(out.set.suggestions.is_empty());
    let mut partial = transcript("transcript-150.json");
    partial.complete = false;
    let out = suggest_for_source(&partial, None, &s.cfg, &AtomicBool::new(false), |_| {});
    assert_eq!(out.claude_error.map(|e| e.code), Some(ErrorCode::Internal));
    assert!(s.log().is_empty(), "claude was never started");
}
