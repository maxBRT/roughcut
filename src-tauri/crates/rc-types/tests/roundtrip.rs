//! Serde round trips, and checks that the JSON matches the TypeScript notation of spec 3.4.

use rc_types::*;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

fn roundtrip<T: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug>(value: &T) -> Value {
    let text = serde_json::to_string_pretty(value).unwrap();
    let back: T = serde_json::from_str(&text).unwrap();
    assert_eq!(&back, value, "round trip changed the value; JSON was:\n{text}");
    serde_json::to_value(value).unwrap()
}

fn sample_project() -> Project {
    let clip = Clip { id: "c1".into(), source_id: "s1".into(), start: 0, end: 3_600_000_000 };
    let state = EditState {
        clips: vec![clip.clone()],
        dismissed: vec![SourceRange { source_id: "s1".into(), start: 1_000, end: 2_000 }],
    };
    Project {
        schema_version: PROJECT_SCHEMA_VERSION,
        id: "p1".into(),
        name: "Episode 12".into(),
        created_at: "2026-11-13T10:00:00Z".into(),
        updated_at: "2026-11-13T11:00:00Z".into(),
        frame_rate: Rational { num: 30000, den: 1001 },
        sources: vec![SourceRef {
            id: "s1".into(),
            path: "D:\\footage\\take1.mp4".into(),
            added_at: "2026-11-13T10:00:00Z".into(),
            media: MediaInfo {
                duration: 3_600_000_000,
                container: "mov,mp4,m4a,3gp,3g2,mj2".into(),
                video: VideoInfo {
                    codec: "hevc".into(),
                    width: 3840,
                    height: 2160,
                    frame_rate: Rational { num: 30000, den: 1001 },
                    variable_frame_rate: false,
                    bit_depth: BitDepth::Ten,
                    hdr: true,
                },
                audio_tracks: vec![
                    AudioTrackInfo { index: 0, codec: "aac".into(), channels: 2, sample_rate: 48000, title: None },
                    AudioTrackInfo {
                        index: 1,
                        codec: "aac".into(),
                        channels: 1,
                        sample_rate: 48000,
                        title: Some("Mic".into()),
                    },
                ],
                speech_track: 1,
                direct_playable: true,
            },
        }],
        edit: EditDocument { current: state.clone(), undo: vec![EditState::default()], redo: vec![] },
        session: SessionState {
            view: SessionView::Timeline,
            playhead: Some(SourcePosition { source_id: "s1".into(), at: 42 }),
            playback_rate: PlaybackRate::X1_5,
            cut_text_hidden: true,
        },
        last_export: Some(ExportResult {
            path: "C:\\out\\ep12.mp4".into(),
            duration: 2_460_000_000,
            bytes: 9_876_543_210,
            took_seconds: 512.5,
            finished_at: "2026-11-13T12:00:00Z".into(),
        }),
    }
}

#[test]
fn project_roundtrip_and_shape() {
    let mut p = sample_project();
    let v = roundtrip(&p);
    assert_eq!(v["schemaVersion"], 1);
    assert_eq!(v["frameRate"], json!({ "num": 30000, "den": 1001 }));
    assert_eq!(v["sources"][0]["addedAt"], "2026-11-13T10:00:00Z");
    assert_eq!(v["sources"][0]["media"]["video"]["bitDepth"], 10);
    assert_eq!(v["sources"][0]["media"]["video"]["variableFrameRate"], false);
    assert_eq!(v["sources"][0]["media"]["audioTracks"][1]["sampleRate"], 48000);
    assert!(v["sources"][0]["media"]["audioTracks"][0].get("title").is_none(), "absent optional is omitted");
    assert_eq!(v["sources"][0]["media"]["speechTrack"], 1);
    assert_eq!(v["sources"][0]["media"]["directPlayable"], true);
    assert_eq!(v["edit"]["current"]["clips"][0], json!({ "id": "c1", "sourceId": "s1", "start": 0, "end": 3_600_000_000i64 }));
    assert_eq!(v["session"]["view"], "timeline");
    assert_eq!(v["session"]["playbackRate"], 1.5);
    assert_eq!(v["session"]["cutTextHidden"], true);
    assert_eq!(v["session"]["playhead"], json!({ "sourceId": "s1", "at": 42 }));
    assert_eq!(v["lastExport"]["tookSeconds"], 512.5);
    assert_eq!(v["lastExport"]["bytes"], 9_876_543_210u64);

    // `lastExport?` is omitted when absent; `playhead: ... | null` is written as null.
    p.last_export = None;
    p.session.playhead = None;
    p.session.playback_rate = PlaybackRate::X2;
    let v = roundtrip(&p);
    assert!(v.get("lastExport").is_none());
    assert_eq!(v["session"]["playhead"], Value::Null);
    assert_eq!(v["session"]["playbackRate"], 2);
    assert_eq!(serde_json::to_string(&PlaybackRate::X1).unwrap(), "1");

    // Values written by the interface (JS numbers) are read back.
    let rate: PlaybackRate = serde_json::from_str("1.0").unwrap();
    assert_eq!(rate, PlaybackRate::X1);
    assert!(serde_json::from_str::<PlaybackRate>("3").is_err());
    assert!(serde_json::from_str::<BitDepth>("12").is_err());
}

#[test]
fn transcript_roundtrip_and_token_tags() {
    let t = Transcript {
        schema_version: TRANSCRIPT_SCHEMA_VERSION,
        source_id: "s1".into(),
        model: "parakeet-tdt-0.6b-v2".into(),
        complete: false,
        utterances: vec![Utterance {
            index: 0,
            start: 100,
            end: 2_000_000,
            tokens: vec![
                Token::Word(WordToken { start: 100, end: 400_000, cut_before: 50, text: "Hello".into() }),
                Token::Pause(PauseToken { start: 400_000, end: 1_600_000, cut_before: 400_000 }),
                Token::Unrecognised(UnrecognisedToken { start: 1_600_000, end: 2_000_000, cut_before: 1_600_000 }),
            ],
        }],
    };
    let v = roundtrip(&t);
    assert_eq!(v["sourceId"], "s1");
    assert_eq!(v["complete"], false);
    let tokens = &v["utterances"][0]["tokens"];
    assert_eq!(tokens[0], json!({ "kind": "word", "start": 100, "end": 400_000, "cutBefore": 50, "text": "Hello" }));
    assert_eq!(tokens[1], json!({ "kind": "pause", "start": 400_000, "end": 1_600_000, "cutBefore": 400_000 }));
    assert_eq!(tokens[2]["kind"], "unrecognised");
    assert_eq!(t.utterances[0].tokens[1].base(), TokenBase { start: 400_000, end: 1_600_000, cut_before: 400_000 });
}

#[test]
fn suggestion_set_roundtrip_and_shape() {
    let s = SuggestionSet {
        schema_version: SUGGESTION_SET_SCHEMA_VERSION,
        source_id: "s1".into(),
        claude_model: Some("opus".into()),
        suggestions: vec![
            Suggestion {
                id: "g1".into(),
                kind: SuggestionKind::Retake,
                origin: SuggestionOrigin::Claude,
                range: SourceRange { source_id: "s1".into(), start: 10, end: 20 },
                reason: "Said again at 0:42, cleaner".into(),
                kept_version_at: Some(42_000_000),
            },
            Suggestion {
                id: "g2".into(),
                kind: SuggestionKind::FalseStart,
                origin: SuggestionOrigin::Claude,
                range: SourceRange { source_id: "s1".into(), start: 30, end: 40 },
                reason: "Abandoned sentence".into(),
                kept_version_at: None,
            },
            Suggestion {
                id: "g3".into(),
                kind: SuggestionKind::DeadAir,
                origin: SuggestionOrigin::Local,
                range: SourceRange { source_id: "s1".into(), start: 50, end: 60 },
                reason: "4 s of silence".into(),
                kept_version_at: None,
            },
        ],
    };
    let v = roundtrip(&s);
    assert_eq!(v["claudeModel"], "opus");
    assert_eq!(v["suggestions"][0]["kind"], "retake");
    assert_eq!(v["suggestions"][0]["keptVersionAt"], 42_000_000);
    assert_eq!(v["suggestions"][1]["kind"], "false_start");
    assert!(v["suggestions"][1].get("keptVersionAt").is_none());
    assert_eq!(v["suggestions"][2]["kind"], "dead_air");
    assert_eq!(v["suggestions"][2]["origin"], "local");

    let dead_air_only = SuggestionSet { claude_model: None, ..s };
    let v = roundtrip(&dead_air_only);
    assert!(v.get("claudeModel").is_none());
}

#[test]
fn settings_roundtrip_and_shape() {
    let s = Settings {
        schema_version: SETTINGS_SCHEMA_VERSION,
        export_folder: "C:\\Users\\me\\Videos".into(),
        key_bindings: vec![KeyBinding {
            action: "timeline.split".into(),
            context: KeyContext::Timeline,
            chord: "Ctrl+B".into(),
        }],
        speech_model: "parakeet-tdt-0.6b-v2".into(),
        speech_device: SpeechDevice::Auto,
        claude_model: "opus".into(),
        claude_auth: ClaudeAuth::ApiKey,
        claude_code_version_tested: "2.1.323".into(),
        cache_limit_bytes: 50 * 1024 * 1024 * 1024,
    };
    let v = roundtrip(&s);
    assert_eq!(v["exportFolder"], "C:\\Users\\me\\Videos");
    assert_eq!(v["keyBindings"][0], json!({ "action": "timeline.split", "context": "timeline", "chord": "Ctrl+B" }));
    assert_eq!(v["speechDevice"], "auto");
    assert_eq!(v["claudeAuth"], "api_key");
    assert_eq!(v["claudeCodeVersionTested"], "2.1.323");
    assert_eq!(v["cacheLimitBytes"], 53_687_091_200u64);
}

#[test]
fn runtime_unions_use_spec_strings() {
    let status = JobStatus {
        id: "j1".into(),
        kind: JobKind::Transcribe,
        source_id: Some("s1".into()),
        project_id: None,
        state: JobState::Failed,
        progress: 0.5,
        seconds_left: None,
        error: Some(AppError::new(ErrorCode::ClaudeSignedOut, "Not signed in").with_detail("auth status")),
    };
    let v = roundtrip(&status);
    assert_eq!(v["kind"], "transcribe");
    assert_eq!(v["state"], "failed");
    assert_eq!(v["error"]["code"], "claude_signed_out");
    assert!(v.get("projectId").is_none());

    let assets = SourceAssets {
        source_id: "s1".into(),
        online: true,
        playback: PlaybackSource::Proxy,
        playback_url: None,
        waveform_url: Some("http://127.0.0.1:1/media/s1/waveform".into()),
        transcript: TranscriptProgress::Partial,
        suggestions: SuggestionsProgress::Unavailable,
    };
    let v = roundtrip(&assets);
    assert_eq!(v["playback"], "proxy");
    assert_eq!(v["playbackUrl"], Value::Null);
    assert_eq!(v["transcript"], "partial");
    assert_eq!(v["suggestions"], "unavailable");

    let fmt = OutputFormat {
        codec: OutputCodec::Hevc,
        width: 3840,
        height: 2160,
        frame_rate: Rational { num: 30, den: 1 },
        bit_depth: BitDepth::Eight,
        hdr: false,
        audio_tracks: 3,
    };
    let v = roundtrip(&fmt);
    assert_eq!(v["codec"], "hevc");
    assert_eq!(v["bitDepth"], 8);
    assert_eq!(serde_json::to_value(OutputCodec::H264).unwrap(), "h264");

    for code in [ErrorCode::SourceMismatch, ErrorCode::NothingToExport, ErrorCode::ClaudeBadAnswer, ErrorCode::Internal] {
        assert_eq!(serde_json::to_value(code).unwrap(), code.as_str());
    }
}

#[test]
fn event_names_and_payloads() {
    assert_eq!(
        ALL_EVENTS,
        [
            "job_updated",
            "source_assets_changed",
            "transcript_appended",
            "transcript_completed",
            "suggestions_ready",
            "suggestions_unavailable",
            "export_finished",
        ]
    );
    let p = SuggestionsUnavailablePayload {
        source_id: "s1".into(),
        error: AppError::new(ErrorCode::ClaudeLimit, "Usage limit reached"),
    };
    let v = roundtrip(&p);
    assert_eq!(v, json!({ "sourceId": "s1", "error": { "code": "claude_limit", "message": "Usage limit reached" } }));
    let v = roundtrip(&TranscriptCompletedPayload { source_id: "s1".into() });
    assert_eq!(v, json!({ "sourceId": "s1" }));
}

#[test]
fn generated_typescript_is_current_and_has_no_bigint() {
    let ts = rc_types::ts_export::typescript();
    assert!(!ts.contains("bigint"), "Micros and byte counts must be `number` in TypeScript");
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../src/types/generated.ts");
    let on_disk = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
    assert!(on_disk == ts, "src/types/generated.ts is out of date: run `npm run gen:types`");
}

#[test]
fn generated_token_types_carry_their_kind_as_in_the_spec() {
    let ts = rc_types::ts_export::typescript();
    for line in [
        "export type Token = WordToken | PauseToken | UnrecognisedToken;",
        "export type WordToken = TokenBase & { kind: \"word\"; text: string };",
        "export type PauseToken = TokenBase & { kind: \"pause\" };",
        "export type UnrecognisedToken = TokenBase & { kind: \"unrecognised\" };",
        "export type MediaItem = \"proxy\" | \"original\" | \"waveform\";",
    ] {
        assert!(ts.lines().any(|l| l == line), "generated.ts lacks the line: {line}");
    }
    // Each declared exactly once.
    for name in ["Token", "WordToken", "PauseToken", "UnrecognisedToken", "TokenBase"] {
        let decl = format!("export type {name} =");
        assert_eq!(ts.matches(&decl).count(), 1, "{decl}");
    }
}
