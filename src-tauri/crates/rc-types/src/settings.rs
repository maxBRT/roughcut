//! Settings (spec 3.4 "Settings"). Saved as `%APPDATA%\Roughcut\settings.json`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The `schemaVersion` this build writes for `settings.json`.
pub const SETTINGS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub schema_version: u32,
    pub export_folder: String,
    /// Only those changed from the defaults.
    pub key_bindings: Vec<KeyBinding>,
    pub speech_model: String,
    #[ts(inline)]
    pub speech_device: SpeechDevice,
    /// `'opus'` by default.
    pub claude_model: String,
    #[ts(inline)]
    pub claude_auth: ClaudeAuth,
    pub claude_code_version_tested: String,
    pub cache_limit_bytes: u64,
}

/// `Settings.speechDevice`: `'auto' | 'gpu' | 'cpu'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SpeechDevice {
    #[default]
    Auto,
    Gpu,
    Cpu,
}

/// `Settings.claudeAuth`: `'subscription' | 'api_key'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeAuth {
    #[default]
    Subscription,
    ApiKey,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum KeyContext {
    Everywhere,
    Home,
    Transcript,
    Timeline,
    Export,
}

/// One per row of spec 1.10, e.g. `'timeline.split'`.
pub type ActionId = String;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct KeyBinding {
    #[ts(type = "ActionId")]
    pub action: ActionId,
    pub context: KeyContext,
    pub chord: String,
}
