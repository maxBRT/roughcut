//! Spike transcriber: 16 kHz mono s16le PCM on stdin -> JSON lines on stdout (spec 3.5.7).
//!
//! Usage:
//!   transcriber-spike --model-dir <dir> [--device gpu|cpu] [--vad <silero_vad.onnx>]
//!                     [--threads N] [--batch N] [--pad-ms N] [--vad-threshold F]
//!                     [--min-silence F] [--min-speech F] [--max-speech F] [--raw]
//!
//! Messages: ready, segment, speech_without_words, progress, done, error.
//! Extra fields beyond the spec (timing stats, raw tokens) exist only for the spike.

use serde_json::json;
use sherpa_onnx::{
    OfflineRecognizer, OfflineRecognizerConfig, OfflineStream, OfflineTransducerModelConfig,
    SileroVadModelConfig, VadModelConfig, VoiceActivityDetector,
};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

const SR: usize = 16000;
const WINDOW: usize = 512; // Silero VAD window at 16 kHz

struct Args {
    model_dir: PathBuf,
    device: String,
    vad: PathBuf,
    threads: i32,
    batch: usize,
    pad_ms: usize,
    vad_threshold: f32,
    min_silence: f32,
    min_speech: f32,
    max_speech: f32,
    raw: bool,
    debug: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args {
        model_dir: PathBuf::new(),
        device: "cpu".into(),
        vad: PathBuf::new(),
        threads: 8,
        batch: 1,
        pad_ms: 250,
        vad_threshold: 0.5,
        min_silence: 0.5,
        min_speech: 0.25,
        max_speech: 20.0,
        raw: false,
        debug: false,
    };
    let v: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < v.len() {
        let k = v[i].as_str();
        let mut val = || -> Result<String, String> {
            i += 1;
            v.get(i).cloned().ok_or(format!("missing value for {k}"))
        };
        match k {
            "--model-dir" => a.model_dir = val()?.into(),
            "--device" => a.device = val()?,
            "--vad" => a.vad = val()?.into(),
            "--threads" => a.threads = val()?.parse().map_err(|e| format!("{e}"))?,
            "--batch" => a.batch = val()?.parse().map_err(|e| format!("{e}"))?,
            "--pad-ms" => a.pad_ms = val()?.parse().map_err(|e| format!("{e}"))?,
            "--vad-threshold" => a.vad_threshold = val()?.parse().map_err(|e| format!("{e}"))?,
            "--min-silence" => a.min_silence = val()?.parse().map_err(|e| format!("{e}"))?,
            "--min-speech" => a.min_speech = val()?.parse().map_err(|e| format!("{e}"))?,
            "--max-speech" => a.max_speech = val()?.parse().map_err(|e| format!("{e}"))?,
            "--raw" => a.raw = true,
            "--debug" => a.debug = true,
            _ => return Err(format!("unknown argument {k}")),
        }
        i += 1;
    }
    if a.model_dir.as_os_str().is_empty() {
        return Err("--model-dir is required".into());
    }
    if a.vad.as_os_str().is_empty() {
        a.vad = a.model_dir.join("..").join("silero_vad.onnx");
    }
    Ok(a)
}

fn emit(v: serde_json::Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn fail(code: &str, msg: &str) -> ! {
    emit(json!({"type": "error", "code": code, "message": msg}));
    std::process::exit(1);
}

/// Picks encoder/decoder/joiner in a model folder: prefers fp32/fp16 names for GPU,
/// int8 for CPU, but takes whatever exists.
fn find_model_file(dir: &Path, stem: &str, prefer_int8: bool) -> Option<String> {
    let mut cands = vec![
        format!("{stem}.int8.onnx"),
        format!("{stem}.onnx"),
        format!("{stem}.fp16.onnx"),
    ];
    if !prefer_int8 {
        cands.rotate_left(1);
    }
    cands
        .into_iter()
        .map(|n| dir.join(n))
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
}

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryW(name: *const u16) -> *mut std::ffi::c_void;
}

/// Checks that the CUDA execution provider and its NVIDIA libraries can be loaded.
/// Returns the first library that failed.
fn cuda_preflight() -> Result<(), String> {
    for dll in [
        "cudart64_12.dll",
        "cublasLt64_12.dll",
        "cublas64_12.dll",
        "cudnn64_9.dll",
        "onnxruntime_providers_shared.dll",
        // Not onnxruntime_providers_cuda.dll: loading it outside onnxruntime fails in its
        // DLL initialisation (WinError 1114) because onnxruntime has not set the provider host.
    ] {
        let w: Vec<u16> = dll.encode_utf16().chain(std::iter::once(0)).collect();
        let h = unsafe { LoadLibraryW(w.as_ptr()) };
        if h.is_null() {
            return Err(format!("{dll} could not be loaded"));
        }
    }
    Ok(())
}

struct Word {
    text: String,
    start: f64,
    end: f64,
}

/// Groups SentencePiece tokens into words. A token starting with a space opens a word;
/// other tokens (sub-words, punctuation) extend the current one. End = token start + TDT duration.
fn tokens_to_words(tokens: &[String], ts: &[f32], dur: &[f32], offset: f64) -> Vec<Word> {
    let mut words: Vec<Word> = Vec::new();
    for (i, t) in tokens.iter().enumerate() {
        let s = offset + ts.get(i).copied().unwrap_or(0.0) as f64;
        let e = s + dur.get(i).copied().unwrap_or(0.0) as f64;
        let starts_word = t.starts_with(' ') || t.starts_with('\u{2581}') || words.is_empty();
        let clean = t.trim_start_matches(' ').trim_start_matches('\u{2581}');
        if starts_word {
            words.push(Word { text: clean.to_string(), start: s, end: e.max(s) });
        } else if let Some(w) = words.last_mut() {
            w.text.push_str(clean);
            if e > w.end {
                w.end = e;
            }
        }
    }
    words.retain(|w| !w.text.is_empty());
    words
}

struct Pending {
    vad_start: usize, // samples, absolute
    vad_end: usize,
    dec_start: usize, // padded window actually decoded
    stream: OfflineStream,
}

fn main() {
    let t0 = Instant::now();
    let args = parse_args().unwrap_or_else(|e| fail("bad_arguments", &e));

    // Device selection with explicit fallback.
    let mut device = args.device.clone();
    let mut fallback_reason: Option<String> = None;
    if device == "gpu" {
        if let Err(e) = cuda_preflight() {
            fallback_reason = Some(e);
            device = "cpu".into();
        }
    }
    let provider = if device == "gpu" { "cuda" } else { "cpu" };

    let prefer_int8 = device == "cpu";
    let enc = find_model_file(&args.model_dir, "encoder", prefer_int8);
    let dec = find_model_file(&args.model_dir, "decoder", prefer_int8);
    let joi = find_model_file(&args.model_dir, "joiner", prefer_int8);
    let tokens = args.model_dir.join("tokens.txt");
    if enc.is_none() || dec.is_none() || joi.is_none() || !tokens.exists() {
        fail("model_missing", &format!("model files not found in {}", args.model_dir.display()));
    }

    let mut config = OfflineRecognizerConfig::default();
    config.model_config.transducer = OfflineTransducerModelConfig {
        encoder: enc.clone(),
        decoder: dec.clone(),
        joiner: joi.clone(),
    };
    config.model_config.tokens = Some(tokens.to_string_lossy().into_owned());
    config.model_config.model_type = Some("nemo_transducer".into());
    config.model_config.num_threads = args.threads;
    config.model_config.provider = Some(provider.into());
    config.model_config.debug = args.debug;
    config.decoding_method = Some("greedy_search".into());

    let t_load = Instant::now();
    let recognizer = OfflineRecognizer::create(&config)
        .unwrap_or_else(|| fail("model_load_failed", "OfflineRecognizer::create returned null"));
    let load_secs = t_load.elapsed().as_secs_f64();

    let vad_config = VadModelConfig {
        silero_vad: SileroVadModelConfig {
            model: Some(args.vad.to_string_lossy().into_owned()),
            threshold: args.vad_threshold,
            min_silence_duration: args.min_silence,
            min_speech_duration: args.min_speech,
            window_size: WINDOW as i32,
            max_speech_duration: args.max_speech,
        },
        sample_rate: SR as i32,
        num_threads: 1,
        provider: Some("cpu".into()),
        ..Default::default()
    };
    let vad = VoiceActivityDetector::create(&vad_config, 60.0)
        .unwrap_or_else(|| fail("vad_load_failed", "VoiceActivityDetector::create returned null"));

    emit(json!({
        "type": "ready",
        "model": args.model_dir.file_name().map(|s| s.to_string_lossy().into_owned()),
        "encoder": enc.as_ref().and_then(|p| Path::new(p).file_name().map(|s| s.to_string_lossy().into_owned())),
        "device": device,
        "requested_device": args.device,
        "fallback_reason": fallback_reason,
        "load_seconds": load_secs,
    }));

    // Audio buffer: keeps samples from `buf_origin` onward so padded windows can be cut.
    let mut buf: Vec<f32> = Vec::new();
    let mut buf_origin: usize = 0;
    let mut consumed: usize = 0; // samples fed to VAD
    let mut fed_to_vad: usize = 0;
    let mut pending: Vec<Pending> = Vec::new();
    let mut speech_ranges: Vec<(f64, f64)> = Vec::new();
    let mut decode_secs = 0.0f64;
    let mut vad_secs = 0.0f64;
    let mut n_segments = 0usize;
    let mut last_progress = 0usize;
    let pad = args.pad_ms * SR / 1000;

    let mut stdin = std::io::stdin().lock();
    let mut raw = vec![0u8; 32768];
    let mut carry: Vec<u8> = Vec::new();
    let mut eof = false;

    let decode_pending = |pending: &mut Vec<Pending>, decode_secs: &mut f64, n_segments: &mut usize| {
        if pending.is_empty() {
            return;
        }
        let td = Instant::now();
        if pending.len() == 1 {
            recognizer.decode(&pending[0].stream);
        } else {
            let refs: Vec<&OfflineStream> = pending.iter().map(|p| &p.stream).collect();
            recognizer.decode_multiple_streams(&refs);
        }
        *decode_secs += td.elapsed().as_secs_f64();
        for p in pending.drain(..) {
            *n_segments += 1;
            let start = p.vad_start as f64 / SR as f64;
            let end = p.vad_end as f64 / SR as f64;
            let r = p.stream.get_result();
            let (toks, ts, du) = match &r {
                Some(r) => (
                    r.tokens.clone(),
                    r.timestamps.clone().unwrap_or_default(),
                    r.durations.clone().unwrap_or_default(),
                ),
                None => (vec![], vec![], vec![]),
            };
            let offset = p.dec_start as f64 / SR as f64;
            let words = tokens_to_words(&toks, &ts, &du, offset);
            if words.is_empty() {
                emit(json!({"type": "speech_without_words", "start": start, "end": end}));
            } else {
                let mut msg = json!({
                    "type": "segment",
                    "start": start,
                    "end": end,
                    "text": r.as_ref().map(|r| r.text.trim().to_string()),
                    "words": words.iter().map(|w| json!({"text": w.text, "start": (w.start*1000.0).round()/1000.0, "end": (w.end*1000.0).round()/1000.0})).collect::<Vec<_>>(),
                });
                if args.raw {
                    msg["tokens"] = json!(toks);
                    msg["token_starts"] = json!(ts.iter().map(|t| *t as f64 + offset).collect::<Vec<_>>());
                    msg["token_durations"] = json!(du);
                }
                emit(msg);
            }
        }
    };

    loop {
        if !eof {
            match stdin.read(&mut raw) {
                Ok(0) => eof = true,
                Ok(n) => {
                    carry.extend_from_slice(&raw[..n]);
                    let whole = carry.len() / 2 * 2;
                    for c in carry[..whole].chunks_exact(2) {
                        buf.push(i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0);
                    }
                    carry.drain(..whole);
                    consumed = buf_origin + buf.len();
                }
                Err(e) => fail("stdin_read_failed", &e.to_string()),
            }
        }
        // Feed whole VAD windows.
        let tv = Instant::now();
        while fed_to_vad + WINDOW <= consumed {
            let a = fed_to_vad - buf_origin;
            vad.accept_waveform(&buf[a..a + WINDOW]);
            fed_to_vad += WINDOW;
        }
        vad_secs += tv.elapsed().as_secs_f64();
        if eof {
            if fed_to_vad < consumed {
                let a = fed_to_vad - buf_origin;
                vad.accept_waveform(&buf[a..]);
                fed_to_vad = consumed;
            }
            vad.flush();
        }
        while let Some(seg) = vad.front() {
            let vs = seg.start() as usize;
            let ve = vs + seg.n() as usize;
            vad.pop();
            speech_ranges.push((vs as f64 / SR as f64, ve as f64 / SR as f64));
            // Padded window, clamped to what we still hold and to the audio read so far.
            let ds = vs.saturating_sub(pad).max(buf_origin);
            let de = (ve + pad).min(consumed);
            let stream = recognizer.create_stream();
            stream.accept_waveform(SR as i32, &buf[ds - buf_origin..de - buf_origin]);
            pending.push(Pending { vad_start: vs, vad_end: ve, dec_start: ds, stream });
            if pending.len() >= args.batch {
                decode_pending(&mut pending, &mut decode_secs, &mut n_segments);
            }
        }
        // Drop audio that can no longer be part of a padded window (keep 30 s + pad behind VAD).
        let keep_from = fed_to_vad.saturating_sub(30 * SR + pad);
        if keep_from > buf_origin + 10 * SR {
            buf.drain(..keep_from - buf_origin);
            buf_origin = keep_from;
        }
        if consumed >= last_progress + 30 * SR {
            last_progress = consumed;
            emit(json!({"type": "progress", "seconds": consumed as f64 / SR as f64}));
        }
        if eof {
            break;
        }
    }
    decode_pending(&mut pending, &mut decode_secs, &mut n_segments);

    let audio_secs = consumed as f64 / SR as f64;
    let wall = t0.elapsed().as_secs_f64();
    emit(json!({
        "type": "done",
        "speech": speech_ranges.iter().map(|(s, e)| json!({"start": s, "end": e})).collect::<Vec<_>>(),
        "stats": {
            "audio_seconds": audio_secs,
            "wall_seconds": wall,
            "model_load_seconds": load_secs,
            "decode_seconds": decode_secs,
            "vad_seconds": vad_secs,
            "segments": n_segments,
            "speed_x_realtime_wall": audio_secs / wall,
            "speed_x_realtime_excluding_load": audio_secs / (wall - load_secs),
        }
    }));
}
