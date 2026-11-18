//! Upgrading older `project.json` files (spec 3.4 rule 6: newer ones are refused).
//!
//! `MIGRATIONS[v]` turns a version `v` file into a version `v + 1` file, working on the raw
//! JSON so that it never depends on the current Rust types. To change the format: bump
//! `rc_types::PROJECT_SCHEMA_VERSION`, append one function here and add a test with a file
//! of the old version.

use rc_types::PROJECT_SCHEMA_VERSION;
use serde_json::{json, Map, Value};

type Migration = fn(&mut Map<String, Value>) -> Result<(), String>;

/// One step per version, from 0 up to the current one.
const MIGRATIONS: &[Migration] = &[v0_to_v1];

/// What reading the version of a file found.
#[derive(Debug, PartialEq, Eq)]
pub enum Version {
    /// This build can read it, possibly after upgrading.
    Known(u32),
    /// Written by a newer Roughcut: refused, never guessed at.
    Newer(u32),
}

/// The `schemaVersion` of a project file; 0 when the field is absent (files from before
/// versioning).
pub fn version_of(doc: &Map<String, Value>) -> Result<Version, String> {
    let v = match doc.get("schemaVersion") {
        None | Some(Value::Null) => 0,
        Some(v) => v.as_u64().and_then(|v| u32::try_from(v).ok()).ok_or("schemaVersion is not a whole number")?,
    };
    Ok(if v > PROJECT_SCHEMA_VERSION { Version::Newer(v) } else { Version::Known(v) })
}

/// Upgrades `doc` from version `from` to the current version in place.
pub fn upgrade(doc: &mut Map<String, Value>, from: u32) -> Result<(), String> {
    debug_assert_eq!(MIGRATIONS.len(), PROJECT_SCHEMA_VERSION as usize);
    for (v, step) in MIGRATIONS.iter().enumerate().skip(from as usize) {
        step(doc).map_err(|e| format!("upgrading from version {v}: {e}"))?;
        doc.insert("schemaVersion".into(), json!(v + 1));
    }
    Ok(())
}

/// Version 0 is the draft layout used before files carried a `schemaVersion`. It could lack
/// `session`, `edit.undo`, `edit.redo`, `edit.current.dismissed`, `sources[].addedAt` and
/// `updatedAt`, and it named the clip list `edit.clips` (no undo history).
fn v0_to_v1(doc: &mut Map<String, Value>) -> Result<(), String> {
    let created = doc.get("createdAt").and_then(Value::as_str).ok_or("createdAt is missing")?.to_owned();
    if !doc.contains_key("updatedAt") {
        doc.insert("updatedAt".into(), json!(created));
    }
    if let Some(Value::Array(sources)) = doc.get_mut("sources") {
        for s in sources.iter_mut().filter_map(Value::as_object_mut) {
            s.entry("addedAt").or_insert_with(|| json!(created));
        }
    }
    let edit = doc.entry("edit").or_insert_with(|| json!({})).as_object_mut().ok_or("edit is not an object")?;
    if !edit.contains_key("current") {
        let clips = edit.remove("clips").unwrap_or_else(|| json!([]));
        edit.insert("current".into(), json!({ "clips": clips, "dismissed": [] }));
    }
    if let Some(current) = edit.get_mut("current").and_then(Value::as_object_mut) {
        current.entry("dismissed").or_insert_with(|| json!([]));
    }
    edit.entry("undo").or_insert_with(|| json!([]));
    edit.entry("redo").or_insert_with(|| json!([]));
    doc.entry("session").or_insert_with(|| {
        json!({ "view": "transcript", "playhead": null, "playbackRate": 1, "cutTextHidden": false })
    });
    Ok(())
}
