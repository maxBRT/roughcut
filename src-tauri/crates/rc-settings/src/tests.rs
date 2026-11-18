use super::*;
use rc_types::KeyContext;
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

static N: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> TempDir {
        let n = N.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("rc-settings-{tag}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn missing_file_reads_as_defaults_and_is_not_written() {
    let dir = TempDir::new("defaults");
    let store = SettingsStore::new(dir.0.join("Roughcut").join("settings.json"));
    let s = store.get().unwrap();
    assert_eq!(s, defaults());
    assert_eq!(s.schema_version, SETTINGS_SCHEMA_VERSION);
    assert_eq!(s.claude_model, "opus");
    assert_eq!(s.claude_auth, ClaudeAuth::Subscription);
    assert_eq!(s.speech_device, SpeechDevice::Auto);
    assert!(s.key_bindings.is_empty());
    assert!(s.cache_limit_bytes > 0);
    assert!(Path::new(&s.export_folder).is_absolute(), "{}", s.export_folder);
    assert!(!store.path().exists());
}

#[test]
fn export_folder_defaults_to_the_users_videos_folder() {
    let v = videos_folder();
    assert!(v.is_absolute(), "{v:?}");
    assert_eq!(defaults().export_folder, v.to_string_lossy());
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        // Normally %USERPROFILE%\Videos; it may have been moved, but it is never empty.
        let usual = PathBuf::from(profile).join("Videos");
        if usual.is_dir() && cfg!(windows) {
            assert!(v.is_dir() || v == usual, "{v:?}");
        }
    }
}

#[test]
fn update_changes_only_given_fields_and_persists() {
    let dir = TempDir::new("update");
    let path = dir.0.join("settings.json");
    let store = SettingsStore::new(&path);
    let changes: SettingsChanges = serde_json::from_str(r#"{ "exportFolder": "D:\\Exports", "cacheLimitBytes": 1073741824 }"#).unwrap();
    let s = store.update(changes).unwrap();
    assert_eq!(s.export_folder, "D:\\Exports");
    assert_eq!(s.cache_limit_bytes, 1 << 30);
    assert_eq!(s.claude_model, "opus");

    let s2 = store
        .update(SettingsChanges {
            key_bindings: Some(vec![KeyBinding { action: "timeline.split".into(), context: KeyContext::Timeline, chord: "S".into() }]),
            claude_auth: Some(ClaudeAuth::ApiKey),
            speech_device: Some(SpeechDevice::Gpu),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(s2.export_folder, "D:\\Exports", "earlier change kept");
    assert_eq!(s2.key_bindings.len(), 1);
    assert_eq!(s2.claude_auth, ClaudeAuth::ApiKey);

    // A fresh store (a restart) reads the same.
    assert_eq!(SettingsStore::new(&path).get().unwrap(), s2);
    // The file is camelCase JSON in the shape of rc_types::Settings.
    let on_disk: Settings = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(on_disk, s2);
    // The previous file stays readable beside it.
    let previous: Settings = serde_json::from_slice(&fs::read(atomic_file::backup_path(&path)).unwrap()).unwrap();
    assert_eq!(previous, s);

    // Bad changes are refused and nothing is written.
    assert!(store.update(SettingsChanges { claude_model: Some("  ".into()), ..Default::default() }).is_err());
    assert!(serde_json::from_str::<SettingsChanges>(r#"{ "apiKey": "sk-ant-secret" }"#).is_err());
    assert!(serde_json::from_str::<SettingsChanges>(r#"{ "schemaVersion": 9 }"#).is_err());
    assert_eq!(store.get().unwrap(), s2);
}

#[test]
fn older_or_partial_files_are_filled_from_defaults() {
    let dir = TempDir::new("partial");
    let path = dir.0.join("settings.json");
    // No schemaVersion (version 0), a missing field, a value this version does not know,
    // and a secret someone put there by hand.
    fs::write(
        &path,
        r#"{ "exportFolder": "E:\\Out", "claudeModel": "sonnet", "speechDevice": "tpu", "apiKey": "sk-ant-oops", "cacheLimitBytes": -5 }"#,
    )
    .unwrap();
    let store = SettingsStore::new(&path);
    let s = store.get().unwrap();
    assert_eq!(s.schema_version, SETTINGS_SCHEMA_VERSION);
    assert_eq!(s.export_folder, "E:\\Out");
    assert_eq!(s.claude_model, "sonnet");
    assert_eq!(s.speech_device, SpeechDevice::Auto, "unknown value -> default");
    assert_eq!(s.cache_limit_bytes, DEFAULT_CACHE_LIMIT_BYTES, "invalid value -> default");
    assert_eq!(s.speech_model, DEFAULT_SPEECH_MODEL, "missing field -> default");
    // Saving writes the current version and drops what it does not know, the key included.
    store.update(SettingsChanges::default()).unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert!(!text.contains("sk-ant-oops"), "{text}");
    assert!(text.contains(&format!("\"schemaVersion\": {SETTINGS_SCHEMA_VERSION}")), "{text}");
}

#[test]
fn newer_files_are_refused_and_left_alone() {
    let dir = TempDir::new("newer");
    let path = dir.0.join("settings.json");
    let newer = format!(r#"{{ "schemaVersion": {}, "exportFolder": "X:\\" }}"#, SETTINGS_SCHEMA_VERSION + 1);
    fs::write(&path, &newer).unwrap();
    let store = SettingsStore::new(&path);
    assert!(store.get().unwrap_err().message.contains("newer"));
    assert!(store.update(SettingsChanges::default()).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), newer);
}

#[test]
fn interrupted_or_damaged_writes_keep_the_previous_settings() {
    use atomic_file::{write_atomic_with_hook, Step};
    let dir = TempDir::new("interrupt");
    let path = dir.0.join("settings.json");
    let store = SettingsStore::new(&path);
    store.update(SettingsChanges { export_folder: Some("D:\\One".into()), ..Default::default() }).unwrap();
    let first = store.update(SettingsChanges { claude_model: Some("sonnet".into()), ..Default::default() }).unwrap();

    let mut next = first.clone();
    next.export_folder = "D:\\Two".into();
    let bytes = serde_json::to_vec_pretty(&next).unwrap();
    for step in [Step::TempCreated, Step::TempHalfWritten, Step::TempWritten, Step::TempSynced, Step::BackupKept] {
        let r = write_atomic_with_hook(&path, &bytes, true, &mut |s| if s == step { Err(io::Error::other("crash")) } else { Ok(()) });
        assert!(r.is_err());
        assert_eq!(store.get().unwrap(), first, "crash at {step:?}");
    }

    // A crash between the two renames left only the backup; the next save writes the file.
    assert!(!path.exists());
    let third = store.update(SettingsChanges { export_folder: Some("D:\\Three".into()), ..Default::default() }).unwrap();
    assert_eq!(store.get().unwrap(), third);

    // A torn file falls back to the version before.
    let good = fs::read(&path).unwrap();
    fs::write(&path, &good[..good.len() / 3]).unwrap();
    let recovered = store.get().unwrap();
    assert_eq!(recovered.export_folder, "D:\\One");
    // Both damaged: defaults, not an error.
    fs::write(atomic_file::backup_path(&path), b"\x00\x00").unwrap();
    assert_eq!(store.get().unwrap(), defaults());
}

#[test]
fn api_key_lives_in_credential_manager_and_never_in_the_file() {
    if !cfg!(windows) {
        return;
    }
    let dir = TempDir::new("apikey");
    let path = dir.0.join("settings.json");
    let target = format!("Roughcut-test/api-key-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed));
    let keys = ApiKeyStore::new(&target);
    assert_eq!(keys.target(), target);
    assert_eq!(keys.get().unwrap(), None);
    keys.delete().unwrap();

    let secret = "sk-ant-api03-TEST-ONLY-not-a-real-key-0123456789";
    keys.set(&format!("  {secret}\n")).unwrap();
    assert_eq!(keys.get().unwrap().as_deref(), Some(secret));
    keys.set("sk-ant-api03-SECOND").unwrap();
    assert_eq!(keys.get().unwrap().as_deref(), Some("sk-ant-api03-SECOND"));
    assert!(keys.set("   ").is_err());
    assert!(keys.set(&"x".repeat(3000)).is_err());

    let store = SettingsStore::new(&path);
    store.update(SettingsChanges { claude_auth: Some(ClaudeAuth::ApiKey), ..Default::default() }).unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert!(!text.contains("sk-ant"), "{text}");

    keys.delete().unwrap();
    assert_eq!(keys.get().unwrap(), None);
    keys.delete().unwrap();
    assert_eq!(ApiKeyStore::default().target(), DEFAULT_API_KEY_TARGET);
}

#[test]
fn default_path_is_under_app_data() {
    let p = default_settings_path();
    assert!(p.ends_with(Path::new("Roughcut").join("settings.json")));
    if let Some(app) = std::env::var_os("APPDATA") {
        assert!(p.starts_with(app));
    }
}
