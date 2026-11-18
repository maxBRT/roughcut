/**
 * `edit`: owns the clip list. Applies edit commands, keeps undo history, answers questions
 * about the sequence. Pure data in, data out (spec 3.3, 3.5.1). May use: nothing (only the
 * shared types and frame-grid helpers in `src/types`).
 */
export type { EditContext, EditSource } from "./context";
export { contextFromProject } from "./context";
export { canRedo, canUndo, createEditDocument, redo, sameState, undo } from "./history";
export type { Direction, Edge, EditCommand } from "./commands";
export {
  appendSource,
  applyEditCommand,
  cutRanges,
  dismissSuggestion,
  moveClip,
  nudgeEdge,
  removeClip,
  restoreRanges,
  splitAt,
  trimEdge,
} from "./commands";
export type { CutPoint, KeepState, PlacedClip, SuggestionState } from "./queries";
export {
  clipAt,
  cutPoints,
  findClip,
  isKept,
  keptRanges,
  nearestCutPoint,
  rangeKeepState,
  sequenceDuration,
  sequenceTimeOf,
  snapRange,
  sourcePositionAt,
  suggestionState,
} from "./queries";
export type { CutPlacement } from "./placement";
export { cutPlacement } from "./placement";
export type { Violation } from "./validate";
export { validateEditState } from "./validate";
/** The shared frame-grid helpers, re-exported for callers of `edit`. */
export { ceilToFrame, firstClipEnd, floorToFrame, frameToMicros, isOnFrameGrid, microsToFrameFloor, snapToFrame } from "../types";
