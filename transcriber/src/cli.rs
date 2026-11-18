//! Command line: `transcriber --model-dir <folder> --device <auto|gpu|cpu> [--vad-model <file>]`.
//!
//! Optional tuning flags, not part of the protocol: `--model <family>` (default
//! [`crate::model::DEFAULT_FAMILY`]), `--threads <n>` (processor threads for the model),
//! `--batch <n>` (most segments decoded together on the GPU).

use std::path::PathBuf;

/// Which processor the caller asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceRequest {
    Auto,
    Gpu,
    Cpu,
}

/// Parsed command line.
#[derive(Debug, Clone, PartialEq)]
pub struct Args {
    pub model_dir: PathBuf,
    pub device: DeviceRequest,
    pub vad_model: Option<PathBuf>,
    pub family: String,
    pub threads: Option<i32>,
    pub batch: Option<usize>,
}

/// Usage text, included in `bad_arguments` messages.
pub const USAGE: &str = "usage: transcriber --model-dir <folder> --device <auto|gpu|cpu> [--vad-model <file>] \
[--model <family>] [--threads <n>] [--batch <n>]";

/// Parses the arguments after the program name. The error is a human-readable reason.
pub fn parse(args: &[String]) -> Result<Args, String> {
    let mut model_dir = None;
    let mut device = DeviceRequest::Auto;
    let mut vad_model = None;
    let mut family = crate::model::DEFAULT_FAMILY.to_string();
    let mut threads = None;
    let mut batch = None;
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let mut value = || it.next().cloned().ok_or_else(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--model-dir" => model_dir = Some(PathBuf::from(value()?)),
            "--device" => {
                device = match value()?.as_str() {
                    "auto" => DeviceRequest::Auto,
                    "gpu" => DeviceRequest::Gpu,
                    "cpu" => DeviceRequest::Cpu,
                    other => return Err(format!("--device must be auto, gpu or cpu, not \"{other}\"")),
                }
            }
            "--vad-model" => vad_model = Some(PathBuf::from(value()?)),
            "--model" => family = value()?,
            "--threads" => {
                let v = value()?;
                let n: i32 = v.parse().map_err(|_| format!("--threads must be a number, not \"{v}\""))?;
                if !(1..=256).contains(&n) {
                    return Err("--threads must be between 1 and 256".into());
                }
                threads = Some(n);
            }
            "--batch" => {
                let v = value()?;
                let n: usize = v.parse().map_err(|_| format!("--batch must be a number, not \"{v}\""))?;
                if !(1..=64).contains(&n) {
                    return Err("--batch must be between 1 and 64".into());
                }
                batch = Some(n);
            }
            other => return Err(format!("unknown argument \"{other}\"")),
        }
    }
    let model_dir = model_dir.ok_or("--model-dir is required")?;
    if model_dir.as_os_str().is_empty() {
        return Err("--model-dir is empty".into());
    }
    if family.is_empty() || family.contains(['/', '\\']) {
        return Err("--model must be a folder name".into());
    }
    Ok(Args { model_dir, device, vad_model, family, threads, batch })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(v: &[&str]) -> Result<Args, String> {
        parse(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn protocol_command_line() {
        let a = p(&["--model-dir", "C:/m", "--device", "gpu", "--vad-model", "v.onnx"]).unwrap();
        assert_eq!(a.model_dir, PathBuf::from("C:/m"));
        assert_eq!(a.device, DeviceRequest::Gpu);
        assert_eq!(a.vad_model, Some(PathBuf::from("v.onnx")));
        assert_eq!(a.family, crate::model::DEFAULT_FAMILY);
        let a = p(&["--device", "cpu", "--model-dir", "m"]).unwrap();
        assert_eq!(a.device, DeviceRequest::Cpu);
        assert_eq!(p(&["--model-dir", "m"]).unwrap().device, DeviceRequest::Auto);
    }

    #[test]
    fn bad_command_lines() {
        assert!(p(&[]).is_err());
        assert!(p(&["--model-dir"]).is_err());
        assert!(p(&["--model-dir", "m", "--device", "tpu"]).is_err());
        assert!(p(&["--model-dir", "m", "--frobnicate"]).is_err());
        assert!(p(&["--model-dir", "m", "--threads", "0"]).is_err());
        assert!(p(&["--model-dir", "m", "--batch", "x"]).is_err());
        assert!(p(&["--model-dir", "m", "--model", "../x"]).is_err());
        assert!(p(&["--model-dir", ""]).is_err());
    }
}
