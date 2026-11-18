/**
 * Wiring the store to the window: the key listener (spec 3.5.2), files dropped on the window
 * (inside Tauri, where the webview gives real paths), and saving before the page goes away.
 */
import { attachKeys, chordFromEvent, isTypingTarget } from "../keys";
import { runningInTauri } from "./core";
import { selectKeyScope } from "./selectors";
import type { RoughcutStore } from "./store";

/** The key that runs "Locate…" while the Locate file prompt is open (Esc closes it). */
export const LOCATE_CHORD = "Enter";

/**
 * Sends every bound keystroke on `target` to `store.dispatch`, in the store's current scope.
 * While the Locate file prompt is open (and no Export dialog), Enter dispatches
 * `ui.locateSource`. Returns the detach function.
 */
export function attachStoreKeys(store: RoughcutStore, target: EventTarget): () => void {
  // Registered before the key listener, which then ignores the event it prevented.
  const onLocateKey = (e: Event): void => {
    const event = e as KeyboardEvent;
    if (event.type !== "keydown" || event.defaultPrevented || event.repeat) return;
    const s = store.getState();
    if (!s.dialogs.locate || s.dialogs.locate.busy || s.dialogs.export) return;
    if (isTypingTarget(event.target ?? null) || chordFromEvent(event) !== LOCATE_CHORD) return;
    event.preventDefault();
    void store.dispatch("ui.locateSource");
  };
  target.addEventListener("keydown", onLocateKey);
  const detach = attachKeys({
    target,
    keymap: () => store.getState().keymap,
    scope: () => selectKeyScope(store.getState()),
    dispatch: (action) => {
      void store.dispatch(action);
    },
  });
  return () => {
    target.removeEventListener("keydown", onLocateKey);
    detach();
  };
}

/**
 * Files dropped on the app window, as `ui.dropFiles`. Inside Tauri the drop arrives as a
 * webview event with the files' paths; a plain browser gives no paths, so nothing is attached.
 */
export function attachFileDrop(store: RoughcutStore): () => void {
  if (!runningInTauri()) return () => undefined;
  let stop: (() => void) | null = null;
  let stopped = false;
  void import("@tauri-apps/api/webview")
    .then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "drop" && event.payload.paths.length > 0) {
          void store.dispatch("ui.dropFiles", { paths: event.payload.paths });
        }
      }),
    )
    .then(
      (unlisten) => {
        if (stopped) unlisten();
        else stop = unlisten;
      },
      (err: unknown) => console.error("Roughcut: cannot listen for dropped files", err),
    );
  return () => {
    stopped = true;
    stop?.();
  };
}

/** How long closing the window waits for the last save before it closes anyway. */
export const CLOSE_SAVE_LIMIT_MS = 3000;

/**
 * Saves when the window is hidden or about to unload (spec 1.8: closing loses nothing). In the
 * app window the close itself waits for the save (up to CLOSE_SAVE_LIMIT_MS): a save started
 * from `beforeunload` or `pagehide` does not reach the core once the page is going away, so
 * an edit or a playhead move made just before closing was lost (found in the real app).
 */
export function attachSaveOnClose(store: RoughcutStore, target: Window): () => void {
  const flush = () => {
    void store.flushSave();
  };
  const onVisibility = () => {
    if (target.document.visibilityState === "hidden") flush();
  };
  target.addEventListener("beforeunload", flush);
  target.addEventListener("pagehide", flush);
  target.document.addEventListener("visibilitychange", onVisibility);
  const stopClose = store.core.onCloseRequested?.(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_SAVE_LIMIT_MS);
    });
    try {
      await Promise.race([store.prepareToClose().then(() => undefined), limit]);
    } finally {
      clearTimeout(timer);
    }
  });
  return () => {
    stopClose?.();
    target.removeEventListener("beforeunload", flush);
    target.removeEventListener("pagehide", flush);
    target.document.removeEventListener("visibilitychange", onVisibility);
  };
}
