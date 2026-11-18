//! The measured settings of the export experiment (spikes/export/RESULT.md): output format,
//! NVENC options, MP4 timescale, audio sample edges, the size and time model.

use rc_types::{BitDepth, MediaInfo, OutputCodec, OutputFormat, Rational};

/// Sample rate of every exported audio track.
pub const EXPORT_AUDIO_RATE: u32 = 48_000;
/// Length of the fade in and out at every cut, in seconds (the preview uses the same).
pub const EXPORT_RAMP_SECONDS: f64 = 0.004;
/// NVENC constant-quality level (cq), both codecs.
pub const EXPORT_CQ: u32 = 19;
/// NVENC preset, both codecs.
pub const EXPORT_PRESET: &str = "p4";
/// Frames between keyframes in every piece.
pub const EXPORT_GOP: u32 = 60;
/// How many pieces are encoded at the same time (the experiment's recommendation).
pub const EXPORT_PARALLEL_PIECES: usize = 2;
/// Pre-roll of the fast seek before a clip's first frame, seconds.
pub(crate) const SEEK_PREROLL_SECONDS: f64 = 1.0;

/// Time model, two pieces at a time: seconds per clip and per 4K frame (RESULT.md section 5).
pub(crate) const SECONDS_PER_CLIP_PARALLEL: f64 = 0.5;
pub(crate) const SECONDS_PER_4K_FRAME_PARALLEL: f64 = 0.0075;
/// Time model, one piece at a time.
pub(crate) const SECONDS_PER_CLIP_SERIAL: f64 = 1.05;
pub(crate) const SECONDS_PER_4K_FRAME_SERIAL: f64 = 0.0083;
/// The join writes the whole file once more at about this rate.
pub(crate) const JOIN_BYTES_PER_SECOND: f64 = 200e6;
/// AAC 256 kb/s per track, in bytes per second.
pub(crate) const AUDIO_BYTES_PER_SECOND_PER_TRACK: f64 = 32_000.0;
/// Lowest video bit rate assumed at 4K30, bits per second. A source coded at a very low rate
/// comes out of cq 19 at about twice its rate (numbered-4k-h264: 1.1 Mb/s in, 2.4 Mb/s out as one
/// piece, 2.8 Mb/s as 12 pieces), far above the ratio model. Scaled by pixels per second.
pub(crate) const MIN_VIDEO_BITS_4K30_H264: f64 = 3.0e6;
/// The same for HEVC (numbered-4k-hevc10-hdr: 1.4 Mb/s in, 1.8 Mb/s out).
pub(crate) const MIN_VIDEO_BITS_4K30_HEVC: f64 = 2.5e6;
/// The disk-space check allows the video to come out this much larger than the estimate (the
/// measured output-to-source ratios range from 0.8 to 3.4 with the content).
pub(crate) const DISK_MARGIN: f64 = 1.5;

/// How many output frames one sequence frame becomes when the output runs at `out`: `Some(m)`
/// when `out` is a whole multiple `m` (1 to 8) of the sequence rate `seq`, so every clip edge on
/// the sequence grid is also a frame edge of the output.
pub(crate) fn rate_multiple(out: Rational, seq: Rational) -> Option<i64> {
    let a = out.num as i128 * seq.den as i128;
    let b = out.den as i128 * seq.num as i128;
    (b > 0 && a > 0 && a % b == 0 && (1..=8).contains(&(a / b))).then(|| (a / b) as i64)
}

/// The output frame rate: the first clip's source rate when it is a whole multiple of the
/// sequence rate (a 60 fps first clip in a 30 fps sequence exports at 60 fps), otherwise the
/// sequence rate, because every cut must stay on a frame edge (spec 2.4.2, frame grid).
pub fn output_frame_rate(first: &MediaInfo, sequence_rate: Rational) -> Rational {
    let r = first.video.frame_rate;
    let fps = r.num as f64 / r.den.max(1) as f64;
    if rate_multiple(r, sequence_rate).is_some() && fps <= 240.0 { r } else { sequence_rate }
}

/// The output format follows the first clip's source (spec 2.4.8, 1.12): its displayed size
/// (rounded down to even sides), its frame rate ([`output_frame_rate`]; the sequence rate when
/// the source's is not a whole multiple of it), its bit depth and HDR signalling, its codec
/// family (HEVC stays HEVC, everything else 8-bit becomes H.264) and its number of audio tracks.
/// 10-bit or HDR pictures become HEVC Main10, because `h264_nvenc` cannot encode 10-bit on this
/// GPU (RESULT.md "10-bit and HDR").
pub fn output_format(first: &MediaInfo, sequence_rate: Rational) -> OutputFormat {
    let frame_rate = output_frame_rate(first, sequence_rate);
    let v = &first.video;
    let ten_bit = v.bit_depth == BitDepth::Ten || v.hdr;
    let codec = if ten_bit || v.codec == "hevc" { OutputCodec::Hevc } else { OutputCodec::H264 };
    let even = |x: u32| (x & !1).max(2);
    OutputFormat {
        codec,
        width: even(v.width),
        height: even(v.height),
        frame_rate,
        bit_depth: if ten_bit { BitDepth::Ten } else { BitDepth::Eight },
        hdr: v.hdr,
        audio_tracks: first.audio_tracks.len() as u32,
    }
}

/// MP4 timescale shared by every piece and the join, so every frame lasts a whole number of
/// ticks: 512 x fps for integer rates up to 127 (30 -> 15360), the numerator for fractional
/// rates (30000/1001 -> 30000), 90000 otherwise.
pub(crate) fn timescale(rate: Rational) -> u32 {
    if rate.den == 1 {
        if rate.num <= 127 { 512 * rate.num } else { 90_000 }
    } else {
        rate.num
    }
}

/// NVENC options, identical for every piece of one export (RESULT.md section 6).
/// H.264 never uses B-frames as references (`-b_ref_mode disabled`): with `middle`, the
/// processor and GPU decoders disagreed on full-length encodes.
pub(crate) fn video_settings(codec: OutputCodec, ten_bit: bool) -> Vec<String> {
    let cq = EXPORT_CQ.to_string();
    let gop = EXPORT_GOP.to_string();
    let bref = if codec == OutputCodec::H264 { "disabled" } else { "middle" };
    let mut a: Vec<String> = vec![
        "-c:v".into(),
        if codec == OutputCodec::H264 { "h264_nvenc" } else { "hevc_nvenc" }.into(),
    ];
    for s in [
        "-preset", EXPORT_PRESET, "-tune", "hq", "-rc", "vbr", "-cq", &cq, "-b:v", "0", "-bf", "3", "-b_ref_mode", bref,
        "-spatial-aq", "1", "-temporal-aq", "1", "-rc-lookahead", "32", "-g", &gop,
    ] {
        a.push(s.to_string());
    }
    // Without -maxrate NVENC caps the rate by itself and cq stops governing hard scenes.
    let tail: &[&str] = match codec {
        OutputCodec::H264 => &["-maxrate", "240M", "-bufsize", "300M", "-profile:v", "high"],
        OutputCodec::Hevc => &[
            "-maxrate", "160M", "-bufsize", "160M", "-profile:v", if ten_bit { "main10" } else { "main" }, "-tier", "high",
            "-tag:v", "hvc1",
        ],
    };
    a.extend(tail.iter().map(|s| s.to_string()));
    a
}

/// Output sample index where each clip starts, plus the total at the end:
/// `floor(frames_before * 48000 * den / num)`, from the cumulative frame count, so the sound is
/// exactly as long as the picture to the sample, also at 30000/1001 (1601.6 samples a frame).
pub(crate) fn sample_edges(frames: &[i64], rate: Rational) -> Vec<i64> {
    let mut edges = Vec::with_capacity(frames.len() + 1);
    edges.push(0);
    let mut cum: i128 = 0;
    for &n in frames {
        cum += n as i128;
        edges.push((cum * EXPORT_AUDIO_RATE as i128 * rate.den as i128 / rate.num as i128) as i64);
    }
    edges
}

/// The first source sample (at 48 kHz, from the first video frame) of frame `frame`.
pub(crate) fn frame_to_sample(frame: i64, rate: Rational) -> i64 {
    (frame as i128 * EXPORT_AUDIO_RATE as i128 * rate.den as i128).div_euclid(rate.num as i128) as i64
}

/// Seconds of `frames` frames.
pub(crate) fn frames_to_seconds(frames: i64, rate: Rational) -> f64 {
    frames as f64 * rate.den as f64 / rate.num as f64
}

/// Estimated seconds for the export (RESULT.md "Model"): per clip and per frame scaled by the
/// pixel count relative to 4K, plus the join. Audio runs alongside the pieces and adds nothing.
pub(crate) fn estimate_seconds(clips: usize, frames: i64, format: &OutputFormat, bytes: u64, parallel: usize) -> f64 {
    let pixel_scale = (format.width as f64 * format.height as f64) / (3840.0 * 2160.0);
    let (per_clip, per_frame) = if parallel >= 2 {
        (SECONDS_PER_CLIP_PARALLEL, SECONDS_PER_4K_FRAME_PARALLEL)
    } else {
        (SECONDS_PER_CLIP_SERIAL, SECONDS_PER_4K_FRAME_SERIAL)
    };
    clips as f64 * per_clip + frames as f64 * per_frame * pixel_scale + join_seconds(bytes)
}

/// Estimated seconds of the join for a file of `bytes`.
pub(crate) fn join_seconds(bytes: u64) -> f64 {
    bytes as f64 / JOIN_BYTES_PER_SECOND
}

/// The rate ceiling of each codec's settings (`-maxrate`), bits per second.
pub(crate) fn rate_ceiling(codec: OutputCodec) -> f64 {
    match codec {
        OutputCodec::H264 => 240e6,
        OutputCodec::Hevc => 160e6,
    }
}

/// Output video bit rate (bits per second) for a source of `source_bits_per_second`:
/// `min(ceiling, max(ratio x source, floor))`, ratio 1.17 (H.264) or 3.15 (HEVC), ceiling 240
/// or 160 Mb/s, floor [`MIN_VIDEO_BITS_4K30_H264`] or [`MIN_VIDEO_BITS_4K30_HEVC`] times
/// `output_scale` (the output's pixels per second relative to 4K30). `scale` adjusts for a
/// source of a different size or frame rate than the output.
pub(crate) fn output_video_bit_rate(codec: OutputCodec, source_bits_per_second: Option<f64>, scale: f64, output_scale: f64) -> f64 {
    let (ratio, floor) = match codec {
        OutputCodec::H264 => (1.17, MIN_VIDEO_BITS_4K30_H264),
        OutputCodec::Hevc => (3.15, MIN_VIDEO_BITS_4K30_HEVC),
    };
    let ceiling = rate_ceiling(codec);
    match source_bits_per_second {
        Some(r) if r > 0.0 => (ratio * r * scale.clamp(0.1, 10.0)).max(floor * output_scale).min(ceiling),
        _ => ceiling,
    }
}

/// A frame rate for people: "30", "29.97", "59.94".
pub(crate) fn rate_label(rate: Rational) -> String {
    if rate.den == 1 {
        return rate.num.to_string();
    }
    let s = format!("{:.3}", rate.num as f64 / rate.den as f64);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Bytes for people, in the units Windows Explorer and the Export dialog use (1 KB = 1024
/// bytes): "17.0 GB", "610 MB", "977 KB", so the core's messages and the dialog's own
/// figures agree.
pub fn format_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.1} GB", b / GB)
    } else if b >= MB {
        format!("{:.0} MB", b / MB)
    } else if b >= KB {
        format!("{:.0} KB", b / KB)
    } else {
        format!("{bytes} B")
    }
}

/// The size a picture of `src_w` x `src_h` is scaled to inside `w` x `h`, keeping its shape,
/// both sides even.
pub(crate) fn fit_inside(src_w: u32, src_h: u32, w: u32, h: u32) -> (u32, u32) {
    let aspect = src_w as f64 / src_h.max(1) as f64;
    let box_aspect = w as f64 / h.max(1) as f64;
    let even = |v: f64| ((v / 2.0).round() as u32 * 2).max(2);
    if (aspect - box_aspect).abs() / box_aspect < 0.002 {
        (w, h)
    } else if aspect > box_aspect {
        (w, even(w as f64 / aspect).min(h))
    } else {
        (even(h as f64 * aspect).min(w), h)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rc_types::{AudioTrackInfo, VideoInfo};

    fn media(codec: &str, w: u32, h: u32, depth: BitDepth, hdr: bool, tracks: usize) -> MediaInfo {
        MediaInfo {
            duration: 10_000_000,
            container: "mp4".into(),
            video: VideoInfo {
                codec: codec.into(),
                width: w,
                height: h,
                frame_rate: Rational { num: 30, den: 1 },
                variable_frame_rate: false,
                bit_depth: depth,
                hdr,
            },
            audio_tracks: (0..tracks)
                .map(|i| AudioTrackInfo { index: i as u32, codec: "aac".into(), channels: 2, sample_rate: 48000, title: None })
                .collect(),
            speech_track: 0,
            direct_playable: true,
        }
    }

    #[test]
    fn format_follows_the_first_clip() {
        let r30 = Rational { num: 30, den: 1 };
        let f = output_format(&media("h264", 3840, 2160, BitDepth::Eight, false, 2), r30);
        assert_eq!((f.codec, f.width, f.height, f.bit_depth, f.hdr, f.audio_tracks), (OutputCodec::H264, 3840, 2160, BitDepth::Eight, false, 2));
        let f = output_format(&media("hevc", 3840, 2160, BitDepth::Ten, true, 1), r30);
        assert_eq!((f.codec, f.bit_depth, f.hdr), (OutputCodec::Hevc, BitDepth::Ten, true));
        // 10-bit H.264 cannot be encoded by h264_nvenc: HEVC Main10 keeps the bit depth.
        let f = output_format(&media("h264", 1920, 1080, BitDepth::Ten, false, 1), r30);
        assert_eq!((f.codec, f.bit_depth), (OutputCodec::Hevc, BitDepth::Ten));
        // Other codecs become H.264; odd sizes are made even.
        let f = output_format(&media("prores", 1921, 1081, BitDepth::Eight, false, 0), r30);
        assert_eq!((f.codec, f.width, f.height, f.audio_tracks), (OutputCodec::H264, 1920, 1080, 0));
    }

    #[test]
    fn frame_rate_follows_the_first_clip_when_the_cuts_stay_on_its_frames() {
        let r = |num, den| Rational { num, den };
        let mut m = media("h264", 1920, 1080, BitDepth::Eight, false, 1);
        m.video.frame_rate = r(60, 1);
        assert_eq!(output_format(&m, r(30, 1)).frame_rate, r(60, 1));
        assert_eq!(output_format(&m, r(60, 1)).frame_rate, r(60, 1));
        // Not a whole multiple of the sequence rate: the sequence rate.
        assert_eq!(output_format(&m, r(25, 1)).frame_rate, r(25, 1));
        assert_eq!(output_format(&m, r(30000, 1001)).frame_rate, r(30000, 1001));
        m.video.frame_rate = r(30, 1);
        assert_eq!(output_format(&m, r(60, 1)).frame_rate, r(60, 1));
        m.video.frame_rate = r(60000, 1001);
        assert_eq!(output_format(&m, r(30000, 1001)).frame_rate, r(60000, 1001));
        assert_eq!(rate_multiple(r(60000, 1001), r(30000, 1001)), Some(2));
        assert_eq!(rate_multiple(r(30, 1), r(30, 1)), Some(1));
        assert_eq!(rate_multiple(r(25, 1), r(30, 1)), None);
    }

    #[test]
    fn timescales_hold_whole_frames() {
        assert_eq!(timescale(Rational { num: 30, den: 1 }), 15360);
        assert_eq!(timescale(Rational { num: 25, den: 1 }), 12800);
        assert_eq!(timescale(Rational { num: 60, den: 1 }), 30720);
        assert_eq!(timescale(Rational { num: 30000, den: 1001 }), 30000);
        assert_eq!(timescale(Rational { num: 240, den: 1 }), 90000);
    }

    #[test]
    fn settings_match_the_experiment() {
        let h = video_settings(OutputCodec::H264, false).join(" ");
        assert_eq!(
            h,
            "-c:v h264_nvenc -preset p4 -tune hq -rc vbr -cq 19 -b:v 0 -bf 3 -b_ref_mode disabled -spatial-aq 1 -temporal-aq 1 \
             -rc-lookahead 32 -g 60 -maxrate 240M -bufsize 300M -profile:v high"
        );
        let x = video_settings(OutputCodec::Hevc, true).join(" ");
        assert_eq!(
            x,
            "-c:v hevc_nvenc -preset p4 -tune hq -rc vbr -cq 19 -b:v 0 -bf 3 -b_ref_mode middle -spatial-aq 1 -temporal-aq 1 \
             -rc-lookahead 32 -g 60 -maxrate 160M -bufsize 160M -profile:v main10 -tier high -tag:v hvc1"
        );
        assert!(video_settings(OutputCodec::Hevc, false).join(" ").contains("-profile:v main "));
    }

    #[test]
    fn sample_edges_follow_cumulative_frames() {
        let ntsc = Rational { num: 30000, den: 1001 };
        let e = sample_edges(&[1, 1, 1, 1, 1], ntsc);
        // 1601.6 samples a frame: floor of the cumulative value, never drifting.
        assert_eq!(e, vec![0, 1601, 3203, 4804, 6406, 8008]);
        assert_eq!(sample_edges(&[300, 1], Rational { num: 30, den: 1 }), vec![0, 480000, 481600]);
        assert_eq!(frame_to_sample(100, Rational { num: 30, den: 1 }), 160000);
        assert_eq!(frame_to_sample(5, ntsc), 8008);
    }

    #[test]
    fn estimates_follow_the_model() {
        let f = OutputFormat {
            codec: OutputCodec::H264,
            width: 3840,
            height: 2160,
            frame_rate: Rational { num: 30, den: 1 },
            bit_depth: BitDepth::Eight,
            hdr: false,
            audio_tracks: 1,
        };
        // The worked example: 300 clips, 73,800 frames, 22 GB: about 13.5 minutes.
        let s = estimate_seconds(300, 73_800, &f, 22_000_000_000, 2);
        assert!((s - (150.0 + 553.5 + 110.0)).abs() < 0.01, "{s}");
        assert_eq!(output_video_bit_rate(OutputCodec::H264, Some(100e6), 1.0, 1.0), 117e6);
        assert_eq!(output_video_bit_rate(OutputCodec::H264, Some(500e6), 1.0, 1.0), 240e6);
        assert_eq!(output_video_bit_rate(OutputCodec::Hevc, None, 1.0, 1.0), 160e6);
        // A source at a very low rate: the floor, scaled to the output's pixels per second.
        assert_eq!(output_video_bit_rate(OutputCodec::H264, Some(1.1e6), 1.0, 1.0), 3.0e6);
        assert_eq!(output_video_bit_rate(OutputCodec::H264, Some(1.1e6), 1.0, 0.25), 1.1e6 * 1.17);
        assert_eq!(output_video_bit_rate(OutputCodec::Hevc, Some(0.5e6), 1.0, 1.0), 2.5e6);
    }

    #[test]
    fn labels() {
        assert_eq!(rate_label(Rational { num: 30000, den: 1001 }), "29.97");
        assert_eq!(rate_label(Rational { num: 60, den: 1 }), "60");
        assert_eq!(format_bytes(18_234_000_000), "17.0 GB");
        assert_eq!(format_bytes(1_000_000), "977 KB");
        assert_eq!(format_bytes(46_230_000), "44 MB");
        assert_eq!(format_bytes(640_000_000), "610 MB");
        assert_eq!(fit_inside(1920, 1080, 3840, 2160), (3840, 2160));
        assert_eq!(fit_inside(1440, 1080, 3840, 2160), (2880, 2160));
        assert_eq!(fit_inside(1080, 1920, 1920, 1080), (608, 1080));
    }
}
