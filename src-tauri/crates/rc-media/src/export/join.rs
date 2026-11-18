//! Join (spec 3.5.9): the pieces and the rendered sound into the MP4, without re-encoding the
//! picture. The concat demuxer joins the pieces (`-c:v copy`) with each piece's exact length
//! in the list, the sound is encoded to AAC per track, and the file is written to
//! `<destination>.part` and renamed onto the destination only when FFmpeg finished.

use std::path::Path;

use rc_types::{AppError, ErrorCode, OutputCodec, OutputFormat};

use super::settings::{EXPORT_AUDIO_RATE, frames_to_seconds, timescale};
use crate::process::{CancelToken, RunSpec, TaskProgress, commit, ensure_parent, in_progress_path, run_ffmpeg};
use crate::tools::FfmpegTools;

/// One encoded piece and its frame count.
#[derive(Debug, Clone, Copy)]
pub struct JoinPiece<'a> {
    /// The piece file.
    pub path: &'a Path,
    /// Its frames.
    pub frames: i64,
}

/// What to join, and where the result goes.
#[derive(Debug, Clone)]
pub struct JoinRequest<'a> {
    /// The pieces in playing order.
    pub pieces: &'a [JoinPiece<'a>],
    /// The rendered sound (one stream per track), or `None` when the export has no sound.
    pub audio: Option<&'a Path>,
    /// The export's format.
    pub format: &'a OutputFormat,
    /// Channels of each output track, for the AAC bit rate.
    pub track_channels: &'a [u32],
    /// Each output track's name (the first clip's track titles, "Lav mic"...), so the user's
    /// editing software shows which track is which. `None` or missing: no name.
    pub track_titles: &'a [Option<String>],
    /// Where the concat list is written (the temporary folder).
    pub list_file: &'a Path,
    /// The finished MP4. Nothing appears here unless the join succeeds.
    pub output: &'a Path,
}

/// The concat demuxer's list: one `file` and exact `duration` line per piece.
pub(crate) fn concat_list(pieces: &[JoinPiece<'_>], format: &OutputFormat) -> String {
    let mut s = String::new();
    for p in pieces {
        let path = p.path.to_string_lossy().replace('\\', "/").replace('\'', "'\\''");
        s.push_str(&format!("file '{path}'\nduration {:.6}\n", frames_to_seconds(p.frames, format.frame_rate)));
    }
    s
}

/// AAC bit rate of a track: 256 kb/s, more for more than four channels.
fn aac_rate(channels: u32) -> String {
    format!("{}k", (64 * channels).max(256))
}

/// The FFmpeg argument list (after the runner's global options).
pub(crate) fn join_args(req: &JoinRequest<'_>, out: &Path) -> Vec<String> {
    let ts = timescale(req.format.frame_rate).to_string();
    let mut a: Vec<String> = Vec::new();
    let push = |a: &mut Vec<String>, items: &[&str]| a.extend(items.iter().map(|s| s.to_string()));
    push(&mut a, &["-y", "-f", "concat", "-safe", "0", "-i", &req.list_file.to_string_lossy()]);
    if let Some(audio) = req.audio {
        push(&mut a, &["-i", &audio.to_string_lossy()]);
    }
    push(&mut a, &["-map", "0:v:0"]);
    let tracks = if req.audio.is_some() { req.format.audio_tracks as usize } else { 0 };
    for t in 0..tracks {
        push(&mut a, &["-map", &format!("1:a:{t}")]);
    }
    push(&mut a, &["-c:v", "copy"]);
    if req.format.codec == OutputCodec::Hevc {
        push(&mut a, &["-tag:v", "hvc1"]);
    }
    if tracks > 0 {
        push(&mut a, &["-c:a", "aac", "-ar", &EXPORT_AUDIO_RATE.to_string()]);
        for t in 0..tracks {
            let ch = req.track_channels.get(t).copied().unwrap_or(2);
            push(&mut a, &[&format!("-b:a:{t}"), &aac_rate(ch)]);
        }
    }
    push(
        &mut a,
        &["-video_track_timescale", &ts, "-movie_timescale", &ts, "-map_metadata", "-1", "-movflags", "+faststart", "-f", "mp4"],
    );
    // After -map_metadata -1 (which drops the pieces' and the sound file's tags): the names.
    for t in 0..tracks {
        if let Some(Some(title)) = req.track_titles.get(t)
            && !title.trim().is_empty()
        {
            // MP4 keeps a track name in two places; editors read one or the other.
            let key = format!("-metadata:s:a:{t}");
            push(&mut a, &[&key, &format!("title={}", title.trim()), &key, &format!("handler_name={}", title.trim())]);
        }
    }
    a.push(out.to_string_lossy().into_owned());
    a
}

/// Joins the pieces and the sound into `req.output` and returns its size in bytes. Errors:
/// `cancelled`, `disk_full`, `export_failed` (FFmpeg's error tail as detail), `internal`
/// when the finished file cannot be moved into place.
pub fn join(
    tools: &FfmpegTools,
    req: &JoinRequest<'_>,
    cancel: &CancelToken,
    on_progress: &mut dyn FnMut(TaskProgress),
) -> Result<u64, AppError> {
    if req.pieces.is_empty() {
        return Err(AppError::new(ErrorCode::NothingToExport, "There is nothing to join"));
    }
    ensure_parent(req.output)?;
    std::fs::write(req.list_file, concat_list(req.pieces, req.format)).map_err(|e| {
        AppError::new(ErrorCode::ExportFailed, "The list of pieces could not be written")
            .with_detail(format!("{}: {e}", req.list_file.display()))
    })?;
    let total: i64 = req.pieces.iter().map(|p| p.frames).sum();
    let duration = rc_types::grid::frame_to_micros(total, req.format.frame_rate);
    let part = in_progress_path(req.output);
    let args = join_args(req, &part);
    run_ffmpeg(tools, &args, RunSpec { duration, cancel, partial_outputs: vec![part.clone()] }, on_progress)
        .map_err(|f| f.into_app_error(ErrorCode::ExportFailed, "The pieces could not be joined"))?;
    if cancel.is_cancelled() {
        let _ = std::fs::remove_file(&part);
        return Err(AppError::new(ErrorCode::Cancelled, "Cancelled"));
    }
    commit(&part, req.output)?;
    Ok(std::fs::metadata(req.output).map(|m| m.len()).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rc_types::{BitDepth, Rational};

    #[test]
    fn list_and_command_match_the_experiment() {
        let f = OutputFormat {
            codec: OutputCodec::Hevc,
            width: 3840,
            height: 2160,
            frame_rate: Rational { num: 30, den: 1 },
            bit_depth: BitDepth::Ten,
            hdr: true,
            audio_tracks: 2,
        };
        let pieces = [JoinPiece { path: Path::new("C:\\w\\it's\\piece_00000.mp4"), frames: 300 }, JoinPiece { path: Path::new("C:/w/p1.mp4"), frames: 37 }];
        assert_eq!(
            concat_list(&pieces, &f),
            "file 'C:/w/it'\\''s/piece_00000.mp4'\nduration 10.000000\nfile 'C:/w/p1.mp4'\nduration 1.233333\n"
        );
        let req = JoinRequest {
            pieces: &pieces,
            audio: Some(Path::new("C:/w/audio.nut")),
            format: &f,
            track_channels: &[2, 1],
            track_titles: &[],
            list_file: Path::new("C:/w/pieces.txt"),
            output: Path::new("D:/out.mp4"),
        };
        assert_eq!(
            join_args(&req, Path::new("D:/out.mp4.part")).join(" "),
            "-y -f concat -safe 0 -i C:/w/pieces.txt -i C:/w/audio.nut -map 0:v:0 -map 1:a:0 -map 1:a:1 -c:v copy -tag:v hvc1 \
             -c:a aac -ar 48000 -b:a:0 256k -b:a:1 256k -video_track_timescale 15360 -movie_timescale 15360 -map_metadata -1 \
             -movflags +faststart -f mp4 D:/out.mp4.part"
        );
        // Found in the real app (e2e "edge-formats"): the tracks' names were dropped, so a
        // three-track export showed as three unnamed tracks in the user's editing software.
        let titles = [Some("Lav mic".to_string()), None];
        let named = JoinRequest { track_titles: &titles, ..req.clone() };
        let a = join_args(&named, Path::new("x")).join(" ");
        assert!(a.ends_with("-map_metadata -1 -movflags +faststart -f mp4 -metadata:s:a:0 title=Lav mic -metadata:s:a:0 handler_name=Lav mic x"), "{a}");
        assert!(!a.contains("s:a:1"), "{a}");
        let silent = JoinRequest { audio: None, ..req };
        let a = join_args(&silent, Path::new("x")).join(" ");
        assert!(!a.contains("1:a") && !a.contains("aac"), "{a}");
        assert_eq!(aac_rate(6), "384k");
    }
}
