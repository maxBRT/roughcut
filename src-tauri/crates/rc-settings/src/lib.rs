//! Roughcut core module `settings` (settings file).
//!
//! Responsibility (spec 3.3): Reads and writes the settings file. Keeps an API key, if one is
//! ever used, in Windows Credential Manager (spec 3.8), never in the file.
//!
//! - [`SettingsStore`]: `settings.json` (spec 2.4.9: `%APPDATA%\Roughcut\settings.json`).
//!   Missing file or missing fields read as [`defaults`]; a field with a value this version
//!   does not understand reads as its default; a file from a newer Roughcut is refused.
//!   Writes are atomic and keep the previous file as `settings.json.bak`.
//! - [`ApiKeyStore`]: set, get and delete the Anthropic API key in Credential Manager.
//!
//! May use: nothing (spec 3.3, 3.6). Shared data types come from `rc-types`.

#[path = "../../rc-cache/src/atomic_file.rs"]
mod atomic_file;
mod platform;

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rc_types::{AppError, ClaudeAuth, ErrorCode, KeyBinding, Settings, SpeechDevice, SETTINGS_SCHEMA_VERSION};
use serde::Deserialize;
use serde_json::{Map, Value};

pub use platform::{videos_folder, ApiKeyStore, DEFAULT_API_KEY_TARGET};

/// The speech model used until the user picks another (spike result: Parakeet TDT 0.6B v2).
pub const DEFAULT_SPEECH_MODEL: &str = "parakeet-tdt-0.6b-v2";
/// The Claude model used by default (spec 3.4).
pub const DEFAULT_CLAUDE_MODEL: &str = "opus";
/// The Claude Code version the app was last checked against (spikes/claude/RESULT.md).
pub const DEFAULT_CLAUDE_CODE_VERSION_TESTED: &str = "2.1.323";
/// Default cache size limit: 50 GiB.
pub const DEFAULT_CACHE_LIMIT_BYTES: u64 = 50 * 1024 * 1024 * 1024;

/// `%APPDATA%\Roughcut\settings.json`, the real settings file of spec 2.4.9.
pub fn default_settings_path() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("AppData").join("Roaming")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("Roughcut").join("settings.json")
}

/// The settings used when there is no file: export to the user's Videos folder, Claude
/// model "opus" through the subscription, speech device chosen automatically.
pub fn defaults() -> Settings {
    Settings {
        schema_version: SETTINGS_SCHEMA_VERSION,
        export_folder: videos_folder().to_string_lossy().into_owned(),
        key_bindings: Vec::new(),
        speech_model: DEFAULT_SPEECH_MODEL.into(),
        speech_device: SpeechDevice::Auto,
        claude_model: DEFAULT_CLAUDE_MODEL.into(),
        claude_auth: ClaudeAuth::Subscription,
        claude_code_version_tested: DEFAULT_CLAUDE_CODE_VERSION_TESTED.into(),
        cache_limit_bytes: DEFAULT_CACHE_LIMIT_BYTES,
    }
}

/// A partial set of fields to change (spec 3.5.4 `update_settings`). Absent fields are left
/// as they are; unknown fields (an `apiKey`, say) are refused. `schemaVersion` cannot be set.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsChanges {
    pub export_folder: Option<String>,
    /// Replaces the whole list (only bindings changed from the defaults).
    pub key_bindings: Option<Vec<KeyBinding>>,
    pub speech_model: Option<String>,
    pub speech_device: Option<SpeechDevice>,
    pub claude_model: Option<String>,
    pub claude_auth: Option<ClaudeAuth>,
    pub claude_code_version_tested: Option<String>,
    pub cache_limit_bytes: Option<u64>,
}

impl SettingsChanges {
    /// Applies every present field to `s`.
    pub fn apply(self, s: &mut Settings) {
        if let Some(v) = self.export_folder {
            s.export_folder = v;
        }
        if let Some(v) = self.key_bindings {
            s.key_bindings = v;
        }
        if let Some(v) = self.speech_model {
            s.speech_model = v;
        }
        if let Some(v) = self.speech_device {
            s.speech_device = v;
        }
        if let Some(v) = self.claude_model {
            s.claude_model = v;
        }
        if let Some(v) = self.claude_auth {
            s.claude_auth = v;
        }
        if let Some(v) = self.claude_code_version_tested {
            s.claude_code_version_tested = v;
        }
        if let Some(v) = self.cache_limit_bytes {
            s.cache_limit_bytes = v;
        }
    }
}

/// The settings file at one path (the real one is [`default_settings_path`]; tests use a
/// temporary folder). Share one per path: it serialises updates.
#[derive(Debug)]
pub struct SettingsStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl SettingsStore {
    /// A store for the settings file at `path` (created on the first update).
    pub fn new(path: impl Into<PathBuf>) -> SettingsStore {
        SettingsStore { path: path.into(), lock: Mutex::new(()) }
    }

    /// The settings file's path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The current settings (spec 3.5.4 `get_settings`). Never writes.
    pub fn get(&self) -> Result<Settings, AppError> {
        let _guard = self.guard();
        read_settings(&self.path)
    }

    /// Applies `changes` and saves (spec 3.5.4 `update_settings`). Returns the new settings.
    pub fn update(&self, changes: SettingsChanges) -> Result<Settings, AppError> {
        self.update_with(|s| changes.apply(s))
    }

    /// Applies any change to the settings and saves, under the store's lock.
    pub fn update_with(&self, change: impl FnOnce(&mut Settings)) -> Result<Settings, AppError> {
        let _guard = self.guard();
        let mut s = read_settings(&self.path)?;
        change(&mut s);
        s.schema_version = SETTINGS_SCHEMA_VERSION;
        validate(&s)?;
        let bytes = serde_json::to_vec_pretty(&s).map_err(|e| AppError::internal(format!("Could not encode the settings: {e}")))?;
        atomic_file::write_atomic(&self.path, &bytes, true).map_err(|e| io_err("save the settings", &self.path, e))?;
        Ok(s)
    }

    fn guard(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|p| p.into_inner())
    }
}

fn validate(s: &Settings) -> Result<(), AppError> {
    for (field, value) in [("exportFolder", &s.export_folder), ("speechModel", &s.speech_model), ("claudeModel", &s.claude_model)] {
        if value.trim().is_empty() {
            return Err(AppError::internal(format!("The setting {field} cannot be empty.")));
        }
    }
    Ok(())
}

/// What one candidate file held.
enum Parsed {
    Ok(Settings),
    Newer(u64),
    Damaged,
}

fn parse(bytes: &[u8]) -> Parsed {
    let Ok(Value::Object(file)) = serde_json::from_slice::<Value>(bytes) else { return Parsed::Damaged };
    let version = match file.get("schemaVersion") {
        None | Some(Value::Null) => 0,
        Some(v) => match v.as_u64() {
            Some(v) => v,
            None => return Parsed::Damaged,
        },
    };
    if version > u64::from(SETTINGS_SCHEMA_VERSION) {
        return Parsed::Newer(version);
    }
    Parsed::Ok(merge_with_defaults(&file))
}

/// Starts from the defaults and takes each field of `file` that this version understands.
/// Unknown fields (and anything that looks like a secret) are dropped; a field whose value
/// does not fit keeps its default. Version 0 (no `schemaVersion`) files read the same way.
fn merge_with_defaults(file: &Map<String, Value>) -> Settings {
    let base = defaults();
    let Ok(Value::Object(mut merged)) = serde_json::to_value(&base) else { return base };
    for (key, value) in file {
        if key == "schemaVersion" || !merged.contains_key(key) {
            continue;
        }
        let mut candidate = merged.clone();
        candidate.insert(key.clone(), value.clone());
        if serde_json::from_value::<Settings>(Value::Object(candidate.clone())).is_ok() {
            merged = candidate;
        }
    }
    merged.insert("schemaVersion".into(), Value::from(SETTINGS_SCHEMA_VERSION));
    let mut s: Settings = serde_json::from_value(Value::Object(merged)).unwrap_or(base);
    if validate(&s).is_err() {
        let d = defaults();
        if s.export_folder.trim().is_empty() {
            s.export_folder = d.export_folder;
        }
        if s.speech_model.trim().is_empty() {
            s.speech_model = d.speech_model;
        }
        if s.claude_model.trim().is_empty() {
            s.claude_model = d.claude_model;
        }
    }
    s
}

/// Reads the settings: defaults when there is no file; the backup when the file is damaged
/// (defaults when both are); an error when a newer Roughcut wrote it.
fn read_settings(path: &Path) -> Result<Settings, AppError> {
    let backup = atomic_file::backup_path(path);
    for candidate in [path, backup.as_path()] {
        let Some(bytes) = atomic_file::read_optional(candidate).map_err(|e| io_err("read the settings", candidate, e))? else {
            continue;
        };
        match parse(&bytes) {
            Parsed::Ok(s) => return Ok(s),
            Parsed::Newer(v) => {
                return Err(AppError::internal("The settings were saved by a newer version of Roughcut.").with_detail(format!(
                    "{}: schemaVersion {v}, this version reads up to {SETTINGS_SCHEMA_VERSION}",
                    candidate.display()
                )));
            }
            Parsed::Damaged => continue,
        }
    }
    Ok(defaults())
}

fn io_err(what: &str, path: &Path, e: io::Error) -> AppError {
    let code = if e.kind() == io::ErrorKind::StorageFull { ErrorCode::DiskFull } else { ErrorCode::Internal };
    AppError::new(code, format!("Could not {what}.")).with_detail(format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests;
