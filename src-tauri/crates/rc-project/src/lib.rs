//! Roughcut core module `project` (project files).
//!
//! Responsibility (spec 3.3): Creates, lists, reads, saves and removes project files. Writes
//! are atomic. Upgrades older files. Only this module writes project files (spec 3.6 rule 5).
//!
//! Layout (spec 2.4.9), under the projects root (`%APPDATA%\Roughcut\projects`):
//!
//! ```text
//! <project id>/project.json       the project (rc_types::Project)
//! <project id>/project.json.bak   the version before the last save (read if project.json is damaged)
//! <project id>/project.v<N>.json  the original of a file upgraded from schema version N
//! ```
//!
//! Every write goes to a temporary file that is flushed and then renamed over
//! `project.json`, so an interruption at any point leaves a complete, readable project.
//! `edit` is written by the core only once, by [`ProjectStore::create`] (spec 3.4 rule 5);
//! afterwards only [`ProjectStore::save_edit`] replaces it, with what the interface sends.
//!
//! May use: `source` (spec 3.3, 3.6).

#[path = "../../rc-cache/src/atomic_file.rs"]
mod atomic_file;
mod migrate;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use rc_source::time::{format_iso_millis, parse_iso_millis, unix_millis_now};
use rc_source::Probe;
use rc_types::{
    first_clip_end, AppError, Clip, EditDocument, EditState, ErrorCode, ExportResult, Project, ProjectId,
    ProjectSummary, SessionState, SourceId, SourceRef, PROJECT_SCHEMA_VERSION,
};
use serde_json::{Map, Value};

/// The project file's name inside its folder.
pub const PROJECT_FILE: &str = "project.json";

/// `%APPDATA%\Roughcut\projects`, the real projects root of spec 2.4.9.
pub fn default_projects_root() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("AppData").join("Roaming")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("Roughcut").join("projects")
}

/// The project store, rooted at a folder (the real one is [`default_projects_root`]; tests
/// use a temporary folder). Share one per root: it serialises changes to project files.
#[derive(Debug)]
pub struct ProjectStore {
    root: PathBuf,
    lock: Mutex<()>,
}

impl ProjectStore {
    /// A store rooted at `root`. The folder is created when the first project is.
    pub fn new(root: impl Into<PathBuf>) -> ProjectStore {
        ProjectStore { root: root.into(), lock: Mutex::new(()) }
    }

    /// The projects root.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The folder of one project.
    pub fn project_dir(&self, id: &str) -> Result<PathBuf, AppError> {
        check_project_id(id)?;
        Ok(self.root.join(id))
    }

    /// Creates a project from probed sources (spec 3.5.4 `create_project`): named after the
    /// first file, on the frame grid of the first source, with one clip per source
    /// `[0, first_clip_end(duration))` in the order given. Repeats of a source are dropped.
    /// This is the only time the core writes `edit`.
    pub fn create(&self, sources: Vec<SourceRef>) -> Result<Project, AppError> {
        let mut unique: Vec<SourceRef> = Vec::with_capacity(sources.len());
        for s in sources {
            if !unique.iter().any(|u| u.id == s.id) {
                unique.push(s);
            }
        }
        let first = unique.first().ok_or_else(|| AppError::internal("No files were given."))?;
        let frame_rate = first.media.video.frame_rate;
        if frame_rate.num == 0 || frame_rate.den == 0 {
            return Err(AppError::new(ErrorCode::SourceUnreadable, "The first file has no usable frame rate.")
                .with_detail(first.path.clone()));
        }
        let name = Path::new(&first.path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "Untitled".into());
        let clips: Vec<Clip> = unique
            .iter()
            .filter_map(|s| first_clip_end(s.media.duration, frame_rate).map(|end| (s, end)))
            .enumerate()
            .map(|(i, (s, end))| Clip { id: format!("clip-{}", i + 1), source_id: s.id.clone(), start: 0, end })
            .collect();

        let _guard = self.guard();
        fs::create_dir_all(&self.root).map_err(|e| io_err("create the projects folder", &self.root, e))?;
        let (id, dir) = self.claim_new_folder()?;
        let now = format_iso_millis(unix_millis_now());
        let project = Project {
            schema_version: PROJECT_SCHEMA_VERSION,
            id,
            name,
            created_at: now.clone(),
            updated_at: now,
            frame_rate,
            sources: unique,
            edit: EditDocument { current: EditState { clips, dismissed: Vec::new() }, undo: Vec::new(), redo: Vec::new() },
            session: SessionState::default(),
            last_export: None,
        };
        if let Err(e) = write_project(&dir, &project, &mut |_| Ok(())) {
            let _ = fs::remove_dir_all(&dir);
            return Err(e);
        }
        Ok(project)
    }

    /// [`ProjectStore::create`] from file paths, fingerprinting and probing each one.
    pub fn create_from_paths(&self, paths: &[PathBuf], probe: &dyn Probe) -> Result<Project, AppError> {
        self.create(rc_source::source_refs_from_paths(paths, probe)?)
    }

    /// One summary per readable project, most recently updated first (the Home list).
    /// Projects that cannot be read (damaged, or made by a newer Roughcut) are left out.
    /// A source counts as missing when no file is at its recorded path (no file is read).
    pub fn list(&self) -> Result<Vec<ProjectSummary>, AppError> {
        let entries = match fs::read_dir(&self.root) {
            Ok(e) => e,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(io_err("list the projects", &self.root, e)),
        };
        let mut ids: Vec<String> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|e| e.file_name().to_str().map(str::to_owned))
            .filter(|id| check_project_id(id).is_ok())
            .collect();
        ids.sort();
        let mut out = Vec::new();
        for id in ids {
            let project = {
                let _guard = self.guard();
                read_project(&self.root.join(&id))
            };
            if let Ok(p) = project {
                out.push(summarize(&p, |s| !rc_source::file_present(s)));
            }
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.id.cmp(&b.id)));
        Ok(out)
    }

    /// Reads a project, upgrading an older file (and saving the upgrade) and recovering
    /// from a damaged file with the previous version. A file from a newer Roughcut is refused.
    pub fn read(&self, id: &str) -> Result<Project, AppError> {
        let dir = self.project_dir(id)?;
        let _guard = self.guard();
        read_project(&dir)
    }

    /// Replaces `edit` and `session` with what the interface sends and bumps `updatedAt`
    /// (spec 3.5.4 `save_edit`). Nothing else changes.
    pub fn save_edit(&self, id: &str, edit: EditDocument, session: SessionState) -> Result<(), AppError> {
        self.change(id, |p| {
            p.edit = edit;
            p.session = session;
            Ok(())
        })
        .map(|_| ())
    }

    /// Renames a project (spec 3.5.4 `rename_project`). Surrounding spaces are dropped;
    /// an empty name is refused.
    pub fn rename(&self, id: &str, name: &str) -> Result<Project, AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::internal("A project name cannot be empty."));
        }
        let name: String = name.chars().filter(|c| !c.is_control()).take(200).collect();
        self.change(id, |p| {
            p.name = name;
            Ok(())
        })
    }

    /// Deletes the project's folder (spec 3.5.4 `remove_project`). Footage is never
    /// touched: only `<root>/<id>` is removed. Removing a project that is not there is not
    /// an error.
    pub fn remove(&self, id: &str) -> Result<(), AppError> {
        let dir = self.project_dir(id)?;
        let _guard = self.guard();
        match fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_err("remove the project", &dir, e)),
        }
    }

    /// Adds probed sources to a project (spec 3.5.4 `add_sources`) and returns those that
    /// were new (a source already in the project is not added twice). `edit` is not
    /// changed: the interface appends their clips (spec 3.4 rule 5).
    pub fn add_sources(&self, id: &str, sources: Vec<SourceRef>) -> Result<Vec<SourceRef>, AppError> {
        let mut added = Vec::new();
        self.change(id, |p| {
            for s in sources {
                if !p.sources.iter().any(|x| x.id == s.id) && !added.iter().any(|x: &SourceRef| x.id == s.id) {
                    added.push(s);
                }
            }
            p.sources.extend(added.iter().cloned());
            Ok(())
        })?;
        Ok(added)
    }

    /// [`ProjectStore::add_sources`] from file paths, fingerprinting and probing each one.
    pub fn add_sources_from_paths(&self, id: &str, paths: &[PathBuf], probe: &dyn Probe) -> Result<Vec<SourceRef>, AppError> {
        let refs = rc_source::source_refs_from_paths(paths, probe)?;
        self.add_sources(id, refs)
    }

    /// Records the last finished export (shown on the Home list).
    pub fn record_export(&self, id: &str, result: ExportResult) -> Result<(), AppError> {
        self.change(id, |p| {
            p.last_export = Some(result);
            Ok(())
        })
        .map(|_| ())
    }

    /// "Locate file" (spec 3.5.4 `locate_source`): checks that `new_path` holds the same
    /// file (same fingerprint) and records it as the source's location. Returns the updated
    /// `SourceRef`. A different file is refused with `source_mismatch` and nothing changes.
    pub fn update_source_path(&self, id: &str, source_id: &SourceId, new_path: &Path) -> Result<SourceRef, AppError> {
        let path = rc_source::verify_relocated(source_id, new_path)?;
        let project = self.change(id, |p| {
            let s = p
                .sources
                .iter_mut()
                .find(|s| &s.id == source_id)
                .ok_or_else(|| AppError::internal(format!("Source {source_id} is not in this project.")))?;
            s.path = path.to_string_lossy().into_owned();
            Ok(())
        })?;
        project
            .sources
            .into_iter()
            .find(|s| &s.id == source_id)
            .ok_or_else(|| AppError::internal("source vanished while saving"))
    }

    /// Reads, changes and writes a project under the lock, bumping `updatedAt`.
    fn change(&self, id: &str, f: impl FnOnce(&mut Project) -> Result<(), AppError>) -> Result<Project, AppError> {
        self.change_with_hook(id, f, &mut |_| Ok(()))
    }

    fn change_with_hook(
        &self,
        id: &str,
        f: impl FnOnce(&mut Project) -> Result<(), AppError>,
        hook: &mut dyn FnMut(atomic_file::Step) -> io::Result<()>,
    ) -> Result<Project, AppError> {
        let dir = self.project_dir(id)?;
        let _guard = self.guard();
        let mut project = read_project(&dir)?;
        f(&mut project)?;
        project.updated_at = next_timestamp(&project.updated_at);
        write_project(&dir, &project, hook)?;
        Ok(project)
    }

    fn guard(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Makes a new, empty project folder with a fresh id.
    fn claim_new_folder(&self) -> Result<(ProjectId, PathBuf), AppError> {
        for _ in 0..100 {
            let id = new_project_id();
            let dir = self.root.join(&id);
            match fs::create_dir(&dir) {
                Ok(()) => return Ok((id, dir)),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(io_err("create the project folder", &dir, e)),
            }
        }
        Err(AppError::internal("Could not find a free project id."))
    }
}

/// The Home-list row for a project. `is_missing` says whether a source's file is gone.
pub fn summarize(project: &Project, is_missing: impl Fn(&SourceRef) -> bool) -> ProjectSummary {
    ProjectSummary {
        id: project.id.clone(),
        name: project.name.clone(),
        raw_duration: project.sources.iter().map(|s| s.media.duration).sum(),
        kept_duration: project.edit.current.clips.iter().map(|c| c.end - c.start).sum(),
        updated_at: project.updated_at.clone(),
        last_exported_at: project.last_export.as_ref().map(|e| e.finished_at.clone()),
        missing_sources: u32::try_from(project.sources.iter().filter(|s| is_missing(s)).count()).unwrap_or(u32::MAX),
    }
}

/// Project ids become folder names: letters, digits, `-` and `_` only, 1 to 64 characters.
fn check_project_id(id: &str) -> Result<(), AppError> {
    let ok = !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok { Ok(()) } else { Err(AppError::internal(format!("Not a project id: {id:?}"))) }
}

/// 16 hex digits, mixed from the clock, the process and a counter.
fn new_project_id() -> ProjectId {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seed = nanos ^ (u64::from(std::process::id()) << 40) ^ COUNTER.fetch_add(1, Ordering::Relaxed).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    // splitmix64 finaliser
    let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    format!("{:016x}", z ^ (z >> 31))
}

/// Now, but always strictly after `previous`, so the newest save sorts first even when two
/// saves land in the same millisecond or the clock steps back.
fn next_timestamp(previous: &str) -> String {
    let now = unix_millis_now();
    let at = match parse_iso_millis(previous) {
        Some(prev) if prev >= now => prev + 1,
        _ => now,
    };
    format_iso_millis(at)
}

/// What one candidate file held.
enum Parsed {
    Ok { project: Box<Project>, upgraded_from: Option<u32> },
    Newer(u32),
    Damaged(String),
}

fn parse(bytes: &[u8]) -> Parsed {
    let doc: Map<String, Value> = match serde_json::from_slice(bytes) {
        Ok(Value::Object(m)) => m,
        Ok(_) => return Parsed::Damaged("not a JSON object".into()),
        Err(e) => return Parsed::Damaged(e.to_string()),
    };
    let mut doc = doc;
    let from = match migrate::version_of(&doc) {
        Ok(migrate::Version::Newer(v)) => return Parsed::Newer(v),
        Ok(migrate::Version::Known(v)) => v,
        Err(e) => return Parsed::Damaged(e),
    };
    if from < PROJECT_SCHEMA_VERSION
        && let Err(e) = migrate::upgrade(&mut doc, from)
    {
        return Parsed::Damaged(e);
    }
    match serde_json::from_value::<Project>(Value::Object(doc)) {
        Ok(project) => Parsed::Ok { project: Box::new(project), upgraded_from: (from < PROJECT_SCHEMA_VERSION).then_some(from) },
        Err(e) => Parsed::Damaged(e.to_string()),
    }
}

fn newer_error(dir: &Path, v: u32) -> AppError {
    AppError::internal("This project was saved by a newer version of Roughcut. Update Roughcut to open it.")
        .with_detail(format!("{}: schemaVersion {v}, this version reads up to {PROJECT_SCHEMA_VERSION}", dir.display()))
}

/// Reads `<dir>/project.json`, falling back to the backup when it is missing or damaged
/// (and then repairing it), and saving an upgraded copy of an older file.
fn read_project(dir: &Path) -> Result<Project, AppError> {
    let path = dir.join(PROJECT_FILE);
    let backup = atomic_file::backup_path(&path);
    let primary = atomic_file::read_optional(&path).map_err(|e| io_err("read the project", &path, e))?;
    let mut damage = None;
    if let Some(bytes) = &primary {
        match parse(bytes) {
            Parsed::Ok { project, upgraded_from } => {
                if let Some(from) = upgraded_from {
                    keep_original(dir, from, bytes);
                    // Best effort: the upgraded project is usable even if it cannot be saved
                    // now; the next change saves it.
                    let _ = write_project(dir, &project, &mut |_| Ok(()));
                }
                return Ok(*project);
            }
            Parsed::Newer(v) => return Err(newer_error(dir, v)),
            Parsed::Damaged(why) => damage = Some(why),
        }
    }
    let fallback = atomic_file::read_optional(&backup).map_err(|e| io_err("read the project", &backup, e))?;
    match (fallback, damage) {
        (Some(bytes), _) => match parse(&bytes) {
            Parsed::Ok { project, upgraded_from } => {
                if let Some(from) = upgraded_from {
                    keep_original(dir, from, &bytes);
                }
                // Put a good file back under the real name, without replacing the backup.
                let encoded = encode(&project)?;
                atomic_file::write_atomic(&path, &encoded, false).map_err(|e| io_err("repair the project", &path, e))?;
                Ok(*project)
            }
            Parsed::Newer(v) => Err(newer_error(dir, v)),
            Parsed::Damaged(why) => Err(AppError::internal("The project file is damaged.").with_detail(format!("{}: {why}", path.display()))),
        },
        (None, Some(why)) => Err(AppError::internal("The project file is damaged.").with_detail(format!("{}: {why}", path.display()))),
        (None, None) => Err(AppError::internal("There is no such project.").with_detail(dir.display().to_string())),
    }
}

/// Keeps the original bytes of a file upgraded from version `from` as `project.v<from>.json`.
fn keep_original(dir: &Path, from: u32, bytes: &[u8]) {
    let p = dir.join(format!("project.v{from}.json"));
    if !p.exists() {
        let _ = atomic_file::write_atomic(&p, bytes, false);
    }
}

fn encode(project: &Project) -> Result<Vec<u8>, AppError> {
    serde_json::to_vec_pretty(project).map_err(|e| AppError::internal(format!("Could not encode the project: {e}")))
}

fn write_project(dir: &Path, project: &Project, hook: &mut dyn FnMut(atomic_file::Step) -> io::Result<()>) -> Result<(), AppError> {
    let path = dir.join(PROJECT_FILE);
    let bytes = encode(project)?;
    atomic_file::write_atomic_with_hook(&path, &bytes, true, hook).map_err(|e| io_err("save the project", &path, e))
}

fn io_err(what: &str, path: &Path, e: io::Error) -> AppError {
    let code = if e.kind() == io::ErrorKind::StorageFull { ErrorCode::DiskFull } else { ErrorCode::Internal };
    AppError::new(code, format!("Could not {what}.")).with_detail(format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests;
