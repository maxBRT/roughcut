//! Render audio (spec 3.5.9): every audio track of the whole sequence in one FFmpeg run.
//!
//! The script form of the export experiment (RESULT.md "Render audio"): the filter graph is
//! written to a file (`-/filter_complex <file>`), so the command line never grows with the
//! number of clips. One `amovie` per clip seeks a second before the clip; each track is put on
//! the source clock at 48 kHz (`aresample` with `async` and `first_pts`, so a track that starts
//! late keeps its delay and gaps are filled), cut with `atrim` in samples, padded to the
//! clip's exact sample count, and given 4 ms fades in and out. Clip edges in samples come from
//! the cumulative frame count, so the sound is exactly as long as the picture.
//!
//! Output tracks follow the first clip's source. A clip whose source has fewer tracks gets
//! silence on the missing ones; extra tracks of a later source are left out.

use std::path::Path;

use rc_types::{AppError, ErrorCode, OutputFormat, Rational};

use super::settings::{EXPORT_AUDIO_RATE, EXPORT_RAMP_SECONDS, SEEK_PREROLL_SECONDS, frame_to_sample, frames_to_seconds, sample_edges};
use super::source::PreparedSource;
use super::piece::ClipFrames;
use crate::probe::check_exists;
use crate::process::{CancelToken, RunSpec, TaskProgress, ensure_parent, run_ffmpeg};
use crate::tools::FfmpegTools;

/// One clip of the sequence, with its source.
#[derive(Debug, Clone, Copy)]
pub struct SequenceClip<'a> {
    /// The clip's source.
    pub source: &'a PreparedSource,
    /// Which of its frames.
    pub clip: ClipFrames,
}

/// The sound of a whole sequence.
#[derive(Debug, Clone)]
pub struct AudioRenderRequest<'a> {
    /// The sequence, in playing order.
    pub clips: &'a [SequenceClip<'a>],
    /// The export's format (frame rate and number of tracks).
    pub format: &'a OutputFormat,
    /// Channel layout of each output track (the first clip's source's tracks);
    /// `format.audio_tracks` entries.
    pub layouts: &'a [String],
    /// Where the filter graph script is written.
    pub script: &'a Path,
    /// Where the rendered tracks go: 32-bit float PCM in a NUT file, one stream per track.
    pub output: &'a Path,
}

/// Escapes `s` for one level of FFmpeg's filter syntax by putting a backslash before every
/// character in `special`.
fn escape(s: &str, special: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if special.contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// A file path as an option value inside a filter graph: escaped for the option parser
/// (`\`, `'`, `:`), then for the graph parser (`\`, `'`, `[`, `]`, `,`, `;`).
pub(crate) fn filter_path(path: &Path) -> String {
    let p = path.to_string_lossy().replace('\\', "/");
    escape(&escape(&p, "\\':"), "\\'[],;")
}

fn secs(x: f64) -> String {
    format!("{x:.6}")
}

/// The filter graph for the whole sequence (one line per filter chain).
pub(crate) fn audio_script(clips: &[SequenceClip<'_>], rate: Rational, layouts: &[String]) -> String {
    let frames: Vec<i64> = clips.iter().map(|c| c.clip.frames).collect();
    let edges = sample_edges(&frames, rate);
    let rate_hz = EXPORT_AUDIO_RATE as f64;
    let n_tracks = layouts.len();
    let mut lines = Vec::new();
    let mut labels = String::new();
    for (i, c) in clips.iter().enumerate() {
        let src = c.source;
        let samples = edges[i + 1] - edges[i];
        let dur = samples as f64 / rate_hz;
        let ramp = EXPORT_RAMP_SECONDS.min(dur / 2.0);
        let fades = format!("afade=t=in:d={},afade=t=out:st={}:d={}", secs(ramp), secs(dur - ramp), secs(ramp));
        // Raw source clock: the first video frame is at `video_start`.
        let a0 = (src.video_start * rate_hz).round() as i64 + frame_to_sample(c.clip.start_frame, rate);
        let used = n_tracks.min(src.audio_streams.len());
        if used > 0 {
            // amovie's seek_point counts from the container's start and lands at or before it.
            let start_s = frames_to_seconds(c.clip.start_frame, rate);
            let seek = (src.ins.start_offset + start_s - SEEK_PREROLL_SECONDS).max(0.0);
            let seek_txt = secs(seek);
            let seek_back: f64 = seek_txt.parse().unwrap_or(seek);
            let first_pts = ((src.format_start + seek_back) * rate_hz).floor() as i64;
            let streams: Vec<String> = src.audio_streams[..used].iter().map(|s| s.to_string()).collect();
            let outs: String = (0..used).map(|t| format!("[m{i}t{t}]")).collect();
            lines.push(format!(
                "amovie=filename={}:seek_point={seek_txt}:streams={}{outs}",
                filter_path(&src.path),
                streams.join("+")
            ));
            for (t, layout) in layouts.iter().enumerate().take(used) {
                lines.push(format!(
                    "[m{i}t{t}]aresample={EXPORT_AUDIO_RATE}:async=1:min_comp=0.00001:first_pts={first_pts},\
                     aformat=sample_fmts=fltp:channel_layouts={layout},asettb=1/{EXPORT_AUDIO_RATE},\
                     atrim=start_pts={a0}:end_pts={},apad=whole_len={samples},asetpts=PTS-STARTPTS,{fades}[c{i}t{t}]",
                    a0 + samples
                ));
            }
        }
        for (t, layout) in layouts.iter().enumerate().skip(used) {
            lines.push(format!(
                "anullsrc=r={EXPORT_AUDIO_RATE}:cl={layout},aformat=sample_fmts=fltp:channel_layouts={layout},\
                 atrim=end_sample={samples},asetpts=PTS-STARTPTS[c{i}t{t}]"
            ));
        }
        for t in 0..n_tracks {
            labels.push_str(&format!("[c{i}t{t}]"));
        }
    }
    let outs: String = (0..n_tracks).map(|t| format!("[o{t}]")).collect();
    lines.push(format!("{labels}concat=n={}:v=0:a={n_tracks}{outs}", clips.len()));
    lines.join(";\n") + "\n"
}

/// Renders every audio track of the sequence. Progress is by output time. Errors:
/// `source_missing`, `cancelled`, `disk_full`, `export_failed` (FFmpeg's error tail as detail).
pub fn render_audio(
    tools: &FfmpegTools,
    req: &AudioRenderRequest<'_>,
    cancel: &CancelToken,
    on_progress: &mut dyn FnMut(TaskProgress),
) -> Result<(), AppError> {
    if req.clips.is_empty() || req.layouts.is_empty() {
        return Err(AppError::internal("There is no sound to render"));
    }
    for c in req.clips {
        check_exists(&c.source.path)?;
    }
    ensure_parent(req.output)?;
    let script = audio_script(req.clips, req.format.frame_rate, req.layouts);
    std::fs::write(req.script, script).map_err(|e| {
        AppError::new(ErrorCode::ExportFailed, "The audio plan could not be written").with_detail(format!("{}: {e}", req.script.display()))
    })?;
    let total: i64 = req.clips.iter().map(|c| c.clip.frames).sum();
    let duration = rc_types::grid::frame_to_micros(total, req.format.frame_rate);
    let mut args: Vec<String> = vec!["-y".into(), "-/filter_complex".into(), req.script.to_string_lossy().into_owned()];
    for t in 0..req.layouts.len() {
        args.push("-map".into());
        args.push(format!("[o{t}]"));
    }
    args.extend(["-c:a", "pcm_f32le", "-f", "nut"].iter().map(|s| s.to_string()));
    args.push(req.output.to_string_lossy().into_owned());
    run_ffmpeg(tools, &args, RunSpec { duration, cancel, partial_outputs: vec![req.output.to_path_buf()] }, on_progress)
        .map_err(|f| f.into_app_error(ErrorCode::ExportFailed, "The sound could not be rendered"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::source::prepared_from_json;
    use crate::probe::{inspect_from_json, media_info};

    fn source(path: &str, tracks: usize) -> PreparedSource {
        let mut streams = vec![r#"{"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"pix_fmt":"yuv420p","r_frame_rate":"30/1","time_base":"1/15360","start_time":"0.0","duration":"60.0"}"#.to_string()];
        for t in 0..tracks {
            streams.push(format!(
                r#"{{"index":{},"codec_type":"audio","codec_name":"aac","channels":{},"sample_rate":"48000","start_time":"0.0","duration":"60.0"}}"#,
                t + 1,
                if t == 0 { 2 } else { 1 }
            ));
        }
        let json = format!(r#"{{"streams":[{}],"format":{{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","start_time":"0.0","duration":"60.0"}}}}"#, streams.join(","));
        let ins = inspect_from_json(json.as_bytes(), Path::new(path)).unwrap();
        let media = media_info(&ins, Rational { num: 30, den: 1 }, false);
        prepared_from_json(json.as_bytes(), Path::new(path), &media).unwrap()
    }

    #[test]
    fn paths_are_escaped_for_both_filter_levels() {
        assert_eq!(filter_path(Path::new("C:\\Users\\a\\b.mp4")), "C\\\\:/Users/a/b.mp4");
        // option level: it\'s  -> graph level: it\\\'s ; brackets and commas escaped once.
        assert_eq!(filter_path(Path::new("D:/it's [a], b;c.mp4")), "D\\\\:/it\\\\\\'s \\[a\\]\\, b\\;c.mp4");
    }

    #[test]
    fn script_matches_the_experiment_and_fills_missing_tracks() {
        let a = source("C:/m/A1.mp4", 2);
        let b = source("C:/m/B.mp4", 1);
        let r = Rational { num: 30, den: 1 };
        let clips = [
            SequenceClip { source: &a, clip: ClipFrames { start_frame: 100, frames: 300 } },
            SequenceClip { source: &b, clip: ClipFrames { start_frame: 0, frames: 1 } },
        ];
        let layouts = vec!["stereo".to_string(), "mono".to_string()];
        let s = audio_script(&clips, r, &layouts);
        let lines: Vec<&str> = s.lines().collect();
        assert_eq!(lines[0], "amovie=filename=C\\\\:/m/A1.mp4:seek_point=2.333333:streams=1+2[m0t0][m0t1];");
        assert_eq!(
            lines[1],
            "[m0t0]aresample=48000:async=1:min_comp=0.00001:first_pts=111999,aformat=sample_fmts=fltp:channel_layouts=stereo,\
             asettb=1/48000,atrim=start_pts=160000:end_pts=640000,apad=whole_len=480000,asetpts=PTS-STARTPTS,\
             afade=t=in:d=0.004000,afade=t=out:st=9.996000:d=0.004000[c0t0];"
        );
        assert!(lines[2].starts_with("[m0t1]aresample") && lines[2].contains("channel_layouts=mono"));
        // Second clip: no seek, one real track, silence on the second.
        assert_eq!(lines[3], "amovie=filename=C\\\\:/m/B.mp4:seek_point=0.000000:streams=1[m1t0];");
        assert!(lines[4].contains("first_pts=0,") && lines[4].contains("atrim=start_pts=0:end_pts=1600,apad=whole_len=1600"));
        assert!(lines[5].starts_with("anullsrc=r=48000:cl=mono,") && lines[5].contains("atrim=end_sample=1600") && lines[5].ends_with("[c1t1];"));
        assert_eq!(lines[6], "[c0t0][c0t1][c1t0][c1t1]concat=n=2:v=0:a=2[o0][o1]");
    }
}
