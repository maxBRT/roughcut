/**
 * The Home screen (spec 1.7 A, mockups/screens/home.png): the drop zone on the left, recent
 * projects on the right (the most recent preselected, so Enter resumes it), the shortcut bar
 * below. It reads the store and dispatches actions only (spec 3.6 rule 1). Up / Down / Enter /
 * Delete / Ctrl+N arrive through the store's key listener, not here.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { screenHints } from "../../keys";
import { useDispatch, useRoughcut, useRoughcutStore } from "../../state";
import type { ProjectSummary } from "../../types";
import { AppFrame, Button, DropZone, ListRow, ListRows, ShortcutBar } from "../../ui";
import { droppedPaths, insideTauri } from "./drop";
import { missingNote, rowLengths, rowStat } from "./format";
import "./home.css";

/** How often the "edited 2 h ago" texts are brought up to date. */
const CLOCK_TICK_MS = 30_000;

/** The current time, refreshed every `CLOCK_TICK_MS`. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** True while files are dragged over the window (HTML drag events, or the Tauri webview's). */
function useDragOverWindow(onDropPaths: (paths: string[]) => void): boolean {
  const [active, setActive] = useState(false);
  const onDropRef = useRef(onDropPaths);
  onDropRef.current = onDropPaths;

  useEffect(() => {
    let depth = 0;
    const carriesFiles = (e: DragEvent) => {
      const types = e.dataTransfer?.types;
      if (!types) return false;
      return Array.from(types).some((t) => t === "Files" || t === "text/uri-list");
    };
    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth += 1;
      setActive(true);
    };
    const onOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault(); // allows the drop instead of the browser opening the file
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setActive(false);
    };
    const onDrop = (e: DragEvent) => {
      depth = 0;
      setActive(false);
      if (!carriesFiles(e)) return;
      e.preventDefault();
      // Inside Tauri the webview reports the drop with real paths to the store itself.
      if (insideTauri()) return;
      const paths = droppedPaths(e.dataTransfer);
      if (paths.length > 0) onDropRef.current(paths);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);

    // In the app, file drags reach the webview as Tauri events; follow them for the highlight.
    let unlisten: (() => void) | null = null;
    let stopped = false;
    if (insideTauri()) {
      void import("@tauri-apps/api/webview")
        .then(({ getCurrentWebview }) =>
          getCurrentWebview().onDragDropEvent((event) => {
            const type = event.payload.type;
            setActive(type === "enter" || type === "over");
          }),
        )
        .then(
          (stop) => {
            if (stopped) stop();
            else unlisten = stop;
          },
          () => undefined, // no highlight; the drop itself still works through the store
        );
    }

    return () => {
      stopped = true;
      unlisten?.();
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  return active;
}

/**
 * Returns a function that tells whether the store is busy importing or opening right now. It
 * reads the store at call time, so an event handler sees the current value, not the one from
 * the last render. While busy, the Home screen starts nothing new (no drop, no double-click
 * open), the same way "pick footage" is disabled.
 */
function useIsBusyNow(): () => boolean {
  const store = useRoughcutStore();
  return () => store.getState().busy !== null;
}

/** One recent project. */
function ProjectRow({
  project,
  index,
  selected,
  now,
}: {
  project: ProjectSummary;
  index: number;
  selected: boolean;
  now: Date;
}) {
  const dispatch = useDispatch();
  const isBusyNow = useIsBusyNow();
  const missing = missingNote(project);
  return (
    <ListRow
      data-index={index}
      data-project-id={project.id}
      data-missing={missing !== null || undefined}
      selected={selected}
      name={project.name}
      meta={
        <>
          {rowLengths(project)}
          {missing !== null && (
            <>
              {" · "}
              <span className="rc-home__missing">{missing}</span>
            </>
          )}
        </>
      }
      stat={rowStat(project, now)}
      onActivate={() => void dispatch("ui.selectProject", { index })}
      onDoubleClick={() => {
        if (isBusyNow()) return;
        void dispatch("ui.openProject", { projectId: project.id });
      }}
    />
  );
}

/** The Home screen: drop zone and recent projects. Takes no props; reads the store. */
export function HomeScreen() {
  const ready = useRoughcut((s) => s.ready);
  const projects = useRoughcut((s) => s.projects);
  const selected = useRoughcut((s) => s.homeSelection);
  const busy = useRoughcut((s) => s.busy);
  const keymap = useRoughcut((s) => s.keymap);
  const dispatch = useDispatch();
  const isBusyNow = useIsBusyNow();
  const now = useNow();

  const dragging = useDragOverWindow((paths) => {
    if (isBusyNow()) return;
    void dispatch("ui.dropFiles", { paths });
  });
  const hints = useMemo(() => screenHints(keymap, "home"), [keymap]);
  const newProjectKeys = hints.items.find((h) => h.label === "new project")?.keys.join(" ");

  // Keep the selected row in view, and keep focus on it while focus is in the list.
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`);
    if (!row) return;
    if (typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
    const focused = document.activeElement;
    if (focused && focused !== row && list.current?.contains(focused)) row.focus();
  }, [selected, projects]);

  const busyText = busy === null ? undefined : `${busy.toLowerCase()}…`;

  return (
    <AppFrame className="rc-home-frame">
      <h1 className="rc-home__title">Roughcut</h1>
      <div className="rc-home" data-screen="home">
        <DropZone
          className="rc-home__drop"
          active={dragging}
          aria-busy={busy !== null}
          aria-label="Drop footage here to start a new project"
          {...(busyText !== undefined ? { detail: <span role="status">{busyText}</span> } : {})}
          action={
            <Button variant="primary" disabled={busy !== null} onClick={() => void dispatch("everywhere.newProject")}>
              pick footage
            </Button>
          }
        />
        <div className="rc-home__side" ref={list}>
          {!ready ? (
            <ListRows heading="recent">{null}</ListRows>
          ) : projects.length === 0 ? (
            <div className="rc-recent rc-home__none">
              <div className="rc-rhead">recent</div>
              <div className="rc-home__empty">
                <p className="rc-home__empty-title">no projects yet</p>
                <p className="rc-home__empty-detail">
                  {newProjectKeys
                    ? `drop a recording on the left, or press ${newProjectKeys} to pick one. it opens straight away.`
                    : "drop a recording on the left to start. it opens straight away."}
                </p>
              </div>
            </div>
          ) : (
            <ListRows heading="recent">
              {projects.map((p, i) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  index={i}
                  selected={i === selected}
                  now={now}
                />
              ))}
            </ListRows>
          )}
        </div>
        <ShortcutBar className="rc-home__hints" items={hints.items} {...(hints.trailing ? { trailing: hints.trailing } : {})} />
      </div>
    </AppFrame>
  );
}
