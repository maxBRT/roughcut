//! Copies the deployed transcriber folder into `<target>/<profile>/speech-runtime` (used by
//! `build.rs`, and compiled into the library's tests so the rules below are tested).
//!
//! The files are COPIED, never hard-linked. A hard link shares the file's contents, so anything
//! that later writes into the target folder writes into `.cache-dev/speech/dist` as well. That
//! happened: the installer build (Tauri copies its bundle resources, the processor runtime,
//! into `target/release/speech-runtime`) wrote the processor DLLs through the links into
//! `dist/gpu`, and every GPU transcription fell back to the processor.
//!
//! Each file is written to a temporary name and then renamed over the old one, so even a file
//! that is still a hard link from an older build is replaced rather than written through.

use std::fs;
use std::io::{self, Read};
use std::path::Path;

/// Written into the target folder once it holds copies only. A folder without it may still hold
/// hard links from older builds, so every file in it is replaced.
pub const MARKER: &str = ".roughcut-copied";

/// Files up to this size are compared byte for byte; larger ones by size and modified time.
/// The small ones (transcriber.exe, onnxruntime.dll, sherpa-onnx-c-api.dll, ...) are the files
/// whose processor and GPU builds get mixed up; the CUDA libraries exist only in the GPU build.
pub const COMPARE_BYTES_UP_TO: u64 = 64 * 1024 * 1024;

/// Makes `to` hold a copy of every file of `from` (one level) and nothing else. Files already
/// there with the same contents are left alone.
pub fn mirror(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    let marker = to.join(MARKER);
    let replace_all = !marker.is_file();
    let mut names = Vec::new();
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let src = entry.path();
        let dst = to.join(&name);
        names.push(name);
        if !replace_all && same_file_contents(&src, &dst)? {
            continue;
        }
        copy_replacing(&src, &dst)?;
    }
    for entry in fs::read_dir(to)? {
        let entry = entry?;
        if entry.file_type()?.is_file() && entry.file_name() != MARKER && !names.contains(&entry.file_name()) {
            fs::remove_file(entry.path())?;
        }
    }
    fs::write(&marker, b"every file here is a copy of .cache-dev/speech/dist/<variant>, made by src-tauri/build.rs\n")?;
    Ok(())
}

/// Copies `src` to `dst` through a temporary file and a rename, keeping `src`'s modified time.
fn copy_replacing(src: &Path, dst: &Path) -> io::Result<()> {
    let mut tmp_name = dst.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(".part-copy");
    let tmp = dst.with_file_name(tmp_name);
    let _ = fs::remove_file(&tmp);
    fs::copy(src, &tmp)?;
    let modified = fs::metadata(src)?.modified()?;
    fs::OpenOptions::new().write(true).open(&tmp)?.set_modified(modified)?;
    fs::rename(&tmp, dst)
}

/// Whether `dst` exists with the contents of `src` (see [`COMPARE_BYTES_UP_TO`]).
fn same_file_contents(src: &Path, dst: &Path) -> io::Result<bool> {
    let (sm, dm) = match (fs::metadata(src), fs::metadata(dst)) {
        (Ok(s), Ok(d)) => (s, d),
        (Err(e), _) => return Err(e),
        (_, Err(_)) => return Ok(false),
    };
    if !dm.is_file() || sm.len() != dm.len() {
        return Ok(false);
    }
    if sm.len() > COMPARE_BYTES_UP_TO {
        return Ok(sm.modified().ok() == dm.modified().ok());
    }
    let (mut a, mut b) = (fs::File::open(src)?, fs::File::open(dst)?);
    let (mut ba, mut bb) = (vec![0u8; 1 << 20], vec![0u8; 1 << 20]);
    loop {
        let n = read_full(&mut a, &mut ba)?;
        let m = read_full(&mut b, &mut bb)?;
        if n != m || ba[..n] != bb[..m] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(true);
        }
    }
}

fn read_full(f: &mut fs::File, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match f.read(&mut buf[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(filled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rc-build-mirror-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("from")).unwrap();
        d
    }

    #[test]
    fn writing_into_the_copy_never_changes_the_deployed_folder() {
        let d = scratch("write");
        let (from, to) = (d.join("from"), d.join("to"));
        fs::write(from.join("onnxruntime.dll"), b"gpu build").unwrap();
        fs::write(from.join("transcriber.exe"), b"transcriber").unwrap();
        mirror(&from, &to).unwrap();
        assert_eq!(fs::read(to.join("onnxruntime.dll")).unwrap(), b"gpu build");
        // What the installer build does: copy the processor runtime over the target folder.
        fs::write(to.join("onnxruntime.dll"), b"cpu build").unwrap();
        assert_eq!(fs::read(from.join("onnxruntime.dll")).unwrap(), b"gpu build", "the write reached the deployed folder");
        // The next build puts the GPU file back.
        mirror(&from, &to).unwrap();
        assert_eq!(fs::read(to.join("onnxruntime.dll")).unwrap(), b"gpu build");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_same_size_file_with_other_contents_is_replaced() {
        let d = scratch("same-size");
        let (from, to) = (d.join("from"), d.join("to"));
        fs::write(from.join("transcriber.exe"), b"AAAA").unwrap();
        mirror(&from, &to).unwrap();
        let modified = fs::metadata(from.join("transcriber.exe")).unwrap().modified().unwrap();
        fs::write(to.join("transcriber.exe"), b"BBBB").unwrap();
        fs::OpenOptions::new().write(true).open(to.join("transcriber.exe")).unwrap().set_modified(modified).unwrap();
        mirror(&from, &to).unwrap();
        assert_eq!(fs::read(to.join("transcriber.exe")).unwrap(), b"AAAA");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn hard_links_left_by_an_older_build_are_replaced_by_copies() {
        let d = scratch("old-links");
        let (from, to) = (d.join("from"), d.join("to"));
        fs::create_dir_all(&to).unwrap();
        fs::write(from.join("onnxruntime.dll"), b"gpu build").unwrap();
        fs::hard_link(from.join("onnxruntime.dll"), to.join("onnxruntime.dll")).unwrap();
        fs::write(to.join("stale.dll"), b"old").unwrap();
        mirror(&from, &to).unwrap();
        fs::write(to.join("onnxruntime.dll"), b"cpu build").unwrap();
        assert_eq!(fs::read(from.join("onnxruntime.dll")).unwrap(), b"gpu build", "the old link was kept");
        assert!(!to.join("stale.dll").exists(), "files the deployed folder lacks are removed");
        assert!(to.join(MARKER).is_file());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn unchanged_files_are_not_copied_again() {
        let d = scratch("unchanged");
        let (from, to) = (d.join("from"), d.join("to"));
        fs::write(from.join("a.dll"), b"contents").unwrap();
        mirror(&from, &to).unwrap();
        // A file left alone keeps an extra hard link made to it; a copied one would not.
        fs::hard_link(to.join("a.dll"), d.join("probe")).unwrap();
        mirror(&from, &to).unwrap();
        fs::write(d.join("probe"), b"changed!").unwrap();
        assert_eq!(fs::read(to.join("a.dll")).unwrap(), b"changed!", "the unchanged file was copied again");
        fs::remove_dir_all(&d).unwrap();
    }
}
