//! Waveform: the loudness file the timeline draws (spec 3.4 `WaveformHeader`, layout in
//! `rc_types::waveform`), written with `rc_types::write_waveform`.
//!
//! Resolution: [`WAVEFORM_VALUES_PER_SECOND`] = 240 values per second (one value per
//! 4.17 ms). 240 is a whole multiple of 24, 30, 48, 60, 120 and 240 fps, so at those rates
//! every frame covers a whole number of values (8 at 30 fps, 4 at 60 fps): edges can be
//! trimmed to the frame with the sound under them drawn exactly, and a 100 ms beep shows as
//! 24 values. At 25/50 fps a frame covers 9.6/4.8 values, still more than enough. Size is
//! 864 KB per hour.
//!
//! Each value is the peak absolute sample over all channels of the speech track in its slice,
//! decoded at 48 kHz (200 samples per value), scaled linearly to 0..255. Time zero is the
//! first video frame; the file always has `ceil(duration × 240)` values (silence pads).

use std::io::Write;
use std::path::Path;

use rc_types::{AppError, ErrorCode, MediaInfo, Micros, SourceId, WaveformHeader, write_waveform};

use crate::probe::inspect;
use crate::process::{
    CancelToken, ManagedChild, ProgressClock, TaskProgress, commit, ensure_parent, hidden_command, in_progress_path,
    read_full,
};
use crate::tools::FfmpegTools;

/// Loudness values per second of source time.
pub const WAVEFORM_VALUES_PER_SECOND: u32 = 240;
/// Decoding rate for the waveform.
const DECODE_RATE: u32 = 48_000;
/// Samples (per channel) behind one value.
const SAMPLES_PER_VALUE: usize = (DECODE_RATE / WAVEFORM_VALUES_PER_SECOND) as usize;

/// What to draw and where to put it.
#[derive(Debug, Clone)]
pub struct WaveformRequest<'a> {
    /// The original file.
    pub source: &'a Path,
    /// Its probe result.
    pub media: &'a MediaInfo,
    /// Written into the header.
    pub source_id: &'a SourceId,
    /// Audio track (as in `AudioTrackInfo.index`); usually `media.speech_track`.
    pub track: u32,
    /// Where the file goes (written as `<output>.part`, renamed when complete).
    pub output: &'a Path,
    /// `output` is already the in-progress name chosen by the caller (the cache's partial
    /// path): write it directly and leave renaming it to the caller.
    pub in_place: bool,
}

impl<'a> WaveformRequest<'a> {
    /// The waveform of the speech track.
    pub fn new(source: &'a Path, media: &'a MediaInfo, source_id: &'a SourceId, output: &'a Path) -> WaveformRequest<'a> {
        WaveformRequest { source, media, source_id, track: media.speech_track, output, in_place: false }
    }
}

/// How many values a source of `duration` has: `ceil(duration × valuesPerSecond)`.
pub fn waveform_value_count(duration: Micros) -> u64 {
    let d = duration.max(0) as u128 * WAVEFORM_VALUES_PER_SECOND as u128;
    d.div_ceil(1_000_000) as u64
}

/// Peak of `samples` (interleaved, any channel count) as 0..255.
pub(crate) fn peak_value(samples: &[f32]) -> u8 {
    let peak = samples.iter().fold(0.0f32, |m, s| if s.is_finite() { m.max(s.abs()) } else { m });
    (peak.min(1.0) * 255.0).round() as u8
}

/// Folds interleaved f32 samples into loudness values.
pub(crate) struct PeakFolder {
    channels: usize,
    pending: Vec<f32>,
    pub(crate) values: Vec<u8>,
}

impl PeakFolder {
    pub(crate) fn new(channels: usize) -> PeakFolder {
        PeakFolder { channels: channels.max(1), pending: Vec::new(), values: Vec::new() }
    }
    pub(crate) fn push(&mut self, samples: &[f32]) {
        self.pending.extend_from_slice(samples);
        let block = SAMPLES_PER_VALUE * self.channels;
        let whole = self.pending.len() / block * block;
        for chunk in self.pending[..whole].chunks_exact(block) {
            self.values.push(peak_value(chunk));
        }
        self.pending.drain(..whole);
    }
    /// The values, exactly `count` of them (a last partial slice counts; missing ones are 0).
    pub(crate) fn finish(mut self, count: u64) -> Vec<u8> {
        if !self.pending.is_empty() {
            let v = peak_value(&self.pending);
            self.values.push(v);
        }
        self.values.resize(count as usize, 0);
        self.values
    }
}

fn waveform_args(req: &WaveformRequest<'_>, seek: Option<String>, channels: u32, duration: Micros) -> Vec<String> {
    let dur = format!("{:.6}", duration as f64 / 1e6);
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error", "-nostats"].iter().map(|s| s.to_string()).collect();
    if let Some(ss) = seek {
        a.extend(["-ss".into(), ss]);
    }
    a.extend(["-i".into(), req.source.to_string_lossy().into_owned()]);
    a.extend(["-map".into(), format!("0:a:{}", req.track), "-vn".into(), "-sn".into(), "-dn".into()]);
    a.extend(["-af".into(), format!("aresample=async=1:first_pts=0,apad=whole_dur={dur}")]);
    a.extend(["-t".into(), dur, "-ac".into(), channels.to_string(), "-ar".into(), DECODE_RATE.to_string()]);
    a.extend(["-c:a".into(), "pcm_f32le".into(), "-f".into(), "f32le".into(), "pipe:1".into()]);
    a
}

fn write_file(output: &Path, in_place: bool, header: &WaveformHeader, values: &[u8]) -> Result<(), AppError> {
    let bytes = write_waveform(header, values).map_err(|e| AppError::internal("Could not build the waveform").with_detail(e.to_string()))?;
    ensure_parent(output)?;
    let part = if in_place { output.to_path_buf() } else { in_progress_path(output) };
    let written = std::fs::File::create(&part).and_then(|mut f| {
        f.write_all(&bytes)?;
        f.sync_all()
    });
    if let Err(e) = written {
        let _ = std::fs::remove_file(&part);
        let code = if e.kind() == std::io::ErrorKind::StorageFull { ErrorCode::DiskFull } else { ErrorCode::Internal };
        return Err(AppError::new(code, "Could not write the waveform").with_detail(format!("{}: {e}", part.display())));
    }
    if in_place { Ok(()) } else { commit(&part, output) }
}

/// Makes the waveform file and returns its header. A source with no audio gets a file of
/// zeros. Errors: `source_missing`, `source_unreadable`, `cancelled`, `disk_full`, `internal`.
pub fn make_waveform(
    tools: &FfmpegTools,
    req: &WaveformRequest<'_>,
    cancel: &CancelToken,
    on_progress: &mut dyn FnMut(TaskProgress),
) -> Result<WaveformHeader, AppError> {
    let ins = inspect(tools, req.source, cancel)?;
    let duration = req.media.duration;
    let count = waveform_value_count(duration);
    let header = WaveformHeader { source_id: req.source_id.clone(), values_per_second: WAVEFORM_VALUES_PER_SECOND, count };
    let mut clock = ProgressClock::new();

    let Some(track) = ins.audio.get(req.track as usize) else {
        if !ins.audio.is_empty() {
            return Err(AppError::internal("That audio track does not exist")
                .with_detail(format!("track {} of {} in {}", req.track, ins.audio.len(), req.source.display())));
        }
        write_file(req.output, req.in_place, &header, &vec![0u8; count as usize])?;
        if let Some(p) = clock.report(1.0) {
            on_progress(p);
        }
        return Ok(header);
    };
    let channels = track.channels.clamp(1, 8);

    let mut cmd = hidden_command(&tools.ffmpeg);
    cmd.args(waveform_args(req, ins.seek_to_first_frame(), channels, duration));
    let fail = |f: crate::process::RunFailure| f.into_app_error(ErrorCode::Internal, "Could not read the sound for the waveform");
    let mut child = ManagedChild::spawn(cmd, cancel.clone()).map_err(fail)?;
    let mut stdout = child.take_stdout().ok_or_else(|| AppError::internal("FFmpeg gave no output"))?;

    let expected_samples = (duration.max(0) as f64 / 1e6 * DECODE_RATE as f64).max(1.0);
    let mut folder = PeakFolder::new(channels as usize);
    let mut buf = vec![0u8; SAMPLES_PER_VALUE * channels as usize * 4 * 48];
    let mut frames_done: u64 = 0;
    let mut carry: Vec<u8> = Vec::new();
    if let Some(p) = clock.report(0.0) {
        on_progress(p);
    }
    loop {
        let n = read_full(&mut stdout, &mut buf).unwrap_or(0);
        if n == 0 {
            break;
        }
        carry.extend_from_slice(&buf[..n]);
        let whole = carry.len() / 4 * 4;
        let samples: Vec<f32> = carry[..whole].as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect();
        carry.drain(..whole);
        frames_done += (samples.len() / channels as usize) as u64;
        folder.push(&samples);
        if let Some(p) = clock.report((frames_done as f64 / expected_samples).min(0.999)) {
            on_progress(p);
        }
    }
    drop(stdout);
    child.wait().map_err(fail)?;
    let values = folder.finish(count);
    write_file(req.output, req.in_place, &header, &values)?;
    if let Some(p) = clock.report(1.0) {
        on_progress(p);
    }
    Ok(header)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_count_rounds_up() {
        assert_eq!(waveform_value_count(30_000_000), 7200);
        assert_eq!(waveform_value_count(1), 1);
        assert_eq!(waveform_value_count(0), 0);
        assert_eq!(waveform_value_count(4_167), 2);
    }

    #[test]
    fn peaks_are_linear_and_cover_all_channels() {
        assert_eq!(peak_value(&[0.0, 0.0]), 0);
        assert_eq!(peak_value(&[0.5, -0.1]), 128);
        assert_eq!(peak_value(&[0.1, -1.5]), 255);
        let mut f = PeakFolder::new(2);
        let mut s = vec![0.0f32; SAMPLES_PER_VALUE * 2 * 3];
        s[SAMPLES_PER_VALUE * 2 + 7] = -0.5; // right channel, second value
        f.push(&s[..100]);
        f.push(&s[100..]);
        f.push(&[0.25, 0.0]);
        assert_eq!(f.finish(6), vec![0, 128, 0, 64, 0, 0]);
    }
}
