//! The project file (spec 3.4 "The project file"). Saved as `project.json`.
//! The core owns everything except `edit` and `session`, which belong to the interface.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::basics::*;
use crate::runtime::ExportResult;

/// The `schemaVersion` this build writes for `project.json`.
pub const PROJECT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub schema_version: u32,
    #[ts(type = "ProjectId")]
    pub id: ProjectId,
    pub name: String,
    /// ISO 8601
    pub created_at: String,
    pub updated_at: String,
    /// The sequence's frame grid, taken from the first source. Frame k starts at
    /// round_half_up(k * 1e6 * den / num) microseconds: see `rc_types::grid` and its twin
    /// src/types/grid.ts, which every module uses to snap times.
    pub frame_rate: Rational,
    pub sources: Vec<SourceRef>,
    pub edit: EditDocument,
    pub session: SessionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_export: Option<ExportResult>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    #[ts(type = "SourceId")]
    pub id: SourceId,
    /// Last known location of the file.
    pub path: String,
    pub added_at: String,
    /// Copy of the probe result, so a project opens even when the file is missing.
    pub media: MediaInfo,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    #[ts(type = "Micros")]
    pub duration: Micros,
    pub container: String,
    pub video: VideoInfo,
    pub audio_tracks: Vec<AudioTrackInfo>,
    /// Which audio track the transcript is made from.
    pub speech_track: u32,
    /// Whether the player can use the original before the proxy exists.
    pub direct_playable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    /// 'h264', 'hevc', ...
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: Rational,
    pub variable_frame_rate: bool,
    #[ts(type = "BitDepth")]
    pub bit_depth: BitDepth,
    pub hdr: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrackInfo {
    pub index: u32,
    pub codec: String,
    pub channels: u32,
    pub sample_rate: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EditDocument {
    pub current: EditState,
    /// Oldest first.
    pub undo: Vec<EditState>,
    pub redo: Vec<EditState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EditState {
    /// The sequence, in playing order.
    pub clips: Vec<Clip>,
    /// Suggestions you chose to keep.
    pub dismissed: Vec<SourceRange>,
}

/// A kept stretch of one source: `start` is included, `end` is not. Never empty, and both
/// edges on the sequence's frame grid (spec 3.4 rule 1).
///
/// The one clip per source that `create_project` makes is `[0, floorToFrame(media.duration,
/// frameRate))`: the duration floored to the grid (`first_clip_end`), so it never runs past
/// the end of the file. A source shorter than one frame gets no clip.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    #[ts(type = "ClipId")]
    pub id: ClipId,
    #[ts(type = "SourceId")]
    pub source_id: SourceId,
    #[ts(type = "Micros")]
    pub start: Micros,
    #[ts(type = "Micros")]
    pub end: Micros,
}

/// Where you were, restored on reopening.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    #[ts(inline)]
    pub view: SessionView,
    pub playhead: Option<SourcePosition>,
    #[ts(type = "PlaybackRate")]
    pub playback_rate: PlaybackRate,
    pub cut_text_hidden: bool,
}

impl Default for SessionState {
    fn default() -> Self {
        SessionState {
            view: SessionView::Transcript,
            playhead: None,
            playback_rate: PlaybackRate::X1,
            cut_text_hidden: false,
        }
    }
}

/// `SessionState.view`: `'transcript' | 'timeline'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SessionView {
    #[default]
    Transcript,
    Timeline,
}

/// `1 | 1.5 | 2` in the spec. Serialized as the bare number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum PlaybackRate {
    #[default]
    X1,
    X1_5,
    X2,
}

impl PlaybackRate {
    pub fn as_f64(self) -> f64 {
        match self {
            PlaybackRate::X1 => 1.0,
            PlaybackRate::X1_5 => 1.5,
            PlaybackRate::X2 => 2.0,
        }
    }
}

impl Serialize for PlaybackRate {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            PlaybackRate::X1 => s.serialize_u8(1),
            PlaybackRate::X1_5 => s.serialize_f64(1.5),
            PlaybackRate::X2 => s.serialize_u8(2),
        }
    }
}

impl<'de> Deserialize<'de> for PlaybackRate {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = f64::deserialize(d)?;
        if v == 1.0 {
            Ok(PlaybackRate::X1)
        } else if v == 1.5 {
            Ok(PlaybackRate::X1_5)
        } else if v == 2.0 {
            Ok(PlaybackRate::X2)
        } else {
            Err(serde::de::Error::custom(format!("playback rate must be 1, 1.5 or 2, got {v}")))
        }
    }
}

/// One row of the Home screen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    #[ts(type = "ProjectId")]
    pub id: ProjectId,
    pub name: String,
    #[ts(type = "Micros")]
    pub raw_duration: Micros,
    #[ts(type = "Micros")]
    pub kept_duration: Micros,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_exported_at: Option<String>,
    pub missing_sources: u32,
}
