/**
 * The shape of the store (spec 3.3 `state`): what the screens read. Everything here is plain
 * data; the store replaces objects instead of mutating them, so a view can compare by identity.
 */
import type { ExportPhase, Keymap, RebindError } from "../keys";
import type { PlaybackRate, PlayerError, PlayerEvent, PlayerFrame, PlayerInput, ShuttleKey, StepAmount } from "../player";
import type { FindMatch, Mark, TextSelection, TranscriptLayout } from "../transcript";
import type {
  ActionId,
  AppError,
  ClaudeStatus,
  EditDocument,
  ExportPlan,
  ExportResult,
  JobId,
  JobStatus,
  Micros,
  Project,
  ProjectSummary,
  SequenceTime,
  SessionState,
  Settings,
  SourceAssets,
  SourceId,
  SourcePosition,
  SuggestionId,
  SuggestionSet,
  Transcript,
} from "../types";

/** Which screen is showing (spec 1.7). */
export type Screen = "home" | "editor";

/** The editor's two views. */
export type EditorView = SessionState["view"];

/**
 * What the store needs from a player: the public controls of `Player` (spec 3.5.3). The real
 * `Player` satisfies it; tests pass a stand-in (`FakePlayer` in ./testing).
 */
export interface PlayerLike {
  subscribe(listener: (e: PlayerEvent) => void): () => void;
  readonly frame: PlayerFrame;
  load(input: PlayerInput): void;
  play(): Promise<void>;
  pause(): void;
  toggle(): Promise<void>;
  seek(t: SequenceTime): Promise<void>;
  step(amount: StepAmount): Promise<void>;
  setRate(rate: PlaybackRate): void;
  shuttle(key: ShuttleKey): Promise<void>;
  previewCut(at: SequenceTime): Promise<void>;
}

/** Everything the store knows about one source, filled from `open_project` and the core's events. */
export interface SourceEntry {
  /** What is ready (null until the core has said). */
  assets: SourceAssets | null;
  /** The transcript as far as it has got (null before the first words). */
  transcript: Transcript | null;
  /** The latest suggestion set (null before any). */
  suggestions: SuggestionSet | null;
  /** Why Claude's suggestions are unavailable, from `suggestions_unavailable`; null otherwise. */
  suggestionsError: AppError | null;
}

/** The Export dialog (spec 1.7 E): its three stages are `phase`. */
export interface ExportDialogState {
  phase: ExportPhase;
  folder: string;
  fileName: string;
  /** The plan for the current folder and clips; null while it is being worked out. */
  plan: ExportPlan | null;
  planning: boolean;
  /** Why planning, starting or the export job failed; shown in the confirm stage. */
  error: AppError | null;
  /** The running export job, once `start_export` has answered. */
  jobId: JobId | null;
  /** 0 to 1 while running. */
  progress: number;
  secondsLeft: number | null;
  /** The finished file (done stage). */
  result: ExportResult | null;
  /** True once "Copy path" has copied the path. */
  copied: boolean;
}

/** The "Locate file" prompt for a source whose file was moved or deleted (spec 1.12). */
export interface LocatePromptState {
  sourceId: SourceId;
  /** The last known path. */
  path: string;
  /** The file name, for the prompt's text. */
  name: string;
  /** Why the last attempt failed (`source_mismatch`: a different file). */
  error: AppError | null;
  busy: boolean;
}

/** Find in transcript (`Ctrl+F`, spec 1.8 rule 10). */
export interface FindState {
  open: boolean;
  query: string;
  /** Every match in the current layout, in playing order. */
  matches: readonly FindMatch[];
  /** The match last jumped to, or -1. */
  index: number;
  /** Goes up each time `Ctrl+F` asks for the find box, so the view can focus it again. */
  focusRequest: number;
}

/** A one-line notice (spec 1.12). `retry` is an action the notice's button dispatches. */
export interface Notice {
  /** Stable id: a notice with the same id replaces the earlier one. */
  id: string;
  kind: "info" | "warning" | "error";
  text: string;
  retry?: { label: string; action: ActionId; payload?: unknown };
}

/** The playhead, which is also the caret (spec 1.8 rule 6). */
export interface Playhead {
  time: SequenceTime;
  /** The source moment at `time`; null for an empty sequence. */
  position: SourcePosition | null;
  playing: boolean;
  /** Positive forwards, negative for silent backwards play, 0 stopped. */
  speed: number;
}

/** The `I` / `O` marks: source positions (sequence times where the sequence was empty). */
export interface Marks {
  in: Mark | null;
  out: Mark | null;
}

/** Autosave status. */
export interface SaveStatus {
  /** Changes not yet written. */
  pending: boolean;
  /** A `save_edit` is in flight. */
  saving: boolean;
  lastSavedAt: string | null;
  error: AppError | null;
}

/** The dialogs and overlays on top of the screen. */
export interface Dialogs {
  export: ExportDialogState | null;
  shortcuts: boolean;
  locate: LocatePromptState | null;
}

/** The whole store. */
export interface RoughcutState {
  /** True once settings and the project list have loaded. */
  ready: boolean;
  screen: Screen;
  dialogs: Dialogs;
  /** Home screen rows, most recent first. */
  projects: readonly ProjectSummary[];
  /** The selected Home row (the most recent is preselected). */
  homeSelection: number;
  /** A short label while a project is being created or opened; null otherwise. */
  busy: string | null;
  /**
   * The open project as the core returned it, with `sources` and `lastExport` kept current.
   * Its `edit` and `session` fields are NOT kept current: read `edit` and `session`.
   */
  project: Project | null;
  /** The clip list with its undo history: the whole edit (null with no project). */
  edit: EditDocument | null;
  session: SessionState;
  /** Per source id: assets, transcript, suggestions. Holds every source the core has spoken of. */
  sources: Readonly<Record<SourceId, SourceEntry>>;
  /** Every job the core has reported, by id. */
  jobs: Readonly<Record<JobId, JobStatus>>;
  notices: readonly Notice[];
  /** The Transcript view's content for the current edit (null with no project). */
  layout: TranscriptLayout | null;
  /** Caret and selection, as boundaries in `layout`. */
  selection: TextSelection;
  playhead: Playhead;
  marks: Marks;
  find: FindState;
  /** The suggestion `N` / `Shift+N` last landed on. */
  currentSuggestion: SuggestionId | null;
  /** Timeline zoom: 1 = fit everything, doubled by each zoom in. */
  zoom: number;
  claude: ClaudeStatus | null;
  settings: Settings | null;
  /** The keymap in force: defaults plus `settings.keyBindings`. */
  keymap: Keymap;
  /** Why the last rebind was refused; null after a successful one. */
  rebindError: RebindError | null;
  save: SaveStatus;
  /** The player waits for media. */
  buffering: boolean;
  /** The player's last error, cleared when playback works again. */
  playerError: PlayerError | null;
}

/** Payloads of the actions the mouse needs that have no key (see `UI_ACTIONS`). */
export interface UiActionPayloads {
  /** Click in the transcript: caret at a boundary (`extend` with Shift held). */
  "ui.placeCaret": { boundary: number; extend?: boolean };
  /** Drag across words: selects whole tokens from one document position to another. */
  "ui.selectTokens": { anchorToken: number; focusToken: number };
  /** Click on the timeline or the overview strip: playhead (and caret) to a sequence time. */
  "ui.seek": { time: SequenceTime };
  /** Drag a clip edge: that edge to a source time (snapped, limits as `trimEdge`). */
  "ui.trimEdgeTo": { clipId: string; edge: "start" | "end"; to: Micros };
  /** Drag a clip: it goes to position `index` in the sequence (one undo step). */
  "ui.moveClipTo": { clipId: string; index: number };
  /** Files dropped on the window: a new project on Home, added footage in the editor. */
  "ui.dropFiles": { paths: string[] };
  /** Click a Home row. */
  "ui.selectProject": { index: number };
  /** Double-click a Home row. */
  "ui.openProject": { projectId: string };
  "ui.removeProject": { projectId: string };
  /** Rename the open project (or the given one). */
  "ui.renameProject": { projectId?: string; name: string };
  /** Back to the Home screen (saves first). */
  "ui.goHome": undefined;
  /** Click the view switch. */
  "ui.setView": { view: EditorView };
  /** Click a speed. */
  "ui.setRate": { rate: PlaybackRate };
  /** Typing in the find box: searches and jumps to the first match from the caret. */
  "ui.findQuery": { query: string };
  /** Enter in the find box. */
  "ui.findNext": undefined;
  /** Shift+Enter in the find box. */
  "ui.findPrevious": undefined;
  "ui.findClose": undefined;
  /** Click a suggestion block: makes it current and selects it. */
  "ui.selectSuggestion": { suggestionId: string };
  /** Retry Claude for every source whose suggestions are unavailable (or one source). */
  "ui.retryClaude": { sourceId?: string } | undefined;
  /** The save notice's Retry: writes unsaved changes now. */
  "ui.retrySave": undefined;
  "ui.dismissNotice": { id: string };
  /** The update notice's button: save, download the new version, install it and restart. */
  "ui.installUpdate": undefined;
  /** Pick the file for a missing source (the prompt's source by default). */
  "ui.locateSource": { sourceId?: string } | undefined;
  /** Close the Locate file prompt without locating. */
  "ui.closeLocate": undefined;
  /** Edit the export file name. */
  "ui.exportFileName": { fileName: string };
  /** Scroll to zoom: 1 = fit. */
  "ui.setZoom": { zoom: number };
  "ui.cancelJob": { jobId: string };
  /** Change one action's key; refused clashes land in `rebindError`. */
  "ui.rebindKey": { actionId: ActionId; chord: string };
  "ui.resetKey": { actionId: ActionId };
  "ui.resetAllKeys": undefined;
  "ui.closeShortcuts": undefined;
}

/** A mouse action id. */
export type UiActionId = keyof UiActionPayloads;

/** Optional payloads some key actions take when a button sends them. */
export interface KeyActionPayloads {
  /** The suggestion block's "A cut" button. */
  "transcript.acceptSuggestion": { suggestionId?: string } | undefined;
  /** The suggestion block's "D keep" button. */
  "transcript.dismissSuggestion": { suggestionId?: string } | undefined;
}

/** Runs an action; resolves when its work (including core calls) is done. Edits apply before it returns. */
export interface Dispatch {
  <A extends UiActionId>(action: A, ...payload: undefined extends UiActionPayloads[A] ? [UiActionPayloads[A]?] : [UiActionPayloads[A]]): Promise<void>;
  <A extends keyof KeyActionPayloads>(action: A, payload?: KeyActionPayloads[A]): Promise<void>;
  (action: ActionId, payload?: unknown): Promise<void>;
}
