//! Roughcut core module `cache` (the per-source cache folder and its size limit).
//!
//! Responsibility (spec 3.3): Decides where each cached item lives, reports sizes, removes
//! the least recently used sources when over the limit. Only this module chooses cache paths
//! (spec 3.6 rule 5).
//!
//! Layout, under the cache root (spec 2.4.9, `%LOCALAPPDATA%\Roughcut\cache`):
//!
//! ```text
//! <source fingerprint>/
//!   proxy.mp4          CacheItem::Proxy        (written as proxy.partial.mp4, then finished)
//!   speech.wav         CacheItem::SpeechAudio  16 kHz mono s16 WAV for the transcriber
//!   waveform.bin       CacheItem::Waveform     layout of rc_types::WaveformHeader
//!   transcript.json    CacheItem::Transcript   rc_types::Transcript, replaced atomically
//!   suggestions.json   CacheItem::Suggestions  rc_types::SuggestionSet, replaced atomically
//!   last-used          when the source was last used (for the size limit)
//! .work/               temporary working folders (an export's pieces); never a source,
//!                      emptied at start-up ([`Cache::clear_work_dir`])
//! ```
//!
//! A media file is first written under its "partial" name ([`Cache::partial_path`]) and
//! renamed to its final name by [`Cache::finish`] only when complete, so a half-written item
//! is never mistaken for a finished one. JSON items are replaced atomically.
//!
//! May use: nothing (spec 3.3, 3.6). Shared data types come from `rc-types`.

#[path = "atomic_file.rs"]
mod atomic_file;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rc_types::{
    AppError, SourceId, SuggestionSet, Transcript, SUGGESTION_SET_SCHEMA_VERSION, TRANSCRIPT_SCHEMA_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};

/// Name of the file that records when a source was last used.
const LAST_USED_FILE: &str = "last-used";
/// The temporary work folder's name; the dot keeps it from ever being a source id.
const WORK_DIR: &str = ".work";

/// One cached item of a source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CacheItem {
    /// The editing proxy (H.264 MP4).
    Proxy,
    /// The audio extracted for speech recognition (16 kHz mono 16-bit WAV).
    SpeechAudio,
    /// The waveform file (`rc_types::write_waveform` layout).
    Waveform,
    /// The transcript JSON (`rc_types::Transcript`).
    Transcript,
    /// The suggestion set JSON (`rc_types::SuggestionSet`).
    Suggestions,
}

impl CacheItem {
    /// Every item, in a fixed order.
    pub const ALL: [CacheItem; 5] =
        [CacheItem::Proxy, CacheItem::SpeechAudio, CacheItem::Waveform, CacheItem::Transcript, CacheItem::Suggestions];

    /// The finished item's file name, e.g. `proxy.mp4`.
    pub fn file_name(self) -> &'static str {
        match self {
            CacheItem::Proxy => "proxy.mp4",
            CacheItem::SpeechAudio => "speech.wav",
            CacheItem::Waveform => "waveform.bin",
            CacheItem::Transcript => "transcript.json",
            CacheItem::Suggestions => "suggestions.json",
        }
    }

    /// The in-progress file name, e.g. `proxy.partial.mp4` (the extension is kept so tools
    /// such as FFmpeg still recognise the format).
    pub fn partial_file_name(self) -> &'static str {
        match self {
            CacheItem::Proxy => "proxy.partial.mp4",
            CacheItem::SpeechAudio => "speech.partial.wav",
            CacheItem::Waveform => "waveform.partial.bin",
            CacheItem::Transcript => "transcript.partial.json",
            CacheItem::Suggestions => "suggestions.partial.json",
        }
    }
}

/// One source's folder in the cache.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedSource {
    pub source_id: SourceId,
    /// Everything in its folder, finished or not.
    pub bytes: u64,
    /// Milliseconds since the Unix epoch when it was last used ([`Cache::touch`]), or the
    /// newest file time in its folder when it was never touched.
    pub last_used_millis: i64,
}

/// `%LOCALAPPDATA%\Roughcut\cache`, the real cache root of spec 2.4.9.
pub fn default_cache_root() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("AppData").join("Local")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("Roughcut").join("cache")
}

/// The cache, rooted at a folder (the real one is [`default_cache_root`]; tests use a
/// temporary folder). Cheap to clone; holds no open files.
#[derive(Debug, Clone)]
pub struct Cache {
    root: PathBuf,
}

impl Cache {
    /// A cache rooted at `root`. The folder is created when first written to.
    pub fn new(root: impl Into<PathBuf>) -> Cache {
        Cache { root: root.into() }
    }

    /// The cache root.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The folder for one source (not created).
    pub fn source_dir(&self, source_id: &str) -> Result<PathBuf, AppError> {
        check_id(source_id)?;
        Ok(self.root.join(source_id))
    }

    /// The folder for temporary work that is not a cached item (an export's pieces), under
    /// the cache root. Its name cannot be a source id, so it is never listed, counted or
    /// removed as a source. Not created here.
    pub fn work_dir(&self) -> PathBuf {
        self.root.join(WORK_DIR)
    }

    /// Removes everything in [`Cache::work_dir`] (left by a run that was killed). Call it at
    /// start-up, before any work starts. Entries that cannot be removed now are left.
    pub fn clear_work_dir(&self) -> Result<(), AppError> {
        let dir = self.work_dir();
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(io_err("list the cache's work folder", &dir, e)),
        };
        for entry in entries.flatten() {
            let p = entry.path();
            let _ = if entry.file_type().is_ok_and(|t| t.is_dir()) { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
        }
        Ok(())
    }

    /// Where the finished `item` of a source lives (it may not exist yet).
    pub fn item_path(&self, source_id: &str, item: CacheItem) -> Result<PathBuf, AppError> {
        Ok(self.source_dir(source_id)?.join(item.file_name()))
    }

    /// Where a task writes `item` while it is in progress. Creates the source folder and
    /// removes any leftover partial file from an earlier, interrupted run.
    pub fn partial_path(&self, source_id: &str, item: CacheItem) -> Result<PathBuf, AppError> {
        let dir = self.source_dir(source_id)?;
        fs::create_dir_all(&dir).map_err(|e| io_err("create the cache folder", &dir, e))?;
        let p = dir.join(item.partial_file_name());
        remove_if_present(&p).map_err(|e| io_err("remove an unfinished cache file", &p, e))?;
        Ok(p)
    }

    /// Marks `item` finished: its partial file becomes the finished file (replacing any
    /// older one). Returns the finished path.
    pub fn finish(&self, source_id: &str, item: CacheItem) -> Result<PathBuf, AppError> {
        let dir = self.source_dir(source_id)?;
        let from = dir.join(item.partial_file_name());
        let to = dir.join(item.file_name());
        // Flushing needs write access on Windows.
        let file = fs::OpenOptions::new().write(true).open(&from).map_err(|e| io_err("open the finished cache file", &from, e))?;
        file.sync_all().map_err(|e| io_err("flush the cache file", &from, e))?;
        drop(file);
        fs::rename(&from, &to).map_err(|e| io_err("finish the cache file", &to, e))?;
        Ok(to)
    }

    /// Removes the partial file of `item`, if any (after a failed or cancelled task).
    pub fn discard_partial(&self, source_id: &str, item: CacheItem) -> Result<(), AppError> {
        let p = self.source_dir(source_id)?.join(item.partial_file_name());
        remove_if_present(&p).map_err(|e| io_err("remove an unfinished cache file", &p, e))
    }

    /// Whether the finished `item` exists. A partial file never counts.
    pub fn has(&self, source_id: &str, item: CacheItem) -> bool {
        self.item_path(source_id, item).is_ok_and(|p| p.is_file())
    }

    /// The finished items of a source, in [`CacheItem::ALL`] order.
    pub fn items(&self, source_id: &str) -> Vec<CacheItem> {
        CacheItem::ALL.into_iter().filter(|i| self.has(source_id, *i)).collect()
    }

    /// Removes one finished item (and its partial file), e.g. to rebuild it.
    pub fn remove_item(&self, source_id: &str, item: CacheItem) -> Result<(), AppError> {
        let p = self.item_path(source_id, item)?;
        remove_if_present(&p).map_err(|e| io_err("remove a cache file", &p, e))?;
        self.discard_partial(source_id, item)
    }

    /// Records that a source is being used now (opening a project, serving its proxy), so
    /// the size limit removes it last.
    pub fn touch(&self, source_id: &str) -> Result<(), AppError> {
        let p = self.source_dir(source_id)?.join(LAST_USED_FILE);
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        atomic_file::write_atomic(&p, now.to_string().as_bytes(), false).map_err(|e| io_err("record cache use", &p, e))
    }

    /// Every source folder in the cache with its size and last use.
    pub fn sources(&self) -> Result<Vec<CachedSource>, AppError> {
        let entries = match fs::read_dir(&self.root) {
            Ok(e) => e,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(io_err("list the cache", &self.root, e)),
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
            if check_id(&name).is_err() || !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let dir = entry.path();
            let (bytes, newest) = folder_size(&dir);
            let last_used_millis = fs::read_to_string(dir.join(LAST_USED_FILE))
                .ok()
                .and_then(|s| s.trim().parse::<i64>().ok())
                .unwrap_or(newest);
            out.push(CachedSource { source_id: name, bytes, last_used_millis });
        }
        out.sort_by(|a, b| a.source_id.cmp(&b.source_id));
        Ok(out)
    }

    /// Bytes used by the whole cache.
    pub fn usage_bytes(&self) -> Result<u64, AppError> {
        Ok(self.sources()?.iter().map(|s| s.bytes).sum())
    }

    /// Bytes used by one source.
    pub fn source_bytes(&self, source_id: &str) -> Result<u64, AppError> {
        Ok(folder_size(&self.source_dir(source_id)?).0)
    }

    /// Removes one source's whole folder. `Ok(false)` when it could not be removed
    /// completely (a file in it is open, e.g. a proxy being played).
    /// A partly removed folder keeps its last-use time, so the size limit still sees its age.
    pub fn remove_source(&self, source_id: &str) -> Result<bool, AppError> {
        Ok(self.remove_source_dir(source_id)?.is_none())
    }

    /// Removes a source's folder. `None` when it is gone; otherwise the bytes still in it.
    /// Windows deletes files one by one and stops at the first that is open, so the files
    /// before it (often the `last-used` marker and a big proxy) are already gone: the marker
    /// is written back with the time it had, so the source keeps its place in the LRU order.
    fn remove_source_dir(&self, source_id: &str) -> Result<Option<u64>, AppError> {
        let dir = self.source_dir(source_id)?;
        let marker = dir.join(LAST_USED_FILE);
        let last_used = match fs::read_to_string(&marker).ok().and_then(|s| s.trim().parse::<i64>().ok()) {
            Some(ms) => ms,
            None => folder_size(&dir).1,
        };
        match fs::remove_dir_all(&dir) {
            Ok(()) => return Ok(None),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) if !dir.exists() => return Ok(None),
            Err(_) => {}
        }
        if !marker.exists() {
            // Best effort: failing to restore the marker must not turn a partial removal into
            // an error; the folder's newest file time is then used instead.
            let _ = atomic_file::write_atomic(&marker, last_used.to_string().as_bytes(), false);
        }
        Ok(Some(folder_size(&dir).0))
    }

    /// Removes every source's folder except those in `in_use`. Returns the ids removed.
    /// Folders that cannot be removed right now are left and not reported.
    pub fn clear(&self, in_use: &[SourceId]) -> Result<Vec<SourceId>, AppError> {
        let mut removed = Vec::new();
        for s in self.sources()? {
            if in_use.contains(&s.source_id) {
                continue;
            }
            if self.remove_source(&s.source_id)? {
                removed.push(s.source_id);
            }
        }
        Ok(removed)
    }

    /// Keeps the cache within `limit_bytes` by removing whole sources, least recently used
    /// first, never touching those in `in_use`. Returns the ids removed, in removal order.
    /// The cache may stay over the limit when what is left is in use. A source that could only
    /// be partly removed (an open file) is not reported, but the bytes freed from it count.
    pub fn enforce_limit(&self, limit_bytes: u64, in_use: &[SourceId]) -> Result<Vec<SourceId>, AppError> {
        let mut sources = self.sources()?;
        let mut total: u64 = sources.iter().map(|s| s.bytes).sum();
        sources.sort_by(|a, b| a.last_used_millis.cmp(&b.last_used_millis).then_with(|| a.source_id.cmp(&b.source_id)));
        let mut removed = Vec::new();
        for s in sources {
            if total <= limit_bytes {
                break;
            }
            if in_use.contains(&s.source_id) {
                continue;
            }
            match self.remove_source_dir(&s.source_id)? {
                None => {
                    total = total.saturating_sub(s.bytes);
                    removed.push(s.source_id);
                }
                // Partly removed: count what was freed before deciding whether to go on.
                Some(remaining) => total = total.saturating_sub(s.bytes.saturating_sub(remaining)),
            }
        }
        Ok(removed)
    }

    /// The cached transcript, as far as it has got. `None` when there is none, or when the
    /// file is unreadable, belongs to another source or has a newer schema (the cache is
    /// rebuilt in that case).
    pub fn read_transcript(&self, source_id: &str) -> Result<Option<Transcript>, AppError> {
        let t: Option<Transcript> = self.read_json(source_id, CacheItem::Transcript)?;
        Ok(t.filter(|t| t.source_id == source_id && t.schema_version <= TRANSCRIPT_SCHEMA_VERSION))
    }

    /// Writes the transcript of `transcript.source_id`, replacing the old one atomically.
    pub fn write_transcript(&self, transcript: &Transcript) -> Result<PathBuf, AppError> {
        self.write_json(&transcript.source_id, CacheItem::Transcript, transcript)
    }

    /// The cached suggestion set, with the same rules as [`Cache::read_transcript`].
    pub fn read_suggestions(&self, source_id: &str) -> Result<Option<SuggestionSet>, AppError> {
        let s: Option<SuggestionSet> = self.read_json(source_id, CacheItem::Suggestions)?;
        Ok(s.filter(|s| s.source_id == source_id && s.schema_version <= SUGGESTION_SET_SCHEMA_VERSION))
    }

    /// Writes the suggestion set of `set.source_id`, replacing the old one atomically.
    pub fn write_suggestions(&self, set: &SuggestionSet) -> Result<PathBuf, AppError> {
        self.write_json(&set.source_id, CacheItem::Suggestions, set)
    }

    fn read_json<T: DeserializeOwned>(&self, source_id: &str, item: CacheItem) -> Result<Option<T>, AppError> {
        let p = self.item_path(source_id, item)?;
        let Some(bytes) = atomic_file::read_optional(&p).map_err(|e| io_err("read a cache file", &p, e))? else {
            return Ok(None);
        };
        Ok(serde_json::from_slice(&bytes).ok())
    }

    fn write_json<T: Serialize>(&self, source_id: &str, item: CacheItem, value: &T) -> Result<PathBuf, AppError> {
        let p = self.item_path(source_id, item)?;
        let bytes = serde_json::to_vec(value).map_err(|e| AppError::internal(format!("could not encode {}: {e}", item.file_name())))?;
        atomic_file::write_atomic(&p, &bytes, false).map_err(|e| io_err("write a cache file", &p, e))?;
        Ok(p)
    }
}

/// Source ids become folder names: only letters, digits, `-` and `_`, 1 to 64 characters.
fn check_id(id: &str) -> Result<(), AppError> {
    let ok = !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok { Ok(()) } else { Err(AppError::internal(format!("not a valid source id: {id:?}"))) }
}

/// Total bytes under `dir` and the newest modified time in it (Unix milliseconds).
fn folder_size(dir: &Path) -> (u64, i64) {
    let mut bytes = 0u64;
    let mut newest = 0i64;
    let Ok(entries) = fs::read_dir(dir) else { return (0, 0) };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            let (b, n) = folder_size(&entry.path());
            bytes += b;
            newest = newest.max(n);
        } else {
            bytes += meta.len();
            if let Some(ms) = meta.modified().ok().and_then(|m| m.duration_since(UNIX_EPOCH).ok()) {
                newest = newest.max(i64::try_from(ms.as_millis()).unwrap_or(i64::MAX));
            }
        }
    }
    (bytes, newest)
}

fn remove_if_present(p: &Path) -> io::Result<()> {
    match fs::remove_file(p) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn io_err(what: &str, path: &Path, e: io::Error) -> AppError {
    let code = if e.kind() == io::ErrorKind::StorageFull { rc_types::ErrorCode::DiskFull } else { rc_types::ErrorCode::Internal };
    AppError::new(code, format!("Could not {what}.")).with_detail(format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests;
