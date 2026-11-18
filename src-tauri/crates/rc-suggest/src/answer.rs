//! Reading what `claude -p --output-format json` printed: branch on the envelope as the
//! experiment describes (spikes/claude/RESULT.md sections 3 and 4), validate the
//! structured answer against the embedded schema, and map every failure to an
//! [`ErrorCode`] of spec 3.5.8. A failure is never turned into an empty list.

use rc_types::{AppError, ErrorCode, SuggestionKind};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::request::ANSWER_SCHEMA;
use crate::schema;

/// One suggestion exactly as Claude answers it (spec 3.5.8 answer fields).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaudeSuggestion {
    pub kind: ClaudeKind,
    pub first_utterance: u32,
    pub last_utterance: u32,
    /// The exact words to cut, copied from the transcript.
    pub quote: String,
    pub reason: String,
    /// Retakes (and asides that cover a failed take): the utterance holding the version to keep.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_utterance: Option<u32>,
}

/// The three kinds Claude may propose (dead air is found locally).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeKind {
    Retake,
    FalseStart,
    Aside,
}

impl From<ClaudeKind> for SuggestionKind {
    fn from(k: ClaudeKind) -> Self {
        match k {
            ClaudeKind::Retake => SuggestionKind::Retake,
            ClaudeKind::FalseStart => SuggestionKind::FalseStart,
            ClaudeKind::Aside => SuggestionKind::Aside,
        }
    }
}

/// A usable answer: Claude's suggestions and the model that actually answered
/// (from the envelope's `modelUsage`, e.g. `claude-opus-5-5`), when reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeAnswer {
    pub suggestions: Vec<ClaudeSuggestion>,
    pub model: Option<String>,
}

/// The one-line notices shown for each outcome (spec 1.12).
pub(crate) mod notice {
    pub const MISSING: &str = "Claude Code is not installed, so there are no Claude suggestions.";
    pub const SIGNED_OUT: &str =
        "Claude is signed out. Sign in with `claude auth login`, then retry.";
    pub const LIMIT: &str = "Claude's usage limit is reached. Retry after it resets.";
    pub const OFFLINE: &str = "Claude could not be reached. Check the connection, then retry.";
    pub const BAD_ANSWER: &str = "Claude's answer could not be used. Retry to ask again.";
}

/// Texts Claude Code prints when the login is missing, expired or (API-key mode) refused.
const SIGNED_OUT_PREFIXES: &[&str] = &[
    "Not logged in",
    "Login expired",
    "Invalid API key",
    "OAuth token has expired",
];

/// Connection texts from the experiment and the Claude Code errors page.
const OFFLINE_PREFIXES: &[&str] = &[
    "API Error: Connection",
    "Unable to connect to API",
    "Can't reach the API server",
    "No internet route",
    "Connection dropped",
    "Request timed out",
    "API Error: Request timed out",
    "API Error: No response from API",
];

fn err(code: ErrorCode, message: &str, detail: impl Into<String>) -> AppError {
    let detail: String = detail.into();
    let e = AppError::new(code, message);
    if detail.is_empty() {
        e
    } else {
        e.with_detail(detail)
    }
}

/// Whether a result text reports a usage limit (`You've hit your session limit · resets ...`,
/// `... usage limit`, `... spend limit`). A short server throttle that says
/// "not your usage limit" is not one.
fn is_limit_text(result: &str) -> bool {
    let lower = result.to_lowercase();
    if lower.contains("not your usage limit") {
        return false;
    }
    let hit = lower
        .find("hit your")
        .is_some_and(|i| lower[i..].contains("limit"));
    hit || lower.contains("usage limit") || lower.contains("spend limit")
}

/// Classifies one finished call. `exit_code` is the process exit code (None when it was
/// killed), `stdout` its standard output decoded as UTF-8, `stderr` kept for detail only.
pub fn read_answer(
    exit_code: Option<i32>,
    stdout: &str,
    stderr: &str,
) -> Result<ClaudeAnswer, AppError> {
    let parsed: Option<Value> = serde_json::from_str(stdout.trim()).ok();
    let Some(env) = parsed.filter(|v| v.get("type").and_then(Value::as_str) == Some("result"))
    else {
        let mut detail =
            format!("exit code {exit_code:?}; standard output was not a result envelope");
        let head: String = stdout.trim().chars().take(300).collect();
        if !head.is_empty() {
            detail.push_str(&format!(": {head}"));
        }
        let err_head: String = stderr.trim().chars().take(300).collect();
        if !err_head.is_empty() {
            detail.push_str(&format!(" | stderr: {err_head}"));
        }
        return Err(err(ErrorCode::ClaudeBadAnswer, notice::BAD_ANSWER, detail));
    };

    let result = env
        .get("result")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    // Branch on is_error, never on subtype: error envelopes also say "success".
    if env
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let api_error = env.get("api_error").and_then(Value::as_str).unwrap_or("");
        let status = env.get("api_error_status").and_then(Value::as_i64);
        let r = result.trim_start();
        if SIGNED_OUT_PREFIXES.iter().any(|p| r.starts_with(p)) {
            return Err(err(ErrorCode::ClaudeSignedOut, notice::SIGNED_OUT, result));
        }
        if r.to_lowercase().contains("not your usage limit") {
            return Err(err(ErrorCode::ClaudeOffline, notice::OFFLINE, result));
        }
        if status == Some(429) || is_limit_text(r) {
            return Err(err(ErrorCode::ClaudeLimit, notice::LIMIT, result));
        }
        if api_error == "connection_failed" || OFFLINE_PREFIXES.iter().any(|p| r.starts_with(p)) {
            return Err(err(ErrorCode::ClaudeOffline, notice::OFFLINE, result));
        }
        let detail = if api_error.is_empty() {
            result
        } else {
            format!("{api_error}: {result}")
        };
        return Err(err(ErrorCode::ClaudeBadAnswer, notice::BAD_ANSWER, detail));
    }

    let subtype = env.get("subtype").and_then(Value::as_str).unwrap_or("");
    let terminal = env
        .get("terminal_reason")
        .and_then(Value::as_str)
        .unwrap_or("");
    if matches!(
        subtype,
        "error_max_structured_output_retries" | "error_during_execution"
    ) || terminal == "structured_output_retry_exhausted"
    {
        return Err(err(
            ErrorCode::ClaudeBadAnswer,
            notice::BAD_ANSWER,
            format!("{subtype} {terminal}: {result}"),
        ));
    }
    let structured = match env.get("structured_output") {
        Some(v) if !v.is_null() => v,
        _ => {
            let head: String = result.chars().take(300).collect();
            return Err(err(
                ErrorCode::ClaudeBadAnswer,
                notice::BAD_ANSWER,
                format!("no structured_output: {head}"),
            ));
        }
    };
    let schema: Value = serde_json::from_str(ANSWER_SCHEMA).expect("embedded schema is valid JSON");
    if let Err(problem) = schema::validate(&schema, structured) {
        return Err(err(
            ErrorCode::ClaudeBadAnswer,
            notice::BAD_ANSWER,
            format!("answer fails the schema: {problem}"),
        ));
    }
    #[derive(Deserialize)]
    struct Answer {
        suggestions: Vec<ClaudeSuggestion>,
    }
    let answer: Answer = serde_json::from_value(structured.clone()).map_err(|e| {
        err(
            ErrorCode::ClaudeBadAnswer,
            notice::BAD_ANSWER,
            format!("answer does not parse: {e}"),
        )
    })?;
    let model = env
        .get("modelUsage")
        .and_then(Value::as_object)
        .and_then(|m| m.keys().min().cloned());
    Ok(ClaudeAnswer {
        suggestions: answer.suggestions,
        model,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn envelope(extra: Value) -> String {
        let mut base = json!({"type": "result", "subtype": "success", "is_error": false, "result": "", "terminal_reason": "completed"});
        for (k, v) in extra.as_object().unwrap() {
            base[k] = v.clone();
        }
        base.to_string()
    }

    fn code(r: Result<ClaudeAnswer, AppError>) -> ErrorCode {
        r.unwrap_err().code
    }

    #[test]
    fn success_reads_structured_output_and_model() {
        let s = envelope(json!({
            "structured_output": {"suggestions": [{"kind": "false_start", "first_utterance": 2, "last_utterance": 2, "quote": "I was", "reason": "Abandoned start"}]},
            "modelUsage": {"claude-opus-5-5": {"costUSD": 0.1}}
        }));
        let a = read_answer(Some(0), &s, "").unwrap();
        assert_eq!(a.suggestions.len(), 1);
        assert_eq!(a.suggestions[0].kind, ClaudeKind::FalseStart);
        assert_eq!(a.model.as_deref(), Some("claude-opus-5-5"));
    }

    #[test]
    fn error_envelopes_map_to_codes() {
        let e = |result: &str, extra: Value| {
            let mut v = extra;
            v["is_error"] = json!(true);
            v["result"] = json!(result);
            v["terminal_reason"] = json!("api_error");
            code(read_answer(Some(1), &envelope(v), ""))
        };
        assert_eq!(
            e("Not logged in · Please run /login", json!({})),
            ErrorCode::ClaudeSignedOut
        );
        assert_eq!(
            e("Login expired · Please run /login", json!({})),
            ErrorCode::ClaudeSignedOut
        );
        assert_eq!(
            e(
                "API Error: Connection refused",
                json!({"api_error": "connection_failed"})
            ),
            ErrorCode::ClaudeOffline
        );
        assert_eq!(
            e("Unable to connect to API (ENOTFOUND)", json!({})),
            ErrorCode::ClaudeOffline
        );
        assert_eq!(
            e("You've hit your session limit · resets 3:45pm", json!({})),
            ErrorCode::ClaudeLimit
        );
        assert_eq!(
            e("You've hit your weekly limit · resets Mon", json!({})),
            ErrorCode::ClaudeLimit
        );
        assert_eq!(
            e("Rate limited", json!({"api_error_status": 429})),
            ErrorCode::ClaudeLimit
        );
        assert_eq!(
            e("Your org reached its spend limit", json!({})),
            ErrorCode::ClaudeLimit
        );
        assert_eq!(
            e(
                "API Error: Server is temporarily limiting requests (not your usage limit)",
                json!({"api_error_status": 429})
            ),
            ErrorCode::ClaudeOffline
        );
        assert_eq!(
            e("Something unexpected", json!({})),
            ErrorCode::ClaudeBadAnswer
        );
    }

    #[test]
    fn unusable_answers_are_bad_answers_never_empty_lists() {
        assert_eq!(
            code(read_answer(
                Some(0),
                &envelope(json!({"result": "I decline"})),
                ""
            )),
            ErrorCode::ClaudeBadAnswer
        );
        assert_eq!(
            code(read_answer(
                Some(0),
                &envelope(json!({"structured_output": null})),
                ""
            )),
            ErrorCode::ClaudeBadAnswer
        );
        assert_eq!(
            code(read_answer(
                Some(0),
                &envelope(json!({"structured_output": {"suggestions": [{"kind": "pause"}]}})),
                ""
            )),
            ErrorCode::ClaudeBadAnswer
        );
        assert_eq!(
            code(read_answer(
                Some(0),
                &envelope(
                    json!({"subtype": "error_max_structured_output_retries", "structured_output": {"suggestions": []}})
                ),
                ""
            )),
            ErrorCode::ClaudeBadAnswer
        );
        assert_eq!(
            code(read_answer(Some(0), "not json at all", "")),
            ErrorCode::ClaudeBadAnswer
        );
        assert_eq!(
            code(read_answer(Some(1), "", "boom")),
            ErrorCode::ClaudeBadAnswer
        );
        assert_eq!(
            code(read_answer(Some(0), "[1,2]", "")),
            ErrorCode::ClaudeBadAnswer
        );
    }
}
