//! Runs a real transcriber over a 16 kHz mono WAV file through rc-speech and prints a summary
//! of the transcript (a manual end-to-end check; the automated tests use the stand-in).
//!
//! `cargo run -p rc-speech --example transcribe_wav -- <transcriber.exe> <model-dir> <device> <file.wav> [out.json]`

use std::io::Cursor;
use std::path::PathBuf;
use std::time::Instant;

use rc_speech::{transcribe, BuildOptions, CancelToken, SpeechEvent, TranscribeJob, TranscriberCommand};
use rc_types::{SpeechDevice, Token};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 4 {
        eprintln!("usage: transcribe_wav <transcriber.exe> <model-dir> <auto|gpu|cpu> <file.wav> [out.json]");
        std::process::exit(2);
    }
    let device = match args[2].as_str() {
        "gpu" => SpeechDevice::Gpu,
        "cpu" => SpeechDevice::Cpu,
        _ => SpeechDevice::Auto,
    };
    let bytes = std::fs::read(&args[3]).expect("read the wav file");
    let pcm = wav_data(&bytes);
    let duration = (pcm.len() / 2) as i64 * 1_000_000 / 16_000;
    let model_dir = PathBuf::from(&args[1]);
    let vad = PathBuf::from(&args[1]).join("silero_vad.onnx");
    let cmd = TranscriberCommand {
        program: PathBuf::from(&args[0]),
        model_dir,
        device,
        vad_model: vad.is_file().then_some(vad),
    };
    let job = TranscribeJob { source_id: "example".into(), duration, options: BuildOptions::default() };
    let started = Instant::now();
    let mut batches = 0;
    let result = transcribe(&cmd, &job, Cursor::new(pcm), &CancelToken::new(), |e| match e {
        SpeechEvent::Ready { model, device, fallback } => {
            println!("ready after {:?}: {model} on {device:?} (fallback {fallback})", started.elapsed())
        }
        SpeechEvent::Progress { fraction, .. } => eprint!("\rprogress {:.0}%", fraction * 100.0),
        SpeechEvent::Utterances(u) => {
            batches += 1;
            eprintln!("\rbatch {batches}: {} utterance(s), first #{}", u.len(), u[0].index);
        }
    });
    match result {
        Ok(t) => {
            let tokens: Vec<&Token> = t.utterances.iter().flat_map(|u| &u.tokens).collect();
            let count = |f: fn(&Token) -> bool| tokens.iter().filter(|t| f(t)).count();
            println!(
                "done in {:?}: {} utterances, {} words, {} pauses, {} unrecognised, {batches} batches",
                started.elapsed(),
                t.utterances.len(),
                count(|t| matches!(t, Token::Word(_))),
                count(|t| matches!(t, Token::Pause(_))),
                count(|t| matches!(t, Token::Unrecognised(_)))
            );
            for u in t.utterances.iter().take(8) {
                let text: Vec<String> = u
                    .tokens
                    .iter()
                    .map(|t| match t {
                        Token::Word(w) => w.text.clone(),
                        Token::Pause(p) => format!("[pause {:.1}s]", (p.end - p.start) as f64 / 1e6),
                        Token::Unrecognised(_) => "[unrecognised]".into(),
                    })
                    .collect();
                println!("#{} {:.2}-{:.2}: {}", u.index, u.start as f64 / 1e6, u.end as f64 / 1e6, text.join(" "));
            }
            if let Some(out) = args.get(4) {
                std::fs::write(out, serde_json::to_string_pretty(&t).unwrap()).expect("write the transcript");
            }
        }
        Err(e) => {
            println!("failed: {e:?}");
            std::process::exit(1);
        }
    }
}

/// The `data` chunk of a 16 kHz mono s16le WAV file.
fn wav_data(bytes: &[u8]) -> Vec<u8> {
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let len = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
        if &bytes[at..at + 4] == b"data" {
            return bytes[at + 8..(at + 8 + len).min(bytes.len())].to_vec();
        }
        at += 8 + len + (len & 1);
    }
    panic!("no data chunk: not a WAV file");
}
