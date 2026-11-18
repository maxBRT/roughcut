//! Finding the model files and choosing the processor (spec 2.4.4, speech experiment 4.4 and 4.5).
//!
//! `--model-dir` holds one sub-folder per variant, named as sherpa-onnx publishes them:
//! `<family>` with `encoder.onnx` (+ `encoder.weights`), `decoder.onnx`, `joiner.onnx` (fp32, for
//! the GPU) and `<family>-int8` with `*.int8.onnx` (for the processor), each with `tokens.txt`.
//! A folder that itself holds `tokens.txt` is taken as a single variant.

use std::path::{Path, PathBuf};

/// Model family used when none is named.
pub const DEFAULT_FAMILY: &str = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2";
/// Version of the sherpa-onnx runtime this program is built against.
pub const SHERPA_ONNX_VERSION: &str = "2.0.1";

/// Numeric precision of a model variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Precision {
    Fp32,
    Int8,
}

/// One usable set of model files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Variant {
    pub name: String,
    pub precision: Precision,
    pub encoder: PathBuf,
    pub decoder: PathBuf,
    pub joiner: PathBuf,
    pub tokens: PathBuf,
}

impl Variant {
    /// Name and version reported in `ready`.
    pub fn display_name(&self) -> String {
        format!("{} (sherpa-onnx {})", self.name, SHERPA_ONNX_VERSION)
    }
}

fn nonempty_file(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_file() && m.len() > 0).unwrap_or(false)
}

/// Why a variant folder cannot be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VariantError {
    /// The variant's folder does not exist.
    NoFolder,
    /// The folder exists but a model file is missing or empty (reported as `model_missing`).
    Incomplete(String),
    /// All files are there but one is damaged, e.g. a `tokens.txt` cut short by an interrupted
    /// download (reported as `model_load_failed`). sherpa-onnx would call `exit()` on such a
    /// file, so it is checked here, before the runtime ever sees it.
    Broken(String),
}

impl VariantError {
    /// A human-readable reason for standard error and the `error` message.
    pub fn reason(&self) -> String {
        match self {
            VariantError::NoFolder => "folder not found".into(),
            VariantError::Incomplete(r) | VariantError::Broken(r) => r.clone(),
        }
    }
}

/// Checks a sherpa-onnx `tokens.txt`: every line is `<symbol> <id>` (a line holding only an id
/// stands for the space symbol), the ids run 0, 1, 2, ... in order, and the blank token
/// `<blk>` that NeMo transducers need is present. Returns the number of tokens.
pub fn check_tokens(path: &Path) -> Result<usize, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{} cannot be read: {e}", path.display()))?;
    let text = std::str::from_utf8(&bytes).map_err(|_| format!("{} is not valid UTF-8", path.display()))?;
    let mut count = 0usize;
    let mut has_blank = false;
    // `lines` splits at line feeds and drops a carriage return before them.
    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        let (symbol, id) = match fields.as_slice() {
            [id] => (" ", *id),
            [symbol, id] => (*symbol, *id),
            _ => return Err(format!("{} line {}: expected \"<symbol> <id>\"", path.display(), i + 1)),
        };
        let id: usize = id
            .parse()
            .map_err(|_| format!("{} line {}: \"{id}\" is not a token id", path.display(), i + 1))?;
        if id != count {
            return Err(format!("{} line {}: token id {id}, expected {count}", path.display(), i + 1));
        }
        has_blank |= symbol == "<blk>";
        count += 1;
    }
    if count == 0 {
        return Err(format!("{} holds no tokens", path.display()));
    }
    if !has_blank {
        return Err(format!(
            "{} has no blank token <blk> (cut short after {count} tokens, e.g. by an interrupted download?)",
            path.display()
        ));
    }
    Ok(count)
}

/// Reads one variant folder with the file names for `precision`, checking that every file is
/// present and non-empty and that `tokens.txt` is whole.
pub fn variant_in(dir: &Path, precision: Precision) -> Result<Variant, VariantError> {
    if !dir.is_dir() {
        return Err(VariantError::NoFolder);
    }
    let suffix = match precision {
        Precision::Fp32 => ".onnx",
        Precision::Int8 => ".int8.onnx",
    };
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| dir.to_string_lossy().into_owned());
    let v = Variant {
        name,
        precision,
        encoder: dir.join(format!("encoder{suffix}")),
        decoder: dir.join(format!("decoder{suffix}")),
        joiner: dir.join(format!("joiner{suffix}")),
        tokens: dir.join("tokens.txt"),
    };
    for p in [&v.encoder, &v.decoder, &v.joiner, &v.tokens] {
        if !nonempty_file(p) {
            return Err(VariantError::Incomplete(format!("{} is missing or empty", p.display())));
        }
    }
    check_tokens(&v.tokens).map_err(VariantError::Broken)?;
    Ok(v)
}

/// The variants under `model_dir` for `family`: (fp32, int8), each usable or the reason not.
pub fn find_variants(model_dir: &Path, family: &str) -> (Result<Variant, VariantError>, Result<Variant, VariantError>) {
    if model_dir.join("tokens.txt").is_file() {
        return (variant_in(model_dir, Precision::Fp32), variant_in(model_dir, Precision::Int8));
    }
    let fp32 = variant_in(&model_dir.join(family), Precision::Fp32);
    let int8 = variant_in(&model_dir.join(format!("{family}-int8")), Precision::Int8);
    (fp32, int8)
}

/// Where the voice-detector model is looked for when `--vad-model` is not given.
pub fn default_vad_path(model_dir: &Path) -> PathBuf {
    let here = model_dir.join("silero_vad.onnx");
    if here.is_file() {
        return here;
    }
    match model_dir.parent() {
        Some(p) if p.join("silero_vad.onnx").is_file() => p.join("silero_vad.onnx"),
        _ => here,
    }
}

/// Folder of the running executable (where the runtime DLLs sit).
pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

/// True when the installation carries the GPU runtime (the CUDA provider beside the program).
pub fn gpu_runtime_installed() -> bool {
    exe_dir().map(|d| d.join("onnxruntime_providers_cuda.dll").is_file()).unwrap_or(false)
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LoadLibraryW(name: *const u16) -> *mut c_void;
        fn GetModuleHandleW(name: *const u16) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn load_handle(name: &str) -> *mut c_void {
        let w = wide(name);
        // SAFETY: `w` is a valid NUL-terminated UTF-16 string that outlives the call.
        unsafe { LoadLibraryW(w.as_ptr()) }
    }

    pub fn load(name: &str) -> bool {
        !load_handle(name).is_null()
    }

    pub fn is_loaded(name: &str) -> bool {
        let w = wide(name);
        // SAFETY: as above; GetModuleHandleW does not take ownership.
        !unsafe { GetModuleHandleW(w.as_ptr()) }.is_null()
    }

    /// `cudaGetDeviceCount` from the CUDA runtime beside the program: the number of usable CUDA
    /// devices, or the CUDA error code (100 = no CUDA-capable device, 35 = driver too old).
    pub fn cuda_device_count() -> Result<i32, String> {
        let module = load_handle("cudart64_12.dll");
        if module.is_null() {
            return Err("cudart64_12.dll could not be loaded".into());
        }
        // SAFETY: `module` is a loaded module handle (never freed) and the name is NUL-terminated.
        let proc = unsafe { GetProcAddress(module, b"cudaGetDeviceCount\0".as_ptr()) };
        if proc.is_null() {
            return Err("cudart64_12.dll has no cudaGetDeviceCount".into());
        }
        // SAFETY: the CUDA runtime declares `cudaError_t cudaGetDeviceCount(int *count)`, a C
        // function returning an int-sized enum; x64 Windows has a single calling convention.
        let get_count: unsafe extern "C" fn(*mut i32) -> i32 = unsafe { std::mem::transmute(proc) };
        let mut count: i32 = 0;
        // SAFETY: `count` is a valid, writable int for the duration of the call.
        let rc = unsafe { get_count(&mut count) };
        if rc != 0 {
            return Err(format!("cudaGetDeviceCount failed with CUDA error {rc}"));
        }
        Ok(count)
    }
}

/// Libraries the CUDA provider needs. Loading them before the recognizer is created finds a
/// missing NVIDIA library early. `onnxruntime_providers_cuda.dll` itself must not be loaded
/// here: outside onnxruntime its initialisation fails (speech experiment 4.5). Nor may
/// `cudnn_graph64_9.dll`: only a working CUDA provider loads it, which is what
/// [`cuda_provider_active`] checks afterwards.
const CUDA_PREREQUISITES: &[&str] = &[
    "cudart64_12.dll",
    "cublasLt64_12.dll",
    "cublas64_12.dll",
    "cudnn64_9.dll",
    "onnxruntime_providers_shared.dll",
];

/// Checks that the GPU runtime can be loaded and that CUDA sees at least one device. Returns
/// the reason when it cannot. Without a device (old driver, GPU disabled,
/// `CUDA_VISIBLE_DEVICES=-1`) onnxruntime would otherwise quietly run the fp32 model on the
/// processor.
pub fn cuda_preflight() -> Result<(), String> {
    if !gpu_runtime_installed() {
        return Err("onnxruntime_providers_cuda.dll is not next to the transcriber".into());
    }
    #[cfg(windows)]
    {
        for dll in CUDA_PREREQUISITES {
            if !win::load(dll) {
                return Err(format!("{dll} could not be loaded"));
            }
        }
        match win::cuda_device_count()? {
            n if n > 0 => Ok(()),
            _ => Err("CUDA reports no CUDA-capable device".into()),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = CUDA_PREREQUISITES;
        Err("the GPU path is only built for Windows".into())
    }
}

/// After the recognizer was created with provider "cuda": true when onnxruntime really runs
/// its CUDA provider. The provider DLL alone is not proof (onnxruntime loads it even when the
/// CUDA session then fails and falls back to the processor); cuDNN's graph library is loaded
/// only once the provider has a working device.
pub fn cuda_provider_active() -> bool {
    #[cfg(windows)]
    {
        win::is_loaded("onnxruntime_providers_cuda.dll") && win::is_loaded("cudnn_graph64_9.dll")
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKENS: &str = "<unk> 0\n\u{2581}t 1\n\u{2581}th 2\n<blk> 3\n";

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"x").unwrap();
    }

    fn write_tokens(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("rc-transcriber-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    #[test]
    fn finds_variants_by_folder_name() {
        let root = scratch("model-test");
        let fam = root.join("fam");
        let int8 = root.join("fam-int8");
        for f in ["encoder.onnx", "decoder.onnx", "joiner.onnx"] {
            touch(&fam.join(f));
        }
        write_tokens(&fam.join("tokens.txt"), TOKENS);
        for f in ["encoder.int8.onnx", "decoder.int8.onnx"] {
            touch(&int8.join(f));
        }
        write_tokens(&int8.join("tokens.txt"), TOKENS);
        let (a, b) = find_variants(&root, "fam");
        assert_eq!(a.unwrap().precision, Precision::Fp32);
        assert!(matches!(b, Err(VariantError::Incomplete(_))), "joiner missing: {b:?}");
        touch(&int8.join("joiner.int8.onnx"));
        let (_, b) = find_variants(&root, "fam");
        let b = b.unwrap();
        assert_eq!(b.name, "fam-int8");
        assert!(b.display_name().contains("sherpa-onnx 2.0.1"));
        // A variant folder given directly.
        let (a, b) = find_variants(&int8, "ignored");
        assert!(a.is_err() && b.is_ok());
        // An empty file does not count.
        std::fs::write(fam.join("encoder.onnx"), b"").unwrap();
        assert!(matches!(find_variants(&root, "fam").0, Err(VariantError::Incomplete(_))));
        // A family that is not there at all.
        assert_eq!(find_variants(&root, "other").1, Err(VariantError::NoFolder));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_truncated_tokens_file_marks_the_variant_broken() {
        let root = scratch("tokens-test");
        let int8 = root.join("fam-int8");
        for f in ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx"] {
            touch(&int8.join(f));
        }
        // Cut short in the last line, as an interrupted download leaves it.
        write_tokens(&int8.join("tokens.txt"), &TOKENS[..TOKENS.len() - 4]);
        match find_variants(&root, "fam").1 {
            Err(VariantError::Broken(r)) => assert!(r.contains("line 4"), "{r}"),
            other => panic!("{other:?}"),
        }
        // Cut short just before the last line.
        write_tokens(&int8.join("tokens.txt"), &TOKENS[..TOKENS.len() - 8]);
        match find_variants(&root, "fam").1 {
            Err(VariantError::Broken(r)) => assert!(r.contains("no blank token <blk>"), "{r}"),
            other => panic!("{other:?}"),
        }
        // Cut short in the middle of an id.
        write_tokens(&int8.join("tokens.txt"), "<unk> 0\n\u{2581}t 1\n\u{2581}th 2\n<blk> 3\nz 4");
        assert!(find_variants(&root, "fam").1.is_ok());
        write_tokens(&int8.join("tokens.txt"), "<unk> 0\n\u{2581}t 1\n<blk> 2\nz 1");
        match find_variants(&root, "fam").1 {
            Err(VariantError::Broken(r)) => assert!(r.contains("line 4"), "{r}"),
            other => panic!("{other:?}"),
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn checks_the_tokens_format() {
        let root = scratch("tokens-format");
        let p = root.join("tokens.txt");
        write_tokens(&p, TOKENS);
        assert_eq!(check_tokens(&p), Ok(4));
        // Windows line ends, no final newline, a bare id for the space symbol.
        write_tokens(&p, "<unk> 0\r\n 1\r\n<blk> 2");
        assert_eq!(check_tokens(&p), Ok(3));
        for bad in ["", "\n\n", "<unk> 0\n<blk> 2\n", "<unk> 0\na b 1\n<blk> 2\n", "<unk> x\n<blk> 1\n", "<unk> 0\na 1\n"] {
            write_tokens(&p, bad);
            assert!(check_tokens(&p).is_err(), "{bad:?} accepted");
        }
        std::fs::write(&p, [0xffu8, 0xfe, b' ', b'0']).unwrap();
        assert!(check_tokens(&p).is_err());
        assert!(check_tokens(&root.join("absent.txt")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_real_parakeet_tokens_pass() {
        let models = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.cache-dev/speech/models");
        let mut seen = 0;
        for fam in [DEFAULT_FAMILY.to_string(), format!("{DEFAULT_FAMILY}-int8")] {
            let p = models.join(fam).join("tokens.txt");
            if p.is_file() {
                assert_eq!(check_tokens(&p), Ok(1025), "{}", p.display());
                seen += 1;
            }
        }
        assert!(seen > 0, "no Parakeet tokens.txt under {}", models.display());
    }
}
