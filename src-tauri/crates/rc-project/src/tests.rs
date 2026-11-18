use super::*;
use atomic_file::Step;
use rc_types::{
    is_on_frame_grid, AudioTrackInfo, BitDepth, MediaInfo, PlaybackRate, Rational, SessionView, SourcePosition,
    SourceRange, VideoInfo,
};
use std::sync::Arc;

static N: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> TempDir {
        let n = N.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("rc-project-{tag}-{}-{n}", std::process::id()));
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

const NTSC: Rational = Rational { num: 30000, den: 1001 };

fn media(duration: i64, rate: Rational) -> MediaInfo {
    MediaInfo {
        duration,
        container: "mov,mp4,m4a,3gp,3g2,mj2".into(),
        video: VideoInfo {
            codec: "h264".into(),
            width: 3840,
            height: 2160,
            frame_rate: rate,
            variable_frame_rate: false,
            bit_depth: BitDepth::Eight,
            hdr: false,
        },
        audio_tracks: vec![AudioTrackInfo { index: 1, codec: "aac".into(), channels: 2, sample_rate: 48000, title: None }],
        speech_track: 1,
        direct_playable: true,
    }
}

/// A probe that reads the duration (in microseconds) and frame rate from the file's
/// first line, e.g. `30000000 30000/1001`, so tests use real files without FFmpeg.
struct TextProbe;
impl Probe for TextProbe {
    fn probe(&self, path: &Path) -> Result<MediaInfo, AppError> {
        let text = fs::read_to_string(path).map_err(|e| AppError::new(ErrorCode::SourceUnreadable, e.to_string()))?;
        let line = text.lines().next().unwrap_or_default();
        let mut parts = line.split_whitespace();
        let duration: i64 = parts.next().and_then(|d| d.parse().ok()).ok_or_else(|| AppError::new(ErrorCode::SourceUnreadable, "no duration"))?;
        let (num, den) = parts.next().and_then(|r| r.split_once('/')).unwrap_or(("30000", "1001"));
        Ok(media(duration, Rational { num: num.parse().unwrap(), den: den.parse().unwrap() }))
    }
}

/// Writes a "recording" whose probe gives `duration` and `rate`, with distinct content.
fn footage(dir: &Path, name: &str, duration: i64, rate: &str) -> PathBuf {
    let p = dir.join(name);
    let filler: String = name.chars().cycle().take(4096).collect();
    fs::write(&p, format!("{duration} {rate}\n{filler}")).unwrap();
    p
}

struct Fixture {
    _dir: TempDir,
    store: ProjectStore,
    footage: PathBuf,
}

fn fixture(tag: &str) -> Fixture {
    let dir = TempDir::new(tag);
    let footage = dir.0.join("footage");
    fs::create_dir_all(&footage).unwrap();
    let store = ProjectStore::new(dir.0.join("projects"));
    Fixture { _dir: dir, store, footage }
}

fn on_disk(store: &ProjectStore, id: &str) -> Project {
    serde_json::from_slice(&fs::read(store.project_dir(id).unwrap().join(PROJECT_FILE)).unwrap()).unwrap()
}

fn edited(p: &Project) -> (EditDocument, SessionState) {
    let mut edit = p.edit.clone();
    edit.undo.push(edit.current.clone());
    let first = edit.current.clips[0].clone();
    edit.current.clips[0].end = rc_types::floor_to_frame(first.end / 2, p.frame_rate);
    edit.current.dismissed.push(SourceRange { source_id: first.source_id.clone(), start: 0, end: 1_000_000 });
    let session = SessionState {
        view: SessionView::Timeline,
        playhead: Some(SourcePosition { source_id: first.source_id, at: 2_000_000 }),
        playback_rate: PlaybackRate::X1_5,
        cut_text_hidden: true,
    };
    (edit, session)
}

#[test]
fn create_makes_one_clip_per_source_on_the_first_sources_grid() {
    let f = fixture("create");
    let a = footage(&f.footage, "Interview take 1.mp4", 30_000_000, "30000/1001");
    let b = footage(&f.footage, "b-roll.mov", 10_123_456, "60/1");
    let tiny = footage(&f.footage, "tiny.mp4", 20_000, "30/1");
    let p = f.store.create_from_paths(&[a.clone(), b.clone(), a.clone(), tiny], &TextProbe).unwrap();

    assert_eq!(p.schema_version, PROJECT_SCHEMA_VERSION);
    assert_eq!(p.name, "Interview take 1");
    assert_eq!(p.frame_rate, NTSC, "the first source sets the grid");
    assert_eq!(p.sources.len(), 3, "the repeated file is added once");
    assert_eq!(p.created_at, p.updated_at);
    assert!(parse_iso_millis(&p.created_at).is_some());
    assert_eq!(p.session, SessionState::default());
    assert!(p.edit.undo.is_empty() && p.edit.redo.is_empty() && p.edit.current.dismissed.is_empty());
    assert!(p.last_export.is_none());

    let clips = &p.edit.current.clips;
    assert_eq!(clips.len(), 2, "a source shorter than one frame gets no clip");
    assert_eq!(clips[0], Clip { id: "clip-1".into(), source_id: p.sources[0].id.clone(), start: 0, end: first_clip_end(30_000_000, NTSC).unwrap() });
    assert_eq!(clips[1].id, "clip-2");
    assert_eq!(clips[1].source_id, p.sources[1].id);
    assert_eq!(clips[1].end, first_clip_end(10_123_456, NTSC).unwrap());
    for c in clips {
        assert!(c.start < c.end);
        assert!(is_on_frame_grid(c.start, NTSC) && is_on_frame_grid(c.end, NTSC));
    }
    assert!(clips[1].end <= 10_123_456);

    assert_eq!(on_disk(&f.store, &p.id), p);
    assert_eq!(f.store.read(&p.id).unwrap(), p);
    assert!(f.store.project_dir(&p.id).unwrap().starts_with(f.store.root()));
}

#[test]
fn create_refuses_nothing_and_reports_missing_files() {
    let f = fixture("create-bad");
    assert!(f.store.create(Vec::new()).is_err());
    let e = f.store.create_from_paths(&[f.footage.join("gone.mp4")], &TextProbe).unwrap_err();
    assert_eq!(e.code, ErrorCode::SourceMissing);
    assert!(f.store.list().unwrap().is_empty());
}

#[test]
fn list_is_newest_first_with_durations_missing_sources_and_last_export() {
    let f = fixture("list");
    let a = footage(&f.footage, "a.mp4", 30_000_000, "30/1");
    let b = footage(&f.footage, "b.mp4", 12_000_000, "30/1");
    let pa = f.store.create_from_paths(&[a.clone(), b.clone()], &TextProbe).unwrap();
    let pb = f.store.create_from_paths(std::slice::from_ref(&b), &TextProbe).unwrap();

    let list = f.store.list().unwrap();
    assert_eq!(list.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec![pb.id.as_str(), pa.id.as_str()]);
    let sa = &list[1];
    assert_eq!(sa.name, "a");
    assert_eq!(sa.raw_duration, 42_000_000);
    assert_eq!(sa.kept_duration, 42_000_000);
    assert_eq!(sa.missing_sources, 0);
    assert_eq!(sa.last_exported_at, None);

    // Editing the older project moves it to the top and changes its kept duration.
    let (edit, session) = edited(&pa);
    let kept: i64 = edit.current.clips.iter().map(|c| c.end - c.start).sum();
    f.store.save_edit(&pa.id, edit, session).unwrap();
    f.store
        .record_export(&pa.id, ExportResult { path: "D:\\out.mp4".into(), duration: kept, bytes: 1234, took_seconds: 9.5, finished_at: "2026-11-13T10:00:00.000Z".into() })
        .unwrap();
    fs::rename(&b, f.footage.join("b-moved.mp4")).unwrap();

    let list = f.store.list().unwrap();
    assert_eq!(list[0].id, pa.id);
    assert_eq!(list[0].kept_duration, kept);
    assert_eq!(list[0].raw_duration, 42_000_000);
    assert_eq!(list[0].missing_sources, 1);
    assert_eq!(list[0].last_exported_at.as_deref(), Some("2026-11-13T10:00:00.000Z"));
    assert_eq!(list[1].missing_sources, 1);

    // Folders that are not projects are ignored.
    fs::create_dir_all(f.store.root().join("not a project")).unwrap();
    fs::create_dir_all(f.store.root().join("emptyfolder")).unwrap();
    assert_eq!(f.store.list().unwrap().len(), 2);
}

#[test]
fn save_edit_replaces_only_edit_and_session() {
    let f = fixture("save");
    let a = footage(&f.footage, "a.mp4", 30_000_000, "30000/1001");
    let p = f.store.create_from_paths(&[a], &TextProbe).unwrap();
    let mut previous = p.updated_at.clone();
    let (edit, session) = edited(&p);
    for _ in 0..5 {
        f.store.save_edit(&p.id, edit.clone(), session.clone()).unwrap();
        let now = f.store.read(&p.id).unwrap();
        assert!(now.updated_at > previous, "{} after {previous}", now.updated_at);
        previous = now.updated_at.clone();
        let mut expected = p.clone();
        expected.edit = edit.clone();
        expected.session = session.clone();
        expected.updated_at = now.updated_at.clone();
        assert_eq!(now, expected);
    }
    assert!(f.store.save_edit("0000000000000000", edit, session).is_err(), "unknown project");
}

#[test]
fn rename_add_sources_and_relocate() {
    let f = fixture("change");
    let a = footage(&f.footage, "a.mp4", 30_000_000, "30/1");
    let b = footage(&f.footage, "b.mp4", 5_000_000, "25/1");
    let p = f.store.create_from_paths(std::slice::from_ref(&a), &TextProbe).unwrap();

    let renamed = f.store.rename(&p.id, "  Launch video  ").unwrap();
    assert_eq!(renamed.name, "Launch video");
    assert!(f.store.rename(&p.id, "   ").is_err());
    assert_eq!(f.store.read(&p.id).unwrap().name, "Launch video");

    let added = f.store.add_sources_from_paths(&p.id, &[b.clone(), a.clone()], &TextProbe).unwrap();
    assert_eq!(added.len(), 1, "a source already in the project is not added again");
    let now = f.store.read(&p.id).unwrap();
    assert_eq!(now.sources.len(), 2);
    assert_eq!(now.edit, p.edit, "the core never changes edit after creating the project");
    assert_eq!(now.frame_rate, p.frame_rate);

    // The file moves: "Locate file" with the right file updates the path.
    let source_id = p.sources[0].id.clone();
    let moved_dir = f.footage.join("archive");
    fs::create_dir_all(&moved_dir).unwrap();
    let moved = moved_dir.join("a renamed.mp4");
    fs::rename(&a, &moved).unwrap();
    assert_eq!(f.store.list().unwrap()[0].missing_sources, 1);
    let r = f.store.update_source_path(&p.id, &source_id, &moved).unwrap();
    assert_eq!(Path::new(&r.path), moved.as_path());
    assert_eq!(r.id, source_id);
    assert_eq!(f.store.read(&p.id).unwrap().sources[0].path, r.path);
    assert_eq!(f.store.list().unwrap()[0].missing_sources, 0);

    // A different file is refused and nothing changes.
    let before = f.store.read(&p.id).unwrap();
    let e = f.store.update_source_path(&p.id, &source_id, &b).unwrap_err();
    assert_eq!(e.code, ErrorCode::SourceMismatch);
    assert_eq!(f.store.read(&p.id).unwrap(), before);
}

#[test]
fn remove_deletes_the_project_folder_and_never_footage() {
    let f = fixture("remove");
    let a = footage(&f.footage, "a.mp4", 30_000_000, "30/1");
    let keep = f.store.create_from_paths(std::slice::from_ref(&a), &TextProbe).unwrap();
    let gone = f.store.create_from_paths(std::slice::from_ref(&a), &TextProbe).unwrap();
    let dir = f.store.project_dir(&gone.id).unwrap();
    assert!(dir.exists());
    f.store.remove(&gone.id).unwrap();
    assert!(!dir.exists());
    assert!(a.exists(), "footage is untouched");
    assert_eq!(f.store.list().unwrap().iter().map(|s| s.id.clone()).collect::<Vec<_>>(), vec![keep.id.clone()]);
    f.store.remove(&gone.id).unwrap();
    assert!(f.store.read(&gone.id).is_err());
    // Ids that could escape the projects folder are refused.
    for bad in ["..", "..\\footage", "a/b", "C:\\", ""] {
        assert!(f.store.remove(bad).is_err(), "{bad:?}");
    }
    assert!(f.footage.exists() && a.exists());
}

#[test]
fn a_save_interrupted_at_any_point_leaves_the_previous_file_readable() {
    let all = [Step::TempCreated, Step::TempHalfWritten, Step::TempWritten, Step::TempSynced, Step::BackupKept, Step::Renamed];
    for step in all {
        let f = fixture("interrupt");
        let a = footage(&f.footage, "a.mp4", 30_000_000, "30/1");
        let p = f.store.create_from_paths(&[a], &TextProbe).unwrap();
        f.store.rename(&p.id, "Saved once").unwrap();
        let before = f.store.read(&p.id).unwrap();
        let (edit, session) = edited(&before);
        let r = f.store.change_with_hook(
            &p.id,
            |p| {
                p.edit = edit.clone();
                p.session = session.clone();
                Ok(())
            },
            &mut |s| if s == step { Err(io::Error::other("power cut")) } else { Ok(()) },
        );
        assert!(r.is_err(), "the write stops at {step:?}");

        // A fresh store, as after a restart.
        let reopened = ProjectStore::new(f.store.root());
        let now = reopened.read(&p.id).unwrap();
        if step == Step::Renamed {
            assert_eq!(now.edit, edit);
        } else {
            assert_eq!(now, before, "after a crash at {step:?}");
        }
        assert_eq!(reopened.list().unwrap().len(), 1, "leftover temporary files are not projects");
        // And saving works again.
        reopened.save_edit(&p.id, edit.clone(), session.clone()).unwrap();
        assert_eq!(reopened.read(&p.id).unwrap().edit, edit);
    }
}

#[test]
fn a_damaged_or_missing_file_falls_back_to_the_previous_version() {
    let f = fixture("damaged");
    let a = footage(&f.footage, "a.mp4", 30_000_000, "30/1");
    let p = f.store.create_from_paths(&[a], &TextProbe).unwrap();
    let saved_once = f.store.rename(&p.id, "First").unwrap();
    f.store.rename(&p.id, "Second").unwrap();
    let file = f.store.project_dir(&p.id).unwrap().join(PROJECT_FILE);

    // A torn write: the file stops in the middle.
    let bytes = fs::read(&file).unwrap();
    fs::write(&file, &bytes[..bytes.len() / 2]).unwrap();
    let recovered = f.store.read(&p.id).unwrap();
    assert_eq!(recovered, saved_once);
    assert_eq!(on_disk(&f.store, &p.id), saved_once, "the good version is put back");

    // A write cut off before anything reached the disk: an empty file.
    f.store.rename(&p.id, "Third").unwrap();
    fs::write(&file, b"").unwrap();
    assert_eq!(f.store.read(&p.id).unwrap().name, "First");

    // The file is gone entirely but the backup is there.
    f.store.rename(&p.id, "Fourth").unwrap();
    fs::remove_file(&file).unwrap();
    assert_eq!(f.store.read(&p.id).unwrap().name, "First");
    assert!(file.exists());
    assert_eq!(f.store.list().unwrap().len(), 1);

    // Both damaged: a clear error, not a panic.
    fs::write(&file, b"{").unwrap();
    fs::write(atomic_file::backup_path(&file), b"[").unwrap();
    let e = f.store.read(&p.id).unwrap_err();
    assert!(e.message.contains("damaged"), "{e:?}");
    assert!(f.store.list().unwrap().is_empty());
}

/// A version 0 file: the draft layout from before `schemaVersion` existed.
fn version0_json(source_path: &str, source_id: &str) -> String {
    serde_json::json!({
        "id": "legacy0000000001",
        "name": "Old project",
        "createdAt": "2026-01-02T03:04:05.000Z",
        "frameRate": { "num": 25, "den": 1 },
        "sources": [{
            "id": source_id,
            "path": source_path,
            "media": serde_json::to_value(media(8_000_000, Rational { num: 25, den: 1 })).unwrap()
        }],
        "edit": { "clips": [{ "id": "clip-1", "sourceId": source_id, "start": 0, "end": 8_000_000 }] }
    })
    .to_string()
}

#[test]
fn older_files_are_upgraded() {
    let f = fixture("upgrade");
    let dir = f.store.root().join("legacy0000000001");
    fs::create_dir_all(&dir).unwrap();
    let source_id = "0123456789abcdef0123456789abcdef";
    let original = version0_json("D:\\Footage\\old.mp4", source_id);
    fs::write(dir.join(PROJECT_FILE), &original).unwrap();

    let p = f.store.read("legacy0000000001").unwrap();
    assert_eq!(p.schema_version, PROJECT_SCHEMA_VERSION);
    assert_eq!(p.name, "Old project");
    assert_eq!(p.updated_at, "2026-01-02T03:04:05.000Z");
    assert_eq!(p.sources[0].added_at, "2026-01-02T03:04:05.000Z");
    assert_eq!(p.edit.current.clips, vec![Clip { id: "clip-1".into(), source_id: source_id.into(), start: 0, end: 8_000_000 }]);
    assert!(p.edit.current.dismissed.is_empty() && p.edit.undo.is_empty() && p.edit.redo.is_empty());
    assert_eq!(p.session, SessionState::default());

    // The upgrade is saved, and the original is kept beside it.
    assert_eq!(on_disk(&f.store, &p.id), p);
    assert_eq!(fs::read_to_string(dir.join("project.v0.json")).unwrap(), original);
    let list = f.store.list().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].missing_sources, 1);

    // A version 1 file with an explicit version reads unchanged.
    let again = f.store.read(&p.id).unwrap();
    assert_eq!(again, p);
}

#[test]
fn newer_files_are_refused_not_guessed_at() {
    let f = fixture("newer");
    let a = footage(&f.footage, "a.mp4", 30_000_000, "30/1");
    let p = f.store.create_from_paths(&[a], &TextProbe).unwrap();
    f.store.rename(&p.id, "Has a backup").unwrap();
    let file = f.store.project_dir(&p.id).unwrap().join(PROJECT_FILE);
    let mut doc: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    doc["schemaVersion"] = serde_json::json!(PROJECT_SCHEMA_VERSION + 1);
    doc["somethingNew"] = serde_json::json!({ "x": 1 });
    let newer = serde_json::to_vec_pretty(&doc).unwrap();
    fs::write(&file, &newer).unwrap();

    let e = f.store.read(&p.id).unwrap_err();
    assert!(e.message.contains("newer version"), "{e:?}");
    // Refused for every change too, and the file is left exactly as it was: no fallback
    // to the older backup, no rewrite.
    let (edit, session) = edited(&p);
    assert!(f.store.save_edit(&p.id, edit, session).is_err());
    assert!(f.store.rename(&p.id, "x").is_err());
    assert_eq!(fs::read(&file).unwrap(), newer);
    assert!(f.store.list().unwrap().is_empty(), "it cannot be listed either");
}

#[test]
fn concurrent_changes_are_serialised() {
    let f = fixture("threads");
    let a = footage(&f.footage, "a.mp4", 30_000_000, "30/1");
    let p = f.store.create_from_paths(&[a], &TextProbe).unwrap();
    let store = Arc::new(f.store);
    let (edit, session) = edited(&p);
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let store = Arc::clone(&store);
            let (id, edit, session) = (p.id.clone(), edit.clone(), session.clone());
            std::thread::spawn(move || {
                for j in 0..10 {
                    if j % 2 == 0 {
                        store.save_edit(&id, edit.clone(), session.clone()).unwrap();
                    } else {
                        store.rename(&id, &format!("name {i} {j}")).unwrap();
                    }
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    let now = store.read(&p.id).unwrap();
    assert_eq!(now.edit, edit);
    assert!(now.name.starts_with("name "));
    let files: Vec<_> = fs::read_dir(store.project_dir(&p.id).unwrap()).unwrap().flatten().map(|e| e.file_name()).collect();
    assert_eq!(files.len(), 2, "only project.json and its backup remain: {files:?}");
}

#[test]
fn default_root_is_under_app_data() {
    let root = default_projects_root();
    assert!(root.ends_with(Path::new("Roughcut").join("projects")));
    if let Some(app) = std::env::var_os("APPDATA") {
        assert!(root.starts_with(app));
    }
}
