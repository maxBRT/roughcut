//! Proxy: the 1280×720 H.264 playback copy (spec 2.4.2; command from spikes/player/RESULT.md).
//!
//! - Picture: fitted inside 1280×720 keeping its shape (black bars where needed), rotation
//!   applied, HDR tone-mapped to SDR BT.709, 8-bit 4:2:0.
//! - Constant frame rate at the requested rate (variable-frame-rate sources keep wall-clock
//!   time: FFmpeg duplicates or drops frames), a keyframe every half second, no B-frames.
//! - Time zero is the source's first video frame (a non-zero start time is removed).
//! - Sound: every audio track mixed into one stereo AAC track (48 kHz, 128 kb/s).
//! - Encoding on the GPU (NVENC) with an automatic fallback to the processor (libx264).
//!   HEVC/AV1/VP9 4:2:0 sources are also decoded on the GPU, and if that fails the processor
//!   decodes for NVENC before libx264 is tried; H.264 (and 4:2:2) is decoded on the
//!   processor, which the player experiment measured as faster for 4K H.264.
//! - Written to `<output>.part` and renamed to `output` only when complete, unless the caller
//!   names the in-progress file itself ([`ProxyRequest::in_place`]; the cache does).

use std::path::Path;
use std::time::Instant;

use rc_types::{AppError, ErrorCode, MediaInfo, Rational};

use crate::probe::{Inspected, inspect};
use crate::process::{CancelToken, RunFailure, RunSpec, TaskProgress, commit, ensure_parent, in_progress_path, run_ffmpeg};
use crate::tools::FfmpegTools;

/// Proxy picture size.
pub const PROXY_WIDTH: u32 = 1280;
/// Proxy picture size.
pub const PROXY_HEIGHT: u32 = 720;
/// Seconds between proxy keyframes.
pub const PROXY_KEYFRAME_SECONDS: f64 = 0.5;

/// Which encoder the proxy uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EncoderChoice {
    /// GPU first, then the processor if the GPU attempt fails.
    #[default]
    Auto,
    /// The processor only (libx264).
    SoftwareOnly,
    /// The GPU only; a failure is reported as `gpu_unavailable`.
    GpuOnly,
}

/// What to make a proxy of, and where to put it.
#[derive(Debug, Clone)]
pub struct ProxyRequest<'a> {
    /// The original file.
    pub source: &'a Path,
    /// Its probe result.
    pub media: &'a MediaInfo,
    /// Where the finished proxy goes (the cache decides). Its folder is created if needed.
    pub output: &'a Path,
    /// The proxy's constant frame rate: the source's `media.video.frame_rate` (the spike's
    /// "source frame rate, rounded to the sequence frame rate").
    pub frame_rate: Rational,
    /// GPU, processor, or GPU with fallback.
    pub encoder: EncoderChoice,
    /// `output` is already the in-progress name chosen by the caller (the cache's partial
    /// path, spec 3.6 rule 5): write it directly, remove it on failure or cancel, and leave
    /// renaming it to the caller. When false, `<output>.part` is written and renamed.
    pub in_place: bool,
    /// Test hook: makes the GPU attempt fail as a broken driver would, to exercise the fallback.
    #[doc(hidden)]
    pub simulate_gpu_failure: bool,
}

impl<'a> ProxyRequest<'a> {
    /// A request with the usual choices: the source's own frame rate, GPU with fallback.
    pub fn new(source: &'a Path, media: &'a MediaInfo, output: &'a Path) -> ProxyRequest<'a> {
        ProxyRequest {
            source,
            media,
            output,
            frame_rate: media.video.frame_rate,
            encoder: EncoderChoice::Auto,
            in_place: false,
            simulate_gpu_failure: false,
        }
    }
}

/// How the proxy was made.
#[derive(Debug, Clone, PartialEq)]
pub struct ProxyOutcome {
    /// True when NVENC made it.
    pub used_gpu: bool,
    /// Why the GPU attempt failed, when the processor had to take over.
    pub gpu_failure: Option<AppError>,
    /// Wall-clock seconds for the whole task.
    pub took_seconds: f64,
}

/// The size the picture is scaled to inside the 1280×720 frame: the display shape kept,
/// both sides even.
pub(crate) fn fit_size(display_w: u32, display_h: u32) -> (u32, u32) {
    let aspect = display_w as f64 / display_h.max(1) as f64;
    let box_aspect = PROXY_WIDTH as f64 / PROXY_HEIGHT as f64;
    let even = |v: f64| ((v / 2.0).round() as u32 * 2).max(2);
    if (aspect - box_aspect).abs() < 0.001 {
        (PROXY_WIDTH, PROXY_HEIGHT)
    } else if aspect > box_aspect {
        (PROXY_WIDTH, even(PROXY_WIDTH as f64 / aspect).min(PROXY_HEIGHT))
    } else {
        (even(PROXY_HEIGHT as f64 * aspect).min(PROXY_WIDTH), PROXY_HEIGHT)
    }
}

/// Frames between keyframes at `rate` (half a second, at least 1).
pub(crate) fn gop(rate: Rational) -> u32 {
    ((rate.num as f64 / rate.den as f64) * PROXY_KEYFRAME_SECONDS).round().max(1.0) as u32
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Route {
    /// NVDEC + scale_cuda + NVENC.
    GpuDecode,
    /// Processor decode and scale + NVENC.
    GpuEncode,
    /// Processor decode, scale and libx264.
    Software,
}

/// `aresample` options that put a track on the output clock at 48 kHz: time zero is the
/// first video frame, a later start becomes leading silence.
const ON_CLOCK: &str = "48000:async=1:first_pts=0";

const TONEMAP: &str = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv";

/// The `-vf` chain for the picture.
pub(crate) fn video_filter(ins: &Inspected, path: Route) -> String {
    let (w, h) = fit_size(ins.display_width, ins.display_height);
    let mut f = Vec::new();
    if path == Route::GpuDecode {
        let fmt = if ins.hdr { "p010le" } else { "yuv420p" };
        f.push(format!("scale_cuda=w={w}:h={h}:format={fmt}:interp_algo=bilinear"));
        f.push(format!("hwdownload,format={fmt}"));
    } else {
        f.push(format!("scale={w}:{h}:flags=bilinear"));
    }
    if ins.hdr {
        f.push(TONEMAP.to_string());
    }
    f.push("format=yuv420p".to_string());
    if (w, h) != (PROXY_WIDTH, PROXY_HEIGHT) {
        f.push(format!("pad={PROXY_WIDTH}:{PROXY_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black"));
    }
    f.push("setsar=1".to_string());
    f.join(",")
}

fn rate_str(r: Rational) -> String {
    format!("{}/{}", r.num, r.den)
}

/// The full FFmpeg argument list (after the runner's global options) for one attempt.
pub(crate) fn proxy_args(ins: &Inspected, req: &ProxyRequest<'_>, path: Route, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    let push = |a: &mut Vec<String>, items: &[&str]| a.extend(items.iter().map(|s| s.to_string()));
    a.push("-y".into());
    if path == Route::GpuDecode {
        push(&mut a, &["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]);
    }
    if let Some(ss) = ins.seek_to_first_frame() {
        push(&mut a, &["-ss", &ss]);
    }
    push(&mut a, &["-i", &req.source.to_string_lossy()]);

    // Picture.
    push(&mut a, &["-map", &format!("0:{}", ins.video_stream), "-vf", &video_filter(ins, path)]);
    // Sound: all tracks to one stereo track. Each track is first put on the shared clock
    // (`async=1:first_pts=0` pads a late start with silence and fills gaps), because `amix`
    // ignores its inputs' start times and would pull a late track forward.
    let tracks = ins.audio.len();
    if tracks == 1 {
        push(&mut a, &["-map", "0:a:0", "-af", &format!("aresample={ON_CLOCK}")]);
    } else if tracks > 1 {
        let mut graph = String::new();
        for i in 0..tracks {
            graph.push_str(&format!(
                "[0:a:{i}]aresample={ON_CLOCK},aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}];"
            ));
        }
        for i in 0..tracks {
            graph.push_str(&format!("[a{i}]"));
        }
        graph.push_str(&format!(
            "amix=inputs={tracks}:duration=longest:normalize=0,alimiter=limit=0.95:level=disabled:latency=1[aout]"
        ));
        push(&mut a, &["-filter_complex", &graph, "-map", "[aout]"]);
    }

    let fr = rate_str(req.frame_rate);
    let g = gop(req.frame_rate).to_string();
    push(&mut a, &["-fps_mode", "cfr", "-r", &fr]);
    match path {
        Route::GpuDecode | Route::GpuEncode => {
            push(
                &mut a,
                &[
                    "-c:v", "h264_nvenc", "-preset", "p4", "-profile:v", "high", "-rc", "vbr", "-cq", "25", "-b:v", "2500k",
                    "-maxrate", "5M", "-bufsize", "5M", "-g", &g, "-keyint_min", &g, "-bf", "0", "-forced-idr", "1",
                ],
            );
            if req.simulate_gpu_failure {
                // An NVENC device that does not exist: fails exactly like a missing GPU.
                push(&mut a, &["-gpu", "63"]);
            }
        }
        Route::Software => push(
            &mut a,
            &[
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "high", "-g", &g, "-keyint_min", &g,
                "-bf", "0", "-sc_threshold", "0",
            ],
        ),
    }
    push(&mut a, &["-force_key_frames", &format!("expr:gte(t,n_forced*{PROXY_KEYFRAME_SECONDS})")]);
    if ins.hdr {
        push(&mut a, &["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]);
    }
    if tracks > 0 {
        push(&mut a, &["-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000"]);
    }
    push(&mut a, &["-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", "-f", "mp4"]);
    a.push(out.to_string_lossy().into_owned());
    a
}

/// Whether the source is decoded on the GPU in the GPU path: HEVC/AV1/VP9 in 4:2:0 (NVDEC on
/// this GPU cannot decode 4:2:2, the usual mirrorless-camera format) and never rotated
/// sources (rotation is applied by FFmpeg's software autorotate).
pub(crate) fn gpu_decodes(ins: &Inspected) -> bool {
    matches!(ins.codec.as_str(), "hevc" | "av1" | "vp9") && ins.rotation == 0 && ins.is_420()
}

/// The GPU routes to try, in order: NVDEC+NVENC first when the GPU decodes the source, then
/// processor decode + NVENC. The GPU counts as unavailable only when NVENC itself fails.
pub(crate) fn gpu_routes(ins: &Inspected) -> &'static [Route] {
    if gpu_decodes(ins) { &[Route::GpuDecode, Route::GpuEncode] } else { &[Route::GpuEncode] }
}

/// Makes the proxy. Progress restarts from 0 when one attempt fails and the next route takes
/// over (NVDEC+NVENC, then processor decode + NVENC, then libx264). Errors:
/// `source_missing`, `source_unreadable`, `cancelled`, `disk_full`, `gpu_unavailable` (GPU
/// only), `internal` (with FFmpeg's last error lines as detail).
pub fn make_proxy(
    tools: &FfmpegTools,
    req: &ProxyRequest<'_>,
    cancel: &CancelToken,
    on_progress: &mut dyn FnMut(TaskProgress),
) -> Result<ProxyOutcome, AppError> {
    let started = Instant::now();
    let ins = inspect(tools, req.source, cancel)?;
    ensure_parent(req.output)?;
    let part = if req.in_place { req.output.to_path_buf() } else { in_progress_path(req.output) };
    let duration = req.media.duration.max(ins.duration);

    let attempt = |path: Route, on_progress: &mut dyn FnMut(TaskProgress)| -> Result<(), RunFailure> {
        let args = proxy_args(&ins, req, path, &part);
        run_ffmpeg(tools, &args, RunSpec { duration, cancel, partial_outputs: vec![part.clone()] }, on_progress)
    };
    // Every GPU route in turn; the error of the last one when all fail. Cancel and a full
    // disk end the task at once.
    let try_gpu = |on_progress: &mut dyn FnMut(TaskProgress)| -> Result<Result<(), AppError>, AppError> {
        let mut last = None;
        for &route in gpu_routes(&ins) {
            match attempt(route, on_progress) {
                Ok(()) => return Ok(Ok(())),
                Err(RunFailure::Cancelled) => return Err(RunFailure::Cancelled.into_app_error(ErrorCode::Cancelled, "")),
                Err(f) => {
                    let e = f.into_app_error(ErrorCode::GpuUnavailable, "The GPU could not make the proxy");
                    if e.code == ErrorCode::DiskFull {
                        return Err(e);
                    }
                    last = Some(e);
                }
            }
        }
        Ok(Err(last.unwrap_or_else(|| AppError::new(ErrorCode::GpuUnavailable, "The GPU could not make the proxy"))))
    };

    let (used_gpu, gpu_failure) = match req.encoder {
        EncoderChoice::SoftwareOnly => {
            attempt(Route::Software, on_progress).map_err(|f| f.into_app_error(ErrorCode::Internal, "Could not make the proxy"))?;
            (false, None)
        }
        EncoderChoice::GpuOnly => {
            try_gpu(on_progress)??;
            (true, None)
        }
        EncoderChoice::Auto => match try_gpu(on_progress)? {
            Ok(()) => (true, None),
            Err(gpu_err) => {
                attempt(Route::Software, on_progress)
                    .map_err(|f| f.into_app_error(ErrorCode::Internal, "Could not make the proxy"))?;
                (false, Some(gpu_err))
            }
        },
    };
    if !req.in_place {
        commit(&part, req.output)?;
    }
    Ok(ProxyOutcome { used_gpu, gpu_failure, took_seconds: started.elapsed().as_secs_f64() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rc_types::BitDepth;

    fn ins(w: u32, h: u32, hdr: bool, audio: usize) -> Inspected {
        Inspected {
            video_stream: 0,
            codec: "hevc".into(),
            display_width: w,
            display_height: h,
            width: w,
            height: h,
            rotation: 0,
            hdr,
            bit_depth: BitDepth::Ten,
            r_frame_rate: None,
            avg_frame_rate: None,
            time_base: None,
            audio: (0..audio)
                .map(|i| rc_types::AudioTrackInfo { index: i as u32, codec: "aac".into(), channels: 2, sample_rate: 48000, title: None })
                .collect(),
            audio_codecs_playable: true,
            pix_fmt: "yuv420p10le".into(),
            start_offset: 0.0,
            duration: 1_000_000,
            container: "mp4".into(),
        }
    }

    #[test]
    fn shapes_are_kept_inside_720p() {
        assert_eq!(fit_size(3840, 2160), (1280, 720));
        assert_eq!(fit_size(640, 480), (960, 720));
        assert_eq!(fit_size(1080, 1920), (406, 720));
        assert_eq!(fit_size(2560, 1080), (1280, 540));
        assert_eq!(fit_size(1920, 1080), (1280, 720));
    }

    #[test]
    fn half_second_gop() {
        assert_eq!(gop(Rational { num: 30, den: 1 }), 15);
        assert_eq!(gop(Rational { num: 60, den: 1 }), 30);
        assert_eq!(gop(Rational { num: 30000, den: 1001 }), 15);
        assert_eq!(gop(Rational { num: 24, den: 1 }), 12);
        assert_eq!(gop(Rational { num: 1, den: 1 }), 1);
    }

    #[test]
    fn filters_pad_tonemap_and_use_cuda_when_asked() {
        let f = video_filter(&ins(640, 480, false, 1), Route::Software);
        assert_eq!(f, "scale=960:720:flags=bilinear,format=yuv420p,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1");
        let f = video_filter(&ins(3840, 2160, true, 1), Route::GpuDecode);
        assert!(f.starts_with("scale_cuda=w=1280:h=720:format=p010le"), "{f}");
        assert!(f.contains("tonemap=hable") && !f.contains("pad="), "{f}");
    }

    #[test]
    fn gpu_routes_skip_nvdec_for_422_and_rotation() {
        let mut i = ins(1920, 1080, false, 1);
        assert_eq!(gpu_routes(&i), &[Route::GpuDecode, Route::GpuEncode]);
        i.pix_fmt = "yuv422p10le".into();
        assert_eq!(gpu_routes(&i), &[Route::GpuEncode]);
        i.pix_fmt = "yuv420p".into();
        i.rotation = 90;
        assert_eq!(gpu_routes(&i), &[Route::GpuEncode]);
        i.rotation = 0;
        i.codec = "h264".into();
        assert_eq!(gpu_routes(&i), &[Route::GpuEncode]);
    }

    #[test]
    fn all_audio_tracks_are_mixed() {
        let i = ins(1920, 1080, false, 3);
        let m = MediaInfo {
            duration: 1_000_000,
            container: "mp4".into(),
            video: rc_types::VideoInfo {
                codec: "hevc".into(),
                width: 1920,
                height: 1080,
                frame_rate: Rational { num: 30, den: 1 },
                variable_frame_rate: false,
                bit_depth: BitDepth::Eight,
                hdr: false,
            },
            audio_tracks: i.audio.clone(),
            speech_track: 0,
            direct_playable: true,
        };
        let req = ProxyRequest::new(Path::new("in.mp4"), &m, Path::new("out.mp4"));
        let args = proxy_args(&i, &req, Route::Software, Path::new("out.mp4.part"));
        let graph = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(graph.contains("[a0][a1][a2]amix=inputs=3"), "{graph}");
        // Every track goes on the shared clock before the mix, so a late track stays late.
        for t in 0..3 {
            assert!(graph.contains(&format!("[0:a:{t}]aresample=48000:async=1:first_pts=0,")), "{graph}");
        }
        assert!(args.windows(2).any(|w| w[0] == "-g" && w[1] == "15"));
        assert!(!args.iter().any(|a| a == "-ss"));
    }
}
