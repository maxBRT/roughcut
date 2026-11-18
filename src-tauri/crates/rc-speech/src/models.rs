//! The speech model and its runtime: where they live, whether they are installed, and
//! downloading them on first run with progress, resume and verification (spec 2.4.9).
//!
//! Two packages, with URLs, sizes and SHA-256 hashes taken from the speech experiment
//! (`spikes/speech/RESULT.md` section 4.2, hashes measured on the downloaded files):
//! - the processor package: Parakeet TDT 0.6B v2 int8, the Silero voice detector and the
//!   CPU sherpa-onnx runtime (about 0.5 GB to download). Always installed first.
//! - the GPU package: the fp32 model plus the CUDA sherpa-onnx runtime and the NVIDIA CUDA,
//!   cuBLAS and cuDNN libraries (about 5.9 GB to download). Installed when an NVIDIA GPU is present.
//!
//! Layout under the speech folder (`%LOCALAPPDATA%\Roughcut\speech`):
//! - `models/` is the `--model-dir`, laid out as the transcriber program reads it:
//!   `models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/` (`tokens.txt`, `encoder.int8.onnx`,
//!   `decoder.int8.onnx`, `joiner.int8.onnx`; processor) and
//!   `models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2/` (`tokens.txt`, `encoder.onnx`,
//!   `encoder.weights`, `decoder.onnx`, `joiner.onnx`; GPU).
//! - `models/silero_vad.onnx`: the voice detector, also passed as `--vad-model`.
//! - `runtime/cpu/` and `runtime/gpu/`: the runtime libraries, plus a copy of the transcriber
//!   program. The program must run from the folder of its libraries: Windows 11 has its own
//!   `onnxruntime.dll` in System32, which the loader prefers over anything on PATH.
//! - `downloads/`: partial downloads (`*.part`), kept for resuming.

use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use rc_types::{AppError, ErrorCode, SpeechDevice};
use sha2::{Digest, Sha256};

use crate::client::{CancelToken, TranscriberCommand};

/// The speech model family both packages hold (the fp32 variant's folder name).
pub const MODEL_NAME: &str = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2";
/// Folder of the int8 variant (processor package).
const INT8_DIR: &str = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";
/// The Visual C++ runtime the CUDA build of onnxruntime imports; without it the GPU runtime
/// cannot start at all. Looked for next to the program and in System32.
const VC_RUNTIME: [&str; 4] = ["msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

/// Which of the two packages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PackageKind {
    /// int8 model, voice detector and the CPU runtime.
    Cpu,
    /// fp32 model, CUDA runtime and NVIDIA libraries.
    Gpu,
}

/// One file taken out of an archive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    /// Path inside the archive, with `/` separators.
    pub path_in_archive: String,
    /// Destination relative to the speech folder, with `/` separators.
    pub dest: String,
    /// Exact size in bytes.
    pub size: u64,
}

/// What to do with a downloaded file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unpack {
    /// Keep it as is, at `dest` (relative to the speech folder).
    File { dest: String },
    /// A `.tar.bz2` archive; take these members.
    TarBz2 { members: Vec<Member> },
    /// A `.zip` archive; take these members.
    Zip { members: Vec<Member> },
}

/// One file to download.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Download {
    pub url: String,
    /// Name used in the downloads folder.
    pub file_name: String,
    /// Exact size in bytes.
    pub size: u64,
    /// Lower-case hex SHA-256 of the whole file.
    pub sha256: String,
    pub unpack: Unpack,
}

impl Download {
    /// Every installed file this download produces, with its size.
    fn outputs(&self) -> Vec<(String, u64)> {
        match &self.unpack {
            Unpack::File { dest } => vec![(dest.clone(), self.size)],
            Unpack::TarBz2 { members } | Unpack::Zip { members } => {
                members.iter().map(|m| (m.dest.clone(), m.size)).collect()
            }
        }
    }
}

/// A set of downloads installed together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Package {
    pub kind: PackageKind,
    pub downloads: Vec<Download>,
}

impl Package {
    /// Total download size in bytes.
    pub fn total_bytes(&self) -> u64 {
        self.downloads.iter().map(|d| d.size).sum()
    }
}

/// What an install is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadPhase {
    Downloading,
    Verifying,
    Unpacking,
}

/// Progress of [`SpeechHome::install`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadProgress {
    pub package: PackageKind,
    pub phase: DownloadPhase,
    /// The file being worked on.
    pub file: String,
    /// Bytes downloaded so far, counting what earlier attempts left, out of `total_bytes`
    /// (the size of everything this install has to fetch).
    pub done_bytes: u64,
    pub total_bytes: u64,
}

/// How to start the transcriber with what is installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    pub command: TranscriberCommand,
    /// True when the GPU runtime is used.
    pub uses_gpu_runtime: bool,
    /// True when an NVIDIA GPU is present and wanted but the GPU package is not installed yet.
    pub gpu_package_needed: bool,
    /// Why the installed GPU package cannot be used on this PC (the processor is used).
    pub gpu_unusable: Option<String>,
}

const RUNTIME_CPU: &str = "runtime/cpu";
const RUNTIME_GPU: &str = "runtime/gpu";

fn model_file(variant: &str, name: &str) -> String {
    format!("models/{variant}/{name}")
}

fn member(path_in_archive: &str, dest: String, size: u64) -> Member {
    Member { path_in_archive: path_in_archive.to_string(), dest, size }
}

/// The processor package: always installed first, so transcription can start.
pub fn cpu_package() -> Package {
    const SHERPA: &str = "sherpa-onnx-v2.0.1-win-x64-shared-MT-Release-no-tts";
    const MODEL: &str = INT8_DIR;
    let lib = |n: &str, size| member(&format!("{SHERPA}/lib/{n}"), format!("{RUNTIME_CPU}/{n}"), size);
    let m = |n: &str, size| member(&format!("{MODEL}/{n}"), model_file(INT8_DIR, n), size);
    Package {
        kind: PackageKind::Cpu,
        downloads: vec![
            Download {
                url: format!("https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/{SHERPA}.tar.bz2"),
                file_name: format!("{SHERPA}.tar.bz2"),
                size: 25_567_228,
                sha256: "a644dfe2f7944afec9a356d2557c0452380f20ffcf2f8c704653cfce37558596".into(),
                unpack: Unpack::TarBz2 {
                    members: vec![
                        lib("onnxruntime.dll", 17_799_168),
                        lib("onnxruntime_providers_shared.dll", 104_960),
                        lib("sherpa-onnx-c-api.dll", 3_667_968),
                    ],
                },
            },
            Download {
                url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx".into(),
                file_name: "silero_vad.onnx".into(),
                size: 643_854,
                sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6".into(),
                unpack: Unpack::File { dest: "models/silero_vad.onnx".into() },
            },
            Download {
                url: format!("https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/{MODEL}.tar.bz2"),
                file_name: format!("{MODEL}.tar.bz2"),
                size: 482_440_461,
                sha256: "6fc4426b54aa549a0019b8a75b8dea59164e71790a37ac56a045ad57f915f714".into(),
                unpack: Unpack::TarBz2 {
                    members: vec![
                        m("tokens.txt", 9_384),
                        m("encoder.int8.onnx", 652_282_309),
                        m("decoder.int8.onnx", 7_257_753),
                        m("joiner.int8.onnx", 1_739_080),
                    ],
                },
            },
        ],
    }
}

/// The GPU package: fetched when an NVIDIA GPU is present, after the processor package.
pub fn gpu_package() -> Package {
    const SHERPA: &str = "sherpa-onnx-v2.0.1-cuda-12.x-cudnn-9.x-onnxruntime1.28.2-win-x64-cuda";
    const CUDART: &str = "cuda_cudart-windows-x86_64-12.9.79-archive";
    const CUBLAS: &str = "libcublas-windows-x86_64-12.9.2.10-archive";
    const CUDNN: &str = "cudnn-windows-x86_64-9.28.1.4_cuda12-archive";
    const HF: &str = "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2/resolve/main";
    let gpu = |n: &str| format!("{RUNTIME_GPU}/{n}");
    let fp32 = |n: &str, size: u64, sha: &str| Download {
        url: format!("{HF}/{n}"),
        file_name: format!("{MODEL_NAME}-{n}"),
        size,
        sha256: sha.into(),
        unpack: Unpack::File { dest: model_file(MODEL_NAME, n) },
    };
    let cudnn = |n: &str, size| member(&format!("{CUDNN}/bin/x64/{n}"), gpu(n), size);
    Package {
        kind: PackageKind::Gpu,
        downloads: vec![
            Download {
                url: format!("https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/{SHERPA}.tar.bz2"),
                file_name: format!("{SHERPA}.tar.bz2"),
                size: 597_231_017,
                sha256: "cd983fa95431a8a08555b15005e1effd0b771f161d30f7f3bd52d518da48f6b6".into(),
                unpack: Unpack::TarBz2 {
                    members: [
                        ("onnxruntime.dll", 16_283_448),
                        ("onnxruntime_providers_cuda.dll", 496_742_712),
                        ("onnxruntime_providers_shared.dll", 21_816),
                        ("sherpa-onnx-c-api.dll", 4_294_656),
                    ]
                    .into_iter()
                    .map(|(n, s)| member(&format!("{SHERPA}/lib/{n}"), gpu(n), s))
                    .collect(),
                },
            },
            Download {
                url: format!(
                    "https://developer.download.nvidia.com/compute/cuda/redist/cuda_cudart/windows-x86_64/{CUDART}.zip"
                ),
                file_name: format!("{CUDART}.zip"),
                size: 3_521_238,
                sha256: "179e9c43b0735ffe67207b3da556eb5a0c50f3047961882b7657d3b822d34ef8".into(),
                unpack: Unpack::Zip {
                    members: vec![member(&format!("{CUDART}/bin/cudart64_12.dll"), gpu("cudart64_12.dll"), 583_680)],
                },
            },
            Download {
                url: format!(
                    "https://developer.download.nvidia.com/compute/cuda/redist/libcublas/windows-x86_64/{CUBLAS}.zip"
                ),
                file_name: format!("{CUBLAS}.zip"),
                size: 549_731_131,
                sha256: "62782c354e1536118caab8fe5fd295ac5fd9076e4814aba0bdaf032fe2b833ae".into(),
                unpack: Unpack::Zip {
                    members: vec![
                        member(&format!("{CUBLAS}/bin/cublas64_12.dll"), gpu("cublas64_12.dll"), 102_518_272),
                        member(&format!("{CUBLAS}/bin/cublasLt64_12.dll"), gpu("cublasLt64_12.dll"), 668_673_536),
                    ],
                },
            },
            Download {
                url: format!(
                    "https://developer.download.nvidia.com/compute/cudnn/redist/cudnn/windows-x86_64/{CUDNN}.zip"
                ),
                file_name: format!("{CUDNN}.zip"),
                size: 1_885_727_510,
                sha256: "75bf8c4201adfe994213ac080b97ecba0e04ee86be10c1774982e837bee3ee8f".into(),
                unpack: Unpack::Zip {
                    members: vec![
                        cudnn("cudnn64_9.dll", 272_496),
                        cudnn("cudnn_adv64_9.dll", 229_649_008),
                        cudnn("cudnn_cnn64_9.dll", 2_872_944),
                        cudnn("cudnn_engines_precompiled64_9.dll", 522_326_640),
                        cudnn("cudnn_engines_runtime_compiled64_9.dll", 43_971_184),
                        cudnn("cudnn_engines_tensor_ir64_9.dll", 156_784),
                        cudnn("cudnn_ext64_9.dll", 130_160),
                        cudnn("cudnn_graph64_9.dll", 99_939_952),
                        cudnn("cudnn_heuristic64_9.dll", 94_795_376),
                        cudnn("cudnn_ops64_9.dll", 90_087_024),
                    ],
                },
            },
            fp32("encoder.onnx", 41_838_346, "266d8e8177013abc20a65d5011a59a850e76bfaa876b33f8beb89ae73f81bb76"),
            fp32("encoder.weights", 2_435_420_160, "90cd4bb6c9b60496d49be9bec3a844f4e9bf22c62a45ea93f391cc00f9a47cfe"),
            fp32("decoder.onnx", 28_883_664, "612105ff91f4854f981714e3a8dce1a9a3f99ee6aa96b9966dbbdac3cc09dd04"),
            fp32("joiner.onnx", 6_907_577, "fc1f63b222b7a7327c378ed272206dc9c74cf34e64a9b0b9fbed4160f20e3c6c"),
            // The same file as in the int8 package; each variant folder must be complete.
            fp32("tokens.txt", 9_384, "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d"),
        ],
    }
}

/// The model files alone of `pkg`: the downloads whose every output lies under `models/`
/// (the speech model and the voice detector), without the runtime libraries. This is what is
/// downloaded when the transcriber's own folder already holds its runtime (an installed app
/// ships the runtime beside `transcriber.exe`; development uses `.cache-dev/speech/dist`).
pub fn model_only(pkg: &Package) -> Package {
    Package {
        kind: pkg.kind,
        downloads: pkg
            .downloads
            .iter()
            .filter(|d| d.outputs().iter().all(|(rel, _)| rel.starts_with("models/")))
            .cloned()
            .collect(),
    }
}

/// True when the NVIDIA driver is installed (its `nvcuda.dll` is in System32).
pub fn nvidia_gpu_present() -> bool {
    if !cfg!(windows) {
        return false;
    }
    let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    Path::new(&system_root).join("System32").join("nvcuda.dll").is_file()
}

fn download_failed(message: &str, detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::TranscriberFailed, message).with_detail(detail)
}

fn cancelled() -> AppError {
    AppError::new(ErrorCode::Cancelled, "The speech model download was cancelled.")
}

fn io_failed(what: &str, path: &Path, e: std::io::Error) -> AppError {
    let code = if e.raw_os_error() == Some(112) || e.kind() == std::io::ErrorKind::StorageFull {
        ErrorCode::DiskFull
    } else {
        ErrorCode::TranscriberFailed
    };
    AppError::new(code, "Could not install the speech model.").with_detail(format!("{what} {}: {e}", path.display()))
}

/// The speech folder: model, voice detector, runtimes and partial downloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeechHome {
    root: PathBuf,
    /// A model folder somewhere else than `<root>/models` (see [`SpeechHome::with_model_dir`]).
    models: Option<PathBuf>,
}

impl SpeechHome {
    /// A speech folder at `root` (created on first install).
    pub fn new(root: impl Into<PathBuf>) -> Self {
        SpeechHome { root: root.into(), models: None }
    }

    /// A speech home whose model folder is `model_dir` itself (the `--model-dir`, laid out as
    /// under `models/`), for a model folder chosen on its own (`ROUGHCUT_MODEL_DIR`). Partial
    /// downloads go to `<model_dir>/.downloads`. Runtime folders, if used, are under `model_dir`.
    pub fn with_model_dir(model_dir: impl Into<PathBuf>) -> Self {
        let dir = model_dir.into();
        SpeechHome { root: dir.clone(), models: Some(dir) }
    }

    /// `%LOCALAPPDATA%\Roughcut\speech`, or `None` when LOCALAPPDATA is not set.
    pub fn default_location() -> Option<Self> {
        let base = std::env::var_os("LOCALAPPDATA")?;
        Some(SpeechHome::new(PathBuf::from(base).join("Roughcut").join("speech")))
    }

    /// The speech folder.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The model folder passed as `--model-dir`: one sub-folder per model variant, named as
    /// sherpa-onnx publishes them, and the voice detector beside them (the layout the
    /// transcriber program reads; it picks the variant for the device it uses).
    pub fn model_dir(&self) -> PathBuf {
        self.path("models")
    }

    /// The voice detector passed as `--vad-model`.
    pub fn vad_model(&self) -> PathBuf {
        self.path("models/silero_vad.onnx")
    }

    /// The runtime folder of a package; the transcriber runs from here.
    pub fn runtime_dir(&self, kind: PackageKind) -> PathBuf {
        self.path(match kind {
            PackageKind::Cpu => RUNTIME_CPU,
            PackageKind::Gpu => RUNTIME_GPU,
        })
    }

    fn path(&self, rel: &str) -> PathBuf {
        let join = |base: &Path, rel: &str| rel.split('/').fold(base.to_path_buf(), |p, part| p.join(part));
        if let Some(models) = &self.models {
            if rel == "models" {
                return models.clone();
            }
            if let Some(rest) = rel.strip_prefix("models/") {
                return join(models, rest);
            }
            if rel == "downloads" {
                return models.join(".downloads");
            }
        }
        join(&self.root, rel)
    }

    fn download_installed(&self, d: &Download) -> bool {
        d.outputs().iter().all(|(rel, size)| fs::metadata(self.path(rel)).is_ok_and(|m| m.is_file() && m.len() == *size))
    }

    /// True when every file of the package is present with its exact size.
    pub fn is_installed(&self, pkg: &Package) -> bool {
        pkg.downloads.iter().all(|d| self.download_installed(d))
    }

    /// Bytes still to download for the package (partial downloads count as done).
    pub fn missing_bytes(&self, pkg: &Package) -> u64 {
        pkg.downloads
            .iter()
            .filter(|d| !self.download_installed(d))
            .map(|d| {
                let have = fs::metadata(self.part_path(d)).map(|m| m.len()).unwrap_or(0).min(d.size);
                d.size - have
            })
            .sum()
    }

    fn part_path(&self, d: &Download) -> PathBuf {
        self.path("downloads").join(format!("{}.part", d.file_name))
    }

    /// Downloads, verifies and unpacks whatever of the package is missing. Partial downloads
    /// are resumed; a file whose size or SHA-256 does not match is deleted and reported.
    /// Returns `cancelled` when `cancel` is set (the partial file is kept for next time).
    pub fn install(
        &self,
        pkg: &Package,
        cancel: &CancelToken,
        mut on_progress: impl FnMut(DownloadProgress),
    ) -> Result<(), AppError> {
        let needed: Vec<&Download> = pkg.downloads.iter().filter(|d| !self.download_installed(d)).collect();
        if needed.is_empty() {
            return Ok(());
        }
        let downloads_dir = self.path("downloads");
        fs::create_dir_all(&downloads_dir).map_err(|e| io_failed("creating", &downloads_dir, e))?;
        let total: u64 = needed.iter().map(|d| d.size).sum();
        let mut done_before = 0u64;
        for d in needed {
            let part = self.part_path(d);
            let mut report = |phase, done: u64| {
                on_progress(DownloadProgress {
                    package: pkg.kind,
                    phase,
                    file: d.file_name.clone(),
                    done_bytes: done_before + done,
                    total_bytes: total,
                })
            };
            fetch(d, &part, cancel, |n| report(DownloadPhase::Downloading, n))?;
            report(DownloadPhase::Verifying, d.size);
            let hash = sha256_file(&part, cancel)?;
            if !hash.eq_ignore_ascii_case(&d.sha256) {
                let _ = fs::remove_file(&part);
                return Err(download_failed(
                    "The downloaded speech model is damaged.",
                    format!("{}: SHA-256 {hash}, expected {}", d.file_name, d.sha256),
                ));
            }
            report(DownloadPhase::Unpacking, d.size);
            self.unpack(d, &part, cancel)?;
            let _ = fs::remove_file(&part);
            done_before += d.size;
        }
        Ok(())
    }

    fn unpack(&self, d: &Download, archive: &Path, cancel: &CancelToken) -> Result<(), AppError> {
        match &d.unpack {
            Unpack::File { dest } => {
                let target = self.path(dest);
                ensure_parent(&target)?;
                // Same volume: a rename, not a copy of gigabytes.
                fs::rename(archive, &target).map_err(|e| io_failed("moving into place", &target, e))?;
                Ok(())
            }
            Unpack::TarBz2 { members } => {
                let f = File::open(archive).map_err(|e| io_failed("opening", archive, e))?;
                let dec = bzip2::read::MultiBzDecoder::new(BufReader::with_capacity(1 << 20, f));
                let mut ar = tar::Archive::new(dec);
                let mut found = vec![false; members.len()];
                let entries = ar.entries().map_err(|e| bad_archive(d, e))?;
                for entry in entries {
                    let mut entry = entry.map_err(|e| bad_archive(d, e))?;
                    let name = entry.path().map_err(|e| bad_archive(d, e))?.to_string_lossy().replace('\\', "/");
                    if let Some(i) = members.iter().position(|m| m.path_in_archive == name) {
                        self.write_member(d, &members[i], &mut entry, cancel)?;
                        found[i] = true;
                        if found.iter().all(|f| *f) {
                            break;
                        }
                    }
                }
                missing_members(d, members, &found)
            }
            Unpack::Zip { members } => {
                let f = File::open(archive).map_err(|e| io_failed("opening", archive, e))?;
                let mut zip = zip::ZipArchive::new(BufReader::new(f)).map_err(|e| bad_archive(d, e))?;
                let mut found = vec![false; members.len()];
                for (i, m) in members.iter().enumerate() {
                    let Ok(mut entry) = zip.by_name(&m.path_in_archive) else { continue };
                    self.write_member(d, m, &mut entry, cancel)?;
                    found[i] = true;
                }
                missing_members(d, members, &found)
            }
        }
    }

    fn write_member(&self, d: &Download, m: &Member, reader: &mut dyn Read, cancel: &CancelToken) -> Result<(), AppError> {
        let target = self.path(&m.dest);
        ensure_parent(&target)?;
        let tmp = target.with_extension("partial");
        let mut out = File::create(&tmp).map_err(|e| io_failed("creating", &tmp, e))?;
        let written = copy_cancellable(reader, &mut out, cancel, |_| {}).map_err(|e| match e {
            CopyError::Cancelled => cancelled(),
            CopyError::Read(e) => bad_archive(d, e),
            CopyError::Write(e) => io_failed("writing", &tmp, e),
        });
        drop(out);
        let written = match written {
            Ok(n) => n,
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(e);
            }
        };
        if written != m.size {
            let _ = fs::remove_file(&tmp);
            return Err(download_failed(
                "The downloaded speech model is damaged.",
                format!("{} in {}: {written} bytes, expected {}", m.path_in_archive, d.file_name, m.size),
            ));
        }
        fs::rename(&tmp, &target).map_err(|e| io_failed("moving into place", &target, e))
    }

    /// The command that starts the transcriber with what is installed, for the device the
    /// settings ask for. Copies `transcriber_exe` into the runtime folder it must run from
    /// (when missing or changed). Fails when the processor package is not installed.
    pub fn launch_plan(&self, transcriber_exe: &Path, device: SpeechDevice, nvidia_present: bool) -> Result<LaunchPlan, AppError> {
        let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let system32 = Path::new(&system_root).join("System32");
        self.launch_plan_for(transcriber_exe, device, nvidia_present, &cpu_package(), &gpu_package(), &system32)
    }

    /// The Visual C++ runtime files the GPU runtime cannot start without and that are in
    /// neither its folder nor `system_dir`.
    fn vc_runtime_missing(&self, system_dir: &Path) -> Vec<&'static str> {
        let dir = self.runtime_dir(PackageKind::Gpu);
        VC_RUNTIME.into_iter().filter(|n| !dir.join(n).is_file() && !system_dir.join(n).is_file()).collect()
    }

    fn launch_plan_for(
        &self,
        transcriber_exe: &Path,
        device: SpeechDevice,
        nvidia_present: bool,
        cpu: &Package,
        gpu: &Package,
        system_dir: &Path,
    ) -> Result<LaunchPlan, AppError> {
        if !self.is_installed(cpu) {
            return Err(AppError::new(ErrorCode::TranscriberFailed, "The speech model is not downloaded yet.")
                .with_detail(format!("missing files under {}", self.root.display())));
        }
        let wants_gpu = device != SpeechDevice::Cpu && nvidia_present;
        let mut gpu_installed = wants_gpu && self.is_installed(gpu);
        let mut gpu_unusable = None;
        if gpu_installed {
            let missing = self.vc_runtime_missing(system_dir);
            if !missing.is_empty() {
                gpu_installed = false;
                gpu_unusable = Some(format!(
                    "the GPU runtime needs the Visual C++ 2015-2022 runtime ({} not found)",
                    missing.join(", ")
                ));
            }
        }
        let kind = if gpu_installed { PackageKind::Gpu } else { PackageKind::Cpu };
        let dir = self.runtime_dir(kind);
        let name = transcriber_exe.file_name().map(PathBuf::from).unwrap_or_else(|| "transcriber.exe".into());
        let program = dir.join(name);
        copy_if_changed(transcriber_exe, &program)?;
        Ok(LaunchPlan {
            command: TranscriberCommand {
                program,
                model_dir: self.model_dir(),
                device: if gpu_installed { device } else { SpeechDevice::Cpu },
                vad_model: Some(self.vad_model()),
            },
            uses_gpu_runtime: gpu_installed,
            gpu_package_needed: wants_gpu && !gpu_installed && gpu_unusable.is_none(),
            gpu_unusable,
        })
    }
}

fn bad_archive(d: &Download, e: impl std::fmt::Display) -> AppError {
    download_failed("The downloaded speech model is damaged.", format!("{}: {e}", d.file_name))
}

fn missing_members(d: &Download, members: &[Member], found: &[bool]) -> Result<(), AppError> {
    let missing: Vec<&str> =
        members.iter().zip(found).filter(|(_, f)| !**f).map(|(m, _)| m.path_in_archive.as_str()).collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(download_failed("The downloaded speech model is incomplete.", format!("{} lacks {}", d.file_name, missing.join(", "))))
    }
}

fn ensure_parent(path: &Path) -> Result<(), AppError> {
    match path.parent() {
        Some(p) => fs::create_dir_all(p).map_err(|e| io_failed("creating", p, e)),
        None => Ok(()),
    }
}

/// Copies `src` to `dst` unless `dst` already has the same size and is not older.
fn copy_if_changed(src: &Path, dst: &Path) -> Result<(), AppError> {
    let src_meta = fs::metadata(src).map_err(|e| {
        AppError::new(ErrorCode::TranscriberFailed, "The transcriber program is missing.")
            .with_detail(format!("{}: {e}", src.display()))
    })?;
    if let Ok(dst_meta) = fs::metadata(dst) {
        let newer = match (src_meta.modified(), dst_meta.modified()) {
            (Ok(s), Ok(d)) => s > d,
            _ => false,
        };
        if dst_meta.len() == src_meta.len() && !newer {
            return Ok(());
        }
    }
    ensure_parent(dst)?;
    let tmp = dst.with_extension("exe.partial");
    let result = fs::copy(src, &tmp).and_then(|_| fs::rename(&tmp, dst));
    match result {
        Ok(()) => Ok(()),
        // An older copy that is running cannot be replaced; it still works.
        Err(_) if dst.is_file() => {
            let _ = fs::remove_file(&tmp);
            Ok(())
        }
        Err(e) => Err(io_failed("copying the transcriber to", dst, e)),
    }
}

enum CopyError {
    Cancelled,
    Read(std::io::Error),
    Write(std::io::Error),
}

fn copy_cancellable(
    reader: &mut dyn Read,
    writer: &mut dyn Write,
    cancel: &CancelToken,
    mut on_bytes: impl FnMut(u64),
) -> Result<u64, CopyError> {
    let mut buf = vec![0u8; 256 * 1024];
    let mut total = 0u64;
    loop {
        if cancel.is_cancelled() {
            return Err(CopyError::Cancelled);
        }
        let n = match reader.read(&mut buf) {
            Ok(0) => return Ok(total),
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(CopyError::Read(e)),
        };
        writer.write_all(&buf[..n]).map_err(CopyError::Write)?;
        total += n as u64;
        on_bytes(total);
    }
}

fn sha256_file(path: &Path, cancel: &CancelToken) -> Result<String, AppError> {
    let mut f = File::open(path).map_err(|e| io_failed("opening", path, e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        let n = f.read(&mut buf).map_err(|e| io_failed("reading", path, e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Downloads `d` into `part`, resuming from what is already there.
fn fetch(d: &Download, part: &Path, cancel: &CancelToken, mut on_bytes: impl FnMut(u64)) -> Result<(), AppError> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(30))
        .timeout_read(Duration::from_secs(60))
        .user_agent("roughcut-speech-setup")
        .build();
    for _attempt in 0..2 {
        let mut have = fs::metadata(part).map(|m| m.len()).unwrap_or(0);
        if have > d.size {
            let _ = fs::remove_file(part);
            have = 0;
        }
        if have == d.size {
            on_bytes(have);
            return Ok(());
        }
        on_bytes(have);
        let mut req = agent.get(&d.url);
        if have > 0 {
            req = req.set("Range", &format!("bytes={have}-"));
        }
        let resp = match req.call() {
            Ok(r) => r,
            Err(ureq::Error::Status(416, _)) => {
                // The server will not resume from here: start again.
                let _ = fs::remove_file(part);
                continue;
            }
            Err(e) => {
                return Err(download_failed("Could not download the speech model.", format!("{}: {e}", d.url)));
            }
        };
        let resumed = resp.status() == 206
            && resp
                .header("Content-Range")
                .and_then(|v| v.strip_prefix("bytes "))
                .and_then(|v| v.split('-').next())
                .and_then(|v| v.trim().parse::<u64>().ok())
                == Some(have);
        if resp.status() != 200 && !resumed {
            if resp.status() == 206 {
                let _ = fs::remove_file(part);
                continue;
            }
            return Err(download_failed(
                "Could not download the speech model.",
                format!("{}: HTTP {}", d.url, resp.status()),
            ));
        }
        let start = if resumed { have } else { 0 };
        let mut out = if resumed {
            OpenOptions::new().append(true).open(part)
        } else {
            File::create(part)
        }
        .map_err(|e| io_failed("writing", part, e))?;
        let mut body = resp.into_reader();
        let result = copy_cancellable(&mut body, &mut out, cancel, |n| on_bytes(start + n));
        drop(out);
        match result {
            Ok(_) => {}
            Err(CopyError::Cancelled) => return Err(cancelled()),
            Err(CopyError::Read(e)) => {
                return Err(download_failed(
                    "The speech model download was interrupted; it resumes next time.",
                    format!("{}: {e}", d.url),
                ));
            }
            Err(CopyError::Write(e)) => return Err(io_failed("writing", part, e)),
        }
        let got = fs::metadata(part).map(|m| m.len()).unwrap_or(0);
        if got == d.size {
            return Ok(());
        }
        if got > d.size {
            let _ = fs::remove_file(part);
            return Err(download_failed(
                "The downloaded speech model is damaged.",
                format!("{}: {got} bytes, expected {}", d.file_name, d.size),
            ));
        }
        return Err(download_failed(
            "The speech model download was interrupted; it resumes next time.",
            format!("{}: {got} of {} bytes", d.file_name, d.size),
        ));
    }
    Err(download_failed("Could not download the speech model.", format!("{}: the server refused to resume", d.url)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rc-speech-models-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn fake(kind: PackageKind, dest: &str, size: u64) -> Package {
        Package {
            kind,
            downloads: vec![Download {
                url: "http://127.0.0.1:9/never".into(),
                file_name: format!("{dest}.bin").replace('/', "_"),
                size,
                sha256: String::new(),
                unpack: Unpack::File { dest: dest.into() },
            }],
        }
    }

    fn put(home: &SpeechHome, rel: &str, size: usize) {
        let p = home.path(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, vec![7u8; size]).unwrap();
    }

    #[test]
    fn packages_are_consistent() {
        for pkg in [cpu_package(), gpu_package()] {
            let mut dests = std::collections::HashSet::new();
            for d in &pkg.downloads {
                assert_eq!(d.sha256.len(), 64, "{}", d.file_name);
                assert!(d.url.starts_with("https://"), "{}", d.url);
                for (dest, size) in d.outputs() {
                    assert!(size > 0);
                    assert!(dests.insert(dest.clone()), "two downloads write {dest}");
                }
            }
        }
        // The processor package holds what every launch needs.
        let cpu: Vec<String> = cpu_package().downloads.iter().flat_map(|d| d.outputs()).map(|(p, _)| p).collect();
        for need in ["models/silero_vad.onnx", "models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/tokens.txt", "runtime/cpu/sherpa-onnx-c-api.dll"] {
            assert!(cpu.iter().any(|p| p == need), "{need}");
        }
        assert!(gpu_package().total_bytes() > 5_000_000_000);
    }

    #[test]
    fn launch_plan_picks_the_runtime_and_copies_the_program() {
        let dir = tmp_dir("plan");
        let home = SpeechHome::new(dir.join("speech"));
        let exe = dir.join("transcriber.exe");
        fs::write(&exe, b"program").unwrap();
        let cpu = fake(PackageKind::Cpu, "models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/tokens.txt", 10);
        let gpu = fake(PackageKind::Gpu, "runtime/gpu/cudnn64_9.dll", 20);
        // A system folder with the Visual C++ runtime, and one without.
        let sys = dir.join("system32");
        fs::create_dir_all(&sys).unwrap();
        for n in VC_RUNTIME {
            fs::write(sys.join(n), b"dll").unwrap();
        }
        let bare = dir.join("bare-system32");
        fs::create_dir_all(&bare).unwrap();

        let err = home.launch_plan_for(&exe, SpeechDevice::Auto, true, &cpu, &gpu, &sys).unwrap_err();
        assert_eq!(err.code, ErrorCode::TranscriberFailed);

        put(&home, "models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/tokens.txt", 10);
        let plan = home.launch_plan_for(&exe, SpeechDevice::Auto, true, &cpu, &gpu, &sys).unwrap();
        assert!(!plan.uses_gpu_runtime);
        assert!(plan.gpu_package_needed);
        assert_eq!(plan.command.device, SpeechDevice::Cpu);
        assert_eq!(plan.command.program, home.runtime_dir(PackageKind::Cpu).join("transcriber.exe"));
        assert_eq!(fs::read(&plan.command.program).unwrap(), b"program");
        assert_eq!(plan.command.vad_model, Some(home.vad_model()));
        assert_eq!(plan.command.model_dir, home.model_dir());

        put(&home, "runtime/gpu/cudnn64_9.dll", 20);
        let plan = home.launch_plan_for(&exe, SpeechDevice::Auto, true, &cpu, &gpu, &sys).unwrap();
        assert!(plan.uses_gpu_runtime);
        assert!(!plan.gpu_package_needed);
        assert_eq!(plan.command.device, SpeechDevice::Auto);
        assert_eq!(plan.command.program, home.runtime_dir(PackageKind::Gpu).join("transcriber.exe"));
        assert_eq!(plan.gpu_unusable, None);

        // Without the Visual C++ runtime the GPU runtime cannot start: the processor is used.
        let plan = home.launch_plan_for(&exe, SpeechDevice::Auto, true, &cpu, &gpu, &bare).unwrap();
        assert!(!plan.uses_gpu_runtime && !plan.gpu_package_needed);
        assert_eq!(plan.command.device, SpeechDevice::Cpu);
        assert!(plan.gpu_unusable.as_deref().unwrap().contains("vcruntime140.dll"), "{:?}", plan.gpu_unusable);
        // App-local copies next to the GPU runtime are enough.
        for n in VC_RUNTIME {
            put(&home, &format!("runtime/gpu/{n}"), 3);
        }
        let plan = home.launch_plan_for(&exe, SpeechDevice::Auto, true, &cpu, &gpu, &bare).unwrap();
        assert!(plan.uses_gpu_runtime);

        // The processor is asked for, or there is no NVIDIA GPU: the CPU runtime.
        let plan = home.launch_plan_for(&exe, SpeechDevice::Cpu, true, &cpu, &gpu, &sys).unwrap();
        assert!(!plan.uses_gpu_runtime && !plan.gpu_package_needed);
        let plan = home.launch_plan_for(&exe, SpeechDevice::Gpu, false, &cpu, &gpu, &sys).unwrap();
        assert!(!plan.uses_gpu_runtime && !plan.gpu_package_needed);
        assert_eq!(plan.command.device, SpeechDevice::Cpu);

        // A changed program is copied again.
        fs::write(&exe, b"program v2").unwrap();
        let plan = home.launch_plan_for(&exe, SpeechDevice::Cpu, false, &cpu, &gpu, &sys).unwrap();
        assert_eq!(fs::read(&plan.command.program).unwrap(), b"program v2");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_size_means_not_installed() {
        let dir = tmp_dir("size");
        let home = SpeechHome::new(&dir);
        let pkg = fake(PackageKind::Cpu, "models/x.onnx", 10);
        assert!(!home.is_installed(&pkg));
        assert_eq!(home.missing_bytes(&pkg), 10);
        put(&home, "models/x.onnx", 9);
        assert!(!home.is_installed(&pkg));
        put(&home, "models/x.onnx", 10);
        assert!(home.is_installed(&pkg));
        assert_eq!(home.missing_bytes(&pkg), 0);
        let _ = fs::remove_dir_all(&dir);
    }
}
