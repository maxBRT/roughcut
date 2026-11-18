use super::*;
use rc_types::{AudioTrackInfo, BitDepth, Rational, VideoInfo};
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static N: AtomicU64 = AtomicU64::new(0);

/// A fresh empty folder under the system temp folder, removed when dropped.
struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> TempDir {
        let n = N.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("rc-source-{tag}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Deterministic pseudo-random bytes.
fn bytes(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x as u8
        })
        .collect()
}

fn write_file(path: &Path, data: &[u8]) {
    let mut f = File::create(path).unwrap();
    f.write_all(data).unwrap();
    f.sync_all().unwrap();
}

fn media(duration: i64) -> MediaInfo {
    MediaInfo {
        duration,
        container: "mov,mp4,m4a,3gp,3g2,mj2".into(),
        video: VideoInfo {
            codec: "h264".into(),
            width: 3840,
            height: 2160,
            frame_rate: Rational { num: 30000, den: 1001 },
            variable_frame_rate: false,
            bit_depth: BitDepth::Eight,
            hdr: false,
        },
        audio_tracks: vec![AudioTrackInfo { index: 1, codec: "aac".into(), channels: 2, sample_rate: 48000, title: None }],
        speech_track: 1,
        direct_playable: true,
    }
}

struct FakeProbe;
impl Probe for FakeProbe {
    fn probe(&self, path: &Path) -> Result<MediaInfo, AppError> {
        if path.extension().is_some_and(|e| e == "txt") {
            return Err(AppError::new(ErrorCode::SourceUnreadable, "not a video"));
        }
        Ok(media(30_000_000))
    }
}

#[test]
fn fingerprint_has_id_shape_and_is_stable() {
    let dir = TempDir::new("stable");
    let small = dir.0.join("small.mp4");
    let large = dir.0.join("large.mp4");
    write_file(&small, &bytes(1000, 1));
    write_file(&large, &bytes(3 * 1024 * 1024 + 17, 2));
    for p in [&small, &large] {
        let a = fingerprint(p).unwrap();
        assert!(is_valid_source_id(&a), "{a}");
        assert_eq!(a, fingerprint(p).unwrap());
    }
    assert_ne!(fingerprint(&small).unwrap(), fingerprint(&large).unwrap());
    // An empty file has a fingerprint too.
    let empty = dir.0.join("empty.mp4");
    write_file(&empty, &[]);
    assert!(is_valid_source_id(&fingerprint(&empty).unwrap()));
}

#[test]
fn moved_or_renamed_file_keeps_its_fingerprint() {
    let dir = TempDir::new("move");
    let original = dir.0.join("Recording 2026-11-13.mp4");
    write_file(&original, &bytes(5 * 1024 * 1024, 3));
    let before = fingerprint(&original).unwrap();

    let renamed = dir.0.join("renamed.MP4");
    fs::rename(&original, &renamed).unwrap();
    assert_eq!(fingerprint(&renamed).unwrap(), before, "rename");

    let sub = dir.0.join("elsewhere").join("deeper");
    fs::create_dir_all(&sub).unwrap();
    let moved = sub.join("take.mp4");
    fs::rename(&renamed, &moved).unwrap();
    assert_eq!(fingerprint(&moved).unwrap(), before, "move to another folder");

    // A copy keeps size, content and (on Windows) the modified time, so it is the same source.
    let copied = dir.0.join("copy.mp4");
    fs::copy(&moved, &copied).unwrap();
    File::options().write(true).open(&copied).unwrap().set_modified(fs::metadata(&moved).unwrap().modified().unwrap()).unwrap();
    assert_eq!(fingerprint(&copied).unwrap(), before, "copy with the same modified time");
}

#[test]
fn different_files_get_different_fingerprints() {
    let dir = TempDir::new("diff");
    let data = bytes(4 * 1024 * 1024, 4);
    let a = dir.0.join("a.mp4");
    write_file(&a, &data);
    let when = fs::metadata(&a).unwrap().modified().unwrap();
    let fa = fingerprint(&a).unwrap();

    // Same size and modified time, different content at the start.
    let mut changed = data.clone();
    changed[10] ^= 0xFF;
    let b = dir.0.join("b.mp4");
    write_file(&b, &changed);
    File::options().write(true).open(&b).unwrap().set_modified(when).unwrap();
    assert_ne!(fingerprint(&b).unwrap(), fa, "content at the start");

    // Different content at the end.
    let mut changed = data.clone();
    let last = changed.len() - 1;
    changed[last] ^= 0xFF;
    write_file(&b, &changed);
    File::options().write(true).open(&b).unwrap().set_modified(when).unwrap();
    assert_ne!(fingerprint(&b).unwrap(), fa, "content at the end");

    // Same content, different modified time.
    write_file(&b, &data);
    File::options().write(true).open(&b).unwrap().set_modified(when + Duration::from_secs(3600)).unwrap();
    assert_ne!(fingerprint(&b).unwrap(), fa, "modified time");

    // Same content, one byte longer.
    let mut longer = data.clone();
    longer.push(0);
    write_file(&b, &longer);
    File::options().write(true).open(&b).unwrap().set_modified(when).unwrap();
    assert_ne!(fingerprint(&b).unwrap(), fa, "size");

    // And identical content and time: the same.
    write_file(&b, &data);
    File::options().write(true).open(&b).unwrap().set_modified(when).unwrap();
    assert_eq!(fingerprint(&b).unwrap(), fa);
}

/// A 60 GB "file" that produces bytes on demand and counts how many were read.
struct HugeReader {
    size: u64,
    pos: u64,
    read: u64,
}
impl Read for HugeReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = (buf.len() as u64).min(self.size.saturating_sub(self.pos)) as usize;
        for (i, b) in buf[..n].iter_mut().enumerate() {
            *b = ((self.pos + i as u64) % 251) as u8;
        }
        self.pos += n as u64;
        self.read += n as u64;
        Ok(n)
    }
}
impl Seek for HugeReader {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        self.pos = match to {
            SeekFrom::Start(p) => p,
            SeekFrom::End(d) => (self.size as i64 + d) as u64,
            SeekFrom::Current(d) => (self.pos as i64 + d) as u64,
        };
        Ok(self.pos)
    }
}

#[test]
fn sixty_gigabyte_file_reads_only_small_samples() {
    let size = 60 * 1024 * 1024 * 1024u64;
    let mut r = HugeReader { size, pos: 0, read: 0 };
    let started = Instant::now();
    let id = fingerprint_reader(&mut r, size, SystemTime::now()).unwrap();
    let took = started.elapsed();
    assert!(is_valid_source_id(&id));
    assert!(r.read <= 256 * 1024, "read {} bytes", r.read);
    assert!(took < Duration::from_secs(1), "took {took:?}");
}

#[test]
fn real_large_file_is_fast() {
    let dir = TempDir::new("large");
    let p = dir.0.join("big.mp4");
    {
        // 256 MB of data, written in chunks.
        let mut f = File::create(&p).unwrap();
        let chunk = bytes(8 * 1024 * 1024, 9);
        for _ in 0..32 {
            f.write_all(&chunk).unwrap();
        }
    }
    let started = Instant::now();
    fingerprint(&p).unwrap();
    let took = started.elapsed();
    assert!(took < Duration::from_millis(500), "fingerprint of 256 MB took {took:?}");
}

#[test]
fn missing_and_unreadable_paths() {
    let dir = TempDir::new("missing");
    let e = fingerprint(&dir.0.join("nope.mp4")).unwrap_err();
    assert_eq!(e.code, ErrorCode::SourceMissing);
    let e = fingerprint(&dir.0).unwrap_err();
    assert_eq!(e.code, ErrorCode::SourceUnreadable);
}

#[test]
fn source_ref_uses_fingerprint_absolute_path_and_probe() {
    let dir = TempDir::new("ref");
    let p = dir.0.join("clip.mp4");
    write_file(&p, &bytes(2000, 5));
    let r = source_ref_from_path(&p, &FakeProbe).unwrap();
    assert_eq!(r.id, fingerprint(&p).unwrap());
    assert!(Path::new(&r.path).is_absolute());
    assert_eq!(Path::new(&r.path), p.as_path());
    assert_eq!(r.media, media(30_000_000));
    assert!(time::parse_iso_millis(&r.added_at).is_some());

    let t = dir.0.join("notes.txt");
    write_file(&t, b"hello");
    assert_eq!(source_ref_from_path(&t, &FakeProbe).unwrap_err().code, ErrorCode::SourceUnreadable);
    assert_eq!(source_ref_from_path(&dir.0.join("gone.mp4"), &FakeProbe).unwrap_err().code, ErrorCode::SourceMissing);

    // Repeats of the same file are left out.
    let copy = dir.0.join("again.mp4");
    fs::rename(&p, &copy).unwrap();
    let other = dir.0.join("other.mp4");
    write_file(&other, &bytes(2000, 6));
    let refs = source_refs_from_paths(&[copy.clone(), other.clone(), copy.clone()], &FakeProbe).unwrap();
    assert_eq!(refs.len(), 2);
    assert_eq!(refs[0].id, r.id);
}

#[test]
fn check_source_reports_online_missing_and_changed() {
    let dir = TempDir::new("check");
    let p = dir.0.join("a.mp4");
    write_file(&p, &bytes(3000, 7));
    let r = source_ref_from_path(&p, &FakeProbe).unwrap();
    assert_eq!(check_source(&r), SourceStatus::Online);
    assert!(file_present(&r));

    let moved = dir.0.join("moved.mp4");
    fs::rename(&p, &moved).unwrap();
    assert_eq!(check_source(&r), SourceStatus::Missing);
    assert!(!file_present(&r));

    write_file(&p, &bytes(3000, 8));
    assert_eq!(check_source(&r), SourceStatus::Changed);
}

#[test]
fn locate_file_accepts_the_same_file_and_rejects_another() {
    let dir = TempDir::new("locate");
    let p = dir.0.join("talk.mp4");
    write_file(&p, &bytes(2 * 1024 * 1024, 10));
    let id = fingerprint(&p).unwrap();

    let new_home = dir.0.join("archive");
    fs::create_dir_all(&new_home).unwrap();
    let moved = new_home.join("talk (final).mp4");
    fs::rename(&p, &moved).unwrap();
    assert_eq!(verify_relocated(&id, &moved).unwrap(), moved);

    let impostor = dir.0.join("impostor.mp4");
    write_file(&impostor, &bytes(2 * 1024 * 1024, 11));
    let e = verify_relocated(&id, &impostor).unwrap_err();
    assert_eq!(e.code, ErrorCode::SourceMismatch);

    let e = verify_relocated(&id, &dir.0.join("nothing.mp4")).unwrap_err();
    assert_eq!(e.code, ErrorCode::SourceMissing);
}

#[test]
fn source_id_shape() {
    assert!(is_valid_source_id("0123456789abcdef0123456789abcdef"));
    assert!(!is_valid_source_id("0123456789ABCDEF0123456789abcdef"));
    assert!(!is_valid_source_id("../../../../windows/system32/xx"));
    assert!(!is_valid_source_id(""));
}
