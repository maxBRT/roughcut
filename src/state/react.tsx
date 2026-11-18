/**
 * React bindings: the provider that hands the store to the screens, and the hooks they read it
 * with. Views read state with `useRoughcut(selector)` and act with `useDispatch()`; they never
 * call `edit`, the player or the core (spec 3.6 rule 1).
 */
import { createContext, useCallback, useContext, type ReactNode } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { RoughcutStore } from "./store";
import type { Dispatch, PlayerLike, RoughcutState } from "./types";
import type { VisualLines } from "../transcript";

const StoreContext = createContext<RoughcutStore | null>(null);

/** Makes `store` available to every screen below it. */
export function RoughcutProvider({ store, children }: { store: RoughcutStore; children?: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/** The store itself (for `getState()` in event handlers). Throws outside a `RoughcutProvider`. */
export function useRoughcutStore(): RoughcutStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useRoughcutStore: no RoughcutProvider above this component");
  return store;
}

/** Reads a slice of the store; re-renders when it changes (compared with Object.is). */
export function useRoughcut<T>(selector: (state: RoughcutState) => T): T {
  return useStore(useRoughcutStore(), selector);
}

/** Like `useRoughcut`, for a selector that builds a new object or array each time (shallow compare). */
export function useRoughcutShallow<T>(selector: (state: RoughcutState) => T): T {
  return useStore(useRoughcutStore(), useShallow(selector));
}

/** The dispatcher: `dispatch(actionId, payload?)`. */
export function useDispatch(): Dispatch {
  return useRoughcutStore().dispatch;
}

/** The `onPlayer` callback for `PlayerView`: hands the player to the store (null on unmount). */
export function usePlayerAttach(): (player: PlayerLike | null) => void {
  const store = useRoughcutStore();
  return useCallback((player: PlayerLike | null) => store.attachPlayer(player), [store]);
}

/** For the Transcript view: registers its visual lines (Up / Down by line); pass null on unmount. */
export function useVisualLinesRegistration(): (lines: VisualLines | null) => void {
  const store = useRoughcutStore();
  return useCallback((lines: VisualLines | null) => store.setVisualLines(lines), [store]);
}
