//! Speech audio and waveform with the real FFmpeg on the generated fixtures.

mod common;

use std::io::Read;
use std::time::Instant;

use common::*;
use rc_media::{
    CancelToken, SpeechAudioRequest, WAVEFORM_VALUES_PER_SECOND, WaveformRequest, in_progress_path, make_waveform, probe,
    speech_samples_for, start_speech_audio, waveform_value_count,
};
use rc_types::{ErrorCode, read_waveform};

fn pcm_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes.as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b) as f32 / 32768.0).collect()
}

fn rms_windows(s: &[f32], win: usize) -> Vec<f64> {
    s.chunks(win).map(|c| (c.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>() / c.len() as f64).sqrt()).collect()
}

fn correlation(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len().min(b.len());
    let (a, b) = (&a[..n], &b[..n]);
    let ma = a.iter().sum::<f64>() / n as f64;
    let mb = b.iter().sum::<f64>() / n as f64;
    let cov: f64 = a.iter().zip(b).map(|(x, y)| (x - ma) * (y - mb)).sum();
    let va: f64 = a.iter().map(|x| (x - ma).powi(2)).sum();
    let vb: f64 = b.iter().map(|y| (y - mb).powi(2)).sum();
    cov / (va * vb).sqrt()
}

#[test]
fn speech_stream_matches_the_duration_and_the_reference_signal() {
    let tools = tools();
    let src = fixture("speech-2min");
    let media = probe(&tools, &src, &CancelToken::new()).unwrap();
    let dir = scratch("speech-stream");
    let wav = dir.join("audio").join("speech.wav");
    let req = SpeechAudioRequest { save_to: Some(&wav), ..SpeechAudioRequest::new(&src, &media) };
    let mut stream = start_speech_audio(&tools, &req, &CancelToken::new()).unwrap();
    let expected = stream.expected_bytes();
    assert_eq!(expected, speech_samples_for(media.duration) * 2);

    // Read in small pieces, as the transcriber client does, watching progress rise.
    let mut pcm = Vec::new();
    let mut buf = [0u8; 3200];
    let mut fractions = Vec::new();
    loop {
        let n = stream.read(&mut buf).unwrap();
        if n == 0 {
            break;
        }
        pcm.extend_from_slice(&buf[..n]);
        fractions.push(stream.progress().fraction);
    }
    let summary = stream.finish().unwrap();
    assert!(fractions.first().unwrap() < &0.1 && (fractions.last().unwrap() - 1.0).abs() < 1e-9);
    assert_eq!(summary.samples as usize, pcm.len() / 2);
    let samples = pcm.len() as i64 / 2;
    let want = speech_samples_for(media.duration) as i64;
    assert!((samples - want).abs() <= 16000 / 30, "{samples} samples, expected {want} (127.6 s at 16 kHz)");

    // The saved WAV holds the same bytes behind a 44-byte header.
    assert_eq!(summary.saved_to.as_deref(), Some(wav.as_path()));
    let file = std::fs::read(&wav).unwrap();
    assert_eq!(&file[..4], b"RIFF");
    assert_eq!(u32::from_le_bytes(file[40..44].try_into().unwrap()) as usize, pcm.len());
    assert_eq!(&file[44..], &pcm[..]);
    assert!(!in_progress_path(&wav).exists());

    // Same timing as the fixture's exact 16 kHz signal: loudness per 50 ms correlates.
    let reference = std::fs::read(root().join("fixtures/out/speech-2min.wav")).unwrap();
    let data = reference.windows(4).position(|w| w == b"data").unwrap() + 8;
    let ref_s = pcm_to_f32(&reference[data..]);
    let got = pcm_to_f32(&pcm);
    let c = correlation(&rms_windows(&got, 800), &rms_windows(&ref_s, 800));
    assert!(c > 0.9, "loudness correlation with the reference {c}");
    // And shifted by 100 ms it correlates clearly worse, so the alignment is real.
    let shifted = correlation(&rms_windows(&got[1600..], 800), &rms_windows(&ref_s, 800));
    assert!(shifted < c - 0.1, "aligned {c}, shifted {shifted}");
}

#[test]
fn speech_stream_uses_the_chosen_track() {
    let tools = tools();
    let src = fixture("numbered-3audio");
    let media = probe(&tools, &src, &CancelToken::new()).unwrap();
    assert_eq!(media.speech_track, 1);
    let mut stream = start_speech_audio(&tools, &SpeechAudioRequest::new(&src, &media), &CancelToken::new()).unwrap();
    let mut pcm = Vec::new();
    stream.read_to_end(&mut pcm).unwrap();
    stream.finish().unwrap();
    let s = pcm_to_f32(&pcm);
    assert_eq!(s.len() as u64, speech_samples_for(media.duration));
    // The lav mic carries 500 Hz beeps: 2 zero crossings per cycle → about 80 in 80 ms.
    let beep = &s[16000 + 160..16000 + 1440];
    let crossings = beep.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
    assert!((70..=90).contains(&crossings), "{crossings} crossings: not the 500 Hz track");
    // Beeps start on whole seconds, silence between.
    for k in [1usize, 15, 29] {
        let onset = (k * 16000 - 800..k * 16000 + 800).find(|&i| s[i].abs() > 0.05).unwrap();
        assert!((onset as i64 - (k * 16000) as i64).abs() <= 32, "beep {k} at sample {onset}");
    }
    assert!(s[16000 * 5 + 4000..16000 * 5 + 12000].iter().all(|x| x.abs() < 0.01));
}

#[test]
fn speech_stream_cancel_stops_and_removes_the_partial_file() {
    let tools = tools();
    let src = fixture("speech-2min");
    let media = probe(&tools, &src, &CancelToken::new()).unwrap();
    let dir = scratch("speech-cancel");
    let wav = dir.join("speech.wav");
    let cancel = CancelToken::new();
    let req = SpeechAudioRequest { save_to: Some(&wav), ..SpeechAudioRequest::new(&src, &media) };
    let mut stream = start_speech_audio(&tools, &req, &cancel).unwrap();
    let mut buf = vec![0u8; 32000];
    stream.read_exact(&mut buf).unwrap();
    cancel.cancel();
    // Reading on ends with an error once FFmpeg is killed.
    let mut total = 0usize;
    let ended_with_error = loop {
        match stream.read(&mut buf) {
            Ok(0) => break false,
            Ok(n) => total += n,
            Err(_) => break true,
        }
    };
    assert!(ended_with_error, "read reports the cancel");
    assert!((total as u64) < stream.expected_bytes(), "stopped early");
    assert_eq!(stream.finish().unwrap_err().code, ErrorCode::Cancelled);
    assert!(!wav.exists() && !in_progress_path(&wav).exists());
}

#[test]
fn dropping_a_stream_cleans_up() {
    let tools = tools();
    let src = fixture("speech-2min");
    let media = probe(&tools, &src, &CancelToken::new()).unwrap();
    let dir = scratch("speech-drop");
    let wav = dir.join("speech.wav");
    let req = SpeechAudioRequest { save_to: Some(&wav), ..SpeechAudioRequest::new(&src, &media) };
    let mut stream = start_speech_audio(&tools, &req, &CancelToken::new()).unwrap();
    let mut buf = vec![0u8; 3200];
    stream.read_exact(&mut buf).unwrap();
    drop(stream);
    assert!(!wav.exists() && !in_progress_path(&wav).exists());
}

#[test]
fn waveform_shows_the_beeps_at_whole_seconds() {
    let tools = tools();
    let src = fixture("numbered-4k-h264");
    let media = probe(&tools, &src, &CancelToken::new()).unwrap();
    let dir = scratch("waveform");
    let out = dir.join("waveform.bin");
    let id = "fixture-4k".to_string();
    let mut reports = Vec::new();
    let header = make_waveform(&tools, &WaveformRequest::new(&src, &media, &id, &out), &CancelToken::new(), &mut |p| reports.push(p))
        .unwrap();
    assert_eq!(reports.last().unwrap().fraction, 1.0);
    let (h, values) = read_waveform(&std::fs::read(&out).unwrap()).unwrap();
    assert_eq!(h, header);
    assert_eq!(h.source_id, "fixture-4k");
    assert_eq!(h.values_per_second, WAVEFORM_VALUES_PER_SECOND);
    assert_eq!(h.count, waveform_value_count(media.duration));
    assert_eq!(values.len(), 7200);
    let vps = WAVEFORM_VALUES_PER_SECOND as usize;
    for k in 0..30 {
        let start = k * vps;
        // The beep: amplitude 0.5 → about 128, for 100 ms = 24 values from the whole second.
        let first_loud = (start.saturating_sub(4)..start + vps).find(|&i| values[i] > 40).unwrap();
        assert!(first_loud.abs_diff(start) <= 1, "second {k}: beep starts at value {first_loud}, expected {start}");
        let peak = *values[start..start + 24].iter().max().unwrap();
        assert!((110..=150).contains(&peak), "second {k}: peak {peak}");
        let loud = values[start..start + vps].iter().filter(|&&v| v > 40).count();
        assert!((22..=27).contains(&loud), "second {k}: {loud} loud values (24 expected)");
        // Silence for the rest of the second.
        assert!(values[start + 30..start + vps - 2].iter().all(|&v| v <= 2), "second {k} is not silent after the beep");
    }
}

#[test]
fn waveform_of_silence_is_flat() {
    let tools = tools();
    let src = fixture("silence-only");
    let media = probe(&tools, &src, &CancelToken::new()).unwrap();
    let dir = scratch("waveform-silence");
    let out = dir.join("w.bin");
    let id = "s".to_string();
    let h = make_waveform(&tools, &WaveformRequest::new(&src, &media, &id, &out), &CancelToken::new(), &mut |_| {}).unwrap();
    let (_, values) = read_waveform(&std::fs::read(&out).unwrap()).unwrap();
    assert_eq!(h.count, 20 * WAVEFORM_VALUES_PER_SECOND as u64);
    assert!(values.iter().all(|&v| v == 0));
}

#[test]
fn waveform_cancel_before_start_leaves_no_file() {
    let tools = tools();
    let src = fixture("speech-2min");
    let media = probe(&tools, &src, &CancelToken::new()).unwrap();
    let dir = scratch("waveform-cancel-early");
    let out = dir.join("w.bin");
    let id = "s".to_string();
    let cancel = CancelToken::new();
    cancel.cancel();
    let err = make_waveform(&tools, &WaveformRequest::new(&src, &media, &id, &out), &cancel, &mut |_| {}).unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);
    assert!(!out.exists() && !in_progress_path(&out).exists());
}

#[test]
fn waveform_cancel_mid_run_kills_ffmpeg_and_leaves_no_file() {
    let tools = tools();
    // The 2-minute fixture decodes in a few hundred milliseconds, too fast to land a cancel
    // reliably; 40 minutes of it, stream-copied (no re-encode), takes a couple of seconds.
    let dir = scratch("waveform-cancel");
    let src = dir.join("speech-40min.mp4");
    ffmpeg(
        &tools,
        &["-stream_loop", "19", "-i", &fixture("speech-2min").to_string_lossy(), "-c", "copy", &src.to_string_lossy()],
    );
    let media = probe(&tools, &src, &CancelToken::new()).unwrap();
    assert!(media.duration > 2_000_000_000, "{}", media.duration);
    let out = dir.join("w.bin");
    let id = "s".to_string();
    let cancel = CancelToken::new();
    let c2 = cancel.clone();
    let mut cancelled_at: Option<(Instant, f64)> = None;
    let mut last_fraction = 0.0;
    let res = make_waveform(&tools, &WaveformRequest::new(&src, &media, &id, &out), &cancel, &mut |p| {
        last_fraction = p.fraction;
        if p.fraction > 0.1 && p.fraction < 0.9 && cancelled_at.is_none() {
            cancelled_at = Some((Instant::now(), p.fraction));
            c2.cancel();
        }
    });
    let (at, fraction) = cancelled_at.expect("a progress report between 10 % and 90 % while FFmpeg was running");
    assert_eq!(res.unwrap_err().code, ErrorCode::Cancelled);
    assert!(at.elapsed().as_secs_f64() < 2.0, "stopped {} s after the cancel", at.elapsed().as_secs_f64());
    assert!(last_fraction < 1.0, "cancelled at {fraction}, yet the task reported completion");
    assert!(!out.exists() && !in_progress_path(&out).exists());
}

/// With `in_place` the waveform goes straight to the given (in-progress) path, without a
/// `.part` of its own; renaming is the caller's job (the cache's `finish`).
#[test]
fn in_place_waveform_writes_the_given_path() {
    let tools = tools();
    let src = fixture("speech-2min");
    let media = probe(&tools, &src, &CancelToken::new()).unwrap();
    let dir = scratch("waveform-in-place");
    let out = dir.join("waveform.partial.bin");
    let id = "s".to_string();
    let req = WaveformRequest { in_place: true, ..WaveformRequest::new(&src, &media, &id, &out) };
    let h = make_waveform(&tools, &req, &CancelToken::new(), &mut |_| {}).unwrap();
    assert!(!in_progress_path(&out).exists());
    let (head, values) = read_waveform(&std::fs::read(&out).unwrap()).unwrap();
    assert_eq!(head, h);
    assert_eq!(values.len() as u64, h.count);
    assert!(values.iter().any(|&v| v > 0), "the speech is audible");
}
