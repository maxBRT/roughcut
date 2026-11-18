/**
 * The actions the mouse needs that have no key (spec 1.8 "Mouse works too", and the buttons of
 * the mockups). Their payloads are `UiActionPayloads` in ./types. Key actions are the ids of
 * `KEY_ACTIONS` in `keys`; both go through the same `dispatch`.
 */
import type { UiActionId, UiActionPayloads } from "./types";

const ALL: Record<UiActionId, true> = {
  "ui.placeCaret": true,
  "ui.selectTokens": true,
  "ui.seek": true,
  "ui.trimEdgeTo": true,
  "ui.moveClipTo": true,
  "ui.dropFiles": true,
  "ui.selectProject": true,
  "ui.openProject": true,
  "ui.removeProject": true,
  "ui.renameProject": true,
  "ui.goHome": true,
  "ui.setView": true,
  "ui.setRate": true,
  "ui.findQuery": true,
  "ui.findNext": true,
  "ui.findPrevious": true,
  "ui.findClose": true,
  "ui.selectSuggestion": true,
  "ui.retryClaude": true,
  "ui.retrySave": true,
  "ui.dismissNotice": true,
  "ui.installUpdate": true,
  "ui.locateSource": true,
  "ui.closeLocate": true,
  "ui.exportFileName": true,
  "ui.setZoom": true,
  "ui.cancelJob": true,
  "ui.rebindKey": true,
  "ui.resetKey": true,
  "ui.resetAllKeys": true,
  "ui.closeShortcuts": true,
};

/** Every mouse action id (each has a handler; a test checks it). */
export const UI_ACTION_IDS: readonly (keyof UiActionPayloads)[] = Object.keys(ALL) as UiActionId[];
