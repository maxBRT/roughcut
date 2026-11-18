/**
 * The overlays: the shortcut list (`?`, spec 1.10) with rebinding, the "Locate file" prompt for
 * a moved or deleted source (spec 1.12) and the one-line notices with their retry. None takes
 * props: each reads the store, dispatches actions, and renders nothing when it is not open.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  chordFromEvent,
  chordsFor,
  formatChord,
  getAction,
  shortcutGroups,
  type Keymap,
  type RebindError,
} from "../../keys";
import {
  fileNameOf,
  LOCATE_CHORD,
  useDispatch,
  useRoughcut,
  useRoughcutStore,
  type Notice as StoreNotice,
} from "../../state";
import type { ActionId, AppError } from "../../types";
import { Button, Dialog, Key, Notice, ShortcutBar } from "../../ui";
import "./overlays.css";

/** The keycap text of an action's first key ("esc"), or `fallback` when it has none. */
function capFor(keymap: Keymap, id: ActionId, fallback: string): string {
  const first = chordsFor(keymap, id)[0];
  return first === undefined ? fallback : formatChord(first, "cap");
}

/** True when the action's keys differ from its defaults. */
function isChanged(id: ActionId, chords: readonly string[]): boolean {
  const defaults = getAction(id)?.defaults ?? [];
  return (
    defaults.length !== chords.length ||
    defaults.some((c, i) => c !== chords[i])
  );
}

/** The last change made from the overlay (a new key, or back to the defaults), for its message. */
type Attempt =
  | { kind: "rebind"; actionId: ActionId; chord: string }
  | { kind: "reset"; actionId: ActionId };

/** Elements inside the overlay that Tab moves between. */
const TABBABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * The `?` overlay: every shortcut, grouped by context, with rebinding one action at a time.
 * "change" (or Enter on the highlighted row) waits for the next key; Esc keeps the old key. A
 * key that is already taken is refused with the name of the action that has it.
 */
export function ShortcutOverlay() {
  const open = useRoughcut((s) => s.dialogs.shortcuts);
  if (!open) return null;
  return <ShortcutList />;
}

function ShortcutList() {
  const store = useRoughcutStore();
  const dispatch = useDispatch();
  const keymap = useRoughcut((s) => s.keymap);
  const rebindError = useRoughcut((s) => s.rebindError);
  const groups = useMemo(() => shortcutGroups(keymap), [keymap]);
  const flat = useMemo(() => groups.flatMap((g) => g.entries), [groups]);

  const [capturing, setCapturing] = useState<ActionId | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [active, setActive] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const capturingRef = useRef<ActionId | null>(null);
  capturingRef.current = capturing;
  const rows = useRef(new Map<ActionId, HTMLLIElement>());

  // Focus the list on open so the arrows and Enter reach it.
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, []);

  // Keep the highlighted row in view.
  const activeId = flat[active]?.id;
  useEffect(() => {
    if (activeId === undefined) return;
    const el = rows.current.get(activeId);
    if (el && typeof el.scrollIntoView === "function")
      el.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  // While waiting for a key, the next keystroke is the new key, before any other listener.
  useEffect(() => {
    if (capturing === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const chord = chordFromEvent(e);
      if (chord === null) return; // a modifier alone: wait for the rest of the chord
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (chord === "Escape") {
        setCapturing(null);
        setAttempt(null);
        panel.current?.focus({ preventScroll: true });
        return;
      }
      const actionId = capturing;
      setAttempt({ kind: "rebind", actionId, chord });
      void dispatch("ui.rebindKey", { actionId, chord }).then(() => {
        // A refused key keeps the row waiting, so another key can be tried at once.
        setCapturing(store.getState().rebindError ? actionId : null);
        if (!store.getState().rebindError)
          panel.current?.focus({ preventScroll: true });
      });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, dispatch, store]);

  const startCapture = (id: ActionId) => {
    const index = flat.findIndex((x) => x.id === id);
    if (index >= 0) setActive(index);
    setAttempt(null);
    // A focused button would also react to the key pressed next.
    if (
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== panel.current
    ) {
      document.activeElement.blur();
    }
    setCapturing(id);
  };

  const reset = (id: ActionId) => {
    setCapturing(null);
    // Kept as the attempt so a refused reset (its usual key is taken now) says why.
    setAttempt({ kind: "reset", actionId: id });
    void dispatch("ui.resetKey", { actionId: id });
  };

  /**
   * The overlay is modal for keys (spec 1.10): only its own keys act. Esc and the "?" key close
   * it here; every other key stays inside it, so nothing acts behind it (view keys, Tab's view
   * switch, or the Export dialog's keys, whose scope the store keeps while the dialog is open).
   * Tab keeps its default, moving focus between the rows and the footer buttons, wrapping inside
   * the overlay. Returns true when the key was handled or stopped.
   */
  const guardKey = (e: KeyboardEvent): boolean => {
    if (capturingRef.current !== null || e.isComposing) return false;
    const chord = chordFromEvent(e);
    if (chord === null) return false;
    const keys = store.getState().keymap;
    if (
      chordsFor(keys, "everywhere.escape").includes(chord) ||
      chordsFor(keys, "everywhere.showShortcuts").includes(chord)
    ) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) void dispatch("ui.closeShortcuts");
      return true;
    }
    if (e.key === "Tab") {
      const box = root.current?.querySelector<HTMLElement>('[role="dialog"]');
      const stops = box
        ? Array.from(box.querySelectorAll<HTMLElement>(TABBABLE))
        : [];
      const at = document.activeElement;
      const inside = !!box && at instanceof Node && box.contains(at);
      const first = stops[0];
      const last = stops[stops.length - 1];
      const wrapTo = !inside
        ? first
        : e.shiftKey && (at === first || at === panel.current)
          ? last
          : !e.shiftKey && at === last
            ? first
            : undefined;
      if (wrapTo) {
        e.preventDefault();
        wrapTo.focus();
      }
    }
    e.stopPropagation();
    return true;
  };

  // Keys inside the overlay are stopped by the wrapper's onKeyDown below (bubble phase, so the
  // list's own keys run first, and before the store's window listener). A key whose target is
  // outside it (focus fell to the page) is stopped here, before any other listener.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof Node && root.current?.contains(t)) return;
      if (guardKey(e)) e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (capturing !== null || e.target !== panel.current) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => Math.max(0, Math.min(flat.length - 1, i + step)));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : flat.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const id = flat[active]?.id;
      if (id !== undefined) startCapture(id);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      const entry = flat[active];
      if (entry && isChanged(entry.id, entry.chords)) reset(entry.id);
    }
  };

  const message = rebindMessage(attempt, rebindError, keymap);
  const escCap = capFor(keymap, "everywhere.escape", "esc");
  const anyChanged = flat.some((x) => isChanged(x.id, x.chords));

  return (
    <div
      ref={root}
      className="rcs-root"
      onKeyDown={(e) => void guardKey(e.nativeEvent)}
    >
      <Dialog
        open
        size="wide"
        title="shortcuts"
        titleId="rc-shortcuts-title"
        shortcut={capFor(keymap, "everywhere.showShortcuts", "?")}
        onScrimClick={() => void dispatch("ui.closeShortcuts")}
        footer={
          <>
            <ShortcutBar
              items={
                capturing === null
                  ? [
                      { keys: ["↑", "↓"], label: "choose" },
                      { keys: ["enter"], label: "change key" },
                      { keys: ["del"], label: "reset" },
                      { keys: [escCap], label: "close" },
                    ]
                  : [{ keys: [escCap], label: "keep the old key" }]
              }
            />
            <div className="rc-dialog__foot-r">
              <Button
                disabled={!anyChanged}
                onClick={() => void dispatch("ui.resetAllKeys")}
              >
                reset all
              </Button>
              <Button onClick={() => void dispatch("ui.closeShortcuts")}>
                close
              </Button>
            </div>
          </>
        }
      >
        <div
          ref={panel}
          className="rcs-panel"
          tabIndex={-1}
          onKeyDown={onKeyDown}
          aria-label="Every shortcut. Arrows choose, Enter changes the key."
        >
          <p
            className="rcs-status"
            aria-live="polite"
            data-error={message?.error || undefined}
          >
            {capturing !== null
              ? (message?.text ??
                `Press the new key for “${getAction(capturing)?.label ?? capturing}”.`)
              : (message?.text ??
                "To give an action a new key, press Enter on its row or click change.")}
          </p>
          {keymap.rejected.length > 0 && (
            <p className="rcs-status" data-error>
              {keymap.rejected.length === 1
                ? "One saved shortcut was"
                : `${keymap.rejected.length} saved shortcuts were`}{" "}
              ignored because the key was taken; the default is used instead.
            </p>
          )}
          <div className="rcs-groups">
            {groups.map((g) => (
              <section
                key={g.context}
                className="rcs-group"
                aria-labelledby={`rcs-g-${g.context}`}
              >
                <h3 className="rcs-group__title" id={`rcs-g-${g.context}`}>
                  {g.title}
                </h3>
                <ul className="rcs-rows">
                  {g.entries.map((entry) => {
                    const index = flat.indexOf(entry);
                    const waiting = capturing === entry.id;
                    const changed = isChanged(entry.id, entry.chords);
                    return (
                      <li
                        key={entry.id}
                        ref={(el) => {
                          if (el) rows.current.set(entry.id, el);
                          else rows.current.delete(entry.id);
                        }}
                        className="rcs-row"
                        data-action={entry.id}
                        data-active={index === active || undefined}
                        data-waiting={waiting || undefined}
                        onClick={() => setActive(index)}
                      >
                        <span className="rcs-row__label">{entry.label}</span>
                        <span className="rcs-row__keys">
                          {waiting ? (
                            <span className="rcs-wait">press a key…</span>
                          ) : entry.keys.length === 0 ? (
                            <span className="rcs-wait">no key</span>
                          ) : (
                            entry.chords.map((c, i) => (
                              <span key={i} className="rcs-or">
                                {i > 0 && (
                                  <span className="rcs-or__word">or</span>
                                )}
                                <Key title={entry.keys[i]}>{formatChord(c, "cap")}</Key>
                              </span>
                            ))
                          )}
                        </span>
                        <span className="rcs-row__acts">
                          <button
                            type="button"
                            className="rcs-link"
                            aria-label={`Change the key for ${entry.label}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (waiting) setCapturing(null);
                              else startCapture(entry.id);
                            }}
                          >
                            {waiting ? "keep" : "change"}
                          </button>
                          {changed && !waiting && (
                            <button
                              type="button"
                              className="rcs-link"
                              aria-label={`Reset the key for ${entry.label}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                reset(entry.id);
                              }}
                            >
                              reset
                            </button>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </Dialog>
    </div>
  );
}

/** The overlay's one-line message about the last rebind attempt, or null. */
function rebindMessage(
  attempt: Attempt | null,
  error: RebindError | null,
  keymap: Keymap,
): { text: string; error: boolean } | null {
  if (attempt === null) return null;
  const label = getAction(attempt.actionId)?.label ?? attempt.actionId;
  if (attempt.kind === "reset") {
    const defaults = getAction(attempt.actionId)?.defaults ?? [];
    if (error === null) {
      const now = chordsFor(keymap, attempt.actionId).map((c) =>
        formatChord(c),
      );
      return {
        text: `“${label}” is back to ${now.join(" or ") || "no key"}.`,
        error: false,
      };
    }
    if (error.reason === "clash") {
      const held = chordsFor(keymap, error.with);
      const taken = defaults.filter((c) => held.includes(c));
      const keys = (taken.length > 0 ? taken : defaults)
        .map((c) => formatChord(c))
        .join(" or ");
      return {
        text: `${keys} ${taken.length > 1 ? "are" : "is"} already used by “${error.withLabel}”; change that one first.`,
        error: true,
      };
    }
    return { text: `“${label}” cannot be reset.`, error: true };
  }
  const shown = formatChord(attempt.chord);
  if (error === null) {
    const now = chordsFor(keymap, attempt.actionId).map((c) => formatChord(c));
    return {
      text: `“${label}” is now ${now.join(" or ") || shown}.`,
      error: false,
    };
  }
  switch (error.reason) {
    case "clash":
      return {
        text: `${shown} is already used by “${error.withLabel}”. Press another key for “${label}”, or Esc to keep the old one.`,
        error: true,
      };
    case "invalid_chord":
      return {
        text: `${shown} cannot be used as a shortcut. Press another key, or Esc.`,
        error: true,
      };
    case "unknown_action":
      return { text: `“${label}” cannot be changed.`, error: true };
  }
}

/**
 * "Locate file" for a source whose file was moved or deleted. Enter (handled by the store's
 * key wiring, `LOCATE_CHORD`) or "locate…" opens the file picker; Esc or "not now" closes it.
 * A picked file that is not the same recording is refused with its own message.
 */
export function LocateFilePrompt() {
  const prompt = useRoughcut((s) => s.dialogs.locate);
  const exportOpen = useRoughcut((s) => s.dialogs.export !== null);
  const keymap = useRoughcut((s) => s.keymap);
  const dispatch = useDispatch();
  // Behind the Export dialog the prompt's keys do not act, so it waits until the dialog closes.
  if (!prompt || exportOpen) return null;
  const escCap = capFor(keymap, "everywhere.escape", "esc");
  const locateCap = formatChord(LOCATE_CHORD, "cap");
  // The buttons never take focus: Enter belongs to the key wiring, so a focused button would
  // run the locate a second time.
  const noFocus = (e: { preventDefault(): void }) => e.preventDefault();
  return (
    <Dialog
      open
      title="locate file"
      titleId="rc-locate-title"
      footer={
        <>
          <ShortcutBar
            items={[
              { keys: [locateCap], label: "locate…" },
              { keys: [escCap], label: "not now" },
            ]}
          />
          <div className="rc-dialog__foot-r">
            <Button
              tabIndex={-1}
              onMouseDown={noFocus}
              disabled={prompt.busy}
              onClick={() => void dispatch("ui.closeLocate")}
            >
              not now
            </Button>
            <Button
              variant="primary"
              tabIndex={-1}
              onMouseDown={noFocus}
              disabled={prompt.busy}
              onClick={() =>
                void dispatch("ui.locateSource", { sourceId: prompt.sourceId })
              }
            >
              locate…
            </Button>
          </div>
        </>
      }
    >
      <div className="rcl-body" data-source={prompt.sourceId}>
        <p className="rcl-lead">
          <b>{prompt.name}</b> was moved or deleted.
        </p>
        <p className="rcl-note">
          Last seen at <span className="rcl-path">{prompt.path}</span>
        </p>
        <p className="rcl-note">
          Your edits are intact. Pick the file where it is now.
        </p>
        {prompt.busy && (
          <p className="rcl-note" role="status">
            Checking the file…
          </p>
        )}
        {prompt.error && (
          <LocateError error={prompt.error} name={prompt.name} />
        )}
      </div>
    </Dialog>
  );
}

function LocateError({ error, name }: { error: AppError; name: string }) {
  const picked = error.detail ? fileNameOf(error.detail) : null;
  const text =
    error.code === "source_mismatch"
      ? `That is a different file${picked ? ` (${picked})` : ""}, not the recording ${name} was. Pick the original file.`
      : error.code === "source_missing"
        ? `That file is not there any more${picked ? ` (${picked})` : ""}. Pick another.`
        : error.message;
  return (
    <p className="rcl-error" role="alert" data-code={error.code}>
      {text}
    </p>
  );
}

const TONE: Record<StoreNotice["kind"], "info" | "warn" | "error"> = {
  info: "info",
  warning: "warn",
  error: "error",
};

/** The one-line notices, newest last, each with its retry (if any) and a close button. */
export function Notices() {
  const notices = useRoughcut((s) => s.notices);
  const dispatch = useDispatch();
  if (notices.length === 0) return null;
  return (
    <ul className="rcn-list" aria-label="Notices">
      {notices.map((n) => {
        const retry = n.retry;
        return (
          <li key={n.id} className="rcn-item" data-id={n.id} data-kind={n.kind}>
            <Notice
              tone={TONE[n.kind]}
              {...(retry
                ? {
                    onRetry: () => void dispatch(retry.action, retry.payload),
                    retryLabel: retry.label.toLowerCase(),
                  }
                : {})}
            >
              {n.text}
            </Notice>
            <button
              type="button"
              className="rcn-close"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={() => void dispatch("ui.dismissNotice", { id: n.id })}
            >
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}
