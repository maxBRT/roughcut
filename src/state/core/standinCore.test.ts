import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppError, EventName, EventPayloads, ExportRequest, JobStatus } from "../../types";
import { COMMANDS, isAppError, type CommandName, type CoreClient } from "./client";
import { createStandinCore, type StandinCore, type StandinOptions } from "./standinCore";
import { ManualScheduler } from "./scheduler";
import { DEMO_PROJECT_ID, DEMO_SOURCE_ID } from "./demoData";
import * as S from "./shapes.test-helpers";

type Recorded = { [E in EventName]: { event: E; payload: EventPayloads[E] } }[EventName];

const EVENT_NAMES: EventName[] = [
  "job_updated",
  "source_assets_changed",
  "transcript_appended",
  "transcript_completed",
  "suggestions_ready",
  "suggestions_unavailable",
  "export_finished",
];

let cores: StandinCore[] = [];
afterEach(() => {
  cores.forEach((c) => c.dispose());
  cores = [];
  vi.useRealTimers();
});

function setup(options: StandinOptions = {}) {
  const scheduler = new ManualScheduler();
  const core = createStandinCore({ scheduler, ...options });
  cores.push(core);
  const events: Recorded[] = [];
  for (const name of EVENT_NAMES) {
    core.subscribe(name, (payload) => events.push({ event: name, payload } as Recorded));
  }
  return { core, scheduler, events };
}

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(isAppError(e)).toBe(true);
    return e as AppError;
  }
  throw new Error("expected the call to reject");
}

const jobEvents = (events: Recorded[]) =>
  events.flatMap((e) => (e.event === "job_updated" ? [e.payload] : []));

describe("stand-in core: every command resolves with the documented type", () => {
  it("covers all 21 commands", async () => {
    const { core, scheduler } = setup();
    const seen = new Set<CommandName>();
    const check = async <T>(name: CommandName, shape: Parameters<typeof S.expectShape>[0], p: Promise<T>) => {
      const v = await p;
      S.expectShape(shape, v, name);
      seen.add(name);
      return v;
    };

    const list = await check("list_projects", S.arr(S.projectSummary), core.listProjects());
    expect(list.map((p) => p.id)).toContain(DEMO_PROJECT_ID);

    const created = await check("create_project", S.project, core.createProject(["D:\\Footage\\A.mp4"]));
    expect(created.edit.current.clips).toHaveLength(1);
    const opened = await check("open_project", S.openedProject, core.openProject(DEMO_PROJECT_ID));
    expect(opened.assets).toHaveLength(opened.project.sources.length);

    await check("save_edit", S.nothing, core.saveEdit(DEMO_PROJECT_ID, opened.project.edit, opened.project.session));
    await check("rename_project", S.nothing, core.renameProject(created.id, "Renamed"));
    const added = await check("add_sources", S.arr(S.sourceRef), core.addSources(created.id, ["D:\\Footage\\B.mov"]));
    expect(added).toHaveLength(1);
    await check("locate_source", S.sourceAssets, core.locateSource(DEMO_PROJECT_ID, DEMO_SOURCE_ID, "E:\\TAKE-1.mp4"));
    await check("get_transcript", S.transcript, core.getTranscript(DEMO_SOURCE_ID));
    await check("get_suggestions", S.suggestionSet, core.getSuggestions(DEMO_SOURCE_ID));
    await check("retry_suggestions", S.str, core.retrySuggestions(DEMO_SOURCE_ID));
    const jobs = await check("list_jobs", S.arr(S.jobStatus), core.listJobs());
    const someJob = jobs.find((j) => j.state === "queued" || j.state === "running");
    expect(someJob).toBeDefined();
    await check("cancel_job", S.nothing, core.cancelJob(someJob!.id));

    const request: ExportRequest = {
      projectId: DEMO_PROJECT_ID,
      clips: opened.project.edit.current.clips,
      folder: "D:\\Exports",
      fileName: "weekly",
    };
    await check("plan_export", S.exportPlan, core.planExport(request));
    await check("start_export", S.str, core.startExport(request));
    await check("reveal_file", S.nothing, core.revealFile("D:\\Exports\\weekly.mp4"));
    await check("claude_status", S.claudeStatus, core.claudeStatus());
    await check("get_settings", S.settings, core.getSettings());
    const updated = await check("update_settings", S.settings, core.updateSettings({ claudeModel: "sonnet" }));
    expect(updated.claudeModel).toBe("sonnet");
    await check("cache_usage", S.cacheUsage, core.cacheUsage());
    await check("clear_cache", S.nothing, core.clearCache());
    await check("remove_project", S.nothing, core.removeProject(created.id));

    expect([...seen].sort()).toEqual(Object.keys(COMMANDS).sort());
    scheduler.runAll();
  });

  it("every event payload has the documented type", async () => {
    const { core, scheduler, events } = setup({ errors: { claudeSignedOut: true } });
    const p = await core.createProject(["D:\\Footage\\A.mp4"]);
    scheduler.runAll();
    await core.startExport({ projectId: p.id, clips: p.edit.current.clips, folder: "D:\\Out", fileName: "a.mp4" });
    scheduler.runAll();
    const shapes: Record<EventName, Parameters<typeof S.expectShape>[0]> = {
      job_updated: S.jobStatus,
      source_assets_changed: S.sourceAssets,
      transcript_appended: S.obj({ sourceId: S.str, utterances: S.arr(S.utterance) }),
      transcript_completed: S.obj({ sourceId: S.str }),
      suggestions_ready: S.suggestionSet,
      suggestions_unavailable: S.obj({ sourceId: S.str, error: S.appErrorShape }),
      export_finished: S.exportResult,
    };
    for (const name of EVENT_NAMES) {
      const of = events.filter((e) => e.event === name);
      expect(of.length, name).toBeGreaterThan(0);
      of.forEach((e, i) => S.expectShape(shapes[name], e.payload, `${name}[${i}]`));
    }
  });

  it("results are copies: mutating them does not change the core", async () => {
    const { core } = setup();
    const t = await core.getTranscript(DEMO_SOURCE_ID);
    t.utterances.length = 0;
    expect((await core.getTranscript(DEMO_SOURCE_ID)).utterances.length).toBeGreaterThan(100);
  });
});

describe("stand-in core: import order (spec 2.4.10, 2.5)", () => {
  it("probe, then proxy/audio/transcription in parallel, streamed transcript, then suggestions", async () => {
    const { core, scheduler, events } = setup({ transcriptBatches: 5 });
    const project = await core.createProject(["D:\\Footage\\Interview.mp4"]);
    const sourceId = project.sources[0]!.id;

    // Probe has finished by the time the call resolves; nothing else is running yet.
    const early = jobEvents(events);
    expect(early.filter((j) => j.kind === "probe").map((j) => j.state)).toEqual(["queued", "running", "done"]);
    expect(early.some((j) => j.kind !== "probe" && j.state === "running")).toBe(false);
    expect(project.sources[0]!.media.duration).toBeGreaterThan(0);

    const jobsNow = await core.listJobs();
    expect(jobsNow.filter((j) => j.state === "queued").map((j) => j.kind).sort()).toEqual(
      ["audio", "proxy", "transcribe", "waveform"],
    );

    scheduler.runAll();
    const idx = (pred: (e: Recorded) => boolean) => events.findIndex(pred);
    const lastIdx = (pred: (e: Recorded) => boolean) => events.map(pred).lastIndexOf(true);
    const job = (kind: string, state: string) => (e: Recorded) =>
      e.event === "job_updated" && e.payload.kind === kind && e.payload.state === state;

    const probeDone = idx(job("probe", "done"));
    const proxyRunning = idx(job("proxy", "running"));
    const audioRunning = idx(job("audio", "running"));
    const transcribeRunning = idx(job("transcribe", "running"));
    const audioDone = idx(job("audio", "done"));
    const proxyDone = idx(job("proxy", "done"));
    const firstAppend = idx((e) => e.event === "transcript_appended");
    const lastAppend = lastIdx((e) => e.event === "transcript_appended");
    const completed = idx((e) => e.event === "transcript_completed");
    const suggestQueued = idx(job("suggest", "queued"));
    const firstReady = idx((e) => e.event === "suggestions_ready");
    const lastReady = lastIdx((e) => e.event === "suggestions_ready");

    expect(probeDone).toBeGreaterThanOrEqual(0);
    // proxy and audio run at the same time
    expect(probeDone).toBeLessThan(proxyRunning);
    expect(probeDone).toBeLessThan(audioRunning);
    expect(proxyRunning).toBeLessThan(audioDone);
    expect(audioRunning).toBeLessThan(proxyDone);
    // transcription streams while audio is extracted
    expect(transcribeRunning).toBeLessThan(firstAppend);
    expect(firstAppend).toBeLessThan(audioDone);
    // several batches, all before completion
    expect(events.filter((e) => e.event === "transcript_appended")).toHaveLength(5);
    expect(lastAppend).toBeLessThan(completed);
    // suggestions only once the transcript is complete: dead air first, then Claude
    expect(completed).toBeLessThan(suggestQueued);
    expect(suggestQueued).toBeLessThan(firstReady);
    const ready = events.flatMap((e) => (e.event === "suggestions_ready" ? [e.payload] : []));
    expect(ready).toHaveLength(2);
    expect(ready[0]!.claudeModel).toBeUndefined();
    expect(ready[0]!.suggestions.every((s) => s.kind === "dead_air" && s.origin === "local")).toBe(true);
    expect(ready[1]!.claudeModel).toBeDefined();
    expect(ready[1]!.suggestions.some((s) => s.origin === "claude")).toBe(true);
    expect(firstReady).toBeLessThan(lastReady);
    expect(events.some((e) => e.event === "suggestions_unavailable")).toBe(false);

    // assets: original first, then proxy; transcript partial, then complete; suggestions ready
    const assets = events.flatMap((e) => (e.event === "source_assets_changed" ? [e.payload] : []));
    expect(assets[0]!.playback).toBe("original");
    expect(assets.at(-1)!.playback).toBe("proxy");
    expect(assets.map((a) => a.transcript)).toEqual(expect.arrayContaining(["partial", "complete"]));
    expect(assets.findIndex((a) => a.transcript === "partial")).toBeLessThan(
      assets.findIndex((a) => a.transcript === "complete"),
    );
    expect(assets.some((a) => a.waveformUrl !== null)).toBe(true);
    const opened = await core.openProject(project.id);
    expect(opened.assets[0]).toMatchObject({ playback: "proxy", transcript: "complete", suggestions: "ready" });

    // the streamed batches add up to the stored transcript
    const streamed = events.flatMap((e) => (e.event === "transcript_appended" ? e.payload.utterances : []));
    const t = await core.getTranscript(sourceId);
    expect(t.complete).toBe(true);
    expect(streamed).toEqual(t.utterances);
    expect(t.utterances.length).toBeGreaterThanOrEqual(120);

    // every import job ends done
    const final = new Map<string, JobStatus>();
    for (const j of jobEvents(events)) final.set(j.id, j);
    expect([...final.values()].every((j) => j.state === "done")).toBe(true);
    expect(new Set([...final.values()].map((j) => j.kind))).toEqual(
      new Set(["probe", "proxy", "audio", "waveform", "transcribe", "suggest"]),
    );
  });

  it("get_transcript returns the transcript as far as it has got", async () => {
    const { core, scheduler } = setup({ stepMs: 100, transcriptBatches: 4 });
    const p = await core.createProject(["D:\\Footage\\A.mp4"]);
    const id = p.sources[0]!.id;
    expect((await core.getTranscript(id)).utterances).toHaveLength(0);
    scheduler.advance(300); // start + two batches
    const partial = await core.getTranscript(id);
    expect(partial.complete).toBe(false);
    expect(partial.utterances.length).toBeGreaterThan(0);
    scheduler.runAll();
    expect((await core.getTranscript(id)).complete).toBe(true);
  });

  it("works with Vitest fake timers and the default scheduler", async () => {
    vi.useFakeTimers();
    const core = createStandinCore({ stepMs: 200 });
    cores.push(core);
    const completed = vi.fn();
    core.onTranscriptCompleted(completed);
    const p = await core.createProject(["D:\\Footage\\A.mp4"]);
    expect(completed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(completed).toHaveBeenCalledWith({ sourceId: p.sources[0]!.id });
  });

  it("cancelling transcription stops it; open_project restarts the unfinished work", async () => {
    const { core, scheduler, events } = setup();
    const p = await core.createProject(["D:\\Footage\\A.mp4"]);
    scheduler.advance(600);
    const transcribe = (await core.listJobs()).find((j) => j.kind === "transcribe")!;
    await core.cancelJob(transcribe.id);
    scheduler.runAll();
    expect(events.some((e) => e.event === "transcript_completed")).toBe(false);
    const after = (await core.listJobs()).find((j) => j.id === transcribe.id)!;
    expect(after.state).toBe("cancelled");
    expect(after.error?.code).toBe("cancelled");

    const opened = await core.openProject(p.id);
    expect(opened.assets[0]!.transcript).toBe("partial");
    scheduler.runAll();
    expect(events.some((e) => e.event === "transcript_completed")).toBe(true);
    const t = await core.getTranscript(p.sources[0]!.id);
    expect(t.complete).toBe(true);
    // resumed, not restarted from zero: no utterance arrives twice
    const streamed = events.flatMap((e) => (e.event === "transcript_appended" ? e.payload.utterances : []));
    expect(streamed).toEqual(t.utterances);
  });

  it("unsubscribing stops delivery", async () => {
    const { core, scheduler } = setup();
    const h = vi.fn();
    const off = core.onJobUpdated(h);
    off();
    off();
    await core.createProject(["D:\\Footage\\A.mp4"]);
    scheduler.runAll();
    expect(h).not.toHaveBeenCalled();
  });
});

describe("stand-in core: projects, saving and export", () => {
  it("save_edit stores what it is given and open_project returns it", async () => {
    const { core } = setup();
    const { project } = await core.openProject(DEMO_PROJECT_ID);
    const clip = project.edit.current.clips[0]!;
    const edit = {
      current: { clips: [{ ...clip, end: 10_010_000 }], dismissed: [] },
      undo: [project.edit.current],
      redo: [],
    };
    const session = { view: "timeline" as const, playhead: { sourceId: clip.sourceId, at: 5_000_000 }, playbackRate: 1.5 as const, cutTextHidden: true };
    await core.saveEdit(DEMO_PROJECT_ID, edit, session);
    const again = await core.openProject(DEMO_PROJECT_ID);
    expect(again.project.edit).toEqual(edit);
    expect(again.project.session).toEqual(session);
    const summary = (await core.listProjects()).find((p) => p.id === DEMO_PROJECT_ID)!;
    expect(summary.keptDuration).toBe(10_010_000);
  });

  it("add_sources does not touch the edit (spec 3.4 rule 5)", async () => {
    const { core } = setup();
    const p = await core.createProject(["D:\\Footage\\A.mp4"]);
    await core.addSources(p.id, ["D:\\Footage\\B.mp4"]);
    const { project } = await core.openProject(p.id);
    expect(project.sources).toHaveLength(2);
    expect(project.edit.current.clips).toHaveLength(1);
  });

  it("export progresses and ends with export_finished", async () => {
    const { core, scheduler, events } = setup();
    const { project } = await core.openProject(DEMO_PROJECT_ID);
    const plan = await core.planExport({ projectId: project.id, clips: project.edit.current.clips, folder: "D:\\Exports", fileName: "Weekly" });
    expect(plan.blockedBy).toBeUndefined();
    expect(plan.format).toMatchObject({ codec: "h264", width: 3840, height: 2160 });
    const jobId = await core.startExport({ projectId: project.id, clips: project.edit.current.clips, folder: "D:\\Exports", fileName: "Weekly" });
    scheduler.runAll();
    const updates = jobEvents(events).filter((j) => j.id === jobId);
    expect(updates[0]!.state).toBe("queued");
    expect(updates.at(-1)!.state).toBe("done");
    const progress = updates.map((j) => j.progress);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    const finished = events.find((e) => e.event === "export_finished");
    expect(finished?.payload).toMatchObject({ path: "D:\\Exports\\Weekly.mp4", duration: plan.duration });
    const summary = (await core.listProjects()).find((p) => p.id === DEMO_PROJECT_ID)!;
    expect(summary.lastExportedAt).toBeDefined();
  });

  it("a cancelled export sends no export_finished", async () => {
    const { core, scheduler, events } = setup();
    const { project } = await core.openProject(DEMO_PROJECT_ID);
    const jobId = await core.startExport({ projectId: project.id, clips: project.edit.current.clips, folder: "D:\\E", fileName: "x" });
    scheduler.advance(300);
    await core.cancelJob(jobId);
    scheduler.runAll();
    expect(events.some((e) => e.event === "export_finished")).toBe(false);
    expect((await core.listJobs()).find((j) => j.id === jobId)!.state).toBe("cancelled");
  });

  it("nothing to export blocks the plan", async () => {
    const { core } = setup();
    const plan = await core.planExport({ projectId: DEMO_PROJECT_ID, clips: [], folder: "D:\\E", fileName: "x" });
    expect(plan.blockedBy?.code).toBe("nothing_to_export");
    const err = await rejection(core.startExport({ projectId: DEMO_PROJECT_ID, clips: [], folder: "D:\\E", fileName: "x" }));
    expect(err.code).toBe("nothing_to_export");
  });
});

describe("stand-in core: injected errors surface as AppError", () => {
  it("Claude signed out: dead air still arrives, then suggestions_unavailable", async () => {
    const { core, scheduler, events } = setup({ errors: { claudeSignedOut: true } });
    expect((await core.claudeStatus()).signedIn).toBe(false);
    const p = await core.createProject(["D:\\Footage\\A.mp4"]);
    scheduler.runAll();
    const ready = events.filter((e) => e.event === "suggestions_ready");
    expect(ready).toHaveLength(1);
    const unavailable = events.find((e) => e.event === "suggestions_unavailable");
    expect(unavailable?.payload).toMatchObject({ sourceId: p.sources[0]!.id, error: { code: "claude_signed_out" } });
    expect(isAppError(unavailable!.payload.error)).toBe(true);
    const suggest = jobEvents(events).filter((j) => j.kind === "suggest").at(-1)!;
    expect(suggest.state).toBe("failed");
    expect(suggest.error?.code).toBe("claude_signed_out");
    expect((await core.openProject(p.id)).assets[0]!.suggestions).toBe("unavailable");

    // signing in and retrying works
    core.setErrors({ claudeSignedOut: false });
    const jobId = await core.retrySuggestions(p.sources[0]!.id);
    scheduler.runAll();
    expect((await core.listJobs()).find((j) => j.id === jobId)!.state).toBe("done");
    expect((await core.getSuggestions(p.sources[0]!.id)).claudeModel).toBeDefined();
  });

  it("missing source: refused on import, offline in a project, blocks export, fixed by locate", async () => {
    const { core, events } = setup({ errors: { missingSources: ["D:\\Gone.mp4"] } });
    const err = await rejection(core.createProject(["D:\\Gone.mp4"]));
    expect(err).toMatchObject({ code: "source_missing", detail: "D:\\Gone.mp4" });

    core.setErrors({ missingSources: [DEMO_SOURCE_ID] });
    const changed = events.filter((e) => e.event === "source_assets_changed").at(-1);
    expect(changed?.payload).toMatchObject({ sourceId: DEMO_SOURCE_ID, online: false });
    const { project, assets } = await core.openProject(DEMO_PROJECT_ID);
    expect(assets[0]!.online).toBe(false);
    expect((await core.listProjects()).find((p) => p.id === DEMO_PROJECT_ID)!.missingSources).toBe(1);

    const request = { projectId: DEMO_PROJECT_ID, clips: project.edit.current.clips, folder: "D:\\E", fileName: "x" };
    expect((await core.planExport(request)).blockedBy?.code).toBe("source_missing");
    expect((await rejection(core.startExport(request))).code).toBe("source_missing");

    core.setErrors({ mismatchPaths: ["E:\\Other.mp4"] });
    expect((await rejection(core.locateSource(DEMO_PROJECT_ID, DEMO_SOURCE_ID, "E:\\Other.mp4"))).code).toBe("source_mismatch");
    const found = await core.locateSource(DEMO_PROJECT_ID, DEMO_SOURCE_ID, "E:\\TAKE-1.mp4");
    expect(found.online).toBe(true);
    expect((await core.planExport(request)).blockedBy).toBeUndefined();
  });

  it("disk full blocks the export", async () => {
    const { core } = setup({ errors: { diskFull: true } });
    const { project } = await core.openProject(DEMO_PROJECT_ID);
    const request = { projectId: DEMO_PROJECT_ID, clips: project.edit.current.clips, folder: "D:\\E", fileName: "x" };
    const plan = await core.planExport(request);
    expect(plan.blockedBy?.code).toBe("disk_full");
    expect(plan.freeBytes).toBeLessThan(plan.estimatedBytes);
    expect((await rejection(core.startExport(request))).code).toBe("disk_full");
  });

  it("failNext rejects the next call of a command only", async () => {
    const { core } = setup();
    core.failNext("list_projects", { code: "internal", message: "boom", detail: "x" });
    expect(await rejection(core.listProjects())).toEqual({ code: "internal", message: "boom", detail: "x" });
    await expect(core.listProjects()).resolves.toHaveLength(1);
  });

  it("unknown ids reject with an AppError", async () => {
    const { core } = setup();
    const calls: (() => Promise<unknown>)[] = [
      () => core.openProject("nope"),
      () => core.getTranscript("nope"),
      () => core.cancelJob("nope"),
      () => core.removeProject("nope"),
      () => core.createProject([]),
    ];
    for (const c of calls) expect((await rejection(c())).code).toBe("internal");
  });
});

describe("stand-in core: pickers", () => {
  it("returns the configured choices", async () => {
    const { core } = setup({ pickedFiles: ["D:\\a.mp4", "D:\\b.mp4"], pickedFolder: null });
    expect(await core.pickFiles()).toEqual(["D:\\a.mp4", "D:\\b.mp4"]);
    expect(await core.pickFiles({ multiple: false })).toEqual(["D:\\a.mp4"]);
    expect(await core.pickFolder()).toBeNull();
  });
});

// Type-level: a stand-in is a CoreClient.
const _typeCheck: (c: StandinCore) => CoreClient = (c) => c;
void _typeCheck;
