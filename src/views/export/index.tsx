/**
 * The Export dialog (spec 1.7 E, 1.12, 2.9): confirm, running, done. It reads
 * `dialogs.export` and the keymap from the store and dispatches the `export.*` actions; the
 * keys (Enter, Esc, C) reach the same actions through the store's key listener. There is no
 * quality choice: exports are always full quality.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  chordsFor,
  formatChord,
  screenHints,
  type HintScreen,
  type Keymap,
} from "../../keys";
import {
  fileNameOf,
  requiredBytesOf,
  useDispatch,
  useRoughcut,
  useRoughcutStore,
  type ExportDialogState,
  type RoughcutStore,
} from "../../state";
import type { ActionId, AppError } from "../../types";
import {
  Button,
  InfoList,
  Label,
  Led,
  ProgressBar,
  ShortcutBar,
} from "../../ui";
import {
  describeFormat,
  fitPath,
  formatBytes,
  formatClock,
  formatEstimate,
  formatLength,
  formatTimeLeft,
} from "./format";
import "./export.css";

export {
  fitPath,
  describeFormat,
  formatBytes,
  formatClock,
  formatEstimate,
  formatLength,
  formatTimeLeft,
} from "./format";

const HINTS: Record<ExportDialogState["phase"], HintScreen> = {
  confirm: "exportConfirm",
  running: "exportRunning",
  done: "exportDone",
};

/** The keycap text of an action's first key ("ctrl e"), or undefined when it has none. */
function capFor(keymap: Keymap, id: ActionId): string | undefined {
  const first = chordsFor(keymap, id)[0];
  return first === undefined ? undefined : formatChord(first, "cap");
}

/**
 * The Export dialog in its three stages. Renders nothing while `dialogs.export` is null.
 *
 * Drawn as the mockup's Export screen (mockups/roughcut-mockups.html ".exp"): it covers the
 * editor below the header, which stays in view. The left pane is the confirm stage, the right
 * pane holds the running stage above the done stage. The stage in progress is lit; the others
 * stay in place, dimmed, the way a device keeps its unused displays. Its accessible name follows
 * the stage: "export", "exporting <file>", "export done".
 */
export function ExportDialog() {
  const dialog = useRoughcut((s) => s.dialogs.export);
  const keymap = useRoughcut((s) => s.keymap);
  if (!dialog) return null;
  const hints = screenHints(keymap, HINTS[dialog.phase]);
  const title =
    dialog.phase === "confirm"
      ? "export"
      : dialog.phase === "running"
        ? `exporting ${dialog.fileName}`
        : "export done";
  return (
    <div className="rcx-sheet">
      <section
        className="rcx-export"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rc-export-title"
        data-phase={dialog.phase}
      >
        <h2 className="rcx-title" id="rc-export-title">
          {title}
        </h2>
        <ConfirmStage dialog={dialog} keymap={keymap} />
        <div className="rcx-pane rcx-pane--b">
          <RunningStage dialog={dialog} />
          <DoneStage dialog={dialog} />
        </div>
        <ShortcutBar
          className="rcx-hints"
          items={hints.items}
          {...(hints.trailing ? { trailing: hints.trailing } : {})}
        />
      </section>
    </div>
  );
}

/** The name being typed, and the way it reaches the store (`ui.exportFileName`, which re-plans). */
interface NameDraft {
  draft: string;
  setDraft(value: string): void;
  /** Sends the typed name, once; resolves when the re-plan it causes has finished. */
  commit(): Promise<void>;
}

function useNameDraft(fileName: string): NameDraft {
  const dispatch = useDispatch();
  const [draft, setDraft] = useState(fileName);
  // The name last sent to the store, so Enter (or a click) and the blur it causes plan once.
  const sent = useRef(fileName);
  // The commit in flight, so a click that follows a blur waits for the plan the blur started.
  const inFlight = useRef<Promise<void> | null>(null);
  useEffect(() => {
    sent.current = fileName;
    setDraft(fileName);
  }, [fileName]);

  const commit = (): Promise<void> => {
    const name = draft.trim();
    if (name === "") {
      setDraft(sent.current);
      return inFlight.current ?? Promise.resolve();
    }
    if (name === sent.current) return inFlight.current ?? Promise.resolve();
    sent.current = name;
    const p = dispatch("ui.exportFileName", { fileName: name }).finally(() => {
      if (inFlight.current === p) inFlight.current = null;
    });
    inFlight.current = p;
    return p;
  };
  return { draft, setDraft, commit };
}

/** Resolves once the dialog has no plan in progress (or has closed). */
function planSettled(store: RoughcutStore): Promise<void> {
  const settled = () => !store.getState().dialogs.export?.planning;
  if (settled()) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = store.subscribe(() => {
      if (!settled()) return;
      stop();
      resolve();
    });
  });
}

/** The editable file name: committed when the field loses focus; Enter commits and exports. */
function NameField({
  name,
  onExport,
  disabled = false,
}: {
  name: NameDraft;
  onExport: () => void;
  /** True once the export has started: the name is shown, no longer edited. */
  disabled?: boolean;
}) {
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onExport();
  };
  return (
    <form className="rcx-name" onSubmit={onSubmit}>
      <input
        className="rcx-name__input"
        aria-label="File name"
        value={name.draft}
        spellCheck={false}
        disabled={disabled}
        onChange={(e) => name.setDraft(e.target.value)}
        onBlur={() => void name.commit()}
      />
    </form>
  );
}

/**
 * Why the export cannot start. The core's message is shown as it is. For a full disk the view
 * never works out a figure of its own (the file and the temporary pieces may be on different
 * drives): it states the amount needed only when the plan carries `requiredBytes`, with the
 * plan's free space next to it (spec 1.12 "with the amount needed").
 */
function Blocked({ error, folder, needed, free }: { error: AppError; folder: string; needed: number | null; free: number | null }) {
  let detail: string | null = null;
  let amounts: string | null = null;
  // A tool's own output (FFmpeg's error lines) is kept for reporting but folded away, so the
  // dialog shows one plain sentence instead of a wall of encoder messages.
  let technical: string | null = null;
  if (error.code === "disk_full") {
    detail = `Free some space, or change the folder${folder ? ` (now ${folder})` : ""}.`;
    if (needed !== null) amounts = `Needs about ${formatBytes(needed, true)}${free !== null ? ` · ${formatBytes(free)} free` : ""}`;
  } else if (error.code === "source_missing" && error.detail) {
    detail = `Missing: ${fileNameOf(error.detail)}. Close this and locate the file first.`;
  } else if (error.code === "nothing_to_export") {
    detail = "Restore some of the footage, or undo, then export.";
  } else if (error.code === "gpu_unavailable") {
    detail = "Export uses the NVIDIA graphics card's encoder. Check that the graphics driver is installed and up to date, then try again.";
    technical = error.detail ?? null;
  } else if (error.detail && isToolOutput(error.detail)) {
    technical = error.detail;
  } else if (error.detail) {
    detail = error.detail;
  }
  return (
    <div className="rcx-blocked" role="alert" data-code={error.code}>
      <Led on />
      <div>
        <p className="rcx-blocked__msg">{error.message}</p>
        {amounts !== null && (
          <p className="rcx-blocked__detail" data-needed="">
            {amounts}
          </p>
        )}
        {detail !== null && <p className="rcx-blocked__detail">{detail}</p>}
        {technical !== null && (
          <details className="rcx-blocked__tech">
            <summary>technical details</summary>
            <pre>{technical}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

/**
 * A path in one line that keeps its end in view: when it is wider than its box, folders in the
 * middle give way to "…" (the text is monospaced, so characters measure the width). The full
 * path is in the tooltip. Without ResizeObserver (tests) the whole path is shown.
 */
function PathText({ path, className, empty = "", as = "span" }: { path: string; className: string; empty?: string; as?: "span" | "p" }) {
  const ref = useRef<HTMLElement | null>(null);
  const [maxChars, setMaxChars] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const measure = () => {
      const probe = document.createElement("span");
      probe.textContent = "0".repeat(20);
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
      el.appendChild(probe);
      const charW = probe.getBoundingClientRect().width / 20;
      probe.remove();
      const w = el.clientWidth;
      if (charW > 0 && w > 0) setMaxChars(Math.floor(w / charW));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const text = path ? (maxChars === null ? path : fitPath(path, maxChars)) : empty;
  const setRef = (el: HTMLElement | null) => {
    ref.current = el;
  };
  return as === "p" ? (
    <p ref={setRef} className={className} title={path || undefined} data-path={path}>
      {text}
    </p>
  ) : (
    <span ref={setRef} className={className} title={path || undefined} data-path={path}>
      {text}
    </span>
  );
}

/** Whether an error detail is a program's raw output rather than a sentence for the user. */
export function isToolOutput(detail: string): boolean {
  return detail.length > 160 || /FFmpeg exit code|\[[a-z0-9_]+ @ [0-9a-fx]+\]|exit code/i.test(detail);
}

function ConfirmStage({
  dialog,
  keymap,
}: {
  dialog: ExportDialogState;
  keymap: Keymap;
}) {
  const dispatch = useDispatch();
  const store = useRoughcutStore();
  const name = useNameDraft(dialog.fileName);
  const active = dialog.phase === "confirm";
  const plan = dialog.plan;
  const blocked = plan?.blockedBy ?? null;
  // Not disabled while a plan is being worked out: leaving the name field re-plans, and the
  // click that caused it must still start the export once the plan is in (see `startExport`).
  const canStart = dialog.planning || (plan !== null && !blocked);
  const starting = useRef(false);
  const startExport = () => {
    if (starting.current) return;
    starting.current = true;
    void name
      .commit()
      .then(() => planSettled(store))
      .then(() => dispatch("export.confirm"))
      .finally(() => {
        starting.current = false;
      });
  };
  const changeCap = capFor(keymap, "export.changeFolder");

  // With nothing kept there is no file to describe (no length, size or picture format): the
  // note says why, and the figures would only read "0:00 · 0 kb · 0×0".
  const nothing = plan?.blockedBy?.code === "nothing_to_export";
  let summary: string;
  if (nothing) {
    summary = "nothing kept";
  } else if (plan) {
    summary = `${formatLength(plan.duration)} · full quality · about ${formatBytes(plan.estimatedBytes, true)} · takes ${formatEstimate(plan.estimatedSeconds)}`;
  } else if (dialog.planning) {
    summary = "working out the length and size…";
  } else {
    summary = "no estimate";
  }

  return (
    <div className="rcx-pane rcx-pane--a" data-active={active}>
      <Label>confirm</Label>
      <InfoList
        rows={[
          {
            label: "name",
            value: <NameField name={name} onExport={startExport} disabled={!active} />,
          },
          {
            label: "save to",
            value: (
              <PathText className="rcx-folder" path={dialog.folder} empty="no folder chosen" />
            ),
            ...(active
              ? {
                  action: (
                    <Button
                      title={changeCap ? `Change folder (${changeCap})` : "Change folder"}
                      onClick={() => void dispatch("export.changeFolder")}
                    >
                      change folder
                    </Button>
                  ),
                }
              : {}),
          },
        ]}
      />
      <div className="rcx-figures">
        <p
          className="rcx-line"
          aria-live="polite"
          data-planning={dialog.planning || undefined}
        >
          {summary}
        </p>
        {plan && !nothing && <p className="rcx-sub">{describeFormat(plan.format)}</p>}
      </div>
      {plan && plan.notices.length > 0 && (
        <ul className="rcx-notes" aria-label="Export notices">
          {plan.notices.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {active && blocked && (
        <Blocked error={blocked} folder={dialog.folder} needed={requiredBytesOf(plan)} free={plan?.freeBytes ?? null} />
      )}
      {active && dialog.error && !blocked && (
        <Blocked error={dialog.error} folder={dialog.folder} needed={null} free={null} />
      )}
      {active && (
        <div className="rcx-foot">
          <Button onClick={() => void dispatch("export.cancel")}>cancel</Button>
          <Button
            variant="primary"
            disabled={!canStart}
            aria-busy={dialog.planning || undefined}
            onClick={startExport}
          >
            export mp4
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The running stage. While confirming it waits at 0% with the estimate beside it; once the file
 * is written it rests at 100%. Only while running is it a live progress bar with its cancel key.
 */
function RunningStage({ dialog }: { dialog: ExportDialogState }) {
  const dispatch = useDispatch();
  if (dialog.phase === "running") {
    return (
      <div className="rcx-part" data-active="true">
        <Label>running</Label>
        <ProgressBar
          size="large"
          label="Export progress"
          value={dialog.progress}
          detail={formatTimeLeft(dialog.secondsLeft)}
        />
        <div className="rcx-keys">
          <Button onClick={() => void dispatch("export.cancel")}>
            cancel export
          </Button>
        </div>
      </div>
    );
  }
  const done = dialog.phase === "done";
  const detail = done
    ? "finished"
    : dialog.plan && !dialog.plan.blockedBy
      ? formatEstimate(dialog.plan.estimatedSeconds)
      : "not started";
  return (
    <div className="rcx-part" data-active="false">
      <Label>running</Label>
      <div className="rc-progress" aria-hidden="true">
        <div className="rc-pct">
          <span>{done ? "100%" : "0%"}</span>
          <small className="rc-pct__detail">{detail}</small>
        </div>
        <div className="rc-meter">
          <i className="rc-meter__fill" style={{ width: done ? "100%" : "0%" }} />
        </div>
      </div>
    </div>
  );
}

/** The done stage: what was written and where, or a resting line until then. */
function DoneStage({ dialog }: { dialog: ExportDialogState }) {
  const dispatch = useDispatch();
  const r = dialog.result;
  if (dialog.phase !== "done" || !r) {
    return (
      <div className="rcx-part" data-active="false">
        <Label>done</Label>
        <p className="rcx-line rcx-line--idle">
          {dialog.phase === "running" ? "writing the file…" : "not exported yet"}
        </p>
      </div>
    );
  }
  return (
    <div className="rcx-part" data-active="true">
      <Label>done</Label>
      <div className="rcx-figures">
        <p className="rcx-line">
          {formatLength(r.duration)} · {formatBytes(r.bytes)} · took{" "}
          {formatClock(r.tookSeconds)}
        </p>
        <PathText as="p" className="rcx-sub rcx-path" path={r.path} />
      </div>
      <div className="rcx-keys">
        <Button onClick={() => void dispatch("export.showInFolder")}>
          show in folder
        </Button>
        <Button onClick={() => void dispatch("export.copyPath")}>
          {dialog.copied ? "path copied" : "copy path"}
        </Button>
        <Button onClick={() => void dispatch("export.close")}>close</Button>
      </div>
    </div>
  );
}
