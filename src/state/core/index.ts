/**
 * The interface's client for the core (spec 3.5.4, 3.5.5). Only `state` uses this
 * (spec 3.6 rule 3).
 *
 * - `getCore()`: the shared client. Inside Tauri it is the real core (`tauriCore`);
 *   anywhere else (plain browser via `npm run dev`, Vitest) it is the in-memory stand-in
 *   seeded with the demo project.
 * - `createStandinCore(options)`: a fresh stand-in, e.g. for a test, with a
 *   `ManualScheduler` and injected errors.
 * - `setCore(client)`: replaces the shared client (tests, storybook-style previews).
 */
import { isTauri } from "@tauri-apps/api/core";
import type { CoreClient } from "./client";
import { createStandinCore } from "./standinCore";
import { createTauriCore } from "./tauriCore";

export * from "./client";
export { createStandinCore } from "./standinCore";
export type { MediaItem, StandinCore, StandinErrors, StandinOptions } from "./standinCore";
export { createTauriCore } from "./tauriCore";
export { ManualScheduler, realScheduler, type Scheduler } from "./scheduler";
export {
  DEMO_PROJECT_ID,
  DEMO_SOURCE_ID,
  demoDuration,
  demoProject,
  demoSuggestions,
  demoTranscript,
} from "./demoData";

/** True when running inside the Tauri app (not a plain browser or Vitest). */
export function runningInTauri(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

/** Which core the app talks to: the real one inside Tauri, the in-memory stand-in anywhere else. */
export type CoreKind = "tauri" | "standin";

/**
 * The one place that decides which core the app uses: inside the Tauri window the real core,
 * in a plain browser (`npm run dev`) or a test the stand-in with its demo data.
 */
export function coreKind(): CoreKind {
  return runningInTauri() ? "tauri" : "standin";
}

/** A new client: the real core inside Tauri, the stand-in otherwise (see `coreKind`). */
export function createCore(): CoreClient {
  return coreKind() === "tauri" ? createTauriCore() : createStandinCore();
}

let shared: CoreClient | undefined;

/** The shared client, created on first use. */
export function getCore(): CoreClient {
  shared ??= createCore();
  return shared;
}

/** Replaces the shared client (pass `undefined` to go back to the default on next use). */
export function setCore(client: CoreClient | undefined): void {
  shared = client;
}
