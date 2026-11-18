//! Basics (spec 3.4 "Basics").

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Whole microseconds. A position in a source file unless the type says otherwise.
pub type Micros = i64;
/// A position in the edited sequence, not in a source.
pub type SequenceTime = Micros;

pub type ProjectId = String;
/// The source's fingerprint (spec 2.4.9).
pub type SourceId = String;
pub type ClipId = String;
pub type SuggestionId = String;
pub type JobId = String;

/// A frame rate, e.g. 30000 / 1001.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Rational {
    pub num: u32,
    pub den: u32,
}

/// A stretch of one source. `start` is included, `end` is not.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SourceRange {
    #[ts(type = "SourceId")]
    pub source_id: SourceId,
    #[ts(type = "Micros")]
    pub start: Micros,
    #[ts(type = "Micros")]
    pub end: Micros,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SourcePosition {
    #[ts(type = "SourceId")]
    pub source_id: SourceId,
    #[ts(type = "Micros")]
    pub at: Micros,
}

/// `8 | 10` in the spec. Serialized as the bare number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum BitDepth {
    #[default]
    Eight,
    Ten,
}

impl BitDepth {
    pub fn bits(self) -> u8 {
        match self {
            BitDepth::Eight => 8,
            BitDepth::Ten => 10,
        }
    }
}

impl Serialize for BitDepth {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u8(self.bits())
    }
}

impl<'de> Deserialize<'de> for BitDepth {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = f64::deserialize(d)?;
        if v == 8.0 {
            Ok(BitDepth::Eight)
        } else if v == 10.0 {
            Ok(BitDepth::Ten)
        } else {
            Err(serde::de::Error::custom(format!("bit depth must be 8 or 10, got {v}")))
        }
    }
}
