//! The waveform file (spec 3.4 `WaveformHeader`, 3.5.6 `GET /media/{sourceId}/waveform`):
//! its exact byte layout, with the one writer and reader the core uses. The interface's twin
//! is `parseWaveform` in `src/types/waveform.ts`; both are checked against the same fixture
//! in `testdata/contract_vectors.json`.
//!
//! **Layout.**
//! 1. The header: [`WaveformHeader`] as compact UTF-8 JSON (camelCase field names, as
//!    serde writes it), terminated by one line feed byte (`0x0A`). JSON never contains a raw
//!    line feed, so the first `0x0A` in the file ends the header.
//! 2. Exactly `count` loudness values, one byte each: `u8` peak loudness of that slice of
//!    the speech track, on a linear amplitude scale, `0` = silence, `255` = full scale.
//!    Value `i` covers `[i / valuesPerSecond, (i + 1) / valuesPerSecond)` seconds of the
//!    source. No padding, nothing after the last value.
//!
//! The media server serves the file unchanged with `Content-Type: application/octet-stream`.

use crate::cache::WaveformHeader;

/// The `Content-Type` the media server sends for the waveform file.
pub const WAVEFORM_CONTENT_TYPE: &str = "application/octet-stream";

/// Why a waveform file could not be written or read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WaveformError {
    #[error("waveform header says {header} values but {actual} were given or found")]
    CountMismatch { header: u64, actual: u64 },
    #[error("waveform file has no header line")]
    NoHeader,
    #[error("waveform header is not valid: {0}")]
    BadHeader(String),
}

/// The bytes of a waveform file. `header.count` must equal `values.len()`.
pub fn write_waveform(header: &WaveformHeader, values: &[u8]) -> Result<Vec<u8>, WaveformError> {
    if header.count != values.len() as u64 {
        return Err(WaveformError::CountMismatch { header: header.count, actual: values.len() as u64 });
    }
    let json = serde_json::to_vec(header).map_err(|e| WaveformError::BadHeader(e.to_string()))?;
    let mut out = Vec::with_capacity(json.len() + 1 + values.len());
    out.extend_from_slice(&json);
    out.push(b'\n');
    out.extend_from_slice(values);
    Ok(out)
}

/// The header and loudness values of a waveform file.
pub fn read_waveform(bytes: &[u8]) -> Result<(WaveformHeader, Vec<u8>), WaveformError> {
    let nl = bytes.iter().position(|&b| b == b'\n').ok_or(WaveformError::NoHeader)?;
    let header: WaveformHeader =
        serde_json::from_slice(&bytes[..nl]).map_err(|e| WaveformError::BadHeader(e.to_string()))?;
    let values = &bytes[nl + 1..];
    if header.count != values.len() as u64 {
        return Err(WaveformError::CountMismatch { header: header.count, actual: values.len() as u64 });
    }
    Ok((header, values.to_vec()))
}
