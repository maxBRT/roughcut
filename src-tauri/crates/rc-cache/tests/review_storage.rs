//! Review tests (track storage-review). They show defects in `Cache::enforce_limit` when a
//! source folder can only be partly removed.

use std::fs;
use std::path::PathBuf;

use rc_cache::{Cache, CacheItem};

fn temp(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("rc-cache-review-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&p);
    fs::create_dir_all(&p).unwrap();
    p
}

fn put(cache: &Cache, source: &str, item: CacheItem, len: usize) {
    let p = cache.partial_path(source, item).unwrap();
    fs::write(&p, vec![7u8; len]).unwrap();
    cache.finish(source, item).unwrap();
}

fn id(n: u8) -> String {
    format!("{:032x}", u128::from(n) * 0x1111)
}

/// A source whose speech audio is open (not shared for delete) is only partly removed:
/// `last-used` and its big proxy go first (directory order), so the cache is already under the limit, yet the bytes that were freed
/// are not counted and a second, newer source is removed as well.
#[cfg(windows)]
#[test]
fn review_partly_removed_source_is_not_counted_and_causes_over_removal() {
    let root = temp("over");
    let cache = Cache::new(&root);
    let (a, b) = (id(40), id(41));
    put(&cache, &a, CacheItem::Proxy, 50_000);
    put(&cache, &a, CacheItem::SpeechAudio, 10);
    put(&cache, &b, CacheItem::Proxy, 1_000);
    fs::write(cache.source_dir(&a).unwrap().join("last-used"), "1").unwrap();
    fs::write(cache.source_dir(&b).unwrap().join("last-used"), "2").unwrap();

    let mut open = fs::OpenOptions::new();
    open.read(true);
    std::os::windows::fs::OpenOptionsExt::share_mode(&mut open, 1 /* FILE_SHARE_READ */);
    let held = open.open(cache.item_path(&a, CacheItem::SpeechAudio).unwrap()).unwrap();

    let removed = cache.enforce_limit(5_000, &[]).unwrap();
    let after = cache.usage_bytes().unwrap();
    drop(held);
    let b_exists = cache.source_dir(&b).unwrap().exists();
    let _ = fs::remove_dir_all(&root);

    // a's proxy (50 000 bytes) was deleted, leaving about 1 000 bytes in total, far
    // below the 5 000-byte limit: b, the more recently used source, should have been kept.
    assert!(b_exists, "b was removed although the cache was already under the limit; removed {removed:?}, {after} bytes left");
}
