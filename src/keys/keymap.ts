/**
 * The keymap: the defaults with the user's overrides applied. Immutable: rebinding returns a new
 * keymap. Resolves a keystroke to an action in the active context.
 */
import type { ActionId, KeyBinding, KeyContext } from "../types";
import {
  CONTEXT_ORDER,
  CONTEXT_TITLES,
  KEY_ACTIONS,
  SCREEN_HINTS,
  getAction,
  type ExportPhase,
  type HintScreen,
  type KeyAction,
} from "./actions";
import {
  chordFromEvent,
  formatChord,
  isTypingTarget,
  parseChord,
  passesThroughTextField,
  type KeyLike,
} from "./chord";

/** Where keys are being pressed: a context, plus the dialog state for "export". */
export interface KeyScope {
  context: KeyContext;
  /** Only for "export"; defaults to "confirm". */
  phase?: ExportPhase;
}

/** Defaults plus overrides. Treat as a value: never mutate it. */
export interface Keymap {
  /** The chords bound to each action, for every action in the registry. */
  readonly chords: ReadonlyMap<ActionId, readonly string[]>;
  /** Overrides from settings that were not applied (unknown action, bad chord, or a clash). */
  readonly rejected: readonly KeyBinding[];
}

function sameChords(x: readonly string[], y: readonly string[]): boolean {
  if (x.length !== y.length) return false;
  const sx = [...x].sort();
  const sy = [...y].sort();
  return sx.every((c, i) => c === sy[i]);
}

function phasesOverlap(x: KeyAction, y: KeyAction): boolean {
  if (x.phases === undefined || y.phases === undefined) return true;
  return x.phases.some((p) => y.phases?.includes(p) === true);
}

/**
 * Whether two actions may not share a key: same context (and, for Export, an overlapping dialog
 * state), or one of them acts everywhere, unless one deliberately shadows the other.
 */
export function scopesOverlap(x: KeyAction, y: KeyAction): boolean {
  if (x.id === y.id) return false;
  if (x.shadows === y.id || y.shadows === x.id) return false;
  if (x.context === "everywhere" || y.context === "everywhere") return true;
  return x.context === y.context && phasesOverlap(x, y);
}

/** Every pair of actions that share a chord where they may not: [action, other action, chord]. */
export function findClashes(chords: ReadonlyMap<ActionId, readonly string[]>): [ActionId, ActionId, string][] {
  const out: [ActionId, ActionId, string][] = [];
  for (let i = 0; i < KEY_ACTIONS.length; i++) {
    const x = KEY_ACTIONS[i]!;
    const cx = chords.get(x.id) ?? [];
    for (let j = i + 1; j < KEY_ACTIONS.length; j++) {
      const y = KEY_ACTIONS[j]!;
      if (!scopesOverlap(x, y)) continue;
      const cy = chords.get(y.id) ?? [];
      for (const c of cx) if (cy.includes(c)) out.push([x.id, y.id, c]);
    }
  }
  return out;
}

function defaultChords(): Map<ActionId, readonly string[]> {
  return new Map(KEY_ACTIONS.map((x) => [x.id, x.defaults]));
}

/**
 * Builds the keymap from the defaults and Settings.keyBindings (only bindings changed from the
 * defaults). All bindings saved for one action replace that action's defaults. A binding with an
 * unknown action, a context that is not the action's, or an unreadable chord is rejected; so is an
 * overridden action whose key clashes, which then keeps its defaults.
 */
export function createKeymap(overrides: readonly KeyBinding[] = []): Keymap {
  const rejected: KeyBinding[] = [];
  const grouped = new Map<ActionId, { chords: string[]; bindings: KeyBinding[] }>();
  for (const b of overrides) {
    const action = getAction(b.action);
    const chord = parseChord(b.chord);
    if (action === undefined || action.context !== b.context || chord === null) {
      rejected.push(b);
      continue;
    }
    const g = grouped.get(action.id) ?? { chords: [], bindings: [] };
    if (!g.chords.includes(chord)) g.chords.push(chord);
    g.bindings.push(b);
    grouped.set(action.id, g);
  }

  const chords = defaultChords();
  for (const [id, g] of grouped) chords.set(id, g.chords);

  // Revert overridden actions that clash until none do. Defaults never clash (tested), so each
  // round reverts at least one override and this ends.
  for (;;) {
    const clashes = findClashes(chords);
    if (clashes.length === 0) break;
    let reverted = false;
    for (const [x, y] of clashes) {
      for (const id of [x, y]) {
        const g = grouped.get(id);
        if (g !== undefined) {
          chords.set(id, getAction(id)!.defaults);
          grouped.delete(id);
          rejected.push(...g.bindings);
          reverted = true;
          break;
        }
      }
      if (reverted) break;
    }
    if (!reverted) break;
  }
  return { chords, rejected };
}

/** Why a rebinding was refused. */
export type RebindError =
  | { reason: "unknown_action" }
  | { reason: "invalid_chord" }
  | { reason: "clash"; with: ActionId; withLabel: string };

/** Outcome of rebind: the new keymap, or why not. */
export type RebindResult = { ok: true; keymap: Keymap } | ({ ok: false } & RebindError);

/**
 * Binds one action to one chord, replacing its keys. Refused when the chord is taken by another
 * action in the same context (same Export state) or in "everywhere"; rebinding an "everywhere"
 * action is refused for a chord any context uses.
 */
export function rebind(keymap: Keymap, actionId: ActionId, chord: string): RebindResult {
  const action = getAction(actionId);
  if (action === undefined) return { ok: false, reason: "unknown_action" };
  const canonical = parseChord(chord);
  if (canonical === null) return { ok: false, reason: "invalid_chord" };
  for (const other of KEY_ACTIONS) {
    if (!scopesOverlap(action, other)) continue;
    if ((keymap.chords.get(other.id) ?? []).includes(canonical)) {
      return { ok: false, reason: "clash", with: other.id, withLabel: other.label };
    }
  }
  const chords = new Map(keymap.chords);
  chords.set(actionId, [canonical]);
  return { ok: true, keymap: { chords, rejected: keymap.rejected } };
}

/** Puts one action back on its default keys, when that does not clash; otherwise as rebind. */
export function resetAction(keymap: Keymap, actionId: ActionId): RebindResult {
  const action = getAction(actionId);
  if (action === undefined) return { ok: false, reason: "unknown_action" };
  for (const other of KEY_ACTIONS) {
    if (!scopesOverlap(action, other)) continue;
    const taken = keymap.chords.get(other.id) ?? [];
    const hit = action.defaults.find((c) => taken.includes(c));
    if (hit !== undefined) return { ok: false, reason: "clash", with: other.id, withLabel: other.label };
  }
  const chords = new Map(keymap.chords);
  chords.set(actionId, action.defaults);
  return { ok: true, keymap: { chords, rejected: keymap.rejected } };
}

/** The list to save as Settings.keyBindings: one entry per chord of each action changed from its defaults. */
export function toOverrides(keymap: Keymap): KeyBinding[] {
  const out: KeyBinding[] = [];
  for (const action of KEY_ACTIONS) {
    const chords = keymap.chords.get(action.id) ?? action.defaults;
    if (sameChords(chords, action.defaults)) continue;
    for (const chord of chords) out.push({ action: action.id, context: action.context, chord });
  }
  return out;
}

/** The chords bound to an action now (empty for an unknown id). */
export function chordsFor(keymap: Keymap, actionId: ActionId): readonly string[] {
  return keymap.chords.get(actionId) ?? [];
}

function scopeOf(scope: KeyContext | KeyScope): KeyScope {
  return typeof scope === "string" ? { context: scope } : scope;
}

function liveIn(action: KeyAction, scope: KeyScope): boolean {
  if (action.context !== scope.context) return false;
  if (action.phases === undefined) return true;
  return action.phases.includes(scope.phase ?? "confirm");
}

/** The action bound to a chord in a scope: the scope's context first, then "everywhere". */
export function actionForChord(keymap: Keymap, chord: string, scope: KeyContext | KeyScope): KeyAction | null {
  const s = scopeOf(scope);
  const find = (pred: (x: KeyAction) => boolean): KeyAction | null =>
    KEY_ACTIONS.find((x) => pred(x) && (keymap.chords.get(x.id) ?? []).includes(chord)) ?? null;
  if (s.context !== "everywhere") {
    const local = find((x) => liveIn(x, s));
    if (local !== null) return local;
  }
  return find((x) => x.context === "everywhere");
}

/** A keyboard event, or the parts of one that matter here. */
export type KeyEventLike = KeyLike & { target?: EventTarget | null };

/**
 * What a keystroke means: the action, and whether to run it. `run` is false for a held-down key
 * on an action that does not repeat. Null when the key means nothing here, or when the user is
 * typing in a text field and the key is not Esc (Enter there is left to the field: find next).
 */
export function matchEvent(
  keymap: Keymap,
  event: KeyEventLike,
  scope: KeyContext | KeyScope,
): { action: KeyAction; run: boolean } | null {
  const chord = chordFromEvent(event);
  if (chord === null) return null;
  if (isTypingTarget(event.target ?? null) && !passesThroughTextField(chord)) return null;
  const action = actionForChord(keymap, chord, scope);
  if (action === null) return null;
  return { action, run: event.repeat !== true || action.repeat };
}

/** The action id a keystroke triggers in the active context, or null (spec 3.5.2). */
export function resolve(keymap: Keymap, event: KeyEventLike, scope: KeyContext | KeyScope): ActionId | null {
  const m = matchEvent(keymap, event, scope);
  return m !== null && m.run ? m.action.id : null;
}

/** One line of the "?" overlay. */
export interface ShortcutEntry {
  id: ActionId;
  label: string;
  /** Canonical chords. */
  chords: readonly string[];
  /** The same, as shown to the user ("Ctrl+Shift+Z", "?", "←"). */
  keys: readonly string[];
}

/** One group of the "?" overlay. */
export interface ShortcutGroup {
  context: KeyContext;
  title: string;
  entries: ShortcutEntry[];
}

/** The full list for the "?" overlay, grouped by context in the order of spec 1.10, then Home and Export. */
export function shortcutGroups(keymap: Keymap): ShortcutGroup[] {
  return CONTEXT_ORDER.map((context) => ({
    context,
    title: CONTEXT_TITLES[context],
    entries: KEY_ACTIONS.filter((x) => x.context === context).map((x) => {
      const chords = keymap.chords.get(x.id) ?? x.defaults;
      return { id: x.id, label: x.label, chords, keys: chords.map((c) => formatChord(c)) };
    }),
  }));
}

/** A ready-to-draw hint: keycaps in the mockup's style ("ctrl n", "del") and a label. */
export interface ScreenHint {
  keys: string[];
  label: string;
}

/**
 * The hint bar of a screen with the current bindings, shaped for the ui ShortcutBar: `items`,
 * and `trailing` for the "? all shortcuts" hint when the screen has one.
 */
export function screenHints(keymap: Keymap, screen: HintScreen): { items: ScreenHint[]; trailing?: ScreenHint } {
  const toHint = (h: { actions: readonly ActionId[]; label: string }): ScreenHint => ({
    keys: h.actions.flatMap((id) => {
      const first = (keymap.chords.get(id) ?? [])[0];
      return first === undefined ? [] : [formatChord(first, "cap")];
    }),
    label: h.label,
  });
  const specs = SCREEN_HINTS[screen];
  const last = specs[specs.length - 1];
  if (last !== undefined && last.actions.length === 1 && last.actions[0] === "everywhere.showShortcuts") {
    return { items: specs.slice(0, -1).map(toHint), trailing: toHint(last) };
  }
  return { items: specs.map(toHint) };
}
