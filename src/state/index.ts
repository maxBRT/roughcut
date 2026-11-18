/**
 * `state`: the single store the views read. Runs actions: calls `edit`, `transcript`, `player` and the core, and holds what the core reports (spec 3.3). The only interface module that talks to the core. May use: `edit`, `transcript`, `player`, the core.
 *
 * See README.md in this folder for how screens read the store and dispatch actions.
 */
export {
  clipUnder,
  createRoughcutStore,
  defaultExportFileName,
  fileNameOf,
  KEY_ACTION_IDS,
  ZOOM_MAX,
  type RoughcutStore,
  type StoreOptions,
  type StoreTimers,
} from "./store";
export { UI_ACTION_IDS } from "./actions";
export { requiredBytesOf, type ExportPlanWithNeeds } from "./exportPlan";
export * from "./selectors";
export {
  RoughcutProvider,
  useDispatch,
  usePlayerAttach,
  useRoughcut,
  useRoughcutShallow,
  useRoughcutStore,
  useVisualLinesRegistration,
} from "./react";
export { attachFileDrop, attachSaveOnClose, attachStoreKeys, LOCATE_CHORD } from "./wiring";
export type {
  Dialogs,
  Dispatch,
  EditorView,
  ExportDialogState,
  FindState,
  KeyActionPayloads,
  LocatePromptState,
  Marks,
  Notice,
  Playhead,
  PlayerLike,
  RoughcutState,
  SaveStatus,
  Screen,
  SourceEntry,
  UiActionId,
  UiActionPayloads,
} from "./types";
