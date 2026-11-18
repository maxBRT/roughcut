/**
 * The store (spec 3.3 `state`): one zustand store per app (or per test), and the code that runs
 * every action. Views and keys both go through `dispatch(actionId, payload?)`, so the mouse and
 * the keyboard do the same thing (spec 3.6 rule 1).
 *
 * - Edits run synchronously inside `dispatch` (spec 2.4.7): the next `EditDocument` is in the
 *   store before `dispatch` returns. `save_edit` follows shortly afterwards, in the background.
 * - Every core event is folded into the store, whichever project it belongs to.
 * - The player is kept loaded with the current clips and playback addresses; the caret and the
 *   playhead are kept the same thing (spec 1.8 rule 6).
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type { CoreClient } from "./core/client";
import { toAppError } from "./core/client";
import {
  appendSource,
  canRedo,
  canUndo,
  clipAt,
  contextFromProject,
  cutPoints,
  cutRanges,
  dismissSuggestion,
  moveClip,
  nearestCutPoint,
  nudgeEdge,
  redo,
  removeClip,
  restoreRanges,
  sequenceDuration,
  sequenceTimeOf,
  sourcePositionAt,
  splitAt,
  trimEdge,
  undo,
  type EditContext,
  type PlacedClip,
} from "../edit";
import { createKeymap, KEY_ACTIONS, rebind, resetAction, toOverrides, type Keymap } from "../keys";
import type { PlaybackRate, PlayerEvent, PlayerInput, PlayerSource, ShuttleKey, StepAmount } from "../player";
import {
  anchorSelection,
  caretAt,
  caretForSource,
  caretSequenceTime,
  findInTranscript,
  isCollapsed,
  layoutTranscript,
  markToRanges,
  moveCaret,
  nextMatch,
  nextPendingSuggestion,
  positionOf,
  previousMatch,
  previousPendingSuggestion,
  resolveSelection,
  sameAddress,
  selectedSpan,
  selectionToRanges,
  selectTokens,
  suggestionAt,
  tokensToRanges,
  type CaretMotion,
  type FindMatch,
  type LayoutInput,
  type SuggestionView,
  type TextSelection,
  type VisualLines,
} from "../transcript";
import type {
  ActionId,
  AppError,
  Clip,
  EditDocument,
  EditState,
  ExportResult,
  JobStatus,
  OpenedProject,
  Project,
  SequenceTime,
  SessionState,
  SourceAssets,
  SourceId,
  SourcePosition,
  SourceRange,
  SourceRef,
  SuggestionSet,
  Transcript,
  Utterance,
} from "../types";
import { frameToMicros, microsToFrameFloor } from "../types";
import type {
  Dispatch,
  EditorView,
  ExportDialogState,
  Notice,
  Playhead,
  PlayerLike,
  RoughcutState,
  SourceEntry,
  UiActionPayloads,
} from "./types";

// ---- options and public type ------------------------------------------------------------

/** Timers the store uses for autosave (default: the global ones, so Vitest fake timers work). */
export interface StoreTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** What `createRoughcutStore` takes. */
export interface StoreOptions {
  /** The core: `getCore()` in the app, `createStandinCore()` in a test. */
  core: CoreClient;
  /** A player to drive from the start (tests); the app attaches the real one with `attachPlayer`. */
  player?: PlayerLike | null;
  /** Delay between an edit and its `save_edit`, in ms (default 300). */
  autosaveMs?: number;
  /** Delay before saving a change of playhead or view alone, in ms (default 2000). */
  sessionSaveMs?: number;
  timers?: StoreTimers;
  /** For "Copy path" (default: `navigator.clipboard` when there is one). */
  clipboard?: { writeText(text: string): Promise<void> } | null;
  /** Clock, for the export file name (default `new Date()`). */
  now?: () => Date;
}

/** The store: zustand's API plus the action dispatcher and the wiring the app needs. */
export interface RoughcutStore extends StoreApi<RoughcutState> {
  readonly core: CoreClient;
  /** Runs an action (a keys registry id or a `ui.*` id). */
  readonly dispatch: Dispatch;
  /** Every action id `dispatch` handles. */
  readonly actionIds: readonly ActionId[];
  /** Loads the project list, settings and Claude's status. Later calls return the first call's promise. */
  init(): Promise<void>;
  /** The player to drive (`PlayerView`'s `onPlayer`); null when it unmounts. */
  attachPlayer(player: PlayerLike | null): void;
  /** The Transcript view's visual lines, for Up / Down by line; null to fall back to paragraphs. */
  setVisualLines(lines: VisualLines | null): void;
  /** Writes unsaved changes now (on close, before switching project). */
  flushSave(): Promise<void>;
  /**
   * The window is closing: pauses the player and saves until nothing is left unsaved. False
   * when a save failed.
   */
  prepareToClose(): Promise<boolean>;
  /** Resolves when every dispatched action and save in flight has finished (tests). */
  idle(): Promise<void>;
  /** Stops listening to the core and the player and cancels timers. */
  dispose(): void;
}

// ---- constants and small helpers ---------------------------------------------------------

/** Most zoomed in the timeline goes (1 = fit). */
export const ZOOM_MAX = 1024;

const DEFAULT_SESSION: SessionState = { view: "transcript", playhead: null, playbackRate: 1, cutTextHidden: false };
const STOPPED: Playhead = { time: 0, position: null, playing: false, speed: 0 };
const EMPTY_CLIPS: readonly Clip[] = [];
const CLAUDE_NOTICE = "claude";
const UPDATE_NOTICE = "update";
/** Tolerance for "at a cut", in microseconds. */
const AT_CUT_US = 1_000;

const emptyEntry = (): SourceEntry => ({ assets: null, transcript: null, suggestions: null, suggestionsError: null });

function initialState(): RoughcutState {
  return {
    ready: false,
    screen: "home",
    dialogs: { export: null, shortcuts: false, locate: null },
    projects: [],
    homeSelection: 0,
    busy: null,
    project: null,
    edit: null,
    session: DEFAULT_SESSION,
    sources: {},
    jobs: {},
    notices: [],
    layout: null,
    selection: { anchor: 0, focus: 0 },
    playhead: STOPPED,
    marks: { in: null, out: null },
    find: { open: false, query: "", matches: [], index: -1, focusRequest: 0 },
    currentSuggestion: null,
    zoom: 1,
    claude: null,
    settings: null,
    keymap: createKeymap(),
    rebindError: null,
    save: { pending: false, saving: false, lastSavedAt: null, error: null },
    buffering: false,
    playerError: null,
  };
}

function samePosition(a: SourcePosition | null, b: SourcePosition | null): boolean {
  return a === b || (!!a && !!b && a.sourceId === b.sourceId && a.at === b.at);
}

/** The file name of a path, without folders. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** The export file name offered by default: the project name as a slug, then the date. */
export function defaultExportFileName(projectName: string, date: Date): string {
  const slug =
    projectName
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "export";
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return slug.endsWith(ymd) ? `${slug}.mp4` : `${slug}-${ymd}.mp4`;
}

/** The clip under sequence time `t`; at the very end of the sequence, the last clip. */
export function clipUnder(state: EditState, t: SequenceTime): PlacedClip | null {
  const placed = clipAt(state, t);
  if (placed) return placed;
  const n = state.clips.length;
  if (n === 0 || t < sequenceDuration(state)) return null;
  const clip = state.clips[n - 1]!;
  return { clip, index: n - 1, sequenceStart: sequenceDuration(state) - (clip.end - clip.start) };
}

/** Joins utterances by `index` (later copies win), in index order. Returns `base` itself when nothing is new. */
function mergeUtterances(base: readonly Utterance[], incoming: readonly Utterance[]): Utterance[] | null {
  if (incoming.length === 0) return null;
  const last = base[base.length - 1];
  if (!last || incoming.every((u, i) => u.index > last.index && (i === 0 || u.index > incoming[i - 1]!.index))) {
    return [...base, ...incoming];
  }
  const by = new Map<number, Utterance>();
  for (const u of base) by.set(u.index, u);
  let changed = false;
  for (const u of incoming) {
    if (!by.has(u.index)) changed = true;
    by.set(u.index, u);
  }
  if (!changed) return null;
  return [...by.values()].sort((a, b) => a.index - b.index);
}

/** The transcript after receiving `incoming` (a full `get_transcript` answer). */
function mergeTranscript(existing: Transcript | null, incoming: Transcript): Transcript {
  if (!existing) return incoming;
  const merged = mergeUtterances(existing.utterances, incoming.utterances);
  const complete = existing.complete || incoming.complete;
  const model = incoming.model || existing.model;
  if (!merged && complete === existing.complete && model === existing.model) return existing;
  return { ...existing, model, complete, utterances: merged ?? existing.utterances };
}

/** Same format for export purposes: codec, size and frame rate. */
function sameFormat(a: SourceRef, b: SourceRef): boolean {
  const x = a.media.video;
  const y = b.media.video;
  return (
    x.codec === y.codec &&
    x.width === y.width &&
    x.height === y.height &&
    x.frameRate.num * y.frameRate.den === y.frameRate.num * x.frameRate.den
  );
}

/**
 * Actions that still act while the Export dialog is open. A notice's Retry also acts (the
 * notices sit above the dialog): `ui.retry*`, and whatever action a notice on screen offers.
 */
function modalAllowed(action: ActionId, notices: readonly Notice[]): boolean {
  return (
    action.startsWith("export.") ||
    action.startsWith("ui.retry") ||
    notices.some((n) => n.retry?.action === action) ||
    action === "everywhere.showShortcuts" ||
    action === "everywhere.escape" ||
    action === "ui.exportFileName" ||
    action === "ui.closeShortcuts" ||
    action === "ui.dismissNotice" ||
    action === "ui.rebindKey" ||
    action === "ui.resetKey" ||
    action === "ui.resetAllKeys"
  );
}

// ---- the store -------------------------------------------------------------------------

/** Creates a store driving `options.core` (and `options.player`, if given). */
export function createRoughcutStore(options: StoreOptions): RoughcutStore {
  const core = options.core;
  const timers: StoreTimers = options.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const autosaveMs = options.autosaveMs ?? 300;
  const sessionSaveMs = options.sessionSaveMs ?? 2000;
  const now = options.now ?? (() => new Date());
  const clipboard =
    options.clipboard !== undefined
      ? options.clipboard
      : typeof navigator !== "undefined" && navigator.clipboard
        ? { writeText: (t: string) => navigator.clipboard.writeText(t) }
        : null;

  const api = createStore<RoughcutState>()(() => initialState());
  const get = api.getState;
  const set = (patch: Partial<RoughcutState>) => api.setState(patch);

  let player: PlayerLike | null = null;
  let unsubscribePlayer: (() => void) | null = null;
  let visualLines: VisualLines | null = null;
  /** Non-playing player frames move the caret only after a seek the caret did not ask for. */
  let caretFollowsPlayer = false;
  /**
   * The store's own seek (`placePlayhead`) the player has not finished yet. Until it has, the
   * player's paused frames are of earlier seeks: they must not move the playhead back (three
   * quick → then `O` would mark a word the caret already left).
   */
  let seekToken = 0;
  let seekPending = false;
  let disposed = false;
  const inflight = new Set<Promise<unknown>>();
  /** Sources whose Locate prompt was closed this session: not asked again. */
  const locateDismissed = new Set<SourceId>();
  let planSeq = 0;
  /** True while an update is being downloaded and installed. */
  let updating = false;

  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p);
    const done = () => inflight.delete(p);
    p.then(done, done);
    return p;
  };

  // ---- notices ----

  function pushNotice(notice: Notice): void {
    const rest = get().notices.filter((n) => n.id !== notice.id);
    set({ notices: [...rest, notice] });
  }

  function dropNotice(id: string): void {
    const s = get();
    if (s.notices.some((n) => n.id === id)) set({ notices: s.notices.filter((n) => n.id !== id) });
  }

  function errorNotice(id: string, prefix: string, error: unknown): void {
    const e = toAppError(error);
    pushNotice({ id, kind: "error", text: prefix ? `${prefix}: ${e.message}` : e.message });
  }

  // ---- derived state: layout, selection, find ----

  let ctxCache: { sources: readonly SourceRef[]; frameRate: Project["frameRate"]; ctx: EditContext } | null = null;
  function editContext(project: Project): EditContext {
    if (!ctxCache || ctxCache.sources !== project.sources || ctxCache.frameRate !== project.frameRate) {
      ctxCache = { sources: project.sources, frameRate: project.frameRate, ctx: contextFromProject(project) };
    }
    return ctxCache.ctx;
  }

  interface InputKey {
    edit: EditState;
    sources: readonly SourceRef[];
    hide: boolean;
    transcripts: (Transcript | null)[];
    suggestions: (SuggestionSet | null)[];
  }
  let lastKey: InputKey | null = null;

  /** Sources with a transcription queued or running (their text is on its way). */
  function transcribingSourceIds(jobs: RoughcutState["jobs"]): Set<SourceId> {
    const ids = new Set<SourceId>();
    for (const j of Object.values(jobs)) {
      if (j.kind === "transcribe" && j.sourceId !== undefined && (j.state === "queued" || j.state === "running")) ids.add(j.sourceId);
    }
    return ids;
  }

  /**
   * An empty, incomplete transcript per source (kept the same object, so the layout is not
   * worked out again for nothing): what the layout is given for a source whose transcription
   * has started but has sent no text yet, so its kept time shows as "text appears here as it
   * is transcribed" rather than "no transcript".
   */
  const underwayTranscripts = new Map<SourceId, Transcript>();
  function underwayTranscript(sourceId: SourceId): Transcript {
    let t = underwayTranscripts.get(sourceId);
    if (!t) {
      t = { schemaVersion: 1, sourceId, model: "", complete: false, utterances: [] };
      underwayTranscripts.set(sourceId, t);
    }
    return t;
  }

  function keyOf(s: RoughcutState): InputKey | null {
    if (!s.project || !s.edit) return null;
    const underway = transcribingSourceIds(s.jobs);
    return {
      edit: s.edit.current,
      sources: s.project.sources,
      hide: s.session.cutTextHidden,
      transcripts: s.project.sources.map(
        (r) => s.sources[r.id]?.transcript ?? (underway.has(r.id) ? underwayTranscript(r.id) : null),
      ),
      suggestions: s.project.sources.map((r) => s.sources[r.id]?.suggestions ?? null),
    };
  }

  function sameKey(a: InputKey | null, b: InputKey | null): boolean {
    if (a === null || b === null) return a === b;
    return (
      a.edit === b.edit &&
      a.sources === b.sources &&
      a.hide === b.hide &&
      a.transcripts.length === b.transcripts.length &&
      a.transcripts.every((t, i) => t === b.transcripts[i]) &&
      a.suggestions.every((t, i) => t === b.suggestions[i])
    );
  }

  function layoutInput(s: RoughcutState, key: InputKey): LayoutInput {
    const transcripts: Record<SourceId, Transcript | null> = {};
    const suggestions: Record<SourceId, SuggestionSet | null> = {};
    s.project!.sources.forEach((r, i) => {
      transcripts[r.id] = key.transcripts[i] ?? null;
      suggestions[r.id] = key.suggestions[i] ?? null;
    });
    return {
      frameRate: s.project!.frameRate,
      sources: s.project!.sources,
      transcripts,
      edit: key.edit,
      suggestions,
      hideCut: key.hide,
    };
  }

  /** Works out the layout (and re-anchors the selection and find matches) for a state about to be set. */
  function derive(before: RoughcutState, next: RoughcutState): Partial<RoughcutState> {
    const key = keyOf(next);
    if (key === null) {
      lastKey = null;
      return next.layout !== null ? { layout: null, selection: { anchor: 0, focus: 0 } } : {};
    }
    if (next.layout && sameKey(lastKey, key)) return {};
    lastKey = key;
    // A patch that sets `layout: null` (opening a project) starts afresh.
    const old = next.layout && before.project?.id === next.project?.id ? next.layout : null;
    const layout = layoutTranscript(layoutInput(next, key), old);
    let selection: TextSelection;
    if (!old || old.tokens.length === 0) {
      const b = next.playhead.position ? caretForSource(layout, next.playhead.position) : null;
      selection = caretAt(layout, b ?? 0);
    } else {
      selection = resolveSelection(layout, anchorSelection(old, next.selection));
    }
    const out: Partial<RoughcutState> = { layout, selection };
    if (next.find.query !== "") {
      const matches = findInTranscript(layout, next.find.query);
      const prev = next.find.matches[next.find.index];
      const index = prev ? matches.findIndex((m) => sameAddress(m.first, prev.first)) : -1;
      out.find = { ...next.find, matches, index };
    }
    return out;
  }

  /** Sets `patch`, then the derived layout, then keeps the player loaded. */
  function commit(patch: Partial<RoughcutState>): void {
    const before = get();
    const next = { ...before, ...patch };
    set({ ...patch, ...derive(before, next) });
    syncPlayer();
  }

  function patchSource(id: SourceId, patch: Partial<SourceEntry>): void {
    const s = get();
    const entry = s.sources[id] ?? emptyEntry();
    commit({ sources: { ...s.sources, [id]: { ...entry, ...patch } } });
  }

  const inProject = (s: RoughcutState, id: SourceId | undefined): boolean =>
    !!id && !!s.project && s.project.sources.some((r) => r.id === id);

  // ---- player ----

  let loaded: { player: PlayerLike; clips: readonly Clip[]; urls: string } | null = null;

  function playerInput(s: RoughcutState): { input: PlayerInput; urls: string } {
    const sources = new Map<SourceId, PlayerSource>();
    const parts: string[] = [];
    for (const r of s.project?.sources ?? []) {
      const url = s.sources[r.id]?.assets?.playbackUrl ?? null;
      sources.set(r.id, { url, duration: r.media.duration });
      parts.push(`${r.id}=${url ?? ""}`);
    }
    return {
      input: {
        clips: s.edit?.current.clips ?? EMPTY_CLIPS,
        sources,
        frameRate: s.project?.frameRate ?? { num: 30, den: 1 },
      },
      urls: parts.join("\n"),
    };
  }

  /** Loads the player again when the clips or a playback address changed (spec 3.5.3 Load). */
  function syncPlayer(): void {
    if (!player) return;
    const s = get();
    const { input, urls } = playerInput(s);
    if (loaded && loaded.player === player && loaded.clips === input.clips && loaded.urls === urls) return;
    loaded = { player, clips: input.clips, urls };
    player.load(input);
  }

  function onPlayerEvent(e: PlayerEvent): void {
    if (disposed) return;
    const s = get();
    switch (e.type) {
      case "frame": {
        const f = e.frame;
        if (seekPending && !f.playing) return;
        const patch: Partial<RoughcutState> = {
          playhead: { time: f.time, position: f.position, playing: f.playing, speed: f.speed },
        };
        // Playback works again: the error and its notice go away together.
        if (f.playing && s.playerError) patch.playerError = null;
        if (f.playing && s.notices.some((n) => n.id === "player")) {
          patch.notices = s.notices.filter((n) => n.id !== "player");
        }
        if ((f.playing || caretFollowsPlayer) && s.layout && f.position && isCollapsed(s.selection)) {
          const b = caretForSource(s.layout, f.position);
          if (b !== null && b !== s.selection.focus) patch.selection = { anchor: b, focus: b };
        }
        if (s.project && !samePosition(s.session.playhead, f.position)) {
          patch.session = { ...s.session, playhead: f.position };
          markDirty("session");
        }
        set(patch);
        return;
      }
      case "ended":
        set({ playhead: { ...s.playhead, playing: false, speed: 0 } });
        return;
      case "buffering":
        set({ buffering: e.buffering });
        return;
      case "error": {
        set({ playerError: e.error, playhead: { ...s.playhead, playing: false, speed: 0 } });
        // A source whose assets the core has not reported yet (the project is shown before the
        // first source_assets_changed arrives) is not known to be unplayable: no notice. If it
        // stays without an address, the assets event or the next press of play says so.
        if (e.error.code === "no_address" && e.error.sourceId && !s.sources[e.error.sourceId]?.assets) return;
        const text =
          e.error.code === "no_address"
            ? "This part cannot play yet: its preview copy is still being made."
            : e.error.code === "play_rejected"
              ? "Playback did not start. Press Space again."
              : `This video cannot be played: ${e.error.message}`;
        pushNotice({ id: "player", kind: "warning", text });
        return;
      }
    }
  }

  function attachPlayer(next: PlayerLike | null): void {
    if (next === player) return;
    unsubscribePlayer?.();
    unsubscribePlayer = null;
    player = next;
    loaded = null;
    seekToken++;
    seekPending = false;
    if (!player) return;
    unsubscribePlayer = player.subscribe(onPlayerEvent);
    const s = get();
    syncPlayer();
    player.setRate(s.session.playbackRate);
    if (s.project) void player.seek(s.playhead.time).catch(() => undefined);
  }

  // ---- playhead and caret (spec 1.8 rule 6) ----

  function duration(s: RoughcutState): number {
    return s.edit ? sequenceDuration(s.edit.current) : 0;
  }

  /**
   * Puts the playhead at sequence time `t`. `caret: "follow"` moves the caret there too (a seek
   * from the timeline, a step, a jump); `"keep"` leaves it (the caret asked for this seek).
   */
  function placePlayhead(t: SequenceTime, caret: "follow" | "keep"): void {
    if (!setPlayheadNow(t, caret)) return;
    const time = get().playhead.time;
    if (player) awaitLanding(player, player.seek(time), caret);
  }

  /**
   * Sets the playhead (and, for "follow", the caret) to sequence time `t` at once, before the
   * player has shown it, so the next key acts on where the user moved to. False with no edit.
   */
  function setPlayheadNow(t: SequenceTime, caret: "follow" | "keep"): boolean {
    const s = get();
    if (!s.edit) return false;
    const time = Math.max(0, Math.min(duration(s), Math.round(t)));
    const position = sourcePositionAt(s.edit.current, time);
    const patch: Partial<RoughcutState> = { playhead: { ...s.playhead, time, position } };
    if (caret === "follow" && s.layout) {
      const b = position ? caretForSource(s.layout, position) : null;
      patch.selection = caretAt(s.layout, b ?? s.selection.focus);
    }
    if (!samePosition(s.session.playhead, position)) patch.session = { ...s.session, playhead: position };
    set(patch);
    caretFollowsPlayer = caret === "follow";
    markDirty("session");
    return true;
  }

  /**
   * Holds off the player's paused frames until its seek or step `landing` is on screen (they
   * are of earlier requests and would move the playhead back), then, for "follow", takes the
   * frame it landed on. A seek the caret asked for keeps the caret's exact moment (the word's
   * start, which the frame on screen may begin a little before): that is where I / O mark.
   */
  function awaitLanding(p: PlayerLike, landing: Promise<void>, caret: "follow" | "keep"): void {
    const token = ++seekToken;
    seekPending = true;
    const done = () => {
      if (token !== seekToken) return; // a later seek owns the playhead now
      seekPending = false;
      if (caret === "follow" && p === player && !disposed) onPlayerEvent({ type: "frame", frame: p.frame });
    };
    void landing.then(done, done);
  }

  /** Sets the selection and moves the playhead to its focus (the caret). */
  function moveCaretTo(selection: TextSelection, extra: Partial<RoughcutState> = {}): void {
    const s = get();
    if (!s.layout) return;
    set({ selection, ...extra });
    placePlayhead(caretSequenceTime(s.layout, selection.focus), "keep");
  }

  /** The caret goes to the playhead (after a timeline edit, an undo, a step without a player). */
  function caretToPlayhead(): void {
    const s = get();
    if (!s.layout) return;
    const b = s.playhead.position ? caretForSource(s.layout, s.playhead.position) : null;
    if (b !== null) set({ selection: caretAt(s.layout, b) });
    else if (!isCollapsed(s.selection)) set({ selection: caretAt(s.layout, s.selection.focus) });
  }

  /** The playhead after an edit: the same source moment if still kept, else the same sequence time. */
  function keepPlayhead(ph: Playhead, state: EditState): Playhead {
    const total = sequenceDuration(state);
    let time = ph.position ? sequenceTimeOf(state, ph.position) : null;
    if (time === null) time = Math.max(0, Math.min(total, ph.time));
    return { ...ph, time, position: sourcePositionAt(state, time) };
  }

  // ---- edits ----

  /**
   * Runs one edit (spec 3.5.1) on the current document. Returns false when nothing changed.
   * `extra` adds fields set together with the new document (a caret, cleared marks).
   */
  function applyEdit(
    make: (doc: EditDocument, ctx: EditContext) => EditDocument,
    extra: Partial<RoughcutState> = {},
  ): boolean {
    const s = get();
    if (!s.edit || !s.project) return false;
    const doc = make(s.edit, editContext(s.project));
    if (doc === s.edit) return false;
    const playhead = keepPlayhead(s.playhead, doc.current);
    commit({ edit: doc, playhead, session: { ...s.session, playhead: playhead.position }, ...extra });
    markDirty("edit");
    return true;
  }

  /** After a timeline edit: the caret follows the playhead, and the player shows it. */
  function afterTimelineEdit(): void {
    caretToPlayhead();
    caretFollowsPlayer = true;
  }

  // ---- autosave ----

  let saveTimer: unknown = null;
  let saveTimerKind: "edit" | "session" | null = null;
  let dirty = false;
  let saving: Promise<void> | null = null;

  function markDirty(kind: "edit" | "session"): void {
    const s = get();
    if (!s.project || disposed) return;
    dirty = true;
    if (!s.save.pending) set({ save: { ...s.save, pending: true } });
    if (saveTimer !== null) {
      if (saveTimerKind === "edit" || kind === "session") return; // the earlier timer stands
      timers.clearTimeout(saveTimer);
    }
    saveTimerKind = kind;
    saveTimer = timers.setTimeout(
      () => {
        saveTimer = null;
        saveTimerKind = null;
        void track(runSave());
      },
      kind === "edit" ? autosaveMs : sessionSaveMs,
    );
  }

  async function runSave(): Promise<void> {
    while (saving) await saving;
    if (!dirty) return;
    const s = get();
    if (!s.project || !s.edit) {
      dirty = false;
      return;
    }
    dirty = false;
    const projectId = s.project.id;
    set({ save: { ...s.save, saving: true } });
    saving = (async () => {
      try {
        await core.saveEdit(projectId, s.edit!, s.session);
        const after = get();
        set({ save: { pending: dirty, saving: false, lastSavedAt: now().toISOString(), error: null } });
        if (after.notices.some((n) => n.id === "save")) dropNotice("save");
      } catch (e) {
        dirty = true;
        const error = toAppError(e);
        set({ save: { ...get().save, saving: false, pending: true, error } });
        pushNotice({ id: "save", kind: "error", text: `Could not save: ${error.message}`, retry: { label: "Retry", action: "ui.retrySave" } });
      }
    })();
    try {
      await saving;
    } finally {
      saving = null;
    }
  }

  async function flushSave(): Promise<void> {
    if (saveTimer !== null) {
      timers.clearTimeout(saveTimer);
      saveTimer = null;
      saveTimerKind = null;
    }
    await runSave();
  }

  /**
   * Saves the open project until nothing is left unsaved, right before another project replaces
   * it. Edits and player frames can arrive while a save (or an open / import) is in flight, so
   * this loops. `pause` stops the player first, so its frames stop moving the saved playhead
   * (used right before the old project is replaced). False when a save failed: the caller keeps
   * the open project, so nothing is lost.
   */
  async function settleBeforeSwitch(pause = false): Promise<boolean> {
    if (pause && player && get().playhead.playing) player.pause();
    for (let i = 0; i < 10 && (dirty || saveTimer !== null || saving); i++) {
      await flushSave();
      if (dirty && get().save.error) break; // the save failed: do not hammer the disk
    }
    return !dirty;
  }

  /** Tells the user the switch was refused because the open project could not be saved. */
  function switchRefused(): void {
    set({ busy: null });
    const why = get().save.error?.message;
    pushNotice({
      id: "save",
      kind: "error",
      text: `Could not save this project${why ? ` (${why})` : ""}, so it stays open. Nothing was lost.`,
      retry: { label: "Retry", action: "ui.retrySave" },
    });
  }

  // ---- loading projects ----

  async function refreshProjects(): Promise<void> {
    try {
      const projects = await core.listProjects();
      const s = get();
      set({ projects, homeSelection: Math.max(0, Math.min(s.homeSelection, projects.length - 1)) });
    } catch (e) {
      errorNotice("projects", "Could not list projects", e);
    }
  }

  /** Shows a project in the editor: from `open_project`, or from `create_project` (assets from events). */
  function hydrate(project: Project, assets: readonly SourceAssets[]): void {
    const s = get();
    const sources = { ...s.sources };
    for (const a of assets) sources[a.sourceId] = { ...(sources[a.sourceId] ?? emptyEntry()), assets: a };
    for (const r of project.sources) sources[r.id] ??= emptyEntry();
    const edit = project.edit;
    const session: SessionState = { ...DEFAULT_SESSION, ...project.session };
    const at = session.playhead ? sequenceTimeOf(edit.current, session.playhead) : null;
    const time = at ?? 0;
    const playhead: Playhead = { time, position: sourcePositionAt(edit.current, time), playing: false, speed: 0 };
    locateDismissed.clear();
    caretFollowsPlayer = false;
    lastKey = null;
    ctxCache = null;
    commit({
      screen: "editor",
      busy: null,
      project,
      edit,
      session: { ...session, playhead: playhead.position },
      sources,
      layout: null,
      selection: { anchor: 0, focus: 0 },
      playhead,
      marks: { in: null, out: null },
      find: { open: false, query: "", matches: [], index: -1, focusRequest: s.find.focusRequest },
      currentSuggestion: null,
      zoom: 1,
      dialogs: { export: null, shortcuts: false, locate: null },
      save: { pending: false, saving: false, lastSavedAt: null, error: null },
      playerError: null,
      buffering: false,
    });
    if (player) {
      player.setRate(session.playbackRate);
      void player.seek(time).catch(() => undefined);
    }
    const unavailable = project.sources.find((r) => sources[r.id]?.assets?.suggestions === "unavailable");
    if (unavailable) claudeNotice(null);
    promptNextMissing();
    for (const r of project.sources) void track(fetchSourceData(r.id));
  }

  /** Fetches a source's transcript and suggestions as far as they have got. */
  async function fetchSourceData(id: SourceId): Promise<void> {
    const assets = get().sources[id]?.assets;
    const wantTranscript = !assets || assets.transcript !== "none";
    const wantSuggestions = !assets || assets.suggestions !== "none";
    const tasks: Promise<void>[] = [];
    if (wantTranscript) tasks.push(fetchTranscript(id));
    if (wantSuggestions) {
      tasks.push(
        core.getSuggestions(id).then(
          (set) => {
            const entry = get().sources[id];
            if (!entry?.suggestions || (set.claudeModel && !entry.suggestions.claudeModel)) patchSource(id, { suggestions: set });
          },
          () => undefined,
        ),
      );
    }
    await Promise.all(tasks);
  }

  async function fetchTranscript(id: SourceId): Promise<void> {
    try {
      const t = await core.getTranscript(id);
      const entry = get().sources[id] ?? emptyEntry();
      // Asked while a transcription ran, answered after it failed: that text was dropped.
      if (entry.assets?.transcript === "none" && !t.complete) return;
      const merged = mergeTranscript(entry.transcript, t);
      if (merged !== entry.transcript) patchSource(id, { transcript: merged });
    } catch {
      // Not there yet: the events will bring it.
    }
  }

  /**
   * One open or import at a time: a second drop, Enter, Ctrl+N or double-click while one runs
   * is ignored (spec 1.6 UC1, UC8). `busy` is set at once, before the old project is saved, so
   * every path in (keys, window drops, Home rows) sees it.
   */
  function claimBusy(label: string): boolean {
    if (get().busy !== null) return false;
    set({ busy: label });
    return true;
  }

  async function openProject(projectId: string): Promise<void> {
    if (!claimBusy("Opening project")) return;
    if (!(await settleBeforeSwitch())) return switchRefused();
    const jobsBefore = jobStates();
    try {
      const opened: OpenedProject = await core.openProject(projectId);
      // Edits made while the project was opening belong to the old one: save them first.
      if (!(await settleBeforeSwitch(true))) return switchRefused();
      hydrate(opened.project, opened.assets);
      // Spec 1.12: the notice is shown whenever such a project is on screen, reopened too.
      mixedFormatNotice(opened.project.sources);
      noticeEarlyFailures(jobsBefore);
    } catch (e) {
      set({ busy: null });
      errorNotice("open", "Could not open the project", e);
    }
  }

  async function createFromPaths(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    if (!claimBusy("Importing footage")) return;
    if (!(await settleBeforeSwitch())) return switchRefused();
    const jobsBefore = jobStates();
    try {
      const project = await core.createProject(paths);
      // Edits made during the import belong to the old project: save them first.
      if (!(await settleBeforeSwitch(true))) {
        void refreshProjects();
        return switchRefused();
      }
      const s = get();
      const assets = project.sources.map((r) => s.sources[r.id]?.assets).filter((a): a is SourceAssets => !!a);
      hydrate(project, assets);
      mixedFormatNotice(project.sources);
      noticeEarlyFailures(jobsBefore);
      void refreshProjects();
    } catch (e) {
      set({ busy: null });
      errorNotice("import", "Could not import the footage", e);
    }
  }

  async function addFootage(paths: string[]): Promise<void> {
    const s = get();
    if (!s.project || paths.length === 0) return;
    const projectId = s.project.id;
    try {
      const refs = await core.addSources(projectId, paths);
      const now2 = get();
      if (!now2.project || now2.project.id !== projectId || !now2.edit) return;
      const known = new Set(now2.project.sources.map((r) => r.id));
      const added = refs.filter((r) => !known.has(r.id));
      if (added.length === 0) {
        pushNotice({ id: "import", kind: "info", text: "That footage is already in this project." });
        return;
      }
      const project: Project = { ...now2.project, sources: [...now2.project.sources, ...added] };
      const sources = { ...now2.sources };
      for (const r of added) sources[r.id] ??= emptyEntry();
      commit({ project, sources });
      // One undo step for the whole drop: appendSource for each new source (spec 3.5.1).
      applyEdit((doc, ctx) => {
        let d = doc;
        for (const r of added) d = appendSource(d, ctx, r.id, r.media.duration);
        return d === doc ? doc : { current: d.current, undo: [...doc.undo, doc.current], redo: [] };
      });
      mixedFormatNotice(project.sources);
      for (const r of added) void track(fetchSourceData(r.id));
    } catch (e) {
      errorNotice("import", "Could not add the footage", e);
    }
  }

  function mixedFormatNotice(refs: readonly SourceRef[]): void {
    const first = refs[0];
    if (first && refs.some((r) => !sameFormat(first, r))) {
      pushNotice({
        id: "mixed",
        kind: "info",
        text: "These recordings differ in format. The export follows the first clip.",
      });
    }
  }

  async function pickFootage(title: string): Promise<string[] | null> {
    try {
      return await core.pickFiles({
        title,
        multiple: true,
        filters: [{ name: "Video", extensions: ["mp4", "mov", "mkv", "m4v", "avi", "webm", "mts", "m2ts"] }],
      });
    } catch (e) {
      errorNotice("picker", "Could not open the file picker", e);
      return null;
    }
  }

  async function goHome(): Promise<void> {
    if (!(await settleBeforeSwitch(true))) return switchRefused();
    if (player) player.pause();
    lastKey = null;
    set({
      screen: "home",
      // The list is most recent first: the project just left is selected.
      homeSelection: 0,
      project: null,
      edit: null,
      layout: null,
      session: DEFAULT_SESSION,
      selection: { anchor: 0, focus: 0 },
      playhead: STOPPED,
      marks: { in: null, out: null },
      find: { ...get().find, open: false, query: "", matches: [], index: -1 },
      currentSuggestion: null,
      dialogs: { export: null, shortcuts: false, locate: null },
    });
    syncPlayer();
    await refreshProjects();
  }

  // ---- Locate file (spec 1.12) ----

  function promptNextMissing(): void {
    const s = get();
    if (!s.project || s.dialogs.locate) return;
    const missing = s.project.sources.find(
      (r) => s.sources[r.id]?.assets?.online === false && !locateDismissed.has(r.id),
    );
    if (!missing) return;
    set({
      dialogs: {
        ...s.dialogs,
        locate: { sourceId: missing.id, path: missing.path, name: fileNameOf(missing.path), error: null, busy: false },
      },
    });
  }

  /** A locate (picker, then the core's check) is running: Enter or a click meanwhile does nothing. */
  let locating = false;

  async function locate(sourceId: SourceId | undefined): Promise<void> {
    if (locating) return;
    locating = true;
    try {
      await locateOnce(sourceId);
    } finally {
      locating = false;
    }
  }

  async function locateOnce(sourceId: SourceId | undefined): Promise<void> {
    const s = get();
    if (!s.project) return;
    const id = sourceId ?? s.dialogs.locate?.sourceId;
    const ref = s.project.sources.find((r) => r.id === id);
    if (!ref) return;
    if (s.dialogs.locate?.sourceId !== ref.id) {
      set({ dialogs: { ...s.dialogs, locate: { sourceId: ref.id, path: ref.path, name: fileNameOf(ref.path), error: null, busy: false } } });
    }
    let picked: string[] | null;
    try {
      picked = await core.pickFiles({ title: `Locate ${fileNameOf(ref.path)}`, multiple: false, defaultPath: ref.path });
    } catch (e) {
      errorNotice("picker", "Could not open the file picker", e);
      return;
    }
    const path = picked?.[0];
    if (!path) return;
    const withBusy = get().dialogs.locate;
    if (withBusy) set({ dialogs: { ...get().dialogs, locate: { ...withBusy, busy: true, error: null } } });
    try {
      const assets = await core.locateSource(s.project.id, ref.id, path);
      const now2 = get();
      if (now2.project?.id === s.project.id) {
        const project: Project = {
          ...now2.project,
          sources: now2.project.sources.map((r) => (r.id === ref.id ? { ...r, path } : r)),
        };
        const sources = { ...now2.sources, [ref.id]: { ...(now2.sources[ref.id] ?? emptyEntry()), assets } };
        commit({ project, sources, dialogs: { ...now2.dialogs, locate: null } });
        promptNextMissing();
      }
    } catch (e) {
      const error = toAppError(e);
      const prompt = get().dialogs.locate;
      if (prompt) set({ dialogs: { ...get().dialogs, locate: { ...prompt, busy: false, error } } });
      else errorNotice("locate", "Could not use that file", error);
    }
  }

  // ---- Claude (spec 1.9) ----

  function claudeNotice(error: AppError | null): void {
    const text = error
      ? `No suggestions from Claude: ${error.message}`
      : "No suggestions from Claude right now. Everything else works.";
    pushNotice({ id: CLAUDE_NOTICE, kind: "warning", text, retry: { label: "Retry", action: "ui.retryClaude" } });
  }

  async function retryClaude(sourceId?: SourceId): Promise<void> {
    const s = get();
    if (!s.project) return;
    const ids = sourceId
      ? [sourceId]
      : s.project.sources
          .filter((r) => {
            const e = s.sources[r.id];
            return !!e?.suggestionsError || e?.assets?.suggestions === "unavailable";
          })
          .map((r) => r.id);
    dropNotice(CLAUDE_NOTICE);
    try {
      set({ claude: await core.claudeStatus() });
    } catch {
      // The retry below reports what is wrong.
    }
    for (const id of ids) {
      patchSource(id, { suggestionsError: null });
      try {
        await core.retrySuggestions(id);
      } catch (e) {
        const error = toAppError(e);
        patchSource(id, { suggestionsError: error });
        claudeNotice(error);
      }
    }
  }

  // ---- export (spec 1.7 E, 3.6 "Exporting") ----

  /** One press of Enter in the Export dialog, until start_export answers. */
  interface ExportStart {
    cancelled: boolean;
  }
  /** The start waiting for start_export's answer, if any. */
  let exportStart: ExportStart | null = null;
  /** Export jobs cancelled because nobody waits for them: their events are ignored. */
  const abandonedExports = new Set<string>();
  /** An export_finished that arrived before start_export answered. */
  let unclaimedResult: ExportResult | null = null;

  function setExport(patch: Partial<ExportDialogState> | null): void {
    const s = get();
    if (patch === null) {
      set({ dialogs: { ...s.dialogs, export: null } });
      return;
    }
    if (!s.dialogs.export) return;
    set({ dialogs: { ...s.dialogs, export: { ...s.dialogs.export, ...patch } } });
  }

  function exportRequest(s: RoughcutState, d: ExportDialogState) {
    return { projectId: s.project!.id, clips: s.edit!.current.clips, folder: d.folder, fileName: d.fileName };
  }

  async function planExport(): Promise<void> {
    const s = get();
    const d = s.dialogs.export;
    if (!d || !s.project || !s.edit) return;
    const seq = ++planSeq;
    setExport({ planning: true, error: null });
    try {
      const plan = await core.planExport(exportRequest(s, d));
      if (seq === planSeq && get().dialogs.export?.phase === "confirm") setExport({ plan, planning: false });
    } catch (e) {
      if (seq === planSeq) setExport({ planning: false, plan: null, error: toAppError(e) });
    }
  }

  async function openExport(): Promise<void> {
    const s = get();
    if (!s.project || !s.edit || s.screen !== "editor") return;
    if (s.dialogs.export) return;
    const folder = s.settings?.exportFolder ?? "";
    const dialog: ExportDialogState = {
      phase: "confirm",
      folder,
      fileName: defaultExportFileName(s.project.name, now()),
      plan: null,
      planning: true,
      error: null,
      jobId: null,
      progress: 0,
      secondsLeft: null,
      result: null,
      copied: false,
    };
    if (player) player.pause();
    set({ dialogs: { ...s.dialogs, export: dialog, shortcuts: false } });
    await planExport();
  }

  async function startExport(): Promise<void> {
    const s = get();
    const d = s.dialogs.export;
    if (!d || d.phase !== "confirm" || d.planning || !d.plan || d.plan.blockedBy || !s.project || !s.edit) return;
    const request = exportRequest(s, d);
    const start: ExportStart = { cancelled: false };
    exportStart = start;
    setExport({ phase: "running", progress: 0, secondsLeft: d.plan.estimatedSeconds, jobId: null, error: null });
    let jobId: string;
    try {
      jobId = await core.startExport(request);
    } catch (e) {
      if (exportStart === start) exportStart = null;
      if (!start.cancelled && get().dialogs.export?.phase === "running") setExport({ phase: "confirm", error: toAppError(e) });
      return;
    }
    if (exportStart === start) exportStart = null;
    const now2 = get().dialogs.export;
    // Cancelled (or the dialog closed) before the core answered: stop the job it just queued.
    if (start.cancelled || !now2 || now2.phase !== "running" || (now2.jobId !== null && now2.jobId !== jobId)) {
      await abandonExport(jobId);
      return;
    }
    setExport({ jobId });
    const known = get().jobs[jobId];
    if (known) foldExportJob(known);
    const early = unclaimedResult;
    unclaimedResult = null;
    if (early && get().dialogs.export?.phase === "running") finishExport(early);
  }

  /** Cancels an export job nobody is waiting for any more; its events are ignored from now on. */
  async function abandonExport(jobId: string): Promise<void> {
    abandonedExports.add(jobId);
    try {
      await core.cancelJob(jobId);
    } catch (e) {
      const job = get().jobs[jobId];
      if (!job || (job.state !== "done" && job.state !== "cancelled" && job.state !== "failed")) {
        errorNotice("export", "Could not cancel the export", e);
      }
    }
  }

  function finishExport(result: ExportResult): void {
    setExport({ phase: "done", result, progress: 1, secondsLeft: 0 });
  }

  function foldExportJob(job: JobStatus): void {
    if (abandonedExports.has(job.id)) return;
    const s = get();
    const d = s.dialogs.export;
    if (!d || d.phase !== "running") return;
    // Before start_export answers, the dialog takes the project's export job as its own.
    const mine =
      d.jobId === job.id ||
      (d.jobId === null && !!exportStart && !exportStart.cancelled && job.kind === "export" && job.projectId === s.project?.id);
    if (!mine) return;
    switch (job.state) {
      case "queued":
      case "running":
        setExport({ jobId: job.id, progress: job.progress, secondsLeft: job.secondsLeft ?? null });
        return;
      case "done":
        setExport({ jobId: job.id, progress: 1, secondsLeft: 0 });
        return;
      case "failed":
        setExport({ phase: "confirm", jobId: null, error: job.error ?? { code: "export_failed", message: "The export failed." } });
        return;
      case "cancelled":
        setExport(null);
        pushNotice({ id: "export", kind: "info", text: "Export cancelled. The project is untouched." });
        return;
    }
  }

  async function cancelExport(): Promise<void> {
    const d = get().dialogs.export;
    if (!d) return;
    if (d.phase !== "running") {
      setExport(null);
      return;
    }
    if (d.jobId) {
      try {
        await core.cancelJob(d.jobId);
      } catch (e) {
        errorNotice("export", "Could not cancel the export", e);
        return;
      }
    } else if (exportStart) {
      // start_export has not answered yet: its job is cancelled the moment the id arrives.
      exportStart.cancelled = true;
    }
    if (get().dialogs.export) {
      setExport(null);
      pushNotice({ id: "export", kind: "info", text: "Export cancelled. The project is untouched." });
    }
  }

  async function changeExportFolder(): Promise<void> {
    const d = get().dialogs.export;
    if (!d || d.phase !== "confirm") return;
    let folder: string | null;
    try {
      folder = await core.pickFolder({ title: "Save exports to", defaultPath: d.folder || undefined });
    } catch (e) {
      errorNotice("picker", "Could not open the folder picker", e);
      return;
    }
    if (!folder || !get().dialogs.export) return;
    setExport({ folder });
    try {
      set({ settings: await core.updateSettings({ exportFolder: folder }) });
    } catch (e) {
      errorNotice("settings", "Could not remember the folder", e);
    }
    await planExport();
  }

  // ---- event folding (spec 3.5.5) ----

  const unsubscribers: (() => void)[] = [];

  unsubscribers.push(
    core.onJobUpdated((job) => {
      const s = get();
      const jobs = { ...s.jobs, [job.id]: job };
      // A transcription starting or stopping changes how text still to come is shown (the
      // layout), so that update goes through `commit`.
      if (job.kind === "transcribe") commit({ jobs });
      else set({ jobs });
      if (job.kind === "export") {
        foldExportJob(job);
        return;
      }
      jobFailureNotice(s, job);
    }),
  );

  /**
   * The notice for a failed job of a source in the open project. A job can fail before the
   * project is in the store (the transcriber missing fails within milliseconds of the import),
   * so `hydrate` callers run `noticeEarlyFailures` once the project is there.
   */
  function jobFailureNotice(s: RoughcutState, job: JobStatus): void {
    if (job.state !== "failed" || !job.error || !inProject(s, job.sourceId)) return;
    // The audio job ends "cancelled" when the transcriber stopped taking audio: its
    // transcription job's own failure says why.
    if (job.kind === "audio" && job.error.code === "cancelled") return;
    const ref = s.project!.sources.find((r) => r.id === job.sourceId)!;
    const what =
      job.kind === "transcribe" || job.kind === "audio"
        ? "Transcription failed"
        : job.kind === "proxy"
          ? "The preview copy could not be made"
          : job.kind === "suggest"
            ? null
            : `The ${job.kind} step failed`;
    if (what) pushNotice({ id: `job-${job.kind}-${ref.id}`, kind: "error", text: `${what} for ${fileNameOf(ref.path)}: ${job.error.message}` });
  }

  /**
   * Notices for jobs of the open project's sources that failed while it was being created or
   * opened, before it was in the store. `before` holds each job's state when that began, so an
   * old failure (from an earlier import in this session) is not announced again.
   */
  function noticeEarlyFailures(before: ReadonlyMap<string, string>): void {
    const s = get();
    for (const job of Object.values(s.jobs)) if (before.get(job.id) !== job.state) jobFailureNotice(s, job);
  }
  const jobStates = (): Map<string, string> => new Map(Object.values(get().jobs).map((j) => [j.id, j.state]));

  unsubscribers.push(
    core.onSourceAssetsChanged((assets) => {
      const before = get().sources[assets.sourceId];
      // A transcription that ended without a transcript (the transcriber crashed, was missing
      // or was cancelled): the core has dropped its partial text, so the words shown so far go
      // too, and the view shows the source as untranscribed instead of half-made.
      const dropPartial = assets.transcript === "none" && before?.transcript != null && !before.transcript.complete;
      patchSource(assets.sourceId, dropPartial ? { assets, transcript: null } : { assets });
      const s = get();
      if (!inProject(s, assets.sourceId)) return;
      if (!assets.online) promptNextMissing();
      else if (s.dialogs.locate?.sourceId === assets.sourceId) {
        set({ dialogs: { ...s.dialogs, locate: null } });
        promptNextMissing();
      }
      if (assets.transcript !== "none" && !before?.transcript) void track(fetchTranscript(assets.sourceId));
      if (assets.suggestions === "ready" && !before?.suggestions) void track(fetchSourceData(assets.sourceId));
      if (assets.suggestions === "unavailable" && !s.sources[assets.sourceId]?.suggestionsError && !s.notices.some((n) => n.id === CLAUDE_NOTICE)) {
        claudeNotice(null);
      }
      if (s.playerError?.sourceId === assets.sourceId) {
        // The source can play now (the original at once, spec 1.6 UC1; the proxy later): the
        // "cannot play yet" error and its notice are no longer true.
        if (assets.playbackUrl && (s.playerError.code === "no_address" || assets.playback === "proxy")) {
          set({ playerError: null });
          dropNotice("player");
        } else if (!assets.playbackUrl && assets.online && s.playerError.code === "no_address" && !before?.assets) {
          // The error came before the assets were known (no notice then); now it is confirmed.
          pushNotice({ id: "player", kind: "warning", text: "This part cannot play yet: its preview copy is still being made." });
        }
      }
    }),
  );

  unsubscribers.push(
    core.onTranscriptAppended(({ sourceId, utterances }) => {
      const entry = get().sources[sourceId] ?? emptyEntry();
      const base: Transcript = entry.transcript ?? { schemaVersion: 1, sourceId, model: "", complete: false, utterances: [] };
      const merged = mergeUtterances(base.utterances, utterances);
      if (!merged) return;
      patchSource(sourceId, { transcript: { ...base, utterances: merged } });
    }),
  );

  unsubscribers.push(
    core.onTranscriptCompleted(({ sourceId }) => {
      const entry = get().sources[sourceId] ?? emptyEntry();
      if (entry.transcript) {
        if (!entry.transcript.complete) patchSource(sourceId, { transcript: { ...entry.transcript, complete: true } });
      }
      void track(fetchTranscript(sourceId));
    }),
  );

  unsubscribers.push(
    core.onSuggestionsReady((suggestions) => {
      const patch: Partial<SourceEntry> = { suggestions };
      if (suggestions.claudeModel) patch.suggestionsError = null;
      patchSource(suggestions.sourceId, patch);
      const s = get();
      if (suggestions.claudeModel && s.project && !s.project.sources.some((r) => s.sources[r.id]?.suggestionsError)) {
        dropNotice(CLAUDE_NOTICE);
      }
    }),
  );

  unsubscribers.push(
    core.onSuggestionsUnavailable(({ sourceId, error }) => {
      patchSource(sourceId, { suggestionsError: error });
      if (inProject(get(), sourceId)) claudeNotice(error);
    }),
  );

  unsubscribers.push(
    core.onExportFinished((result) => {
      const s = get();
      const d = s.dialogs.export;
      // The file exists whatever the dialog shows: the project remembers it.
      if (s.project) set({ project: { ...s.project, lastExport: result } });
      if (!d || d.phase !== "running") return;
      if (d.jobId !== null) {
        if (!abandonedExports.has(d.jobId)) finishExport(result);
      } else if (exportStart && !exportStart.cancelled) {
        // Finished before start_export answered: shown once the job id is known.
        unclaimedResult = result;
      }
    }),
  );

  // ---- transcript actions ----

  function motion(m: CaretMotion, extend: boolean): void {
    const s = get();
    if (!s.layout) return;
    const options = visualLines ? { extend, lines: visualLines } : { extend };
    const sel = moveCaret(s.layout, s.selection, m, options);
    caretFollowsPlayer = false;
    moveCaretTo(sel, extend ? {} : { currentSuggestion: null });
  }

  /** The ranges a cut or a restore acts on: the selection, else the I/O marks, else the token at the caret. */
  function targetRanges(s: RoughcutState): { ranges: SourceRange[]; caret: number | null; usedMarks: boolean } {
    const layout = s.layout!;
    if (!isCollapsed(s.selection)) {
      return { ranges: selectionToRanges(layout, s.selection), caret: selectedSpan(s.selection).to, usedMarks: false };
    }
    if (s.marks.in !== null && s.marks.out !== null) {
      return { ranges: markToRanges(layout, s.marks.in, s.marks.out), caret: null, usedMarks: true };
    }
    const b = s.selection.focus;
    if (b < layout.tokens.length) return { ranges: tokensToRanges(layout, b, b + 1), caret: b + 1, usedMarks: false };
    return { ranges: [], caret: null, usedMarks: false };
  }

  function cutOrRestore(kind: "cut" | "restore"): void {
    const s = get();
    if (!s.layout) return;
    const { ranges, caret, usedMarks } = targetRanges(s);
    if (ranges.length === 0) return;
    const extra: Partial<RoughcutState> = { currentSuggestion: null };
    if (caret !== null) extra.selection = caretAt(s.layout, caret);
    if (usedMarks) extra.marks = { in: null, out: null };
    const changed = applyEdit((d, c) => (kind === "cut" ? cutRanges(d, c, ranges) : restoreRanges(d, c, ranges)), extra);
    if (!changed) {
      if (usedMarks) set({ marks: { in: null, out: null } });
      return;
    }
    if (caret !== null) moveCaretTo(get().selection);
    else caretToPlayhead();
  }

  function mark(which: "in" | "out"): void {
    const s = get();
    if (!s.edit) return;
    const m = s.playhead.position ?? s.playhead.time;
    set({ marks: { ...s.marks, [which]: m } });
  }

  /** The suggestion A / D act on: the current one if still pending, else the pending one at the caret. */
  function actionableSuggestion(s: RoughcutState, id?: string): SuggestionView | null {
    if (!s.layout) return null;
    const want = id ?? s.currentSuggestion;
    if (want) {
      const v = s.layout.suggestions.find((x) => x.suggestion.id === want);
      if (v && v.state === "pending") return v;
      if (id) return null;
    }
    const at = suggestionAt(s.layout, Math.min(s.selection.anchor, s.selection.focus));
    return at && at.state === "pending" ? at : null;
  }

  function goToSuggestion(view: SuggestionView): void {
    if (view.firstPosition < 0) return;
    caretFollowsPlayer = false;
    moveCaretTo({ anchor: view.lastPosition + 1, focus: view.firstPosition }, { currentSuggestion: view.suggestion.id });
  }

  function stepSuggestion(dir: 1 | -1): void {
    const s = get();
    if (!s.layout) return;
    const from = Math.min(s.selection.anchor, s.selection.focus);
    const opts = { current: s.currentSuggestion };
    const view =
      dir === 1 ? nextPendingSuggestion(s.layout, from, opts) : previousPendingSuggestion(s.layout, from, opts);
    if (view) goToSuggestion(view);
  }

  function resolveSuggestion(kind: "accept" | "dismiss", id?: string): void {
    const s = get();
    const view = actionableSuggestion(s, id);
    if (!view || !s.layout) return;
    const range = view.suggestion.range;
    const caret = view.lastPosition >= 0 ? view.lastPosition + 1 : s.selection.focus;
    const changed = applyEdit(
      (d, c) => (kind === "accept" ? cutRanges(d, c, [range]) : dismissSuggestion(d, c, range)),
      { selection: caretAt(s.layout, caret), currentSuggestion: null },
    );
    if (changed) moveCaretTo(get().selection);
  }

  function acceptAll(): void {
    const s = get();
    if (!s.layout) return;
    const ranges = s.layout.suggestions.filter((v) => v.state === "pending").map((v) => ({ ...v.suggestion.range }));
    if (ranges.length === 0) return;
    if (applyEdit((d, c) => cutRanges(d, c, ranges), { currentSuggestion: null })) caretToPlayhead();
  }

  // ---- find ----

  function jumpToMatch(m: FindMatch): void {
    let s = get();
    if (m.hidden && s.session.cutTextHidden) {
      commit({ session: { ...s.session, cutTextHidden: false } });
      markDirty("session");
      s = get();
    }
    if (!s.layout) return;
    const index = s.find.matches.findIndex((x) => sameAddress(x.first, m.first));
    const from = positionOf(s.layout, m.first);
    const last = positionOf(s.layout, m.last);
    const sel = from >= 0 && last >= 0 ? { anchor: last + 1, focus: from } : { anchor: m.to, focus: m.from };
    caretFollowsPlayer = false;
    moveCaretTo(sel, { find: { ...s.find, index } });
  }

  function findQuery(query: string): void {
    const s = get();
    if (!s.layout) {
      set({ find: { ...s.find, query, matches: [], index: -1 } });
      return;
    }
    const matches = findInTranscript(s.layout, query);
    set({ find: { ...s.find, open: true, query, matches, index: -1 } });
    const from = Math.min(s.selection.anchor, s.selection.focus);
    const first = nextMatch(matches, from - 1);
    if (first) jumpToMatch(first);
  }

  function findStep(dir: 1 | -1): void {
    const s = get();
    const { matches, index } = s.find;
    if (matches.length === 0) return;
    const current = matches[index];
    const boundary = current ? current.from : Math.min(s.selection.anchor, s.selection.focus);
    const m = dir === 1 ? nextMatch(matches, current ? boundary : boundary - 1) : previousMatch(matches, boundary);
    if (m) jumpToMatch(m);
  }

  // ---- timeline actions ----

  function nudge(edge: "end" | "start", frames: number): void {
    const s = get();
    if (!s.edit) return;
    const cut = nearestCutPoint(s.edit.current, s.playhead.time);
    if (!cut) return;
    const atCut = Math.abs(cut.at - s.playhead.time) <= AT_CUT_US;
    const clip = edge === "end" ? cut.before : cut.after;
    if (!applyEdit((d, c) => nudgeEdge(d, c, clip.id, edge, frames))) return;
    const moved = cutPoints(get().edit!.current).find((p) => p.index === cut.index && p.before.id === cut.before.id);
    if (atCut && moved) placePlayhead(moved.at, "follow");
    else afterTimelineEdit();
  }

  function trimToPlayhead(edge: "start" | "end"): void {
    const s = get();
    if (!s.edit) return;
    const placed = clipUnder(s.edit.current, s.playhead.time);
    if (!placed) return;
    const length = placed.clip.end - placed.clip.start;
    const to = placed.clip.start + Math.min(length, s.playhead.time - placed.sequenceStart);
    // The playhead keeps its source moment: after Q it sits at the clip's new start.
    if (applyEdit((d, c) => trimEdge(d, c, placed.clip.id, edge, to))) afterTimelineEdit();
  }

  function clipUnderPlayhead(): PlacedClip | null {
    const s = get();
    return s.edit ? clipUnder(s.edit.current, s.playhead.time) : null;
  }

  function step(amount: StepAmount): void {
    const s = get();
    if (!s.edit || !s.project) return;
    caretFollowsPlayer = true;
    const rate = s.project.frameRate;
    // Sequence times after a cut may sit a microsecond below the frame grid.
    const t =
      "frames" in amount
        ? frameToMicros(microsToFrameFloor(s.playhead.time + 2, rate) + amount.frames, rate)
        : s.playhead.time + amount.seconds * 1_000_000;
    if (!player) {
      placePlayhead(t, "follow");
      return;
    }
    // Where the step lands, at once (so Shift+→ then S splits there), until the player, which
    // steps from the latest position asked for, reports the exact frame it landed on.
    setPlayheadNow(t, "follow");
    awaitLanding(player, player.step(amount), "follow");
  }

  function jumpCut(dir: 1 | -1): void {
    const s = get();
    if (!s.edit) return;
    const t = s.playhead.time;
    const cuts = cutPoints(s.edit.current);
    if (dir === 1) {
      const next = cuts.find((p) => p.at > t + AT_CUT_US);
      placePlayhead(next ? next.at : duration(s), "follow");
    } else {
      let prev: number | null = null;
      for (const p of cuts) if (p.at < t - AT_CUT_US) prev = p.at;
      placePlayhead(prev ?? 0, "follow");
    }
  }

  function moveClipTo(clipId: string, index: number): void {
    applyEdit((doc, ctx) => {
      const from = doc.current.clips.findIndex((c) => c.id === clipId);
      if (from < 0) return doc;
      const target = Math.max(0, Math.min(doc.current.clips.length - 1, Math.round(index)));
      let d = doc;
      for (let i = from; i !== target; i += target > from ? 1 : -1) {
        d = moveClip(d, ctx, clipId, target > from ? "later" : "earlier");
      }
      return d === doc ? doc : { current: d.current, undo: [...doc.undo, doc.current], redo: [] };
    });
    afterTimelineEdit();
  }

  // ---- player controls ----

  function withPlayer(fn: (p: PlayerLike) => Promise<void> | void): void {
    if (!player || !get().project) return;
    caretFollowsPlayer = true;
    const r = fn(player);
    if (r) void r.catch(() => undefined);
  }

  function setRate(rate: PlaybackRate): void {
    const s = get();
    if (s.session.playbackRate !== rate) {
      set({ session: { ...s.session, playbackRate: rate } });
      markDirty("session");
    }
    player?.setRate(rate);
  }

  function setView(view: EditorView): void {
    const s = get();
    if (s.screen !== "editor" || s.session.view === view) return;
    set({ session: { ...s.session, view } });
    // The caret follows the playhead into the Timeline view; a selection whose caret end is
    // already at the playhead carries over (and is there again on Tab back).
    if (view === "timeline") {
      const b = s.layout && s.playhead.position ? caretForSource(s.layout, s.playhead.position) : null;
      if (b === null || b !== s.selection.focus) caretToPlayhead();
    }
    markDirty("session");
  }

  // ---- key bindings ----

  async function saveBindings(keymap: Keymap): Promise<void> {
    set({ keymap, rebindError: null });
    try {
      set({ settings: await core.updateSettings({ keyBindings: toOverrides(keymap) }) });
    } catch (e) {
      errorNotice("settings", "Could not save the shortcut", e);
    }
  }

  // ---- the action table ----

  type Handler = (payload: never) => void | Promise<void>;
  const shuttle = (k: ShuttleKey) => () => withPlayer((p) => p.shuttle(k));
  const inEditor = (fn: () => void | Promise<void>) => () => (get().screen === "editor" ? fn() : undefined);

  const handlers: Record<string, Handler> = {
    // Everywhere
    "everywhere.playPause": () => withPlayer((p) => p.toggle()),
    "everywhere.playBackward": shuttle("J"),
    "everywhere.pause": shuttle("K"),
    "everywhere.playForward": shuttle("L"),
    "everywhere.speed1x": () => setRate(1),
    "everywhere.speed1_5x": () => setRate(1.5),
    "everywhere.speed2x": () => setRate(2),
    "everywhere.switchView": () => setView(get().session.view === "transcript" ? "timeline" : "transcript"),
    "everywhere.undo": () => {
      if (applyEdit((d) => (canUndo(d) ? undo(d) : d), { currentSuggestion: null })) {
        caretToPlayhead();
        caretFollowsPlayer = true;
      }
    },
    "everywhere.redo": () => {
      if (applyEdit((d) => (canRedo(d) ? redo(d) : d), { currentSuggestion: null })) {
        caretToPlayhead();
        caretFollowsPlayer = true;
      }
    },
    "everywhere.newProject": async () => {
      if (get().busy !== null) return; // an open or import is running: no second picker
      const paths = await pickFootage("New project from footage");
      if (paths && paths.length > 0) await createFromPaths(paths);
    },
    "everywhere.addFootage": inEditor(async () => {
      const paths = await pickFootage("Add footage to this project");
      if (paths && paths.length > 0) await addFootage(paths);
    }),
    "everywhere.export": inEditor(openExport),
    "everywhere.find": inEditor(() => {
      const s = get();
      if (s.session.view !== "transcript") setView("transcript");
      set({ find: { ...get().find, open: true, focusRequest: s.find.focusRequest + 1 } });
    }),
    "everywhere.showShortcuts": () => {
      const s = get();
      set({ dialogs: { ...s.dialogs, shortcuts: !s.dialogs.shortcuts } });
    },
    "everywhere.escape": () => {
      const s = get();
      if (s.dialogs.shortcuts) return set({ dialogs: { ...s.dialogs, shortcuts: false } });
      if (s.dialogs.locate) {
        locateDismissed.add(s.dialogs.locate.sourceId);
        return set({ dialogs: { ...s.dialogs, locate: null } });
      }
      if (s.dialogs.export) return cancelExport();
      if (s.find.open) return set({ find: { ...s.find, open: false } });
      if (!s.layout) return;
      set({
        selection: caretAt(s.layout, s.selection.focus),
        marks: { in: null, out: null },
        currentSuggestion: null,
      });
    },

    // Transcript view
    "transcript.wordPrev": () => motion("tokenPrev", false),
    "transcript.wordNext": () => motion("tokenNext", false),
    "transcript.linePrev": () => motion("lineUp", false),
    "transcript.lineNext": () => motion("lineDown", false),
    "transcript.sentencePrev": () => motion("sentencePrev", false),
    "transcript.sentenceNext": () => motion("sentenceNext", false),
    "transcript.paragraphPrev": () => motion("paragraphPrev", false),
    "transcript.paragraphNext": () => motion("paragraphNext", false),
    "transcript.extendWordPrev": () => motion("tokenPrev", true),
    "transcript.extendWordNext": () => motion("tokenNext", true),
    "transcript.extendLinePrev": () => motion("lineUp", true),
    "transcript.extendLineNext": () => motion("lineDown", true),
    "transcript.extendSentencePrev": () => motion("sentencePrev", true),
    "transcript.extendSentenceNext": () => motion("sentenceNext", true),
    "transcript.extendParagraphPrev": () => motion("paragraphPrev", true),
    "transcript.extendParagraphNext": () => motion("paragraphNext", true),
    "transcript.cut": () => cutOrRestore("cut"),
    "transcript.restore": () => cutOrRestore("restore"),
    "transcript.markIn": () => mark("in"),
    "transcript.markOut": () => mark("out"),
    "transcript.playFromCaret": () => {
      const s = get();
      if (!s.layout || !player) return;
      const t = caretSequenceTime(s.layout, s.selection.focus);
      placePlayhead(t, "keep");
      withPlayer((p) => p.play());
    },
    "transcript.toggleCutText": () => {
      const s = get();
      if (!s.project) return;
      commit({ session: { ...s.session, cutTextHidden: !s.session.cutTextHidden } });
      markDirty("session");
    },
    "transcript.nextSuggestion": () => stepSuggestion(1),
    "transcript.prevSuggestion": () => stepSuggestion(-1),
    "transcript.acceptSuggestion": (p: { suggestionId?: string } | undefined) => resolveSuggestion("accept", p?.suggestionId),
    "transcript.dismissSuggestion": (p: { suggestionId?: string } | undefined) => resolveSuggestion("dismiss", p?.suggestionId),
    "transcript.acceptAllSuggestions": acceptAll,

    // Timeline view
    "timeline.stepFrameBack": () => step({ frames: -1 }),
    "timeline.stepFrameForward": () => step({ frames: 1 }),
    "timeline.stepSecondBack": () => step({ seconds: -1 }),
    "timeline.stepSecondForward": () => step({ seconds: 1 }),
    "timeline.prevCut": () => jumpCut(-1),
    "timeline.nextCut": () => jumpCut(1),
    "timeline.nudgeEndEarlier": () => nudge("end", -1),
    "timeline.nudgeEndLater": () => nudge("end", 1),
    "timeline.nudgeStartEarlier": () => nudge("start", -1),
    "timeline.nudgeStartLater": () => nudge("start", 1),
    "timeline.trimStart": () => trimToPlayhead("start"),
    "timeline.trimEnd": () => trimToPlayhead("end"),
    "timeline.split": () => {
      const t = get().playhead.time;
      if (applyEdit((d, c) => splitAt(d, c, t))) afterTimelineEdit();
    },
    "timeline.removeClip": () => {
      const placed = clipUnderPlayhead();
      if (placed && applyEdit((d, c) => removeClip(d, c, placed.clip.id))) {
        const s = get();
        // The next clip slides into place: the playhead stays at the same sequence time.
        placePlayhead(Math.min(placed.sequenceStart, duration(s)), "follow");
      }
    },
    "timeline.moveClipEarlier": () => {
      const placed = clipUnderPlayhead();
      if (placed && applyEdit((d, c) => moveClip(d, c, placed.clip.id, "earlier"))) afterTimelineEdit();
    },
    "timeline.moveClipLater": () => {
      const placed = clipUnderPlayhead();
      if (placed && applyEdit((d, c) => moveClip(d, c, placed.clip.id, "later"))) afterTimelineEdit();
    },
    "timeline.previewCut": () => {
      const s = get();
      if (!s.edit) return;
      const cut = nearestCutPoint(s.edit.current, s.playhead.time);
      if (cut) withPlayer((p) => p.previewCut(cut.at));
    },
    "timeline.zoomIn": () => set({ zoom: Math.min(ZOOM_MAX, get().zoom * 2) }),
    "timeline.zoomOut": () => set({ zoom: Math.max(1, get().zoom / 2) }),
    "timeline.zoomFit": () => set({ zoom: 1 }),

    // Home
    "home.selectPrev": () => {
      const s = get();
      if (s.screen === "home") set({ homeSelection: Math.max(0, s.homeSelection - 1) });
    },
    "home.selectNext": () => {
      const s = get();
      if (s.screen === "home") set({ homeSelection: Math.max(0, Math.min(s.projects.length - 1, s.homeSelection + 1)) });
    },
    "home.open": async () => {
      const s = get();
      const p = s.projects[s.homeSelection];
      if (s.screen === "home" && p) await openProject(p.id);
    },
    "home.remove": async () => {
      const s = get();
      const p = s.projects[s.homeSelection];
      if (s.screen !== "home" || !p) return;
      // An open or import is running: it may be this very project (its answer is on the way).
      if (s.busy !== null) return;
      try {
        await core.removeProject(p.id);
      } catch (e) {
        errorNotice("projects", "Could not remove the project", e);
      }
      await refreshProjects();
    },

    // Export dialog
    "export.confirm": startExport,
    "export.cancel": () => {
      const s = get();
      if (s.dialogs.shortcuts) return set({ dialogs: { ...s.dialogs, shortcuts: false } });
      return cancelExport();
    },
    "export.changeFolder": changeExportFolder,
    "export.showInFolder": async () => {
      const r = get().dialogs.export?.result;
      if (!r) return;
      try {
        await core.revealFile(r.path);
      } catch (e) {
        errorNotice("export", "Could not show the file", e);
      }
    },
    "export.copyPath": async () => {
      const r = get().dialogs.export?.result;
      if (!r) return;
      if (!clipboard) {
        pushNotice({ id: "export", kind: "warning", text: `Copy is not available here. The file is ${r.path}` });
        return;
      }
      try {
        await clipboard.writeText(r.path);
        setExport({ copied: true });
        pushNotice({ id: "export", kind: "info", text: "Path copied." });
      } catch (e) {
        errorNotice("export", "Could not copy the path", e);
      }
    },
    "export.close": () => {
      const s = get();
      if (s.dialogs.shortcuts) return set({ dialogs: { ...s.dialogs, shortcuts: false } });
      setExport(null);
    },

    // Mouse actions
    "ui.placeCaret": (p: UiActionPayloads["ui.placeCaret"]) => {
      const s = get();
      if (!s.layout) return;
      const b = caretAt(s.layout, p.boundary).focus;
      caretFollowsPlayer = false;
      moveCaretTo(p.extend ? { anchor: s.selection.anchor, focus: b } : { anchor: b, focus: b }, { currentSuggestion: null });
    },
    "ui.selectTokens": (p: UiActionPayloads["ui.selectTokens"]) => {
      const s = get();
      if (!s.layout) return;
      caretFollowsPlayer = false;
      moveCaretTo(selectTokens(s.layout, p.anchorToken, p.focusToken), { currentSuggestion: null });
    },
    "ui.seek": (p: UiActionPayloads["ui.seek"]) => placePlayhead(p.time, "follow"),
    "ui.trimEdgeTo": (p: UiActionPayloads["ui.trimEdgeTo"]) => {
      if (applyEdit((d, c) => trimEdge(d, c, p.clipId, p.edge, p.to))) afterTimelineEdit();
    },
    "ui.moveClipTo": (p: UiActionPayloads["ui.moveClipTo"]) => moveClipTo(p.clipId, p.index),
    "ui.dropFiles": async (p: UiActionPayloads["ui.dropFiles"]) => {
      if (p.paths.length === 0) return;
      if (get().screen === "editor" && get().project) await addFootage(p.paths);
      else await createFromPaths(p.paths);
    },
    "ui.selectProject": (p: UiActionPayloads["ui.selectProject"]) => {
      const s = get();
      set({ homeSelection: Math.max(0, Math.min(s.projects.length - 1, p.index)) });
    },
    "ui.openProject": (p: UiActionPayloads["ui.openProject"]) => openProject(p.projectId),
    "ui.removeProject": async (p: UiActionPayloads["ui.removeProject"]) => {
      if (get().busy !== null) return; // as home.remove: never under a running open or import
      try {
        await core.removeProject(p.projectId);
      } catch (e) {
        errorNotice("projects", "Could not remove the project", e);
      }
      await refreshProjects();
    },
    "ui.renameProject": async (p: UiActionPayloads["ui.renameProject"]) => {
      const s = get();
      const id = p.projectId ?? s.project?.id;
      const name = p.name.trim();
      if (!id || !name) return;
      try {
        await core.renameProject(id, name);
        const now2 = get();
        if (now2.project?.id === id) set({ project: { ...now2.project, name } });
        await refreshProjects();
      } catch (e) {
        errorNotice("projects", "Could not rename the project", e);
      }
    },
    "ui.goHome": goHome,
    "ui.setView": (p: UiActionPayloads["ui.setView"]) => setView(p.view),
    "ui.setRate": (p: UiActionPayloads["ui.setRate"]) => setRate(p.rate),
    "ui.findQuery": (p: UiActionPayloads["ui.findQuery"]) => findQuery(p.query),
    "ui.findNext": () => findStep(1),
    "ui.findPrevious": () => findStep(-1),
    "ui.findClose": () => set({ find: { ...get().find, open: false } }),
    "ui.selectSuggestion": (p: UiActionPayloads["ui.selectSuggestion"]) => {
      const v = get().layout?.suggestions.find((x) => x.suggestion.id === p.suggestionId);
      if (v) goToSuggestion(v);
    },
    "ui.retryClaude": (p: UiActionPayloads["ui.retryClaude"]) => retryClaude(p?.sourceId),
    "ui.retrySave": () => flushSave(),
    "ui.dismissNotice": (p: UiActionPayloads["ui.dismissNotice"]) => dropNotice(p.id),
    "ui.installUpdate": () => installUpdate(),
    "ui.locateSource": (p: UiActionPayloads["ui.locateSource"]) => locate(p?.sourceId),
    "ui.closeLocate": () => {
      const s = get();
      if (s.dialogs.locate) locateDismissed.add(s.dialogs.locate.sourceId);
      set({ dialogs: { ...s.dialogs, locate: null } });
    },
    "ui.exportFileName": async (p: UiActionPayloads["ui.exportFileName"]) => {
      const d = get().dialogs.export;
      if (!d || d.phase !== "confirm") return;
      setExport({ fileName: p.fileName });
      await planExport();
    },
    "ui.setZoom": (p: UiActionPayloads["ui.setZoom"]) => {
      if (Number.isFinite(p.zoom)) set({ zoom: Math.max(1, Math.min(ZOOM_MAX, p.zoom)) });
    },
    "ui.cancelJob": async (p: UiActionPayloads["ui.cancelJob"]) => {
      try {
        await core.cancelJob(p.jobId);
      } catch (e) {
        errorNotice("jobs", "Could not cancel", e);
      }
    },
    "ui.rebindKey": async (p: UiActionPayloads["ui.rebindKey"]) => {
      const r = rebind(get().keymap, p.actionId, p.chord);
      if (!r.ok) {
        const { ok: _ok, ...error } = r;
        set({ rebindError: error });
        return;
      }
      await saveBindings(r.keymap);
    },
    "ui.resetKey": async (p: UiActionPayloads["ui.resetKey"]) => {
      const r = resetAction(get().keymap, p.actionId);
      if (!r.ok) {
        const { ok: _ok, ...error } = r;
        set({ rebindError: error });
        return;
      }
      await saveBindings(r.keymap);
    },
    "ui.resetAllKeys": () => saveBindings(createKeymap()),
    "ui.closeShortcuts": () => set({ dialogs: { ...get().dialogs, shortcuts: false } }),
  };

  const dispatch = ((action: ActionId, payload?: unknown): Promise<void> => {
    if (disposed) return Promise.resolve();
    // The Export dialog is modal: behind it, only its own keys, `?` and Esc act.
    const now0 = get();
    if (now0.dialogs.export && !modalAllowed(action, now0.notices)) return Promise.resolve();
    const handler = handlers[action] as ((p: unknown) => void | Promise<void>) | undefined;
    if (!handler) {
      console.warn(`Roughcut: no handler for action ${action}`);
      return Promise.resolve();
    }
    let result: void | Promise<void>;
    try {
      result = handler(payload);
    } catch (e) {
      errorNotice("action", "", e);
      return Promise.resolve();
    }
    if (!result) return Promise.resolve();
    return track(
      result.catch((e: unknown) => {
        errorNotice("action", "", e);
      }),
    );
  }) as Dispatch;

  // ---- init and teardown ----

  let initialised: Promise<void> | null = null;
  function init(): Promise<void> {
    initialised ??= load();
    return initialised;
  }

  async function load(): Promise<void> {
    await track(
      Promise.all([
        refreshProjects(),
        core.getSettings().then(
          (settings) => {
            const keymap = createKeymap(settings.keyBindings);
            set({ settings, keymap });
            if (keymap.rejected.length > 0) {
              pushNotice({ id: "keys", kind: "warning", text: "Some saved shortcuts clash or are unknown and were ignored." });
            }
          },
          (e) => errorNotice("settings", "Could not read the settings", e),
        ),
        core.claudeStatus().then(
          (claude) => set({ claude }),
          () => undefined,
        ),
      ]),
    );
    set({ ready: true });
    // Not awaited: the app is usable at once; the notice appears when GitHub has answered.
    void track(checkForUpdate());
  }

  // ---- updates ----

  /** Asks whether a newer release exists (the real core only) and offers it in a notice. */
  async function checkForUpdate(): Promise<void> {
    if (!core.checkForUpdate) return;
    const found = await core.checkForUpdate().catch(() => null);
    if (!found || disposed) return;
    pushNotice({
      id: UPDATE_NOTICE,
      kind: "info",
      text: `Roughcut ${found.version} is available.`,
      retry: { label: "Update and restart", action: "ui.installUpdate" },
    });
  }

  /** Saves, then downloads and installs the update; the app restarts as the new version. */
  async function installUpdate(): Promise<void> {
    if (!core.installUpdate || updating) return;
    updating = true;
    pushNotice({ id: UPDATE_NOTICE, kind: "info", text: "Updating: downloading the new version, then Roughcut restarts." });
    try {
      if (!(await settleBeforeSwitch(true))) {
        switchRefused();
        dropNotice(UPDATE_NOTICE);
        return;
      }
      await core.installUpdate();
    } catch (e) {
      pushNotice({
        id: UPDATE_NOTICE,
        kind: "error",
        text: `Could not update: ${toAppError(e).message}`,
        retry: { label: "Retry", action: "ui.installUpdate" },
      });
    } finally {
      updating = false;
    }
  }

  async function idle(): Promise<void> {
    while (inflight.size > 0) await Promise.allSettled([...inflight]);
  }

  function dispose(): void {
    disposed = true;
    for (const u of unsubscribers) u();
    unsubscribers.length = 0;
    unsubscribePlayer?.();
    unsubscribePlayer = null;
    player = null;
    if (saveTimer !== null) timers.clearTimeout(saveTimer);
    saveTimer = null;
  }

  const store: RoughcutStore = {
    ...api,
    core,
    dispatch,
    actionIds: Object.keys(handlers),
    init,
    attachPlayer,
    setVisualLines: (lines) => {
      visualLines = lines;
    },
    flushSave: () => track(flushSave()),
    prepareToClose: () => track(settleBeforeSwitch(true)),
    idle,
    dispose,
  };
  if (options.player) attachPlayer(options.player);
  return store;
}

/** Ids of the key actions in the registry (spec 1.10), for checks that each has a handler. */
export const KEY_ACTION_IDS: readonly ActionId[] = KEY_ACTIONS.map((a) => a.id);
