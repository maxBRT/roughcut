//! The few request and response shapes of the interface-to-core commands (spec 3.5.4)
//! that neither spec 3.4 nor `rc-types` names, plus the list of command names.
//!
//! `OpenedProject` (result of `open_project`) and `CacheUsage` (result of `cache_usage`)
//! already live in `rc_types::api`; only what is missing there is defined here.
//!
//! The TypeScript form is generated, with ts-rs exactly as `rc-types` does, into
//! `src/state/core/apiTypes.ts`. The test `api_types_ts_is_current` fails while that file
//! is out of date; regenerate it with
//! `RC_WRITE_API_TS=1 cargo test -p roughcut --lib api::types` (Bash) or
//! `$env:RC_WRITE_API_TS=1; cargo test -p roughcut --lib api::types` (PowerShell).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use rc_types::{ClaudeAuth, KeyBinding, Settings, SpeechDevice};

/// Argument of `update_settings`: the fields to change. Absent fields are left as they
/// are. `schemaVersion` is owned by the core and cannot be changed.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub export_folder: Option<String>,
    /// Replaces the whole list. Only bindings changed from the defaults.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key_bindings: Option<Vec<KeyBinding>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub speech_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub speech_device: Option<SpeechDevice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub claude_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, inline)]
    pub claude_auth: Option<ClaudeAuth>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub claude_code_version_tested: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cache_limit_bytes: Option<u64>,
}

impl SettingsPatch {
    /// `settings` with every present field of this patch applied.
    pub fn apply_to(&self, settings: &Settings) -> Settings {
        let mut s = settings.clone();
        if let Some(v) = &self.export_folder {
            s.export_folder = v.clone();
        }
        if let Some(v) = &self.key_bindings {
            s.key_bindings = v.clone();
        }
        if let Some(v) = &self.speech_model {
            s.speech_model = v.clone();
        }
        if let Some(v) = self.speech_device {
            s.speech_device = v;
        }
        if let Some(v) = &self.claude_model {
            s.claude_model = v.clone();
        }
        if let Some(v) = self.claude_auth {
            s.claude_auth = v;
        }
        if let Some(v) = &self.claude_code_version_tested {
            s.claude_code_version_tested = v.clone();
        }
        if let Some(v) = self.cache_limit_bytes {
            s.cache_limit_bytes = v;
        }
        s
    }
}

/// Every command of spec 3.5.4, in table order, with its argument names as the
/// interface sends them (Tauri maps camelCase keys to the snake_case Rust parameters).
/// Must match `super::handler()`; the test below checks the count.
pub const COMMANDS: [(&str, &[&str]); 21] = [
    ("list_projects", &[]),
    ("create_project", &["paths"]),
    ("open_project", &["projectId"]),
    ("save_edit", &["projectId", "edit", "session"]),
    ("rename_project", &["projectId", "name"]),
    ("remove_project", &["projectId"]),
    ("add_sources", &["projectId", "paths"]),
    ("locate_source", &["projectId", "sourceId", "newPath"]),
    ("get_transcript", &["sourceId"]),
    ("get_suggestions", &["sourceId"]),
    ("retry_suggestions", &["sourceId"]),
    ("list_jobs", &[]),
    ("cancel_job", &["jobId"]),
    ("plan_export", &["request"]),
    ("start_export", &["request"]),
    ("reveal_file", &["path"]),
    ("claude_status", &[]),
    ("get_settings", &[]),
    ("update_settings", &["changes"]),
    ("cache_usage", &[]),
    ("clear_cache", &[]),
];

const HEADER: &str = "\
// GENERATED FILE - DO NOT EDIT.
// Source: src-tauri/src/api/types.rs (Rust). Regenerate with
//   RC_WRITE_API_TS=1 cargo test -p roughcut --lib api::types
// Command request/response shapes of spec 3.5.4 that spec 3.4 does not name.
// (OpenedProject and CacheUsage are in src/types, generated from rc-types.)

import type { KeyBinding } from \"../../types\";
";

/// The full contents of `src/state/core/apiTypes.ts`.
pub fn typescript() -> String {
    let cfg = ts_rs::Config::new().with_large_int("number");
    let mut out = String::from(HEADER);
    out.push('\n');
    if let Some(docs) = SettingsPatch::docs() {
        out.push_str(docs.trim_end());
        out.push('\n');
    }
    out.push_str("export ");
    out.push_str(SettingsPatch::decl(&cfg).trim());
    out.push_str("\n\n");

    out.push_str(
        "/** Every core command of spec 3.5.4 and the argument names it takes, as sent to `invoke`. */\n\
         export const COMMANDS = {\n",
    );
    for (name, args) in COMMANDS {
        let list: Vec<String> = args.iter().map(|a| format!("\"{a}\"")).collect();
        out.push_str(&format!("  {name}: [{}],\n", list.join(", ")));
    }
    out.push_str("} as const;\n\n");
    out.push_str("export type CommandName = keyof typeof COMMANDS;\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn ts_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/state/core/apiTypes.ts")
    }

    #[test]
    fn api_types_ts_is_current() {
        let want = typescript();
        let path = ts_path();
        if std::env::var_os("RC_WRITE_API_TS").is_some() {
            std::fs::write(&path, &want).expect("write apiTypes.ts");
        }
        let have = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .replace("\r\n", "\n");
        assert_eq!(
            have, want,
            "src/state/core/apiTypes.ts is out of date: run RC_WRITE_API_TS=1 cargo test -p roughcut --lib api::types"
        );
        assert!(!want.contains("bigint"));
    }

    #[test]
    fn command_names_are_unique_snake_case() {
        let mut names: Vec<&str> = COMMANDS.iter().map(|(n, _)| *n).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), COMMANDS.len());
        assert!(names.iter().all(|n| n.chars().all(|c| c.is_ascii_lowercase() || c == '_')));
    }

    #[test]
    fn settings_patch_applies_only_present_fields() {
        let base = Settings {
            schema_version: 1,
            export_folder: "a".into(),
            key_bindings: vec![],
            speech_model: "m".into(),
            speech_device: SpeechDevice::Auto,
            claude_model: "opus".into(),
            claude_auth: ClaudeAuth::Subscription,
            claude_code_version_tested: "1".into(),
            cache_limit_bytes: 10,
        };
        let patch: SettingsPatch =
            serde_json::from_str(r#"{"claudeModel":"sonnet","cacheLimitBytes":20}"#).unwrap();
        let next = patch.apply_to(&base);
        assert_eq!(next.claude_model, "sonnet");
        assert_eq!(next.cache_limit_bytes, 20);
        assert_eq!(next.export_folder, "a");
        assert_eq!(serde_json::to_string(&SettingsPatch::default()).unwrap(), "{}");
    }
}
