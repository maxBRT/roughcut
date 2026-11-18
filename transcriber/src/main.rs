//! The separate transcriber program (spec 3.3, 3.5.7), started by the `speech` module.
//!
//! `transcriber --model-dir <folder> --device <auto|gpu|cpu> [--vad-model <file>]`
//! Reads 16 kHz mono s16le audio on standard input until it ends; writes `ready`, then
//! `segment` / `speech_without_words` / `progress` as it goes, then `done`, one JSON object per
//! line. On a fatal problem it writes one `error` line and exits with code 1. Exit code 0 only
//! after `done`.

use std::sync::Arc;
use std::time::Duration;
use transcriber::engine::{self, Failure};
use transcriber::protocol::{ErrorCode, Message, Output};
use transcriber::cli;

fn fail(out: &Output, f: Failure) -> ! {
    eprintln!("transcriber: {}", f.message);
    out.emit(&Message::Error { code: f.code, message: f.message });
    std::process::exit(1);
}

fn main() {
    let out = Arc::new(Output::new(Box::new(std::io::stdout()), Duration::from_secs(1)));

    // Any panic becomes an `error` line instead of a silent exit.
    std::panic::set_hook(Box::new(|info| {
        let message = format!("internal error: {info}");
        eprintln!("transcriber: {message}");
        let line = Message::Error { code: ErrorCode::Internal, message }.to_line();
        use std::io::Write;
        let mut so = std::io::stdout().lock();
        let _ = writeln!(so, "{line}");
        let _ = so.flush();
        std::process::exit(1);
    }));

    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match cli::parse(&argv) {
        Ok(a) => a,
        Err(e) => fail(&out, Failure { code: ErrorCode::BadArguments, message: format!("{e}; {}", cli::USAGE) }),
    };

    let t = std::time::Instant::now();
    let loaded = match engine::load(&args) {
        Ok(l) => l,
        Err(f) => fail(&out, f),
    };
    eprintln!(
        "transcriber: ready on {:?} with {} (loaded in {:.1} s)",
        loaded.device,
        loaded.model_name,
        t.elapsed().as_secs_f64()
    );
    out.emit(&loaded.ready_message());

    match engine::run(&loaded, std::io::stdin(), Arc::clone(&out)) {
        Ok(()) => std::process::exit(0),
        Err(f) => fail(&out, f),
    }
}
