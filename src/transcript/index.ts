/**
 * `transcript`: turns transcript tokens plus the clip list into what the Transcript view shows; turns a text selection or an I / O range into source ranges; search (spec 3.3). May use: `edit` (queries only).
 *
 * Start with `layoutTranscript(input, previous)`; every other function takes the layout it returns.
 */
export type { TokenAddress } from "./sourceIndex";
export type {
  DisplayToken,
  LayoutBlock,
  LayoutInput,
  ParagraphBlock,
  SourceHeaderBlock,
  SuggestionLookup,
  SuggestionView,
  TranscriptLayout,
  TranscriptLookup,
  UntranscribedBlock,
} from "./layout";
export {
  addressAt,
  addressKey,
  boundaryOf,
  compareAddresses,
  layoutTranscript,
  positionOf,
  sameAddress,
  sequenceTimeAt,
  tokenOf,
} from "./layout";
export type { AnchoredSelection, CaretMotion, Mark, MoveOptions, TextSelection, VisualLines } from "./selection";
export {
  anchorSelection,
  caretAt,
  clampSelection,
  isCollapsed,
  markToRanges,
  moveCaret,
  resolveSelection,
  selectAll,
  selectedSpan,
  selectionToRanges,
  selectTokens,
  snapRangeToTokens,
  tokensToRanges,
} from "./selection";
export type { Caption, SuggestionNavOptions } from "./lookup";
export {
  captionAt,
  caretForSource,
  caretSequenceTime,
  caretSourcePosition,
  nextPendingSuggestion,
  pendingSuggestionRanges,
  previousPendingSuggestion,
  suggestionAt,
  suggestionSelection,
  tokenAtSource,
  tokenSourcePosition,
} from "./lookup";
export type { FindMatch } from "./find";
export { findInTranscript, nextMatch, previousMatch } from "./find";
export { normaliseForSearch } from "./text";
export { STRANDED_SILENCE_MAX, strandedSilence } from "./stranded";
