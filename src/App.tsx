/**
 * The app: one store, the key listener in the store's current key scope, the current screen
 * and the dialogs on top of it.
 */
import { useEffect, useState } from "react";
import {
  attachFileDrop,
  attachSaveOnClose,
  attachStoreKeys,
  createRoughcutStore,
  RoughcutProvider,
  useRoughcut,
  type RoughcutStore,
} from "./state";
import { getCore } from "./state/core";
import { EditorScreen } from "./views/editor";
import { ExportDialog } from "./views/export";
import { HomeScreen } from "./views/home";
import { LocateFilePrompt, Notices, ShortcutOverlay } from "./views/overlays";

/** Shows Home or the Editor, and the dialogs. */
function Screens() {
  const screen = useRoughcut((s) => s.screen);
  return (
    <>
      {screen === "home" ? <HomeScreen /> : <EditorScreen />}
      <ExportDialog />
      <LocateFilePrompt />
      <ShortcutOverlay />
      <Notices />
    </>
  );
}

/**
 * The root component. `src/main.tsx` passes the store made by `bootRoughcut()` (src/app/boot.ts),
 * which picks the core; without one (a test), it makes a store on the shared core (`getCore()`).
 */
export function App({ store: given }: { store?: RoughcutStore } = {}) {
  const [store] = useState(() => given ?? createRoughcutStore({ core: getCore() }));

  useEffect(() => {
    const detachKeys = attachStoreKeys(store, window);
    const detachDrop = attachFileDrop(store);
    const detachSave = attachSaveOnClose(store, window);
    void store.init();
    return () => {
      detachKeys();
      detachDrop();
      detachSave();
    };
  }, [store]);

  return (
    <RoughcutProvider store={store}>
      <Screens />
    </RoughcutProvider>
  );
}
