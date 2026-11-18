//! Spec 3.7, `media`: "The proxy has constant frame rate and half-second keyframes", with the
//! real FFmpeg on the generated fixtures; plus cancel, the software fallback, every audio
//! track in the mix, HDR to SDR, and sources that are rotated, not 16:9, or start late.

mod common;

use std::process::Command;
use std::time::{Duration, Instant};

use common::*;
use rc_media::{CancelToken, EncoderChoice, ProxyRequest, in_progress_path, make_proxy, probe};
use rc_types::ErrorCode;

fn proxy_of(name: &str, encoder: EncoderChoice, simulate_gpu_failure: bool) -> (std::path::PathBuf, rc_media::ProxyOutcome, rc_types::MediaInfo) {
    let tools = tools();
    let src = fixture(name);
    let media = probe(&tools, &src, &CancelToken::new()).unwrap();
    let dir = scratch(&format!("proxy-{name}-{encoder:?}-{simulate_gpu_failure}"));
    let out = dir.join("sub").join("proxy.mp4");
    let mut req = ProxyRequest::new(&src, &media, &out);
    req.encoder = encoder;
    req.simulate_gpu_failure = simulate_gpu_failure;
    let mut reports = Vec::new();
    let outcome = make_proxy(&tools, &req, &CancelToken::new(), &mut |p| reports.push(p)).unwrap_or_else(|e| panic!("{name}: {e:?}"));
    assert!(out.is_file());
    assert!(!in_progress_path(&out).exists(), "in-progress file renamed away");
    assert!(reports.len() >= 2, "progress was reported");
    assert!(reports.windows(2).all(|w| w[1].fraction >= w[0].fraction || outcome.gpu_failure.is_some()));
    assert_eq!(reports.last().unwrap().fraction, 1.0);
    eprintln!("{name}: {:?} in {:.1} s", outcome.used_gpu, outcome.took_seconds);
    (out, outcome, media)
}

#[test]
fn h264_4k_proxy_is_cfr_720p_with_half_second_keyframes() {
    let (out, outcome, media) = proxy_of("numbered-4k-h264", EncoderChoice::Auto, false);
    assert!(outcome.used_gpu, "NVENC is available on this PC: {:?}", outcome.gpu_failure);
    assert_eq!(check_proxy(&tools(), &out, 30.0, media.duration, true), 900);
}

#[test]
fn vfr_proxy_is_constant_and_keeps_wall_clock_time() {
    let tools = tools();
    let (out, _, media) = proxy_of("numbered-vfr", EncoderChoice::Auto, false);
    // 894 source frames on a variable grid become 900 constant frames over the same 30 s.
    assert_eq!(check_proxy(&tools, &out, 30.0, media.duration, true), 900);
    // Sound keeps its place: beeps still start on whole seconds.
    let a = decode_audio(&tools, &out, 0, 48000);
    for k in [1usize, 10, 20, 29] {
        let onset = (k * 48000 - 2400..k * 48000 + 4800).find(|&i| a[i].abs() > 0.05).unwrap();
        let err_ms = (onset as f64 / 48.0) - k as f64 * 1000.0;
        assert!(err_ms.abs() < 34.0, "beep {k} at {err_ms} ms off");
    }
}

#[test]
fn hdr_proxy_is_8bit_sdr() {
    let tools = tools();
    let (out, outcome, media) = proxy_of("numbered-4k-hevc10-hdr", EncoderChoice::Auto, false);
    assert!(outcome.used_gpu);
    check_proxy(&tools, &out, 30.0, media.duration, true);
    let j = ffprobe_json(&tools, &out);
    let v = &j["streams"].as_array().unwrap().iter().find(|s| s["codec_type"] == "video").unwrap().clone();
    assert_eq!(v["color_transfer"], "bt709");
    assert_eq!(v["color_primaries"], "bt709");
}

#[test]
fn three_track_proxy_mixes_every_track_to_stereo() {
    let tools = tools();
    let (out, _, media) = proxy_of("numbered-3audio", EncoderChoice::Auto, false);
    check_proxy(&tools, &out, 30.0, media.duration, true);
    let a = decode_audio(&tools, &out, 0, 48000);
    let beep = &a[48000 + 960..48000 + 4320]; // 1.02 s to 1.09 s
    for f in [500.0, 1000.0, 2000.0] {
        let p = tone_power(beep, 48000, f);
        assert!(p > 0.001, "{f} Hz missing from the mix (power {p})");
    }
    assert!(tone_power(beep, 48000, 3000.0) < 0.0005);
}

#[test]
fn forced_software_proxy_has_the_same_properties() {
    let (out, outcome, media) = proxy_of("numbered-1080p60", EncoderChoice::SoftwareOnly, false);
    assert!(!outcome.used_gpu);
    assert_eq!(check_proxy(&tools(), &out, 60.0, media.duration, true), 1800);
    let j = ffprobe_json(&tools(), &out);
    assert_eq!(j["streams"][0]["r_frame_rate"], "60/1");
}

#[test]
fn a_failing_gpu_falls_back_to_the_processor() {
    let (out, outcome, media) = proxy_of("silence-only", EncoderChoice::Auto, true);
    assert!(!outcome.used_gpu);
    let why = outcome.gpu_failure.expect("the GPU failure is reported");
    assert_eq!(why.code, ErrorCode::GpuUnavailable);
    assert!(why.detail.is_some_and(|d| !d.is_empty()));
    check_proxy(&tools(), &out, 30.0, media.duration, true);
}

#[test]
fn gpu_only_failure_is_gpu_unavailable() {
    let tools = tools();
    let src = fixture("silence-only");
    let media = probe(&tools, &src, &CancelToken::new()).unwrap();
    let dir = scratch("proxy-gpu-only-fail");
    let out = dir.join("proxy.mp4");
    let mut req = ProxyRequest::new(&src, &media, &out);
    req.encoder = EncoderChoice::GpuOnly;
    req.simulate_gpu_failure = true;
    let err = make_proxy(&tools, &req, &CancelToken::new(), &mut |_| {}).unwrap_err();
    assert_eq!(err.code, ErrorCode::GpuUnavailable);
    assert!(!out.exists() && !in_progress_path(&out).exists());
}

#[test]
fn cancel_mid_run_kills_ffmpeg_and_leaves_nothing() {
    let tools = tools();
    let src = fixture("numbered-4k-h264");
    let media = probe(&tools, &src, &CancelToken::new()).unwrap();
    let dir = scratch("proxy-cancel");
    let out = dir.join("proxy.mp4");
    // The processor path is the slower one, so there is time to cancel in the middle.
    let mut req = ProxyRequest::new(&src, &media, &out);
    req.encoder = EncoderChoice::SoftwareOnly;
    let cancel = CancelToken::new();
    let c2 = cancel.clone();
    let mut cancelled_at: Option<Instant> = None;
    let mut last = 0.0;
    let res = make_proxy(&tools, &req, &cancel, &mut |p| {
        last = p.fraction;
        if p.fraction > 0.1 && cancelled_at.is_none() {
            cancelled_at = Some(Instant::now());
            c2.cancel();
        }
    });
    let err = res.unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);
    let after = cancelled_at.expect("progress passed 10 %").elapsed();
    assert!(after < Duration::from_secs(3), "stopped {after:?} after cancel");
    assert!(last < 1.0);
    assert!(!out.exists(), "no proxy");
    assert!(!in_progress_path(&out).exists(), "partial output removed");
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "folder left empty");
}

#[test]
fn rotated_4_3_late_starting_source_keeps_shape_and_first_frame() {
    let tools = tools();
    let dir = scratch("proxy-odd");
    let src = make_odd_source(&tools, &dir);
    let media = probe(&tools, &src, &CancelToken::new()).unwrap();
    for encoder in [EncoderChoice::Auto, EncoderChoice::SoftwareOnly] {
        let out = dir.join(format!("proxy-{encoder:?}.mp4"));
        make_proxy(&tools, &ProxyRequest { encoder, ..ProxyRequest::new(&src, &media, &out) }, &CancelToken::new(), &mut |_| {})
            .unwrap();
        // Starts at 0 with the first picture, lasts the 3 s of picture, 90 frames.
        let frames = check_proxy(&tools, &out, 30.0, media.duration, true);
        assert!((89..=91).contains(&frames), "{frames} frames");
        // The first frame: the 480×640 picture scaled to 540×720 in the middle, black bars beside.
        let raw = Command::new(&tools.ffmpeg)
            .args(["-v", "error", "-i"])
            .arg(&out)
            .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"])
            .output()
            .unwrap()
            .stdout;
        assert_eq!(raw.len(), 1280 * 720 * 3);
        let px = |x: usize, y: usize| {
            let i = (y * 1280 + x) * 3;
            (raw[i], raw[i + 1], raw[i + 2])
        };
        let (r, g, b) = px(640, 360);
        assert!(r > 200 && g < 60 && b < 60, "centre is the red picture: {:?}", (r, g, b));
        for x in [20, 360, 920, 1260] {
            let (r, g, b) = px(x, 360);
            assert!(r < 30 && g < 30 && b < 30, "bar at x={x} is black: {:?}", (r, g, b));
        }
        let (r, _, _) = px(380, 360);
        assert!(r > 200, "picture starts at x=370");
    }
}

/// The cache names the in-progress file itself (spec 3.6 rule 5): with `in_place` the proxy is
/// written straight to the given path, no `.part` of its own is made, and a cancelled run
/// removes the given file.
#[test]
fn in_place_proxy_writes_the_given_path_and_removes_it_on_cancel() {
    let tools = tools();
    let src = fixture("numbered-4k-h264");
    let media = probe(&tools, &src, &CancelToken::new()).unwrap();
    let dir = scratch("proxy-in-place");
    let out = dir.join("proxy.partial.mp4");
    let mut req = ProxyRequest::new(&src, &media, &out);
    req.in_place = true;
    let mut seen_part = false;
    make_proxy(&tools, &req, &CancelToken::new(), &mut |_| seen_part |= in_progress_path(&out).exists()).unwrap();
    assert!(out.is_file(), "written at the given path");
    assert!(!seen_part && !in_progress_path(&out).exists(), "no .part of its own");
    check_proxy(&tools, &out, 30.0, media.duration, true);

    std::fs::remove_file(&out).unwrap();
    let cancel = CancelToken::new();
    let c2 = cancel.clone();
    req.encoder = EncoderChoice::SoftwareOnly;
    let err = make_proxy(&tools, &req, &cancel, &mut |p| {
        if p.fraction > 0.05 {
            c2.cancel();
        }
    })
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);
    assert!(!out.exists() && !in_progress_path(&out).exists(), "the given file is removed");
}
