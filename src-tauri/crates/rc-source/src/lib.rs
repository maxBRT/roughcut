//! Roughcut core module `source` (fingerprint, probe result, locating files).
//!
//! Responsibility (spec 3.3): Fingerprints a file, holds its probe result, checks it is still
//! where it was, verifies a relocated file.
//!
//! - [`fingerprint`]: the `SourceId` of a file (spec 2.4.9): its size, its modified time and
//!   a sample of its content. It reads at most [`MAX_SAMPLE_BYTES`] whatever the file size, so
//!   it is fast on a 60 GB recording. Moving or renaming a file keeps its fingerprint.
//! - [`Probe`]: "probe this path and return its `MediaInfo`". The `media` crate implements it
//!   with ffprobe; this crate never runs FFmpeg itself.
//! - [`source_ref_from_path`], [`check_source`], [`verify_relocated`].
//! - [`time`]: the ISO 8601 timestamps every storage crate writes.
//!
//! May use: `media` (probe) (spec 3.3, 3.6), here only through the [`Probe`] trait.

pub mod time;

use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rc_types::{AppError, ErrorCode, MediaInfo, SourceId, SourceRef};
use sha2::{Digest, Sha256};

pub use time::now_iso;

/// Bump when the fingerprint recipe changes (it is part of the hashed input, so a new
/// recipe can never collide with an old id).
const FINGERPRINT_RECIPE: &[u8] = b"roughcut-source-fingerprint-v1";
/// Files up to this size are hashed whole.
const WHOLE_FILE_LIMIT: u64 = 1024 * 1024;
/// Bytes read from the start and from the end of a larger file.
const EDGE_SAMPLE: u64 = 64 * 1024;
/// Bytes read at each of the evenly spaced points in between.
const MIDDLE_SAMPLE: u64 = 16 * 1024;
/// How many evenly spaced points in between.
const MIDDLE_SAMPLES: u64 = 8;
/// The most a fingerprint ever reads from a file: 256 KiB, or the whole file up to 1 MiB.
pub const MAX_SAMPLE_BYTES: u64 = WHOLE_FILE_LIMIT;
/// The modified time is counted in steps of this many seconds, so that copying a file to a
/// FAT or exFAT drive (which store coarser times) is less likely to change its fingerprint.
const MTIME_STEP_SECS: i64 = 2;

/// "Probe this path and return what is in it." Implemented by the `media` crate (ffprobe);
/// tests supply their own.
pub trait Probe: Send + Sync {
    /// The file's `MediaInfo`, or `source_unreadable` when it is not usable footage.
    fn probe(&self, path: &Path) -> Result<MediaInfo, AppError>;
}

/// Where a project's source stands now (see [`check_source`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceStatus {
    /// The same file is at the recorded path.
    Online,
    /// Nothing is at the recorded path (moved, renamed, deleted, or its drive is gone).
    Missing,
    /// A file is at the recorded path but it is a different file (another fingerprint).
    Changed,
    /// The file is there but could not be read.
    Unreadable,
}

/// The fingerprint of the file at `path`, used as its `SourceId`: 32 lowercase hex digits.
///
/// Errors: `source_missing` when there is no file at `path`, `source_unreadable` when it
/// cannot be read.
pub fn fingerprint(path: &Path) -> Result<SourceId, AppError> {
    let meta = fs::metadata(path).map_err(|e| io_error(path, e))?;
    if !meta.is_file() {
        return Err(AppError::new(ErrorCode::SourceUnreadable, "That is a folder, not a file.")
            .with_detail(path.display().to_string()));
    }
    let modified = meta.modified().map_err(|e| io_error(path, e))?;
    let mut file = File::open(path).map_err(|e| io_error(path, e))?;
    fingerprint_reader(&mut file, meta.len(), modified).map_err(|e| io_error(path, e))
}

/// The fingerprint of `size` bytes of content in `reader`, last modified at `modified`.
/// [`fingerprint`] uses this on a file; it reads at most [`MAX_SAMPLE_BYTES`].
pub fn fingerprint_reader<R: Read + Seek>(reader: &mut R, size: u64, modified: SystemTime) -> io::Result<SourceId> {
    let mut hash = Sha256::new();
    hash.update(FINGERPRINT_RECIPE);
    hash.update(size.to_le_bytes());
    hash.update(mtime_steps(modified).to_le_bytes());
    for (offset, len) in sample_ranges(size) {
        reader.seek(SeekFrom::Start(offset))?;
        let mut buf = vec![0u8; usize::try_from(len).map_err(io::Error::other)?];
        reader.read_exact(&mut buf)?;
        hash.update(offset.to_le_bytes());
        hash.update(&buf);
    }
    let digest = hash.finalize();
    Ok(digest[..16].iter().map(|b| format!("{b:02x}")).collect())
}

fn mtime_steps(modified: SystemTime) -> i64 {
    let secs = match modified.duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_secs()).unwrap_or(i64::MAX),
        Err(e) => -i64::try_from(e.duration().as_secs()).unwrap_or(i64::MAX) - 1,
    };
    secs.div_euclid(MTIME_STEP_SECS)
}

/// The (offset, length) pieces of a file of `size` bytes that go into its fingerprint.
fn sample_ranges(size: u64) -> Vec<(u64, u64)> {
    if size <= WHOLE_FILE_LIMIT {
        return vec![(0, size)];
    }
    let mut ranges = vec![(0, EDGE_SAMPLE)];
    for i in 1..=MIDDLE_SAMPLES {
        let at = (u128::from(size) * u128::from(i) / u128::from(MIDDLE_SAMPLES + 1)) as u64;
        ranges.push((at - MIDDLE_SAMPLE / 2, MIDDLE_SAMPLE));
    }
    ranges.push((size - EDGE_SAMPLE, EDGE_SAMPLE));
    ranges
}

/// Whether `id` has the shape of a fingerprint (32 lowercase hex digits). Folder names and
/// URLs are built from ids, so anything else is refused before it reaches a path.
pub fn is_valid_source_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The absolute form of `path` (without resolving links, and without the `\\?\` prefix
/// that `canonicalize` adds on Windows).
pub fn absolute_path(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

/// A `SourceRef` for the file at `path`: its fingerprint, absolute path, the time it was
/// added (now) and the probe result.
pub fn source_ref_from_path(path: &Path, probe: &dyn Probe) -> Result<SourceRef, AppError> {
    let path = absolute_path(path);
    let id = fingerprint(&path)?;
    let media = probe.probe(&path)?;
    Ok(SourceRef { id, path: path.to_string_lossy().into_owned(), added_at: now_iso(), media })
}

/// `SourceRef`s for several paths, in order, with repeats of the same file (same
/// fingerprint) left out. Stops at the first file that fails.
pub fn source_refs_from_paths(paths: &[PathBuf], probe: &dyn Probe) -> Result<Vec<SourceRef>, AppError> {
    let mut refs: Vec<SourceRef> = Vec::with_capacity(paths.len());
    for path in paths {
        let r = source_ref_from_path(path, probe)?;
        if !refs.iter().any(|x| x.id == r.id) {
            refs.push(r);
        }
    }
    Ok(refs)
}

/// Whether the file a project expects is still at its recorded path. Reads a fingerprint's
/// worth of the file (at most [`MAX_SAMPLE_BYTES`]).
pub fn check_source(source: &SourceRef) -> SourceStatus {
    match fingerprint(Path::new(&source.path)) {
        Ok(id) if id == source.id => SourceStatus::Online,
        Ok(_) => SourceStatus::Changed,
        Err(e) if e.code == ErrorCode::SourceMissing => SourceStatus::Missing,
        Err(_) => SourceStatus::Unreadable,
    }
}

/// A quick check that only asks whether some file is at the recorded path (no reading), for
/// lists of many projects.
pub fn file_present(source: &SourceRef) -> bool {
    Path::new(&source.path).is_file()
}

/// "Locate file": accepts `new_path` only when it holds the same file as `expected`.
/// Returns the absolute form of `new_path`.
///
/// Errors: `source_mismatch` for a different file, `source_missing` / `source_unreadable`
/// when nothing usable is at `new_path`.
pub fn verify_relocated(expected: &SourceId, new_path: &Path) -> Result<PathBuf, AppError> {
    let path = absolute_path(new_path);
    let found = fingerprint(&path)?;
    if &found != expected {
        return Err(AppError::new(ErrorCode::SourceMismatch, "That is a different file from the one in the project.")
            .with_detail(path.display().to_string()));
    }
    Ok(path)
}

fn io_error(path: &Path, e: io::Error) -> AppError {
    let code = if e.kind() == io::ErrorKind::NotFound { ErrorCode::SourceMissing } else { ErrorCode::SourceUnreadable };
    let message = if code == ErrorCode::SourceMissing { "The file is not there any more." } else { "The file could not be read." };
    AppError::new(code, message).with_detail(format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests;
