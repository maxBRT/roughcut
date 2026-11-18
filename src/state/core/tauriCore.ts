/**
 * The real `CoreClient`: Tauri `invoke` for commands, `listen` for events, and the
 * dialog plugin (`tauri-plugin-dialog`, registered in src-tauri/src/lib.rs and allowed by
 * `dialog:default` in src-tauri/capabilities/default.json) for the system pickers.
 *
 * Argument keys are camelCase; Tauri maps them to the snake_case Rust parameters
 * (`COMMANDS` in ./apiTypes lists them, generated from the Rust side).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EVENTS, type EventName, type EventPayloads, type JobStatus } from "../../types";
import {
  appError,
  toAppError,
  type CommandName,
  type CoreClient,
  type EventHandler,
  type Unsubscribe,
} from "./client";

/** Invokes one core command; rejections are always `AppError`. */
async function call<T>(command: CommandName, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    throw toAppError(e);
  }
}

function subscribe<E extends EventName>(event: E, handler: EventHandler<E>): Unsubscribe {
  let stopped = false;
  let unlisten: (() => void) | undefined;
  listen<EventPayloads[E]>(event, (e) => {
    if (!stopped) handler(e.payload);
  }).then(
    (fn) => {
      if (stopped) fn();
      else unlisten = fn;
    },
    (err: unknown) => {
      console.error(`Roughcut: cannot listen to ${event}`, err);
    },
  );
  return () => {
    if (stopped) return;
    stopped = true;
    unlisten?.();
  };
}

/** The dialog plugin's `open` command, called directly (same wire format as @tauri-apps/plugin-dialog). */
async function dialogOpen(options: Record<string, unknown>): Promise<string | string[] | null> {
  try {
    return await invoke<string | string[] | null>("plugin:dialog|open", { options });
  } catch (e) {
    throw toAppError(e);
  }
}

export function createTauriCore(): CoreClient {
  return {
    listProjects: () => call("list_projects"),
    createProject: (paths) => call("create_project", { paths }),
    openProject: (projectId) => call("open_project", { projectId }),
    saveEdit: (projectId, edit, session) => call("save_edit", { projectId, edit, session }),
    renameProject: (projectId, name) => call("rename_project", { projectId, name }),
    removeProject: (projectId) => call("remove_project", { projectId }),

    addSources: (projectId, paths) => call("add_sources", { projectId, paths }),
    locateSource: (projectId, sourceId, newPath) =>
      call("locate_source", { projectId, sourceId, newPath }),
    getTranscript: (sourceId) => call("get_transcript", { sourceId }),
    getSuggestions: (sourceId) => call("get_suggestions", { sourceId }),
    retrySuggestions: (sourceId) => call("retry_suggestions", { sourceId }),

    listJobs: () => call("list_jobs"),
    cancelJob: (jobId) => call("cancel_job", { jobId }),

    planExport: (request) => call("plan_export", { request }),
    startExport: (request) => call("start_export", { request }),
    revealFile: (path) => call("reveal_file", { path }),

    claudeStatus: () => call("claude_status"),

    getSettings: () => call("get_settings"),
    updateSettings: (changes) => call("update_settings", { changes }),

    cacheUsage: () => call("cache_usage"),
    clearCache: () => call("clear_cache"),

    subscribe,
    onJobUpdated: (h) => subscribe(EVENTS.jobUpdated, h),
    onSourceAssetsChanged: (h) => subscribe(EVENTS.sourceAssetsChanged, h),
    onTranscriptAppended: (h) => subscribe(EVENTS.transcriptAppended, h),
    onTranscriptCompleted: (h) => subscribe(EVENTS.transcriptCompleted, h),
    onSuggestionsReady: (h) => subscribe(EVENTS.suggestionsReady, h),
    onSuggestionsUnavailable: (h) => subscribe(EVENTS.suggestionsUnavailable, h),
    onExportFinished: (h) => subscribe(EVENTS.exportFinished, h),

    async pickFiles(options = {}) {
      const picked = await dialogOpen({
        title: options.title,
        multiple: options.multiple ?? true,
        directory: false,
        filters: options.filters ?? [],
        defaultPath: options.defaultPath,
      });
      if (picked === null) return null;
      return Array.isArray(picked) ? picked : [picked];
    },
    onCloseRequested(handler) {
      // Tauri keeps the window open while a close-requested listener runs, then destroys it
      // (allowed by core:window:allow-destroy in src-tauri/capabilities/default.json).
      let stopped = false;
      let unlisten: (() => void) | undefined;
      getCurrentWindow()
        .onCloseRequested(async () => {
          await handler();
        })
        .then(
          (fn) => {
            if (stopped) fn();
            else unlisten = fn;
          },
          (err: unknown) => console.error("Roughcut: cannot watch the window closing", err),
        );
      return () => {
        if (stopped) return;
        stopped = true;
        unlisten?.();
      };
    },
    async pickFolder(options = {}) {
      const picked = await dialogOpen({
        title: options.title,
        multiple: false,
        directory: true,
        defaultPath: options.defaultPath,
      });
      if (picked === null) return null;
      return Array.isArray(picked) ? (picked[0] ?? null) : picked;
    },
    async checkForUpdate() {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        pendingUpdate = await check();
        return pendingUpdate ? { version: pendingUpdate.version, notes: pendingUpdate.body ?? null } : null;
      } catch {
        // Not worth a notice: the updater is only there in an installed release build
        // (src-tauri/src/lib.rs), and otherwise the PC is offline or GitHub did not answer.
        pendingUpdate = null;
        return null;
      }
    },
    async installUpdate() {
      const update = pendingUpdate;
      if (!update) throw appError("internal", "There is no update to install.");
      try {
        await update.download();
        // The installer replaces ffmpeg.exe and the transcriber, and the app exits without its
        // usual shutdown, so nothing of ours may still be running them.
        await stopAllJobs();
        await update.install();
      } catch (e) {
        throw toAppError(e);
      }
    },
  };
}

/** The update the last `checkForUpdate` found (a handle held by the updater plugin). */
let pendingUpdate: import("@tauri-apps/plugin-updater").Update | null = null;

/** Cancels every queued or running job and waits (ten seconds at most) until none is left. */
async function stopAllJobs(): Promise<void> {
  const active = async () => (await call<JobStatus[]>("list_jobs")).filter((j) => j.state === "queued" || j.state === "running");
  for (const job of await active()) await call("cancel_job", { jobId: job.id }).catch(() => undefined);
  for (let i = 0; i < 50 && (await active()).length > 0; i++) await new Promise((r) => setTimeout(r, 200));
}
