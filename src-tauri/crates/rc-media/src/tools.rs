//! Finding FFmpeg and ffprobe, and reporting their version.
//!
//! Search order (first folder that holds both programs wins):
//! 1. the folder passed to [`FfmpegTools::locate`], if any;
//! 2. the folder in the `ROUGHCUT_FFMPEG_DIR` environment variable;
//! 3. next to the running executable: its own folder, then `ffmpeg\`, then `ffmpeg\bin\`;
//! 4. every folder on `PATH`.

use std::path::{Path, PathBuf};

use rc_types::{AppError, ErrorCode};

use crate::process::hidden_command;

/// Environment variable naming a folder that holds `ffmpeg` and `ffprobe`.
pub const FFMPEG_DIR_ENV: &str = "ROUGHCUT_FFMPEG_DIR";

/// The FFmpeg programs every media task runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FfmpegTools {
    /// Full path of the `ffmpeg` executable.
    pub ffmpeg: PathBuf,
    /// Full path of the `ffprobe` executable.
    pub ffprobe: PathBuf,
    /// The version FFmpeg reports, e.g. `9.0.2-full_build-www.gyan.dev`.
    pub version: String,
}

fn exe_name(base: &str) -> String {
    if cfg!(windows) { format!("{base}.exe") } else { base.to_string() }
}

/// `Some((ffmpeg, ffprobe))` when both programs are in `dir`.
fn pair_in(dir: &Path) -> Option<(PathBuf, PathBuf)> {
    let ffmpeg = dir.join(exe_name("ffmpeg"));
    let ffprobe = dir.join(exe_name("ffprobe"));
    (ffmpeg.is_file() && ffprobe.is_file()).then_some((ffmpeg, ffprobe))
}

/// The folders searched, in order, for the given explicit folder.
fn candidate_dirs(explicit: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(d) = explicit {
        dirs.push(d.to_path_buf());
    }
    if let Some(d) = std::env::var_os(FFMPEG_DIR_ENV).filter(|v| !v.is_empty()) {
        dirs.push(PathBuf::from(d));
    }
    if let Some(exe_dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        dirs.push(exe_dir.clone());
        dirs.push(exe_dir.join("ffmpeg"));
        dirs.push(exe_dir.join("ffmpeg").join("bin"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs
}

/// The version from the first line of `ffmpeg -version` ("ffmpeg version X Copyright ...").
pub(crate) fn parse_version(first_line: &str) -> Option<String> {
    let rest = first_line.trim().strip_prefix("ffmpeg version ")?;
    rest.split_whitespace().next().map(str::to_string)
}

impl FfmpegTools {
    /// Finds FFmpeg and ffprobe (see the module comment for the order) and reads the version.
    /// An explicit folder that does not hold both programs is an error, not skipped.
    pub fn locate(explicit_dir: Option<&Path>) -> Result<FfmpegTools, AppError> {
        if let Some(dir) = explicit_dir
            && pair_in(dir).is_none()
        {
            return Err(AppError::internal("FFmpeg was not found in the given folder")
                .with_detail(format!("no ffmpeg and ffprobe in {}", dir.display())));
        }
        let found = candidate_dirs(explicit_dir).iter().find_map(|d| pair_in(d));
        let Some((ffmpeg, ffprobe)) = found else {
            return Err(AppError::internal("FFmpeg was not found").with_detail(format!(
                "looked in {FFMPEG_DIR_ENV}, next to the app and on PATH for ffmpeg and ffprobe"
            )));
        };
        Self::from_paths(ffmpeg, ffprobe)
    }

    /// Uses these two programs as they are, after checking that `ffmpeg -version` runs.
    pub fn from_paths(ffmpeg: PathBuf, ffprobe: PathBuf) -> Result<FfmpegTools, AppError> {
        let out = hidden_command(&ffmpeg).arg("-hide_banner").arg("-version").output().map_err(|e| {
            AppError::internal("FFmpeg could not be started").with_detail(format!("{}: {e}", ffmpeg.display()))
        })?;
        let text = String::from_utf8_lossy(&out.stdout);
        let first = text.lines().next().unwrap_or_default();
        let version = parse_version(first).ok_or_else(|| {
            AppError::new(ErrorCode::Internal, "FFmpeg did not report a version")
                .with_detail(format!("{}: {first}", ffmpeg.display()))
        })?;
        Ok(FfmpegTools { ffmpeg, ffprobe, version })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_read_from_the_first_line() {
        assert_eq!(
            parse_version("ffmpeg version 9.0.2-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers"),
            Some("9.0.2-full_build-www.gyan.dev".to_string())
        );
        assert_eq!(parse_version("something else"), None);
    }

    #[test]
    fn explicit_folder_comes_first_and_exe_folder_before_path() {
        let dirs = candidate_dirs(Some(Path::new("C:/explicit")));
        assert_eq!(dirs[0], PathBuf::from("C:/explicit"));
        let exe_dir = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
        let pos = |p: &PathBuf| dirs.iter().position(|d| d == p).unwrap();
        assert!(pos(&exe_dir) < pos(&exe_dir.join("ffmpeg")));
        assert!(pos(&exe_dir.join("ffmpeg")) < pos(&exe_dir.join("ffmpeg").join("bin")));
    }

    #[test]
    fn explicit_folder_without_ffmpeg_is_an_error() {
        let err = FfmpegTools::locate(Some(Path::new("C:/definitely/not/here"))).unwrap_err();
        assert_eq!(err.code, ErrorCode::Internal);
    }

    #[test]
    fn finds_ffmpeg_on_path_and_reports_version() {
        let tools = FfmpegTools::locate(None).expect("ffmpeg on PATH (source tools/env.sh)");
        assert!(tools.ffmpeg.is_file() && tools.ffprobe.is_file());
        assert!(!tools.version.is_empty());
        // The folder found that way also works when passed explicitly.
        let dir = tools.ffmpeg.parent().unwrap();
        assert_eq!(FfmpegTools::locate(Some(dir)).unwrap().ffmpeg, tools.ffmpeg);
    }
}
