//! Helpers for the integration tests: fixtures, ffprobe checks, decoding.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;

use rc_media::FfmpegTools;
use serde_json::Value;

/// The project root (`roughcut/`).
pub fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap()
}

/// `fixtures/out/manifest.json`.
pub fn manifest() -> Value {
    let p = root().join("fixtures/out/manifest.json");
    let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e} (run `npm run fixtures`)", p.display()));
    serde_json::from_str(&text).unwrap()
}

/// Absolute path of a fixture by name.
pub fn fixture(name: &str) -> PathBuf {
    root().join("fixtures/out").join(format!("{name}.mp4"))
}

pub fn tools() -> FfmpegTools {
    FfmpegTools::locate(None).expect("ffmpeg and ffprobe on PATH: source tools/env.sh")
}

/// A fresh, empty folder for one test. The same test's folders from earlier runs (other
/// process ids, untouched for an hour) are removed, so outputs do not pile up in %TEMP%.
pub fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join("rc-media-it");
    if let Ok(rd) = std::fs::read_dir(&root) {
        let prefix = format!("{name}-");
        for e in rd.filter_map(|e| e.ok()) {
            let n = e.file_name().to_string_lossy().into_owned();
            let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|d| d.as_secs() > 3600);
            if old && n.strip_prefix(&prefix).is_some_and(|pid| !pid.is_empty() && pid.chars().all(|c| c.is_ascii_digit())) {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    let dir = root.join(format!("{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// ffprobe's streams and format as JSON.
pub fn ffprobe_json(tools: &FfmpegTools, file: &Path) -> Value {
    let out = Command::new(&tools.ffprobe)
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(file)
        .output()
        .unwrap();
    assert!(out.status.success(), "ffprobe failed: {}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).unwrap()
}

/// Video packets of the first video stream: (pts seconds, is keyframe), sorted by time.
pub fn video_packets(tools: &FfmpegTools, file: &Path) -> Vec<(f64, bool)> {
    let out = Command::new(&tools.ffprobe)
        .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0"])
        .arg(file)
        .output()
        .unwrap();
    assert!(out.status.success());
    let mut v: Vec<(f64, bool)> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let mut it = l.split(',');
            let t = it.next()?.trim().parse::<f64>().ok()?;
            let flags = it.next().unwrap_or("");
            Some((t, flags.starts_with('K')))
        })
        .collect();
    v.sort_by(|a, b| a.0.total_cmp(&b.0));
    v
}

/// One audio track decoded to mono f32 at `rate`.
pub fn decode_audio(tools: &FfmpegTools, file: &Path, track: u32, rate: u32) -> Vec<f32> {
    let out = Command::new(&tools.ffmpeg)
        .args(["-v", "error", "-i"])
        .arg(file)
        .args(["-map", &format!("0:a:{track}"), "-ac", "1", "-ar", &rate.to_string(), "-f", "f32le", "pipe:1"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    out.stdout.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect()
}

/// Runs ffmpeg with these arguments and asserts success.
pub fn ffmpeg(tools: &FfmpegTools, args: &[&str]) {
    let out = Command::new(&tools.ffmpeg).args(["-v", "error", "-y"]).args(args).output().unwrap();
    assert!(out.status.success(), "ffmpeg {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// Relative power of `freq` in `samples` (Goertzel), normalised so a full-scale sine gives ~0.25.
pub fn tone_power(samples: &[f32], rate: u32, freq: f64) -> f64 {
    let n = samples.len() as f64;
    let w = 2.0 * std::f64::consts::PI * freq / rate as f64;
    let coeff = 2.0 * w.cos();
    let (mut s1, mut s2) = (0.0f64, 0.0f64);
    for &x in samples {
        let s0 = x as f64 + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    let power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    power / (n * n)
}

/// Asserts the proxy's properties: 1280×720 H.264 yuv420p at `fps`, constant frame rate,
/// keyframes exactly every half second from 0, starts at 0, lasts `duration_us` within a
/// frame, and one stereo AAC track when `audio` is true. Returns the frame count.
pub fn check_proxy(tools: &FfmpegTools, file: &Path, fps: f64, duration_us: i64, audio: bool) -> usize {
    let j = ffprobe_json(tools, file);
    let streams = j["streams"].as_array().unwrap();
    let v = streams.iter().find(|s| s["codec_type"] == "video").expect("video stream");
    assert_eq!(v["codec_name"], "h264");
    assert_eq!(v["width"], 1280);
    assert_eq!(v["height"], 720);
    assert_eq!(v["pix_fmt"], "yuv420p");
    let a: Vec<&Value> = streams.iter().filter(|s| s["codec_type"] == "audio").collect();
    if audio {
        assert_eq!(a.len(), 1, "one mixed audio track");
        assert_eq!(a[0]["codec_name"], "aac");
        assert_eq!(a[0]["channels"], 2);
        assert_eq!(a[0]["sample_rate"], "48000");
    } else {
        assert!(a.is_empty());
    }
    let frame = 1.0 / fps;
    let fmt_dur: f64 = j["format"]["duration"].as_str().unwrap().parse().unwrap();
    let want = duration_us as f64 / 1e6;
    assert!((fmt_dur - want).abs() <= frame + 1e-6, "proxy lasts {fmt_dur} s, source {want} s");

    let pk = video_packets(tools, file);
    assert!(pk[0].0.abs() < 1e-6, "proxy starts at {}", pk[0].0);
    let expected_frames = (want * fps).round() as i64;
    assert!((pk.len() as i64 - expected_frames).abs() <= 1, "{} frames, expected {expected_frames}", pk.len());
    // Constant frame rate: every interval one frame (within the 1/15360-style rounding).
    for w in pk.windows(2) {
        let d = w[1].0 - w[0].0;
        assert!((d - frame).abs() < 0.0005, "interval {d} at {} (frame {frame})", w[0].0);
    }
    let last_video_end = pk.last().unwrap().0 + frame;
    assert!((last_video_end - want).abs() <= frame + 1e-6, "video ends at {last_video_end}, source {want}");
    // Keyframes exactly every half second, and nowhere else.
    let keys: Vec<f64> = pk.iter().filter(|p| p.1).map(|p| p.0).collect();
    let expected_keys = ((pk.last().unwrap().0 + 1e-6) / 0.5).floor() as usize + 1;
    assert_eq!(keys.len(), expected_keys, "keyframes at {keys:?}");
    for (i, k) in keys.iter().enumerate() {
        let target = i as f64 * 0.5;
        assert!((k - target).abs() <= frame / 2.0, "keyframe {i} at {k}, expected {target}");
    }
    pk.len()
}

/// A 4:3 source with a rotation flag whose picture starts 0.5 s after its sound.
pub fn make_odd_source(tools: &FfmpegTools, dir: &Path) -> PathBuf {
    let plain = dir.join("odd-plain.mp4");
    let rotated = dir.join("odd.mp4");
    let plain_s = plain.to_string_lossy().to_string();
    let rotated_s = rotated.to_string_lossy().to_string();
    ffmpeg(
        tools,
        &[
            "-itsoffset", "0.5", "-f", "lavfi", "-i", "color=c=red:s=640x480:r=30:d=3",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3.5",
            "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", &plain_s,
        ],
    );
    ffmpeg(tools, &["-display_rotation:v:0", "90", "-i", &plain_s, "-c", "copy", &rotated_s]);
    rotated
}
