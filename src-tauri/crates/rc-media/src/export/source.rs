//! What the export needs to know about one source, from one ffprobe run per source.

use std::path::{Path, PathBuf};

use rc_types::{AppError, ErrorCode, MediaInfo};

use crate::probe::{FfprobeOutput, Inspected, check_exists, inspect_from_json, parse_f64, run_ffprobe};
use crate::process::CancelToken;
use crate::tools::FfmpegTools;

/// Colour signalling written on every piece, taken from the first clip's source, so all pieces
/// carry the same stream description. `None` fields are left to FFmpeg.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OutputColor {
    /// E.g. "bt709", "bt2020".
    pub primaries: Option<String>,
    /// E.g. "bt709", "smpte2084".
    pub transfer: Option<String>,
    /// E.g. "bt709", "bt2020nc".
    pub space: Option<String>,
    /// "tv" or "pc".
    pub range: Option<String>,
}

impl OutputColor {
    /// The `-color_*` output options.
    pub(crate) fn args(&self) -> Vec<String> {
        let mut a = Vec::new();
        for (opt, v) in [
            ("-color_primaries", &self.primaries),
            ("-color_trc", &self.transfer),
            ("-colorspace", &self.space),
            ("-color_range", &self.range),
        ] {
            if let Some(v) = v {
                a.push(opt.to_string());
                a.push(v.clone());
            }
        }
        a
    }
}

/// A source ready for the export tasks: its path, its probe result and what one ffprobe run
/// adds (stream indices, start times, bit rate, channel layouts, colour tags).
/// Made by [`prepare_source`]; shared by every clip of that source.
#[derive(Debug, Clone)]
pub struct PreparedSource {
    /// The original file.
    pub path: PathBuf,
    /// Its probe result (as stored in the project).
    pub media: MediaInfo,
    pub(crate) ins: Inspected,
    /// Raw time of the first video frame, seconds (FFmpeg's `start_time` of the stream).
    pub(crate) video_start: f64,
    /// Raw start of the container, seconds.
    pub(crate) format_start: f64,
    /// Video bit rate, bits per second, when it can be read or worked out.
    pub(crate) video_bit_rate: Option<f64>,
    /// Absolute stream index of each audio track (FFmpeg `0:N`), in track order.
    pub(crate) audio_streams: Vec<u32>,
    /// Channel layout of each audio track ("stereo", "mono", "5.1(side)", "3c").
    pub(crate) audio_layouts: Vec<String>,
    pub(crate) color: OutputColor,
}

impl PreparedSource {
    /// The colour signalling of this source's picture.
    pub fn color(&self) -> &OutputColor {
        &self.color
    }
    /// The channel layout of each of its audio tracks, as FFmpeg names them.
    pub fn audio_layouts(&self) -> &[String] {
        &self.audio_layouts
    }
}

fn tag(v: &Option<String>) -> Option<String> {
    v.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "unknown" && *s != "reserved" && *s != "unspecified")
        .map(str::to_string)
}

/// A layout name FFmpeg's filters accept for `channels` channels when the file names none.
pub(crate) fn default_layout(channels: u32) -> String {
    match channels {
        0 | 2 => "stereo".into(),
        1 => "mono".into(),
        n => format!("{n}c"),
    }
}

/// Builds a [`PreparedSource`] from ffprobe's streams-and-format JSON.
pub(crate) fn prepared_from_json(json: &[u8], path: &Path, media: &MediaInfo) -> Result<PreparedSource, AppError> {
    let ins = inspect_from_json(json, path)?;
    let out: FfprobeOutput = serde_json::from_slice(json).map_err(|e| {
        AppError::new(ErrorCode::SourceUnreadable, "This file could not be read").with_detail(format!("ffprobe output: {e}"))
    })?;
    let video = out.streams.iter().find(|s| s.index == ins.video_stream);
    let format = out.format.unwrap_or_default();
    let video_start = video.and_then(|v| parse_f64(&v.start_time)).unwrap_or(0.0);
    let format_start = parse_f64(&format.start_time).unwrap_or(video_start.min(0.0)).min(video_start);
    let audio: Vec<_> = out.streams.iter().filter(|s| s.codec_type.as_deref() == Some("audio")).collect();
    let parse_rate = |v: &Option<String>| v.as_deref().and_then(|s| s.trim().parse::<f64>().ok()).filter(|r| *r > 0.0);
    let duration_s = ins.duration as f64 / 1e6;
    let video_bit_rate = video.and_then(|v| parse_rate(&v.bit_rate)).or_else(|| {
        let audio_rate: f64 = audio.iter().filter_map(|a| parse_rate(&a.bit_rate)).sum();
        let total = parse_rate(&format.bit_rate)
            .or_else(|| parse_rate(&format.size).filter(|_| duration_s > 0.0).map(|size| size * 8.0 / duration_s));
        total.map(|t| (t - audio_rate).max(t * 0.5))
    });
    let audio_layouts = audio
        .iter()
        .map(|a| tag(&a.channel_layout).unwrap_or_else(|| default_layout(a.channels.unwrap_or(2))))
        .collect();
    Ok(PreparedSource {
        path: path.to_path_buf(),
        media: media.clone(),
        video_start,
        format_start,
        video_bit_rate,
        audio_streams: audio.iter().map(|a| a.index).collect(),
        audio_layouts,
        color: OutputColor {
            primaries: video.and_then(|v| tag(&v.color_primaries)),
            transfer: video.and_then(|v| tag(&v.color_transfer)),
            space: video.and_then(|v| tag(&v.color_space)),
            range: video.and_then(|v| tag(&v.color_range)),
        },
        ins,
    })
}

/// Reads a source for the export (one ffprobe run, no packet scan). Errors: `source_missing`,
/// `source_unreadable`, `cancelled`.
pub fn prepare_source(tools: &FfmpegTools, path: &Path, media: &MediaInfo, cancel: &CancelToken) -> Result<PreparedSource, AppError> {
    check_exists(path)?;
    let json = run_ffprobe(tools, &["-print_format", "json", "-show_format", "-show_streams"], path, cancel)?;
    prepared_from_json(&json, path, media)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::media_info;
    use rc_types::Rational;

    #[test]
    fn facts_are_read_from_ffprobe_json() {
        let json = br#"{
          "streams": [
            {"index":0,"codec_type":"video","codec_name":"hevc","width":3840,"height":2160,"pix_fmt":"yuv420p10le","r_frame_rate":"30/1","avg_frame_rate":"30/1","time_base":"1/15360","start_time":"0.000000","duration":"10.0","bit_rate":"20000000",
             "color_primaries":"bt2020","color_transfer":"smpte2084","color_space":"bt2020nc","color_range":"tv"},
            {"index":1,"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2,"channel_layout":"stereo","start_time":"0.0","duration":"10.0","bit_rate":"256000"},
            {"index":2,"codec_type":"data","codec_name":"bin_data"},
            {"index":3,"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":1,"start_time":"0.5","duration":"9.5"}
          ],
          "format": {"format_name":"mov,mp4,m4a,3gp,3g2,mj2","start_time":"0.000000","duration":"10.0","bit_rate":"21000000","size":"26250000"}
        }"#;
        let ins = inspect_from_json(json, Path::new("x.mp4")).unwrap();
        let media = media_info(&ins, Rational { num: 30, den: 1 }, false);
        let p = prepared_from_json(json, Path::new("x.mp4"), &media).unwrap();
        assert_eq!(p.audio_streams, vec![1, 3]);
        assert_eq!(p.audio_layouts, vec!["stereo".to_string(), "mono".to_string()]);
        assert_eq!(p.video_bit_rate, Some(20e6));
        assert_eq!(p.color.args().join(" "), "-color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -color_range tv");
        assert_eq!((p.video_start, p.format_start), (0.0, 0.0));
    }

    #[test]
    fn bit_rate_falls_back_to_the_container() {
        let json = br#"{"streams":[
            {"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"pix_fmt":"yuv420p","r_frame_rate":"30/1","time_base":"1/90000","start_time":"0.1","duration":"10.0","color_primaries":"unknown"},
            {"index":1,"codec_type":"audio","codec_name":"aac","channels":6,"start_time":"0.0","bit_rate":"1000000"}],
          "format":{"format_name":"matroska,webm","start_time":"0.0","duration":"10.1","size":"12625000"}}"#;
        let ins = inspect_from_json(json, Path::new("x.mkv")).unwrap();
        let media = media_info(&ins, Rational { num: 30, den: 1 }, false);
        let p = prepared_from_json(json, Path::new("x.mkv"), &media).unwrap();
        // 12.625 MB over 10.0 s from the first video frame = 10.1 Mb/s, minus 1 Mb/s of audio.
        assert!((p.video_bit_rate.unwrap() - 9.1e6).abs() < 1.0, "{:?}", p.video_bit_rate);
        assert_eq!(p.audio_layouts, vec!["6c".to_string()]);
        assert_eq!(p.color, OutputColor::default());
        assert!((p.video_start - 0.1).abs() < 1e-9);
    }
}
