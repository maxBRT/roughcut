//! Builds the single TypeScript file `src/types/generated.ts` from the Rust types.
//!
//! Everything goes in one file so that the spec's named aliases (`Micros`, `SourceId`, ...)
//! can be referenced by every declaration without imports. Large integers (`i64`, `u64`)
//! become `number`, never `bigint`.

use ts_rs::{Config, TS};

use crate::*;

const HEADER: &str = "\
// GENERATED FILE - DO NOT EDIT.
// Source: src-tauri/crates/rc-types (Rust). Regenerate with `npm run gen:types`.
// Types follow spec section 3.4; event names and payloads follow spec section 3.5.5.

/** Whole microseconds. A position in a source file unless the type says otherwise. */
export type Micros = number;
/** A position in the edited sequence, not in a source. */
export type SequenceTime = Micros;

export type ProjectId = string;
/** The source's fingerprint (spec 2.4.9). */
export type SourceId = string;
export type ClipId = string;
export type SuggestionId = string;
export type JobId = string;
/** One per row of spec 1.10, e.g. 'timeline.split'. */
export type ActionId = string;

export type BitDepth = 8 | 10;
export type PlaybackRate = 1 | 1.5 | 2;
";

/// `Token` and the three token types, written by hand so that each named type carries its
/// `kind` literal, exactly as spec 3.4 declares them. The Rust `Token` enum's serde output
/// (`{"kind": "word", "start": ..., ...}`) is the same JSON.
pub const TOKENS: &str = "/** `WordToken | PauseToken | UnrecognisedToken`, tagged by `kind`. */
export type Token = WordToken | PauseToken | UnrecognisedToken;

export type WordToken = TokenBase & { kind: \"word\"; text: string };

/** The pause chip. */
export type PauseToken = TokenBase & { kind: \"pause\" };

/** Speech with no words. */
export type UnrecognisedToken = TokenBase & { kind: \"unrecognised\" };

";

fn push<T: TS + ?Sized>(out: &mut String, cfg: &Config) {
    if let Some(docs) = T::docs() {
        out.push_str(docs.trim_end());
        out.push('\n');
    }
    out.push_str("export ");
    out.push_str(T::decl(cfg).trim());
    out.push_str("\n\n");
}

/// The full contents of `src/types/generated.ts`.
pub fn typescript() -> String {
    let cfg = Config::new().with_large_int("number");
    let mut out = String::from(HEADER);
    out.push('\n');

    macro_rules! all {
        ($($t:ty),* $(,)?) => { $( push::<$t>(&mut out, &cfg); )* };
    }

    // Basics
    out.push_str("// ---- Basics ----\n\n");
    all!(Rational, SourceRange, SourcePosition);

    // The project file
    out.push_str("// ---- The project file ----\n\n");
    all!(
        Project,
        SourceRef,
        MediaInfo,
        VideoInfo,
        AudioTrackInfo,
        EditDocument,
        EditState,
        Clip,
        SessionState,
        SessionView,
        ProjectSummary,
    );

    // The cache, per source
    out.push_str("// ---- The cache, per source ----\n\n");
    all!(
        Transcript,
        Utterance,
        TokenBase,
    );
    out.push_str(TOKENS);
    all!(
        SuggestionSet,
        Suggestion,
        SuggestionKind,
        SuggestionOrigin,
        WaveformHeader,
    );

    // Runtime only
    out.push_str("// ---- Runtime only (never saved) ----\n\n");
    all!(
        JobKind,
        JobState,
        JobStatus,
        SourceAssets,
        MediaItem,
        PlaybackSource,
        TranscriptProgress,
        SuggestionsProgress,
        ExportRequest,
        ExportPlan,
        OutputFormat,
        OutputCodec,
        ExportResult,
        ClaudeStatus,
        AppError,
        ErrorCode,
    );

    // Settings
    out.push_str("// ---- Settings ----\n\n");
    all!(Settings, SpeechDevice, ClaudeAuth, KeyContext, KeyBinding);

    // Command results (3.5.4)
    out.push_str("// ---- Command results (spec 3.5.4) ----\n\n");
    all!(OpenedProject, CacheUsage);

    // Events (3.5.5)
    out.push_str("// ---- Core-to-interface events (spec 3.5.5) ----\n\n");
    all!(TranscriptAppendedPayload, TranscriptCompletedPayload, SuggestionsUnavailablePayload);
    out.push_str(
        "export type JobUpdatedPayload = JobStatus;\n\
         export type SourceAssetsChangedPayload = SourceAssets;\n\
         export type SuggestionsReadyPayload = SuggestionSet;\n\
         export type ExportFinishedPayload = ExportResult;\n\n",
    );
    out.push_str("/** Event names, as emitted by the core. */\nexport const EVENTS = {\n");
    let payloads = [
        "JobUpdatedPayload",
        "SourceAssetsChangedPayload",
        "TranscriptAppendedPayload",
        "TranscriptCompletedPayload",
        "SuggestionsReadyPayload",
        "SuggestionsUnavailablePayload",
        "ExportFinishedPayload",
    ];
    for name in crate::events::ALL_EVENTS {
        out.push_str(&format!("  {}: \"{}\",\n", camel(name), name));
    }
    out.push_str("} as const;\n\n");
    out.push_str("export type EventName = (typeof EVENTS)[keyof typeof EVENTS];\n\n");
    out.push_str("/** The payload carried by each event. */\nexport interface EventPayloads {\n");
    for (name, payload) in crate::events::ALL_EVENTS.iter().zip(payloads) {
        out.push_str(&format!("  {name}: {payload};\n"));
    }
    out.push_str("}\n");
    out
}

fn camel(snake: &str) -> String {
    let mut out = String::new();
    let mut up = false;
    for c in snake.chars() {
        if c == '_' {
            up = true;
        } else if up {
            out.extend(c.to_uppercase());
            up = false;
        } else {
            out.push(c);
        }
    }
    out
}
