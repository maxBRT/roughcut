/**
 * `ui`: colours, type and components carried over from the HTML mockups (spec 3.3, 2.4.11). May use: nothing.
 *
 * Styles: src/ui/global.css (imported once by main.tsx) pulls in tokens.css and components.css.
 * Every component here is presentational: props in, markup out.
 */
export {
  AppFrame,
  Button,
  Device,
  Dialog,
  DropZone,
  EmptyState,
  formatPause,
  InfoList,
  Key,
  Keys,
  Label,
  Led,
  ListRow,
  ListRows,
  Notice,
  Oled,
  PauseChip,
  Placeholder,
  ProgressBar,
  Readout,
  ShortcutBar,
  SkeletonLines,
  SuggestionBlock,
  Timecode,
  ViewSwitch,
} from "./components";

export type {
  AppFrameProps,
  ButtonProps,
  ButtonVariant,
  DialogProps,
  DropZoneProps,
  EditorView,
  EmptyStateProps,
  KeyProps,
  ListRowProps,
  NoticeProps,
  PauseChipProps,
  PlaceholderProps,
  ProgressBarProps,
  ReadoutProps,
  ShortcutBarProps,
  ShortcutHint,
  SuggestionBlockProps,
  ViewSwitchProps,
} from "./components";
