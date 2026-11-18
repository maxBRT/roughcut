//! Spec 3.7, `media`: "Probe reads each fixture correctly", with the real ffprobe on the
//! generated fixtures (fixtures/out, described by its manifest).

mod common;

use common::*;
use rc_media::{CancelToken, probe};
use rc_types::{BitDepth, ErrorCode, Rational};

#[test]
fn probe_reads_every_fixture_like_the_manifest() {
    let tools = tools();
    let m = manifest();
    let fixtures = m["fixtures"].as_object().unwrap();
    assert!(fixtures.len() >= 7, "manifest lists {} fixtures", fixtures.len());
    for (name, f) in fixtures {
        let path = root().join(f["path"].as_str().unwrap());
        let info = probe(&tools, &path, &CancelToken::new()).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let v = &f["video"];
        let ctx = |what: &str| format!("{name}: {what}: {info:#?}");

        assert_eq!(info.video.codec, v["codec"].as_str().unwrap(), "{}", ctx("codec"));
        assert_eq!(info.video.width as u64, v["width"].as_u64().unwrap(), "{}", ctx("width"));
        assert_eq!(info.video.height as u64, v["height"].as_u64().unwrap(), "{}", ctx("height"));
        let (n, d) = v["frameRate"].as_str().unwrap().split_once('/').unwrap();
        assert_eq!(info.video.frame_rate, Rational { num: n.parse().unwrap(), den: d.parse().unwrap() }, "{}", ctx("frame rate"));
        assert_eq!(info.video.variable_frame_rate, v["frameRateMode"] == "vfr", "{}", ctx("variable frame rate"));
        let bits = if info.video.bit_depth == BitDepth::Ten { 10 } else { 8 };
        assert_eq!(bits, v["bitDepth"].as_u64().unwrap(), "{}", ctx("bit depth"));
        assert_eq!(info.video.hdr, !v["hdr"].is_null(), "{}", ctx("hdr"));

        // Duration: the nominal length, within one frame.
        let frame_us = 1_000_000 * info.video.frame_rate.den as i64 / info.video.frame_rate.num as i64;
        let want = f["durationUs"].as_i64().unwrap();
        assert!((info.duration - want).abs() <= frame_us, "{}", ctx(&format!("duration, want {want}")));
        assert_eq!(info.container, "mp4", "{}", ctx("container"));

        let tracks = f["audioTracks"].as_array().unwrap();
        assert_eq!(info.audio_tracks.len(), tracks.len(), "{}", ctx("audio track count"));
        for (got, want) in info.audio_tracks.iter().zip(tracks) {
            assert_eq!(got.index as u64, want["index"].as_u64().unwrap());
            assert_eq!(got.codec, want["codec"].as_str().unwrap());
            assert_eq!(got.channels as u64, want["channels"].as_u64().unwrap());
            assert_eq!(got.sample_rate as u64, want["sampleRate"].as_u64().unwrap());
            assert_eq!(got.title.as_deref(), want["title"].as_str(), "{}", ctx("track title"));
        }
        let speech = if name == "numbered-3audio" { 1 } else { 0 };
        assert_eq!(info.speech_track, speech, "{}", ctx("speech track"));
        // All fixtures are MP4 with H.264 or HEVC and AAC: playable before the proxy exists.
        assert!(info.direct_playable, "{}", ctx("direct playable"));
    }
}

#[test]
fn the_three_audio_track_fixture_picks_the_lav_mic() {
    let info = probe(&tools(), &fixture("numbered-3audio"), &CancelToken::new()).unwrap();
    let titles: Vec<_> = info.audio_tracks.iter().map(|t| t.title.clone().unwrap_or_default()).collect();
    assert_eq!(titles, ["Main mix (1000 Hz)", "Lav mic (500 Hz)", "Camera mic (2000 Hz)"]);
    assert_eq!(info.speech_track, 1);
}

#[test]
fn hdr_and_vfr_fixtures_are_recognised() {
    let tools = tools();
    let hdr = probe(&tools, &fixture("numbered-4k-hevc10-hdr"), &CancelToken::new()).unwrap();
    assert!(hdr.video.hdr);
    assert_eq!(hdr.video.bit_depth, BitDepth::Ten);
    assert_eq!(hdr.video.codec, "hevc");
    let vfr = probe(&tools, &fixture("numbered-vfr"), &CancelToken::new()).unwrap();
    assert!(vfr.video.variable_frame_rate);
    assert_eq!(vfr.video.frame_rate, Rational { num: 30, den: 1 });
    let cfr = probe(&tools, &fixture("numbered-4k-h264"), &CancelToken::new()).unwrap();
    assert!(!cfr.video.variable_frame_rate);
}

#[test]
fn missing_and_unreadable_files_give_the_right_errors() {
    let tools = tools();
    let missing = probe(&tools, &root().join("fixtures/out/no-such-file.mp4"), &CancelToken::new()).unwrap_err();
    assert_eq!(missing.code, ErrorCode::SourceMissing);
    let dir = scratch("probe-garbage");
    let junk = dir.join("junk.mp4");
    std::fs::write(&junk, b"this is not a video file at all").unwrap();
    let bad = probe(&tools, &junk, &CancelToken::new()).unwrap_err();
    assert_eq!(bad.code, ErrorCode::SourceUnreadable);
    assert!(bad.detail.is_some(), "ffprobe's error output is kept");
    // A WAV file has no picture.
    let wav = probe(&tools, &root().join("fixtures/out/speech-2min.wav"), &CancelToken::new()).unwrap_err();
    assert_eq!(wav.code, ErrorCode::SourceUnreadable);
}

#[test]
fn rotation_shape_and_start_offset_are_read() {
    let tools = tools();
    let dir = scratch("probe-odd");
    let src = make_odd_source(&tools, &dir);
    let info = probe(&tools, &src, &CancelToken::new()).unwrap();
    // 640×480 stored, rotated a quarter turn: shown 480×640.
    assert_eq!((info.video.width, info.video.height), (480, 640));
    // Video starts 0.5 s after the audio; the audio runs to 3.5 s: 3 s from the first frame.
    assert!((info.duration - 3_000_000).abs() <= 50_000, "duration {}", info.duration);
    assert!(!info.video.variable_frame_rate);
}
