//! Encode clip (spec 3.5.9): one clip of the sequence to one video piece.
//!
//! The method of the export experiment (RESULT.md section 6): a fast seek up to one second
//! before the clip, `-copyts`, the `fps` filter onto the sequence grid (which also turns a
//! variable frame rate into a constant one), `trim` on frame slots (never seconds), and NVENC
//! with the same settings for every piece. Exact at both edges whether or not they are
//! keyframes. A source that ends before the clip does is padded by repeating its last frame,
//! so every piece has exactly the frames the sequence says.
//!
//! Decoding is on the GPU (NVDEC, frames stay in GPU memory) when the source allows it, with a
//! fallback to the processor when the GPU cannot decode it; the encoder is always NVENC.

use std::path::Path;

use rc_types::{AppError, BitDepth, Clip, ErrorCode, OutputCodec, OutputFormat, Rational};
use rc_types::grid::{micros_to_frame_floor, snap_to_frame};

use super::settings::{SEEK_PREROLL_SECONDS, fit_inside, frames_to_seconds, timescale, video_settings};
use super::source::{OutputColor, PreparedSource};
use crate::probe::check_exists;
use crate::process::{CancelToken, ManagedChild, RunFailure, RunSpec, TaskProgress, hidden_command, run_ffmpeg};
use crate::tools::FfmpegTools;

/// A clip as frames of the sequence grid: `frames` frames of its source starting at
/// `start_frame` (frame 0 is the source's first video frame).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClipFrames {
    /// First frame, on the sequence grid.
    pub start_frame: i64,
    /// Number of frames, at least 1.
    pub frames: i64,
}

impl ClipFrames {
    /// The frames a [`Clip`] covers on the grid of `rate` (its edges snapped to the grid,
    /// which they already are by spec 3.4 rule 1). `None` for a clip of no frames.
    pub fn from_clip(clip: &Clip, rate: Rational) -> Option<ClipFrames> {
        let start = micros_to_frame_floor(snap_to_frame(clip.start.max(0), rate), rate);
        let end = micros_to_frame_floor(snap_to_frame(clip.end.max(0), rate), rate);
        (end > start).then_some(ClipFrames { start_frame: start, frames: end - start })
    }
}

/// How a piece's source is decoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DecodeChoice {
    /// On the GPU when the source allows it, the processor if that fails.
    #[default]
    Auto,
    /// On the processor only (a source the GPU already failed on).
    SoftwareOnly,
}

/// One clip to encode.
#[derive(Debug, Clone)]
pub struct PieceRequest<'a> {
    /// The clip's source.
    pub source: &'a PreparedSource,
    /// Which of its frames.
    pub clip: ClipFrames,
    /// The export's format; every piece of one export uses the same.
    pub format: &'a OutputFormat,
    /// Colour signalling written on the piece (the first clip's source's).
    pub color: &'a OutputColor,
    /// Where the piece goes (a temporary folder). Removed again if the task fails.
    pub output: &'a Path,
    /// GPU or processor decoding.
    pub decode: DecodeChoice,
    /// Test hook: the GPU decode attempt fails as a missing GPU decoder would.
    #[doc(hidden)]
    pub simulate_gpu_decode_failure: bool,
    /// Test hook: the encoder fails as a missing NVENC would.
    #[doc(hidden)]
    pub simulate_encoder_failure: bool,
}

/// How a piece was made.
#[derive(Debug, Clone, PartialEq)]
pub struct PieceOutcome {
    /// True when NVDEC decoded the source.
    pub gpu_decoded: bool,
    /// Why GPU decoding failed, when the processor had to take over.
    pub gpu_decode_failure: Option<AppError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Route {
    /// NVDEC, frames stay on the GPU, `scale_cuda` when the size or bit depth differs.
    GpuDecode,
    /// Processor decode and filters, NVENC.
    SoftwareDecode,
}

/// SDR BT.709 from HDR (PQ or HLG), as the proxy does.
const HDR_TO_SDR: &str =
    "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv";
/// SDR BT.709 placed into PQ BT.2020 with SDR white at 100 nits.
const SDR_TO_HDR: &str =
    "zscale=tin=bt709:min=bt709:pin=bt709:t=linear:npl=100,format=gbrpf32le,zscale=p=bt2020:t=smpte2084:m=bt2020nc:r=tv:npl=100";

fn ten_bit(f: &OutputFormat) -> bool {
    f.bit_depth == BitDepth::Ten
}

/// Whether NVDEC can decode this source for this output with the frames kept on the GPU:
/// H.264 (8-bit), HEVC, AV1 or VP9 in 4:2:0, not rotated, square pixels, the same HDR
/// signalling as the output and the same shape (no black bars needed).
pub(crate) fn gpu_decodable(src: &PreparedSource, format: &OutputFormat) -> bool {
    let ins = &src.ins;
    let codec_ok = match ins.codec.as_str() {
        "h264" => ins.bit_depth == BitDepth::Eight,
        "hevc" | "av1" | "vp9" => true,
        _ => false,
    };
    codec_ok
        && ins.is_420()
        && ins.rotation == 0
        && (ins.width, ins.height) == (ins.display_width, ins.display_height)
        && ins.hdr == format.hdr
        && fit_inside(ins.display_width, ins.display_height, format.width, format.height) == (format.width, format.height)
}

/// The `-vf` chain of a piece.
pub(crate) fn piece_filter(src: &PreparedSource, req_clip: ClipFrames, format: &OutputFormat, route: Route) -> String {
    let r = format.frame_rate;
    let (k, n) = (req_clip.start_frame, req_clip.frames);
    let mut f = vec![
        format!("fps={}/{}", r.num, r.den),
        // Only acts if the source ends early: repeats the last frame so trim still gets n frames.
        format!("tpad=stop_mode=clone:stop={n}"),
        format!("trim=start_pts={k}:end_pts={}", k + n),
        "setpts=PTS-STARTPTS".to_string(),
    ];
    let ins = &src.ins;
    let (w, h) = (format.width, format.height);
    let out_fmt = if ten_bit(format) { "p010le" } else { "yuv420p" };
    match route {
        Route::GpuDecode => {
            let same_size = (ins.width, ins.height) == (w, h);
            if !same_size || ins.bit_depth != format.bit_depth {
                let cuda_fmt = if ten_bit(format) { "p010le" } else { "nv12" };
                f.push(format!("scale_cuda=w={w}:h={h}:format={cuda_fmt}:interp_algo=lanczos"));
            }
        }
        Route::SoftwareDecode => {
            let (sw, sh) = fit_inside(ins.display_width, ins.display_height, w, h);
            if (ins.display_width, ins.display_height) != (sw, sh) || (ins.width, ins.height) != (sw, sh) {
                f.push(format!("scale={sw}:{sh}:flags=lanczos"));
            }
            if (sw, sh) != (w, h) {
                f.push(format!("pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black"));
            }
            f.push("setsar=1".to_string());
            if ins.hdr && !format.hdr {
                f.push(HDR_TO_SDR.to_string());
            } else if !ins.hdr && format.hdr {
                f.push(SDR_TO_HDR.to_string());
            }
            f.push(format!("format={out_fmt}"));
        }
    }
    f.join(",")
}

/// Seek pre-rolls (seconds before the clip) tried in turn while a fast seek lands after the
/// clip's first frame; `None` decodes from the start of the file. A fast seek lands on the
/// keyframe before the target in files with a seek index (MP4, MOV, Matroska), but MPEG-TS
/// (.ts, .m2ts, .mts) and other index-less files land on the keyframe after it.
pub(crate) const PREROLL_LADDER: [Option<f64>; 5] = [Some(SEEK_PREROLL_SECONDS), Some(4.0), Some(15.0), Some(60.0), None];

/// Whether a fast seek in this source's container may land after its target (no seek index).
pub(crate) fn seek_may_land_late(src: &PreparedSource) -> bool {
    matches!(src.ins.container.as_str(), "mpegts" | "mpeg" | "mpegvideo" | "h264" | "hevc" | "m4v" | "flv" | "avs2" | "vvc")
}

/// The `-ss` value (seconds from the container's start) of an attempt with `preroll`, or
/// `None` for no seek.
pub(crate) fn seek_seconds(src: &PreparedSource, clip: ClipFrames, rate: Rational, preroll: Option<f64>) -> Option<f64> {
    let start_s = frames_to_seconds(clip.start_frame, rate);
    preroll.map(|p| (src.ins.start_offset + start_s - p).max(0.0))
}

/// The input options shared by a piece and the seek check: shift to the first video frame,
/// fast seek, keep the timestamps.
fn input_args(src: &PreparedSource, seek: Option<f64>) -> Vec<String> {
    let mut a = Vec::new();
    // Frame slots count from the source's first video frame: shift a non-zero start to 0.
    if src.video_start.abs() >= 0.000_000_5 {
        a.extend(["-itsoffset".to_string(), format!("{:.6}", -src.video_start)]);
    }
    if let Some(seek) = seek {
        a.extend(["-noaccurate_seek".to_string(), "-ss".to_string(), format!("{seek:.6}")]);
    }
    a.extend(["-copyts".to_string(), "-i".to_string(), src.path.to_string_lossy().into_owned()]);
    a
}

/// Time (seconds, frame slots' clock) of the first frame FFmpeg decodes after the seek.
fn first_frame_time(tools: &FfmpegTools, src: &PreparedSource, seek: f64, cancel: &CancelToken) -> Result<Option<f64>, AppError> {
    let mut cmd = hidden_command(&tools.ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-nostats", "-loglevel", "info"]);
    cmd.args(input_args(src, Some(seek)));
    cmd.args(["-map", &format!("0:{}", src.ins.video_stream), "-an", "-sn", "-dn", "-vf", "showinfo", "-frames:v", "1", "-f", "null", "-"]);
    let child = ManagedChild::spawn(cmd, cancel.clone()).map_err(|f| f.into_app_error(ErrorCode::ExportFailed, "FFmpeg could not be started"))?;
    match child.wait_with_tail() {
        Err(RunFailure::Cancelled) => Err(RunFailure::Cancelled.into_app_error(ErrorCode::Cancelled, "")),
        Err(_) => Ok(None),
        Ok(text) => Ok(text
            .lines()
            .filter(|l| l.contains("showinfo") && l.contains(" n:"))
            .find_map(|l| l.split("pts_time:").nth(1)?.split_whitespace().next()?.parse::<f64>().ok())),
    }
}

/// The first rung of [`PREROLL_LADDER`] worth encoding with. For a source whose fast seek may
/// land late, a one-frame decode checks each rung until the first decoded frame is at or before
/// the clip's first frame. Other sources start at the first rung.
fn choose_preroll(tools: &FfmpegTools, req: &PieceRequest<'_>, cancel: &CancelToken) -> Result<usize, AppError> {
    if !seek_may_land_late(req.source) {
        return Ok(0);
    }
    let rate = req.format.frame_rate;
    // The fps filter rounds a frame to its nearest slot: a frame up to 0.4 slot late still
    // fills the clip's first slot.
    let limit = frames_to_seconds(req.clip.start_frame, rate) + 0.4 * frames_to_seconds(1, rate);
    for (step, preroll) in PREROLL_LADDER.iter().enumerate() {
        let Some(seek) = seek_seconds(req.source, req.clip, rate, *preroll) else { return Ok(step) };
        if seek <= 0.0 {
            return Ok(step);
        }
        match first_frame_time(tools, req.source, seek, cancel)? {
            Some(t) if t > limit => continue,
            _ => return Ok(step),
        }
    }
    Ok(PREROLL_LADDER.len() - 1)
}

/// The full FFmpeg argument list (after the runner's global options) of one attempt, with the
/// first rung of [`PREROLL_LADDER`].
#[cfg(test)]
pub(crate) fn piece_args(req: &PieceRequest<'_>, route: Route, out: &Path) -> Vec<String> {
    piece_args_with(req, route, out, PREROLL_LADDER[0])
}

/// The full FFmpeg argument list (after the runner's global options) of one attempt.
pub(crate) fn piece_args_with(req: &PieceRequest<'_>, route: Route, out: &Path, preroll: Option<f64>) -> Vec<String> {
    let src = req.source;
    let r = req.format.frame_rate;
    let mut a: Vec<String> = vec!["-y".into()];
    let push = |a: &mut Vec<String>, items: &[&str]| a.extend(items.iter().map(|s| s.to_string()));
    if route == Route::GpuDecode {
        push(&mut a, &["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]);
        if req.simulate_gpu_decode_failure {
            push(&mut a, &["-hwaccel_device", "63"]);
        }
    }
    // -ss is relative to the container's start; land `preroll` before the clip.
    a.extend(input_args(src, seek_seconds(src, req.clip, r, preroll)));
    push(&mut a, &["-map",&format!("0:{}", src.ins.video_stream), "-an", "-sn", "-dn"]);
    push(&mut a, &["-vf", &piece_filter(src, req.clip, req.format, route)]);
    push(&mut a, &["-frames:v", &req.clip.frames.to_string(), "-fps_mode", "passthrough"]);
    a.extend(video_settings(req.format.codec, ten_bit(req.format)));
    if req.simulate_encoder_failure {
        // An NVENC device that does not exist: fails exactly like a missing GPU.
        push(&mut a, &["-gpu", "63"]);
    }
    a.extend(req.color.args());
    let ts = timescale(r).to_string();
    push(&mut a, &["-video_track_timescale", &ts, "-movie_timescale", &ts, "-map_metadata", "-1", "-f", "mp4"]);
    a.push(out.to_string_lossy().into_owned());
    a
}

/// Whether FFmpeg's error output says the GPU encoder itself failed.
pub(crate) fn encoder_failed(stderr: &str) -> bool {
    let l = stderr.to_ascii_lowercase();
    l.contains("nvenc") || l.contains("nvcuda") || l.contains("no capable devices") || l.contains("cuda_error")
        || l.contains("openencodesession") || l.contains("gpus are available")
}

fn classify(f: RunFailure) -> AppError {
    let gpu = matches!(&f, RunFailure::Failed { stderr_tail, .. } if encoder_failed(stderr_tail));
    let e = f.into_app_error(ErrorCode::ExportFailed, "A clip could not be encoded");
    if gpu && e.code == ErrorCode::ExportFailed {
        return AppError { code: ErrorCode::GpuUnavailable, message: "The GPU encoder (NVENC) could not start".into(), detail: e.detail };
    }
    e
}

/// Number of video packets in a finished piece (one per frame).
pub(crate) fn count_video_packets(tools: &FfmpegTools, file: &Path) -> Result<u64, AppError> {
    let out = hidden_command(&tools.ffprobe)
        .args(["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0"])
        .arg(file)
        .output()
        .map_err(|e| AppError::internal("ffprobe could not be started").with_detail(e.to_string()))?;
    // HDR streams print their side data as further fields ("90,"): the count is the first.
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().next().unwrap_or("").split(',').next().unwrap_or("").trim().to_string();
    first.parse::<u64>().map_err(|_| {
        AppError::new(ErrorCode::ExportFailed, "A finished piece could not be read")
            .with_detail(format!("{}: {}", file.display(), String::from_utf8_lossy(&out.stderr).trim()))
    })
}

/// Encodes one clip into one piece, then checks it has exactly `clip.frames` frames.
/// Errors: `source_missing`, `cancelled`, `disk_full`, `gpu_unavailable` (NVENC could not
/// start, FFmpeg's error tail as the detail), `export_failed` (with the error tail).
pub fn encode_clip(
    tools: &FfmpegTools,
    req: &PieceRequest<'_>,
    cancel: &CancelToken,
    on_progress: &mut dyn FnMut(TaskProgress),
) -> Result<PieceOutcome, AppError> {
    check_exists(&req.source.path)?;
    if req.clip.frames < 1 {
        return Err(AppError::internal("A clip with no frames cannot be encoded"));
    }
    let duration = rc_types::grid::frame_to_micros(req.clip.frames, req.format.frame_rate);
    // (The encoder-failure hook needs frames in system memory: with GPU frames NVENC takes the
    // decoder's device and ignores `-gpu`.)
    let gpu_ok = req.decode == DecodeChoice::Auto && !req.simulate_encoder_failure;
    let mut routes: &[Route] = if gpu_ok && gpu_decodable(req.source, req.format) {
        &[Route::GpuDecode, Route::SoftwareDecode]
    } else {
        &[Route::SoftwareDecode]
    };
    let mut gpu_decode_failure = None;
    let mut step = choose_preroll(tools, req, cancel)?;
    loop {
        let preroll = PREROLL_LADDER[step];
        let mut made = None;
        for &route in routes {
            let args = piece_args_with(req, route, req.output, preroll);
            let spec = RunSpec { duration, cancel, partial_outputs: vec![req.output.to_path_buf()] };
            match run_ffmpeg(tools, &args, spec, on_progress) {
                Ok(()) => {
                    made = Some(route);
                    break;
                }
                Err(RunFailure::Cancelled) => return Err(RunFailure::Cancelled.into_app_error(ErrorCode::Cancelled, "")),
                Err(f) => {
                    let e = classify(f);
                    if e.code == ErrorCode::DiskFull || route == Route::SoftwareDecode {
                        return Err(e);
                    }
                    gpu_decode_failure = Some(e);
                }
            }
        }
        let Some(route) = made else {
            return Err(gpu_decode_failure.unwrap_or_else(|| AppError::new(ErrorCode::ExportFailed, "A clip could not be encoded")));
        };
        if route == Route::SoftwareDecode {
            routes = &[Route::SoftwareDecode];
        }
        let got = count_video_packets(tools, req.output)?;
        if got == req.clip.frames as u64 {
            return Ok(PieceOutcome { gpu_decoded: route == Route::GpuDecode, gpu_decode_failure });
        }
        let _ = std::fs::remove_file(req.output);
        // Too few frames after a seek: it landed after the clip's first frame. Seek further back.
        let seeked = seek_seconds(req.source, req.clip, req.format.frame_rate, preroll).is_some_and(|s| s > 0.0);
        if got < req.clip.frames as u64 && seeked && step + 1 < PREROLL_LADDER.len() {
            step += 1;
            continue;
        }
        return Err(AppError::new(ErrorCode::ExportFailed, "A clip came out with the wrong number of frames")
            .with_detail(format!("{}: {got} frames, expected {}", req.source.path.display(), req.clip.frames)));
    }
}

/// For error messages and tests: the output codec's FFmpeg name.
pub(crate) fn codec_name(codec: OutputCodec) -> &'static str {
    match codec {
        OutputCodec::H264 => "h264",
        OutputCodec::Hevc => "hevc",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::source::prepared_from_json;
    use crate::probe::{inspect_from_json, media_info};

    fn source(codec: &str, w: u32, h: u32, pix: &str, transfer: &str) -> PreparedSource {
        let json = format!(
            r#"{{"streams":[{{"index":0,"codec_type":"video","codec_name":"{codec}","width":{w},"height":{h},"pix_fmt":"{pix}","r_frame_rate":"60/1","avg_frame_rate":"60/1","time_base":"1/15360","start_time":"0.0","duration":"10.0","color_transfer":"{transfer}"}},
               {{"index":1,"codec_type":"audio","codec_name":"aac","channels":2,"sample_rate":"48000","start_time":"0.0","duration":"10.0"}}],
              "format":{{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","start_time":"0.0","duration":"10.0"}}}}"#
        );
        let ins = inspect_from_json(json.as_bytes(), Path::new("C:/v/src.mp4")).unwrap();
        let media = media_info(&ins, Rational { num: 60, den: 1 }, false);
        prepared_from_json(json.as_bytes(), Path::new("C:/v/src.mp4"), &media).unwrap()
    }

    fn format(codec: OutputCodec, w: u32, h: u32, depth: BitDepth, hdr: bool) -> OutputFormat {
        OutputFormat { codec, width: w, height: h, frame_rate: Rational { num: 30, den: 1 }, bit_depth: depth, hdr, audio_tracks: 1 }
    }

    #[test]
    fn clips_become_grid_frames() {
        let r = Rational { num: 30000, den: 1001 };
        let clip = |s, e| Clip { id: "c".into(), source_id: "s".into(), start: s, end: e };
        let f = ClipFrames::from_clip(&clip(rc_types::grid::frame_to_micros(100, r), rc_types::grid::frame_to_micros(400, r)), r);
        assert_eq!(f, Some(ClipFrames { start_frame: 100, frames: 300 }));
        assert_eq!(ClipFrames::from_clip(&clip(5_000, 5_000), r), None);
        // Slightly off the grid: snapped.
        assert_eq!(ClipFrames::from_clip(&clip(33_400, 66_700), Rational { num: 30, den: 1 }), Some(ClipFrames { start_frame: 1, frames: 1 }));
    }

    #[test]
    fn piece_command_matches_the_experiment() {
        let src = source("h264", 3840, 2160, "yuv420p", "bt709");
        let fmt = format(OutputCodec::H264, 3840, 2160, BitDepth::Eight, false);
        let color = OutputColor::default();
        let out = Path::new("C:/w/piece_00000.mp4");
        let req = PieceRequest {
            source: &src,
            clip: ClipFrames { start_frame: 100, frames: 300 },
            format: &fmt,
            color: &color,
            output: out,
            decode: DecodeChoice::Auto,
            simulate_gpu_decode_failure: false,
            simulate_encoder_failure: false,
        };
        assert!(gpu_decodable(&src, &fmt));
        let a = piece_args(&req, Route::GpuDecode, out).join(" ");
        assert_eq!(
            a,
            "-y -hwaccel cuda -hwaccel_output_format cuda -noaccurate_seek -ss 2.333333 -copyts -i C:/v/src.mp4 -map 0:0 -an -sn -dn \
             -vf fps=30/1,tpad=stop_mode=clone:stop=300,trim=start_pts=100:end_pts=400,setpts=PTS-STARTPTS -frames:v 300 \
             -fps_mode passthrough -c:v h264_nvenc -preset p4 -tune hq -rc vbr -cq 19 -b:v 0 -bf 3 -b_ref_mode disabled \
             -spatial-aq 1 -temporal-aq 1 -rc-lookahead 32 -g 60 -maxrate 240M -bufsize 300M -profile:v high \
             -video_track_timescale 15360 -movie_timescale 15360 -map_metadata -1 -f mp4 C:/w/piece_00000.mp4"
        );
        // Clip at the start: no negative seek.
        let req0 = PieceRequest { clip: ClipFrames { start_frame: 10, frames: 1 }, ..req.clone() };
        assert!(piece_args(&req0, Route::SoftwareDecode, out).join(" ").contains("-ss 0.000000 -copyts"));
        // Further back for a seek that landed late, and no seek at all on the last rung.
        assert!(piece_args_with(&req, Route::GpuDecode, out, Some(4.0)).join(" ").contains("-noaccurate_seek -ss 0.000000 -copyts"));
        let req_far = PieceRequest { clip: ClipFrames { start_frame: 900, frames: 30 }, ..req.clone() };
        assert!(piece_args_with(&req_far, Route::GpuDecode, out, Some(15.0)).join(" ").contains("-noaccurate_seek -ss 15.000000 -copyts"));
        let none = piece_args_with(&req_far, Route::GpuDecode, out, None).join(" ");
        assert!(!none.contains("-ss") && none.contains("cuda -copyts -i C:/v/src.mp4"), "{none}");
        assert!(!seek_may_land_late(&src));
    }

    #[test]
    fn transport_streams_are_seeked_with_care() {
        let json = r#"{"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":1280,"height":720,"pix_fmt":"yuv420p","r_frame_rate":"30/1","avg_frame_rate":"30/1","time_base":"1/90000","start_time":"1.466667","duration":"12.0"}],
              "format":{"format_name":"mpegts","start_time":"1.445333","duration":"12.0"}}"#;
        let p = Path::new("C:/v/cam.m2ts");
        let ins = inspect_from_json(json.as_bytes(), p).unwrap();
        let media = media_info(&ins, Rational { num: 30, den: 1 }, false);
        let src = prepared_from_json(json.as_bytes(), p, &media).unwrap();
        assert!(seek_may_land_late(&src));
        let s = seek_seconds(&src, ClipFrames { start_frame: 100, frames: 50 }, Rational { num: 30, den: 1 }, Some(1.0)).unwrap();
        // 0.021334 s from the container's start to the picture, plus 100/30 s, minus 1 s.
        assert!((s - (0.021334 + 100.0 / 30.0 - 1.0)).abs() < 1e-5, "{s}");
    }

    #[test]
    fn mixed_sources_are_scaled_on_the_gpu_or_padded_on_the_processor() {
        let fmt = format(OutputCodec::H264, 3840, 2160, BitDepth::Eight, false);
        let hd = source("h264", 1920, 1080, "yuv420p", "bt709");
        assert!(gpu_decodable(&hd, &fmt));
        let f = piece_filter(&hd, ClipFrames { start_frame: 0, frames: 10 }, &fmt, Route::GpuDecode);
        assert!(f.ends_with("scale_cuda=w=3840:h=2160:format=nv12:interp_algo=lanczos"), "{f}");
        // 4:3 needs black bars: processor path.
        let sd = source("h264", 1440, 1080, "yuv420p", "bt709");
        assert!(!gpu_decodable(&sd, &fmt));
        let f = piece_filter(&sd, ClipFrames { start_frame: 0, frames: 10 }, &fmt, Route::SoftwareDecode);
        assert!(f.contains("scale=2880:2160:flags=lanczos,pad=3840:2160:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p"), "{f}");
        // HDR into SDR is tone-mapped on the processor; 4:2:2 is never decoded on the GPU.
        let hdr = source("hevc", 3840, 2160, "yuv420p10le", "smpte2084");
        assert!(!gpu_decodable(&hdr, &fmt));
        assert!(piece_filter(&hdr, ClipFrames { start_frame: 0, frames: 1 }, &fmt, Route::SoftwareDecode).contains("tonemap=hable"));
        assert!(!gpu_decodable(&source("hevc", 3840, 2160, "yuv422p10le", "bt709"), &format(OutputCodec::Hevc, 3840, 2160, BitDepth::Ten, false)));
        // Same size, 8-bit source into a 10-bit output: format conversion on the GPU.
        let ten = format(OutputCodec::Hevc, 3840, 2160, BitDepth::Ten, false);
        let src = source("h264", 3840, 2160, "yuv420p", "bt709");
        assert!(piece_filter(&src, ClipFrames { start_frame: 0, frames: 1 }, &ten, Route::GpuDecode).contains("format=p010le"));
        // No scaling at all when everything matches.
        assert!(!piece_filter(&src, ClipFrames { start_frame: 0, frames: 1 }, &fmt, Route::GpuDecode).contains("scale"));
    }

    #[test]
    fn encoder_failures_are_recognised() {
        assert!(encoder_failed("[h264_nvenc @ 0000] OpenEncodeSessionEx failed: unsupported device (2): (no details)"));
        assert!(encoder_failed("[hevc_nvenc @ 01] Requested GPU 63, but only 1 GPUs are available!"));
        assert!(!encoder_failed("C:/x.mp4: No such file or directory"));
        assert_eq!(codec_name(OutputCodec::Hevc), "hevc");
    }
}
