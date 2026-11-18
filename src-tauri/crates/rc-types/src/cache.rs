//! The cache, per source (spec 3.4 "The cache, per source"). Everything here can be deleted and rebuilt.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::basics::*;

/// The `schemaVersion` this build writes for a cached transcript.
pub const TRANSCRIPT_SCHEMA_VERSION: u32 = 1;
/// The `schemaVersion` this build writes for a cached suggestion set.
pub const SUGGESTION_SET_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub schema_version: u32,
    #[ts(type = "SourceId")]
    pub source_id: SourceId,
    /// Name and version of the speech model that made it.
    pub model: String,
    pub complete: bool,
    pub utterances: Vec<Utterance>,
}

/// One paragraph in the Transcript view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Utterance {
    /// The number Claude uses to refer to it.
    pub index: u32,
    #[ts(type = "Micros")]
    pub start: Micros,
    #[ts(type = "Micros")]
    pub end: Micros,
    pub tokens: Vec<Token>,
}

/// `WordToken | PauseToken | UnrecognisedToken`, tagged by `kind`.
///
/// The TypeScript for `Token` and the three token types is written by hand in
/// `ts_export.rs` so that each named type carries its own `kind`, exactly as spec 3.4 has it
/// (`interface WordToken extends TokenBase { kind: 'word'; text: string }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Token {
    Word(WordToken),
    /// The pause chip.
    Pause(PauseToken),
    /// Speech with no words.
    Unrecognised(UnrecognisedToken),
}

impl Token {
    /// The fields every token has.
    pub fn base(&self) -> TokenBase {
        match self {
            Token::Word(t) => TokenBase { start: t.start, end: t.end, cut_before: t.cut_before },
            Token::Pause(t) => TokenBase { start: t.start, end: t.end, cut_before: t.cut_before },
            Token::Unrecognised(t) => TokenBase { start: t.start, end: t.end, cut_before: t.cut_before },
        }
    }
    pub fn start(&self) -> Micros {
        self.base().start
    }
    pub fn end(&self) -> Micros {
        self.base().end
    }
    pub fn cut_before(&self) -> Micros {
        self.base().cut_before
    }
}

/// The fields shared by every token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TokenBase {
    #[ts(type = "Micros")]
    pub start: Micros,
    #[ts(type = "Micros")]
    pub end: Micros,
    /// Where a cut between the previous token and this one lands (spec 2.4.5).
    #[ts(type = "Micros")]
    pub cut_before: Micros,
}

/// `kind: 'word'` (in Rust the tag lives on `Token`; the TypeScript type includes it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WordToken {
    #[ts(type = "Micros")]
    pub start: Micros,
    #[ts(type = "Micros")]
    pub end: Micros,
    #[ts(type = "Micros")]
    pub cut_before: Micros,
    pub text: String,
}

/// `kind: 'pause'`: the pause chip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PauseToken {
    #[ts(type = "Micros")]
    pub start: Micros,
    #[ts(type = "Micros")]
    pub end: Micros,
    #[ts(type = "Micros")]
    pub cut_before: Micros,
}

/// `kind: 'unrecognised'`: speech with no words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UnrecognisedToken {
    #[ts(type = "Micros")]
    pub start: Micros,
    #[ts(type = "Micros")]
    pub end: Micros,
    #[ts(type = "Micros")]
    pub cut_before: Micros,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionSet {
    pub schema_version: u32,
    #[ts(type = "SourceId")]
    pub source_id: SourceId,
    /// Absent when only dead air was found.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub claude_model: Option<String>,
    pub suggestions: Vec<Suggestion>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    #[ts(type = "SuggestionId")]
    pub id: SuggestionId,
    #[ts(inline)]
    pub kind: SuggestionKind,
    #[ts(inline)]
    pub origin: SuggestionOrigin,
    /// What accepting it cuts.
    pub range: SourceRange,
    /// The one line shown under the block.
    pub reason: String,
    /// Retakes only: where the version to keep starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Micros")]
    pub kept_version_at: Option<Micros>,
}

/// `Suggestion.kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionKind {
    Retake,
    FalseStart,
    Aside,
    DeadAir,
}

/// `Suggestion.origin`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionOrigin {
    Claude,
    Local,
}

/// Followed in the same file by `count` loudness values. File layout: this header as compact
/// UTF-8 JSON ending in one line feed (0x0A), then exactly `count` bytes, each a u8 peak
/// loudness on a linear scale (0 = silence, 255 = full scale); value i covers
/// [i / valuesPerSecond, (i + 1) / valuesPerSecond) seconds. Served as
/// application/octet-stream. Written by `rc_types::write_waveform`, read by
/// `parseWaveform` (src/types/waveform.ts).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WaveformHeader {
    #[ts(type = "SourceId")]
    pub source_id: SourceId,
    pub values_per_second: u32,
    pub count: u64,
}
