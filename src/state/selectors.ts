/**
 * Selectors: what the screens read from the store, worked out once per state change. Each takes
 * the whole state; the ones that build objects remember their last answer, so they return the
 * same object while their inputs are the same (safe for `useRoughcut` without a shallow compare).
 */
import { canRedo, canUndo, cutPoints, sequenceDuration, type CutPoint, type PlacedClip } from "../edit";
import type { HintScreen, KeyScope } from "../keys";
import {
  captionAt,
  caretSourcePosition,
  isCollapsed,
  selectionToRanges,
  suggestionAt,
  type Caption,
  type SuggestionView,
} from "../transcript";
import type { Clip, JobStatus, KeyContext, SourceId, SourcePosition, SourceRange, SourceRef } from "../types";
import { clipUnder } from "./store";
import type { RoughcutState, SourceEntry } from "./types";

/** Remembers the last answer for the same inputs (compared by identity). */
function memo<const A extends readonly unknown[], R>(
  inputs: (s: RoughcutState) => A,
  compute: (...a: [...A]) => R,
): (s: RoughcutState) => R {
  let last: A | null = null;
  let value: R;
  return (s) => {
    const a = inputs(s);
    if (last && a.length === last.length && a.every((x, i) => Object.is(x, last![i]))) return value;
    last = a;
    value = compute(...(a as unknown as [...A]));
    return value;
  };
}

/**
 * The key scope for `attachKeys`: the Export dialog and its stage; else "everywhere" while the
 * shortcut overlay or the Locate file prompt is open (they are modal: view keys such as Delete
 * do nothing behind them, Esc closes them, Enter locates the file, see `attachStoreKeys`); else
 * Home, else the editor view.
 */
export const selectKeyScope = memo(
  (s) => [s.dialogs.export?.phase ?? null, s.dialogs.shortcuts, s.dialogs.locate !== null, s.screen, s.session.view] as const,
  (phase, shortcuts, locate, screen, view): KeyContext | KeyScope => {
    // The ? overlay sits above everything, the Export dialog included: only Esc, ? and the
    // other everywhere keys reach the store (and the store's modal rule drops the rest).
    if (shortcuts) return "everywhere";
    // The Locate prompt is hidden while the Export dialog is open, so the dialog keeps its keys.
    if (phase) return { context: "export", phase };
    if (locate) return "everywhere";
    if (screen === "home") return "home";
    return view;
  },
);

/** The clips in playing order (empty with no project). */
export const selectClips = (s: RoughcutState): readonly Clip[] => s.edit?.current.clips ?? NO_CLIPS;
const NO_CLIPS: readonly Clip[] = [];

/** Length of the edited sequence ("41:12 kept"). */
export const selectSequenceDuration = memo(
  (s) => [s.edit?.current ?? null] as const,
  (state) => (state ? sequenceDuration(state) : 0),
);

/** Whether Ctrl+Z / Ctrl+Shift+Z would do something. */
export const selectCanUndo = (s: RoughcutState): boolean => !!s.edit && canUndo(s.edit);
export const selectCanRedo = (s: RoughcutState): boolean => !!s.edit && canRedo(s.edit);

/** Every cut point in playing order. */
export const selectCutPoints = memo(
  (s) => [s.edit?.current ?? null] as const,
  (state): readonly CutPoint[] => (state ? cutPoints(state) : []),
);

/** The clip under the playhead (the double-bordered one on the timeline). */
export const selectCurrentClip = memo(
  (s) => [s.edit?.current ?? null, s.playhead.time] as const,
  (state, t): PlacedClip | null => (state ? clipUnder(state, t) : null),
);

/** "cut 2 of 14": the number of cut points at or before the playhead, and how many there are. */
export const selectCutCounter = memo(
  (s) => [selectCutPoints(s), s.playhead.time] as const,
  (cuts, t) => ({ index: cuts.filter((c) => c.at <= t + 1_000).length, count: cuts.length }),
);

/** The project's sources with what is known about each, in project order. */
export const selectProjectSources = memo(
  (s) => [s.project?.sources ?? null, s.sources] as const,
  (refs, sources): readonly { ref: SourceRef; entry: SourceEntry | null }[] =>
    (refs ?? []).map((ref) => ({ ref, entry: sources[ref.id] ?? null })),
);

/** Sources whose file is missing (online false). */
export const selectMissingSources = memo(
  (s) => [selectProjectSources(s)] as const,
  (list) => list.filter((x) => x.entry?.assets?.online === false).map((x) => x.ref),
);

/** Each project source's waveform address (null until ready). */
export const selectWaveformUrls = memo(
  (s) => [selectProjectSources(s)] as const,
  (list): Readonly<Record<SourceId, string | null>> =>
    Object.fromEntries(list.map((x) => [x.ref.id, x.entry?.assets?.waveformUrl ?? null])),
);

/** Jobs of the open project's sources (and its export), newest first by id order of arrival. */
export const selectProjectJobs = memo(
  (s) => [s.jobs, s.project] as const,
  (jobs, project): readonly JobStatus[] => {
    if (!project) return [];
    const ids = new Set(project.sources.map((r) => r.id));
    return Object.values(jobs).filter((j) => (j.sourceId && ids.has(j.sourceId)) || j.projectId === project.id);
  },
);

/**
 * The "Transcribing 34%, about 3 min left" line (spec 1.7 B): over the project's sources whose
 * transcript is not complete. Null when every transcript is complete.
 */
export const selectTranscribing = memo(
  (s) => [selectProjectSources(s), s.jobs] as const,
  (list, jobs): { progress: number; secondsLeft: number | null; sources: number } | null => {
    // Only sources whose transcription is on its way: a failed one, or one that cannot start
    // (no transcriber), is not "transcribing" (the notice says what happened).
    const latest = (id: string) =>
      Object.values(jobs)
        .filter((j) => j.kind === "transcribe" && j.sourceId === id)
        .pop();
    const open = list.filter((x) => {
      if (x.entry?.assets?.transcript === "complete" || x.entry?.transcript?.complete) return false;
      const job = latest(x.ref.id);
      if (job) return job.state === "queued" || job.state === "running";
      // No job reported yet: text already arriving, or the import has only just begun.
      return x.entry?.assets?.transcript === "partial" || x.entry?.assets == null;
    });
    if (open.length === 0) return null;
    let progress = 0;
    let left: number | null = null;
    for (const x of open) {
      const job = Object.values(jobs)
        .filter((j) => j.kind === "transcribe" && j.sourceId === x.ref.id)
        .pop();
      // The transcriber reports progress at most once a second, so text can run ahead of the
      // job's figure: never show less than the part of the source that already has text.
      const utterances = x.entry?.transcript?.utterances ?? [];
      const reached = utterances.length > 0 ? utterances[utterances.length - 1]!.end : 0;
      const duration = x.ref.media.duration;
      const textShare = duration > 0 ? Math.min(1, reached / duration) : 0;
      progress += Math.max(job ? (job.state === "done" ? 1 : job.progress) : 0, textShare);
      if (job?.secondsLeft !== undefined) left = Math.max(left ?? 0, job.secondsLeft);
    }
    return { progress: progress / open.length, secondsLeft: left, sources: open.length };
  },
);

/**
 * The first-run speech model download (spec 2.4.9, 3.2 milestone 6), while one is queued or
 * running: the core runs it as a `model_download` job of no source. Several packages are
 * downloaded one job each; the line follows the earliest one still on its way. Null otherwise.
 */
export const selectModelDownload = memo(
  (s) => [s.jobs] as const,
  (jobs): { progress: number; secondsLeft: number | null } | null => {
    const open = Object.values(jobs).filter((j) => j.kind === "model_download" && (j.state === "queued" || j.state === "running"));
    const job = open[0];
    if (!job) return null;
    return { progress: Math.max(0, Math.min(1, job.progress)), secondsLeft: job.secondsLeft ?? null };
  },
);

/** Pending suggestions in the transcript ("3 suggestions"). */
export const selectPendingSuggestions = memo(
  (s) => [s.layout] as const,
  (layout): readonly SuggestionView[] => (layout ? layout.suggestions.filter((v) => v.state === "pending") : []),
);

/** The suggestion A / D act on: the current one if still pending, else the pending one at the caret. */
export const selectActiveSuggestion = memo(
  (s) => [s.layout, s.currentSuggestion, s.selection] as const,
  (layout, current, sel): SuggestionView | null => {
    if (!layout) return null;
    if (current) {
      const v = layout.suggestions.find((x) => x.suggestion.id === current);
      if (v && v.state === "pending") return v;
    }
    const at = suggestionAt(layout, Math.min(sel.anchor, sel.focus));
    return at && at.state === "pending" ? at : null;
  },
);

/** The source ranges the selection covers (the "Selection" panel); empty for a caret. */
export const selectSelectedRanges = memo(
  (s) => [s.layout, s.selection] as const,
  (layout, sel): readonly SourceRange[] => (layout && !isCollapsed(sel) ? selectionToRanges(layout, sel) : []),
);

/** Where the caret is ("TAKE-1.mp4 at 0:27.4"): the playhead's source position, else the caret's token. */
export const selectCaretPosition = memo(
  (s) => [s.layout, s.selection.focus, s.playhead.position] as const,
  (layout, focus, position): SourcePosition | null =>
    position ?? (layout ? caretSourcePosition(layout, focus) : null),
);

/** The Timeline view's one-line caption around the playhead. */
export const selectCaption = memo(
  (s) => [s.layout, s.playhead.position] as const,
  (layout, position): Caption | null => (layout && position ? captionAt(layout, position) : null),
);

/** Which hint bar to show (spec 1.7, `screenHints` in keys). */
export const selectHintScreen = memo(
  (s) => [s.screen, s.dialogs.export?.phase ?? null, s.session.view, selectActiveSuggestion(s), selectTranscribing(s)] as const,
  (screen, phase, view, suggestion, transcribing): HintScreen => {
    if (phase === "confirm") return "exportConfirm";
    if (phase === "running") return "exportRunning";
    if (phase === "done") return "exportDone";
    if (screen === "home") return "home";
    if (view === "timeline") return "timeline";
    if (suggestion) return "suggestion";
    return transcribing ? "transcribing" : "transcript";
  },
);

/** True when everything is cut: export is disabled with a note (spec 1.12). */
export const selectNothingKept = (s: RoughcutState): boolean => !!s.edit && s.edit.current.clips.length === 0;

/** The selected Home row's project, or null. */
export const selectSelectedProject = (s: RoughcutState) => s.projects[s.homeSelection] ?? null;
