//! The Roughcut transcriber program (spec 3.3, 3.5.7): 16 kHz mono signed 16-bit PCM on standard
//! input, one JSON message per line on standard output. Parakeet TDT 0.6B v2 through sherpa-onnx
//! 2.0.1 (fp32 on the GPU, int8 on the processor) with the Silero voice detector inside.
//!
//! The library half holds the pieces the binary is made of, so they can be unit-tested. The
//! wire format is in [`protocol`]; other Roughcut modules talk to the program only through it.

pub mod audio;
pub mod cli;
pub mod engine;
pub mod model;
pub mod protocol;
pub mod split;
pub mod words;
