//! Probe: a file path to [`MediaInfo`] (spec 3.4, 3.5.9).
//!
//! Two ffprobe runs: streams and format (everything but timing), then the presentation times
//! of the video packets, from which variable frame rate is decided (real timing, not the
//! container's declared rates). Files of up to [`FULL_SCAN_SECONDS`] are scanned whole;
//! longer ones in three windows (start, middle, end).
//!
//! Conventions the other tasks rely on (see README.md):
//! - **Time zero is the first video frame.** `duration` runs from there to the end of the
//!   container (the longest stream). Proxy, speech audio and waveform use the same zero.
//! - `width`/`height` are as displayed: rotation metadata of 90 or 270 degrees swaps them.
//! - `AudioTrackInfo.index` counts audio tracks only (FFmpeg's `0:a:N`), from 0.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use rc_types::{AppError, AudioTrackInfo, BitDepth, ErrorCode, MediaInfo, Micros, Rational, VideoInfo};
use serde::Deserialize;

use crate::process::{CancelToken, ManagedChild, hidden_command};
use crate::tools::FfmpegTools;

/// Files up to this long have every video packet time read for the frame-rate check.
pub const FULL_SCAN_SECONDS: f64 = 90.0;
/// Length of each of the three windows read in longer files.
const WINDOW_SECONDS: f64 = 20.0;

#[derive(Debug, Default, Deserialize)]
pub(crate) struct FfprobeOutput {
    #[serde(default)]
    pub streams: Vec<FfStream>,
    #[serde(default)]
    pub format: Option<FfFormat>,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct FfDisposition {
    #[serde(default)]
    pub attached_pic: i64,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct FfStream {
    pub index: u32,
    pub codec_type: Option<String>,
    pub codec_name: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub pix_fmt: Option<String>,
    pub bits_per_raw_sample: Option<String>,
    pub r_frame_rate: Option<String>,
    pub avg_frame_rate: Option<String>,
    pub time_base: Option<String>,
    pub start_time: Option<String>,
    pub duration: Option<String>,
    pub sample_rate: Option<String>,
    pub channels: Option<u32>,
    pub color_transfer: Option<String>,
    /// Colour tags and bit rate, read by the export (`export::source`).
    pub color_primaries: Option<String>,
    pub color_space: Option<String>,
    pub color_range: Option<String>,
    pub bit_rate: Option<String>,
    pub channel_layout: Option<String>,
    pub sample_aspect_ratio: Option<String>,
    #[serde(default)]
    pub disposition: Option<FfDisposition>,
    #[serde(default)]
    pub tags: HashMap<String, String>,
    #[serde(default)]
    pub side_data_list: Vec<serde_json::Value>,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct FfFormat {
    pub format_name: Option<String>,
    pub start_time: Option<String>,
    pub duration: Option<String>,
    /// Whole-file bit rate and size, read by the export's size estimate.
    pub bit_rate: Option<String>,
    pub size: Option<String>,
    #[serde(default)]
    pub tags: HashMap<String, String>,
}

/// Everything the tasks need to know about a source, from one ffprobe run (no packet scan).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Inspected {
    /// Absolute stream index of the picture (FFmpeg `0:N`).
    pub video_stream: u32,
    pub codec: String,
    /// As displayed (rotation and pixel aspect applied).
    pub display_width: u32,
    pub display_height: u32,
    /// Stored size, before rotation.
    pub width: u32,
    pub height: u32,
    /// 0, 90, 180 or 270.
    pub rotation: u32,
    pub hdr: bool,
    pub bit_depth: BitDepth,
    pub r_frame_rate: Option<Rational>,
    pub avg_frame_rate: Option<Rational>,
    pub time_base: Option<Rational>,
    pub audio: Vec<AudioTrackInfo>,
    pub audio_codecs_playable: bool,
    /// The decoded pixel format ("yuv420p", "yuv422p10le", ...), empty when unknown.
    pub pix_fmt: String,
    /// Seconds from the container's start to the first video frame (never negative).
    pub start_offset: f64,
    /// Microseconds from the first video frame to the end of the container.
    pub duration: Micros,
    pub container: String,
}

impl Inspected {
    /// Whether the picture is 4:2:0, the only chroma layout the player experiment showed
    /// playing in WebView2 and NVDEC decoding on this GPU.
    pub(crate) fn is_420(&self) -> bool {
        is_420_pix_fmt(&self.pix_fmt)
    }

    /// The `-ss` value (seconds, input option) that makes output time zero the first video frame,
    /// or `None` when FFmpeg's default already does.
    pub(crate) fn seek_to_first_frame(&self) -> Option<String> {
        (self.start_offset > 0.000_000_5).then(|| format!("{:.6}", self.start_offset))
    }
}

pub(crate) fn parse_f64(s: &Option<String>) -> Option<f64> {
    s.as_deref().and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| v.is_finite())
}

/// "30000/1001" → Rational, `None` for "0/0", missing or nonsense.
pub(crate) fn parse_rational(s: Option<&str>) -> Option<Rational> {
    let s = s?.trim();
    let (n, d) = s.split_once('/').unwrap_or((s, "1"));
    let (n, d) = (n.trim().parse::<u64>().ok()?, d.trim().parse::<u64>().ok()?);
    if n == 0 || d == 0 {
        return None;
    }
    let g = gcd(n, d);
    let (n, d) = (n / g, d / g);
    Some(Rational { num: u32::try_from(n).ok()?, den: u32::try_from(d).ok()? })
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 { a } else { gcd(b, a % b) }
}

fn fps(r: Rational) -> f64 {
    r.num as f64 / r.den as f64
}

/// The common frame rates, for snapping measured rates.
const STANDARD_RATES: [(u32, u32); 12] = [
    (24000, 1001),
    (24, 1),
    (25, 1),
    (30000, 1001),
    (30, 1),
    (48, 1),
    (50, 1),
    (60000, 1001),
    (60, 1),
    (100, 1),
    (120000, 1001),
    (120, 1),
];

fn is_standard(r: Rational) -> bool {
    STANDARD_RATES.iter().any(|&(n, d)| Rational { num: n, den: d } == r)
}

fn nearest_standard(f: f64) -> Rational {
    let (n, d) = STANDARD_RATES
        .iter()
        .copied()
        .min_by(|a, b| {
            let da = (a.0 as f64 / a.1 as f64 - f).abs();
            let db = (b.0 as f64 / b.1 as f64 - f).abs();
            da.total_cmp(&db)
        })
        .unwrap_or((30, 1));
    Rational { num: n, den: d }
}

/// What the packet times say about the frame timing.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TimingStats {
    /// The most common interval between frames, seconds.
    pub mode_interval: f64,
    /// Intervals measured.
    pub intervals: usize,
    /// Intervals that differ from the most common one by more than the tolerance.
    pub irregular: usize,
}

impl TimingStats {
    /// Variable frame rate: more than a stray glitch of irregular intervals
    /// (at least 3, and at least 0.2 % of them).
    pub(crate) fn is_variable(&self) -> bool {
        self.irregular >= 3 && self.irregular as f64 >= self.intervals as f64 * 0.002
    }
}

/// Analyses presentation times (in `time_base` ticks, any order, windows of a file mixed).
/// Intervals longer than 2 s are gaps between windows and are ignored.
///
/// Each interval is compared with a reference: the frame interval of the `declared` rate
/// when that agrees with the most common interval (within a tick or 2 %), else the most
/// common interval itself. An interval is irregular when it differs from the reference by
/// more than 250 µs and by more than the rounding the time base forces: one tick when the
/// reference is not a whole number of ticks (Matroska's 1 ms base stores 60 fps as
/// 17/17/16 ms) or when a frame spans at least 20 ticks, none otherwise (a coarse grid that
/// holds the interval exactly has no excuse).
pub(crate) fn analyse_timing(mut pts: Vec<i64>, time_base: Rational, declared: Option<Rational>) -> Option<TimingStats> {
    pts.sort_unstable();
    pts.dedup();
    let tick = time_base.num as f64 / time_base.den as f64;
    let diffs: Vec<i64> = pts
        .windows(2)
        .map(|w| w[1] - w[0])
        .filter(|&d| d > 0 && (d as f64) * tick <= 2.0)
        .collect();
    if diffs.is_empty() {
        return None;
    }
    let mut counts: HashMap<i64, usize> = HashMap::new();
    for &d in &diffs {
        *counts.entry(d).or_default() += 1;
    }
    let mode = counts.iter().max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0))).map(|(d, _)| *d)?;
    // The declared rate's interval in ticks, exactly: (rate.den * tb.den) / (rate.num * tb.num).
    let declared_ticks = declared.filter(|r| r.num > 0).and_then(|r| {
        let num = r.den as u128 * time_base.den as u128;
        let den = r.num as u128 * time_base.num as u128;
        let ticks = num as f64 / den as f64;
        let close = (ticks - mode as f64).abs() <= (0.02 * mode as f64).max(1.0);
        close.then_some((ticks, !num.is_multiple_of(den)))
    });
    let (reference, fractional) = declared_ticks.unwrap_or((mode as f64, false));
    let rounding = if fractional || mode >= 20 { 1.0 } else { 0.0 };
    let tolerance_ticks = (0.000_25 / tick).max(rounding) + 1e-9;
    let irregular = diffs.iter().filter(|&&d| (d as f64 - reference).abs() > tolerance_ticks).count();
    Some(TimingStats { mode_interval: mode as f64 * tick, intervals: diffs.len(), irregular })
}

/// The frame rate reported for a source (and used as the sequence's grid when it is first).
/// Constant: the declared rate when the packet timing agrees, else the measured one.
/// Variable: the declared base rate when it is a common rate near the average, else the
/// average snapped to the nearest common rate.
pub(crate) fn choose_frame_rate(
    declared: Option<Rational>,
    average: Option<Rational>,
    timing: Option<&TimingStats>,
    variable: bool,
) -> Rational {
    let sane = |r: &Rational| (1.0..=300.0).contains(&fps(*r));
    let declared = declared.filter(sane);
    let average = average.filter(sane);
    if variable {
        if let (Some(r), Some(a)) = (declared, average) {
            let ratio = fps(r) / fps(a);
            if is_standard(r) && (0.95..=1.3).contains(&ratio) {
                return r;
            }
        }
        let f = average
            .map(fps)
            .or_else(|| timing.map(|t| 1.0 / t.mode_interval))
            .or(declared.map(fps))
            .unwrap_or(30.0);
        return nearest_standard(f);
    }
    let agrees = |r: Rational| match timing {
        None => true,
        Some(t) => ((1.0 / fps(r)) - t.mode_interval).abs() / t.mode_interval < 0.02,
    };
    if let Some(r) = declared.filter(|r| agrees(*r)) {
        return r;
    }
    if let Some(a) = average.filter(|a| agrees(*a)) {
        let s = nearest_standard(fps(a));
        return if (fps(s) - fps(a)).abs() / fps(a) < 0.001 { s } else { a };
    }
    if let Some(t) = timing {
        let f = 1.0 / t.mode_interval;
        let s = nearest_standard(f);
        if (fps(s) - f).abs() / f < 0.01 {
            return s;
        }
        return parse_rational(Some(&format!("{}/1000", (f * 1000.0).round() as u64))).unwrap_or(s);
    }
    declared.or(average).unwrap_or(Rational { num: 30, den: 1 })
}

/// Which audio track the transcript is made from (spec 1.12: the microphone track).
/// Titles are scored: words for a voice microphone ("lav", "voice", "mic", ...) count for,
/// words for other sources ("camera", "music", "game", "mix", ...) count against. The best
/// positive score wins (the earlier track on a tie); with no positive score, the first track.
pub fn choose_speech_track(tracks: &[AudioTrackInfo]) -> u32 {
    const STRONG: [&str; 9] = ["lav", "lavalier", "voice", "speech", "dialog", "narrat", "vocal", "headset", "voiceover"];
    const MIC: [&str; 3] = ["mic", "microphone", "mikro"];
    const WEAK_AGAINST: [&str; 5] = ["camera", "cam ", "onboard", "built-in", "internal"];
    const AGAINST: [&str; 9] = ["music", "game", "desktop", "system", "bgm", "background", "sfx", "effects", "ambien"];
    let score = |title: &str| -> i32 {
        let t = format!(" {} ", title.to_lowercase());
        let mut s = 0;
        if STRONG.iter().any(|w| t.contains(w)) {
            s += 3;
        }
        if MIC.iter().any(|w| t.contains(w)) {
            s += 2;
        }
        if WEAK_AGAINST.iter().any(|w| t.contains(w)) {
            s -= 2;
        }
        if AGAINST.iter().any(|w| t.contains(w)) {
            s -= 3;
        }
        if t.contains("mix") {
            s -= 1;
        }
        s
    };
    let mut best: Option<(i32, u32)> = None;
    for tr in tracks {
        let s = tr.title.as_deref().map(score).unwrap_or(0);
        if s > 0 && best.is_none_or(|(b, _)| s > b) {
            best = Some((s, tr.index));
        }
    }
    best.map(|(_, i)| i).or(tracks.first().map(|t| t.index)).unwrap_or(0)
}

/// A track's title: the `title` tag, then MP4's `name`, then a `handler_name` that is not
/// just a muxer's default ("SoundHandler", "Core Media Audio", ...).
fn track_title(tags: &HashMap<String, String>) -> Option<String> {
    let get = |k: &str| {
        tags.iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(k))
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    get("title").or_else(|| get("name")).or_else(|| {
        get("handler_name").filter(|h| {
            let l = h.to_lowercase();
            !(l.contains("handler") || l == "core media audio" || l == "soundhandle")
        })
    })
}

/// 4:2:0 pixel formats, 8 or 10 bit, planar or semi-planar.
pub(crate) fn is_420_pix_fmt(pix_fmt: &str) -> bool {
    matches!(
        pix_fmt,
        "yuv420p" | "yuvj420p" | "yuv420p10le" | "yuv420p10be" | "nv12" | "nv21" | "p010le" | "p010be"
    )
}

fn is_ten_bit(s: &FfStream) -> bool {
    let pix = s.pix_fmt.as_deref().unwrap_or("");
    let by_pix = ["p010", "p016", "10le", "10be", "12le", "12be", "16le", "16be", "p210", "p410", "y210", "x2rgb10"]
        .iter()
        .any(|m| pix.contains(m));
    let by_bits = s.bits_per_raw_sample.as_deref().and_then(|b| b.parse::<u32>().ok()).is_some_and(|b| b > 8);
    by_pix || by_bits
}

fn is_hdr(s: &FfStream) -> bool {
    let transfer = s.color_transfer.as_deref().unwrap_or("");
    let hdr_side_data = s.side_data_list.iter().any(|sd| {
        let t = sd.get("side_data_type").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        t.contains("mastering display") || t.contains("content light level") || t.contains("dovi") || t.contains("hdr dynamic")
    });
    matches!(transfer, "smpte2084" | "arib-std-b67") || hdr_side_data
}

/// Rotation from the display matrix (or the old `rotate` tag), normalised to 0/90/180/270.
fn rotation(s: &FfStream) -> u32 {
    let from_side = s.side_data_list.iter().find_map(|sd| sd.get("rotation").and_then(|v| v.as_f64()));
    let from_tag = s.tags.get("rotate").and_then(|v| v.trim().parse::<f64>().ok());
    let deg = from_side.or(from_tag).unwrap_or(0.0).round() as i64;
    let norm = deg.rem_euclid(360);
    // Round to the nearest quarter turn.
    (((norm + 45) / 90 * 90) % 360) as u32
}

/// Audio codecs Chromium plays in MP4/MOV.
fn audio_codec_playable(codec: &str) -> bool {
    matches!(codec, "aac" | "mp3" | "opus" | "flac")
}

fn container_name(format: &FfFormat, path: &Path) -> String {
    let names = format.format_name.as_deref().unwrap_or("");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if names.contains("mp4") || names.contains("mov") {
        let brand = format.tags.get("major_brand").map(|b| b.trim().to_lowercase()).unwrap_or_default();
        return if brand == "qt" || (brand.is_empty() && ext == "mov") { "mov".into() } else { "mp4".into() };
    }
    if names.contains("matroska") {
        return if ext == "webm" { "webm".into() } else { "matroska".into() };
    }
    names.split(',').next().filter(|n| !n.is_empty()).unwrap_or("unknown").to_string()
}

/// Builds [`Inspected`] from ffprobe's JSON (streams and format).
pub(crate) fn inspect_from_json(json: &[u8], path: &Path) -> Result<Inspected, AppError> {
    let out: FfprobeOutput = serde_json::from_slice(json).map_err(|e| {
        AppError::new(ErrorCode::SourceUnreadable, "This file could not be read").with_detail(format!("ffprobe output: {e}"))
    })?;
    let format = out.format.unwrap_or_default();
    let video = out
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video") && s.disposition.as_ref().is_none_or(|d| d.attached_pic == 0))
        .ok_or_else(|| AppError::new(ErrorCode::SourceUnreadable, "This file has no video").with_detail(path.display().to_string()))?;

    let (width, height) = (video.width.unwrap_or(0), video.height.unwrap_or(0));
    if width == 0 || height == 0 {
        return Err(AppError::new(ErrorCode::SourceUnreadable, "This file's video has no picture size")
            .with_detail(path.display().to_string()));
    }
    let rot = rotation(video);
    // Pixel aspect: display width = stored width × SAR.
    let sar = parse_rational(video.sample_aspect_ratio.as_deref()).filter(|r| r.num > 0);
    let stored_display_w = match sar {
        Some(r) if r.num != r.den => ((width as f64 * fps(r) / 2.0).round() as u32 * 2).max(2),
        _ => width,
    };
    let (display_width, display_height) =
        if rot % 180 == 90 { (height, stored_display_w) } else { (stored_display_w, height) };

    let mut audio = Vec::new();
    let mut audio_codecs_playable = true;
    for s in out.streams.iter().filter(|s| s.codec_type.as_deref() == Some("audio")) {
        let codec = s.codec_name.clone().unwrap_or_else(|| "unknown".into());
        audio_codecs_playable &= audio_codec_playable(&codec);
        audio.push(AudioTrackInfo {
            index: audio.len() as u32,
            codec,
            channels: s.channels.unwrap_or(0),
            sample_rate: s.sample_rate.as_deref().and_then(|r| r.parse().ok()).unwrap_or(0),
            title: track_title(&s.tags),
        });
    }

    let video_start = parse_f64(&video.start_time).unwrap_or(0.0);
    let all_starts = out.streams.iter().filter_map(|s| parse_f64(&s.start_time));
    let format_start = parse_f64(&format.start_time).unwrap_or_else(|| all_starts.fold(video_start, f64::min));
    let stream_end = out
        .streams
        .iter()
        .filter(|s| matches!(s.codec_type.as_deref(), Some("video" | "audio")))
        .filter_map(|s| Some(parse_f64(&s.start_time).unwrap_or(format_start) + parse_f64(&s.duration)?))
        .fold(f64::NAN, f64::max);
    let end = match parse_f64(&format.duration) {
        Some(d) => format_start + d,
        None if stream_end.is_finite() => stream_end,
        None => {
            return Err(AppError::new(ErrorCode::SourceUnreadable, "This file's length could not be read")
                .with_detail(path.display().to_string()));
        }
    };
    let duration = ((end - video_start) * 1e6).round() as i64;
    if duration <= 0 {
        return Err(AppError::new(ErrorCode::SourceUnreadable, "This file has no length")
            .with_detail(path.display().to_string()));
    }

    Ok(Inspected {
        video_stream: video.index,
        codec: video.codec_name.clone().unwrap_or_else(|| "unknown".into()),
        display_width,
        display_height,
        width,
        height,
        rotation: rot,
        hdr: is_hdr(video),
        bit_depth: if is_ten_bit(video) { BitDepth::Ten } else { BitDepth::Eight },
        r_frame_rate: parse_rational(video.r_frame_rate.as_deref()),
        avg_frame_rate: parse_rational(video.avg_frame_rate.as_deref()),
        time_base: parse_rational(video.time_base.as_deref()),
        audio,
        audio_codecs_playable,
        pix_fmt: video.pix_fmt.clone().unwrap_or_default(),
        start_offset: (video_start - format_start).max(0.0),
        duration,
        container: container_name(&format, path),
    })
}

pub(crate) fn check_exists(path: &Path) -> Result<(), AppError> {
    if !path.is_file() {
        return Err(AppError::new(ErrorCode::SourceMissing, "The file is not where it was")
            .with_detail(path.display().to_string()));
    }
    Ok(())
}

/// Runs ffprobe with `args` + `path` and returns its stdout.
pub(crate) fn run_ffprobe(tools: &FfmpegTools, args: &[&str], path: &Path, cancel: &CancelToken) -> Result<Vec<u8>, AppError> {
    let mut cmd = hidden_command(&tools.ffprobe);
    cmd.args(["-hide_banner", "-v", "error"]).args(args).arg(path);
    let unreadable = |f: crate::process::RunFailure| f.into_app_error(ErrorCode::SourceUnreadable, "This file could not be read");
    let mut child = ManagedChild::spawn(cmd, cancel.clone()).map_err(unreadable)?;
    let mut out = Vec::new();
    if let Some(mut stdout) = child.take_stdout() {
        let _ = stdout.read_to_end(&mut out);
    }
    child.wait().map_err(unreadable)?;
    Ok(out)
}

/// Streams and format of a source, without the packet scan. Used by every task.
pub(crate) fn inspect(tools: &FfmpegTools, path: &Path, cancel: &CancelToken) -> Result<Inspected, AppError> {
    check_exists(path)?;
    let json = run_ffprobe(tools, &["-print_format", "json", "-show_format", "-show_streams"], path, cancel)?;
    inspect_from_json(&json, path)
}

/// The `-read_intervals` argument for the packet scan, or `None` to read everything.
pub(crate) fn scan_intervals(start: f64, duration_s: f64) -> Option<String> {
    if duration_s <= FULL_SCAN_SECONDS {
        return None;
    }
    let mid = start + duration_s / 2.0 - WINDOW_SECONDS / 2.0;
    let tail = start + duration_s - WINDOW_SECONDS;
    Some(format!("%+{w},{mid:.3}%+{w},{tail:.3}%+{w}", w = WINDOW_SECONDS))
}

fn packet_times(tools: &FfmpegTools, path: &Path, ins: &Inspected, cancel: &CancelToken) -> Result<Vec<i64>, AppError> {
    let select = ins.video_stream.to_string();
    let mut args: Vec<String> =
        vec!["-select_streams".into(), select, "-show_entries".into(), "packet=pts".into(), "-of".into(), "csv=p=0".into()];
    if let Some(iv) = scan_intervals(0.0, ins.duration as f64 / 1e6) {
        args.push("-read_intervals".into());
        args.push(iv);
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_ffprobe(tools, &refs, path, cancel)?;
    Ok(String::from_utf8_lossy(&out)
        .lines()
        .filter_map(|l| l.split(',').next().and_then(|v| v.trim().parse::<i64>().ok()))
        .collect())
}

/// Reads a source file: duration, streams, real frame-rate behaviour, bit depth, HDR, audio
/// tracks with titles, the speech track and whether the player can use the file directly.
/// Errors: `source_missing` when there is no file at `path`, `source_unreadable` when
/// ffprobe cannot read it or it has no video, `cancelled`.
pub fn probe(tools: &FfmpegTools, path: &Path, cancel: &CancelToken) -> Result<MediaInfo, AppError> {
    let ins = inspect(tools, path, cancel)?;
    let pts = packet_times(tools, path, &ins, cancel)?;
    let timing = ins.time_base.and_then(|tb| analyse_timing(pts, tb, ins.r_frame_rate));
    let variable = timing.as_ref().is_some_and(TimingStats::is_variable);
    let frame_rate = choose_frame_rate(ins.r_frame_rate, ins.avg_frame_rate, timing.as_ref(), variable);
    Ok(media_info(&ins, frame_rate, variable))
}

/// Assembles the [`MediaInfo`] for an inspected source.
pub(crate) fn media_info(ins: &Inspected, frame_rate: Rational, variable: bool) -> MediaInfo {
    // The player experiment proved MP4/MOV with H.264 or HEVC in 4:2:0 (8-bit, High10, Main10)
    // only; 4:2:2 and 4:4:4 do not decode in WebView2 here and wait for the proxy.
    let direct_playable = matches!(ins.container.as_str(), "mp4" | "mov")
        && matches!(ins.codec.as_str(), "h264" | "hevc")
        && ins.is_420()
        && ins.audio_codecs_playable;
    MediaInfo {
        duration: ins.duration,
        container: ins.container.clone(),
        video: VideoInfo {
            codec: ins.codec.clone(),
            width: ins.display_width,
            height: ins.display_height,
            frame_rate,
            variable_frame_rate: variable,
            bit_depth: ins.bit_depth,
            hdr: ins.hdr,
        },
        speech_track: choose_speech_track(&ins.audio),
        audio_tracks: ins.audio.clone(),
        direct_playable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(index: u32, title: Option<&str>) -> AudioTrackInfo {
        AudioTrackInfo { index, codec: "aac".into(), channels: 1, sample_rate: 48000, title: title.map(String::from) }
    }

    #[test]
    fn speech_track_prefers_the_microphone() {
        let fixture = [track(0, Some("Main mix (1000 Hz)")), track(1, Some("Lav mic (500 Hz)")), track(2, Some("Camera mic (2000 Hz)"))];
        assert_eq!(choose_speech_track(&fixture), 1);
        assert_eq!(choose_speech_track(&[track(0, Some("Desktop audio")), track(1, Some("Mic/Aux"))]), 1);
        assert_eq!(choose_speech_track(&[track(0, Some("Game")), track(1, Some("Voice"))]), 1);
        assert_eq!(choose_speech_track(&[track(0, None), track(1, None)]), 0);
        assert_eq!(choose_speech_track(&[track(0, Some("Music")), track(1, Some("Track 2"))]), 0, "no positive hint: first");
        assert_eq!(choose_speech_track(&[]), 0);
        assert_eq!(choose_speech_track(&[track(0, Some("Mic 1")), track(1, Some("Mic 2"))]), 0, "tie: earlier");
    }

    #[test]
    fn titles_come_from_title_then_name_then_a_real_handler_name() {
        let tags = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        assert_eq!(track_title(&tags(&[("handler_name", "Lav mic"), ("name", "Lav mic")])), Some("Lav mic".into()));
        assert_eq!(track_title(&tags(&[("handler_name", "SoundHandler")])), None);
        assert_eq!(track_title(&tags(&[("handler_name", "Core Media Audio")])), None);
        assert_eq!(track_title(&tags(&[("handler_name", "Voice")])), Some("Voice".into()));
        assert_eq!(track_title(&tags(&[("title", "T"), ("name", "N")])), Some("T".into()));
    }

    #[test]
    fn rationals_parse_and_reduce() {
        assert_eq!(parse_rational(Some("30000/1001")), Some(Rational { num: 30000, den: 1001 }));
        assert_eq!(parse_rational(Some("60/2")), Some(Rational { num: 30, den: 1 }));
        assert_eq!(parse_rational(Some("0/0")), None);
        assert_eq!(parse_rational(Some("25")), Some(Rational { num: 25, den: 1 }));
        assert_eq!(parse_rational(None), None);
    }

    #[test]
    fn constant_timing_is_not_variable() {
        // 30 fps at 1/15360: 512 ticks; B-frame order shuffled.
        let mut pts: Vec<i64> = (0..300).map(|i| i * 512).collect();
        pts.swap(3, 4);
        let s = analyse_timing(pts, Rational { num: 1, den: 15360 }, None).unwrap();
        assert_eq!(s.irregular, 0);
        assert!(!s.is_variable());
        // 29.97 in a 1 ms timebase alternates 33/34 ms: still constant.
        let pts: Vec<i64> = (0..300).map(|i| (i as f64 * 1001.0 / 30.0).round() as i64).collect();
        let s = analyse_timing(pts, Rational { num: 1, den: 1000 }, None).unwrap();
        assert!(!s.is_variable(), "{s:?}");
        // A single dropped frame is not variable frame rate.
        let pts: Vec<i64> = (0..300).filter(|&i| i != 100).map(|i| i * 512).collect();
        assert!(!analyse_timing(pts, Rational { num: 1, den: 15360 }, None).unwrap().is_variable());
    }

    #[test]
    fn variable_timing_is_detected() {
        // Alternating 33 / 50 ms on a 1/60 grid, as in the VFR fixture.
        let mut t = 0;
        let mut pts = vec![];
        for i in 0..200 {
            pts.push(t);
            t += if i % 2 == 0 { 2 } else { 3 };
        }
        let s = analyse_timing(pts.clone(), Rational { num: 1, den: 60 }, None).unwrap();
        assert!(s.is_variable(), "{s:?}");
        // The fixture declares 30/1, which the 1/60 grid holds exactly (2 ticks): still variable.
        let s = analyse_timing(pts, Rational { num: 1, den: 60 }, Some(Rational { num: 30, den: 1 })).unwrap();
        assert!(s.is_variable(), "{s:?}");
    }

    #[test]
    fn rates_a_time_base_cannot_hold_exactly_are_constant() {
        let ms = Rational { num: 1, den: 1000 };
        // Matroska's 1 ms base: 60 fps is 17/17/16 ms, 59.94 and 120 fps likewise rounded.
        for (num, den) in [(60u32, 1u32), (60000, 1001), (120, 1), (50, 1), (24000, 1001)] {
            let interval_ms = 1000.0 * den as f64 / num as f64;
            let pts: Vec<i64> = (0..600).map(|i| (i as f64 * interval_ms).round() as i64).collect();
            let s = analyse_timing(pts, ms, Some(Rational { num, den })).unwrap();
            assert_eq!(s.irregular, 0, "{num}/{den}: {s:?}");
        }
        // Real VFR in Matroska (16 ms and 33 ms frames mixed) is still caught.
        let mut t = 0;
        let mut pts = vec![];
        for i in 0..300 {
            pts.push(t);
            t += if i % 3 == 0 { 33 } else { 17 };
        }
        assert!(analyse_timing(pts, ms, Some(Rational { num: 60, den: 1 })).unwrap().is_variable());
    }

    #[test]
    fn gaps_between_scan_windows_are_ignored() {
        let mut pts: Vec<i64> = (0..100).map(|i| i * 512).collect();
        pts.extend((0..100).map(|i| 15360 * 600 + i * 512));
        let s = analyse_timing(pts, Rational { num: 1, den: 15360 }, None).unwrap();
        assert_eq!(s.irregular, 0);
        assert_eq!(s.intervals, 198);
    }

    #[test]
    fn frame_rate_choice() {
        let r = |n, d| Rational { num: n, den: d };
        let t30 = TimingStats { mode_interval: 1.0 / 30.0, intervals: 100, irregular: 0 };
        assert_eq!(choose_frame_rate(Some(r(30, 1)), Some(r(30, 1)), Some(&t30), false), r(30, 1));
        // Declared field rate on a 29.97 file: measured timing wins.
        let t2997 = TimingStats { mode_interval: 1001.0 / 30000.0, intervals: 100, irregular: 0 };
        assert_eq!(choose_frame_rate(Some(r(60000, 1001)), Some(r(30000, 1001)), Some(&t2997), false), r(30000, 1001));
        // VFR fixture: r 30/1, average 13410/449 (29.87).
        assert_eq!(choose_frame_rate(Some(r(30, 1)), Some(r(13410, 449)), None, true), r(30, 1));
        // Phone VFR with a nonsense declared rate: average snapped.
        assert_eq!(choose_frame_rate(Some(r(90000, 1)), Some(r(2950, 100)), None, true), r(30000, 1001));
        assert_eq!(choose_frame_rate(None, None, None, false), r(30, 1));
    }

    #[test]
    fn scan_windows_for_long_files() {
        assert_eq!(scan_intervals(0.0, 30.0), None);
        assert_eq!(scan_intervals(0.0, 3600.0).unwrap(), "%+20,1790.000%+20,3580.000%+20");
    }

    #[test]
    fn inspect_reads_rotation_aspect_offset_and_titles() {
        let json = br#"{
          "streams": [
            {"index":0,"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2,"start_time":"-0.021333","duration":"10.0","tags":{"handler_name":"SoundHandler"}},
            {"index":1,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"pix_fmt":"yuv420p","r_frame_rate":"30/1","avg_frame_rate":"30/1","time_base":"1/15360","start_time":"0.000000","duration":"9.9","sample_aspect_ratio":"1:1",
             "side_data_list":[{"side_data_type":"Display Matrix","rotation":-90}]},
            {"index":2,"codec_type":"video","codec_name":"mjpeg","width":300,"height":300,"disposition":{"attached_pic":1,"default":0}},
            {"index":3,"codec_type":"audio","codec_name":"pcm_s16le","sample_rate":"48000","channels":1,"tags":{"name":"Voice"}}
          ],
          "format": {"format_name":"mov,mp4,m4a,3gp,3g2,mj2","start_time":"-0.021333","duration":"10.021333","tags":{"major_brand":"qt  "}}
        }"#;
        let ins = inspect_from_json(json, Path::new("x.mov")).unwrap();
        assert_eq!(ins.video_stream, 1);
        assert_eq!((ins.display_width, ins.display_height, ins.rotation), (1080, 1920, 270));
        assert!((ins.start_offset - 0.021333).abs() < 1e-9);
        assert_eq!(ins.duration, 10_000_000);
        assert_eq!(ins.container, "mov");
        assert_eq!(ins.audio[0].title, None);
        assert_eq!(ins.audio[1].title.as_deref(), Some("Voice"));
        assert!(!ins.audio_codecs_playable, "PCM audio is not playable in the browser");
        let info = media_info(&ins, Rational { num: 30, den: 1 }, false);
        assert!(!info.direct_playable);
        assert_eq!(info.speech_track, 1);
        assert_eq!(ins.seek_to_first_frame().as_deref(), Some("0.021333"));
    }

    #[test]
    fn only_420_pictures_are_direct_playable() {
        let json = |pix: &str| {
            format!(
                r#"{{"streams":[
                  {{"index":0,"codec_type":"video","codec_name":"hevc","width":640,"height":360,"pix_fmt":"{pix}","r_frame_rate":"30/1","avg_frame_rate":"30/1","time_base":"1/15360","start_time":"0.0","duration":"2.0"}},
                  {{"index":1,"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2,"start_time":"0.0","duration":"2.0"}}],
                  "format":{{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","start_time":"0.0","duration":"2.0","tags":{{"major_brand":"isom"}}}}}}"#
            )
        };
        for (pix, playable) in
            [("yuv420p", true), ("yuv420p10le", true), ("yuv422p10le", false), ("yuv422p", false), ("yuv444p", false), ("", false)]
        {
            let ins = inspect_from_json(json(pix).as_bytes(), Path::new("x.mp4")).unwrap();
            assert_eq!(ins.is_420(), playable, "{pix}");
            assert_eq!(media_info(&ins, Rational { num: 30, den: 1 }, false).direct_playable, playable, "{pix}");
        }
    }

    #[test]
    fn audio_only_files_are_unreadable_as_sources() {
        let json = br#"{"streams":[{"index":0,"codec_type":"audio","codec_name":"mp3"}],"format":{"duration":"3.0"}}"#;
        assert_eq!(inspect_from_json(json, Path::new("a.mp3")).unwrap_err().code, ErrorCode::SourceUnreadable);
    }
}
