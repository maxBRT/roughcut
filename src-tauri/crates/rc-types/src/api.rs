//! Small result types of the interface-to-core commands (spec 3.5.4) that spec 3.4
//! does not name. Command arguments are passed by Tauri as named camelCase fields.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::project::Project;
use crate::runtime::SourceAssets;

/// Result of `open_project`: the project and a `SourceAssets` per source.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OpenedProject {
    pub project: Project,
    pub assets: Vec<SourceAssets>,
}

/// Result of `cache_usage`: bytes used, limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CacheUsage {
    pub used_bytes: u64,
    pub limit_bytes: u64,
}
