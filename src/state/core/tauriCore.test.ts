import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const listeners = new Map<string, (e: { payload: unknown }) => void>();
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  isTauri: () => false,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (e: { payload: unknown }) => void) => {
    listeners.set(event, handler);
    return Promise.resolve(unlisten);
  },
}));

import { COMMANDS, METHOD_FOR_COMMAND, type CommandName, type CoreClient } from "./client";
import { createTauriCore } from "./tauriCore";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  listeners.clear();
  unlisten.mockReset();
});

/** Sample arguments, by argument name. */
const SAMPLE: Record<string, unknown> = {
  paths: ["D:\\a.mp4"],
  projectId: "p1",
  sourceId: "s1",
  jobId: "j1",
  name: "Name",
  newPath: "E:\\a.mp4",
  edit: { current: { clips: [], dismissed: [] }, undo: [], redo: [] },
  session: { view: "transcript", playhead: null, playbackRate: 1, cutTextHidden: false },
  request: { projectId: "p1", clips: [], folder: "D:\\E", fileName: "x" },
  path: "D:\\E\\x.mp4",
  changes: { claudeModel: "sonnet" },
};

describe("tauriCore", () => {
  it("calls each command by its exact name with exactly the argument names the Rust side takes", async () => {
    const core = createTauriCore();
    for (const [command, argNames] of Object.entries(COMMANDS) as [CommandName, readonly string[]][]) {
      invoke.mockClear();
      const method = core[METHOD_FOR_COMMAND[command]] as (...a: unknown[]) => Promise<unknown>;
      await method(...argNames.map((a) => SAMPLE[a]));
      expect(invoke).toHaveBeenCalledTimes(1);
      const [name, args] = invoke.mock.calls[0]!;
      expect(name).toBe(command);
      expect(Object.keys((args as Record<string, unknown>) ?? {}).sort()).toEqual([...argNames].sort());
      for (const a of argNames) expect((args as Record<string, unknown>)[a]).toEqual(SAMPLE[a]);
    }
  });

  it("maps every method of CoreClient that is a command", () => {
    const methods = Object.values(METHOD_FOR_COMMAND);
    expect(new Set(methods).size).toBe(Object.keys(COMMANDS).length);
  });

  it("passes AppErrors through and turns anything else into internal", async () => {
    const core = createTauriCore();
    invoke.mockRejectedValueOnce({ code: "disk_full", message: "full" });
    await expect(core.listJobs()).rejects.toEqual({ code: "disk_full", message: "full" });
    invoke.mockRejectedValueOnce("command list_jobs not found");
    await expect(core.listJobs()).rejects.toEqual({ code: "internal", message: "command list_jobs not found" });
  });

  it("subscribes to events by their spec names and unsubscribes", async () => {
    const core: CoreClient = createTauriCore();
    const h = vi.fn();
    const off = core.onTranscriptCompleted(h);
    await Promise.resolve();
    listeners.get("transcript_completed")!({ payload: { sourceId: "s1" } });
    expect(h).toHaveBeenCalledWith({ sourceId: "s1" });
    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
    listeners.get("transcript_completed")!({ payload: { sourceId: "s2" } });
    expect(h).toHaveBeenCalledTimes(1);

    const names: string[] = [];
    for (const sub of [
      core.onJobUpdated, core.onSourceAssetsChanged, core.onTranscriptAppended, core.onSuggestionsReady,
      core.onSuggestionsUnavailable, core.onExportFinished,
    ]) sub(() => {});
    names.push(...listeners.keys());
    expect(names.sort()).toEqual([
      "export_finished", "job_updated", "source_assets_changed", "suggestions_ready",
      "suggestions_unavailable", "transcript_appended", "transcript_completed",
    ]);
  });

  it("uses the dialog plugin for the pickers", async () => {
    const core = createTauriCore();
    invoke.mockResolvedValueOnce(["D:\\a.mp4"]);
    expect(await core.pickFiles({ filters: [{ name: "Video", extensions: ["mp4"] }] })).toEqual(["D:\\a.mp4"]);
    expect(invoke.mock.calls[0]![0]).toBe("plugin:dialog|open");
    expect((invoke.mock.calls[0]![1] as { options: Record<string, unknown> }).options).toMatchObject({ multiple: true, directory: false });
    invoke.mockResolvedValueOnce("D:\\E");
    expect(await core.pickFolder()).toBe("D:\\E");
    expect((invoke.mock.calls[1]![1] as { options: Record<string, unknown> }).options).toMatchObject({ directory: true });
    invoke.mockResolvedValueOnce(null);
    expect(await core.pickFiles()).toBeNull();
  });
});
