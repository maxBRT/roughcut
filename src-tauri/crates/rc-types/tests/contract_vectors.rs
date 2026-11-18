//! The shared contract vectors (`testdata/contract_vectors.json`), which `src/types/contract.test.ts`
//! checks against the TypeScript twins too: frame grid, first clip end, media addresses, waveform layout.

use rc_types::*;
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("../testdata/contract_vectors.json")).unwrap()
}

fn rate(v: &Value) -> Rational {
    Rational { num: v["num"].as_u64().unwrap() as u32, den: v["den"].as_u64().unwrap() as u32 }
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

#[test]
fn frame_grid_matches_vectors() {
    let v = vectors();
    let grid = &v["frameGrid"];
    let mut n = 0;
    for c in grid["frameToMicros"].as_array().unwrap() {
        let r = rate(&c["rate"]);
        assert_eq!(frame_to_micros(c["frame"].as_i64().unwrap(), r), c["micros"].as_i64().unwrap(), "{c}");
        n += 1;
    }
    for c in grid["times"].as_array().unwrap() {
        let r = rate(&c["rate"]);
        let t = c["t"].as_i64().unwrap();
        assert_eq!(micros_to_frame_floor(t, r), c["frameFloor"].as_i64().unwrap(), "frameFloor {c}");
        assert_eq!(floor_to_frame(t, r), c["floor"].as_i64().unwrap(), "floor {c}");
        assert_eq!(ceil_to_frame(t, r), c["ceil"].as_i64().unwrap(), "ceil {c}");
        assert_eq!(snap_to_frame(t, r), c["snap"].as_i64().unwrap(), "snap {c}");
        assert_eq!(is_on_frame_grid(t, r), c["onGrid"].as_bool().unwrap(), "onGrid {c}");
        n += 1;
    }
    for c in v["firstClipEnd"].as_array().unwrap() {
        let r = rate(&c["rate"]);
        assert_eq!(first_clip_end(c["duration"].as_i64().unwrap(), r), c["end"].as_i64(), "{c}");
    }
    assert!(n > 100);
}

#[test]
fn media_urls_match_vectors() {
    for c in vectors()["mediaUrl"].as_array().unwrap() {
        let item: MediaItem = serde_json::from_value(c["item"].clone()).unwrap();
        assert_eq!(MediaItem::parse(c["item"].as_str().unwrap()), Some(item));
        let url = media_url(
            c["base"].as_str().unwrap(),
            c["token"].as_str().unwrap(),
            c["sourceId"].as_str().unwrap(),
            item,
        );
        assert_eq!(url, c["url"].as_str().unwrap());
    }
    assert_eq!(MEDIA_TOKEN_PARAM, "token");
}

#[test]
fn waveform_layout_matches_fixture() {
    let v = vectors();
    let w = &v["waveform"];
    let header: WaveformHeader = serde_json::from_value(w["header"].clone()).unwrap();
    let values: Vec<u8> = w["values"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect();
    let bytes = write_waveform(&header, &values).unwrap();
    assert_eq!(bytes, hex(w["hex"].as_str().unwrap()), "writer must produce the fixture bytes exactly");
    assert_eq!(read_waveform(&bytes).unwrap(), (header.clone(), values.clone()));
    for bad in w["bad"].as_array().unwrap() {
        assert!(read_waveform(&hex(bad["hex"].as_str().unwrap())).is_err(), "{}", bad["why"]);
    }
    let short = WaveformHeader { count: 4, ..header };
    assert!(matches!(write_waveform(&short, &values), Err(WaveformError::CountMismatch { .. })));
    assert_eq!(WAVEFORM_CONTENT_TYPE, "application/octet-stream");
}
