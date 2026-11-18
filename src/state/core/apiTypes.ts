// GENERATED FILE - DO NOT EDIT.
// Source: src-tauri/src/api/types.rs (Rust). Regenerate with
//   RC_WRITE_API_TS=1 cargo test -p roughcut --lib api::types
// Command request/response shapes of spec 3.5.4 that spec 3.4 does not name.
// (OpenedProject and CacheUsage are in src/types, generated from rc-types.)

import type { KeyBinding } from "../../types";

/**
 * Argument of `update_settings`: the fields to change. Absent fields are left as they
 * are. `schemaVersion` is owned by the core and cannot be changed.
 */
export type SettingsPatch = { exportFolder?: string, 
/**
 * Replaces the whole list. Only bindings changed from the defaults.
 */
keyBindings?: Array<KeyBinding>, speechModel?: string, speechDevice?: "auto" | "gpu" | "cpu", claudeModel?: string, claudeAuth?: "subscription" | "api_key", claudeCodeVersionTested?: string, cacheLimitBytes?: number, };

/** Every core command of spec 3.5.4 and the argument names it takes, as sent to `invoke`. */
export const COMMANDS = {
  list_projects: [],
  create_project: ["paths"],
  open_project: ["projectId"],
  save_edit: ["projectId", "edit", "session"],
  rename_project: ["projectId", "name"],
  remove_project: ["projectId"],
  add_sources: ["projectId", "paths"],
  locate_source: ["projectId", "sourceId", "newPath"],
  get_transcript: ["sourceId"],
  get_suggestions: ["sourceId"],
  retry_suggestions: ["sourceId"],
  list_jobs: [],
  cancel_job: ["jobId"],
  plan_export: ["request"],
  start_export: ["request"],
  reveal_file: ["path"],
  claude_status: [],
  get_settings: [],
  update_settings: ["changes"],
  cache_usage: [],
  clear_cache: [],
} as const;

export type CommandName = keyof typeof COMMANDS;
