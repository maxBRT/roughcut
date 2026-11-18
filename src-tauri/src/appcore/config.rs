//! Where the app keeps its files and finds its outside programs (spec 2.4.9, 2.7), each
//! overridable by an environment variable so tests and development use temporary folders and
//! the files under `.cache-dev`.
//!
//! | Variable | What | Default |
//! | --- | --- | --- |
//! | `ROUGHCUT_DATA_DIR` | projects (`projects/`) and `settings.json` | `%APPDATA%\Roughcut` |
//! | `ROUGHCUT_CACHE_DIR` | the per-source cache | `%LOCALAPPDATA%\Roughcut\cache` |
//! | `ROUGHCUT_FFMPEG_DIR` | folder with `ffmpeg.exe` and `ffprobe.exe` (read by rc-media) | next to the app, then `PATH` |
//! | `ROUGHCUT_TRANSCRIBER_DIR` | folder with `transcriber.exe` and its runtime DLLs | `%LOCALAPPDATA%\Roughcut\speech\runtime\gpu` when it holds the GPU runtime, there is an NVIDIA driver and the shipped folder has only the processor runtime; else `speech-runtime\` next to the app's exe |
//! | `ROUGHCUT_MODEL_DIR` | the speech model folder (`--model-dir`) | `%LOCALAPPDATA%\Roughcut\speech\models`, filled on first run |
//! | `ROUGHCUT_CLAUDE` | the `claude` program | `%USERPROFILE%\.local\bin\claude.exe`, then `PATH` |
//! | `ROUGHCUT_TEST_FREE_BYTES` | test hook: the free space the export assumes at every destination | unset: ask Windows |
//! | `ROUGHCUT_TEST_REVEAL_LOG` | test hook: a file that "Show in folder" appends its File Explorer argument to, instead of opening a window | unset: open File Explorer |

use std::path::{Path, PathBuf};

use rc_jobs::Limits;
use rc_speech::Package;

/// `ROUGHCUT_DATA_DIR`: projects and settings.
pub const DATA_DIR_ENV: &str = "ROUGHCUT_DATA_DIR";
/// `ROUGHCUT_CACHE_DIR`: the cache root.
pub const CACHE_DIR_ENV: &str = "ROUGHCUT_CACHE_DIR";
/// `ROUGHCUT_TRANSCRIBER_DIR`: the folder holding `transcriber.exe` and its runtime files.
pub const TRANSCRIBER_DIR_ENV: &str = "ROUGHCUT_TRANSCRIBER_DIR";
/// `ROUGHCUT_MODEL_DIR`: the speech model folder.
pub const MODEL_DIR_ENV: &str = "ROUGHCUT_MODEL_DIR";
/// `ROUGHCUT_CLAUDE`: the `claude` program.
pub const CLAUDE_ENV: &str = "ROUGHCUT_CLAUDE";
/// `ROUGHCUT_TEST_FREE_BYTES`: test hook, the free space in bytes the export assumes at every
/// destination instead of asking Windows (end-to-end tests of "not enough disk space").
pub const TEST_FREE_BYTES_ENV: &str = "ROUGHCUT_TEST_FREE_BYTES";
/// `ROUGHCUT_TEST_REVEAL_LOG`: test hook, the file "Show in folder" writes to instead of opening
/// File Explorer (read where the window would be opened, in `appcore`).
pub const TEST_REVEAL_LOG_ENV: &str = "ROUGHCUT_TEST_REVEAL_LOG";
/// `ROUGHCUT_FFMPEG_DIR` (read by rc-media itself; repeated here for the documentation).
pub const FFMPEG_DIR_ENV: &str = rc_media::FFMPEG_DIR_ENV;

/// The folder next to the app's exe that holds the transcriber and its runtime by default. The
/// app crate's build script fills it from `.cache-dev/speech/dist/<gpu|cpu>`; an installer
/// ships it. (Not `transcriber`: Cargo writes the transcriber binary under that name beside
/// the exe.)
pub const SPEECH_RUNTIME_DIR: &str = "speech-runtime";

/// The transcriber program's file name inside its folder.
pub const TRANSCRIBER_EXE: &str = if cfg!(windows) { "transcriber.exe" } else { "transcriber" };

/// Everything [`super::AppCore`] needs to know about locations and outside programs.
#[derive(Debug, Clone)]
pub struct AppConfig {
    /// Projects live in `<data_dir>/projects/<id>/project.json`; settings in `<data_dir>/settings.json`.
    pub data_dir: PathBuf,
    /// The cache root (`<cache_dir>/<source fingerprint>/...`).
    pub cache_dir: PathBuf,
    /// A folder holding ffmpeg and ffprobe; `None` searches as rc-media does
    /// (`ROUGHCUT_FFMPEG_DIR`, next to the app, `PATH`).
    pub ffmpeg_dir: Option<PathBuf>,
    /// The folder holding the transcriber program and its runtime libraries.
    pub transcriber_dir: PathBuf,
    /// The speech model folder passed as `--model-dir`.
    pub model_dir: PathBuf,
    /// The `claude` program; `None` finds the installed one when it is needed.
    pub claude_program: Option<PathBuf>,
    /// Added to the `claude` child's environment (used by tests to drive the stand-in).
    pub claude_extra_env: Vec<(String, String)>,
    /// How many jobs of each kind run at once.
    pub limits: Limits,
    /// Test hook: the packages the first-run download installs, in order, each with whether
    /// a transcription must wait for it. `None`: the model files of rc-speech's processor
    /// package (required) and, when the GPU can be used, of its GPU package (not waited for).
    #[doc(hidden)]
    pub model_packages: Option<Vec<(Package, bool)>>,
    /// Test hook (`ROUGHCUT_TEST_FREE_BYTES`): the free space the export plan and the export
    /// assume at every destination. `None` asks Windows.
    #[doc(hidden)]
    pub export_free_bytes: Option<u64>,
}

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// `ROUGHCUT_TEST_FREE_BYTES`'s value: a whole number of bytes; anything else is ignored.
fn parse_free_bytes(v: Option<&str>) -> Option<u64> {
    v.and_then(|v| v.trim().parse().ok())
}

/// `%APPDATA%\Roughcut` (the folder of rc-settings' and rc-project's defaults).
pub fn default_data_dir() -> PathBuf {
    rc_settings::default_settings_path().parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("Roughcut"))
}

/// The library whose presence in a transcriber folder means it holds the GPU runtime.
pub const CUDA_PROVIDER_DLL: &str = "onnxruntime_providers_cuda.dll";

/// The transcriber folder used when `ROUGHCUT_TRANSCRIBER_DIR` is not set: the GPU runtime
/// installed under `%LOCALAPPDATA%\Roughcut\speech\runtime\gpu` when the PC has an NVIDIA
/// driver and the folder shipped next to the exe (`speech-runtime\`) holds only the processor
/// runtime; otherwise the shipped folder. See [`choose_transcriber_dir`].
pub fn default_transcriber_dir() -> PathBuf {
    let shipped = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
        .join(SPEECH_RUNTIME_DIR);
    let installed_gpu = rc_speech::SpeechHome::default_location().map(|h| h.runtime_dir(rc_speech::PackageKind::Gpu));
    choose_transcriber_dir(shipped, installed_gpu.as_deref(), rc_speech::nvidia_gpu_present())
}

/// Picks the transcriber folder. The installed app ships the processor runtime (about 22 MB)
/// in `shipped`; the GPU runtime (about 2.3 GB, with its own copy of `transcriber.exe`) can sit
/// in `installed_gpu`. The shipped folder wins when it has the GPU runtime itself (a
/// development build) or when the GPU folder is incomplete or there is no NVIDIA driver.
pub fn choose_transcriber_dir(shipped: PathBuf, installed_gpu: Option<&Path>, gpu_present: bool) -> PathBuf {
    let has_gpu_runtime = |d: &Path| d.join(TRANSCRIBER_EXE).is_file() && d.join(CUDA_PROVIDER_DLL).is_file();
    if has_gpu_runtime(&shipped) || !gpu_present {
        return shipped;
    }
    match installed_gpu {
        Some(gpu) if has_gpu_runtime(gpu) => gpu.to_path_buf(),
        _ => shipped,
    }
}

/// `%LOCALAPPDATA%\Roughcut\speech\models`.
pub fn default_model_dir() -> PathBuf {
    rc_speech::SpeechHome::default_location()
        .map(|h| h.model_dir())
        .unwrap_or_else(|| std::env::temp_dir().join("Roughcut").join("speech").join("models"))
}

impl AppConfig {
    /// The real locations, each replaced by its environment variable when that is set.
    pub fn from_env() -> AppConfig {
        AppConfig {
            data_dir: env_dir(DATA_DIR_ENV).unwrap_or_else(default_data_dir),
            cache_dir: env_dir(CACHE_DIR_ENV).unwrap_or_else(rc_cache::default_cache_root),
            ffmpeg_dir: env_dir(FFMPEG_DIR_ENV),
            transcriber_dir: env_dir(TRANSCRIBER_DIR_ENV).unwrap_or_else(default_transcriber_dir),
            model_dir: env_dir(MODEL_DIR_ENV).unwrap_or_else(default_model_dir),
            claude_program: env_dir(CLAUDE_ENV),
            claude_extra_env: Vec::new(),
            limits: Limits::default(),
            model_packages: None,
            export_free_bytes: parse_free_bytes(std::env::var(TEST_FREE_BYTES_ENV).ok().as_deref()),
        }
    }

    /// The export options this configuration asks for (the free-space test hook).
    pub fn export_options(&self) -> rc_media::ExportOptions {
        rc_media::ExportOptions { free_bytes_override: self.export_free_bytes, ..rc_media::ExportOptions::default() }
    }

    /// A configuration rooted in one folder (data and cache below it), for tests; the
    /// programs and the model are found as [`AppConfig::from_env`] finds them.
    pub fn in_folder(root: &Path) -> AppConfig {
        AppConfig { data_dir: root.join("data"), cache_dir: root.join("cache"), ..AppConfig::from_env() }
    }

    /// `<data_dir>/projects`.
    pub fn projects_dir(&self) -> PathBuf {
        self.data_dir.join("projects")
    }

    /// `<data_dir>/settings.json`.
    pub fn settings_path(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    /// The transcriber program.
    pub fn transcriber_exe(&self) -> PathBuf {
        self.transcriber_dir.join(TRANSCRIBER_EXE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_follow_the_data_folder() {
        let c = AppConfig {
            data_dir: PathBuf::from("D:/d"),
            transcriber_dir: PathBuf::from("D:/t"),
            ..AppConfig::from_env()
        };
        assert_eq!(c.projects_dir(), PathBuf::from("D:/d").join("projects"));
        assert_eq!(c.settings_path(), PathBuf::from("D:/d").join("settings.json"));
        assert_eq!(c.transcriber_exe(), PathBuf::from("D:/t").join(TRANSCRIBER_EXE));
    }

    #[test]
    fn the_free_space_hook_reads_whole_bytes_and_reaches_the_export_options() {
        assert_eq!(parse_free_bytes(Some(" 1000000 ")), Some(1_000_000));
        assert_eq!(parse_free_bytes(Some("lots")), None);
        assert_eq!(parse_free_bytes(None), None);
        let c = AppConfig { export_free_bytes: Some(5), ..AppConfig::from_env() };
        assert_eq!(c.export_options().free_bytes_override, Some(5));
        let c = AppConfig { export_free_bytes: None, ..AppConfig::from_env() };
        assert_eq!(c.export_options().free_bytes_override, None);
    }

    #[test]
    fn defaults_match_spec_2_4_9() {
        // Under %APPDATA%\Roughcut and %LOCALAPPDATA%\Roughcut, as rc-settings and rc-cache say.
        assert!(default_data_dir().ends_with("Roughcut"));
        assert_eq!(default_data_dir().join("settings.json"), rc_settings::default_settings_path());
        assert!(default_model_dir().ends_with(Path::new("Roughcut").join("speech").join("models")));
        // `speech-runtime\` next to the exe, unless an installed GPU runtime is chosen over it.
        let d = default_transcriber_dir();
        assert!(d.ends_with(SPEECH_RUNTIME_DIR) || d.ends_with(Path::new("runtime").join("gpu")), "{}", d.display());
    }

    /// The packaged app ships only the processor runtime next to its exe; the GPU runtime the
    /// user has under `%LOCALAPPDATA%\Roughcut\speech\runtime\gpu` must be found and used.
    #[test]
    fn the_installed_gpu_runtime_is_chosen_over_a_processor_only_shipped_folder() {
        let root = std::env::temp_dir().join(format!("rc-choose-transcriber-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (shipped, gpu) = (root.join("app").join(SPEECH_RUNTIME_DIR), root.join("speech").join("runtime").join("gpu"));
        let put = |d: &Path, names: &[&str]| {
            std::fs::create_dir_all(d).unwrap();
            for n in names {
                std::fs::write(d.join(n), b"x").unwrap();
            }
        };
        put(&shipped, &[TRANSCRIBER_EXE, "onnxruntime.dll"]);
        // No GPU folder yet: the shipped one.
        assert_eq!(choose_transcriber_dir(shipped.clone(), Some(&gpu), true), shipped);
        // An incomplete GPU folder (no CUDA provider) is not used.
        put(&gpu, &[TRANSCRIBER_EXE]);
        assert_eq!(choose_transcriber_dir(shipped.clone(), Some(&gpu), true), shipped);
        // A complete one is, when there is an NVIDIA driver.
        put(&gpu, &[CUDA_PROVIDER_DLL]);
        assert_eq!(choose_transcriber_dir(shipped.clone(), Some(&gpu), true), gpu);
        assert_eq!(choose_transcriber_dir(shipped.clone(), Some(&gpu), false), shipped);
        assert_eq!(choose_transcriber_dir(shipped.clone(), None, true), shipped);
        // A shipped folder with the GPU runtime itself (a development build) always wins.
        put(&shipped, &[CUDA_PROVIDER_DLL]);
        assert_eq!(choose_transcriber_dir(shipped.clone(), Some(&gpu), true), shipped);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The default transcriber folder must be a folder the build can fill: Cargo writes the
    /// transcriber binary itself beside the exe, so a folder of the same stem could never exist.
    #[test]
    fn the_default_transcriber_folder_is_not_cargos_transcriber_output() {
        assert_ne!(SPEECH_RUNTIME_DIR, "transcriber");
        assert_ne!(Path::new(SPEECH_RUNTIME_DIR).with_extension("exe"), Path::new(TRANSCRIBER_EXE));
    }

    /// The app build put the deployed transcriber into the default folder next to the built
    /// exes (the test binary sits in `<target>/<profile>/deps`, or in
    /// `<target>/<profile>/build/<pkg>/<hash>/out` in newer Cargo layouts; the app in
    /// `<target>/<profile>`), so the built app finds it with no environment variable. Only
    /// checked when a deployed transcriber exists to be put there.
    #[test]
    fn the_build_puts_the_transcriber_next_to_the_app() {
        let dist = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join(".cache-dev/speech/dist");
        if !["gpu", "cpu"].iter().any(|v| dist.join(v).join(TRANSCRIBER_EXE).is_file()) {
            eprintln!("no deployed transcriber under {}; nothing to check", dist.display());
            return;
        }
        let exe = std::env::current_exe().unwrap();
        let profile = exe
            .ancestors()
            .find(|a| a.file_name().is_some_and(|n| n == "deps" || n == "build"))
            .and_then(Path::parent)
            .expect("the test runs from a Cargo target folder");
        assert!(profile.join(if cfg!(windows) { "roughcut.exe" } else { "roughcut" }).is_file(), "the app is in {}", profile.display());
        let program = profile.join(SPEECH_RUNTIME_DIR).join(TRANSCRIBER_EXE);
        assert!(program.is_file(), "{} is missing", program.display());
        assert!(profile.join(SPEECH_RUNTIME_DIR).join("sherpa-onnx-c-api.dll").is_file(), "its runtime is beside it");
        // The files are those of the deployed folder the build chose (GPU first), byte for
        // byte: the installer build once left the processor DLLs here (and, through hard
        // links, in dist/gpu).
        let deployed = ["gpu", "cpu"].iter().map(|v| dist.join(v)).find(|d| d.join(TRANSCRIBER_EXE).is_file()).unwrap();
        for name in [TRANSCRIBER_EXE, "sherpa-onnx-c-api.dll", "onnxruntime.dll", "onnxruntime_providers_shared.dll"] {
            let (a, b) = (deployed.join(name), profile.join(SPEECH_RUNTIME_DIR).join(name));
            assert!(std::fs::read(&a).unwrap() == std::fs::read(&b).unwrap(), "{} differs from {}", b.display(), a.display());
        }
    }
}
