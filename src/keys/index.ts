/**
 * `keys`: knows every action, its default key and its context; turns a keystroke into an action;
 * supplies the shortcut list shown by `?` (spec 3.3, 3.5.2). Uses no other interface module: the
 * caller (normally `state`) passes in the dispatch function.
 *
 * Typical use:
 *   const keymap = createKeymap(settings.keyBindings);
 *   const detach = attachKeys({ target: window, keymap: () => keymap, scope: () => "transcript", dispatch });
 */
export {
  CONTEXT_ORDER,
  CONTEXT_TITLES,
  KEY_ACTIONS,
  SCREEN_HINTS,
  getAction,
  type ExportPhase,
  type HintScreen,
  type HintSpec,
  type KeyAction,
} from "./actions";
export { chordFromEvent, formatChord, isTypingTarget, parseChord, type KeyLike } from "./chord";
export {
  actionForChord,
  chordsFor,
  createKeymap,
  findClashes,
  matchEvent,
  rebind,
  resetAction,
  resolve,
  screenHints,
  shortcutGroups,
  toOverrides,
  type KeyEventLike,
  type KeyScope,
  type Keymap,
  type RebindError,
  type RebindResult,
  type ScreenHint,
  type ShortcutEntry,
  type ShortcutGroup,
} from "./keymap";
export { attachKeys, type AttachKeysOptions } from "./listen";
