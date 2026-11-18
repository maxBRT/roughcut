/**
 * The Editor screen (spec 1.7 B, C, D): the header (project name, the Transcript | Timeline
 * switch, kept length, Export), the player panel (player, time read-out, speed, play and a note
 * line), the overview strip (Transcript view), the shortcut bar for the current view, and the
 * slot for the Transcript or Timeline view. Files dropped on it are added to the project.
 * The one-line notices are shown by the overlays' Notices (App renders it over every screen);
 * the Timeline view's caption and cut counter are drawn by TimelineView itself.
 *
 * Takes no props: it reads the store and dispatches actions only (spec 3.6 rule 1). The player
 * stays mounted at the same place in the tree when the view changes; only the layout moves it.
 */
import { useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { formatChord, screenHints } from "../../keys";
import { PlayerView } from "../../player";
import {
  fileNameOf,
  selectCaretPosition,
  selectHintScreen,
  selectModelDownload,
  selectNothingKept,
  selectPendingSuggestions,
  selectSelectedRanges,
  selectSequenceDuration,
  selectTranscribing,
  useDispatch,
  usePlayerAttach,
  useRoughcut,
  type EditorView,
  type RoughcutState,
} from "../../state";
import type { ActionId, PlaybackRate } from "../../types";
import { AppFrame, Button, Key, Readout, ShortcutBar, Timecode, ViewSwitch } from "../../ui";
import { TimelineView } from "../timeline";
import { TranscriptView } from "../transcript";
import { carriesFiles, droppedPaths } from "./drop";
import { formatDuration, formatSeconds, formatTimecode, formatTimeLeft } from "./format";
import { OverviewStrip } from "./OverviewStrip";
import "./editor.css";

/* ---- header ------------------------------------------------------------------------------- */

/** The first key bound to an action, for a button's tooltip ("ctrl e"); empty when unbound. */
function useChordLabel(actionId: ActionId): string {
  const keymap = useRoughcut((s) => s.keymap);
  const chord = (keymap.chords.get(actionId) ?? [])[0];
  return chord === undefined ? "" : formatChord(chord);
}

/** The brand, which also leads back to Home (the project is saved first). */
function HomeButton() {
  const dispatch = useDispatch();
  return (
    <button type="button" className="rc-ed__home" title="Back to projects" onClick={() => void dispatch("ui.goHome")}>
      roughcut
    </button>
  );
}

/** Kept length and the Export button. */
function HeaderRight() {
  const dispatch = useDispatch();
  const kept = useRoughcut(selectSequenceDuration);
  const nothingKept = useRoughcut(selectNothingKept);
  const hasProject = useRoughcut((s) => s.project !== null);
  const chord = useChordLabel("everywhere.export");
  const disabled = !hasProject || nothingKept;
  return (
    <>
      <Readout label="kept" value={<span data-testid="kept-length">{formatDuration(kept)}</span>} />
      <Button
        variant="primary"
        disabled={disabled}
        title={nothingKept ? "Everything is cut: nothing to export" : chord ? `Export (${chord})` : "Export"}
        onClick={() => void dispatch("everywhere.export")}
      >
        export mp4
      </Button>
    </>
  );
}

/* ---- player panel ------------------------------------------------------------------------- */

const NEXT_RATE: Readonly<Record<PlaybackRate, PlaybackRate>> = { 1: 1.5, 1.5: 2, 2: 1 };

/** "0:28.2 / 41:12", the speed (click for the next one) and play / pause. */
function Transport() {
  const dispatch = useDispatch();
  const time = useRoughcut((s) => s.playhead.time);
  const playing = useRoughcut((s) => s.playhead.playing);
  const total = useRoughcut(selectSequenceDuration);
  const rate = useRoughcut((s) => s.session.playbackRate);
  const playChord = useChordLabel("everywhere.playPause");
  const next = NEXT_RATE[rate] ?? 1;
  return (
    <div className="rc-ed__transport">
      <span data-testid="playhead-time">
        <Timecode value={formatTimecode(time)} total={formatDuration(total)} />
      </span>
      <Button
        aria-label={`Speed ${rate}×, change to ${next}×`}
        title={`Speed: click for ${next}×`}
        onClick={() => void dispatch("ui.setRate", { rate: next })}
      >
        {`${rate}×`}
      </Button>
      <Button title={playChord ? `Play / pause (${playChord})` : "Play / pause"} onClick={() => void dispatch("everywhere.playPause")}>
        {playing ? "pause" : "play"}
      </Button>
    </div>
  );
}

/** What is shown over the player while there is nothing to show; null when the video is there. */
function selectScreenMessage(s: RoughcutState): string | null {
  const p = s.project;
  if (!p) return null;
  if (p.sources.length === 0) return "no footage yet";
  if (s.edit && s.edit.current.clips.length === 0) return "everything is cut";
  return p.sources.some((r) => s.sources[r.id]?.assets?.playbackUrl) ? null : "preparing video…";
}

/** The player box: hosts the player's component and a message while there is no picture. */
function Screen() {
  const onPlayer = usePlayerAttach();
  const message = useRoughcut(selectScreenMessage);
  return (
    <div className="rc-oled rc-ed__screen">
      <PlayerView onPlayer={onPlayer} className="rc-ed__player" />
      {message !== null && (
        <span className="rc-ed__screen-msg" role="status">
          {message}
        </span>
      )}
    </div>
  );
}

/** How many words the selection covers (pause chips and unrecognised speech are not words). */
function selectSelectedWords(s: RoughcutState): number {
  if (!s.layout) return 0;
  const from = Math.max(0, Math.min(s.selection.anchor, s.selection.focus));
  const to = Math.min(s.layout.tokens.length, Math.max(s.selection.anchor, s.selection.focus));
  let n = 0;
  for (let i = from; i < to; i++) if (s.layout.tokens[i]?.token.kind === "word") n++;
  return n;
}

/**
 * The note lines under the transport: transcribing progress, nothing kept, the selection or
 * caret (Transcript view) and waiting for video. The Timeline view's caption and cut counter
 * belong to TimelineView, and the notices to the overlays' Notices, so none is repeated here.
 */
function Notes({ view }: { view: EditorView }) {
  const transcribing = useRoughcut(selectTranscribing);
  const download = useRoughcut(selectModelDownload);
  const ranges = useRoughcut(selectSelectedRanges);
  const words = useRoughcut(selectSelectedWords);
  const caret = useRoughcut(selectCaretPosition);
  const caretName = useRoughcut((s) => {
    const id = selectCaretPosition(s)?.sourceId;
    const ref = id ? s.project?.sources.find((r) => r.id === id) : undefined;
    return ref ? fileNameOf(ref.path) : null;
  });
  const nothingKept = useRoughcut(selectNothingKept);
  const buffering = useRoughcut((s) => s.buffering);
  const pending = useRoughcut(selectPendingSuggestions).length;
  // The key cap as the shortcut bar writes it ("shift a"), following a rebound key.
  const acceptAllKey = useRoughcut((s) => {
    const chord = (s.keymap.chords.get("transcript.acceptAllSuggestions") ?? [])[0];
    return chord === undefined ? "" : formatChord(chord, "cap");
  });
  const dispatch = useDispatch();

  const lines: { key: string; text: ReactNode }[] = [];
  // First run: the speech model is fetched before the first transcript can be made.
  if (download) {
    const pct = `${Math.round(download.progress * 100)}%`;
    lines.push({ key: "model-download", text: ["downloading the speech model, once only", pct, formatTimeLeft(download.secondsLeft)].filter(Boolean).join(" · ") });
  }
  if (transcribing) {
    const left = formatTimeLeft(transcribing.secondsLeft);
    const pct = `${Math.round(Math.max(0, Math.min(1, transcribing.progress)) * 100)}%`;
    lines.push({ key: "transcribing", text: ["transcribing", pct, left].filter(Boolean).join(" · ") });
  }
  if (nothingKept) lines.push({ key: "nothing", text: "everything is cut · nothing to export" });
  if (view === "transcript") {
    if (ranges.length > 0) {
      const us = ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
      // A selection of pause chips only holds no words: it is silence.
      const what = words === 0 ? "silence" : words === 1 ? "1 word" : `${words} words`;
      lines.push({ key: "selection", text: `${what} selected · ${formatSeconds(us)}` });
    } else if (!transcribing && caret && caretName) {
      lines.push({ key: "caret", text: `${caretName} at ${formatTimecode(caret.at)}` });
    }
  }
  // Suggestions still waiting for an answer, with the way to accept them all in one go (one
  // undo step brings them all back). The button never takes focus, so Space keeps meaning play.
  if (view === "transcript" && pending > 0) {
    lines.push({
      key: "suggestions",
      text: (
        <>
          {pending === 1 ? "1 suggestion" : `${pending} suggestions`}
          {" · "}
          <button
            type="button"
            tabIndex={-1}
            className="rc-note__act"
            data-accept-all
            title="Cut everything that is suggested. Undo brings it all back."
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void dispatch("transcript.acceptAllSuggestions")}
          >
            {acceptAllKey ? <Key>{acceptAllKey}</Key> : null}
            accept all
          </button>
        </>
      ),
    });
  }
  if (buffering) lines.push({ key: "buffering", text: "waiting for video…" });

  return (
    <div className="rc-ed__notes" data-testid="editor-notes">
      {lines.map((l) => (
        <p key={l.key} className="rc-note" data-note={l.key}>
          {l.text}
        </p>
      ))}
    </div>
  );
}

/** The player with everything around it. Its children keep their order in both views. */
function PlayerPanel({ view }: { view: EditorView }) {
  return (
    <aside className="rc-ed__side" aria-label="Player">
      <Screen />
      <Transport />
      <Notes view={view} />
    </aside>
  );
}

/* ---- shortcut bar ------------------------------------------------------------------------- */

/** The bottom bar: the hints for the current view, with the bindings in force. */
function HintBar() {
  const keymap = useRoughcut((s) => s.keymap);
  const hintScreen = useRoughcut(selectHintScreen);
  // The mockup keeps the Transcript hints while a suggestion is current: its A / D keys are
  // already shown on the suggestion's own reason line, and Space, Del, R, N and ? still work.
  const screen = hintScreen === "suggestion" ? "transcript" : hintScreen;
  const hints = useMemo(() => screenHints(keymap, screen), [keymap, screen]);
  return <ShortcutBar className="rc-ed__hints" items={hints.items} {...(hints.trailing ? { trailing: hints.trailing } : {})} />;
}

/* ---- the screen --------------------------------------------------------------------------- */

/** The editor: header, the current view, the player panel, the overview strip and the shortcut bar. */
export function EditorScreen() {
  const view = useRoughcut((s) => s.session.view);
  const name = useRoughcut((s) => s.project?.name ?? "");
  const dispatch = useDispatch();
  const [dropping, setDropping] = useState(false);
  const depth = useRef(0);

  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth.current += 1;
    setDropping(true);
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(e.dataTransfer)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDropping(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth.current = 0;
    setDropping(false);
    const paths = droppedPaths(e.dataTransfer);
    if (paths.length > 0) void dispatch("ui.dropFiles", { paths });
  };

  return (
    <div
      className="rc-ed-root"
      data-screen="editor"
      data-editor-view={view}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <AppFrame
        brand={<HomeButton />}
        project={
          <h1 className="rc-ed__name" title={name}>
            {name}
          </h1>
        }
        center={<ViewSwitch value={view} onChange={(v) => void dispatch("ui.setView", { view: v })} />}
        right={<HeaderRight />}
      >
        <div className={`rc-ed rc-ed--${view}`}>
          <section className="rc-ed__main" aria-label={view === "transcript" ? "Transcript" : "Timeline"}>
            {view === "transcript" ? <TranscriptView /> : <TimelineView />}
          </section>
          <PlayerPanel view={view} />
          {view === "transcript" ? <OverviewStrip /> : null}
          <HintBar />
        </div>
      </AppFrame>
      {dropping && (
        <div className="rc-ed__drop" data-testid="drop-overlay">
          <span>drop to add footage to this project</span>
        </div>
      )}
    </div>
  );
}
