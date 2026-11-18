//! Export integration tests (spec 3.7, the Export row) with the real FFmpeg and NVENC.
//!
//! Exact frames are checked with sources made here that carry a machine-readable marker in
//! every frame (the export experiment's 16-block binary code: frame number and source id), on
//! top of the generated fixtures (`npm run fixtures`), which burn the number in as text.
//! Every source beeps on whole seconds (track 0) and half seconds (track 1) for sync checks.
//!
//! The tests share the GPU, so they run one at a time (a lock), and the marker sources are
//! made once into `%TEMP%/rc-media-export-src-v1`.

mod common;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

use rc_media::{CancelToken, ExportOptions, ExportSource, ExportSpec, FfmpegTools, TaskProgress, plan_export, probe, run_export};
use rc_types::grid::frame_to_micros;
use rc_types::{Clip, ErrorCode, ExportPlan, ExportRequest, ExportResult, MediaInfo, Rational};
use serde_json::Value;

const R30: Rational = Rational { num: 30, den: 1 };
const RATE: f64 = 48_000.0;

static GPU: Mutex<()> = Mutex::new(());

fn gpu_lock() -> MutexGuard<'static, ()> {
    GPU.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------------------------
// Marker sources

fn src_dir() -> PathBuf {
    let d = std::env::temp_dir().join("rc-media-export-src-v1");
    std::fs::create_dir_all(&d).unwrap();
    d
}

const BEEP_A: &str = "0.5*sin(2*PI*1000*t)*lt(mod(t,1),0.05)";
const BEEP_B: &str = "0.5*sin(2*PI*3000*t)*lt(mod(t+0.5,1),0.05)";

struct Gen {
    name: &'static str,
    w: u32,
    h: u32,
    rate: &'static str,
    dur: u32,
    sid: u32,
    hdr: bool,
    vfr: bool,
    tracks: u32,
    late_second_track: bool,
}

/// Makes (once) a source with markers and beeps.
fn marker_source(tools: &FfmpegTools, g: &Gen) -> PathBuf {
    let out = src_dir().join(format!("{}.mp4", g.name));
    if out.is_file() {
        return out;
    }
    let tmp = src_dir().join(format!("{}.tmp.mp4", g.name));
    let mh = 160 * g.h / 2160;
    let (w, h, r, d, sid) = (g.w, g.h, g.rate, g.dur, g.sid);
    let tags = if g.hdr {
        "setparams=range=tv:color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc"
    } else {
        "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709"
    };
    let mut graph = format!(
        "testsrc2=s={w}x{h}:r={r}:d={d}[bg];nullsrc=s=16x2:r={r}:d={d},format=gray,\
         geq=lum='if(lt(X,12),255*mod(floor(N/pow(2,X)),2),255*mod(floor({sid}/pow(2,X-12)),2))',\
         scale={w}:{mh}:flags=neighbor[mk];[bg][mk]overlay=0:0,{tags}"
    );
    if g.vfr {
        // Irregular frame durations: every 37th frame 0.1 s long, every 53rd frame shorter.
        graph.push_str(",setpts='(N/30+floor(N/37)*2/30-floor(N/53)*0.5/30)/TB'");
    }
    graph.push_str("[v];");
    graph.push_str(&format!("aevalsrc=exprs='{BEEP_A}|{BEEP_A}':s=48000:d={d}[a1]"));
    let mut args: Vec<String> = vec!["-filter_complex".into(), graph];
    if g.tracks > 1 {
        if g.late_second_track {
            args.extend(["-itsoffset".into(), "0.5".into()]);
        }
        args.extend(["-f".into(), "lavfi".into(), "-i".into(), format!("aevalsrc=exprs='{BEEP_B}':s=48000:d={d}")]);
    }
    args.extend(["-map".into(), "[v]".into(), "-map".into(), "[a1]".into()]);
    if g.tracks > 1 {
        args.extend(["-map".into(), "0:a:0".into()]);
    }
    let venc: Vec<&str> = if g.hdr {
        vec![
            "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le", "-x265-params",
            "log-level=error:keyint=60:min-keyint=60:bframes=3:crf=18:repeat-headers=1:hdr10=1:hdr10-opt=0:colorprim=bt2020:\
             transfer=smpte2084:colormatrix=bt2020nc:range=limited:master-display=G(13250,34500)B(7500,3000)R(34000,16000)\
             WP(15635,16450)L(10000000,1):max-cll=1000,400",
            "-tag:v", "hvc1", "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc", "-color_range", "tv",
        ]
    } else {
        vec![
            "-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "16", "-b:v", "0", "-g", "60", "-bf", "2", "-pix_fmt", "yuv420p",
            "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
        ]
    };
    args.extend(venc.iter().map(|s| s.to_string()));
    args.extend(["-c:a", "aac", "-b:a", "256k", "-ar", "48000"].iter().map(|s| s.to_string()));
    if g.vfr {
        args.extend(["-fps_mode", "passthrough", "-video_track_timescale", "90000"].iter().map(|s| s.to_string()));
    } else {
        args.extend(["-video_track_timescale".to_string(), (if r == "60" { "30720" } else { "15360" }).to_string()]);
    }
    args.extend(["-movflags".into(), "+faststart".into(), tmp.to_string_lossy().into_owned()]);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    common::ffmpeg(tools, &refs);
    std::fs::rename(&tmp, &out).unwrap();
    out
}

fn m264(t: &FfmpegTools) -> PathBuf {
    let g = Gen { name: "m264", w: 3840, h: 2160, rate: "30", dur: 20, sid: 1, hdr: false, vfr: false, tracks: 2, late_second_track: false };
    marker_source(t, &g)
}
fn m265(t: &FfmpegTools) -> PathBuf {
    let g = Gen { name: "m265hdr", w: 3840, h: 2160, rate: "30", dur: 12, sid: 3, hdr: true, vfr: false, tracks: 2, late_second_track: false };
    marker_source(t, &g)
}
fn mvfr(t: &FfmpegTools) -> PathBuf {
    let g = Gen { name: "mvfr", w: 3840, h: 2160, rate: "30", dur: 15, sid: 5, hdr: false, vfr: true, tracks: 2, late_second_track: false };
    marker_source(t, &g)
}
fn m1080p60(t: &FfmpegTools) -> PathBuf {
    let g = Gen { name: "m1080p60", w: 1920, h: 1080, rate: "60", dur: 10, sid: 4, hdr: false, vfr: false, tracks: 1, late_second_track: false };
    marker_source(t, &g)
}
fn mlate(t: &FfmpegTools) -> PathBuf {
    let g = Gen { name: "mlate", w: 1280, h: 720, rate: "30", dur: 10, sid: 6, hdr: false, vfr: false, tracks: 2, late_second_track: true };
    marker_source(t, &g)
}

// ---------------------------------------------------------------------------------------------
// Running an export

struct Run {
    sources: HashMap<String, ExportSource>,
    rate: Rational,
}

impl Run {
    fn new(tools: &FfmpegTools, files: &[(&str, &Path)]) -> Run {
        let mut sources = HashMap::new();
        let mut rate = None;
        for (id, path) in files {
            let media = probe(tools, path, &CancelToken::new()).unwrap();
            rate.get_or_insert(media.video.frame_rate);
            sources.insert(id.to_string(), ExportSource { path: path.to_path_buf(), media });
        }
        Run { sources, rate: rate.unwrap() }
    }
    fn media(&self, id: &str) -> &MediaInfo {
        &self.sources[id].media
    }
}

/// Clips from (source id, first frame, frame count) on the 30 fps grid.
fn clips(rate: Rational, list: &[(&str, i64, i64)]) -> Vec<Clip> {
    list.iter()
        .enumerate()
        .map(|(i, (id, k, n))| Clip {
            id: format!("c{i}"),
            source_id: id.to_string(),
            start: frame_to_micros(*k, rate),
            end: frame_to_micros(k + n, rate),
        })
        .collect()
}

fn request(clips: Vec<Clip>, folder: &Path, name: &str) -> ExportRequest {
    ExportRequest { project_id: "p".into(), clips, folder: folder.to_string_lossy().into_owned(), file_name: name.into() }
}

fn spec<'a>(req: &'a ExportRequest, run: &'a Run, work: &'a Path, options: ExportOptions) -> ExportSpec<'a> {
    ExportSpec { request: req, sources: &run.sources, frame_rate: run.rate, work_root: work, options }
}

/// Runs an export, checks the progress reports, the result and that nothing temporary is left.
fn export_ok(tools: &FfmpegTools, spec: &ExportSpec<'_>) -> (ExportPlan, ExportResult) {
    let plan = plan_export(tools, spec, &CancelToken::new()).unwrap();
    assert!(plan.blocked_by.is_none(), "{:?}", plan.blocked_by);
    let mut seen: Vec<TaskProgress> = Vec::new();
    let res = run_export(tools, spec, &CancelToken::new(), &mut |p| seen.push(p)).unwrap();
    assert!(seen.windows(2).all(|w| w[1].fraction >= w[0].fraction), "progress goes forward");
    assert_eq!(seen.last().unwrap().fraction, 1.0);
    assert_eq!(res.duration, plan.duration);
    assert!(Path::new(&res.path).is_file());
    assert_eq!(res.bytes, std::fs::metadata(&res.path).unwrap().len());
    assert!(!PathBuf::from(format!("{}.part", res.path)).exists());
    assert_no_temp(spec.work_root);
    (plan, res)
}

fn assert_no_temp(work_root: &Path) {
    if let Ok(rd) = std::fs::read_dir(work_root) {
        let left: Vec<_> = rd.filter_map(|e| e.ok()).map(|e| e.file_name()).collect();
        assert!(left.is_empty(), "left in the work folder: {left:?}");
    }
}

// ---------------------------------------------------------------------------------------------
// Reading an output

/// (source id, frame number) of every decoded frame.
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

/// Video packet (pts, duration) in stream ticks, sorted by pts, and the time base.
fn packets(tools: &FfmpegTools, file: &Path) -> (Vec<(i64, i64)>, (i64, i64)) {
    let out = Command::new(&tools.ffprobe)
        .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=time_base:packet=pts,duration", "-of", "json"])
        .arg(file)
        .output()
        .unwrap();
    let j: Value = serde_json::from_slice(&out.stdout).unwrap();
    let tb = j["streams"][0]["time_base"].as_str().unwrap();
    let (n, d) = tb.split_once('/').unwrap();
    let mut p: Vec<(i64, i64)> = j["packets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["pts"].as_i64().unwrap(), p["duration"].as_i64().unwrap_or(0)))
        .collect();
    p.sort();
    (p, (n.parse().unwrap(), d.parse().unwrap()))
}

/// Round half away from zero of a/b for positive values.
fn round_div(a: i128, b: i128) -> i128 {
    (2 * a + b) / (2 * b)
}

/// The frames the `fps` filter puts in slots `k .. k+n` of `rate` (RESULT.md: the last source
/// frame whose time, rounded to the nearest slot, is at most the slot; the last frame repeats
/// past the end).
fn expected_frames(source_pts: &[(i64, i64)], tb: (i64, i64), rate: Rational, k: i64, n: i64) -> Vec<u32> {
    let slots: Vec<i128> = source_pts
        .iter()
        .map(|(p, _)| round_div(*p as i128 * tb.0 as i128 * rate.num as i128, tb.1 as i128 * rate.den as i128))
        .collect();
    (k..k + n)
        .map(|p| {
            let j = slots.iter().rposition(|&s| s <= p as i128).unwrap_or(0);
            j as u32
        })
        .collect()
}

/// Onsets of beeps (sample index of the first loud sample after at least 0.2 s of quiet).
fn onsets(x: &[f32]) -> Vec<usize> {
    let mut out = Vec::new();
    let mut quiet = usize::MAX / 2;
    for (i, v) in x.iter().enumerate() {
        if v.abs() > 0.1 {
            if quiet >= 9600 {
                out.push(i);
            }
            quiet = 0;
        } else {
            quiet += 1;
        }
    }
    out
}

/// Where each clip's sound starts in the output, in samples.
fn edges(frames: &[i64], rate: Rational) -> Vec<i64> {
    let mut e = vec![0i64];
    let mut cum = 0i64;
    for n in frames {
        cum += n;
        e.push((cum as i128 * 48000 * rate.den as i128 / rate.num as i128) as i64);
    }
    e
}

/// Checks the beeps of one output track: every source beep at `period`-spaced times plus
/// `offset` seconds (source clock) that lies inside a clip appears in the output where the
/// clip puts it, within 2 ms; and no beep appears anywhere else except at a cut.
/// Returns the output sample of the last expected beep.
fn check_beeps(samples: &[f32], list: &[(i64, i64)], rate: Rational, period: f64, offset: f64, what: &str) -> Option<i64> {
    let frames: Vec<i64> = list.iter().map(|c| c.1).collect();
    let e = edges(&frames, rate);
    let mut expected = Vec::new();
    for (i, (k, n)) in list.iter().enumerate() {
        let a0 = (*k as i128 * 48000 * rate.den as i128 / rate.num as i128) as i64;
        let s = e[i + 1] - e[i];
        let _ = n;
        let mut b = offset;
        while b * RATE < (a0 + s) as f64 + 1.0 {
            let bs = (b * RATE).round() as i64;
            if bs >= a0 + 240 && bs < a0 + s - 240 {
                expected.push(e[i] + bs - a0);
            }
            b += period;
        }
    }
    let got = onsets(samples);
    for x in &expected {
        let near = got.iter().map(|g| (*g as i64 - x).abs()).min().unwrap_or(i64::MAX);
        assert!(near <= 96, "{what}: beep expected at sample {x} ({:.4} s), nearest detected {near} samples away; got {got:?}", *x as f64 / RATE);
    }
    for g in &got {
        let g = *g as i64;
        let at_cut = e.iter().any(|c| (g - c).abs() <= 480);
        let known = expected.iter().any(|x| (g - x).abs() <= 96);
        assert!(at_cut || known, "{what}: unexpected beep at sample {g} ({:.4} s)", g as f64 / RATE);
    }
    assert!(!expected.is_empty(), "{what}: the edit holds no beep to check");
    expected.last().copied()
}

/// One decode of `file`'s first video stream: the CRC of every frame and FFmpeg's messages.
struct Decode {
    lines: Vec<String>,
    crcs: Vec<String>,
    stderr: String,
}

fn decode_crcs(tools: &FfmpegTools, file: &Path, ten_bit: bool, gpu: bool) -> Decode {
    let fmt = if ten_bit { "p010le" } else { "nv12" };
    let mut c = Command::new(&tools.ffmpeg);
    c.args(["-v", "warning", "-nostdin"]);
    if gpu {
        c.args(["-hwaccel", "cuda"]);
    }
    let out = c.arg("-i").arg(file).args(["-map", "0:v:0", "-pix_fmt", fmt, "-f", "framecrc", "-"]).output().unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    assert!(out.status.success(), "{stderr}");
    let lines: Vec<String> = String::from_utf8_lossy(&out.stdout).lines().filter(|l| !l.starts_with('#')).map(str::to_string).collect();
    let crcs = lines.iter().map(|l| l.rsplit(',').next().unwrap().trim().to_string()).collect();
    Decode { lines, crcs, stderr }
}

fn differing(a: &[String], b: &[String]) -> Vec<usize> {
    (0..a.len().max(b.len())).filter(|&i| a.get(i) != b.get(i)).collect()
}

/// The frames on which the processor and the GPU never agree: frame `i` agrees when some
/// processor decode and some GPU decode give it the same CRC. Every decode must have the same
/// number of frames (otherwise every frame is listed).
fn frames_never_agreeing(cpu: &[Vec<String>], gpu: &[Vec<String>]) -> Vec<usize> {
    let n = cpu.first().map_or(0, Vec::len);
    if cpu.iter().chain(gpu).any(|d| d.len() != n) {
        let most = cpu.iter().chain(gpu).map(Vec::len).max().unwrap_or(0);
        return (0..most).collect();
    }
    (0..n).filter(|&i| !cpu.iter().any(|c| gpu.iter().any(|g| c[i] == g[i]))).collect()
}

/// Decode pairs tried before the processor and the GPU are said to disagree.
const DECODE_ATTEMPTS: usize = 3;

/// Every frame decodes the same on the processor and on the GPU (framecrc of each frame).
///
/// A file whose bitstream the two decoders read differently (an export or join defect) differs
/// in every decode, the same way. Under heavy load on this PC, though, repeated decodes of the
/// very same file by the same decoder were seen to differ from each other (processor against
/// processor too) while an idle machine decodes it identically every time. So a disagreement
/// is decoded again, up to DECODE_ATTEMPTS pairs, and the check passes when, for every frame,
/// some processor decode and some GPU decode give it the same CRC (a defect never does); any
/// retry is reported on standard error.
/// When none agree, the file, every CRC list and FFmpeg's messages are kept under
/// `%TEMP%/rc-media-it/kept/` and the failure names the differing frames.
fn assert_decoders_agree(tools: &FfmpegTools, file: &Path, ten_bit: bool) {
    let (mut cpu, mut gpu) = (Vec::new(), Vec::new());
    for attempt in 1..=DECODE_ATTEMPTS {
        cpu.push(decode_crcs(tools, file, ten_bit, false));
        gpu.push(decode_crcs(tools, file, ten_bit, true));
        let crcs = |d: &[Decode]| d.iter().map(|x| x.crcs.clone()).collect::<Vec<_>>();
        if frames_never_agreeing(&crcs(&cpu), &crcs(&gpu)).is_empty() {
            if attempt > 1 {
                eprintln!(
                    "{}: the processor and the GPU agreed on decode {attempt}; earlier decodes differed in frames {:?} (processor {:?}, GPU {:?} between their own decodes)",
                    file.display(),
                    differing(&cpu[0].crcs, &gpu[0].crcs),
                    differing(&cpu[0].crcs, &cpu[attempt - 1].crcs),
                    differing(&gpu[0].crcs, &gpu[attempt - 1].crcs),
                );
            }
            return;
        }
    }
    let stem = file.file_stem().unwrap().to_string_lossy().into_owned();
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
    let keep = std::env::temp_dir().join("rc-media-it").join("kept").join(format!("{stem}-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&keep).unwrap();
    std::fs::copy(file, keep.join(file.file_name().unwrap())).unwrap();
    for (side, list) in [("cpu", &cpu), ("gpu", &gpu)] {
        for (i, d) in list.iter().enumerate() {
            std::fs::write(keep.join(format!("{side}-{}.framecrc", i + 1)), d.lines.join("\n")).unwrap();
            std::fs::write(keep.join(format!("{side}-{}.stderr.txt", i + 1)), &d.stderr).unwrap();
        }
    }
    let pairs: Vec<Vec<usize>> = cpu.iter().zip(&gpu).map(|(c, g)| differing(&c.crcs, &g.crcs)).collect();
    let crcs = |d: &[Decode]| d.iter().map(|x| x.crcs.clone()).collect::<Vec<_>>();
    panic!(
        "the processor and the GPU decode {} differently: in {DECODE_ATTEMPTS} decodes each, frames {:?} (of {}) never agree; differing frames per attempt {:?}. FFmpeg said (GPU): {:?}. File and CRC lists kept in {}",
        file.display(),
        frames_never_agreeing(&crcs(&cpu), &crcs(&gpu)),
        cpu[0].crcs.len(),
        pairs,
        gpu[0].stderr.trim(),
        keep.display()
    );
}

#[test]
fn decoder_check_fails_a_file_that_always_decodes_differently_and_passes_one_off_variance() {
    let v = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let good = v(&["a", "b", "c"]);
    // An export defect: frame 2 decodes differently on the GPU every time, however often.
    let defect = v(&["a", "b", "X"]);
    assert_eq!(frames_never_agreeing(&[good.clone(), good.clone(), good.clone()], &[defect.clone(), defect.clone(), defect.clone()]), vec![2]);
    // Decodes that went wrong here and there (on either side, a different frame each time).
    assert!(frames_never_agreeing(&[v(&["a", "Y", "c"]), v(&["Q", "b", "c"])], &[v(&["a", "b", "Z"]), v(&["W", "b", "c"])]).is_empty());
    assert!(frames_never_agreeing(&[good.clone()], &[good.clone()]).is_empty());
    // Only one decode each, differing: not agreed.
    assert_eq!(frames_never_agreeing(&[good.clone()], &[v(&["a", "Y", "c"])]), vec![1]);
    // Different frame counts never agree.
    assert_eq!(frames_never_agreeing(&[good.clone()], &[v(&["a", "b"])]), vec![0, 1, 2]);
}

fn streams(tools: &FfmpegTools, file: &Path) -> (Value, Vec<Value>) {
    let j = common::ffprobe_json(tools, file);
    let s = j["streams"].as_array().unwrap().clone();
    let v = s.iter().find(|x| x["codec_type"] == "video").unwrap().clone();
    let a = s.iter().filter(|x| x["codec_type"] == "audio").cloned().collect();
    (v, a)
}

/// Picture and sound line up at the end: the last checked beep (track 0, whole seconds) and the
/// output frame showing that second's source frame are within one frame.
fn assert_end_sync(marks: &[(u32, u32)], list: &[(i64, i64)], beep_sample: i64, rate: Rational, sid: u32) {
    let beep_t = beep_sample as f64 / RATE;
    // The clip holding that beep and the source second it is.
    let frames: Vec<i64> = list.iter().map(|c| c.1).collect();
    let e = edges(&frames, rate);
    let i = (0..list.len()).find(|&i| e[i] <= beep_sample && beep_sample < e[i + 1]).unwrap();
    let a0 = (list[i].0 as i128 * 48000 * rate.den as i128 / rate.num as i128) as i64;
    let source_second = ((beep_sample - e[i] + a0) as f64 / RATE).round();
    let source_frame = (source_second * rate.num as f64 / rate.den as f64).round() as u32;
    let j = marks.iter().position(|m| *m == (sid, source_frame)).expect("the beep's frame is in the output");
    let frame_t = j as f64 * rate.den as f64 / rate.num as f64;
    let frame = rate.den as f64 / rate.num as f64;
    assert!((beep_t - frame_t).abs() < frame, "end sync: beep at {beep_t:.4} s, its frame at {frame_t:.4} s");
}

fn expected_cfr(sid: u32, list: &[(i64, i64)]) -> Vec<(u32, u32)> {
    list.iter().flat_map(|(k, n)| (*k..k + n).map(move |f| (sid, f as u32))).collect()
}

fn audio_len_ok(tools: &FfmpegTools, file: &Path, track: u32, frames: i64, rate: Rational) -> Vec<f32> {
    let x = common::decode_audio(tools, file, track, 48000);
    let want = (frames as i128 * 48000 * rate.den as i128 / rate.num as i128) as i64;
    let frame = (48000.0 * rate.den as f64 / rate.num as f64) as i64;
    assert!((x.len() as i64 - want).abs() < frame, "track {track}: {} samples, video is {want}", x.len());
    x
}

// ---------------------------------------------------------------------------------------------
// Tests

#[test]
fn h264_edit_is_frame_exact_at_every_cut_with_all_tracks_in_sync() {
    let _g = gpu_lock();
    let tools = common::tools();
    let src = m264(&tools);
    let dir = common::scratch("export-h264");
    let work = dir.join("work");
    let run = Run::new(&tools, &[("a", &src)]);
    // Out of order, mostly off keyframes (keyframe every 60 frames), a 1-frame clip, the end.
    let list = [(100, 200), (61, 1), (400, 37), (0, 59), (550, 50), (301, 59)];
    let cl: Vec<(&str, i64, i64)> = list.iter().map(|(k, n)| ("a", *k, *n)).collect();
    let req = request(clips(R30, &cl), &dir.join("out"), "h264-edit");
    let (plan, res) = export_ok(&tools, &spec(&req, &run, &work, ExportOptions::default()));
    let total: i64 = list.iter().map(|c| c.1).sum();
    assert_eq!(plan.duration, frame_to_micros(total, R30));
    assert!(plan.notices.is_empty(), "{:?}", plan.notices);
    assert!(plan.estimated_bytes > 0 && plan.estimated_seconds > 0.0 && plan.free_bytes > 0);
    let out = PathBuf::from(&res.path);
    assert_eq!(out.file_name().unwrap(), "h264-edit.mp4");

    // Exactly the expected frames, in order: the right frame on each side of every cut.
    let marks = markers(&tools, &out);
    assert_eq!(marks.len() as i64, total);
    assert_eq!(marks, expected_cfr(1, &list));
    // Picture timestamps: one regular sequence from 0, one frame per packet.
    let (pk, tb) = packets(&tools, &out);
    assert_eq!(tb, (1, 15360));
    for (i, (pts, dur)) in pk.iter().enumerate() {
        assert_eq!((*pts, *dur), (i as i64 * 512, 512), "packet {i}");
    }
    // Format follows the source.
    let (v, a) = streams(&tools, &out);
    assert_eq!((v["codec_name"].as_str(), v["width"].as_u64(), v["height"].as_u64()), (Some("h264"), Some(3840), Some(2160)));
    assert_eq!((v["r_frame_rate"].as_str(), v["pix_fmt"].as_str()), (Some("30/1"), Some("yuv420p")));
    assert_eq!((v["color_primaries"].as_str(), v["color_transfer"].as_str()), (Some("bt709"), Some("bt709")));
    assert_eq!(a.len(), 2, "both audio tracks");
    assert_eq!((a[0]["channels"].as_u64(), a[1]["channels"].as_u64()), (Some(2), Some(1)));
    assert!(a.iter().all(|t| t["codec_name"] == "aac" && t["sample_rate"] == "48000"));
    // Sound: as long as the picture, every beep where the cut puts it, in sync at the end.
    let t0 = audio_len_ok(&tools, &out, 0, total, R30);
    let t1 = audio_len_ok(&tools, &out, 1, total, R30);
    let last = check_beeps(&t0, &list, R30, 1.0, 0.0, "track 0").unwrap();
    check_beeps(&t1, &list, R30, 1.0, 0.5, "track 1");
    assert_end_sync(&marks, &list, last, R30, 1);
    // Every frame decodes the same on the processor and the GPU.
    assert_decoders_agree(&tools, &out, false);
}

#[test]
fn hevc_hdr_edit_keeps_bit_depth_hdr_metadata_and_exact_frames() {
    let _g = gpu_lock();
    let tools = common::tools();
    let src = m265(&tools);
    let dir = common::scratch("export-hevc");
    let work = dir.join("work");
    let run = Run::new(&tools, &[("b", &src)]);
    let list = [(30, 70), (200, 1), (5, 55), (300, 60)];
    let cl: Vec<(&str, i64, i64)> = list.iter().map(|(k, n)| ("b", *k, *n)).collect();
    let req = request(clips(R30, &cl), &dir.join("out"), "hevc-edit.mp4");
    let (plan, res) = export_ok(&tools, &spec(&req, &run, &work, ExportOptions::default()));
    assert_eq!(plan.format.codec, rc_types::OutputCodec::Hevc);
    assert!(plan.format.hdr && plan.format.bit_depth == rc_types::BitDepth::Ten);
    let out = PathBuf::from(&res.path);
    let total: i64 = list.iter().map(|c| c.1).sum();
    let marks = markers(&tools, &out);
    assert_eq!(marks, expected_cfr(3, &list));
    let (v, a) = streams(&tools, &out);
    assert_eq!((v["codec_name"].as_str(), v["codec_tag_string"].as_str(), v["pix_fmt"].as_str()), (Some("hevc"), Some("hvc1"), Some("yuv420p10le")));
    assert_eq!((v["color_primaries"].as_str(), v["color_transfer"].as_str(), v["color_space"].as_str()), (Some("bt2020"), Some("smpte2084"), Some("bt2020nc")));
    assert_eq!(v["profile"].as_str(), Some("Main 10"));
    assert_eq!(a.len(), 2);
    // HDR10 static metadata on every frame of every piece.
    let o = Command::new(&tools.ffprobe)
        .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "frame_side_data=side_data_type", "-of", "csv=p=0"])
        .arg(&out)
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&o.stdout);
    assert_eq!(text.matches("Mastering display metadata").count() as i64, total);
    assert_eq!(text.matches("Content light level metadata").count() as i64, total);
    let t0 = audio_len_ok(&tools, &out, 0, total, R30);
    let last = check_beeps(&t0, &list, R30, 1.0, 0.0, "track 0").unwrap();
    assert_end_sync(&marks, &list, last, R30, 3);
    assert_decoders_agree(&tools, &out, true);
}

#[test]
fn fixtures_export_in_their_own_format_with_all_tracks() {
    let _g = gpu_lock();
    let tools = common::tools();
    let dir = common::scratch("export-fixtures");
    let work = dir.join("work");
    for name in ["numbered-4k-h264", "numbered-4k-hevc10-hdr", "numbered-3audio"] {
        let src = common::fixture(name);
        let run = Run::new(&tools, &[("f", &src)]);
        let list = [(45, 90), (700, 61)];
        let cl: Vec<(&str, i64, i64)> = list.iter().map(|(k, n)| ("f", *k, *n)).collect();
        let req = request(clips(R30, &cl), &dir.join("out"), name);
        let (plan, res) = export_ok(&tools, &spec(&req, &run, &work, ExportOptions::default()));
        let out = PathBuf::from(&res.path);
        let m = run.media("f");
        let got = probe(&tools, &out, &CancelToken::new()).unwrap();
        assert_eq!((got.video.width, got.video.height, got.video.frame_rate), (m.video.width, m.video.height, m.video.frame_rate), "{name}");
        assert_eq!((got.video.codec.as_str(), got.video.bit_depth, got.video.hdr), (m.video.codec.as_str(), m.video.bit_depth, m.video.hdr), "{name}");
        assert!(!got.video.variable_frame_rate);
        assert_eq!(got.audio_tracks.len(), m.audio_tracks.len(), "{name}: every audio track");
        for (a, b) in got.audio_tracks.iter().zip(&m.audio_tracks) {
            assert_eq!(a.channels, b.channels, "{name}");
        }
        assert_eq!(plan.format.audio_tracks as usize, m.audio_tracks.len());
        let total: i64 = list.iter().map(|c| c.1).sum();
        assert_eq!(common::video_packets(&tools, &out).len() as i64, total, "{name}");
        // The fixture beeps (100 ms, every whole second, on every track) sit where the cuts put them.
        for t in 0..m.audio_tracks.len() as u32 {
            let x = audio_len_ok(&tools, &out, t, total, R30);
            check_beeps(&x, &list, R30, 1.0, 0.0, &format!("{name} track {t}"));
        }
        if name == "numbered-3audio" {
            // Tracks keep their order: 1000, 500 and 2000 Hz.
            for (t, f) in [(0u32, 1000.0), (1, 500.0), (2, 2000.0)] {
                let x = common::decode_audio(&tools, &out, t, 48000);
                // First beep of the second clip: source second 24 at output 3 + (24 - 700/30) s.
                let at = ((90.0 / 30.0 + (24.0 - 700.0 / 30.0)) * RATE) as usize;
                let win = &x[at + 480..at + 4320];
                let own = common::tone_power(win, 48000, f);
                for other in [500.0, 1000.0, 2000.0].into_iter().filter(|o| *o != f) {
                    assert!(own > 10.0 * common::tone_power(win, 48000, other), "track {t} is not the {f} Hz track");
                }
            }
        }
    }
}

#[test]
fn variable_frame_rate_becomes_constant_with_the_frames_the_fps_rule_picks() {
    let _g = gpu_lock();
    let tools = common::tools();
    let src = mvfr(&tools);
    let dir = common::scratch("export-vfr");
    let work = dir.join("work");
    let run = Run::new(&tools, &[("v", &src)]);
    assert!(run.media("v").video.variable_frame_rate, "the made source is VFR");
    let list = [(10, 80), (200, 45), (5, 1), (300, 100)];
    let cl: Vec<(&str, i64, i64)> = list.iter().map(|(k, n)| ("v", *k, *n)).collect();
    let req = request(clips(R30, &cl), &dir.join("out"), "vfr");
    let (plan, res) = export_ok(&tools, &spec(&req, &run, &work, ExportOptions::default()));
    assert!(plan.notices.iter().any(|n| n.contains("Variable frame rate")), "{:?}", plan.notices);
    let out = PathBuf::from(&res.path);
    let (spk, stb) = packets(&tools, &src);
    let want: Vec<(u32, u32)> = list.iter().flat_map(|(k, n)| expected_frames(&spk, stb, R30, *k, *n)).map(|f| (5, f)).collect();
    assert_eq!(markers(&tools, &out), want);
    let (pk, _) = packets(&tools, &out);
    assert!(pk.iter().enumerate().all(|(i, p)| *p == (i as i64 * 512, 512)), "constant frame rate");
    // Wall-clock time is kept: beeps (on the source's real clock) where the slots put them.
    let total: i64 = list.iter().map(|c| c.1).sum();
    let t0 = audio_len_ok(&tools, &out, 0, total, R30);
    check_beeps(&t0, &list, R30, 1.0, 0.0, "vfr track 0");

    // The fixture: the whole file, converted to 30 fps CFR, keeps its length and its beeps.
    let fx = common::fixture("numbered-vfr");
    let run = Run::new(&tools, &[("x", &fx)]);
    let n = rc_types::grid::micros_to_frame_floor(rc_types::grid::first_clip_end(run.media("x").duration, R30).unwrap(), R30);
    let req = request(clips(R30, &[("x", 0, n)]), &dir.join("out"), "vfr-fixture");
    let (_, res) = export_ok(&tools, &spec(&req, &run, &work, ExportOptions::default()));
    let out = PathBuf::from(&res.path);
    let (pk, _) = packets(&tools, &out);
    assert_eq!(pk.len() as i64, n);
    assert!(pk.iter().enumerate().all(|(i, p)| *p == (i as i64 * 512, 512)));
    let x = audio_len_ok(&tools, &out, 0, n, R30);
    check_beeps(&x, &[(0, n)], R30, 1.0, 0.0, "numbered-vfr");
}

#[test]
fn mixed_sources_follow_the_first_clip_and_fill_missing_tracks_with_silence() {
    let _g = gpu_lock();
    let tools = common::tools();
    let (a, b) = (m264(&tools), m1080p60(&tools));
    let dir = common::scratch("export-mixed");
    let work = dir.join("work");
    let run = Run::new(&tools, &[("a", &a), ("b", &b)]);
    assert_eq!(run.rate, R30, "the first source sets the grid");
    // Second source is 1080p60 with one track; grid frames of 30 fps.
    let cl = [("a", 30, 45), ("b", 31, 70), ("a", 400, 40), ("b", 200, 50)];
    let req = request(clips(R30, &cl), &dir.join("out"), "mixed");
    let (plan, res) = export_ok(&tools, &spec(&req, &run, &work, ExportOptions::default()));
    assert!(plan.notices.iter().any(|n| n.starts_with("Sources differ; the export follows the first clip")), "{:?}", plan.notices);
    assert!(plan.notices.iter().any(|n| n.contains("fewer audio tracks")), "{:?}", plan.notices);
    let out = PathBuf::from(&res.path);
    let (v, au) = streams(&tools, &out);
    assert_eq!((v["width"].as_u64(), v["height"].as_u64(), v["r_frame_rate"].as_str()), (Some(3840), Some(2160), Some("30/1")));
    assert_eq!(au.len(), 2);
    let (bpk, btb) = packets(&tools, &b);
    let mut want = Vec::new();
    for (id, k, n) in cl {
        if id == "a" {
            want.extend((k..k + n).map(|f| (1, f as u32)));
        } else {
            want.extend(expected_frames(&bpk, btb, R30, k, n).into_iter().map(|f| (4, f)));
        }
    }
    assert_eq!(markers(&tools, &out), want);
    let list: Vec<(i64, i64)> = cl.iter().map(|c| (c.1, c.2)).collect();
    let total: i64 = list.iter().map(|c| c.1).sum();
    let t0 = audio_len_ok(&tools, &out, 0, total, R30);
    check_beeps(&t0, &list, R30, 1.0, 0.0, "mixed track 0");
    // Track 1: the 1080p60 clips have no second track, so silence there.
    let t1 = audio_len_ok(&tools, &out, 1, total, R30);
    let e = edges(&list.iter().map(|c| c.1).collect::<Vec<_>>(), R30);
    for i in [1usize, 3] {
        let peak = t1[e[i] as usize + 480..e[i + 1] as usize - 480].iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!(peak < 0.01, "clip {i} of track 1 should be silent, peak {peak}");
    }
}

#[test]
fn hdr_and_sdr_sources_mix_in_both_directions() {
    let _g = gpu_lock();
    let tools = common::tools();
    let (sdr, hdr, hd) = (m264(&tools), m265(&tools), m1080p60(&tools));
    let dir = common::scratch("export-hdr-mix");
    let work = dir.join("work");
    // SDR first: the HDR clip is tone-mapped to SDR 8-bit H.264.
    let run = Run::new(&tools, &[("s", &sdr), ("h", &hdr)]);
    let cl = [("s", 10, 20), ("h", 40, 25)];
    let req = request(clips(R30, &cl), &dir.join("out"), "sdr-first");
    let (_, res) = export_ok(&tools, &spec(&req, &run, &work, ExportOptions::default()));
    let out = PathBuf::from(&res.path);
    let (v, _) = streams(&tools, &out);
    assert_eq!((v["codec_name"].as_str(), v["pix_fmt"].as_str(), v["color_transfer"].as_str()), (Some("h264"), Some("yuv420p"), Some("bt709")));
    let want: Vec<(u32, u32)> = (10..30).map(|f| (1, f)).chain((40..65).map(|f| (3, f))).collect();
    assert_eq!(markers(&tools, &out), want);
    // HDR first: the SDR 1080p60 clip is placed into PQ BT.2020, 10-bit, scaled to 4K.
    let run = Run::new(&tools, &[("h", &hdr), ("d", &hd)]);
    let cl = [("h", 0, 15), ("d", 20, 30)];
    let req = request(clips(R30, &cl), &dir.join("out"), "hdr-first");
    let (_, res) = export_ok(&tools, &spec(&req, &run, &work, ExportOptions::default()));
    let out = PathBuf::from(&res.path);
    let (v, _) = streams(&tools, &out);
    assert_eq!((v["codec_name"].as_str(), v["pix_fmt"].as_str(), v["color_transfer"].as_str()), (Some("hevc"), Some("yuv420p10le"), Some("smpte2084")));
    let (dpk, dtb) = packets(&tools, &hd);
    let want: Vec<(u32, u32)> =
        (0..15).map(|f| (3, f)).chain(expected_frames(&dpk, dtb, R30, 20, 30).into_iter().map(|f| (4, f))).collect();
    assert_eq!(markers(&tools, &out), want);
}

#[test]
fn a_late_starting_track_keeps_its_delay() {
    let _g = gpu_lock();
    let tools = common::tools();
    let src = mlate(&tools);
    let dir = common::scratch("export-late");
    let work = dir.join("work");
    let run = Run::new(&tools, &[("l", &src)]);
    // Both tracks beep on whole seconds of the source clock (track 1 starts 0.5 s late and
    // beeps half a second into its own time).
    let list = [(0, 70), (100, 95), (250, 40)];
    let cl: Vec<(&str, i64, i64)> = list.iter().map(|(k, n)| ("l", *k, *n)).collect();
    let req = request(clips(R30, &cl), &dir.join("out"), "late");
    let (_, res) = export_ok(&tools, &spec(&req, &run, &work, ExportOptions::default()));
    let out = PathBuf::from(&res.path);
    assert_eq!(markers(&tools, &out), expected_cfr(6, &list));
    let total: i64 = list.iter().map(|c| c.1).sum();
    let t0 = audio_len_ok(&tools, &out, 0, total, R30);
    let t1 = audio_len_ok(&tools, &out, 1, total, R30);
    check_beeps(&t0, &list, R30, 1.0, 0.0, "late track 0");
    check_beeps(&t1, &list, R30, 1.0, 1.0, "late track 1");
    // Before the late track starts there is silence.
    let peak = t1[..(0.45 * RATE) as usize].iter().fold(0f32, |m, v| m.max(v.abs()));
    assert!(peak < 0.01, "{peak}");
}

#[test]
fn cancel_leaves_no_file_and_no_temporary_folder() {
    let _g = gpu_lock();
    let tools = common::tools();
    let src = common::fixture("numbered-4k-h264");
    let dir = common::scratch("export-cancel");
    let work = dir.join("work");
    let out_dir = dir.join("out");
    let run = Run::new(&tools, &[("f", &src)]);
    let req = request(clips(R30, &[("f", 0, 450), ("f", 450, 450), ("f", 0, 900)]), &out_dir, "cancelled");
    let s = spec(&req, &run, &work, ExportOptions::default());
    let cancel = CancelToken::new();
    let c2 = cancel.clone();
    let mut cancelled_at = None;
    let err = run_export(&tools, &s, &cancel, &mut |p| {
        if p.fraction > 0.15 && cancelled_at.is_none() {
            cancelled_at = Some(Instant::now());
            c2.cancel();
        }
    })
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);
    let took = cancelled_at.expect("progress passed 15 %").elapsed();
    assert!(took.as_secs_f64() < 5.0, "stopping took {took:?}");
    let left: Vec<_> = std::fs::read_dir(&out_dir).map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.file_name()).collect()).unwrap_or_default();
    assert!(left.is_empty(), "nothing at the destination: {left:?}");
    assert_no_temp(&work);
}

#[test]
fn too_little_disk_space_is_caught_before_starting() {
    let _g = gpu_lock();
    let tools = common::tools();
    let src = common::fixture("numbered-4k-h264");
    let dir = common::scratch("export-disk");
    let work = dir.join("work");
    let out_dir = dir.join("out");
    let run = Run::new(&tools, &[("f", &src)]);
    let req = request(clips(R30, &[("f", 0, 900)]), &out_dir, "full");
    let options = ExportOptions { free_bytes_override: Some(1_000_000), ..ExportOptions::default() };
    let s = spec(&req, &run, &work, options);
    let plan = plan_export(&tools, &s, &CancelToken::new()).unwrap();
    let b = plan.blocked_by.clone().expect("blocked");
    assert_eq!(b.code, ErrorCode::DiskFull);
    assert!(b.message.contains("needs about") && b.message.contains("977 KB is free"), "{}", b.message);
    assert_eq!(plan.free_bytes, 1_000_000);
    // Twice the estimate when the temporary pieces share the drive.
    let need: u64 = b.detail.as_ref().unwrap().split_whitespace().nth(1).unwrap().parse().unwrap();
    assert!(need >= 2 * plan.estimated_bytes - 32_000 * 30, "need {need}, estimate {}", plan.estimated_bytes);
    // The plan carries the same amount for the dialog (requiredBytes).
    assert_eq!(plan.required_bytes, Some(need));
    let started = Instant::now();
    let err = run_export(&tools, &s, &CancelToken::new(), &mut |_| {}).unwrap_err();
    assert_eq!(err.code, ErrorCode::DiskFull);
    assert!(started.elapsed().as_secs_f64() < 5.0);
    assert!(!out_dir.exists(), "nothing was started");
    assert!(!work.exists());
    // With enough space the same plan is not blocked.
    let ok = ExportOptions { free_bytes_override: Some(u64::MAX / 4), ..ExportOptions::default() };
    assert!(plan_export(&tools, &spec(&req, &run, &work, ok), &CancelToken::new()).unwrap().blocked_by.is_none());
}

#[test]
fn nothing_to_export_and_missing_sources_block_the_plan() {
    let _g = gpu_lock();
    let tools = common::tools();
    let dir = common::scratch("export-blocked");
    let work = dir.join("work");
    let src = common::fixture("silence-only");
    let mut run = Run::new(&tools, &[("s", &src)]);
    let req = request(vec![], &dir, "empty");
    let plan = plan_export(&tools, &spec(&req, &run, &work, ExportOptions::default()), &CancelToken::new()).unwrap();
    assert_eq!(plan.blocked_by.unwrap().code, ErrorCode::NothingToExport);
    assert_eq!(plan.duration, 0);
    let err = run_export(&tools, &spec(&req, &run, &work, ExportOptions::default()), &CancelToken::new(), &mut |_| {}).unwrap_err();
    assert_eq!(err.code, ErrorCode::NothingToExport);

    let media = run.media("s").clone();
    run.sources.insert("gone".into(), ExportSource { path: dir.join("moved-away.mp4"), media });
    let req = request(clips(R30, &[("s", 0, 30), ("gone", 0, 30)]), &dir, "missing");
    let plan = plan_export(&tools, &spec(&req, &run, &work, ExportOptions::default()), &CancelToken::new()).unwrap();
    let b = plan.blocked_by.unwrap();
    assert_eq!(b.code, ErrorCode::SourceMissing);
    assert!(b.message.contains("moved-away.mp4"), "{}", b.message);
    assert_eq!(plan.duration, frame_to_micros(60, R30), "the plan still shows the length");
    let req = request(clips(R30, &[("nobody", 0, 30)]), &dir, "unknown");
    let plan = plan_export(&tools, &spec(&req, &run, &work, ExportOptions::default()), &CancelToken::new()).unwrap();
    assert_eq!(plan.blocked_by.unwrap().code, ErrorCode::SourceMissing);
    assert!(!work.exists());
}

#[test]
fn gpu_decode_failure_falls_back_and_an_encoder_failure_is_reported() {
    let _g = gpu_lock();
    let tools = common::tools();
    let src = m1080p60(&tools);
    let dir = common::scratch("export-gpu");
    let work = dir.join("work");
    let run = Run::new(&tools, &[("b", &src)]);
    assert_eq!(run.rate, Rational { num: 60, den: 1 });
    let r60 = run.rate;
    let list = [(30, 90), (5, 20)];
    let cl: Vec<(&str, i64, i64)> = list.iter().map(|(k, n)| ("b", *k, *n)).collect();
    let req = request(clips(r60, &cl), &dir.join("out"), "fallback");
    let options = ExportOptions { simulate_gpu_decode_failure: true, ..ExportOptions::default() };
    let (_, res) = export_ok(&tools, &spec(&req, &run, &work, options));
    let out = PathBuf::from(&res.path);
    assert_eq!(markers(&tools, &out), expected_cfr(4, &list));
    let (pk, tb) = packets(&tools, &out);
    assert_eq!(tb, (1, 30720));
    assert!(pk.iter().enumerate().all(|(i, p)| *p == (i as i64 * 512, 512)));

    let req = request(clips(r60, &cl), &dir.join("out2"), "no-encoder");
    let options = ExportOptions { simulate_encoder_failure: true, ..ExportOptions::default() };
    let err = run_export(&tools, &spec(&req, &run, &work, options), &CancelToken::new(), &mut |_| {}).unwrap_err();
    assert_eq!(err.code, ErrorCode::GpuUnavailable, "{err:?}");
    assert!(err.detail.as_deref().unwrap_or("").to_ascii_lowercase().contains("nvenc"), "{err:?}");
    let left: Vec<_> = std::fs::read_dir(dir.join("out2")).map(|rd| rd.filter_map(|e| e.ok()).collect()).unwrap_or_default();
    assert!(left.is_empty());
    assert_no_temp(&work);
}

#[test]
fn paths_with_quotes_brackets_and_commas_work() {
    let _g = gpu_lock();
    let tools = common::tools();
    let orig = mlate(&tools);
    let dir = common::scratch("export-odd").join("it's [odd], dir; x");
    std::fs::create_dir_all(&dir).unwrap();
    let src = dir.join("o'k, [src].mp4");
    std::fs::copy(&orig, &src).unwrap();
    let work = dir.join("wo'rk [tmp]");
    let run = Run::new(&tools, &[("o", &src)]);
    let list = [(40, 50), (0, 20)];
    let cl: Vec<(&str, i64, i64)> = list.iter().map(|(k, n)| ("o", *k, *n)).collect();
    let req = request(clips(R30, &cl), &dir.join("out [1]"), "it's done, ok");
    let (_, res) = export_ok(&tools, &spec(&req, &run, &work, ExportOptions::default()));
    let out = PathBuf::from(&res.path);
    assert_eq!(out.file_name().unwrap(), "it's done, ok.mp4");
    assert_eq!(markers(&tools, &out), expected_cfr(6, &list));
    let x = audio_len_ok(&tools, &out, 0, 70, R30);
    check_beeps(&x, &list, R30, 1.0, 0.0, "odd path");
}

/// A camera-style transport stream (.m2ts, streams starting near 1.4 s) with a keyframe only
/// every 5 s: a fast seek lands on the keyframe after its target there, so clips deep between
/// keyframes need a longer pre-roll (found by the one-frame seek check). Frames and sound exact.
#[test]
fn transport_stream_with_long_keyframe_gaps_is_frame_exact() {
    let _g = gpu_lock();
    let tools = common::tools();
    let ts = src_dir().join("mts-gop150.m2ts");
    if !ts.is_file() {
        let tmp = src_dir().join("mts-gop150.tmp.m2ts");
        let graph = format!(
            "testsrc2=s=1280x720:r=30:d=30[bg];nullsrc=s=16x2:r=30:d=30,format=gray,\
             geq=lum='if(lt(X,12),255*mod(floor(N/pow(2,X)),2),255*mod(floor(8/pow(2,X-12)),2))',\
             scale=1280:53:flags=neighbor[mk];[bg][mk]overlay=0:0,format=yuv420p[v];\
             aevalsrc=exprs='{BEEP_A}|{BEEP_A}':s=48000:d=30[a]"
        );
        common::ffmpeg(
            &tools,
            &[
                "-filter_complex", &graph, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", "150",
                "-keyint_min", "150", "-sc_threshold", "0", "-bf", "2", "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-f", "mpegts",
                &tmp.to_string_lossy(),
            ],
        );
        std::fs::rename(&tmp, &ts).unwrap();
    }
    let dir = common::scratch("export-m2ts");
    let work = dir.join("work");
    let run = Run::new(&tools, &[("t", &ts)]);
    assert_eq!(run.media("t").container, "mpegts");
    // Keyframes at 0, 150, 300, 450, 600, 750: 590 needs the 15 s pre-roll, 440 the 4 s one,
    // 160 lands right with 1 s, 20 is near the start, 760 is in the last group.
    let list = [(590, 40), (440, 30), (160, 20), (20, 15), (760, 60)];
    let cl: Vec<(&str, i64, i64)> = list.iter().map(|(k, n)| ("t", *k, *n)).collect();
    let req = request(clips(R30, &cl), &dir.join("out"), "m2ts");
    let (_, res) = export_ok(&tools, &spec(&req, &run, &work, ExportOptions::default()));
    let out = PathBuf::from(&res.path);
    let marks = markers(&tools, &out);
    assert_eq!(marks, expected_cfr(8, &list));
    let total: i64 = list.iter().map(|c| c.1).sum();
    let x = audio_len_ok(&tools, &out, 0, total, R30);
    let last = check_beeps(&x, &list, R30, 1.0, 0.0, "m2ts track 0").unwrap();
    assert_end_sync(&marks, &list, last, R30, 8);
}

/// The first clip is 1080p60 in a 30 fps sequence: the export runs at 60 fps (a whole multiple,
/// so every cut stays on a frame), the 60 fps clips keep all their frames, the 30 fps clips show
/// each frame twice, and the sound is as long as the picture.
#[test]
fn a_first_clip_at_twice_the_sequence_rate_exports_at_its_own_rate() {
    let _g = gpu_lock();
    let tools = common::tools();
    let (a, b) = (mlate(&tools), m1080p60(&tools));
    let dir = common::scratch("export-first-60");
    let work = dir.join("work");
    let run = Run::new(&tools, &[("a", &a), ("b", &b)]);
    assert_eq!(run.rate, R30);
    let cl = [("b", 31, 40), ("a", 45, 30), ("b", 100, 20)];
    let req = request(clips(R30, &cl), &dir.join("out"), "first-60");
    let (plan, res) = export_ok(&tools, &spec(&req, &run, &work, ExportOptions::default()));
    let r60 = Rational { num: 60, den: 1 };
    assert_eq!((plan.format.width, plan.format.height, plan.format.frame_rate, plan.format.audio_tracks), (1920, 1080, r60, 1));
    assert!(plan.notices.iter().any(|n| n.starts_with("Sources differ; the export follows the first clip (1920x1080, 60 fps")), "{:?}", plan.notices);
    let total30: i64 = cl.iter().map(|c| c.2).sum();
    assert_eq!(plan.duration, frame_to_micros(total30, R30), "the same length as on the sequence grid");
    let out = PathBuf::from(&res.path);
    let (v, au) = streams(&tools, &out);
    assert_eq!((v["width"].as_u64(), v["height"].as_u64(), v["r_frame_rate"].as_str()), (Some(1920), Some(1080), Some("60/1")));
    assert_eq!(au.len(), 1);
    let (pk, tb) = packets(&tools, &out);
    assert_eq!(tb, (1, 30720));
    assert!(pk.iter().enumerate().all(|(i, p)| *p == (i as i64 * 512, 512)), "constant 60 fps");
    let mut want = Vec::new();
    for (id, k, n) in cl {
        if id == "b" {
            want.extend((2 * k..2 * (k + n)).map(|f| (4, f as u32)));
        } else {
            want.extend((k..k + n).flat_map(|f| [(6, f as u32), (6, f as u32)]));
        }
    }
    assert_eq!(markers(&tools, &out), want);
    let list60: Vec<(i64, i64)> = cl.iter().map(|c| (2 * c.1, 2 * c.2)).collect();
    let x = audio_len_ok(&tools, &out, 0, 2 * total30, r60);
    check_beeps(&x, &list60, r60, 1.0, 0.0, "first-60 track 0");
}

/// Exporting onto a project source (same folder and name, another spelling of the path) is
/// blocked before anything starts, and the source is untouched.
#[test]
fn an_export_onto_a_source_file_is_blocked() {
    let _g = gpu_lock();
    let tools = common::tools();
    let dir = common::scratch("export-onto-source");
    let src = dir.join("Weekly.mp4");
    std::fs::copy(mlate(&tools), &src).unwrap();
    let before = std::fs::metadata(&src).unwrap().len();
    let run = Run::new(&tools, &[("s", &src)]);
    let work = dir.join("work");
    for name in ["weekly", "WEEKLY.mp4"] {
        let folder = PathBuf::from(dir.to_string_lossy().replace('\\', "/")).join("sub").join("..");
        let req = request(clips(R30, &[("s", 0, 30)]), &folder, name);
        let s = spec(&req, &run, &work, ExportOptions::default());
        let b = plan_export(&tools, &s, &CancelToken::new()).unwrap().blocked_by.expect("blocked");
        assert_eq!(b.code, ErrorCode::ExportFailed);
        assert!(b.message.contains("would replace a source file (Weekly.mp4)"), "{}", b.message);
        let err = run_export(&tools, &s, &CancelToken::new(), &mut |_| {}).unwrap_err();
        assert_eq!(err.code, ErrorCode::ExportFailed);
    }
    assert_eq!(std::fs::metadata(&src).unwrap().len(), before);
    assert!(!work.exists(), "nothing was started");
}

/// Measured speed on the 4K fixtures (printed; run with --nocapture to see it). Also checks
/// that the size estimate is not below the real file and that the disk check asks for at least
/// the real peak (pieces + finished file).
#[test]
fn speed_on_the_4k_fixtures() {
    let _g = gpu_lock();
    let tools = common::tools();
    let dir = common::scratch("export-speed");
    let work = dir.join("work");
    for name in ["numbered-4k-h264", "numbered-4k-hevc10-hdr"] {
        let src = common::fixture(name);
        let run = Run::new(&tools, &[("f", &src)]);
        for (label, cl) in [
            ("1 clip of 30 s", vec![("f", 0i64, 900i64)]),
            ("12 clips, 26 s", (0..12).map(|i| ("f", i * 73 + 7, 65)).collect::<Vec<_>>()),
        ] {
            let req = request(clips(R30, &cl), &dir.join("out"), &format!("{name}-{}", cl.len()));
            let (plan, res) = export_ok(&tools, &spec(&req, &run, &work, ExportOptions::default()));
            let secs = res.duration as f64 / 1e6;
            let speed = secs / res.took_seconds;
            eprintln!(
                "SPEED {name}, {label}: {secs:.2} s of output in {:.2} s = {speed:.2} x real time; {} bytes; plan said {:.1} s and {} bytes",
                res.took_seconds, res.bytes, plan.estimated_seconds, plan.estimated_bytes
            );
            assert!(speed > 0.5, "{name} {label}: {speed:.2} x real time");
            assert!(plan.estimated_bytes >= res.bytes, "{name} {label}: estimated {} bytes, the file is {}", plan.estimated_bytes, res.bytes);
            // What the disk check asks for (pieces and file on one drive) covers the real peak.
            let tight = ExportOptions { free_bytes_override: Some(1), ..ExportOptions::default() };
            let b = plan_export(&tools, &spec(&req, &run, &work, tight), &CancelToken::new()).unwrap().blocked_by.unwrap();
            let need: u64 = b.detail.as_ref().unwrap().split_whitespace().nth(1).unwrap().parse().unwrap();
            assert!(need >= 2 * res.bytes, "{name} {label}: the check asks for {need} bytes, the peak is about {}", 2 * res.bytes);
            eprintln!("SIZE {name}, {label}: estimate {} / actual {} = {:.2}; disk check {need}", plan.estimated_bytes, res.bytes,
                plan.estimated_bytes as f64 / res.bytes as f64);
        }
    }
}
