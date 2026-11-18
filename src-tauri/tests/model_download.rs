//! First run: a transcription needs a speech model that is not there, so the core starts the
//! model download as a job the interface sees (`job_updated`, kind `model_download`), waits
//! for it, then transcribes. The "model" here is served by a local HTTP server and is what
//! rc-speech's stand-in transcriber reads (its `standin.json` and a recorded protocol file),
//! so the transcription after the download really depends on the downloaded files.

mod common;

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::Arc;

use common::*;
use rc_jobs::JobEvent;
use rc_speech::{Download, Package, PackageKind, Unpack};
use rc_types::{JobKind, JobState};
use roughcut_lib::AppCore;
use sha2::{Digest, Sha256};

/// Serves `files` (path -> bytes) over HTTP/1.1 on 127.0.0.1 until the process ends.
fn serve(files: Vec<(&'static str, Vec<u8>)>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let files = Arc::new(files);
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(conn) = conn else { continue };
            let files = Arc::clone(&files);
            std::thread::spawn(move || {
                let mut reader = BufReader::new(conn.try_clone().unwrap());
                let mut first = String::new();
                if reader.read_line(&mut first).is_err() {
                    return;
                }
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                let path = first.split_whitespace().nth(1).unwrap_or("/").to_string();
                let mut c = conn;
                match files.iter().find(|(p, _)| *p == path) {
                    Some((_, body)) => {
                        let _ = c.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes());
                        let _ = c.write_all(body);
                    }
                    None => {
                        let _ = c.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    }
                }
            });
        }
    });
    base
}

fn download(base: &str, path: &'static str, bytes: &[u8], dest: &str) -> Download {
    Download {
        url: format!("{base}{path}"),
        file_name: path.trim_start_matches('/').to_string(),
        size: bytes.len() as u64,
        sha256: Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect(),
        unpack: Unpack::File { dest: dest.into() },
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_missing_model_is_downloaded_as_a_job_before_the_first_transcription() {
    let _g = serial();
    let dir = Scratch::new("model-download");
    // The transcriber folder holds the stand-in as transcriber.exe; the model folder is empty.
    let tdir = dir.path().join("transcriber");
    std::fs::create_dir_all(&tdir).unwrap();
    std::fs::copy(standin_transcriber(), tdir.join("transcriber.exe")).unwrap();
    let model_dir = dir.path().join("models");

    let recording =
        std::fs::read(root().join("src-tauri/crates/rc-speech/tests/data/speech-2min.v2-int8.cpu.jsonl")).unwrap();
    let standin = br#"{"scenario":"replay","recording":"speech.jsonl"}"#.to_vec();
    // Like rc-speech's real processor package, it carries the voice detector the core passes as
    // `--vad-model` (the stand-in refuses to start without that file).
    let vad = b"stand-in voice detector".to_vec();
    let base = serve(vec![
        ("/standin.json", standin.clone()),
        ("/speech.jsonl", recording.clone()),
        ("/silero_vad.onnx", vad.clone()),
    ]);
    let package = Package {
        kind: PackageKind::Cpu,
        downloads: vec![
            download(&base, "/standin.json", &standin, "models/standin.json"),
            download(&base, "/speech.jsonl", &recording, "models/speech.jsonl"),
            download(&base, "/silero_vad.onnx", &vad, "models/silero_vad.onnx"),
        ],
    };
    // The real package does the same.
    assert!(
        rc_speech::model_only(&rc_speech::cpu_package())
            .downloads
            .iter()
            .any(|d| matches!(&d.unpack, Unpack::File { dest } if dest == "models/silero_vad.onnx")),
        "the processor package installs the voice detector the core passes to the transcriber"
    );

    let mut config = config(dir.path());
    config.transcriber_dir = tdir;
    config.model_dir = model_dir.clone();
    config.model_packages = Some(vec![(package, true)]);
    let sink = Collect::new();
    let core = AppCore::start(config, sink.clone(), tokio::runtime::Handle::current()).unwrap();
    assert!(!core.speech_model_ready());

    let project = core.create_project(vec![fixture("speech-2min").display().to_string()]).await.unwrap();
    let id = project.sources[0].id.clone();
    let s = id.clone();
    wait_for(&sink, "transcript complete", 300, move |e| matches!(e, JobEvent::TranscriptCompleted(p) if p.source_id == s)).await;

    let ev = sink.all();
    let pos = |pred: &dyn Fn(&JobEvent) -> bool| ev.iter().position(pred);
    let model_status = |state: JobState| {
        move |e: &JobEvent| matches!(e, JobEvent::JobUpdated(j) if j.kind == JobKind::ModelDownload && j.state == state)
    };
    let queued = pos(&model_status(JobState::Queued)).expect("the download is a job");
    let done = pos(&model_status(JobState::Done)).expect("the download finished");
    let first_batch = pos(&|e| matches!(e, JobEvent::TranscriptAppended(p) if p.source_id == id)).expect("a transcript arrived");
    assert!(queued < done && done < first_batch, "the transcript comes after the download");
    let JobEvent::JobUpdated(finished) = &ev[done] else { unreachable!() };
    assert_eq!(finished.progress, 1.0);
    assert!(finished.source_id.is_none() && finished.project_id.is_none());
    assert_eq!(sink.count(&model_status(JobState::Queued)), 1, "downloaded once");
    assert!(core.list_jobs().await.unwrap().iter().any(|j| j.kind == JobKind::ModelDownload && j.state == JobState::Done));

    // The files are in the model folder, and the model now counts as installed.
    assert_eq!(std::fs::read(model_dir.join("speech.jsonl")).unwrap(), recording);
    assert!(Path::new(&model_dir.join("standin.json")).is_file());
    assert_eq!(std::fs::read(model_dir.join("silero_vad.onnx")).unwrap(), vad);
    assert!(core.speech_model_ready());
    let t = core.get_transcript(id.clone()).await.unwrap();
    assert!(t.complete && t.utterances.len() > 5);
    assert_eq!(t.model, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");

    core.shutdown().await;
    assert_no_workers(5);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_model_download_fails_the_transcription_with_its_reason() {
    let _g = serial();
    let dir = Scratch::new("model-download-fail");
    let tdir = dir.path().join("transcriber");
    std::fs::create_dir_all(&tdir).unwrap();
    std::fs::copy(standin_transcriber(), tdir.join("transcriber.exe")).unwrap();
    // The server does not have the file: 404.
    let base = serve(vec![]);
    let package = Package { kind: PackageKind::Cpu, downloads: vec![download(&base, "/gone.json", b"{}", "models/standin.json")] };
    let mut config = config(dir.path());
    config.transcriber_dir = tdir;
    config.model_dir = dir.path().join("models");
    config.model_packages = Some(vec![(package, true)]);
    let sink = Collect::new();
    let core = AppCore::start(config, sink.clone(), tokio::runtime::Handle::current()).unwrap();
    let project = core.create_project(vec![fixture("speech-2min").display().to_string()]).await.unwrap();
    let id = project.sources[0].id.clone();
    let s = id.clone();
    let failed = wait_for(&sink, "the transcription failing", 120, move |e| {
        matches!(e, JobEvent::JobUpdated(j) if j.kind == JobKind::Transcribe && j.source_id.as_deref() == Some(s.as_str()) && j.state == JobState::Failed)
    })
    .await;
    let JobEvent::JobUpdated(j) = failed else { unreachable!() };
    let model_job = sink
        .all()
        .into_iter()
        .find_map(|e| match e {
            JobEvent::JobUpdated(m) if m.kind == JobKind::ModelDownload && m.state == JobState::Failed => Some(m),
            _ => None,
        })
        .expect("the download job failed");
    assert_eq!(j.error, model_job.error, "the transcription reports why the download failed");
    assert_eq!(j.error.unwrap().code, rc_types::ErrorCode::TranscriberFailed);
    assert!(!core.speech_model_ready());
    core.shutdown().await;
    assert_no_workers(5);
}

/// Without the transcriber program a transcription cannot run, so no model download starts for
/// it (it would fetch half a gigabyte only to fail afterwards): the transcription fails at once
/// with `transcriber_failed`, naming where the program was looked for.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_model_download_starts_when_the_transcriber_is_missing() {
    let _g = serial();
    let dir = Scratch::new("model-download-no-program");
    let base = serve(vec![("/standin.json", b"{}".to_vec())]);
    let package = Package { kind: PackageKind::Cpu, downloads: vec![download(&base, "/standin.json", b"{}", "models/standin.json")] };
    let mut config = config(dir.path());
    config.transcriber_dir = dir.path().join("no-transcriber-here");
    config.model_dir = dir.path().join("models");
    config.model_packages = Some(vec![(package, true)]);
    let sink = Collect::new();
    let core = AppCore::start(config, sink.clone(), tokio::runtime::Handle::current()).unwrap();
    let project = core.create_project(vec![fixture("speech-2min").display().to_string()]).await.unwrap();
    let s = project.sources[0].id.clone();
    let failed = wait_for(&sink, "the transcription failing", 120, move |e| {
        matches!(e, JobEvent::JobUpdated(j) if j.kind == JobKind::Transcribe && j.source_id.as_deref() == Some(s.as_str()) && j.state == JobState::Failed)
    })
    .await;
    let JobEvent::JobUpdated(j) = failed else { unreachable!() };
    let err = j.error.expect("an error");
    assert_eq!(err.code, rc_types::ErrorCode::TranscriberFailed);
    assert!(err.detail.as_deref().is_some_and(|d| d.contains("no-transcriber-here")), "{err:?}");
    assert_eq!(sink.count(|e| matches!(e, JobEvent::JobUpdated(m) if m.kind == JobKind::ModelDownload)), 0, "no download job");
    assert!(!dir.path().join("models").join("standin.json").exists());
    core.shutdown().await;
    assert_no_workers(5);
}
