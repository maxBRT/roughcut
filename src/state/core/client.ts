/**
 * The contract between the interface and the core (spec 3.5.4, 3.5.5).
 *
 * `CoreClient` has one method per core command, camelCase for the snake_case command
 * name (`listProjects` -> `list_projects`), and one typed subscribe method per core
 * event. Every method resolves with the documented result or rejects with an
 * `AppError` object (`{ code, message, detail? }`), never with anything else.
 *
 * Two implementations: `tauriCore` (the real core, over Tauri invoke/listen) and
 * `standinCore` (in memory, for interface development and tests). Get one from
 * `./index`.
 */
import type {
  AppError,
  CacheUsage,
  ClaudeStatus,
  EditDocument,
  ErrorCode,
  EventName,
  EventPayloads,
  ExportFinishedPayload,
  ExportPlan,
  ExportRequest,
  JobId,
  JobStatus,
  JobUpdatedPayload,
  OpenedProject,
  Project,
  ProjectId,
  ProjectSummary,
  SessionState,
  Settings,
  SourceAssets,
  SourceAssetsChangedPayload,
  SourceId,
  SourceRef,
  SuggestionSet,
  SuggestionsReadyPayload,
  SuggestionsUnavailablePayload,
  Transcript,
  TranscriptAppendedPayload,
  TranscriptCompletedPayload,
} from "../../types";
import type { CommandName, SettingsPatch } from "./apiTypes";

export type { CommandName, SettingsPatch } from "./apiTypes";
export { COMMANDS } from "./apiTypes";

/** Stops a subscription. Safe to call more than once. */
export type Unsubscribe = () => void;

export type EventHandler<E extends EventName> = (payload: EventPayloads[E]) => void;

/** Options for the system file picker. */
export interface PickFilesOptions {
  title?: string;
  /** Allow choosing several files (default true). */
  multiple?: boolean;
  /** e.g. `[{ name: "Video", extensions: ["mp4", "mov"] }]` */
  filters?: { name: string; extensions: string[] }[];
  defaultPath?: string;
}

export interface PickFolderOptions {
  title?: string;
  defaultPath?: string;
}

export interface CoreClient {
  // ---- Projects ----
  /** `list_projects` */
  listProjects(): Promise<ProjectSummary[]>;
  /** `create_project`: starts the import jobs. */
  createProject(paths: string[]): Promise<Project>;
  /** `open_project`: the project and a `SourceAssets` per source; restarts unfinished jobs. */
  openProject(projectId: ProjectId): Promise<OpenedProject>;
  /** `save_edit` */
  saveEdit(projectId: ProjectId, edit: EditDocument, session: SessionState): Promise<void>;
  /** `rename_project` */
  renameProject(projectId: ProjectId, name: string): Promise<void>;
  /** `remove_project`: removes it from the list; footage is untouched. */
  removeProject(projectId: ProjectId): Promise<void>;

  // ---- Sources ----
  /** `add_sources`: starts the import jobs. */
  addSources(projectId: ProjectId, paths: string[]): Promise<SourceRef[]>;
  /** `locate_source`: rejects with `source_mismatch` if it is a different file. */
  locateSource(projectId: ProjectId, sourceId: SourceId, newPath: string): Promise<SourceAssets>;
  /** `get_transcript`: as far as it has got. */
  getTranscript(sourceId: SourceId): Promise<Transcript>;
  /** `get_suggestions` */
  getSuggestions(sourceId: SourceId): Promise<SuggestionSet>;
  /** `retry_suggestions` */
  retrySuggestions(sourceId: SourceId): Promise<JobId>;

  // ---- Jobs ----
  /** `list_jobs` */
  listJobs(): Promise<JobStatus[]>;
  /** `cancel_job` */
  cancelJob(jobId: JobId): Promise<void>;

  // ---- Export ----
  /** `plan_export` */
  planExport(request: ExportRequest): Promise<ExportPlan>;
  /** `start_export` */
  startExport(request: ExportRequest): Promise<JobId>;
  /** `reveal_file`: opens the folder with the file selected. */
  revealFile(path: string): Promise<void>;

  // ---- Claude ----
  /** `claude_status` */
  claudeStatus(): Promise<ClaudeStatus>;

  // ---- Settings ----
  /** `get_settings` */
  getSettings(): Promise<Settings>;
  /** `update_settings`: only the fields present change. */
  updateSettings(changes: SettingsPatch): Promise<Settings>;

  // ---- Cache ----
  /** `cache_usage`: bytes used, limit. */
  cacheUsage(): Promise<CacheUsage>;
  /** `clear_cache` */
  clearCache(): Promise<void>;

  // ---- Events (spec 3.5.5) ----
  /** Any event by name. */
  subscribe<E extends EventName>(event: E, handler: EventHandler<E>): Unsubscribe;
  /** `job_updated` */
  onJobUpdated(handler: (payload: JobUpdatedPayload) => void): Unsubscribe;
  /** `source_assets_changed` */
  onSourceAssetsChanged(handler: (payload: SourceAssetsChangedPayload) => void): Unsubscribe;
  /** `transcript_appended` */
  onTranscriptAppended(handler: (payload: TranscriptAppendedPayload) => void): Unsubscribe;
  /** `transcript_completed` */
  onTranscriptCompleted(handler: (payload: TranscriptCompletedPayload) => void): Unsubscribe;
  /** `suggestions_ready` */
  onSuggestionsReady(handler: (payload: SuggestionsReadyPayload) => void): Unsubscribe;
  /** `suggestions_unavailable` */
  onSuggestionsUnavailable(handler: (payload: SuggestionsUnavailablePayload) => void): Unsubscribe;
  /** `export_finished` */
  onExportFinished(handler: (payload: ExportFinishedPayload) => void): Unsubscribe;

  // ---- System dialogs (not core commands; spec 3.5.4 last line) ----
  /** The system file picker. Resolves with the chosen paths, or `null` if cancelled. */
  pickFiles(options?: PickFilesOptions): Promise<string[] | null>;
  /** The system folder picker. Resolves with the chosen folder, or `null` if cancelled. */
  pickFolder(options?: PickFolderOptions): Promise<string | null>;

  // ---- The app window (not a core command) ----
  /**
   * Runs `handler` when the user closes the window, and closes it once the handler's promise
   * settles. Absent where there is no window to close (the stand-in in a browser tab).
   */
  onCloseRequested?(handler: () => Promise<void>): Unsubscribe;

  // ---- Updates (the updater plugin; not core commands) ----
  /**
   * Asks GitHub whether a newer release exists. Resolves with it, or `null` when this copy is
   * the newest, when updates are switched off (a development build, a copy that was not
   * installed, the tests) or when the check fails. Absent in the stand-in.
   */
  checkForUpdate?(): Promise<AvailableUpdate | null>;
  /**
   * Downloads the update `checkForUpdate` found, stops every job, and runs its installer;
   * the app then exits and the installer starts the new version. Rejects if it cannot.
   */
  installUpdate?(): Promise<void>;
}

/** A release newer than the running app. */
export interface AvailableUpdate {
  version: string;
  /** The release notes, when the release has any. */
  notes: string | null;
}

/** The `CoreClient` method for each command. */
export const METHOD_FOR_COMMAND: Record<CommandName, keyof CoreClient> = {
  list_projects: "listProjects",
  create_project: "createProject",
  open_project: "openProject",
  save_edit: "saveEdit",
  rename_project: "renameProject",
  remove_project: "removeProject",
  add_sources: "addSources",
  locate_source: "locateSource",
  get_transcript: "getTranscript",
  get_suggestions: "getSuggestions",
  retry_suggestions: "retrySuggestions",
  list_jobs: "listJobs",
  cancel_job: "cancelJob",
  plan_export: "planExport",
  start_export: "startExport",
  reveal_file: "revealFile",
  claude_status: "claudeStatus",
  get_settings: "getSettings",
  update_settings: "updateSettings",
  cache_usage: "cacheUsage",
  clear_cache: "clearCache",
};

const ERROR_CODES: readonly ErrorCode[] = [
  "source_missing",
  "source_unreadable",
  "source_mismatch",
  "disk_full",
  "nothing_to_export",
  "export_failed",
  "gpu_unavailable",
  "transcriber_failed",
  "claude_missing",
  "claude_signed_out",
  "claude_limit",
  "claude_offline",
  "claude_bad_answer",
  "cancelled",
  "internal",
];

/** True for an `AppError` object, the only thing a `CoreClient` method rejects with. */
export function isAppError(value: unknown): value is AppError {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.code === "string" &&
    (ERROR_CODES as readonly string[]).includes(v.code) &&
    typeof v.message === "string" &&
    (v.detail === undefined || typeof v.detail === "string")
  );
}

/** Turns anything thrown into an `AppError` (unknown values become `internal`). */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
  if (value instanceof Error) return { code: "internal", message: value.message };
  return { code: "internal", message: typeof value === "string" ? value : String(value) };
}

export function appError(code: ErrorCode, message: string, detail?: string): AppError {
  return detail === undefined ? { code, message } : { code, message, detail };
}
