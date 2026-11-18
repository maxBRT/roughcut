//! `api`: the only door into the core (spec 3.3).
//!
//! Responsibility: checks inputs, forwards to the module that does the work, sends events.
//! Public surface: the commands of spec 3.5.4 ([`commands`]) and the events of spec 3.5.5
//! ([`events`]; names and payload types are in `rc_types::events`). May use all core modules.
//! Each command returns its result or an `rc_types::AppError`.
//!
//! The interface side of this contract is `src/state/core/` (`CoreClient`).

pub mod commands;
pub mod events;
pub mod types;

/// The Tauri command handler: every command of spec 3.5.4, in table order.
/// Keep in step with [`types::COMMANDS`].
pub fn handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        commands::list_projects,
        commands::create_project,
        commands::open_project,
        commands::save_edit,
        commands::rename_project,
        commands::remove_project,
        commands::add_sources,
        commands::locate_source,
        commands::get_transcript,
        commands::get_suggestions,
        commands::retry_suggestions,
        commands::list_jobs,
        commands::cancel_job,
        commands::plan_export,
        commands::start_export,
        commands::reveal_file,
        commands::claude_status,
        commands::get_settings,
        commands::update_settings,
        commands::cache_usage,
        commands::clear_cache,
    ]
}
