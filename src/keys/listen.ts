/**
 * One keydown listener that turns keystrokes into action ids and hands them to a dispatch
 * function supplied by the caller (this module does not import `state`).
 */
import type { ActionId, KeyContext } from "../types";
import { matchEvent, type KeyScope, type Keymap } from "./keymap";

/** What attachKeys needs. The getters are read on every keystroke, so they can follow a store. */
export interface AttachKeysOptions {
  /** Where to listen, usually `window`. */
  target: EventTarget;
  /** The keymap in force now. */
  keymap: () => Keymap;
  /** The active context now (and the Export dialog state when it is open). */
  scope: () => KeyContext | KeyScope;
  /** Runs the action. */
  dispatch: (action: ActionId, event: KeyboardEvent) => void;
}

/**
 * Listens for keydown on the target. A key bound in the active scope has its browser default
 * prevented (Tab does not move focus, Space does not scroll) and its action dispatched, except a
 * held-down repeat of an action that does not repeat. Events already handled
 * (defaultPrevented) are ignored. Returns the function that removes the listener.
 */
export function attachKeys(options: AttachKeysOptions): () => void {
  const onKeyDown = (e: Event): void => {
    const event = e as KeyboardEvent;
    if (event.type !== "keydown" || event.defaultPrevented) return;
    const m = matchEvent(options.keymap(), event, options.scope());
    if (m === null) return;
    event.preventDefault();
    if (m.run) options.dispatch(m.action.id, event);
  };
  options.target.addEventListener("keydown", onKeyDown);
  return () => options.target.removeEventListener("keydown", onKeyDown);
}
