//! Speech audio: one audio track as 16 kHz mono signed 16-bit little-endian PCM, streamed to
//! the caller while FFmpeg is still decoding (spec 2.5: the transcriber starts on the first
//! seconds), and optionally saved as a WAV file at the same time.
//!
//! Time zero is the source's first video frame (as everywhere in rc-media), and the stream
//! is exactly the source's duration long: silence is added if the track ends early or
//! starts late, and anything past the end is dropped. So sample `n` is at `n / 16000` s
//! of source time.

use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::ChildStdout;

use rc_types::{AppError, ErrorCode, MediaInfo, Micros};

use crate::probe::inspect;
use crate::process::{
    CancelToken, ManagedChild, ProgressClock, TaskProgress, commit, ensure_parent, hidden_command, in_progress_path,
};
use crate::tools::FfmpegTools;

/// Samples per second of the speech stream.
pub const SPEECH_SAMPLE_RATE: u32 = 16_000;
/// Bytes per sample of the speech stream (signed 16-bit, mono).
pub const SPEECH_BYTES_PER_SAMPLE: u32 = 2;

/// Which track to stream, and whether to keep a copy.
#[derive(Debug, Clone)]
pub struct SpeechAudioRequest<'a> {
    /// The original file.
    pub source: &'a Path,
    /// Its probe result.
    pub media: &'a MediaInfo,
    /// Audio track index (as in `AudioTrackInfo.index`); usually `media.speech_track`.
    pub track: u32,
    /// Also write the stream to this WAV file (written as `<path>.part`, renamed on success).
    pub save_to: Option<&'a Path>,
}

impl<'a> SpeechAudioRequest<'a> {
    /// The speech track, not saved.
    pub fn new(source: &'a Path, media: &'a MediaInfo) -> SpeechAudioRequest<'a> {
        SpeechAudioRequest { source, media, track: media.speech_track, save_to: None }
    }
}

/// What a finished stream produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeechAudioSummary {
    /// Samples delivered (and saved).
    pub samples: u64,
    /// The WAV file, when one was asked for.
    pub saved_to: Option<PathBuf>,
}

/// The number of samples a source of `duration` gives.
pub fn speech_samples_for(duration: Micros) -> u64 {
    ((duration.max(0) as u128 * SPEECH_SAMPLE_RATE as u128 + 500_000) / 1_000_000) as u64
}

/// A 44-byte WAV header for 16 kHz mono 16-bit PCM with `data_bytes` of samples.
pub(crate) fn wav_header(data_bytes: u32) -> [u8; 44] {
    let mut h = [0u8; 44];
    let byte_rate = SPEECH_SAMPLE_RATE * SPEECH_BYTES_PER_SAMPLE;
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&data_bytes.saturating_add(36).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    h[22..24].copy_from_slice(&1u16.to_le_bytes()); // mono
    h[24..28].copy_from_slice(&SPEECH_SAMPLE_RATE.to_le_bytes());
    h[28..32].copy_from_slice(&byte_rate.to_le_bytes());
    h[32..34].copy_from_slice(&(SPEECH_BYTES_PER_SAMPLE as u16).to_le_bytes());
    h[34..36].copy_from_slice(&16u16.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    h
}

struct WavTee {
    part: PathBuf,
    output: PathBuf,
    file: BufWriter<File>,
    bytes: u64,
}

impl WavTee {
    fn create(output: &Path) -> Result<WavTee, AppError> {
        ensure_parent(output)?;
        let part = in_progress_path(output);
        let mut file = File::create(&part).map(BufWriter::new).map_err(|e| {
            AppError::internal("Could not create the speech audio file").with_detail(format!("{}: {e}", part.display()))
        })?;
        file.write_all(&wav_header(0)).map_err(|e| AppError::internal("Could not write the speech audio file").with_detail(e.to_string()))?;
        Ok(WavTee { part, output: output.to_path_buf(), file, bytes: 0 })
    }

    fn finish(mut self) -> std::io::Result<(PathBuf, PathBuf)> {
        let data = u32::try_from(self.bytes).unwrap_or(u32::MAX);
        self.file.flush()?;
        let mut f = self.file.into_inner().map_err(|e| e.into_error())?;
        f.seek(SeekFrom::Start(0))?;
        f.write_all(&wav_header(data))?;
        f.sync_all()?;
        Ok((self.part, self.output))
    }
}

/// The PCM stream. Read it like a file; then call [`SpeechAudioStream::finish`].
/// Dropping it without finishing kills FFmpeg and removes the partial WAV.
pub struct SpeechAudioStream {
    child: Option<ManagedChild>,
    stdout: Option<ChildStdout>,
    cancel: CancelToken,
    expected_bytes: u64,
    bytes_read: u64,
    clock: ProgressClock,
    tee: Option<WavTee>,
    tee_error: Option<String>,
}

impl SpeechAudioStream {
    /// Bytes the whole stream will have (2 × [`speech_samples_for`] the duration).
    pub fn expected_bytes(&self) -> u64 {
        self.expected_bytes
    }

    /// Bytes read so far.
    pub fn bytes_read(&self) -> u64 {
        self.bytes_read
    }

    /// How far the stream is, by bytes delivered.
    pub fn progress(&self) -> TaskProgress {
        self.clock.at(if self.expected_bytes == 0 { 1.0 } else { self.bytes_read as f64 / self.expected_bytes as f64 })
    }

    /// Stops the stream: FFmpeg is killed; `read` then fails and `finish` reports `cancelled`.
    pub fn cancel(&self) {
        self.cancel.cancel();
        if let Some(c) = &self.child {
            c.kill();
        }
    }

    /// Reads whatever is left (saving it if asked), waits for FFmpeg, and completes the WAV.
    pub fn finish(mut self) -> Result<SpeechAudioSummary, AppError> {
        let mut sink = [0u8; 64 * 1024];
        loop {
            match self.read(&mut sink) {
                Ok(0) => break,
                Ok(_) => {}
                Err(_) => break,
            }
        }
        drop(self.stdout.take());
        let child = self.child.take().ok_or_else(|| AppError::internal("speech audio already finished"))?;
        child.wait().map_err(|f| f.into_app_error(ErrorCode::Internal, "Could not read the sound for transcription"))?;
        let samples = self.bytes_read / SPEECH_BYTES_PER_SAMPLE as u64;
        if let Some(e) = self.tee_error.take() {
            return Err(AppError::internal("Could not write the speech audio file").with_detail(e));
        }
        let saved_to = match self.tee.take() {
            None => None,
            Some(tee) => {
                let (part, output) = tee
                    .finish()
                    .map_err(|e| AppError::internal("Could not write the speech audio file").with_detail(e.to_string()))?;
                commit(&part, &output)?;
                Some(output)
            }
        };
        Ok(SpeechAudioSummary { samples, saved_to })
    }
}

impl Read for SpeechAudioStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let Some(stdout) = self.stdout.as_mut() else { return Ok(0) };
        let n = stdout.read(buf)?;
        if n == 0 && self.cancel.is_cancelled() {
            return Err(std::io::Error::other("speech audio cancelled"));
        }
        self.bytes_read += n as u64;
        if let Some(tee) = self.tee.as_mut()
            && self.tee_error.is_none()
        {
            match tee.file.write_all(&buf[..n]) {
                Ok(()) => tee.bytes += n as u64,
                Err(e) => self.tee_error = Some(format!("{}: {e}", tee.part.display())),
            }
        }
        Ok(n)
    }
}

impl Drop for SpeechAudioStream {
    fn drop(&mut self) {
        if let Some(c) = self.child.take() {
            c.kill();
            drop(self.stdout.take());
            drop(c);
        }
        if let Some(tee) = self.tee.take() {
            let part = tee.part.clone();
            drop(tee);
            let _ = std::fs::remove_file(part);
        }
    }
}

/// FFmpeg arguments for the stream (everything after the program name).
fn speech_args(req: &SpeechAudioRequest<'_>, seek: Option<String>, has_track: bool, duration: Micros) -> Vec<String> {
    let dur = format!("{:.6}", duration as f64 / 1e6);
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error", "-nostats"].iter().map(|s| s.to_string()).collect();
    if has_track {
        if let Some(ss) = seek {
            a.extend(["-ss".into(), ss]);
        }
        a.extend(["-i".into(), req.source.to_string_lossy().into_owned()]);
        a.extend(["-map".into(), format!("0:a:{}", req.track), "-vn".into(), "-sn".into(), "-dn".into()]);
        a.extend(["-af".into(), format!("aresample=async=1:first_pts=0,apad=whole_dur={dur}")]);
    } else {
        a.extend(["-f".into(), "lavfi".into(), "-i".into(), format!("anullsrc=r={SPEECH_SAMPLE_RATE}:cl=mono")]);
    }
    a.extend(["-t".into(), dur, "-ac".into(), "1".into(), "-ar".into(), SPEECH_SAMPLE_RATE.to_string()]);
    a.extend(["-c:a".into(), "pcm_s16le".into(), "-f".into(), "s16le".into(), "pipe:1".into()]);
    a
}

/// Starts streaming the requested track. A source with no audio at all streams silence of
/// the source's length. Errors: `source_missing`, `source_unreadable`, `internal` (track out
/// of range, FFmpeg could not start), `cancelled`.
pub fn start_speech_audio(
    tools: &FfmpegTools,
    req: &SpeechAudioRequest<'_>,
    cancel: &CancelToken,
) -> Result<SpeechAudioStream, AppError> {
    let ins = inspect(tools, req.source, cancel)?;
    let has_track = !ins.audio.is_empty();
    if has_track && req.track as usize >= ins.audio.len() {
        return Err(AppError::internal("That audio track does not exist")
            .with_detail(format!("track {} of {} in {}", req.track, ins.audio.len(), req.source.display())));
    }
    let duration = req.media.duration;
    let tee = req.save_to.map(WavTee::create).transpose()?;
    let mut cmd = hidden_command(&tools.ffmpeg);
    cmd.args(speech_args(req, ins.seek_to_first_frame(), has_track, duration));
    let mut child = ManagedChild::spawn(cmd, cancel.clone()).map_err(|f| {
        f.into_app_error(ErrorCode::Internal, "Could not read the sound for transcription")
    })?;
    let stdout = child.take_stdout();
    Ok(SpeechAudioStream {
        child: Some(child),
        stdout,
        cancel: cancel.clone(),
        expected_bytes: speech_samples_for(duration) * SPEECH_BYTES_PER_SAMPLE as u64,
        bytes_read: 0,
        clock: ProgressClock::new(),
        tee,
        tee_error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_count_follows_duration() {
        assert_eq!(speech_samples_for(30_000_000), 480_000);
        assert_eq!(speech_samples_for(1), 0);
        assert_eq!(speech_samples_for(32), 1);
        assert_eq!(speech_samples_for(-5), 0);
    }

    #[test]
    fn wav_header_layout() {
        let h = wav_header(32_000);
        assert_eq!(&h[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(h[4..8].try_into().unwrap()), 32_036);
        assert_eq!(u32::from_le_bytes(h[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u16::from_le_bytes(h[34..36].try_into().unwrap()), 16);
        assert_eq!(u32::from_le_bytes(h[40..44].try_into().unwrap()), 32_000);
    }
}
