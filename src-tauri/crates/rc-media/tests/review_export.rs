//! Review tests (track mediaExport-review): export cases the track's own tests do not cover.
//! Sources whose streams do not start at zero (MPEG-TS, video delayed in an MP4) and an
//! NTSC (30000/1001) source. Every frame carries the export experiment's 16-block marker.

mod common;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use rc_media::{CancelToken, ExportOptions, ExportSource, ExportSpec, FfmpegTools, probe, run_export};
use rc_types::grid::frame_to_micros;
use rc_types::{Clip, ExportRequest, Rational};

const RATE: f64 = 48_000.0;
const BEEP: &str = "0.5*sin(2*PI*1000*t)*lt(mod(t,1),0.05)";

fn dir() -> PathBuf {
    let d = std::env::temp_dir().join("rc-media-review-export-src");
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// 1280x720 marker source with a 1 kHz beep on every whole second, libx264 (no GPU).
fn marker_mp4(tools: &FfmpegTools, name: &str, rate: &str, dur: u32, sid: u32) -> PathBuf {
    let out = dir().join(format!("{name}.mp4"));
    if out.is_file() {
        return out;
    }
    let graph = format!(
        "testsrc2=s=1280x720:r={rate}:d={dur}[bg];nullsrc=s=16x2:r={rate}:d={dur},format=gray,\
         geq=lum='if(lt(X,12),255*mod(floor(N/pow(2,X)),2),255*mod(floor({sid}/pow(2,X-12)),2))',\
         scale=1280:{mh}:flags=neighbor[mk];[bg][mk]overlay=0:0,format=yuv420p[v];\
         aevalsrc=exprs='{BEEP}|{BEEP}':s=48000:d={dur}[a]",
        mh = 160 * 720 / 2160
    );
    let tmp = dir().join(format!("{name}.tmp.mp4"));
    common::ffmpeg(
        tools,
        &[
            "-filter_complex", &graph, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-g", "60",
            "-bf", "2", "-c:a", "aac", "-b:a", "256k", "-ar", "48000", &tmp.to_string_lossy(),
        ],
    );
    std::fs::rename(&tmp, &out).unwrap();
    out
}

fn markers(tools: &FfmpegTools, file: &Path) -> Vec<(u32, u32)> {
    let out = Command::new(&tools.ffmpeg)
        .args(["-v", "error", "-i"])
        .arg(file)
        .args(["-map", "0:v:0", "-vf", "crop=iw:trunc(160*ih/2160):0:0,scale=16:1:flags=area,format=gray", "-fps_mode", "passthrough", "-f", "rawvideo", "-"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    out.stdout
        .as_chunks::<16>()
        .0
        .iter()
        .map(|b| {
            let v = b.iter().enumerate().fold(0u32, |v, (bit, &x)| if x > 128 { v | (1 << bit) } else { v });
            (v >> 12, v & 0xFFF)
        })
        .collect()
}

fn onsets(x: &[f32]) -> Vec<i64> {
    let mut out = Vec::new();
    let mut quiet = usize::MAX / 2;
    for (i, v) in x.iter().enumerate() {
        if v.abs() > 0.1 {
            if quiet >= 9600 {
                out.push(i as i64);
            }
            quiet = 0;
        } else {
            quiet += 1;
        }
    }
    out
}

fn export(tools: &FfmpegTools, path: &Path, list: &[(i64, i64)], name: &str) -> (PathBuf, Rational) {
    let media = probe(tools, path, &CancelToken::new()).unwrap();
    let rate = media.video.frame_rate;
    let mut sources = HashMap::new();
    sources.insert("s".to_string(), ExportSource { path: path.to_path_buf(), media });
    let clips: Vec<Clip> = list
        .iter()
        .enumerate()
        .map(|(i, (k, n))| Clip { id: format!("c{i}"), source_id: "s".into(), start: frame_to_micros(*k, rate), end: frame_to_micros(k + n, rate) })
        .collect();
    let scratch = common::scratch(&format!("review-export-{name}"));
    let req = ExportRequest { project_id: "p".into(), clips, folder: scratch.join("out").to_string_lossy().into_owned(), file_name: name.into() };
    let work = scratch.join("work");
    let spec = ExportSpec { request: &req, sources: &sources, frame_rate: rate, work_root: &work, options: ExportOptions::default() };
    let res = run_export(tools, &spec, &CancelToken::new(), &mut |_| {}).unwrap_or_else(|e| panic!("{name}: {e:?}"));
    (PathBuf::from(res.path), rate)
}

/// Output sample where every source beep inside a clip should be, for a source whose audio
/// content at video frame k is `audio_lead + k / fps` seconds into the beep track.
fn expected_beeps(list: &[(i64, i64)], rate: Rational, audio_lead: f64) -> Vec<i64> {
    let mut out = Vec::new();
    let mut cum = 0i64;
    for (k, n) in list {
        let e0 = (cum as i128 * 48000 * rate.den as i128 / rate.num as i128) as i64;
        cum += n;
        let e1 = (cum as i128 * 48000 * rate.den as i128 / rate.num as i128) as i64;
        let t0 = audio_lead + *k as f64 * rate.den as f64 / rate.num as f64;
        for j in 0..100 {
            let at = e0 + ((j as f64 - t0) * RATE).round() as i64;
            if at >= e0 + 240 && at < e1 - 240 {
                out.push(at);
            }
        }
    }
    out
}

fn assert_beeps(got: &[i64], want: &[i64], what: &str) {
    assert!(!want.is_empty());
    for w in want {
        let near = got.iter().map(|g| (g - w).abs()).min().unwrap_or(i64::MAX);
        assert!(near <= 96, "{what}: beep expected at {:.4} s, nearest detected {:.4} s away; got {:?}", *w as f64 / RATE, near as f64 / RATE,
            got.iter().map(|g| *g as f64 / RATE).collect::<Vec<_>>());
    }
}

fn expected_cfr(sid: u32, list: &[(i64, i64)]) -> Vec<(u32, u32)> {
    list.iter().flat_map(|(k, n)| (*k..k + n).map(move |f| (sid, f as u32))).collect()
}

const LIST: [(i64, i64); 3] = [(100, 50), (31, 40), (200, 60)];

/// An MPEG-TS copy of a source (streams start near 1.4 s, as in every TS recording) must
/// export the same frames and the same sound as the MP4 it was copied from.
#[test]
fn review_mpegts_source_with_a_nonzero_start_exports_the_right_frames_and_sound() {
    let tools = common::tools();
    let mp4 = marker_mp4(&tools, "rv720", "30", 12, 7);
    let ts = dir().join("rv720.ts");
    if !ts.is_file() {
        common::ffmpeg(&tools, &["-i", &mp4.to_string_lossy(), "-map", "0", "-c", "copy", "-f", "mpegts", &ts.to_string_lossy()]);
    }
    let (out, rate) = export(&tools, &ts, &LIST, "from-ts");
    assert_eq!(markers(&tools, &out), expected_cfr(7, &LIST), "frames of the TS export");
    let got = onsets(&common::decode_audio(&tools, &out, 0, 48000));
    assert_beeps(&got, &expected_beeps(&LIST, rate, 0.0), "TS export track 0");
}

/// Exporting onto one of the project's own source files (same folder, same name) must not
/// destroy the original (spec 2.4.2: originals are read-only inputs).
#[test]
fn review_export_never_replaces_a_source_file() {
    use rc_media::plan_export;
    let tools = common::tools();
    let mp4 = marker_mp4(&tools, "rv720", "30", 12, 7);
    let scratch = common::scratch("review-export-onto-source");
    let src = scratch.join("weekly.mp4");
    std::fs::copy(&mp4, &src).unwrap();
    let before = std::fs::read(&src).unwrap();
    let media = probe(&tools, &src, &CancelToken::new()).unwrap();
    let rate = media.video.frame_rate;
    let mut sources = HashMap::new();
    sources.insert("s".to_string(), ExportSource { path: src.clone(), media });
    let clips = vec![Clip { id: "c".into(), source_id: "s".into(), start: 0, end: frame_to_micros(30, rate) }];
    let req = ExportRequest { project_id: "p".into(), clips, folder: scratch.to_string_lossy().into_owned(), file_name: "weekly".into() };
    let work = scratch.join("work");
    let spec = ExportSpec { request: &req, sources: &sources, frame_rate: rate, work_root: &work, options: ExportOptions::default() };
    let plan = plan_export(&tools, &spec, &CancelToken::new()).unwrap();
    let res = run_export(&tools, &spec, &CancelToken::new(), &mut |_| {});
    let after = std::fs::read(&src).unwrap();
    assert!(
        after == before,
        "the source was replaced by the export (plan blocked_by: {:?}, run result: {:?})",
        plan.blocked_by,
        res.map(|r| r.path)
    );
}

/// Spec 1.12 / 2.4.8 and the task: the output format follows the first clip, frame rate
/// included. Project grid 30 fps (first imported source), but the edit starts with a clip of
/// the 1080p60 fixture.
#[test]
fn review_output_frame_rate_follows_the_first_clip() {
    use rc_media::plan_export;
    let tools = common::tools();
    let a = common::fixture("numbered-4k-h264");
    let b = common::fixture("numbered-1080p60");
    let ma = probe(&tools, &a, &CancelToken::new()).unwrap();
    let mb = probe(&tools, &b, &CancelToken::new()).unwrap();
    let project_rate = ma.video.frame_rate;
    assert_eq!((project_rate, mb.video.frame_rate), (Rational { num: 30, den: 1 }, Rational { num: 60, den: 1 }));
    let mut sources = HashMap::new();
    sources.insert("a".to_string(), ExportSource { path: a, media: ma });
    sources.insert("b".to_string(), ExportSource { path: b, media: mb });
    let clips = vec![
        Clip { id: "1".into(), source_id: "b".into(), start: 0, end: frame_to_micros(30, project_rate) },
        Clip { id: "2".into(), source_id: "a".into(), start: 0, end: frame_to_micros(30, project_rate) },
    ];
    let scratch = common::scratch("review-export-first-rate");
    let req = ExportRequest { project_id: "p".into(), clips, folder: scratch.to_string_lossy().into_owned(), file_name: "x".into() };
    let work = scratch.join("work");
    let spec = ExportSpec { request: &req, sources: &sources, frame_rate: project_rate, work_root: &work, options: ExportOptions::default() };
    let plan = plan_export(&tools, &spec, &CancelToken::new()).unwrap();
    assert_eq!((plan.format.width, plan.format.height), (1920, 1080), "size follows the first clip");
    assert_eq!(plan.format.frame_rate, Rational { num: 60, den: 1 }, "frame rate should follow the first clip; notices {:?}", plan.notices);
}

/// The sound of the same TS edit, rendered on its own, has every beep where the cut puts it.
#[test]
fn review_mpegts_sound_is_rendered_in_place() {
    use rc_media::{AudioRenderRequest, ClipFrames, SequenceClip, prepare_source, render_audio};
    let tools = common::tools();
    let mp4 = marker_mp4(&tools, "rv720", "30", 12, 7);
    let ts = dir().join("rv720.ts");
    if !ts.is_file() {
        common::ffmpeg(&tools, &["-i", &mp4.to_string_lossy(), "-map", "0", "-c", "copy", "-f", "mpegts", &ts.to_string_lossy()]);
    }
    let media = probe(&tools, &ts, &CancelToken::new()).unwrap();
    let rate = media.video.frame_rate;
    let src = prepare_source(&tools, &ts, &media, &CancelToken::new()).unwrap();
    let seq: Vec<SequenceClip<'_>> = LIST.iter().map(|(k, n)| SequenceClip { source: &src, clip: ClipFrames { start_frame: *k, frames: *n } }).collect();
    let format = rc_media::output_format(&media, rate);
    let scratch = common::scratch("review-export-ts-audio");
    let layouts = vec!["stereo".to_string()];
    let (script, out) = (scratch.join("a.txt"), scratch.join("a.nut"));
    let req = AudioRenderRequest { clips: &seq, format: &format, layouts: &layouts, script: &script, output: &out };
    render_audio(&tools, &req, &CancelToken::new(), &mut |_| {}).unwrap();
    let got = onsets(&common::decode_audio(&tools, &out, 0, 48000));
    assert_beeps(&got, &expected_beeps(&LIST, rate, 0.0), "TS sound");
}

/// A Matroska copy (OBS's default container) exports the same frames and sound.
#[test]
fn review_matroska_source_exports_the_right_frames_and_sound() {
    let tools = common::tools();
    let mp4 = marker_mp4(&tools, "rv720", "30", 12, 7);
    let mkv = dir().join("rv720.mkv");
    if !mkv.is_file() {
        common::ffmpeg(&tools, &["-i", &mp4.to_string_lossy(), "-map", "0", "-c", "copy", &mkv.to_string_lossy()]);
    }
    let (out, rate) = export(&tools, &mkv, &LIST, "from-mkv");
    assert_eq!(markers(&tools, &out), expected_cfr(7, &LIST), "frames of the MKV export");
    let got = onsets(&common::decode_audio(&tools, &out, 0, 48000));
    assert_beeps(&got, &expected_beeps(&LIST, rate, 0.0), "MKV export track 0");
}

/// An MP4 whose video starts 0.5 s after its sound (time zero is the first video frame, so
/// frame k goes with the sound 0.5 + k/30 s into the file).
#[test]
fn review_video_that_starts_after_the_sound_keeps_sync() {
    let tools = common::tools();
    let mp4 = marker_mp4(&tools, "rv720", "30", 12, 7);
    let late = dir().join("rv720-video-late.mp4");
    if !late.is_file() {
        let m = mp4.to_string_lossy();
        common::ffmpeg(&tools, &["-itsoffset", "0.5", "-i", &m, "-i", &m, "-map", "0:v", "-map", "1:a", "-c", "copy", &late.to_string_lossy()]);
    }
    let (out, rate) = export(&tools, &late, &LIST, "video-late");
    assert_eq!(markers(&tools, &out), expected_cfr(7, &LIST), "frames");
    let got = onsets(&common::decode_audio(&tools, &out, 0, 48000));
    assert_beeps(&got, &expected_beeps(&LIST, rate, 0.5), "video-late track 0");
}

/// 30000/1001, the experiment's NTSC case: exact frames, regular 1001-tick packets, sound as
/// long as the picture.
#[test]
fn review_ntsc_rate_is_frame_exact() {
    let tools = common::tools();
    let src = marker_mp4(&tools, "rv720ntsc", "30000/1001", 12, 9);
    let (out, rate) = export(&tools, &src, &LIST, "ntsc");
    assert_eq!(rate, Rational { num: 30000, den: 1001 });
    assert_eq!(markers(&tools, &out), expected_cfr(9, &LIST));
    let total: i64 = LIST.iter().map(|c| c.1).sum();
    let a = common::decode_audio(&tools, &out, 0, 48000);
    let want = (total as i128 * 48000 * 1001 / 30000) as i64;
    assert!((a.len() as i64 - want).abs() < 1602, "{} samples, video {want}", a.len());
    assert_beeps(&onsets(&a), &expected_beeps(&LIST, rate, 0.0), "ntsc track 0");
}
