//! Roughcut core module `suggest` (Claude runner and dead-air detection).
//!
//! Responsibility (spec 3.3): reports Claude's status, builds the request from a transcript,
//! runs `claude`, checks and maps the answer, and finds dead air without Claude.
//!
//! How `claude` is run follows the milestone-0 experiment exactly
//! (spikes/claude/RESULT.md): see [`runner`]. Only `jobs` calls into this crate
//! (spec 3.6 rule 4); it reads the API key from `settings` and passes it in.
//!
//! Public surface:
//! - [`claude_status`] with a [`ClaudeConfig`] built by [`ClaudeConfig::from_settings`];
//! - [`suggest_for_source`]: the whole job for one source (dead air first, then Claude);
//! - the parts it is made of, for tests and reuse: [`build_request`], [`ask_claude`],
//!   [`map_suggestions`], [`find_dead_air`], [`merge_suggestions`], [`locate_quote`].

pub mod answer;
pub mod dead_air;
pub mod mapping;
pub mod merge;
pub mod request;
pub mod runner;
pub mod schema;

use std::sync::atomic::AtomicBool;

use rc_types::{
    AppError, ErrorCode, Rational, SUGGESTION_SET_SCHEMA_VERSION, SuggestionSet, Transcript,
};

pub use answer::{ClaudeAnswer, ClaudeKind, ClaudeSuggestion, read_answer};
pub use dead_air::{DEAD_AIR_KEEP_EACH_SIDE, DEAD_AIR_MIN_SILENCE, find_dead_air};
pub use mapping::{locate_quote, map_suggestions, normalise_words, suggestion_id};
pub use merge::{MIN_TRIMMED_DEAD_AIR, merge_suggestions};
pub use request::{
    ANSWER_SCHEMA, SYSTEM_PROMPT, build_request, utterance_by_number, utterance_number,
};
pub use runner::{
    ClaudeAuthMode, ClaudeConfig, ask_claude, child_environment, claude_status, find_claude,
};

/// The outcome of [`suggest_for_source`]. `set` is always usable: it holds the dead air,
/// plus Claude's suggestions when Claude answered. When Claude could not be used,
/// `claude_error` says why (send `suggestions_unavailable`), `set.claudeModel` is absent,
/// and `set` must not be read as "Claude found nothing".
#[derive(Debug, Clone, PartialEq)]
pub struct SuggestOutcome {
    pub set: SuggestionSet,
    pub claude_error: Option<AppError>,
}

/// The suggestion set with only the dead air found locally (the first `suggestions_ready`).
pub fn dead_air_set(transcript: &Transcript, frame_rate: Option<Rational>) -> SuggestionSet {
    SuggestionSet {
        schema_version: SUGGESTION_SET_SCHEMA_VERSION,
        source_id: transcript.source_id.clone(),
        claude_model: None,
        suggestions: find_dead_air(transcript, frame_rate),
    }
}

/// Produces the `SuggestionSet` for one source. First finds dead air and hands that set
/// to `on_dead_air` (so `jobs` can send the first `suggestions_ready` at once), then asks
/// Claude, maps the answer (dropping quotes that cannot be located), and merges it in with
/// overlaps resolved (see [`merge`]). `frame_rate` is the grid that ranges snap to (the
/// project's), or `None` to keep the transcript's own times. Claude is not called for an
/// incomplete transcript (`internal` error) or one with no words (no error, no Claude model).
pub fn suggest_for_source(
    transcript: &Transcript,
    frame_rate: Option<Rational>,
    cfg: &ClaudeConfig,
    cancel: &AtomicBool,
    on_dead_air: impl FnOnce(&SuggestionSet),
) -> SuggestOutcome {
    let dead = dead_air_set(transcript, frame_rate);
    on_dead_air(&dead);
    if !transcript.complete {
        return SuggestOutcome {
            set: dead,
            claude_error: Some(AppError::new(
                ErrorCode::Internal,
                "The transcript is not complete yet; Claude is asked once it is.",
            )),
        };
    }
    if !request::has_words(transcript) {
        return SuggestOutcome {
            set: dead,
            claude_error: None,
        };
    }
    match ask_claude(&build_request(transcript), cfg, cancel) {
        Ok(answer) => {
            let claude = map_suggestions(transcript, &answer.suggestions, frame_rate);
            let suggestions = merge_suggestions(dead.suggestions, claude);
            SuggestOutcome {
                set: SuggestionSet {
                    schema_version: SUGGESTION_SET_SCHEMA_VERSION,
                    source_id: transcript.source_id.clone(),
                    claude_model: Some(answer.model.unwrap_or_else(|| cfg.model.clone())),
                    suggestions,
                },
                claude_error: None,
            }
        }
        Err(e) => SuggestOutcome {
            set: dead,
            claude_error: Some(e),
        },
    }
}
