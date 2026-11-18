//! Export (spec 2.4.8, 3.5.9): planning, and the whole export as one cancellable task.
//!
//! The method and settings are those of the export experiment (spikes/export/RESULT.md):
//! clip by clip, two pieces at a time on NVENC ([`encode_clip`]), every audio track of the
//! sequence in one FFmpeg run alongside the pieces ([`render_audio`]), then a join without
//! re-encoding the picture ([`join`]). [`run_export`] does all three in a temporary folder that
//! is removed in every outcome; the MP4 is written as `<destination>.part` and renamed only
//! when complete, so a cancelled or failed export leaves nothing at the destination.
//!
//! Progress is exact: frames encoded so far over the sequence's frames, then the join, weighted
//! by the time model of the experiment.

mod audio;
mod disk;
mod join;
mod piece;
mod settings;
mod source;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime};

use rc_types::grid::{first_clip_end, frame_to_micros, micros_to_frame_floor};
use rc_types::{AppError, BitDepth, ErrorCode, ExportPlan, ExportRequest, ExportResult, MediaInfo, OutputCodec, OutputFormat, Rational, SourceId};

pub use audio::{AudioRenderRequest, SequenceClip, render_audio};
pub use join::{JoinPiece, JoinRequest, join};
pub use piece::{ClipFrames, DecodeChoice, PieceOutcome, PieceRequest, encode_clip};
pub use settings::{
    EXPORT_AUDIO_RATE, EXPORT_CQ, EXPORT_GOP, EXPORT_PARALLEL_PIECES, EXPORT_PRESET, EXPORT_RAMP_SECONDS, format_bytes, output_format,
    output_frame_rate,
};
pub use source::{OutputColor, PreparedSource, prepare_source};

use crate::process::{CancelToken, ProgressClock, TaskProgress, ensure_parent, in_progress_path};
use crate::tools::FfmpegTools;

/// A source the export may read: where the original is and its probe result (the project's
/// `SourceRef.path` and `SourceRef.media`).
#[derive(Debug, Clone)]
pub struct ExportSource {
    /// The original file.
    pub path: PathBuf,
    /// Its probe result.
    pub media: MediaInfo,
}

/// Choices that are not part of the request.
#[derive(Debug, Clone)]
pub struct ExportOptions {
    /// Pieces encoded at the same time (1 to 4). Default [`EXPORT_PARALLEL_PIECES`].
    pub parallel_pieces: usize,
    /// Test hook: the free space to assume at every drive instead of asking Windows.
    #[doc(hidden)]
    pub free_bytes_override: Option<u64>,
    /// Test hook: every GPU decode attempt fails.
    #[doc(hidden)]
    pub simulate_gpu_decode_failure: bool,
    /// Test hook: the encoder fails as a missing NVENC would.
    #[doc(hidden)]
    pub simulate_encoder_failure: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        ExportOptions {
            parallel_pieces: EXPORT_PARALLEL_PIECES,
            free_bytes_override: None,
            simulate_gpu_decode_failure: false,
            simulate_encoder_failure: false,
        }
    }
}

/// Everything an export needs.
#[derive(Debug, Clone)]
pub struct ExportSpec<'a> {
    /// What the interface asked for: the clips, the folder and the file name.
    pub request: &'a ExportRequest,
    /// The project's sources, by id.
    pub sources: &'a HashMap<SourceId, ExportSource>,
    /// The sequence's frame grid (`Project.frameRate`); the clips' edges are on it.
    pub frame_rate: Rational,
    /// Folder in which the export makes its temporary folder (the cache decides). The
    /// temporary folder is removed when the export ends, whatever the outcome.
    pub work_root: &'a Path,
    /// Other choices.
    pub options: ExportOptions,
}

/// Where the finished file goes: `folder/fileName`, with `.mp4` added when the name has no
/// such extension. An error for an empty name or one with folder separators.
pub fn export_destination(request: &ExportRequest) -> Result<PathBuf, AppError> {
    let name = request.file_name.trim();
    let bad = |why: &str| AppError::new(ErrorCode::ExportFailed, format!("The file name is not usable: {why}")).with_detail(name.to_string());
    if name.is_empty() || name == "." || name == ".." {
        return Err(bad("it is empty"));
    }
    if name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err(bad("it contains a character Windows does not allow in names"));
    }
    if request.folder.trim().is_empty() {
        return Err(AppError::new(ErrorCode::ExportFailed, "No folder was chosen for the export"));
    }
    let has_mp4 = Path::new(name).extension().is_some_and(|e| e.eq_ignore_ascii_case("mp4"));
    let file = if has_mp4 { name.to_string() } else { format!("{name}.mp4") };
    Ok(Path::new(request.folder.trim()).join(file))
}

/// What is already at the destination's path.
#[derive(Debug, PartialEq)]
enum Taken {
    /// A file: the export replaces it (the notice says so).
    File(String),
    /// A folder: the export cannot be written there.
    Folder(AppError),
}

/// Whether something is already at `dest`. A file of the same name is replaced by the export
/// (the plan says so before you confirm); a folder of that name blocks it.
fn destination_taken(dest: &Path) -> Option<Taken> {
    let meta = std::fs::metadata(dest).ok()?;
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if meta.is_dir() {
        return Some(Taken::Folder(
            AppError::new(ErrorCode::ExportFailed, format!("A folder named {name} is in the way. Choose another name."))
                .with_detail(dest.to_string_lossy().into_owned()),
        ));
    }
    Some(Taken::File(format!("A file named {name} is already in this folder; exporting replaces it.")))
}

/// One clip of the sequence, resolved: which prepared source, which frames.
#[derive(Debug, Clone, Copy)]
struct Item {
    src: usize,
    clip: ClipFrames,
}

/// The plan, plus what running it needs.
struct Resolved {
    plan: ExportPlan,
    items: Vec<Item>,
    prepared: Vec<PreparedSource>,
    total_frames: i64,
    destination: Option<PathBuf>,
    est_video_seconds: f64,
    est_join_seconds: f64,
}

fn same_format(m: &MediaInfo, f: &OutputFormat) -> bool {
    let codec_family = if m.video.codec == "hevc" { OutputCodec::Hevc } else { OutputCodec::H264 };
    m.video.width == f.width
        && m.video.height == f.height
        && m.video.frame_rate == f.frame_rate
        && m.video.bit_depth == f.bit_depth
        && m.video.hdr == f.hdr
        && (codec_family == f.codec || f.bit_depth == BitDepth::Ten)
}

fn format_label(f: &OutputFormat) -> String {
    format!(
        "{}x{}, {} fps, {} {}-bit{}",
        f.width,
        f.height,
        settings::rate_label(f.frame_rate),
        if f.codec == OutputCodec::H264 { "H.264" } else { "HEVC" },
        f.bit_depth.bits(),
        if f.hdr { " HDR" } else { "" }
    )
}

fn blocked(plan: &mut ExportPlan, e: AppError) {
    if plan.blocked_by.is_none() {
        plan.blocked_by = Some(e);
    }
}

fn file_name_of(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string())
}

/// Works out the plan. `Err` only for a cancel; every reason not to export is `blocked_by`.
fn resolve(tools: &FfmpegTools, spec: &ExportSpec<'_>, cancel: &CancelToken) -> Result<Resolved, AppError> {
    let rate = spec.frame_rate;
    if rate.num == 0 || rate.den == 0 {
        return Err(AppError::internal("The sequence has no frame rate"));
    }
    let parallel = spec.options.parallel_pieces.clamp(1, 4);
    let mut plan = ExportPlan {
        duration: 0,
        format: OutputFormat {
            codec: OutputCodec::H264,
            width: 0,
            height: 0,
            frame_rate: rate,
            bit_depth: BitDepth::Eight,
            hdr: false,
            audio_tracks: 0,
        },
        estimated_bytes: 0,
        estimated_seconds: 0.0,
        free_bytes: 0,
        notices: Vec::new(),
        blocked_by: None,
        required_bytes: None,
    };
    let destination = match export_destination(spec.request) {
        Ok(d) => Some(d),
        Err(e) => {
            blocked(&mut plan, e);
            None
        }
    };

    // Clips to frames; sources looked up and checked.
    let mut order: Vec<SourceId> = Vec::new();
    let mut raw_items: Vec<(usize, ClipFrames)> = Vec::new();
    for clip in &spec.request.clips {
        let Some(src) = spec.sources.get(&clip.source_id) else {
            blocked(
                &mut plan,
                AppError::new(ErrorCode::SourceMissing, "A clip's source is not in the project").with_detail(clip.source_id.clone()),
            );
            continue;
        };
        let Some(mut frames) = ClipFrames::from_clip(clip, rate) else { continue };
        // Never past the end of the source (a clip there would have no picture).
        if let Some(end) = first_clip_end(src.media.duration, rate) {
            let last = micros_to_frame_floor(end, rate);
            frames.frames = frames.frames.min(last - frames.start_frame);
        }
        if frames.frames < 1 {
            continue;
        }
        let idx = order.iter().position(|id| id == &clip.source_id).unwrap_or_else(|| {
            order.push(clip.source_id.clone());
            order.len() - 1
        });
        raw_items.push((idx, frames));
    }
    if raw_items.is_empty() && plan.blocked_by.is_none() {
        blocked(&mut plan, AppError::new(ErrorCode::NothingToExport, "Everything was cut, so there is nothing to export"));
    }
    if let Some(&(first, _)) = raw_items.first() {
        plan.format = output_format(&spec.sources[&order[first]].media, rate);
    }
    let format = plan.format.clone();
    // From here on frames are output frames: each sequence frame is `m` of them (1 unless the
    // first clip runs at a whole multiple of the sequence rate).
    let out_rate = format.frame_rate;
    let m = settings::rate_multiple(out_rate, rate).unwrap_or(1);
    for (_, c) in raw_items.iter_mut() {
        *c = ClipFrames { start_frame: c.start_frame * m, frames: c.frames * m };
    }
    let total_frames: i64 = raw_items.iter().map(|(_, c)| c.frames).sum();
    plan.duration = frame_to_micros(total_frames, out_rate);

    // Never write over one of the project's own files (spec 2.4.2: originals are read-only).
    if let Some(dest) = &destination {
        let part = in_progress_path(dest);
        for id in &order {
            let p = &spec.sources[id].path;
            if disk::same_file(p, dest) || disk::same_file(p, &part) {
                blocked(
                    &mut plan,
                    AppError::new(
                        ErrorCode::ExportFailed,
                        format!("The export would replace a source file ({}). Choose another name or folder.", file_name_of(p)),
                    )
                    .with_detail(p.display().to_string()),
                );
            }
        }
    }

    // Missing files block; readable ones are prepared (one ffprobe each).
    let mut prepared = Vec::new();
    for id in &order {
        let s = &spec.sources[id];
        if !s.path.is_file() {
            blocked(
                &mut plan,
                AppError::new(ErrorCode::SourceMissing, format!("A source file is missing: {}. Locate it first.", file_name_of(&s.path)))
                    .with_detail(s.path.display().to_string()),
            );
            continue;
        }
        match prepare_source(tools, &s.path, &s.media, cancel) {
            Ok(p) => prepared.push(p),
            Err(e) if e.code == ErrorCode::Cancelled => return Err(e),
            Err(e) => blocked(&mut plan, e),
        }
    }
    let items: Vec<Item> = raw_items.iter().map(|&(src, clip)| Item { src, clip }).collect();

    // Notices.
    if !items.is_empty() {
        let first = &spec.sources[&order[items[0].src]].media;
        if order.iter().any(|id| !same_format(&spec.sources[id].media, &format)) {
            plan.notices.push(format!("Sources differ; the export follows the first clip ({}).", format_label(&format)));
        }
        if first.video.frame_rate != out_rate {
            plan.notices.push(format!(
                "The first clip is {} fps; the export keeps the sequence's {} fps so every cut stays on a frame.",
                settings::rate_label(first.video.frame_rate),
                settings::rate_label(out_rate)
            ));
        }
        if first.video.codec == "h264" && first.video.bit_depth == BitDepth::Ten {
            plan.notices.push("10-bit H.264 cannot be encoded on this GPU, so the export is HEVC 10-bit.".into());
        } else if !matches!(first.video.codec.as_str(), "h264" | "hevc") {
            plan.notices.push(format!(
                "The first clip is {}; the export is {}.",
                first.video.codec,
                piece::codec_name(format.codec).to_uppercase().replace("H264", "H.264")
            ));
        }
        if order.iter().any(|id| spec.sources[id].media.video.variable_frame_rate) {
            plan.notices
                .push(format!("Variable frame rate footage is converted to a constant {} fps.", settings::rate_label(out_rate)));
        }
        if order.iter().any(|id| (spec.sources[id].media.audio_tracks.len() as u32) < format.audio_tracks) {
            plan.notices.push("Some clips have fewer audio tracks than the first; those tracks are silent there.".into());
        }
    }
    if let Some(dest) = &destination {
        match destination_taken(dest) {
            Some(Taken::File(n)) => plan.notices.push(n),
            Some(Taken::Folder(e)) => blocked(&mut plan, e),
            None => {}
        }
    }

    // Size, time and disk space.
    // The disk check allows for the video coming out DISK_MARGIN times larger than estimated
    // (never above the codec's rate ceiling): the pieces and the finished file both need it.
    let mut video_bytes = 0.0;
    let mut video_bytes_bound = 0.0;
    let out_fps = out_rate.num as f64 / out_rate.den.max(1) as f64;
    let output_scale = (format.width as f64 * format.height as f64) / (3840.0 * 2160.0) * out_fps / 30.0;
    if prepared.len() == order.len() {
        for it in &items {
            let p = &prepared[it.src];
            let v = &p.media.video;
            let pixels = (format.width as f64 * format.height as f64) / (v.width.max(1) as f64 * v.height.max(1) as f64);
            let fps_ratio = out_fps / (v.frame_rate.num.max(1) as f64 / v.frame_rate.den.max(1) as f64);
            let bits = settings::output_video_bit_rate(format.codec, p.video_bit_rate, pixels * fps_ratio, output_scale);
            let secs = settings::frames_to_seconds(it.clip.frames, out_rate);
            video_bytes += secs * bits / 8.0;
            video_bytes_bound += secs * (bits * settings::DISK_MARGIN).min(settings::rate_ceiling(format.codec)) / 8.0;
        }
    }
    let seconds = settings::frames_to_seconds(total_frames, out_rate);
    let audio_bytes = seconds * settings::AUDIO_BYTES_PER_SECOND_PER_TRACK * format.audio_tracks as f64;
    let estimated = (video_bytes + audio_bytes).ceil() as u64;
    let file_bound = (video_bytes_bound + audio_bytes).ceil() as u64;
    let channels: u32 = items
        .first()
        .and_then(|it| prepared.get(it.src))
        .map(|p| p.media.audio_tracks.iter().take(format.audio_tracks as usize).map(|t| t.channels.max(1)).sum())
        .unwrap_or(0);
    let pcm_bytes = (seconds * EXPORT_AUDIO_RATE as f64 * 4.0 * channels as f64).ceil() as u64;
    let temp_bytes = video_bytes_bound.ceil() as u64 + pcm_bytes;
    plan.estimated_bytes = estimated;
    let est_join_seconds = settings::join_seconds(estimated);
    plan.estimated_seconds = settings::estimate_seconds(items.len(), total_frames, &format, estimated, parallel);
    let est_video_seconds = (plan.estimated_seconds - est_join_seconds).max(0.001);

    let free = |p: &Path| spec.options.free_bytes_override.or_else(|| disk::free_bytes(p));
    if let Some(dest) = &destination {
        let dest_dir = dest.parent().unwrap_or(Path::new("."));
        let free_dest = free(dest_dir);
        plan.free_bytes = free_dest.unwrap_or(0);
        let same = disk::same_volume(dest_dir, spec.work_root);
        if !items.is_empty() {
            plan.required_bytes = Some(if same { file_bound + temp_bytes } else { file_bound });
        }
        let needs: Vec<(PathBuf, u64, Option<u64>)> = if same {
            vec![(dest_dir.to_path_buf(), file_bound + temp_bytes, free_dest)]
        } else {
            vec![(dest_dir.to_path_buf(), file_bound, free_dest), (spec.work_root.to_path_buf(), temp_bytes, free(spec.work_root))]
        };
        for (dir, need, have) in needs {
            if let Some(have) = have
                && have < need
                && !items.is_empty()
            {
                let place = disk::existing_ancestor(&dir).unwrap_or(dir.clone());
                blocked(
                    &mut plan,
                    AppError::new(
                        ErrorCode::DiskFull,
                        format!(
                            "Not enough disk space: the export needs about {} on the drive of {}, and {} is free.",
                            format_bytes(need),
                            place.display(),
                            format_bytes(have)
                        ),
                    )
                    .with_detail(format!("needed {need} bytes, free {have} bytes at {}", place.display())),
                );
            }
        }
    }

    Ok(Resolved { plan, items, prepared, total_frames, destination, est_video_seconds, est_join_seconds })
}

/// What the Export dialog shows before you confirm: length, format, estimated size and time,
/// free space at the destination, notices, and `blocked_by` when the export cannot run
/// (`nothing_to_export`, `source_missing`, `source_unreadable`, `disk_full` with the amount
/// needed, `export_failed` for an unusable file name). Runs one ffprobe per source.
/// `Err` only when cancelled.
pub fn plan_export(tools: &FfmpegTools, spec: &ExportSpec<'_>, cancel: &CancelToken) -> Result<ExportPlan, AppError> {
    Ok(resolve(tools, spec, cancel)?.plan)
}

/// A folder removed (with everything in it) when dropped.
struct TempFolder(PathBuf);

impl TempFolder {
    fn create(root: &Path) -> Result<TempFolder, AppError> {
        let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = root.join(format!("rc-export-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| {
            AppError::new(ErrorCode::ExportFailed, "The export's temporary folder could not be made").with_detail(format!("{}: {e}", dir.display()))
        })?;
        Ok(TempFolder(dir))
    }
}

impl Drop for TempFolder {
    fn drop(&mut self) {
        // A just-ended FFmpeg can hold a file for a moment on Windows: retry briefly.
        for _ in 0..40 {
            if std::fs::remove_dir_all(&self.0).is_ok() || !self.0.exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

/// A file removed when dropped (the `.part` of the destination; gone already after the rename).
struct RemoveOnDrop(PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        for _ in 0..40 {
            if std::fs::remove_file(&self.0).is_ok() || !self.0.exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

enum Msg {
    Piece(usize, f64),
    PieceDone(usize, Result<(), AppError>),
    Audio(Result<(), AppError>),
}

/// Runs the whole export: plans again (and refuses with the plan's `blocked_by`), encodes the
/// pieces two at a time while the sound is rendered, joins them, and returns the result.
/// Cancel stops every FFmpeg at once. In every outcome the temporary folder is removed, and
/// when cancelled or failed nothing is left at the destination. Errors: those of the plan,
/// `cancelled`, `disk_full`, `gpu_unavailable` (NVENC could not start; FFmpeg's error tail as
/// detail), `export_failed` (with the error tail), `source_missing`.
pub fn run_export(
    tools: &FfmpegTools,
    spec: &ExportSpec<'_>,
    cancel: &CancelToken,
    on_progress: &mut dyn FnMut(TaskProgress),
) -> Result<ExportResult, AppError> {
    let started = Instant::now();
    let r = resolve(tools, spec, cancel)?;
    if let Some(e) = r.plan.blocked_by.clone() {
        return Err(e);
    }
    let destination = r.destination.clone().ok_or_else(|| AppError::internal("No destination"))?;
    ensure_parent(&destination).map_err(|e| AppError { code: ErrorCode::ExportFailed, ..e })?;
    let work_root = std::path::absolute(spec.work_root).unwrap_or_else(|_| spec.work_root.to_path_buf());
    let work = TempFolder::create(&work_root)?;
    let _part = RemoveOnDrop(in_progress_path(&destination));
    let format = r.plan.format.clone();
    let first = &r.prepared[r.items[0].src];
    let color = first.color().clone();
    let layouts: Vec<String> = (0..format.audio_tracks as usize)
        .map(|t| first.audio_layouts.get(t).cloned().unwrap_or_else(|| source::default_layout(2)))
        .collect();
    let track_channels: Vec<u32> = (0..format.audio_tracks as usize)
        .map(|t| first.media.audio_tracks.get(t).map(|a| a.channels.max(1)).unwrap_or(2))
        .collect();
    let track_titles: Vec<Option<String>> = (0..format.audio_tracks as usize)
        .map(|t| first.media.audio_tracks.get(t).and_then(|a| a.title.clone()))
        .collect();
    // One piece per clip.
    let piece_items = &r.items;
    let pieces: Vec<PathBuf> = (0..piece_items.len()).map(|i| work.0.join(format!("piece_{i:05}.mp4"))).collect();
    let audio_file = work.0.join("audio.nut");
    let audio_script = work.0.join("audio.filtergraph.txt");
    let seq: Vec<SequenceClip<'_>> = r.items.iter().map(|it| SequenceClip { source: &r.prepared[it.src], clip: it.clip }).collect();

    let video_w = r.est_video_seconds / (r.est_video_seconds + r.est_join_seconds);
    let total = r.total_frames.max(1) as f64;
    let mut clock = ProgressClock::new();
    let mut report = |fraction: f64, on_progress: &mut dyn FnMut(TaskProgress)| {
        if let Some(p) = clock.report(fraction) {
            on_progress(p);
        }
    };
    report(0.0, on_progress);

    // Pieces (two at a time) and the sound, together.
    let stop = CancelToken::new();
    let next = AtomicUsize::new(0);
    let gpu_broken: Vec<AtomicBool> = r.prepared.iter().map(|_| AtomicBool::new(false)).collect();
    let workers = spec.options.parallel_pieces.clamp(1, 4).min(piece_items.len());
    let mut failure: Option<AppError> = None;
    {
        let (tx, rx) = mpsc::channel::<Msg>();
        let (stop, next, gpu_broken, seq, pieces, format, color) = (&stop, &next, &gpu_broken, &seq, &pieces, &format, &color);
        let (items, prepared) = (piece_items, &r.prepared);
        let opts = &spec.options;
        std::thread::scope(|s| {
            for _ in 0..workers {
                let tx = tx.clone();
                s.spawn(move || {
                    loop {
                        if stop.is_cancelled() {
                            return;
                        }
                        let i = next.fetch_add(1, Ordering::SeqCst);
                        if i >= items.len() {
                            return;
                        }
                        let item = items[i];
                        let decode =
                            if gpu_broken[item.src].load(Ordering::SeqCst) { DecodeChoice::SoftwareOnly } else { DecodeChoice::Auto };
                        let req = PieceRequest {
                            source: &prepared[item.src],
                            clip: item.clip,
                            format,
                            color,
                            output: &pieces[i],
                            decode,
                            simulate_gpu_decode_failure: opts.simulate_gpu_decode_failure,
                            simulate_encoder_failure: opts.simulate_encoder_failure,
                        };
                        let res = encode_clip(tools, &req, stop, &mut |p| {
                            let _ = tx.send(Msg::Piece(i, p.fraction));
                        });
                        if let Ok(o) = &res
                            && o.gpu_decode_failure.is_some()
                        {
                            gpu_broken[item.src].store(true, Ordering::SeqCst);
                        }
                        let failed = res.is_err();
                        let _ = tx.send(Msg::PieceDone(i, res.map(|_| ())));
                        if failed {
                            return;
                        }
                    }
                });
            }
            if format.audio_tracks > 0 {
                let tx = tx.clone();
                let (layouts, audio_file, audio_script) = (&layouts, &audio_file, &audio_script);
                s.spawn(move || {
                    let req = AudioRenderRequest { clips: seq, format, layouts, script: audio_script, output: audio_file };
                    let res = render_audio(tools, &req, stop, &mut |_| {});
                    let _ = tx.send(Msg::Audio(res));
                });
            }
            drop(tx);

            let mut done = vec![0.0f64; items.len()];
            let frames: Vec<f64> = items.iter().map(|c| c.clip.frames as f64).collect();
            loop {
                let msg = rx.recv_timeout(Duration::from_millis(50));
                match msg {
                    // max: a piece retried with a longer seek pre-roll starts its progress again.
                    Ok(Msg::Piece(i, f)) => done[i] = done[i].max((f * frames[i]).min(frames[i])),
                    Ok(Msg::PieceDone(i, Ok(()))) => done[i] = frames[i],
                    Ok(Msg::PieceDone(_, Err(e)) | Msg::Audio(Err(e))) => {
                        if failure.as_ref().is_none_or(|f| f.code == ErrorCode::Cancelled) && !cancel.is_cancelled() {
                            failure = Some(e);
                        }
                        stop.cancel();
                    }
                    Ok(Msg::Audio(Ok(()))) => {}
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
                if cancel.is_cancelled() {
                    stop.cancel();
                }
                let encoded: f64 = done.iter().sum();
                report(video_w * encoded / total, on_progress);
            }
        });
    }
    if cancel.is_cancelled() {
        return Err(AppError::new(ErrorCode::Cancelled, "Cancelled"));
    }
    if let Some(e) = failure {
        return Err(e);
    }

    // Join.
    let join_pieces: Vec<JoinPiece<'_>> =
        pieces.iter().zip(piece_items.iter()).map(|(p, it)| JoinPiece { path: p.as_path(), frames: it.clip.frames }).collect();
    let req = JoinRequest {
        pieces: &join_pieces,
        audio: (format.audio_tracks > 0).then_some(audio_file.as_path()),
        format: &format,
        track_channels: &track_channels,
        track_titles: &track_titles,
        list_file: &work.0.join("pieces.txt"),
        output: &destination,
    };
    let bytes = join(tools, &req, cancel, &mut |p| report(video_w + (1.0 - video_w) * p.fraction, on_progress))?;
    if cancel.is_cancelled() {
        let _ = std::fs::remove_file(&destination);
        return Err(AppError::new(ErrorCode::Cancelled, "Cancelled"));
    }
    report(1.0, on_progress);
    Ok(ExportResult {
        path: destination.to_string_lossy().into_owned(),
        duration: frame_to_micros(r.total_frames, format.frame_rate),
        bytes,
        took_seconds: started.elapsed().as_secs_f64(),
        finished_at: disk::iso_8601(SystemTime::now()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(folder: &str, name: &str) -> ExportRequest {
        ExportRequest { project_id: "p".into(), clips: vec![], folder: folder.into(), file_name: name.into() }
    }

    #[test]
    fn a_file_of_the_same_name_is_noticed_and_a_folder_blocks() {
        let dir = std::env::temp_dir().join(format!("rc-media-taken-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("weekly.mp4");
        assert_eq!(destination_taken(&file), None);
        std::fs::write(&file, b"old").unwrap();
        match destination_taken(&file) {
            Some(Taken::File(n)) => assert!(n.contains("weekly.mp4") && n.contains("already") && n.contains("replaces"), "{n}"),
            other => panic!("{other:?}"),
        }
        let folder = dir.join("clash.mp4");
        std::fs::create_dir_all(&folder).unwrap();
        match destination_taken(&folder) {
            Some(Taken::Folder(e)) => assert_eq!(e.code, ErrorCode::ExportFailed),
            other => panic!("{other:?}"),
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn destinations_get_an_mp4_name() {
        assert_eq!(export_destination(&req("D:/Videos", "weekly")).unwrap(), Path::new("D:/Videos").join("weekly.mp4"));
        assert_eq!(export_destination(&req("D:/Videos", "a.MP4")).unwrap(), Path::new("D:/Videos").join("a.MP4"));
        assert_eq!(export_destination(&req("D:/Videos", "v1.2")).unwrap(), Path::new("D:/Videos").join("v1.2.mp4"));
        assert_eq!(export_destination(&req("D:/Videos", "a/b")).unwrap_err().code, ErrorCode::ExportFailed);
        assert_eq!(export_destination(&req("D:/Videos", "  ")).unwrap_err().code, ErrorCode::ExportFailed);
        assert_eq!(export_destination(&req("", "a")).unwrap_err().code, ErrorCode::ExportFailed);
    }
}
