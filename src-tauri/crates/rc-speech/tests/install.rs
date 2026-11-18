//! Installing the speech packages from a local HTTP server: download with progress, resume
//! after an interrupted transfer, verification by size and SHA-256, unpacking `.tar.bz2` and
//! `.zip` members, cancel, and what counts as installed.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rc_speech::{CancelToken, cpu_package, gpu_package, model_only, Download, DownloadPhase, DownloadProgress, Member, Package, PackageKind, SpeechHome, Unpack};
use rc_types::ErrorCode;
use sha2::{Digest, Sha256};

#[derive(Default)]
struct Behaviour {
    /// Send only this many body bytes on the next request, then drop the connection.
    cut_next_after: Option<usize>,
    /// Answer every request with the whole file, as a server without range support does.
    ignore_range: bool,
}

#[derive(Default)]
struct State {
    files: HashMap<String, Vec<u8>>,
    behaviour: HashMap<String, Behaviour>,
    /// Every request: path and the Range header, if any.
    log: Vec<(String, Option<String>)>,
}

/// A small HTTP/1.1 file server on 127.0.0.1 with byte-range support.
struct Server {
    base: String,
    state: Arc<Mutex<State>>,
}

impl Server {
    fn start() -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(State::default()));
        let st = Arc::clone(&state);
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(conn) = conn else { continue };
                let st = Arc::clone(&st);
                std::thread::spawn(move || serve(conn, &st));
            }
        });
        Server { base, state }
    }

    fn put(&self, path: &str, bytes: Vec<u8>) -> String {
        self.state.lock().unwrap().files.insert(path.to_string(), bytes);
        format!("{}{path}", self.base)
    }

    fn behave(&self, path: &str, b: Behaviour) {
        self.state.lock().unwrap().behaviour.insert(path.to_string(), b);
    }

    fn log(&self) -> Vec<(String, Option<String>)> {
        self.state.lock().unwrap().log.clone()
    }
}

fn serve(conn: TcpStream, state: &Mutex<State>) {
    let mut reader = BufReader::new(conn.try_clone().unwrap());
    let mut first = String::new();
    if reader.read_line(&mut first).is_err() {
        return;
    }
    let path = first.split_whitespace().nth(1).unwrap_or("/").to_string();
    let mut range = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            break;
        }
        if let Some((k, v)) = line.split_once(':')
            && k.eq_ignore_ascii_case("range")
        {
            range = Some(v.trim().to_string());
        }
    }
    let (body, status, extra, cut) = {
        let mut s = state.lock().unwrap();
        s.log.push((path.clone(), range.clone()));
        let Some(file) = s.files.get(&path).cloned() else {
            let mut c = conn;
            let _ = c.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return;
        };
        let b = s.behaviour.entry(path.clone()).or_default();
        let cut = b.cut_next_after.take();
        let from = match (&range, b.ignore_range) {
            (Some(r), false) => r.strip_prefix("bytes=").and_then(|r| r.strip_suffix('-')).and_then(|n| n.parse::<usize>().ok()),
            _ => None,
        };
        match from {
            Some(n) if n >= file.len() => {
                let mut c = conn;
                let _ = c.write_all(
                    format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", file.len())
                        .as_bytes(),
                );
                return;
            }
            Some(n) => {
                let extra = format!("Content-Range: bytes {n}-{}/{}\r\n", file.len() - 1, file.len());
                (file[n..].to_vec(), "206 Partial Content", extra, cut)
            }
            None => (file, "200 OK", String::new(), cut),
        }
    };
    let mut c = conn;
    let head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n", body.len());
    let _ = c.write_all(head.as_bytes());
    let send = cut.unwrap_or(body.len()).min(body.len());
    let _ = c.write_all(&body[..send]);
    let _ = c.flush();
    let _ = c.shutdown(std::net::Shutdown::Both);
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn tmp_home(name: &str) -> (PathBuf, SpeechHome) {
    let dir = std::env::temp_dir().join(format!("rc-speech-install-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    (dir.clone(), SpeechHome::new(dir.join("speech")))
}

/// Deterministic, incompressible-ish content.
fn content(len: usize, seed: u8) -> Vec<u8> {
    let mut x = 0x1234_5678u32 ^ u32::from(seed);
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            (x >> 24) as u8
        })
        .collect()
}

fn tar_bz2(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let enc = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::fast());
    let mut b = tar::Builder::new(enc);
    for (name, data) in entries {
        let mut h = tar::Header::new_gnu();
        h.set_size(data.len() as u64);
        h.set_mode(0o644);
        h.set_cksum();
        b.append_data(&mut h, name, *data).unwrap();
    }
    b.into_inner().unwrap().finish().unwrap()
}

fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, data) in entries {
        w.start_file(*name, opts).unwrap();
        w.write_all(data).unwrap();
    }
    w.finish().unwrap().into_inner()
}

/// A package like the real ones: a runtime archive, a plain file, and a zip of libraries.
fn package(server: &Server) -> (Package, HashMap<&'static str, Vec<u8>>) {
    let dll = content(300_000, 1);
    let tokens = content(5_000, 2);
    let vad = content(700_000, 3);
    let cuda = content(200_000, 4);
    let readme = b"not wanted".to_vec();
    let tar = tar_bz2(&[("pkg/lib/runtime.dll", &dll), ("pkg/README", &readme), ("pkg/model/tokens.txt", &tokens)]);
    let zipped = zip(&[("nv/bin/cuda.dll", &cuda), ("nv/LICENSE", &readme)]);
    let pkg = Package {
        kind: PackageKind::Cpu,
        downloads: vec![
            Download {
                url: server.put("/runtime.tar.bz2", tar.clone()),
                file_name: "runtime.tar.bz2".into(),
                size: tar.len() as u64,
                sha256: sha256(&tar),
                unpack: Unpack::TarBz2 {
                    members: vec![
                        Member { path_in_archive: "pkg/lib/runtime.dll".into(), dest: "runtime/cpu/runtime.dll".into(), size: dll.len() as u64 },
                        Member { path_in_archive: "pkg/model/tokens.txt".into(), dest: "models/m/tokens.txt".into(), size: tokens.len() as u64 },
                    ],
                },
            },
            Download {
                url: server.put("/vad.onnx", vad.clone()),
                file_name: "vad.onnx".into(),
                size: vad.len() as u64,
                sha256: sha256(&vad),
                unpack: Unpack::File { dest: "models/vad.onnx".into() },
            },
            Download {
                url: server.put("/nv.zip", zipped.clone()),
                file_name: "nv.zip".into(),
                size: zipped.len() as u64,
                sha256: sha256(&zipped),
                unpack: Unpack::Zip {
                    members: vec![Member { path_in_archive: "nv/bin/cuda.dll".into(), dest: "runtime/gpu/cuda.dll".into(), size: cuda.len() as u64 }],
                },
            },
        ],
    };
    let expected = HashMap::from([
        ("runtime/cpu/runtime.dll", dll),
        ("models/m/tokens.txt", tokens),
        ("models/vad.onnx", vad),
        ("runtime/gpu/cuda.dll", cuda),
    ]);
    (pkg, expected)
}

fn check_installed(home: &SpeechHome, expected: &HashMap<&'static str, Vec<u8>>) {
    for (rel, bytes) in expected {
        let p = rel.split('/').fold(home.root().to_path_buf(), |p, s| p.join(s));
        assert_eq!(&std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display())), bytes, "{rel}");
    }
    // Only the listed members are unpacked, and no partial files are left.
    assert!(!home.root().join("pkg").exists());
    let downloads: Vec<_> = std::fs::read_dir(home.root().join("downloads")).unwrap().collect();
    assert!(downloads.is_empty(), "{downloads:?}");
}

#[test]
fn installs_with_progress_and_is_then_complete() {
    let server = Server::start();
    let (dir, home) = tmp_home("fresh");
    let (pkg, expected) = package(&server);
    assert!(!home.is_installed(&pkg));
    assert_eq!(home.missing_bytes(&pkg), pkg.total_bytes());
    let mut progress: Vec<DownloadProgress> = Vec::new();
    home.install(&pkg, &CancelToken::new(), |p| progress.push(p)).unwrap();
    assert!(home.is_installed(&pkg));
    assert_eq!(home.missing_bytes(&pkg), 0);
    check_installed(&home, &expected);
    // Progress only grows, ends at the total, and goes through every phase.
    assert!(progress.windows(2).all(|w| w[0].done_bytes <= w[1].done_bytes));
    let last = progress.last().unwrap();
    assert_eq!((last.done_bytes, last.total_bytes), (pkg.total_bytes(), pkg.total_bytes()));
    for phase in [DownloadPhase::Downloading, DownloadPhase::Verifying, DownloadPhase::Unpacking] {
        assert!(progress.iter().any(|p| p.phase == phase), "{phase:?}");
    }
    // A second install has nothing to do.
    let before = server.log().len();
    home.install(&pkg, &CancelToken::new(), |_| {}).unwrap();
    assert_eq!(server.log().len(), before);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn an_interrupted_download_resumes_where_it_stopped() {
    let server = Server::start();
    let (dir, home) = tmp_home("resume");
    let (pkg, expected) = package(&server);
    server.behave("/vad.onnx", Behaviour { cut_next_after: Some(250_000), ..Behaviour::default() });
    let err = home.install(&pkg, &CancelToken::new(), |_| {}).unwrap_err();
    assert_eq!(err.code, ErrorCode::TranscriberFailed);
    assert!(err.message.contains("resumes"), "{err:?}");
    // What arrived is kept, and counts as done.
    let vad_size = pkg.downloads[1].size;
    assert_eq!(home.missing_bytes(&pkg), vad_size - 250_000 + pkg.downloads[2].size);
    home.install(&pkg, &CancelToken::new(), |_| {}).unwrap();
    check_installed(&home, &expected);
    let vad_requests: Vec<Option<String>> =
        server.log().into_iter().filter(|(p, _)| p == "/vad.onnx").map(|(_, r)| r).collect();
    assert_eq!(vad_requests, vec![None, Some("bytes=250000-".to_string())]);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_server_without_ranges_restarts_the_file() {
    let server = Server::start();
    let (dir, home) = tmp_home("norange");
    let (pkg, expected) = package(&server);
    server.behave("/vad.onnx", Behaviour { cut_next_after: Some(100_000), ignore_range: true });
    assert!(home.install(&pkg, &CancelToken::new(), |_| {}).is_err());
    home.install(&pkg, &CancelToken::new(), |_| {}).unwrap();
    check_installed(&home, &expected);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_damaged_download_is_rejected_and_removed() {
    let server = Server::start();
    let (dir, home) = tmp_home("damaged");
    let (mut pkg, _) = package(&server);
    pkg.downloads[1].sha256 = "0".repeat(64);
    let err = home.install(&pkg, &CancelToken::new(), |_| {}).unwrap_err();
    assert_eq!(err.code, ErrorCode::TranscriberFailed);
    assert!(err.detail.unwrap().contains("SHA-256"));
    assert!(!home.root().join("downloads").join("vad.onnx.part").exists());
    assert!(!home.is_installed(&pkg));
    // An archive that lacks a listed member is reported too.
    let (dir2, home) = tmp_home("damaged-member");
    let (mut pkg, _) = package(&server);
    if let Unpack::TarBz2 { members } = &mut pkg.downloads[0].unpack {
        members[0].path_in_archive = "pkg/lib/absent.dll".into();
    }
    let err = home.install(&pkg, &CancelToken::new(), |_| {}).unwrap_err();
    assert!(err.detail.unwrap().contains("absent.dll"));
    // And a member of the wrong size.
    let (dir3, home) = tmp_home("damaged-size");
    let (mut pkg, _) = package(&server);
    if let Unpack::Zip { members } = &mut pkg.downloads[2].unpack {
        members[0].size += 1;
    }
    let err = home.install(&pkg, &CancelToken::new(), |_| {}).unwrap_err();
    assert!(err.detail.unwrap().contains("cuda.dll"));
    for d in [dir, dir2, dir3] {
        let _ = std::fs::remove_dir_all(d);
    }
}

#[test]
fn cancel_stops_the_install_and_keeps_the_partial_file() {
    let server = Server::start();
    let (dir, home) = tmp_home("cancel");
    let (pkg, _) = package(&server);
    let cancel = CancelToken::new();
    let c = cancel.clone();
    let err = home
        .install(&pkg, &cancel, |p| {
            if p.file == "vad.onnx" && p.phase == DownloadPhase::Downloading && p.done_bytes > pkg.downloads[0].size {
                c.cancel();
            }
        })
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);
    let part = home.root().join("downloads").join("vad.onnx.part");
    let kept = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    assert!(kept > 0 && kept < pkg.downloads[1].size, "{kept}");
    // The first download was finished and stays installed.
    assert!(home.root().join("runtime").join("cpu").join("runtime.dll").is_file());
    let _ = std::fs::remove_dir_all(dir);
}

/// The first-run download when the transcriber's folder already holds its runtime: only the
/// model files are fetched, straight into a model folder chosen on its own.
#[test]
fn model_only_install_goes_into_its_own_model_folder() {
    let server = Server::start();
    let (dir, _) = tmp_home("model-only");
    let (pkg, expected) = package(&server);
    let models = model_only(&pkg);
    // The runtime archive and the library zip are left out; the voice detector stays.
    assert_eq!(models.downloads.iter().map(|d| d.file_name.as_str()).collect::<Vec<_>>(), vec!["vad.onnx"]);
    let home = SpeechHome::with_model_dir(dir.join("my-models"));
    assert_eq!(home.model_dir(), dir.join("my-models"));
    assert_eq!(home.vad_model(), dir.join("my-models").join("silero_vad.onnx"));
    assert!(!home.is_installed(&models));
    home.install(&models, &CancelToken::new(), |_| {}).unwrap();
    assert!(home.is_installed(&models));
    assert_eq!(std::fs::read(dir.join("my-models").join("vad.onnx")).unwrap(), expected["models/vad.onnx"]);
    let partials: Vec<_> = std::fs::read_dir(dir.join("my-models").join(".downloads")).unwrap().collect();
    assert!(partials.is_empty(), "{partials:?}");
    assert!(!dir.join("my-models").join("models").exists(), "no nested models folder");
    // The real packages: the processor one keeps the voice detector and the int8 model, the
    // GPU one keeps the five fp32 files.
    let cpu = model_only(&cpu_package());
    assert_eq!(cpu.downloads.len(), 2);
    assert!(cpu.downloads.iter().any(|d| d.file_name == "silero_vad.onnx"));
    assert!(cpu.total_bytes() < cpu_package().total_bytes());
    let gpu = model_only(&gpu_package());
    assert_eq!(gpu.downloads.len(), 5);
    assert!(gpu.downloads.iter().all(|d| d.file_name.starts_with("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-")));
    let _ = std::fs::remove_dir_all(dir);
}
