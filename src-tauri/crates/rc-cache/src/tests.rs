use super::*;
use rc_types::{
    PauseToken, SourceRange, Suggestion, SuggestionKind, SuggestionOrigin, Token, Utterance, WordToken,
};
use std::sync::atomic::{AtomicU64, Ordering};

static N: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> TempDir {
        let n = N.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("rc-cache-{tag}-{}-{n}", std::process::id()));
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

fn id(n: u8) -> SourceId {
    format!("{:032x}", u128::from(n) * 0x1111)
}

/// Puts a finished item of `len` bytes into the cache, the way a task would.
fn put(cache: &Cache, source: &str, item: CacheItem, len: usize) {
    let p = cache.partial_path(source, item).unwrap();
    fs::write(&p, vec![7u8; len]).unwrap();
    cache.finish(source, item).unwrap();
}

/// Sets a source's last use explicitly.
fn used_at(cache: &Cache, source: &str, millis: i64) {
    fs::write(cache.source_dir(source).unwrap().join(LAST_USED_FILE), millis.to_string()).unwrap();
}

fn transcript(source: &str, complete: bool) -> Transcript {
    Transcript {
        schema_version: TRANSCRIPT_SCHEMA_VERSION,
        source_id: source.into(),
        model: "parakeet-tdt-0.6b-v2-int8".into(),
        complete,
        utterances: vec![Utterance {
            index: 0,
            start: 1_000_000,
            end: 2_500_000,
            tokens: vec![
                Token::Word(WordToken { start: 1_000_000, end: 1_300_000, cut_before: 900_000, text: "Hello".into() }),
                Token::Pause(PauseToken { start: 1_300_000, end: 2_000_000, cut_before: 1_350_000 }),
                Token::Word(WordToken { start: 2_000_000, end: 2_500_000, cut_before: 1_950_000, text: "there.".into() }),
            ],
        }],
    }
}

#[test]
fn paths_are_per_source_and_per_item() {
    let dir = TempDir::new("paths");
    let cache = Cache::new(&dir.0);
    let a = id(1);
    assert_eq!(cache.source_dir(&a).unwrap(), dir.0.join(&a));
    let mut names: Vec<_> = CacheItem::ALL.iter().map(|i| cache.item_path(&a, *i).unwrap()).collect();
    names.extend(CacheItem::ALL.iter().map(|i| cache.source_dir(&a).unwrap().join(i.partial_file_name())));
    let unique: std::collections::HashSet<_> = names.iter().collect();
    assert_eq!(unique.len(), 10, "every finished and partial name is distinct");
    assert_eq!(cache.item_path(&a, CacheItem::Proxy).unwrap().extension().unwrap(), "mp4");
    assert_eq!(dir.0.join(&a).join(CacheItem::Proxy.partial_file_name()).extension().unwrap(), "mp4");
    assert!(cache.source_dir("..\\..\\Windows").is_err());
    assert!(cache.source_dir("a/b").is_err());
    assert!(cache.source_dir("").is_err());
}

#[test]
fn half_written_items_are_never_reported_as_finished() {
    let dir = TempDir::new("partial");
    let cache = Cache::new(&dir.0);
    let a = id(2);
    let p = cache.partial_path(&a, CacheItem::Proxy).unwrap();
    fs::write(&p, b"half a proxy").unwrap();
    assert!(!cache.has(&a, CacheItem::Proxy));
    assert!(cache.items(&a).is_empty());

    // A new run starts again from nothing.
    let p2 = cache.partial_path(&a, CacheItem::Proxy).unwrap();
    assert_eq!(p, p2);
    assert!(!p2.exists(), "the leftover partial file is removed");
    fs::write(&p2, b"a whole proxy").unwrap();
    let done = cache.finish(&a, CacheItem::Proxy).unwrap();
    assert_eq!(fs::read(&done).unwrap(), b"a whole proxy");
    assert!(cache.has(&a, CacheItem::Proxy));
    assert!(!p2.exists());

    // A cancelled task discards its partial file; the finished item stays.
    fs::write(cache.partial_path(&a, CacheItem::Proxy).unwrap(), b"newer, cancelled").unwrap();
    cache.discard_partial(&a, CacheItem::Proxy).unwrap();
    assert_eq!(fs::read(&done).unwrap(), b"a whole proxy");

    // Finishing without a partial file is an error, not an empty item.
    assert!(cache.finish(&a, CacheItem::Waveform).is_err());
    assert!(!cache.has(&a, CacheItem::Waveform));

    put(&cache, &a, CacheItem::Waveform, 10);
    put(&cache, &a, CacheItem::SpeechAudio, 10);
    assert_eq!(cache.items(&a), vec![CacheItem::Proxy, CacheItem::SpeechAudio, CacheItem::Waveform]);
    cache.remove_item(&a, CacheItem::SpeechAudio).unwrap();
    assert_eq!(cache.items(&a), vec![CacheItem::Proxy, CacheItem::Waveform]);
}

#[test]
fn transcript_and_suggestions_round_trip() {
    let dir = TempDir::new("json");
    let cache = Cache::new(&dir.0);
    let a = id(3);
    assert_eq!(cache.read_transcript(&a).unwrap(), None);
    assert_eq!(cache.read_suggestions(&a).unwrap(), None);

    let partial = transcript(&a, false);
    cache.write_transcript(&partial).unwrap();
    assert_eq!(cache.read_transcript(&a).unwrap(), Some(partial));
    let complete = transcript(&a, true);
    cache.write_transcript(&complete).unwrap();
    assert_eq!(cache.read_transcript(&a).unwrap(), Some(complete));
    assert!(cache.has(&a, CacheItem::Transcript));

    let set = SuggestionSet {
        schema_version: SUGGESTION_SET_SCHEMA_VERSION,
        source_id: a.clone(),
        claude_model: Some("opus".into()),
        suggestions: vec![Suggestion {
            id: "s1".into(),
            kind: SuggestionKind::Retake,
            origin: SuggestionOrigin::Claude,
            range: SourceRange { source_id: a.clone(), start: 0, end: 1_000_000 },
            reason: "Said again at 0:04".into(),
            kept_version_at: Some(4_000_000),
        }],
    };
    cache.write_suggestions(&set).unwrap();
    assert_eq!(cache.read_suggestions(&a).unwrap(), Some(set.clone()));

    // A file for another source, a newer schema or garbage counts as absent.
    let b = id(4);
    fs::create_dir_all(cache.source_dir(&b).unwrap()).unwrap();
    fs::copy(cache.item_path(&a, CacheItem::Suggestions).unwrap(), cache.item_path(&b, CacheItem::Suggestions).unwrap()).unwrap();
    assert_eq!(cache.read_suggestions(&b).unwrap(), None);
    let mut newer = transcript(&b, true);
    newer.schema_version = TRANSCRIPT_SCHEMA_VERSION + 1;
    cache.write_transcript(&newer).unwrap();
    assert_eq!(cache.read_transcript(&b).unwrap(), None);
    fs::write(cache.item_path(&b, CacheItem::Transcript).unwrap(), b"{\"schemaVers").unwrap();
    assert_eq!(cache.read_transcript(&b).unwrap(), None);
}

#[test]
fn interrupted_transcript_write_keeps_the_previous_one() {
    use atomic_file::{write_atomic_with_hook, Step};
    let dir = TempDir::new("interrupt");
    let cache = Cache::new(&dir.0);
    let a = id(5);
    let first = transcript(&a, false);
    cache.write_transcript(&first).unwrap();
    let path = cache.item_path(&a, CacheItem::Transcript).unwrap();
    let next = serde_json::to_vec(&transcript(&a, true)).unwrap();
    for step in [Step::TempCreated, Step::TempHalfWritten, Step::TempWritten, Step::TempSynced] {
        let r = write_atomic_with_hook(&path, &next, false, &mut |s| {
            if s == step { Err(io::Error::other("power cut")) } else { Ok(()) }
        });
        assert!(r.is_err());
        assert_eq!(cache.read_transcript(&a).unwrap(), Some(first.clone()), "crash at {step:?}");
    }
    // Leftover temporary files are not items and do not confuse the next write.
    assert_eq!(cache.items(&a), vec![CacheItem::Transcript]);
    cache.write_transcript(&transcript(&a, true)).unwrap();
    assert!(cache.read_transcript(&a).unwrap().unwrap().complete);
}

#[test]
fn usage_counts_every_byte_and_clear_spares_sources_in_use() {
    let dir = TempDir::new("usage");
    let cache = Cache::new(&dir.0);
    assert_eq!(cache.usage_bytes().unwrap(), 0, "a cache that was never written is empty");
    let (a, b, c) = (id(6), id(7), id(8));
    put(&cache, &a, CacheItem::Proxy, 1000);
    put(&cache, &a, CacheItem::Waveform, 24);
    put(&cache, &b, CacheItem::SpeechAudio, 500);
    fs::write(cache.partial_path(&c, CacheItem::Proxy).unwrap(), vec![0u8; 300]).unwrap();
    // Something that is not a source folder is ignored.
    fs::write(dir.0.join("stray.txt"), b"hello").unwrap();
    assert_eq!(cache.usage_bytes().unwrap(), 1824);
    assert_eq!(cache.source_bytes(&a).unwrap(), 1024);

    let removed = cache.clear(std::slice::from_ref(&c)).unwrap();
    assert_eq!(removed, vec![a.clone(), b.clone()]);
    assert_eq!(cache.usage_bytes().unwrap(), 300);
    assert!(!cache.source_dir(&a).unwrap().exists());
    assert!(cache.source_dir(&c).unwrap().exists());
    assert!(dir.0.join("stray.txt").exists());
}

#[test]
fn limit_removes_least_recently_used_and_nothing_in_use() {
    let dir = TempDir::new("limit");
    let cache = Cache::new(&dir.0);
    let (oldest, old, recent, newest) = (id(10), id(11), id(12), id(13));
    for s in [&oldest, &old, &recent, &newest] {
        put(&cache, s, CacheItem::Proxy, 1000);
    }
    used_at(&cache, &oldest, 1_000);
    used_at(&cache, &old, 2_000);
    used_at(&cache, &recent, 3_000);
    used_at(&cache, &newest, 4_000);
    let total = cache.usage_bytes().unwrap();

    // Within the limit: nothing happens.
    assert!(cache.enforce_limit(total, &[]).unwrap().is_empty());

    // Over by a little, with the oldest in use: the next oldest goes, and only it.
    let removed = cache.enforce_limit(total - 1, std::slice::from_ref(&oldest)).unwrap();
    assert_eq!(removed, vec![old.clone()]);
    assert!(cache.source_dir(&oldest).unwrap().exists());
    assert!(!cache.source_dir(&old).unwrap().exists());

    // Touching a source makes it the most recently used.
    cache.touch(&oldest).unwrap();
    let left = cache.usage_bytes().unwrap();
    let removed = cache.enforce_limit(left - 1, &[]).unwrap();
    assert_eq!(removed, vec![recent.clone()]);

    // A limit nothing can meet removes everything not in use, then stops.
    let removed = cache.enforce_limit(0, std::slice::from_ref(&newest)).unwrap();
    assert_eq!(removed, vec![oldest.clone()]);
    let left: Vec<_> = cache.sources().unwrap().into_iter().map(|s| s.source_id).collect();
    assert_eq!(left, vec![newest.clone()]);
}

#[test]
fn never_touched_sources_fall_back_to_file_times() {
    let dir = TempDir::new("mtime");
    let cache = Cache::new(&dir.0);
    let (a, b) = (id(20), id(21));
    put(&cache, &a, CacheItem::Proxy, 100);
    put(&cache, &b, CacheItem::Proxy, 100);
    let old = SystemTime::now() - std::time::Duration::from_secs(86_400);
    fs::File::options().write(true).open(cache.item_path(&a, CacheItem::Proxy).unwrap()).unwrap().set_modified(old).unwrap();
    let removed = cache.enforce_limit(150, &[]).unwrap();
    assert_eq!(removed, vec![a]);
}

#[test]
fn a_source_with_an_open_file_is_skipped_not_fatal() {
    let dir = TempDir::new("open");
    let cache = Cache::new(&dir.0);
    let (a, b) = (id(30), id(31));
    put(&cache, &a, CacheItem::Proxy, 1000);
    put(&cache, &b, CacheItem::Proxy, 1000);
    used_at(&cache, &a, 1);
    used_at(&cache, &b, 2);
    // On Windows a file opened without delete sharing cannot be deleted.
    let mut open = fs::OpenOptions::new();
    open.read(true);
    #[cfg(windows)]
    std::os::windows::fs::OpenOptionsExt::share_mode(&mut open, 1 /* FILE_SHARE_READ */);
    let held = open.open(cache.item_path(&a, CacheItem::Proxy).unwrap()).unwrap();
    let removed = cache.enforce_limit(1500, &[]).unwrap();
    let a_after = cache.sources().unwrap().into_iter().find(|s| s.source_id == a);
    drop(held);
    if cfg!(windows) {
        assert_eq!(removed, vec![b.clone()], "the open source is skipped and the next one goes");
        let a_after = a_after.expect("the open source is still there");
        assert_eq!(a_after.last_used_millis, 1, "a partly removed source keeps its last-use time");
        assert_eq!(a_after.bytes, 1000 + 1, "only the open proxy and the restored marker are left");
    } else {
        assert_eq!(removed, vec![a.clone()]);
    }
}

#[test]
fn default_root_is_under_local_app_data() {
    let root = default_cache_root();
    assert!(root.ends_with(Path::new("Roughcut").join("cache")));
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        assert!(root.starts_with(local));
    }
}

#[test]
fn the_work_folder_is_never_a_source_and_is_emptied_at_start_up() {
    let t = TempDir::new("work");
    let cache = Cache::new(&t.0);
    put(&cache, &id(1), CacheItem::Proxy, 10);
    let work = cache.work_dir();
    assert!(work.starts_with(cache.root()));
    fs::create_dir_all(work.join("rc-export-1").join("inner")).unwrap();
    fs::write(work.join("rc-export-1").join("piece_00000.mp4"), vec![1u8; 500]).unwrap();
    fs::write(work.join("stray.bin"), vec![1u8; 5]).unwrap();
    let ids: Vec<SourceId> = cache.sources().unwrap().into_iter().map(|s| s.source_id).collect();
    assert_eq!(ids, vec![id(1)], "the work folder is not listed as a source");
    assert_eq!(cache.usage_bytes().unwrap(), 10);
    assert!(cache.clear(&[]).unwrap().contains(&id(1)));
    assert!(work.exists(), "clear() leaves the work folder alone");
    cache.clear_work_dir().unwrap();
    assert!(work.is_dir());
    assert_eq!(fs::read_dir(&work).unwrap().count(), 0);
    // A cache without a work folder is fine too.
    Cache::new(t.0.join("none")).clear_work_dir().unwrap();
}
