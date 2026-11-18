/**
 * The stand-in core: an in-memory `CoreClient` that behaves like a working core, for
 * interface development and tests. No Tauri dependency.
 *
 * - Holds projects in memory, seeded with a demo project (see `demoData.ts`).
 * - `createProject` / `addSources` fabricate a `SourceRef` with plausible `MediaInfo` and
 *   start import "jobs" that tick forward on timers, in the order of spec 2.4.10 and 2.5:
 *   probe (during the call), then proxy, audio, waveform and transcription in parallel,
 *   the transcript streamed in batches, then suggestions (dead air first, then Claude's).
 * - Export jobs progress and end with `export_finished`.
 * - Errors can be injected: Claude signed out, missing sources, disk full, a different file
 *   on "Locate file", or any `AppError` for the next call of a given command.
 * - Timers come from a `Scheduler`: pass a `ManualScheduler` (or use Vitest fake timers
 *   with the default) for deterministic tests.
 *
 * Every method resolves with a copy of the data (callers cannot change the core's state
 * by mutating results) or rejects with an `AppError`. Probe `job_updated` events are
 * sent during `createProject` / `addSources`, before the call resolves, like the real core.
 *
 * Simplifications: `clearCache` drops proxies and waveforms but keeps transcripts and
 * suggestions; every imported source gets the demo transcript and suggestions.
 */
import type {
  AppError,
  CacheUsage,
  ClaudeStatus,
  Clip,
  EventName,
  EventPayloads,
  ExportPlan,
  ExportRequest,
  ExportResult,
  JobId,
  JobKind,
  JobStatus,
  MediaItem,
  OpenedProject,
  Project,
  ProjectId,
  ProjectSummary,
  Settings,
  SourceAssets,
  SourceId,
  SourceRef,
  SuggestionSet,
  SuggestionsProgress,
  Transcript,
  Utterance,
} from "../../types";
import { EVENTS, firstClipEnd, mediaUrl as sharedMediaUrl } from "../../types";
import {
  appError,
  type CommandName,
  type CoreClient,
  type EventHandler,
  type SettingsPatch,
  type Unsubscribe,
} from "./client";
import {
  DEMO_CLAUDE_MODEL,
  DEMO_PROJECT_ID,
  DEMO_SOURCE_ID,
  DEMO_SPEECH_MODEL,
  demoProject,
  demoSuggestions,
  demoTranscript,
  demoTranscriptBatches,
  fabricateMediaInfo,
  fingerprintFor,
} from "./demoData";
import { realScheduler, type Scheduler } from "./scheduler";
import type { ExportPlanWithNeeds } from "../exportPlan";

export interface StandinErrors {
  /** `claude_status` says signed out; suggest jobs fail with `claude_signed_out` after dead air. */
  claudeSignedOut: boolean;
  /**
   * Source ids or file paths whose original file is missing. Such paths are refused by
   * `createProject` / `addSources` (`source_missing`); such sources are offline, and
   * export is blocked. Changing this list sends `source_assets_changed`.
   */
  missingSources: string[];
  /** Paths that "Locate file" rejects as a different file (`source_mismatch`). */
  mismatchPaths: string[];
  /** `plan_export` is blocked by `disk_full` and `start_export` rejects with it. */
  diskFull: boolean;
  /**
   * The transcriber stops after this many transcript batches: the transcription fails with
   * `transcriber_failed` and, as the real core does (rc-jobs), the partial transcript is dropped
   * and `source_assets_changed` says `transcript: "none"`. Null (the default): it never fails.
   */
  transcriberCrashAfter: number | null;
}

/** The files the media server serves for a source (spec 3.5.6); the shared type from `types`. */
export type { MediaItem } from "../../types";

export interface StandinOptions {
  /** Timers. Default: the global `setTimeout` (so Vitest fake timers work). */
  scheduler?: Scheduler;
  /** Time between job steps, in milliseconds. Default 250. */
  stepMs?: number;
  /** Seed the demo project. Default true. */
  seedDemo?: boolean;
  /** Number of `transcript_appended` batches per import. Default 6. */
  transcriptBatches?: number;
  errors?: Partial<StandinErrors>;
  /** Clock for timestamps. Default `new Date()`. */
  now?: () => Date;
  /** Free space reported by `plan_export` when the disk is not full. Default 500 GB. */
  freeBytes?: number;
  /** What the file picker "chooses". `null` = cancelled. */
  pickedFiles?: string[] | null;
  /** What the folder picker "chooses". `null` = cancelled. */
  pickedFolder?: string | null;
  /**
   * Playback and waveform addresses. Default: the real form built by the shared `mediaUrl`,
   * on the fake origin `standin://media-server` with token `standin`, i.e.
   * `standin://media-server/media/{sourceId}/{item}?token=standin`.
   */
  mediaUrl?: (sourceId: SourceId, item: MediaItem) => string;
}

export interface StandinCore extends CoreClient {
  /** Changes the injected errors; fields left out stay as they are. */
  setErrors(errors: Partial<StandinErrors>): void;
  readonly errors: Readonly<StandinErrors>;
  /** The next call of `command` rejects with `error` (queued; one per call). */
  failNext(command: CommandName, error: AppError): void;
  /** Paths passed to `revealFile`, oldest first. */
  readonly revealed: readonly string[];
  /** The seeded demo project and source ids (present unless `seedDemo: false`). */
  readonly demo: { projectId: ProjectId; sourceId: SourceId };
  /** Stops every pending timer and drops all subscribers. */
  dispose(): void;
}

interface SourceState {
  ref: SourceRef;
  proxyReady: boolean;
  waveformReady: boolean;
  utterances: Utterance[];
  transcriptComplete: boolean;
  suggestions: SuggestionSet;
  suggestionsState: SuggestionsProgress;
  importing: boolean;
}

const clone = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);

const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  exportFolder: "D:\\Exports",
  keyBindings: [],
  speechModel: "parakeet-tdt-0.6b-v2",
  speechDevice: "auto",
  claudeModel: "opus",
  claudeAuth: "subscription",
  claudeCodeVersionTested: "2.1.0",
  cacheLimitBytes: 50 * 1024 ** 3,
};

const GB = 1024 ** 3;
/** Proxy size: about 1 GB per hour (spec 2.4.2). */
const proxyBytes = (duration: number) => Math.round((duration / 3_600_000_000) * GB);

export function createStandinCore(options: StandinOptions = {}): StandinCore {
  const scheduler = options.scheduler ?? realScheduler;
  const stepMs = options.stepMs ?? 250;
  const batches = Math.max(2, options.transcriptBatches ?? 6);
  const now = options.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const mediaUrl =
    options.mediaUrl ?? ((id: SourceId, item: MediaItem) => sharedMediaUrl("standin://media-server", "standin", id, item));
  const pickedFiles = options.pickedFiles === undefined ? ["D:\\Footage\\TAKE-2.mp4"] : options.pickedFiles;
  const pickedFolder = options.pickedFolder === undefined ? "D:\\Exports" : options.pickedFolder;

  const errors: StandinErrors = {
    claudeSignedOut: false,
    missingSources: [],
    mismatchPaths: [],
    diskFull: false,
    transcriberCrashAfter: null,
    ...options.errors,
  };

  const projects = new Map<ProjectId, Project>();
  const sources = new Map<SourceId, SourceState>();
  const jobs = new Map<JobId, JobStatus>();
  const handlers = new Map<EventName, Set<(payload: never) => void>>();
  const timers = new Set<unknown>();
  const failures = new Map<CommandName, AppError[]>();
  const revealed: string[] = [];
  let settings: Settings = clone(DEFAULT_SETTINGS);
  let nextJob = 1;
  let nextProject = 1;
  let disposed = false;

  // ---- events ----

  function emit<E extends EventName>(event: E, payload: EventPayloads[E]): void {
    if (disposed) return;
    const set = handlers.get(event);
    if (!set) return;
    for (const h of [...set]) {
      (h as EventHandler<E>)(clone(payload));
    }
  }

  function subscribe<E extends EventName>(event: E, handler: EventHandler<E>): Unsubscribe {
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    const h = handler as (payload: never) => void;
    set.add(h);
    return () => {
      handlers.get(event)?.delete(h);
    };
  }

  function later(ms: number, fn: () => void): void {
    if (disposed) return;
    const handle: unknown = scheduler.setTimeout(() => {
      timers.delete(handle);
      if (!disposed) fn();
    }, ms);
    timers.add(handle);
  }

  /** Runs `steps` one after another, `stepMs` apart. A step returning false stops the chain. */
  function chain(steps: (() => boolean | void)[]): void {
    const run = (i: number) => {
      const step = steps[i];
      if (!step) return;
      later(stepMs, () => {
        if (step() === false) return;
        run(i + 1);
      });
    };
    run(0);
  }

  // ---- commands ----

  function run<T>(command: CommandName, body: () => T): Promise<T> {
    const queued = failures.get(command);
    const injected = queued?.shift();
    if (injected) return Promise.reject(clone(injected));
    try {
      return Promise.resolve(clone(body()));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function project(id: ProjectId): Project {
    const p = projects.get(id);
    if (!p) throw appError("internal", `No project with id ${id}`);
    return p;
  }

  function source(id: SourceId): SourceState {
    const s = sources.get(id);
    if (!s) throw appError("internal", `No source with id ${id}`);
    return s;
  }

  function isMissing(id: SourceId): boolean {
    const s = sources.get(id);
    return errors.missingSources.includes(id) || (!!s && errors.missingSources.includes(s.ref.path));
  }

  function assets(id: SourceId): SourceAssets {
    const s = source(id);
    const online = !isMissing(id);
    const playback = s.proxyReady
      ? "proxy"
      : online && s.ref.media.directPlayable
        ? "original"
        : "none";
    return {
      sourceId: id,
      online,
      playback,
      playbackUrl: playback === "none" ? null : mediaUrl(id, playback),
      waveformUrl: s.waveformReady ? mediaUrl(id, "waveform") : null,
      transcript: s.transcriptComplete ? "complete" : s.utterances.length > 0 ? "partial" : "none",
      suggestions: s.suggestionsState,
    };
  }

  const emitAssets = (id: SourceId) => emit(EVENTS.sourceAssetsChanged, assets(id));

  // ---- jobs ----

  function newJob(kind: JobKind, sourceId?: SourceId, projectId?: ProjectId): JobStatus {
    const job: JobStatus = { id: `job-${nextJob++}`, kind, state: "queued", progress: 0 };
    if (sourceId !== undefined) job.sourceId = sourceId;
    if (projectId !== undefined) job.projectId = projectId;
    jobs.set(job.id, job);
    emit(EVENTS.jobUpdated, job);
    return job;
  }

  const active = (job: JobStatus) => job.state === "queued" || job.state === "running";

  function updateJob(job: JobStatus, patch: Partial<JobStatus>, stepsLeft?: number): void {
    if (!active(job)) return;
    Object.assign(job, patch);
    if (job.state === "running" && stepsLeft !== undefined) {
      job.secondsLeft = (stepsLeft * stepMs) / 1000;
    } else {
      delete job.secondsLeft;
    }
    emit(EVENTS.jobUpdated, job);
  }

  const finish = (job: JobStatus) => updateJob(job, { state: "done", progress: 1 });

  function fail(job: JobStatus, error: AppError): void {
    updateJob(job, { state: "failed", error });
  }

  // ---- import (spec 2.4.10, 2.5) ----

  function probe(projectId: ProjectId, id: SourceId): void {
    const job = newJob("probe", id, projectId);
    updateJob(job, { state: "running", progress: 0 });
    finish(job);
  }

  function startImport(projectId: ProjectId, id: SourceId): void {
    const s = source(id);
    if (s.importing) return;
    const needTranscript = !s.transcriptComplete;
    const needProxy = !s.proxyReady;
    const needWaveform = !s.waveformReady;
    if (!needTranscript && !needProxy && !needWaveform) return;
    s.importing = true;

    const proxy = needProxy ? newJob("proxy", id, projectId) : undefined;
    const audio = needTranscript ? newJob("audio", id, projectId) : undefined;
    const waveform = needWaveform ? newJob("waveform", id, projectId) : undefined;
    const transcribe = needTranscript ? newJob("transcribe", id, projectId) : undefined;
    // A restarted transcription resumes after the utterances already received.
    const have = s.utterances.length;
    const parts = needTranscript
      ? demoTranscriptBatches(batches)
          .map((b) => b.filter((u) => u.index > have)) // indexes start at 1
          .filter((b) => b.length > 0)
      : [];
    const total = parts.length + 5; // steps until the proxy is ready
    const proxyAt = (step: number) => {
      if (proxy) updateJob(proxy, { progress: Math.min(0.99, step / total) }, total - step);
    };

    const steps: (() => boolean | void)[] = [];
    // 1: everything starts in parallel; the player can use the original meanwhile.
    steps.push(() => {
      if (proxy) updateJob(proxy, { state: "running", progress: 0 }, total);
      if (audio) updateJob(audio, { state: "running", progress: 0 }, parts.length);
      if (transcribe) updateJob(transcribe, { state: "running", progress: 0 }, parts.length + 1);
      if (waveform) updateJob(waveform, { state: "running", progress: 0 }, 2);
      emitAssets(id);
    });
    // 2..: the transcript streams in as audio arrives.
    parts.forEach((batch, k) => {
      steps.push(() => {
        if (audio && audio.state === "cancelled" && transcribe) {
          updateJob(transcribe, { state: "cancelled" });
        }
        if (transcribe && active(transcribe) && errors.transcriberCrashAfter !== null && k >= errors.transcriberCrashAfter) {
          fail(transcribe, appError("transcriber_failed", "The transcriber stopped unexpectedly."));
          if (audio && active(audio)) updateJob(audio, { state: "cancelled" });
          s.utterances = [];
          emitAssets(id);
        }
        if (transcribe && active(transcribe)) {
          s.utterances.push(...batch);
          emit(EVENTS.transcriptAppended, { sourceId: id, utterances: batch });
          updateJob(transcribe, { progress: (k + 1) / (parts.length + 1) }, parts.length - k);
          if (k === 0) emitAssets(id);
        }
        if (audio) {
          if (k >= parts.length - 2) finish(audio);
          else updateJob(audio, { progress: (k + 1) / (parts.length - 1) }, parts.length - 2 - k);
        }
        if (waveform && k <= 1) {
          if (k === 1 && active(waveform)) {
            finish(waveform);
            s.waveformReady = true;
            emitAssets(id);
          } else updateJob(waveform, { progress: 0.5 }, 1);
        }
        proxyAt(k + 2);
      });
    });
    // Transcript complete, then suggestions.
    if (transcribe) {
      steps.push(() => {
        proxyAt(parts.length + 2);
        if (audio && active(audio)) finish(audio);
        if (!active(transcribe)) return;
        finish(transcribe);
        s.transcriptComplete = true;
        emit(EVENTS.transcriptCompleted, { sourceId: id });
        s.suggestionsState = "working";
        emitAssets(id);
        suggest(projectId, id);
      });
      steps.push(() => proxyAt(parts.length + 3));
      steps.push(() => proxyAt(parts.length + 4));
    } else if (waveform) {
      steps.push(() => {
        finish(waveform);
        s.waveformReady = true;
        emitAssets(id);
      });
    }
    // Proxy ready: the player switches to it.
    steps.push(() => {
      s.importing = false;
      if (proxy && active(proxy)) {
        finish(proxy);
        s.proxyReady = true;
        emitAssets(id);
      }
    });
    chain(steps);
  }

  /** The suggest job: dead air first (local), then Claude's answer or `suggestions_unavailable`. */
  function suggest(projectId: ProjectId | undefined, id: SourceId): JobStatus {
    const s = source(id);
    const job = newJob("suggest", id, projectId);
    s.suggestionsState = "working";
    chain([
      () => {
        if (!active(job)) return false;
        updateJob(job, { state: "running", progress: 0.3 }, 2);
        s.suggestions = demoSuggestions(id, false);
        emit(EVENTS.suggestionsReady, s.suggestions);
      },
      () => {
        if (!active(job)) return false;
        updateJob(job, { progress: 0.7 }, 1);
      },
      () => {
        if (!active(job)) {
          if (s.suggestionsState === "working") s.suggestionsState = "none";
          return false;
        }
        if (errors.claudeSignedOut) {
          const error = appError(
            "claude_signed_out",
            "Claude Code is signed out. Run `claude` once in a terminal to sign in, then retry.",
          );
          fail(job, error);
          s.suggestionsState = "unavailable";
          emit(EVENTS.suggestionsUnavailable, { sourceId: id, error });
        } else {
          s.suggestions = demoSuggestions(id, true);
          s.suggestions.claudeModel = settings.claudeModel || DEMO_CLAUDE_MODEL;
          emit(EVENTS.suggestionsReady, s.suggestions);
          finish(job);
          s.suggestionsState = "ready";
        }
        emitAssets(id);
      },
    ]);
    return job;
  }

  function addSource(projectId: ProjectId, path: string): SourceRef {
    if (errors.missingSources.includes(path)) {
      throw appError("source_missing", "The file is not there any more.", path);
    }
    const id = fingerprintFor(path);
    let s = sources.get(id);
    if (!s) {
      s = {
        ref: { id, path, addedAt: iso(), media: fabricateMediaInfo(path) },
        proxyReady: false,
        waveformReady: false,
        utterances: [],
        transcriptComplete: false,
        suggestions: { schemaVersion: 1, sourceId: id, suggestions: [] },
        suggestionsState: "none",
        importing: false,
      };
      sources.set(id, s);
    } else {
      s.ref = { ...s.ref, path, addedAt: iso() };
    }
    probe(projectId, id);
    return clone(s.ref);
  }

  function fileName(path: string): string {
    const base = path.split(/[\\/]/).pop() ?? path;
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(0, dot) : base;
  }

  // ---- export ----

  function plan(request: ExportRequest): ExportPlan {
    project(request.projectId);
    const clips: Clip[] = request.clips;
    const duration = clips.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0);
    const first = clips[0] ? sources.get(clips[0].sourceId) : undefined;
    const media = first?.ref.media ?? fabricateMediaInfo("none.mp4");
    const v = media.video;
    const format = {
      codec: v.codec === "hevc" ? ("hevc" as const) : ("h264" as const),
      width: v.width,
      height: v.height,
      frameRate: v.frameRate,
      bitDepth: v.bitDepth,
      hdr: v.hdr,
      audioTracks: media.audioTracks.length,
    };
    const seconds = duration / 1_000_000;
    const estimatedBytes = Math.round(seconds * (v.width >= 3840 ? 7_500_000 : 2_500_000));
    const result: ExportPlan = {
      duration,
      format,
      estimatedBytes,
      estimatedSeconds: Math.round(seconds / 5),
      freeBytes: options.freeBytes ?? 500 * GB,
      notices: [],
    };
    const differs = clips.some((c) => {
      const m = sources.get(c.sourceId)?.ref.media.video;
      return (
        !!m &&
        (m.width !== v.width ||
          m.height !== v.height ||
          m.codec !== v.codec ||
          m.frameRate.num * v.frameRate.den !== v.frameRate.num * m.frameRate.den)
      );
    });
    if (differs) result.notices.push("Sources differ; the export follows the first clip.");

    if (clips.length === 0 || duration === 0) {
      result.blockedBy = appError("nothing_to_export", "Nothing is kept, so there is nothing to export.");
    } else if (clips.some((c) => !sources.has(c.sourceId) || isMissing(c.sourceId))) {
      const missing = clips.find((c) => !sources.has(c.sourceId) || isMissing(c.sourceId));
      result.blockedBy = appError(
        "source_missing",
        "A source file is missing. Locate it before exporting.",
        missing ? sources.get(missing.sourceId)?.ref.path ?? missing.sourceId : undefined,
      );
    } else if (errors.diskFull) {
      // Like the real core: the file plus its temporary pieces, about three times the estimate.
      const required = estimatedBytes * 3;
      result.freeBytes = Math.floor(estimatedBytes / 3);
      (result as ExportPlanWithNeeds).requiredBytes = required;
      // The amounts travel in requiredBytes and freeBytes; the Export dialog writes them out.
      result.blockedBy = appError(
        "disk_full",
        "Not enough free space in the export folder.",
        `${request.folder}: needs about ${required} bytes, ${result.freeBytes} free`,
      );
    }
    return result;
  }

  function exportPath(request: ExportRequest): string {
    const name = /\.mp4$/i.test(request.fileName) ? request.fileName : `${request.fileName}.mp4`;
    const sep = request.folder.endsWith("\\") || request.folder.endsWith("/") ? "" : "\\";
    return `${request.folder}${sep}${name}`;
  }

  // ---- seed ----

  if (options.seedDemo ?? true) {
    const p = demoProject();
    projects.set(p.id, p);
    const ref = p.sources[0];
    if (ref) {
      const t = demoTranscript(ref.id);
      sources.set(ref.id, {
        ref,
        proxyReady: true,
        waveformReady: true,
        utterances: t.utterances,
        transcriptComplete: true,
        suggestions: demoSuggestions(ref.id, true),
        suggestionsState: "ready",
        importing: false,
      });
    }
  }

  // ---- the client ----

  const core: StandinCore = {
    listProjects: () =>
      run("list_projects", (): ProjectSummary[] =>
        [...projects.values()]
          .map((p) => {
            const summary: ProjectSummary = {
              id: p.id,
              name: p.name,
              rawDuration: p.sources.reduce((sum, s) => sum + s.media.duration, 0),
              keptDuration: p.edit.current.clips.reduce((sum, c) => sum + (c.end - c.start), 0),
              updatedAt: p.updatedAt,
              missingSources: p.sources.filter((s) => isMissing(s.id)).length,
            };
            if (p.lastExport) summary.lastExportedAt = p.lastExport.finishedAt;
            return summary;
          })
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      ),

    createProject: (paths) =>
      run("create_project", (): Project => {
        const unique = [...new Set(paths)];
        if (unique.length === 0) throw appError("internal", "No files were given.");
        const missing = unique.find((p) => errors.missingSources.includes(p));
        if (missing) throw appError("source_missing", "The file is not there any more.", missing);
        const id = `project-${nextProject++}`;
        const refs = unique.map((path) => addSource(id, path));
        const first = refs[0];
        if (!first) throw appError("internal", "No files were given.");
        const stamp = iso();
        const p: Project = {
          schemaVersion: 1,
          id,
          name: fileName(first.path),
          createdAt: stamp,
          updatedAt: stamp,
          frameRate: first.media.video.frameRate,
          sources: refs,
          edit: {
            current: {
              // One clip per source, [0, duration floored to the sequence grid) (rc-types `Clip`);
              // a source shorter than one frame gets none.
              clips: refs.flatMap((r, i) => {
                const end = firstClipEnd(r.media.duration, first.media.video.frameRate);
                return end === null ? [] : [{ id: `clip-${i + 1}`, sourceId: r.id, start: 0, end }];
              }),
              dismissed: [],
            },
            undo: [],
            redo: [],
          },
          session: { view: "transcript", playhead: null, playbackRate: 1, cutTextHidden: false },
        };
        projects.set(id, p);
        for (const r of refs) startImport(id, r.id);
        return p;
      }),

    openProject: (projectId) =>
      run("open_project", (): OpenedProject => {
        const p = project(projectId);
        for (const r of p.sources) startImport(projectId, r.id); // restarts unfinished work only
        return { project: p, assets: p.sources.map((r) => assets(r.id)) };
      }),

    saveEdit: (projectId, edit, session) =>
      run("save_edit", (): void => {
        const p = project(projectId);
        p.edit = clone(edit);
        p.session = clone(session);
        p.updatedAt = iso();
      }),

    renameProject: (projectId, name) =>
      run("rename_project", (): void => {
        const p = project(projectId);
        p.name = name;
        p.updatedAt = iso();
      }),

    removeProject: (projectId) =>
      run("remove_project", (): void => {
        project(projectId);
        projects.delete(projectId);
      }),

    addSources: (projectId, paths) =>
      run("add_sources", (): SourceRef[] => {
        const p = project(projectId);
        const missing = paths.find((path) => errors.missingSources.includes(path));
        if (missing) throw appError("source_missing", "The file is not there any more.", missing);
        const added: SourceRef[] = [];
        for (const path of new Set(paths)) {
          const ref = addSource(projectId, path);
          if (!p.sources.some((s) => s.id === ref.id)) {
            p.sources.push(ref);
            added.push(ref);
          }
        }
        p.updatedAt = iso();
        for (const r of added) startImport(projectId, r.id);
        return added;
      }),

    locateSource: (projectId, sourceId, newPath) =>
      run("locate_source", (): SourceAssets => {
        const p = project(projectId);
        const ref = p.sources.find((s) => s.id === sourceId);
        if (!ref) throw appError("internal", `Source ${sourceId} is not in this project.`);
        if (errors.mismatchPaths.includes(newPath)) {
          throw appError("source_mismatch", "That is a different file from the one in the project.", newPath);
        }
        const s = source(sourceId);
        errors.missingSources = errors.missingSources.filter(
          (m) => m !== sourceId && m !== s.ref.path && m !== ref.path,
        );
        s.ref = { ...s.ref, path: newPath };
        ref.path = newPath;
        p.updatedAt = iso();
        const a = assets(sourceId);
        emit(EVENTS.sourceAssetsChanged, a);
        return a;
      }),

    getTranscript: (sourceId) =>
      run("get_transcript", (): Transcript => {
        const s = source(sourceId);
        return {
          schemaVersion: 1,
          sourceId,
          model: DEMO_SPEECH_MODEL,
          complete: s.transcriptComplete,
          utterances: s.utterances,
        };
      }),

    getSuggestions: (sourceId) => run("get_suggestions", (): SuggestionSet => source(sourceId).suggestions),

    retrySuggestions: (sourceId) =>
      run("retry_suggestions", (): JobId => {
        const s = source(sourceId);
        if (!s.transcriptComplete) {
          throw appError("internal", "The transcript is not complete yet; suggestions start when it is.");
        }
        const running = [...jobs.values()].find((j) => j.kind === "suggest" && j.sourceId === sourceId && active(j));
        if (running) return running.id;
        const projectId = [...projects.values()].find((p) => p.sources.some((r) => r.id === sourceId))?.id;
        const job = suggest(projectId, sourceId);
        emitAssets(sourceId);
        return job.id;
      }),

    listJobs: () => run("list_jobs", (): JobStatus[] => [...jobs.values()]),

    cancelJob: (jobId) =>
      run("cancel_job", (): void => {
        const job = jobs.get(jobId);
        if (!job) throw appError("internal", `No job with id ${jobId}`);
        if (!active(job)) return;
        updateJob(job, {
          state: "cancelled",
          error: appError("cancelled", "Cancelled."),
        });
      }),

    planExport: (request) => run("plan_export", () => plan(request)),

    startExport: (request) =>
      run("start_export", (): JobId => {
        const planned = plan(request);
        if (planned.blockedBy) throw planned.blockedBy;
        const job = newJob("export", undefined, request.projectId);
        const startedAt = now().getTime();
        const pieces = Math.min(8, Math.max(2, request.clips.length + 2)); // clips, then audio and join
        const steps: (() => boolean | void)[] = [];
        for (let i = 0; i < pieces; i++) {
          steps.push(() => {
            if (!active(job)) return false;
            updateJob(job, { state: "running", progress: i / pieces }, pieces - i);
          });
        }
        steps.push(() => {
          if (!active(job)) return false;
          const result: ExportResult = {
            path: exportPath(request),
            duration: planned.duration,
            bytes: planned.estimatedBytes,
            tookSeconds: Math.max(0, (now().getTime() - startedAt) / 1000),
            finishedAt: iso(),
          };
          const p = projects.get(request.projectId);
          if (p) p.lastExport = result;
          finish(job);
          emit(EVENTS.exportFinished, result);
        });
        chain(steps);
        return job.id;
      }),

    revealFile: (path) =>
      run("reveal_file", (): void => {
        revealed.push(path);
      }),

    claudeStatus: () =>
      run("claude_status", (): ClaudeStatus => {
        const status: ClaudeStatus = {
          installed: true,
          version: "2.1.0",
          versionTested: true,
          signedIn: !errors.claudeSignedOut,
        };
        if (!errors.claudeSignedOut) status.authMethod = "Claude subscription";
        return status;
      }),

    getSettings: () => run("get_settings", (): Settings => settings),

    updateSettings: (changes: SettingsPatch) =>
      run("update_settings", (): Settings => {
        const next = { ...settings };
        for (const [k, v] of Object.entries(changes)) {
          if (v !== undefined && k in next && k !== "schemaVersion") {
            (next as Record<string, unknown>)[k] = clone(v);
          }
        }
        settings = next;
        return settings;
      }),

    cacheUsage: () =>
      run("cache_usage", (): CacheUsage => {
        let used = 0;
        for (const s of sources.values()) {
          if (s.proxyReady) used += proxyBytes(s.ref.media.duration);
          if (s.waveformReady) used += Math.round(s.ref.media.duration / 10_000); // 100 values/s
          if (s.utterances.length) used += 200_000;
        }
        return { usedBytes: used, limitBytes: settings.cacheLimitBytes };
      }),

    clearCache: () =>
      run("clear_cache", (): void => {
        for (const s of sources.values()) {
          if (s.importing || (!s.proxyReady && !s.waveformReady)) continue;
          s.proxyReady = false;
          s.waveformReady = false;
          emitAssets(s.ref.id);
        }
      }),

    subscribe,
    onJobUpdated: (h) => subscribe(EVENTS.jobUpdated, h),
    onSourceAssetsChanged: (h) => subscribe(EVENTS.sourceAssetsChanged, h),
    onTranscriptAppended: (h) => subscribe(EVENTS.transcriptAppended, h),
    onTranscriptCompleted: (h) => subscribe(EVENTS.transcriptCompleted, h),
    onSuggestionsReady: (h) => subscribe(EVENTS.suggestionsReady, h),
    onSuggestionsUnavailable: (h) => subscribe(EVENTS.suggestionsUnavailable, h),
    onExportFinished: (h) => subscribe(EVENTS.exportFinished, h),

    pickFiles: async (pickOptions) => {
      if (pickedFiles === null) return null;
      return pickOptions?.multiple === false ? pickedFiles.slice(0, 1) : [...pickedFiles];
    },
    pickFolder: async () => pickedFolder,

    setErrors(next) {
      const before = new Set([...sources.keys()].filter(isMissing));
      Object.assign(errors, clone(next));
      for (const id of sources.keys()) {
        if (before.has(id) !== isMissing(id)) emitAssets(id); // went missing, or was found
      }
    },
    get errors() {
      return clone(errors);
    },
    failNext(command, error) {
      const list = failures.get(command) ?? [];
      list.push(clone(error));
      failures.set(command, list);
    },
    get revealed() {
      return [...revealed];
    },
    demo: { projectId: DEMO_PROJECT_ID, sourceId: DEMO_SOURCE_ID },
    dispose() {
      disposed = true;
      for (const t of timers) scheduler.clearTimeout(t);
      timers.clear();
      handlers.clear();
    },
  };
  return core;
}
