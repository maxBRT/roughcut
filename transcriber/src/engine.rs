//! Loading the recognizer and the voice detector, and the streaming pipeline:
//! standard input -> voice detector (own thread) -> recognizer -> protocol lines.
//!
//! The reader thread decodes PCM, runs the Silero voice detector, and as soon as the detector
//! closes a stretch of speech it cuts that stretch (padded by 250 ms of the original audio on
//! each side, split if very long) and queues it. The decoding thread transcribes queued
//! stretches in order and writes each `segment` line at once. The queue is bounded, so a slow
//! decoder slows reading instead of growing memory, and the reader keeps only the last ~30 s of
//! audio.

use crate::audio::{AudioWindow, PcmDecoder, SAMPLE_RATE, samples_to_micros};
use crate::cli::{Args, DeviceRequest};
use crate::model::{self, Variant, VariantError};
use crate::protocol::{Device, ErrorCode, Message, Micros, Output, Range};
use crate::split::{SplitRule, split_points};
use crate::words::{tidy_words, tokens_to_words};
use sherpa_onnx::{
    OfflineRecognizer, OfflineRecognizerConfig, OfflineStream, OfflineTransducerModelConfig,
    SileroVadModelConfig, VadModelConfig, VoiceActivityDetector,
};
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TryRecvError, sync_channel};
use std::time::Instant;

/// A fatal problem: the code and message of the `error` line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub code: ErrorCode,
    pub message: String,
}

impl Failure {
    fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Failure { code, message: message.into() }
    }
}

/// Voice-detector settings (speech experiment 4.4: threshold 0.3 and minimum speech 0.1 s keep
/// soft leading fillers; 0.5 s of silence closes a stretch; stretches are cut near 20 s).
#[derive(Debug, Clone, Copy)]
pub struct VadSettings {
    pub threshold: f32,
    pub min_silence_secs: f32,
    pub min_speech_secs: f32,
    pub max_speech_secs: f32,
}

impl VadSettings {
    /// The settings the transcriber ships with.
    pub const DEFAULT: VadSettings =
        VadSettings { threshold: 0.3, min_silence_secs: 0.5, min_speech_secs: 0.1, max_speech_secs: 20.0 };
}

/// Silero window at 16 kHz.
const VAD_WINDOW: usize = 512;
/// Original audio added before and after each detected stretch before decoding.
const PAD_SAMPLES: u64 = SAMPLE_RATE as u64 / 4;
/// Audio kept behind the detector's read position, for cutting padded stretches.
const RETAIN_SAMPLES: u64 = 30 * SAMPLE_RATE as u64 + PAD_SAMPLES;
/// Silence past a stretch's end padding after which no later stretch can start inside that
/// padding (the detector dates a stretch's start at most a window plus the minimum speech
/// length before it first hears it; 0.5 s covers that with room to spare).
const RELEASE_MARGIN: u64 = SAMPLE_RATE as u64 / 2;
/// Stretches waiting for the decoder before reading pauses.
const QUEUE_DEPTH: usize = 8;
/// Bytes read from standard input at a time (~1 s of audio).
const READ_CHUNK: usize = 32 * 1024;

/// A loaded recognizer and how it runs.
pub struct Loaded {
    pub recognizer: OfflineRecognizer,
    pub vad_config: VadModelConfig,
    pub device: Device,
    pub fallback: bool,
    pub model_name: String,
    /// Stretches decoded together (GPU only; 1 on the processor).
    pub batch: usize,
}

impl Loaded {
    /// The `ready` message for this load.
    pub fn ready_message(&self) -> Message {
        Message::Ready { model: self.model_name.clone(), device: self.device, fallback: self.fallback }
    }
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn create_recognizer(v: &Variant, provider: &str, threads: i32) -> Option<OfflineRecognizer> {
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.transducer = OfflineTransducerModelConfig {
        encoder: Some(path_str(&v.encoder)),
        decoder: Some(path_str(&v.decoder)),
        joiner: Some(path_str(&v.joiner)),
    };
    config.model_config.tokens = Some(path_str(&v.tokens));
    config.model_config.model_type = Some("nemo_transducer".into());
    config.model_config.num_threads = threads;
    config.model_config.provider = Some(provider.into());
    config.decoding_method = Some("greedy_search".into());
    OfflineRecognizer::create(&config)
}

/// The voice-detector configuration for `vad_model`.
pub fn vad_config(vad_model: &Path, s: VadSettings) -> VadModelConfig {
    VadModelConfig {
        silero_vad: SileroVadModelConfig {
            model: Some(path_str(vad_model)),
            threshold: s.threshold,
            min_silence_duration: s.min_silence_secs,
            min_speech_duration: s.min_speech_secs,
            window_size: VAD_WINDOW as i32,
            max_speech_duration: s.max_speech_secs,
        },
        sample_rate: SAMPLE_RATE as i32,
        num_threads: 1,
        provider: Some("cpu".into()),
        ..Default::default()
    }
}

fn create_vad(config: &VadModelConfig) -> Option<VoiceActivityDetector> {
    VoiceActivityDetector::create(config, 60.0)
}

/// Finds the model files, chooses the processor and loads everything. Diagnostics go to
/// standard error; the result says which device is used and whether that is a fallback.
pub fn load(args: &Args) -> Result<Loaded, Failure> {
    if !args.model_dir.is_dir() {
        return Err(Failure::new(
            ErrorCode::ModelMissing,
            format!("model folder not found: {}", args.model_dir.display()),
        ));
    }
    let vad_path = args.vad_model.clone().unwrap_or_else(|| model::default_vad_path(&args.model_dir));
    if !vad_path.is_file() {
        return Err(Failure::new(
            ErrorCode::ModelMissing,
            format!("voice detector model not found: {}", vad_path.display()),
        ));
    }
    let vad_config = vad_config(&vad_path, VadSettings::DEFAULT);
    if create_vad(&vad_config).is_none() {
        return Err(Failure::new(
            ErrorCode::ModelLoadFailed,
            format!("voice detector model could not be loaded: {}", vad_path.display()),
        ));
    }

    let (fp32, int8) = model::find_variants(&args.model_dir, &args.family);
    for (label, v) in [("fp32", &fp32), ("int8", &int8)] {
        if let Err(e) = v {
            if *e != VariantError::NoFolder {
                eprintln!("transcriber: {label} model not usable: {}", e.reason());
            }
        }
    }
    if fp32.is_err() && int8.is_err() {
        let broken = [&fp32, &int8].into_iter().find_map(|v| match v {
            Err(VariantError::Broken(r)) => Some(r.clone()),
            _ => None,
        });
        return Err(match broken {
            Some(reason) => Failure::new(ErrorCode::ModelLoadFailed, format!("the model is damaged: {reason}")),
            None => Failure::new(
                ErrorCode::ModelMissing,
                format!(
                    "no complete model \"{}\" (fp32) or \"{}-int8\" in {}",
                    args.family,
                    args.family,
                    args.model_dir.display()
                ),
            ),
        });
    }

    let want_gpu = args.device != DeviceRequest::Cpu;
    let mut gpu_attempted = false;
    let mut gpu_load_failed = false;
    if want_gpu {
        let reason = match (&fp32, model::cuda_preflight()) {
            (Err(e), _) => format!("no usable fp32 model \"{}\" for the GPU: {}", args.family, e.reason()),
            (Ok(_), Err(e)) => e,
            (Ok(v), Ok(())) => {
                gpu_attempted = true;
                eprintln!("transcriber: loading {} on the GPU", v.name);
                match create_recognizer(v, "cuda", args.threads.unwrap_or(4)) {
                    Some(r) if model::cuda_provider_active() => {
                        return Ok(Loaded {
                            recognizer: r,
                            vad_config,
                            device: Device::Gpu,
                            fallback: false,
                            model_name: v.display_name(),
                            batch: args.batch.unwrap_or(4),
                        });
                    }
                    // The recognizer is dropped here: it would run the fp32 model on the
                    // processor, far slower than int8.
                    Some(_) => "onnxruntime did not start its CUDA provider (it fell back to the processor)".to_string(),
                    None => {
                        gpu_load_failed = true;
                        "the fp32 model failed to load on the GPU".to_string()
                    }
                }
            }
        };
        eprintln!("transcriber: GPU not used: {reason}");
    }

    let cpu_variant = int8.as_ref().or(fp32.as_ref()).map_err(|_| {
        // Only reachable when int8 is unusable and fp32 exists but failed above.
        Failure::new(ErrorCode::ModelLoadFailed, "the model failed to load")
    })?;
    eprintln!("transcriber: loading {} on the processor", cpu_variant.name);
    let recognizer = create_recognizer(cpu_variant, "cpu", args.threads.unwrap_or(8)).ok_or_else(|| {
        let mut msg = format!("model files could not be loaded from {}", cpu_variant.encoder.parent().unwrap_or(Path::new("")).display());
        if gpu_load_failed {
            msg.push_str(" (the GPU model failed to load too)");
        }
        Failure::new(ErrorCode::ModelLoadFailed, msg)
    })?;
    // An fp32 model whose files are all there counts as installed, even when it is damaged.
    let fp32_installed = matches!(fp32, Ok(_) | Err(VariantError::Broken(_)));
    let fallback = match args.device {
        DeviceRequest::Cpu => false,
        DeviceRequest::Gpu => true,
        // Auto: a fallback when the GPU was selected (its runtime and the fp32 model are both
        // installed) but could not be used; a processor-only installation is not a fallback.
        DeviceRequest::Auto => gpu_attempted || (fp32_installed && model::gpu_runtime_installed()),
    };
    Ok(Loaded {
        recognizer,
        vad_config,
        device: Device::Cpu,
        fallback,
        model_name: cpu_variant.display_name(),
        batch: 1,
    })
}

/// One stretch of audio queued for the decoder.
struct Piece {
    /// The stretch itself, absolute samples `[start, end)`.
    start: u64,
    end: u64,
    /// Absolute sample index of `samples[0]`.
    dec_start: u64,
    samples: Vec<f32>,
}

enum Job {
    Piece(Piece),
    End { speech: Vec<(u64, u64)> },
    Failed(String),
}

/// A detected stretch of speech whose decode window starts at `ds` (absolute samples).
struct Held {
    vs: u64,
    ve: u64,
    ds: u64,
    /// The detector's own copy, when the stretch is older than the window (sent unpadded).
    own: Option<Vec<f32>>,
}

/// Splits a stretch if it is very long and queues its pieces, decoding `[ds, de)` overall:
/// padding only at the stretch's outer edges, not at internal cuts. False when the decoder
/// has stopped.
fn send_stretch(tx: &SyncSender<Job>, window: &AudioWindow, p: Held, de: u64) -> bool {
    let Held { vs, ve, ds, own } = p;
    let audio: &[f32] = match &own {
        Some(s) => s,
        None => window.slice(vs, ve),
    };
    let mut edges = vec![vs];
    edges.extend(split_points(audio, SplitRule::DEFAULT).into_iter().map(|c| vs + c as u64));
    edges.push(ve);
    let last = edges.len() - 2;
    for (i, w) in edges.windows(2).enumerate() {
        let (a, b) = (w[0], w[1]);
        let piece = match &own {
            Some(s) => Piece { start: a, end: b, dec_start: a, samples: s[(a - vs) as usize..(b - vs) as usize].to_vec() },
            None => {
                let s = if i == 0 { ds.min(a) } else { a };
                let e = if i == last { de.max(b) } else { b };
                Piece { start: a, end: b, dec_start: s.max(window.origin()), samples: window.slice(s, e).to_vec() }
            }
        };
        if tx.send(Job::Piece(piece)).is_err() {
            return false;
        }
    }
    true
}

/// Reads standard input, runs the voice detector and queues stretches until end of input.
fn reader_thread(
    mut input: impl Read,
    vad: VoiceActivityDetector,
    tx: SyncSender<Job>,
    consumed: Arc<AtomicU64>,
    out: Arc<Output>,
) {
    let mut pcm = PcmDecoder::default();
    let mut window = AudioWindow::default();
    let mut fed: u64 = 0;
    let mut speech: Vec<(u64, u64)> = Vec::new();
    let mut raw = vec![0u8; READ_CHUNK];
    let mut decoded: Vec<f32> = Vec::with_capacity(READ_CHUNK / 2 + 1);
    // The latest stretch, waiting until its end padding is known.
    let mut held: Option<Held> = None;
    // End (absolute sample) of the last decode window sent.
    let mut prev_de: u64 = 0;
    loop {
        let eof = match input.read(&mut raw) {
            Ok(0) => true,
            Ok(n) => {
                decoded.clear();
                pcm.push(&raw[..n], &mut decoded);
                window.extend(&decoded);
                false
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => true,
            Err(e) => {
                let _ = tx.send(Job::Failed(format!("reading standard input failed: {e}")));
                return;
            }
        };
        consumed.store(window.end(), Ordering::Relaxed);
        while fed + VAD_WINDOW as u64 <= window.end() {
            vad.accept_waveform(window.slice(fed, fed + VAD_WINDOW as u64));
            fed += VAD_WINDOW as u64;
        }
        if eof {
            if fed < window.end() {
                vad.accept_waveform(window.slice(fed, window.end()));
                fed = window.end();
            }
            vad.flush();
            if pcm.has_partial_sample() {
                eprintln!("transcriber: input ended in the middle of a sample; the last byte was ignored");
            }
        }
        while let Some(seg) = vad.front() {
            let vs = seg.start().max(0) as u64;
            let ve = vs + seg.n().max(0) as u64;
            // Normally the stretch is still in our window; if the detector returned something
            // older (an unusually long stretch), use the detector's own copy without padding.
            let own: Option<Vec<f32>> = (vs < window.origin()).then(|| seg.samples().to_vec());
            vad.pop();
            if ve <= vs {
                continue;
            }
            speech.push((vs, ve));
            // The next stretch is known now, so the held one gets its end padding: never more
            // than half the gap, so neighbouring decode windows do not overlap (the detector cuts
            // stretches longer than 20 s at a very short pause).
            if let Some(p) = held.take() {
                let de = (p.ve + PAD_SAMPLES).min(p.ve + vs.saturating_sub(p.ve) / 2).min(window.end());
                if !send_stretch(&tx, &window, p, de) {
                    return;
                }
                prev_de = de;
            }
            match own {
                Some(samples) => {
                    let p = Held { vs, ve, ds: vs, own: Some(samples) };
                    if !send_stretch(&tx, &window, p, ve) {
                        return;
                    }
                    prev_de = ve;
                }
                None => {
                    // Start padding never reaches back into the previous decode window.
                    let ds = vs.saturating_sub(PAD_SAMPLES).max(prev_de).max(window.origin()).min(vs);
                    held = Some(Held { vs, ve, ds, own: None });
                }
            }
        }
        // Release the held stretch with full end padding once no later stretch can start within
        // the padding: at end of input, or when the detector hears silence well past its end.
        if let Some(p) = held.as_ref() {
            if eof || (!vad.detected() && fed >= p.ve + PAD_SAMPLES + RELEASE_MARGIN) {
                let p = held.take().expect("checked above");
                let de = (p.ve + PAD_SAMPLES).min(window.end());
                if !send_stretch(&tx, &window, p, de) {
                    return;
                }
                prev_de = de;
            }
        }
        let keep_from = match held.as_ref() {
            Some(p) => p.ds.min(fed.saturating_sub(RETAIN_SAMPLES)),
            None => fed.saturating_sub(RETAIN_SAMPLES),
        };
        window.discard_before(keep_from, 10 * u64::from(SAMPLE_RATE));
        out.maybe_progress(window.end(), SAMPLE_RATE);
        if eof {
            break;
        }
    }
    let _ = tx.send(Job::End { speech });
}

/// Tracks what has been published so times only move forward.
#[derive(Default)]
struct Published {
    last_word_end: Micros,
    last_segment_end: Micros,
}

fn decode_batch(rec: &OfflineRecognizer, batch: Vec<Piece>, out: &Output, state: &mut Published) {
    if batch.is_empty() {
        return;
    }
    let streams: Vec<OfflineStream> = batch
        .iter()
        .map(|p| {
            let s = rec.create_stream();
            s.accept_waveform(SAMPLE_RATE as i32, &p.samples);
            s
        })
        .collect();
    if streams.len() == 1 {
        rec.decode(&streams[0]);
    } else {
        let refs: Vec<&OfflineStream> = streams.iter().collect();
        rec.decode_multiple_streams(&refs);
    }
    for (p, s) in batch.iter().zip(&streams) {
        let start = samples_to_micros(p.start).max(state.last_segment_end);
        let end = samples_to_micros(p.end).max(start);
        let dec_start = samples_to_micros(p.dec_start);
        let dec_end = samples_to_micros(p.dec_start + p.samples.len() as u64);
        let words = match s.get_result() {
            Some(r) => {
                let ts = r.timestamps.unwrap_or_default();
                let du = r.durations.unwrap_or_default();
                tokens_to_words(&r.tokens, &ts, &du, dec_start)
            }
            None => Vec::new(),
        };
        let lo = dec_start.max(state.last_word_end).max(state.last_segment_end);
        let words = tidy_words(words, lo, dec_end.max(lo));
        match (words.first(), words.last()) {
            (Some(first), Some(last)) => {
                let seg_start = start.min(first.start).max(state.last_segment_end);
                let seg_end = end.max(last.end);
                state.last_word_end = last.end;
                state.last_segment_end = seg_end;
                out.emit(&Message::Segment { start: seg_start, end: seg_end, words });
            }
            _ => {
                state.last_segment_end = state.last_segment_end.max(end);
                out.emit(&Message::SpeechWithoutWords { start, end });
            }
        }
    }
}

/// Runs the whole pipeline over `input` until end of input, writing `segment`,
/// `speech_without_words`, `progress` and finally `done`. Returns after `done` was written.
pub fn run(loaded: &Loaded, input: impl Read + Send + 'static, out: Arc<Output>) -> Result<(), Failure> {
    let vad = create_vad(&loaded.vad_config)
        .ok_or_else(|| Failure::new(ErrorCode::ModelLoadFailed, "voice detector could not be created"))?;
    let (tx, rx): (SyncSender<Job>, Receiver<Job>) = sync_channel(QUEUE_DEPTH);
    let consumed = Arc::new(AtomicU64::new(0));
    let reader = {
        let consumed = Arc::clone(&consumed);
        let out = Arc::clone(&out);
        std::thread::Builder::new()
            .name("vad-reader".into())
            .spawn(move || reader_thread(input, vad, tx, consumed, out))
            .map_err(|e| Failure::new(ErrorCode::Internal, format!("could not start the reader thread: {e}")))?
    };

    let mut state = Published::default();
    let started = Instant::now();
    let mut decode_secs = 0.0f64;
    let result = loop {
        let first = match rx.recv() {
            Ok(j) => j,
            Err(_) => break Err(Failure::new(ErrorCode::Internal, "the reader thread stopped unexpectedly")),
        };
        let mut batch = Vec::new();
        let mut finish: Option<Job> = None;
        match first {
            Job::Piece(p) => batch.push(p),
            other => finish = Some(other),
        }
        // Take whatever else is already waiting, up to the batch size, without waiting for more:
        // when audio arrives faster than it is decoded, batches fill; otherwise text is not held back.
        while finish.is_none() && batch.len() < loaded.batch {
            match rx.try_recv() {
                Ok(Job::Piece(p)) => batch.push(p),
                Ok(other) => finish = Some(other),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    finish = Some(Job::Failed("the reader thread stopped unexpectedly".into()));
                }
            }
        }
        let t = Instant::now();
        decode_batch(&loaded.recognizer, batch, &out, &mut state);
        decode_secs += t.elapsed().as_secs_f64();
        out.maybe_progress(consumed.load(Ordering::Relaxed), SAMPLE_RATE);
        match finish {
            None => {}
            Some(Job::End { speech }) => {
                let speech_ranges = speech
                    .into_iter()
                    .map(|(s, e)| Range { start: samples_to_micros(s), end: samples_to_micros(e) })
                    .collect();
                out.emit(&Message::Done { speech_ranges });
                let audio = consumed.load(Ordering::Relaxed) as f64 / f64::from(SAMPLE_RATE);
                let wall = started.elapsed().as_secs_f64();
                eprintln!(
                    "transcriber: done: {audio:.1} s of audio in {wall:.1} s ({:.1}x real time, decoding {decode_secs:.1} s)",
                    audio / wall.max(1e-9)
                );
                break Ok(());
            }
            Some(Job::Failed(msg)) => break Err(Failure::new(ErrorCode::Internal, msg)),
            Some(Job::Piece(_)) => unreachable!("pieces go into the batch"),
        }
    };
    if result.is_ok() {
        let _ = reader.join();
    }
    result
}
