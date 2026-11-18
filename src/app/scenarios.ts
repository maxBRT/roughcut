/**
 * Scenarios: named states the app can be put in from the address (`?scenario=<name>`) in the
 * browser (stand-in core), for screenshots and for driving the app from outside. Each one goes
 * through the same actions a user would (dispatch), on the stand-in core, with the stand-in's
 * clock stopped at the moment worth looking at. The list is in src/state/README.md.
 */
import { appError, type StandinCore } from "../state/core";
import type { RoughcutStore } from "../state";
import type { ActionId } from "../types";

/** What a scenario can use. */
export interface ScenarioContext {
  store: RoughcutStore;
  core: StandinCore;
  /** Runs the stand-in core's jobs for `ms` of their time, then waits for the store. */
  advance(ms: number): Promise<void>;
  /** Runs the stand-in core's jobs until none is left, then waits for the store. */
  finishJobs(): Promise<void>;
  /** Sets the stand-in core's clock (timestamps of new projects and saves); null = real time. */
  setNow(date: Date | null): void;
}

export interface Scenario {
  /** One line: what is on screen. */
  readonly title: string;
  /** Options for the stand-in core it needs (seed the demo project or not). */
  readonly seedDemo?: boolean;
  /** Runs before the store loads (changes to the core the project list should reflect). */
  prepare?(ctx: ScenarioContext): Promise<void>;
  /** Runs after the store has loaded. */
  run?(ctx: ScenarioContext): Promise<void>;
}

/** Steps of the stand-in's jobs, in its milliseconds (its default `stepMs`). */
export const STANDIN_STEP_MS = 250;

async function act(ctx: ScenarioContext, action: ActionId, payload?: unknown): Promise<void> {
  await (ctx.store.dispatch as (a: ActionId, p?: unknown) => Promise<void>)(action, payload);
  await ctx.store.idle();
}

async function openDemo(ctx: ScenarioContext): Promise<void> {
  await act(ctx, "ui.openProject", { projectId: ctx.core.demo.projectId });
}

/** The demo project after Claude's suggestions were accepted: several clips. */
async function openEdited(ctx: ScenarioContext): Promise<void> {
  await openDemo(ctx);
  await act(ctx, "transcript.acceptAllSuggestions");
}

async function openExport(ctx: ScenarioContext): Promise<void> {
  await openEdited(ctx);
  await act(ctx, "everywhere.export");
}

/** Projects of earlier weeks, for a Home list like the mockup's. */
async function olderProjects(ctx: ScenarioContext): Promise<void> {
  for (const [name, when] of [
    ["Weekly update - Oct 30", "2026-10-30T15:00:00.000Z"],
    ["Weekly update - Nov 6", "2026-11-06T15:00:00.000Z"],
  ] as const) {
    ctx.setNow(new Date(when));
    await ctx.core.createProject([`D:\\Footage\\${name}.mp4`]);
    await ctx.finishJobs();
  }
  ctx.setNow(null);
}

export const SCENARIOS: Readonly<Record<string, Scenario>> = {
  home: {
    title: "Home with three projects, the most recent selected",
    prepare: olderProjects,
  },
  "home-empty": {
    title: "Home with no projects yet",
    seedDemo: false,
  },
  transcribing: {
    title: "Editor right after a drop: the transcript is still arriving",
    run: async (ctx) => {
      await act(ctx, "ui.dropFiles", { paths: ["D:\\Footage\\Weekly update - Nov 20.mp4"] });
      await ctx.advance(3 * STANDIN_STEP_MS);
    },
  },
  transcript: {
    title: "Transcript view: one take cut, the next suggestion current",
    run: async (ctx) => {
      await openDemo(ctx);
      await act(ctx, "transcript.nextSuggestion");
      await act(ctx, "transcript.acceptSuggestion");
      await act(ctx, "transcript.nextSuggestion");
    },
  },
  find: {
    title: "Transcript view with cut text hidden and the find box open on a match in it",
    run: async (ctx) => {
      await openDemo(ctx);
      await act(ctx, "transcript.nextSuggestion");
      await act(ctx, "transcript.acceptSuggestion");
      await act(ctx, "transcript.toggleCutText");
      await act(ctx, "everywhere.find");
      await act(ctx, "ui.findQuery", { query: "first thing" });
    },
  },
  timeline: {
    title: "Timeline view after accepting the suggestions, playhead on the second cut",
    run: async (ctx) => {
      await openEdited(ctx);
      await act(ctx, "ui.setView", { view: "timeline" });
      await act(ctx, "timeline.nextCut");
      await act(ctx, "timeline.nextCut");
    },
  },
  "export-confirm": {
    title: "Export dialog, confirm stage",
    run: openExport,
  },
  "export-running": {
    title: "Export dialog, running stage (about half way)",
    run: async (ctx) => {
      await openExport(ctx);
      await act(ctx, "export.confirm");
      await ctx.advance(5 * STANDIN_STEP_MS);
    },
  },
  "export-done": {
    title: "Export dialog, done stage",
    run: async (ctx) => {
      await openExport(ctx);
      await act(ctx, "export.confirm");
      await ctx.finishJobs();
    },
  },
  "export-disk-full": {
    title: "Export dialog blocked: not enough disk space, with the amount needed",
    run: async (ctx) => {
      ctx.core.setErrors({ diskFull: true });
      await openExport(ctx);
    },
  },
  "export-nothing": {
    title: "Export dialog blocked: everything is cut",
    run: async (ctx) => {
      await openDemo(ctx);
      await act(ctx, "ui.setView", { view: "timeline" });
      for (let i = 0; i < 1000 && (ctx.store.getState().edit?.current.clips.length ?? 0) > 0; i++) {
        await act(ctx, "timeline.removeClip");
      }
      // The header's Export button is disabled; Ctrl+E still opens the dialog, which says why.
      await act(ctx, "everywhere.export");
    },
  },
  "export-missing": {
    title: "Export dialog blocked: a source file is missing",
    run: async (ctx) => {
      await openEdited(ctx);
      ctx.core.setErrors({ missingSources: [ctx.core.demo.sourceId] });
      await ctx.store.idle();
      await act(ctx, "everywhere.export");
    },
  },
  "export-failed": {
    title: "Export dialog back at confirm after the export could not start",
    run: async (ctx) => {
      await openExport(ctx);
      ctx.core.failNext("start_export", appError("export_failed", "The encoder stopped: the GPU is busy.", "nvenc: out of sessions"));
      await act(ctx, "export.confirm");
    },
  },
  "export-shortcuts": {
    title: "The shortcut overlay over the Export dialog",
    run: async (ctx) => {
      await openExport(ctx);
      await act(ctx, "everywhere.showShortcuts");
    },
  },
  shortcuts: {
    title: "The shortcut overlay over the Transcript view",
    run: async (ctx) => {
      await openDemo(ctx);
      await act(ctx, "everywhere.showShortcuts");
    },
  },
  locate: {
    title: "The Locate file prompt: the project's recording was moved",
    prepare: async (ctx) => ctx.core.setErrors({ missingSources: [ctx.core.demo.sourceId] }),
    run: openDemo,
  },
  notice: {
    title: "A one-line notice with Retry: Claude is signed out",
    run: async (ctx) => {
      await openDemo(ctx);
      ctx.core.setErrors({ claudeSignedOut: true });
      await act(ctx, "ui.retryClaude", { sourceId: ctx.core.demo.sourceId });
      await ctx.finishJobs();
    },
  },
  mixed: {
    title: "A project of two recordings in different formats, with its notice",
    run: async (ctx) => {
      await act(ctx, "ui.dropFiles", { paths: ["D:\\Footage\\Weekly update - Nov 20.mp4", "D:\\Footage\\SCREEN-DEMO.mov"] });
      await ctx.finishJobs();
    },
  },
};

/** The scenario names, in the order above. */
export const SCENARIO_NAMES: readonly string[] = Object.keys(SCENARIOS);
