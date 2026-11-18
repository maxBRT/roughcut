//! Review tests (track mediaImport-review): cases the original tests do not cover.
//! Each builds a small source with FFmpeg and checks one claim of the spec or the crate docs.

mod common;

use std::process::Command;

use common::*;
use rc_media::{CancelToken, EncoderChoice, ProxyRequest, make_proxy, probe};
use rc_types::Rational;

/// Audio track `track` of `file` as mono f32 at 48 kHz on the file's clock (a late start is
/// padded with silence, so sample n is at n / 48000 s from the file's time zero).
fn decode_on_clock(tools: &rc_media::FfmpegTools, file: &std::path::Path, track: u32) -> Vec<f32> {
    let out = Command::new(&tools.ffmpeg)
        .args(["-v", "error", "-i"])
        .arg(file)
        .args([
            "-map",
            &format!("0:a:{track}"),
            "-af",
            "aresample=async=1:first_pts=0",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "f32le",
            "pipe:1",
        ])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    out.stdout.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect()
}

/// An OBS-style recording: 60 fps H.264 in Matroska, whose 1 ms time base stores the
/// 16.67 ms frame interval as 17, 17, 16 ticks. That is constant frame rate.
#[test]
fn review_60fps_matroska_is_not_variable_frame_rate() {
    let tools = tools();
    let dir = scratch("review-mkv60");
    let src = dir.join("obs60.mkv");
    ffmpeg(
        &tools,
        &[
            "-f", "lavfi", "-i", "testsrc2=s=320x240:r=60:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            &src.to_string_lossy(),
        ],
    );
    let info = probe(&tools, &src, &CancelToken::new()).unwrap();
    assert_eq!(info.video.frame_rate, Rational { num: 60, den: 1 });
    assert!(!info.video.variable_frame_rate, "a constant 60 fps Matroska file is reported as variable frame rate: {info:#?}");
}

/// Camera footage in 10-bit 4:2:2 (common for HEVC and H.264 from mirrorless cameras). The
/// player spike only showed 4:2:0 (8-bit and Main10/High10) playing in Edge.
#[test]
fn review_422_sources_are_not_claimed_direct_playable() {
    let tools = tools();
    let dir = scratch("review-422");
    for (name, codec) in [("h264-422.mp4", "libx264"), ("hevc-422.mp4", "libx265")] {
        let src = dir.join(name);
        let mut args = vec![
            "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
            "-c:v", codec, "-pix_fmt", "yuv422p10le",
        ];
        if codec == "libx265" {
            args.extend(["-tag:v", "hvc1", "-x265-params", "log-level=error"]);
        }
        let s = src.to_string_lossy().to_string();
        args.extend(["-c:a", "aac", "-shortest", &s]);
        ffmpeg(&tools, &args);
        let info = probe(&tools, &src, &CancelToken::new()).unwrap();
        assert!(!info.direct_playable, "{name}: 4:2:2 is reported direct playable: {info:#?}");
    }
}

/// HEVC 4:2:2 cannot be decoded by NVDEC on this GPU (RTX 40 series), but NVENC works. The
/// automatic fallback should keep the GPU encoder (software decode + NVENC) rather than drop
/// straight to libx264, and should not report the GPU as unavailable.
#[test]
fn review_hevc_422_proxy_still_uses_nvenc() {
    let tools = tools();
    let dir = scratch("review-hevc422-proxy");
    let src = dir.join("hevc-422.mp4");
    ffmpeg(
        &tools,
        &[
            "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=2", "-c:v", "libx265", "-pix_fmt", "yuv422p10le", "-tag:v", "hvc1",
            "-x265-params", "log-level=error", &src.to_string_lossy(),
        ],
    );
    let media = probe(&tools, &src, &CancelToken::new()).unwrap();
    let out = dir.join("proxy.mp4");
    let req = ProxyRequest { encoder: EncoderChoice::Auto, ..ProxyRequest::new(&src, &media, &out) };
    let outcome = make_proxy(&tools, &req, &CancelToken::new(), &mut |_| {}).unwrap();
    assert!(
        outcome.used_gpu && outcome.gpu_failure.is_none(),
        "NVENC works on this PC, yet the proxy fell back to libx264: {:?}",
        outcome.gpu_failure
    );
}

/// Two audio tracks where the second starts 1 s after the picture (a recorder that joined
/// late). In the proxy's stereo mix its tone must start at 1 s, as it does in the original.
#[test]
fn review_mixed_tracks_keep_their_own_start_times() {
    let tools = tools();
    let dir = scratch("review-late-track");
    let src = dir.join("late-track.mp4");
    let s = src.to_string_lossy().to_string();
    ffmpeg(
        &tools,
        &[
            "-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=3",
            "-f", "lavfi", "-t", "3", "-i", "anullsrc=r=48000:cl=mono",
            "-itsoffset", "1.0", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=2",
            "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", &s,
        ],
    );
    // In the original, on its own clock, the tone of track 1 starts at 1 s.
    let orig = decode_on_clock(&tools, &src, 1);
    let rms = |a: &[f32]| (a.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / a.len() as f64).sqrt();
    assert!(rms(&orig[9600..38400]) < 0.01, "original: silent from 0.2 s to 0.8 s");
    assert!(rms(&orig[57600..86400]) > 0.04, "original: tone from 1.2 s to 1.8 s");

    let media = probe(&tools, &src, &CancelToken::new()).unwrap();
    let out = dir.join("proxy.mp4");
    let req = ProxyRequest { encoder: EncoderChoice::SoftwareOnly, ..ProxyRequest::new(&src, &media, &out) };
    make_proxy(&tools, &req, &CancelToken::new(), &mut |_| {}).unwrap();
    let mix = decode_on_clock(&tools, &out, 0);
    assert!(rms(&mix[9600..38400]) < 0.01, "proxy: the late track's tone is heard before 1 s (rms {})", rms(&mix[9600..38400]));
    assert!(rms(&mix[57600..86400]) > 0.03, "proxy: tone from 1.2 s to 1.8 s");
}
