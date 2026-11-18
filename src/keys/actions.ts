/**
 * The action registry: every action a key can trigger (spec 1.10 and the Home and Export keys
 * of spec 1.7), with its id, label, context and default chords.
 */
import type { ActionId, KeyContext } from "../types";

/** The three states of the Export dialog (spec 1.7 E). Export keys act only in their states. */
export type ExportPhase = "confirm" | "running" | "done";

/** One action a key can trigger. */
export interface KeyAction {
  /** Stable id, "context.name". Saved in Settings.keyBindings: never rename one. */
  readonly id: ActionId;
  /** Short description for the shortcut overlay. */
  readonly label: string;
  readonly context: KeyContext;
  /** Default chords (canonical, see chord.ts). Usually one; "Delete or Backspace" has two. */
  readonly defaults: readonly string[];
  /** Whether holding the key down repeats the action (stepping, moving, nudging). */
  readonly repeat: boolean;
  /** Export actions only: the dialog states in which the action is live. Absent = all. */
  readonly phases?: readonly ExportPhase[];
  /**
   * An "everywhere" action this one deliberately replaces in its own context, so they may share
   * a key: the Export dialog's Esc is its own cancel / close, not the general "close dialog".
   */
  readonly shadows?: ActionId;
}

/** Context order of the "?" overlay: the order of the tables in spec 1.10, then Home and Export. */
export const CONTEXT_ORDER: readonly KeyContext[] = ["everywhere", "transcript", "timeline", "home", "export"];

/** Group headings of the "?" overlay. */
export const CONTEXT_TITLES: Readonly<Record<KeyContext, string>> = {
  everywhere: "Everywhere",
  transcript: "Transcript view",
  timeline: "Timeline view",
  home: "Home",
  export: "Export",
};

function a(
  context: KeyContext,
  name: string,
  label: string,
  defaults: readonly string[],
  extra: { repeat?: boolean; phases?: readonly ExportPhase[]; shadows?: ActionId } = {},
): KeyAction {
  const action: KeyAction = {
    id: `${context}.${name}`,
    label,
    context,
    defaults,
    repeat: extra.repeat ?? false,
    ...(extra.phases !== undefined ? { phases: extra.phases } : {}),
    ...(extra.shadows !== undefined ? { shadows: extra.shadows } : {}),
  };
  return action;
}

const R = { repeat: true } as const;

/** Every action, in the order of the overlay (rows of spec 1.10, then Home, then Export). */
export const KEY_ACTIONS: readonly KeyAction[] = [
  // Everywhere
  a("everywhere", "playPause", "Play / pause", ["Space"]),
  a("everywhere", "playBackward", "Play backwards (silent)", ["J"]),
  a("everywhere", "pause", "Pause", ["K"]),
  a("everywhere", "playForward", "Play forwards; press again to go faster", ["L"]),
  a("everywhere", "speed1x", "Playback speed 1x", ["1"]),
  a("everywhere", "speed1_5x", "Playback speed 1.5x", ["2"]),
  a("everywhere", "speed2x", "Playback speed 2x", ["3"]),
  a("everywhere", "switchView", "Switch between Transcript and Timeline", ["Tab"]),
  a("everywhere", "undo", "Undo", ["Ctrl+Z"], R),
  a("everywhere", "redo", "Redo", ["Ctrl+Shift+Z"], R),
  a("everywhere", "newProject", "New project from footage", ["Ctrl+N"]),
  a("everywhere", "addFootage", "Add footage to this project", ["Ctrl+O"]),
  a("everywhere", "export", "Export", ["Ctrl+E"]),
  a("everywhere", "find", "Find in transcript", ["Ctrl+F"]),
  a("everywhere", "showShortcuts", "Show shortcuts", ["Shift+/"]),
  a("everywhere", "escape", "Close dialog, clear selection", ["Escape"]),

  // Transcript view
  a("transcript", "wordPrev", "Move to the previous word", ["ArrowLeft"], R),
  a("transcript", "wordNext", "Move to the next word", ["ArrowRight"], R),
  a("transcript", "linePrev", "Move up a line", ["ArrowUp"], R),
  a("transcript", "lineNext", "Move down a line", ["ArrowDown"], R),
  a("transcript", "sentencePrev", "Move to the previous sentence", ["Ctrl+ArrowLeft"], R),
  a("transcript", "sentenceNext", "Move to the next sentence", ["Ctrl+ArrowRight"], R),
  a("transcript", "paragraphPrev", "Move to the previous paragraph", ["Ctrl+ArrowUp"], R),
  a("transcript", "paragraphNext", "Move to the next paragraph", ["Ctrl+ArrowDown"], R),
  a("transcript", "extendWordPrev", "Extend the selection by a word back", ["Shift+ArrowLeft"], R),
  a("transcript", "extendWordNext", "Extend the selection by a word forward", ["Shift+ArrowRight"], R),
  a("transcript", "extendLinePrev", "Extend the selection a line up", ["Shift+ArrowUp"], R),
  a("transcript", "extendLineNext", "Extend the selection a line down", ["Shift+ArrowDown"], R),
  a("transcript", "extendSentencePrev", "Extend the selection by a sentence back", ["Ctrl+Shift+ArrowLeft"], R),
  a("transcript", "extendSentenceNext", "Extend the selection by a sentence forward", ["Ctrl+Shift+ArrowRight"], R),
  a("transcript", "extendParagraphPrev", "Extend the selection by a paragraph back", ["Ctrl+Shift+ArrowUp"], R),
  a("transcript", "extendParagraphNext", "Extend the selection by a paragraph forward", ["Ctrl+Shift+ArrowDown"], R),
  a("transcript", "cut", "Cut the selection (or the word at the caret)", ["Delete", "Backspace"]),
  a("transcript", "restore", "Restore the selection", ["R"]),
  a("transcript", "markIn", "Mark the start of a range at the playhead", ["I"]),
  a("transcript", "markOut", "Mark the end of a range at the playhead", ["O"]),
  a("transcript", "playFromCaret", "Play from the caret", ["Enter"]),
  a("transcript", "toggleCutText", "Hide / show cut text", ["H"]),
  a("transcript", "nextSuggestion", "Next suggestion", ["N"], R),
  a("transcript", "prevSuggestion", "Previous suggestion", ["Shift+N"], R),
  a("transcript", "acceptSuggestion", "Accept (cut) the current suggestion", ["A"]),
  a("transcript", "dismissSuggestion", "Dismiss (keep) the current suggestion", ["D"]),
  a("transcript", "acceptAllSuggestions", "Accept all remaining suggestions", ["Shift+A"]),

  // Timeline view
  a("timeline", "stepFrameBack", "Step one frame back", ["ArrowLeft"], R),
  a("timeline", "stepFrameForward", "Step one frame forward", ["ArrowRight"], R),
  a("timeline", "stepSecondBack", "Step one second back", ["Shift+ArrowLeft"], R),
  a("timeline", "stepSecondForward", "Step one second forward", ["Shift+ArrowRight"], R),
  a("timeline", "prevCut", "Jump to the previous cut", ["ArrowUp"], R),
  a("timeline", "nextCut", "Jump to the next cut", ["ArrowDown"], R),
  a("timeline", "nudgeEndEarlier", "Nudge the end of the clip before the cut one frame earlier", [","], R),
  a("timeline", "nudgeEndLater", "Nudge the end of the clip before the cut one frame later", ["."], R),
  a("timeline", "nudgeStartEarlier", "Nudge the start of the clip after the cut one frame earlier", ["Shift+,"], R),
  a("timeline", "nudgeStartLater", "Nudge the start of the clip after the cut one frame later", ["Shift+."], R),
  a("timeline", "trimStart", "Trim the clip's start to the playhead", ["Q"]),
  a("timeline", "trimEnd", "Trim the clip's end to the playhead", ["W"]),
  a("timeline", "split", "Split at the playhead", ["S"]),
  a("timeline", "removeClip", "Remove the clip under the playhead", ["Delete"]),
  a("timeline", "moveClipEarlier", "Move the clip earlier", ["Alt+ArrowLeft"], R),
  a("timeline", "moveClipLater", "Move the clip later", ["Alt+ArrowRight"], R),
  a("timeline", "previewCut", "Preview the nearest cut", ["/"]),
  a("timeline", "zoomIn", "Zoom in", ["Shift+="], R),
  a("timeline", "zoomOut", "Zoom out", ["-"], R),
  a("timeline", "zoomFit", "Zoom to fit everything", ["0"]),

  // Home (spec 1.7 A). New project is the "everywhere" Ctrl+N.
  a("home", "selectPrev", "Select the previous project", ["ArrowUp"], R),
  a("home", "selectNext", "Select the next project", ["ArrowDown"], R),
  a("home", "open", "Open the selected project", ["Enter"]),
  a("home", "remove", "Remove the selected project from the list", ["Delete"]),

  // Export dialog (spec 1.7 E)
  a("export", "confirm", "Export", ["Enter"], { phases: ["confirm"] }),
  a("export", "cancel", "Cancel", ["Escape"], { phases: ["confirm", "running"], shadows: "everywhere.escape" }),
  a("export", "changeFolder", "Change the folder", ["C"], { phases: ["confirm"] }),
  a("export", "showInFolder", "Show the file in its folder", ["Enter"], { phases: ["done"] }),
  a("export", "copyPath", "Copy the file's path", ["C"], { phases: ["done"] }),
  a("export", "close", "Close", ["Escape"], { phases: ["done"], shadows: "everywhere.escape" }),
];

const BY_ID: ReadonlyMap<ActionId, KeyAction> = new Map(KEY_ACTIONS.map((x) => [x.id, x]));

/** The action with this id, or undefined. */
export function getAction(id: ActionId): KeyAction | undefined {
  return BY_ID.get(id);
}

/** A hint shown in a screen's bottom bar: the first key of each action, then a label. */
export interface HintSpec {
  readonly actions: readonly ActionId[];
  readonly label: string;
}

/** The screens and dialog states that show a hint bar (spec 1.7, as drawn in the HTML mockup). */
export type HintScreen =
  | "home"
  | "transcribing"
  | "transcript"
  | "suggestion"
  | "timeline"
  | "exportConfirm"
  | "exportRunning"
  | "exportDone";

const ALL_SHORTCUTS: HintSpec = { actions: ["everywhere.showShortcuts"], label: "all shortcuts" };

/** The hints each screen shows, in mockup order; the last item is the trailing "? all shortcuts". */
export const SCREEN_HINTS: Readonly<Record<HintScreen, readonly HintSpec[]>> = {
  home: [
    { actions: ["home.open"], label: "open" },
    { actions: ["everywhere.newProject"], label: "new project" },
    ALL_SHORTCUTS,
  ],
  transcribing: [
    { actions: ["everywhere.playPause"], label: "play" },
    { actions: ["transcript.markIn", "transcript.markOut"], label: "mark range" },
    { actions: ["transcript.cut"], label: "cut" },
    ALL_SHORTCUTS,
  ],
  transcript: [
    { actions: ["everywhere.playPause"], label: "play" },
    { actions: ["transcript.cut"], label: "cut" },
    { actions: ["transcript.restore"], label: "restore" },
    { actions: ["transcript.nextSuggestion"], label: "next suggestion" },
    ALL_SHORTCUTS,
  ],
  suggestion: [
    { actions: ["transcript.acceptSuggestion"], label: "cut" },
    { actions: ["transcript.dismissSuggestion"], label: "keep" },
  ],
  timeline: [
    { actions: ["timeline.prevCut", "timeline.nextCut"], label: "jump to cut" },
    { actions: ["timeline.nudgeEndEarlier", "timeline.nudgeEndLater"], label: "nudge edge" },
    { actions: ["timeline.split"], label: "split" },
    { actions: ["timeline.removeClip"], label: "remove clip" },
    ALL_SHORTCUTS,
  ],
  exportConfirm: [
    { actions: ["export.confirm"], label: "export" },
    { actions: ["export.cancel"], label: "cancel" },
    ALL_SHORTCUTS,
  ],
  exportRunning: [{ actions: ["export.cancel"], label: "cancel" }, ALL_SHORTCUTS],
  exportDone: [
    { actions: ["export.showInFolder"], label: "show in folder" },
    { actions: ["export.copyPath"], label: "copy path" },
    { actions: ["export.close"], label: "close" },
    ALL_SHORTCUTS,
  ],
};
