//! Free disk space, whether two folders share a drive, and the time stamp of a finished export.

use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The nearest folder at or above `path` that exists.
pub(crate) fn existing_ancestor(path: &Path) -> Option<PathBuf> {
    let abs = std::path::absolute(path).ok()?;
    abs.ancestors().find(|p| p.is_dir()).map(Path::to_path_buf)
}

/// Bytes free for this user on the drive that holds `path` (or would hold it once created).
pub(crate) fn free_bytes(path: &Path) -> Option<u64> {
    let dir = existing_ancestor(path)?;
    free_bytes_at(&dir)
}

#[cfg(windows)]
fn free_bytes_at(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut free_to_caller: u64 = 0;
    let mut total: u64 = 0;
    let mut total_free: u64 = 0;
    // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the call, and the three
    // out-pointers point at live u64s.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free_to_caller, &mut total, &mut total_free) };
    (ok != 0).then_some(free_to_caller)
}

#[cfg(not(windows))]
fn free_bytes_at(_dir: &Path) -> Option<u64> {
    None
}

/// The drive (or network share) a path is on, lower case: "c:", "\\server\share".
fn volume_key(path: &Path) -> Option<String> {
    let dir = existing_ancestor(path)?;
    let canon = dunce_canonical(&dir);
    match canon.components().next()? {
        Component::Prefix(p) => Some(p.as_os_str().to_string_lossy().to_ascii_lowercase().replace("\\\\?\\unc\\", "\\\\").replace("\\\\?\\", "")),
        Component::RootDir => Some("/".into()),
        _ => None,
    }
}

fn dunce_canonical(dir: &Path) -> PathBuf {
    dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf())
}

/// The path as one comparable string: absolute, resolved through links and `..` where it
/// exists (the nearest existing folder is resolved and the rest appended), and lower case on
/// Windows, whose file names ignore case.
fn comparable(path: &Path) -> Option<String> {
    let abs = std::path::absolute(path).ok()?;
    let resolved = match abs.canonicalize() {
        Ok(c) => c,
        Err(_) => {
            let base = abs.ancestors().find(|p| p.exists())?;
            let rest = abs.strip_prefix(base).ok()?;
            dunce_canonical(base).join(rest)
        }
    };
    let s = resolved.to_string_lossy().replace('/', "\\");
    let s = s.strip_prefix("\\\\?\\UNC\\").map(|r| format!("\\\\{r}")).unwrap_or_else(|| s.strip_prefix("\\\\?\\").unwrap_or(&s).to_string());
    Some(if cfg!(windows) { s.to_lowercase() } else { s })
}

/// Whether `a` and `b` name the same file (or would, once created).
pub(crate) fn same_file(a: &Path, b: &Path) -> bool {
    match (comparable(a), comparable(b)) {
        (Some(x), Some(y)) => x == y,
        _ => a == b,
    }
}

/// Whether `a` and `b` are on the same drive. Unknown counts as the same (the stricter check).
pub(crate) fn same_volume(a: &Path, b: &Path) -> bool {
    match (volume_key(a), volume_key(b)) {
        (Some(x), Some(y)) => x == y,
        _ => true,
    }
}

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian (H. Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// A time as ISO 8601 in UTC with milliseconds: "2026-11-15T12:41:07.123Z".
pub(crate) fn iso_8601(t: SystemTime) -> String {
    let d = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let (y, mo, da) = civil_from_days(secs.div_euclid(86_400));
    let s = secs.rem_euclid(86_400);
    format!("{y:04}-{mo:02}-{da:02}T{:02}:{:02}:{:02}.{:03}Z", s / 3600, s % 3600 / 60, s % 60, d.subsec_millis())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn iso_times() {
        assert_eq!(iso_8601(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_8601(UNIX_EPOCH + Duration::from_millis(1_794_744_067_123)), "2026-11-15T12:01:07.123Z");
        assert_eq!(iso_8601(UNIX_EPOCH + Duration::from_secs(951_782_400)), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn free_space_of_a_folder_that_does_not_exist_yet_is_its_drive_s() {
        let tmp = std::env::temp_dir();
        let free = free_bytes(&tmp).expect("free space of the temp folder");
        assert!(free > 0);
        let missing = tmp.join("rc-media-no-such").join("deeper");
        let again = free_bytes(&missing).unwrap();
        // Other programs write meanwhile; the two readings are of the same drive.
        assert!(again.abs_diff(free) < 2_000_000_000, "{free} vs {again}");
        assert!(same_volume(&tmp, &missing));
    }

    #[test]
    fn the_same_file_is_recognised_however_it_is_written() {
        let dir = crate::test_support::scratch_dir("disk-same-file");
        let f = dir.join("Weekly.mp4");
        std::fs::write(&f, b"x").unwrap();
        assert!(same_file(&f, &dir.join("sub").join("..").join("Weekly.mp4")));
        assert!(!same_file(&f, &dir.join("weekly2.mp4")));
        #[cfg(windows)]
        {
            assert!(same_file(&f, &dir.join("WEEKLY.MP4")));
            let fwd = PathBuf::from(f.to_string_lossy().replace('\\', "/"));
            assert!(same_file(&f, &fwd));
        }
        // A file that does not exist yet compares by its would-be path.
        assert!(same_file(&dir.join("new.mp4"), &dir.join(".").join("new.mp4")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn drives_are_told_apart() {
        assert!(same_volume(Path::new("C:/Windows"), Path::new("c:/Users")));
        let other = ('D'..='Z').map(|c| PathBuf::from(format!("{c}:\\"))).find(|p| p.is_dir());
        if let Some(d) = other {
            assert!(!same_volume(Path::new("C:/Windows"), &d));
        }
    }
}
