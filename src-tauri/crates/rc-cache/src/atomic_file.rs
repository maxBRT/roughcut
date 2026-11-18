//! Atomic file replacement, shared by the storage crates (`rc-cache`, `rc-project`,
//! `rc-settings`). Each of them includes this one file with `#[path]`, so there is a single
//! implementation and none of those crates has to depend on another.
//!
//! A write goes: new temporary file next to the target -> write -> flush to disk ->
//! (optionally) move the current file to `<name>.bak` -> rename the temporary file over the
//! target. A crash or error at any point leaves a complete file: the old or the new one
//! under the target name, or (with a backup, between the two renames) the old one as
//! `<name>.bak`, which readers fall back to. At worst a stray temporary file is left, which
//! is never read and is cleaned up by a later write.

#![allow(dead_code)]

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

/// A point inside [`write_atomic`]; a test hook can stop the write there, as a crash would.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// The empty temporary file exists.
    TempCreated,
    /// About half of the bytes are in the temporary file.
    TempHalfWritten,
    /// All bytes are written but not yet flushed to disk.
    TempWritten,
    /// The temporary file is flushed to disk.
    TempSynced,
    /// The previous file has moved to `<name>.bak`; the target name is momentarily free.
    BackupKept,
    /// The temporary file has replaced the target.
    Renamed,
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Marker in the name of every temporary file this module makes.
const TEMP_MARK: &str = ".tmp-";
/// Temporary files older than this are taken to be left over from a crash.
const STALE_AFTER: Duration = Duration::from_secs(600);

/// `<name>.bak` next to `path`: the file as it was before the last replacement.
pub fn backup_path(path: &Path) -> PathBuf {
    with_suffix(path, ".bak")
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

/// Whether `file_name` is one of the temporary files made by [`write_atomic`].
pub fn is_temp_name(file_name: &str) -> bool {
    file_name.contains(TEMP_MARK)
}

/// Replaces `path` with `bytes` atomically. With `keep_backup`, the replaced file stays
/// readable as [`backup_path`].
pub fn write_atomic(path: &Path, bytes: &[u8], keep_backup: bool) -> io::Result<()> {
    write_atomic_with_hook(path, bytes, keep_backup, &mut |_| Ok(()))
}

/// [`write_atomic`] with a hook called after each [`Step`]. When the hook returns an error
/// the write stops right there and returns it, leaving the files exactly as a crash at that
/// point would (no cleanup). Used by tests to interrupt a write.
pub fn write_atomic_with_hook(
    path: &Path,
    bytes: &[u8],
    keep_backup: bool,
    hook: &mut dyn FnMut(Step) -> io::Result<()>,
) -> io::Result<()> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = with_suffix(path, &format!("{TEMP_MARK}{}-{n}", std::process::id()));
    let mut file = OpenOptions::new().write(true).create_new(true).open(&temp)?;

    // Until the rename, any ordinary error removes the temporary file. A hook error is a
    // simulated crash and leaves everything as it is.
    let result = (|| -> Result<(), Stop> {
        hook(Step::TempCreated).map_err(Stop::Crash)?;
        let half = bytes.len() / 2;
        file.write_all(&bytes[..half]).map_err(Stop::Io)?;
        file.flush().map_err(Stop::Io)?;
        hook(Step::TempHalfWritten).map_err(Stop::Crash)?;
        file.write_all(&bytes[half..]).map_err(Stop::Io)?;
        file.flush().map_err(Stop::Io)?;
        hook(Step::TempWritten).map_err(Stop::Crash)?;
        file.sync_all().map_err(Stop::Io)?;
        hook(Step::TempSynced).map_err(Stop::Crash)?;
        Ok(())
    })();
    drop(file);
    match result {
        Ok(()) => {}
        Err(Stop::Crash(e)) => return Err(e),
        Err(Stop::Io(e)) => {
            let _ = fs::remove_file(&temp);
            return Err(e);
        }
    }

    if keep_backup && path.is_file() {
        // The previous file itself becomes the backup (a separate file, so nothing written to
        // the target later can touch it). Until the next rename the target name is free;
        // readers then use the backup, which is complete.
        let backup = backup_path(path);
        if let Err(e) = rename_retrying(path, &backup) {
            let _ = fs::remove_file(&temp);
            return Err(e);
        }
        hook(Step::BackupKept)?;
    }

    if let Err(e) = rename_retrying(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(e);
    }
    hook(Step::Renamed)?;
    remove_stale_temps(path);
    Ok(())
}

enum Stop {
    Crash(io::Error),
    Io(io::Error),
}

/// Renames, retrying briefly: on Windows a virus scanner or indexer can hold the target
/// open for a moment, which makes the rename fail with "access denied".
fn rename_retrying(from: &Path, to: &Path) -> io::Result<()> {
    let mut last = None;
    for attempt in 0..10u64 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
                last = Some(e);
                std::thread::sleep(Duration::from_millis(20 * (attempt + 1)));
            }
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| io::Error::other("rename failed")))
}

/// Removes temporary files of `path` left over from an earlier crash (older than ten
/// minutes, so a write still in progress elsewhere is never disturbed).
pub fn remove_stale_temps(path: &Path) {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) else {
        return;
    };
    let dir = if dir.as_os_str().is_empty() { Path::new(".") } else { dir };
    let Ok(entries) = fs::read_dir(dir) else { return };
    let prefix = format!("{name}{TEMP_MARK}");
    let backup_prefix = format!("{name}.bak{TEMP_MARK}");
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else { continue };
        if !(file_name.starts_with(&prefix) || file_name.starts_with(&backup_prefix)) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age >= STALE_AFTER);
        if old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// The file's bytes, or `None` when it does not exist.
pub fn read_optional(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod atomic_tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("rc-atomic-{tag}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const ALL_STEPS: [Step; 6] = [
        Step::TempCreated,
        Step::TempHalfWritten,
        Step::TempWritten,
        Step::TempSynced,
        Step::BackupKept,
        Step::Renamed,
    ];

    #[test]
    fn interrupted_at_every_step_leaves_old_or_new_complete_file() {
        for step in ALL_STEPS {
            let dir = temp_dir("steps");
            let path = dir.join("data.json");
            write_atomic(&path, b"old contents", true).unwrap();
            let err = write_atomic_with_hook(&path, b"new contents, longer", true, &mut |s| {
                if s == step { Err(io::Error::other("crash")) } else { Ok(()) }
            });
            assert!(err.is_err(), "hook at {step:?} should stop the write");
            match step {
                Step::Renamed => {
                    assert_eq!(fs::read(&path).unwrap(), b"new contents, longer");
                    assert_eq!(fs::read(backup_path(&path)).unwrap(), b"old contents");
                }
                Step::BackupKept => {
                    // Between the two renames: the old file is complete under the backup name.
                    assert!(read_optional(&path).unwrap().is_none());
                    assert_eq!(fs::read(backup_path(&path)).unwrap(), b"old contents");
                }
                _ => assert_eq!(fs::read(&path).unwrap(), b"old contents", "after a crash at {step:?}"),
            }
            // The next write succeeds and is complete.
            write_atomic(&path, b"third", true).unwrap();
            assert_eq!(fs::read(&path).unwrap(), b"third");
            fs::remove_dir_all(&dir).unwrap();
        }
    }

    #[test]
    fn backup_holds_previous_version() {
        let dir = temp_dir("backup");
        let path = dir.join("a.json");
        write_atomic(&path, b"1", true).unwrap();
        assert!(!backup_path(&path).exists());
        write_atomic(&path, b"2", true).unwrap();
        write_atomic(&path, b"3", true).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"3");
        assert_eq!(fs::read(backup_path(&path)).unwrap(), b"2");
        // Without backup, the .bak is left alone.
        write_atomic(&path, b"4", false).unwrap();
        assert_eq!(fs::read(backup_path(&path)).unwrap(), b"2");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ordinary_failure_removes_temp_file() {
        let dir = temp_dir("fail");
        // The target is a directory, so the rename fails.
        let path = dir.join("taken");
        fs::create_dir_all(path.join("inside")).unwrap();
        assert!(write_atomic(&path, b"x", false).is_err());
        let left: Vec<_> = fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left.len(), 1, "only the directory remains: {left:?}");
        fs::remove_dir_all(&dir).unwrap();
    }
}
