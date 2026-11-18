//! Roughcut core (spec 2.3, 3.3): the Tauri 2 app.
//!
//! The core modules live in their own crates under `src-tauri/crates/` (rc-project,
//! rc-source, rc-cache, rc-jobs, rc-media, rc-server, rc-speech, rc-suggest,
//! rc-settings, with shared types in rc-types). This crate joins them:
//! - [`appcore`]: the application object [`AppCore`] that owns the stores, the cache, the job
//!   runner and the media server, with one method per command of spec 3.5.4, and the adapters
//!   the job runner asks for;
//! - [`api`]: the only door from the interface into the core, thin Tauri wrappers around those
//!   methods, and the sink that turns core events into Tauri events.

pub mod api;
pub mod appcore;

// build.rs copies the transcriber next to the built app with this; its tests run here.
#[cfg(test)]
#[path = "../build_mirror.rs"]
mod build_mirror;

use std::sync::Arc;

pub use appcore::{AppConfig, AppCore};
use tauri::Manager;

/// `ROUGHCUT_NO_UPDATE`: any non-empty value switches the update check off (the end-to-end
/// tests set it, so no test ever talks to GitHub or installs anything).
pub const NO_UPDATE_ENV: &str = "ROUGHCUT_NO_UPDATE";

/// Whether this copy of the app may update itself from GitHub Releases: only a release build
/// that was put in place by the installer (its `uninstall.exe` sits next to the app). A
/// development build or the portable `dist-app` folder never does: the update is the
/// installer, which would install a second copy instead of replacing this one.
fn updates_enabled() -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    if std::env::var_os(NO_UPDATE_ENV).is_some_and(|v| !v.is_empty()) {
        return false;
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("uninstall.exe").is_file()))
        .unwrap_or(false)
}

/// Starts the app.
pub fn run() {
    let config = AppConfig::from_env();
    let mut builder = tauri::Builder::default()
        // System file and folder pickers, called directly from the interface (spec 3.5.4).
        .plugin(tauri_plugin_dialog::init());
    if updates_enabled() {
        // Checked and installed from the interface (src/state/core/tauriCore.ts). Without the
        // plugin its commands do not exist, and the interface takes that as "no update".
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    let app = builder
        .setup(move |app| {
            let sink = Arc::new(api::events::TauriSink::new(app.handle().clone()));
            let handle = tauri::async_runtime::handle().inner().clone();
            let core = AppCore::start(config, sink, handle)?;
            app.manage(core);
            Ok(())
        })
        // Coming back to the app (perhaps after moving files in Explorer): check the open
        // project's sources at once rather than at the next periodic check.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(true) = event
                && let Some(core) = window.try_state::<Arc<AppCore>>()
            {
                let core = Arc::clone(&core);
                tauri::async_runtime::spawn(async move { core.recheck_sources().await });
            }
        })
        .invoke_handler(api::handler())
        .build(tauri::generate_context!())
        .expect("error while starting Roughcut");
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event
            && let Some(core) = app.try_state::<Arc<AppCore>>()
        {
            // Cancel every job and wait until no FFmpeg, transcriber or claude is left.
            tauri::async_runtime::block_on(core.shutdown());
        }
    });
}
