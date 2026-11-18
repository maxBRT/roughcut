//! The interface-to-core commands (spec 3.5.4), one `#[tauri::command]` each, with the
//! exact names of the spec table. Each returns its result or an `AppError`.
//!
//! Argument names are part of the contract: the interface sends them as camelCase keys
//! (`projectId`, `sourceId`, `newPath`, ...), which Tauri maps to these snake_case
//! parameters. The list is repeated in `super::types::COMMANDS` and generated into
//! `src/state/core/apiTypes.ts`.
//!
//! Each command is a thin wrapper: it forwards to the method of the same name on
//! [`AppCore`](crate::appcore::AppCore), which does the work and needs no window (the
//! window's `State` holds the one `Arc<AppCore>`).

use std::sync::Arc;

use tauri::State;

use crate::appcore::AppCore;
use rc_types::{
    AppError, CacheUsage, ClaudeStatus, EditDocument, ExportPlan, ExportRequest, JobId,
    JobStatus, OpenedProject, Project, ProjectId, ProjectSummary, SessionState, Settings,
    SourceAssets, SourceId, SourceRef, SuggestionSet, Transcript,
};

use super::types::SettingsPatch;

/// The core, as Tauri hands it to every command.
type Core<'a> = State<'a, Arc<AppCore>>;

// ---- Projects ----

/// `ProjectSummary[]`: one row per project on the Home screen.
#[tauri::command]
pub async fn list_projects(core: Core<'_>) -> Result<Vec<ProjectSummary>, AppError> {
    core.list_projects().await
}

/// Creates a project from the given files and starts their import jobs.
#[tauri::command]
pub async fn create_project(core: Core<'_>, paths: Vec<String>) -> Result<Project, AppError> {
    core.create_project(paths).await
}

/// The project and a `SourceAssets` per source. Restarts any unfinished jobs.
#[tauri::command]
pub async fn open_project(core: Core<'_>, project_id: ProjectId) -> Result<OpenedProject, AppError> {
    core.open_project(project_id).await
}

/// Saves the interface-owned parts of the project file.
#[tauri::command]
pub async fn save_edit(core: Core<'_>, project_id: ProjectId, edit: EditDocument, session: SessionState) -> Result<(), AppError> {
    core.save_edit(project_id, edit, session).await
}

#[tauri::command]
pub async fn rename_project(core: Core<'_>, project_id: ProjectId, name: String) -> Result<(), AppError> {
    core.rename_project(project_id, name).await
}

/// Removes the project from the list; footage is untouched.
#[tauri::command]
pub async fn remove_project(core: Core<'_>, project_id: ProjectId) -> Result<(), AppError> {
    core.remove_project(project_id).await
}

// ---- Sources ----

/// Adds files to a project and starts their import jobs.
#[tauri::command]
pub async fn add_sources(core: Core<'_>, project_id: ProjectId, paths: Vec<String>) -> Result<Vec<SourceRef>, AppError> {
    core.add_sources(project_id, paths).await
}

/// Points a source at a new path. `source_mismatch` if it is a different file.
#[tauri::command]
pub async fn locate_source(core: Core<'_>, project_id: ProjectId, source_id: SourceId, new_path: String) -> Result<SourceAssets, AppError> {
    core.locate_source(project_id, source_id, new_path).await
}

/// The transcript as far as it has got.
#[tauri::command]
pub async fn get_transcript(core: Core<'_>, source_id: SourceId) -> Result<Transcript, AppError> {
    core.get_transcript(source_id).await
}

#[tauri::command]
pub async fn get_suggestions(core: Core<'_>, source_id: SourceId) -> Result<SuggestionSet, AppError> {
    core.get_suggestions(source_id).await
}

/// Starts a new suggest job for the source.
#[tauri::command]
pub async fn retry_suggestions(core: Core<'_>, source_id: SourceId) -> Result<JobId, AppError> {
    core.retry_suggestions(source_id).await
}

// ---- Jobs ----

#[tauri::command]
pub async fn list_jobs(core: Core<'_>) -> Result<Vec<JobStatus>, AppError> {
    core.list_jobs().await
}

#[tauri::command]
pub async fn cancel_job(core: Core<'_>, job_id: JobId) -> Result<(), AppError> {
    core.cancel_job(job_id).await
}

// ---- Export ----

#[tauri::command]
pub async fn plan_export(core: Core<'_>, request: ExportRequest) -> Result<ExportPlan, AppError> {
    core.plan_export(request).await
}

#[tauri::command]
pub async fn start_export(core: Core<'_>, request: ExportRequest) -> Result<JobId, AppError> {
    core.start_export(request).await
}

/// Opens the folder with the file selected.
#[tauri::command]
pub async fn reveal_file(core: Core<'_>, path: String) -> Result<(), AppError> {
    core.reveal_file(path).await
}

// ---- Claude ----

#[tauri::command]
pub async fn claude_status(core: Core<'_>) -> Result<ClaudeStatus, AppError> {
    core.claude_status().await
}

// ---- Settings ----

#[tauri::command]
pub async fn get_settings(core: Core<'_>) -> Result<Settings, AppError> {
    core.get_settings().await
}

/// Applies the fields present in `changes` and returns the full settings.
#[tauri::command]
pub async fn update_settings(core: Core<'_>, changes: SettingsPatch) -> Result<Settings, AppError> {
    core.update_settings(changes).await
}

// ---- Cache ----

/// Bytes used and the limit.
#[tauri::command]
pub async fn cache_usage(core: Core<'_>) -> Result<CacheUsage, AppError> {
    core.cache_usage().await
}

#[tauri::command]
pub async fn clear_cache(core: Core<'_>) -> Result<(), AppError> {
    core.clear_cache().await
}
