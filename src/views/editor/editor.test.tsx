/**
 * The Editor screen against the stand-in core and a stand-in player (spec 3.7, "state and
 * views"): keys and clicks go through the store; what the frame shows follows the store in
 * both views. The Transcript and Timeline views are stood in for, so these tests cover the
 * frame alone.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayerLike } from "../../state";
import { RoughcutProvider, selectHintScreen, selectSequenceDuration, selectTranscribing } from "../../state";
import { attachStoreKeys } from "../../state";
import { createTestRig, pressKey, type TestRig } from "../../state/testing";
import { formatDuration } from "./format";

const hoisted = vi.hoisted(() => ({ player: null as PlayerLike | null, mounts: 0, unmounts: 0 }));

vi.mock("../../player", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../player")>();
  /** Stands in for the real player box: hands the rig's FakePlayer to the store. */
  function PlayerView({ onPlayer }: { onPlayer: (p: PlayerLike | null) => void }) {
    useEffect(() => {
      hoisted.mounts++;
      onPlayer(hoisted.player);
      return () => {
        hoisted.unmounts++;
        onPlayer(null);
      };
    }, []);
    return <div data-testid="player-view" />;
  }
  return { ...actual, PlayerView };
});
vi.mock("../transcript", () => ({ TranscriptView: () => <section data-testid="transcript-slot" /> }));
vi.mock("../timeline", () => ({ TimelineView: () => <section data-testid="timeline-slot" /> }));

import { EditorScreen } from "./index";

let rig: TestRig;
let detach: () => void;
const state = () => rig.store.getState();
const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
const originalGetContext = HTMLCanvasElement.prototype.getContext;
let drawn: string[];

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    if (ms > 0) vi.advanceTimersByTime(ms);
    await rig.store.idle();
  });
}

async function press(...chords: string[]): Promise<void> {
  for (const c of chords) {
    await act(async () => {
      pressKey(c);
    });
    await settle();
  }
}

async function setup(): Promise<void> {
  rig = createTestRig({ stepMs: 100, transcriptBatches: 4 });
  hoisted.player = rig.player;
  detach = attachStoreKeys(rig.store, window);
  await rig.store.init();
}

function show() {
  return render(
    <RoughcutProvider store={rig.store}>
      <EditorScreen />
    </RoughcutProvider>,
  );
}

/** Opens the seeded demo project (complete transcript and suggestions) and shows the editor. */
async function openDemo() {
  await setup();
  await rig.store.dispatch("ui.openProject", { projectId: rig.core.demo.projectId });
  await rig.store.idle();
  const view = show();
  await settle();
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  hoisted.mounts = 0;
  hoisted.unmounts = 0;
  drawn = [];
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("rc-strip__in") ? 400 : 0;
    },
  });
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      clearRect: () => drawn.push("clear"),
      fillRect: () => drawn.push("fill"),
      strokeRect: () => drawn.push("stroke"),
      setTransform: () => undefined,
    };
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in tests")));
});

afterEach(() => {
  cleanup();
  detach?.();
  rig?.store.dispose();
  rig?.core.dispose();
  if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", originalClientWidth);
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const keptText = () => screen.getByTestId("kept-length").textContent;
const hintText = () => screen.getByRole("list", { name: "Shortcuts" }).textContent ?? "";

describe("EditorScreen header", () => {
  it("shows the project name, the view switch, the kept length and Export", async () => {
    await openDemo();
    const project = state().project!;
    expect(screen.getByText(project.name)).toBeTruthy();
    expect(screen.getByRole("tab", { name: /transcript/ }).getAttribute("aria-selected")).toBe("true");
    expect(keptText()).toBe(formatDuration(selectSequenceDuration(state())));
    expect(screen.getByTestId("playhead-time").textContent).toContain(formatDuration(selectSequenceDuration(state())));

    fireEvent.click(screen.getByRole("button", { name: "export mp4" }));
    await settle();
    expect(state().dialogs.export).not.toBeNull();
  });

  it("Export is disabled with a note when everything is cut", async () => {
    await openDemo();
    const edit = state().edit!;
    await act(async () => {
      rig.store.setState({ edit: { ...edit, current: { ...edit.current, clips: [] } } });
    });
    const button = screen.getByRole("button", { name: "export mp4" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId("editor-notes").textContent).toContain("everything is cut");
    expect(keptText()).toBe("0:00");
  });

  it("the brand goes back to Home", async () => {
    await openDemo();
    fireEvent.click(screen.getByRole("button", { name: "roughcut" }));
    await settle();
    expect(state().screen).toBe("home");
  });
});

describe("views", () => {
  it("Tab and the switch change the layout; the player is not re-created", async () => {
    const { container } = await openDemo();
    expect(hoisted.mounts).toBe(1);
    expect(screen.getByTestId("transcript-slot")).toBeTruthy();
    expect(screen.getByTestId("overview-strip")).toBeTruthy();
    expect(container.querySelector(".rc-ed--transcript")).toBeTruthy();
    expect(hintText()).toContain("restore");
    expect(hintText()).toContain("all shortcuts");

    await press("Tab");
    expect(state().session.view).toBe("timeline");
    expect(container.querySelector(".rc-ed--timeline")).toBeTruthy();
    expect(screen.getByTestId("timeline-slot")).toBeTruthy();
    expect(screen.queryByTestId("transcript-slot")).toBeNull();
    expect(screen.queryByTestId("overview-strip")).toBeNull();
    expect(screen.getByRole("tab", { name: /timeline/ }).getAttribute("aria-selected")).toBe("true");
    expect(hintText()).toContain("split");
    expect(hintText()).toContain("jump to cut");
    // The cut counter is TimelineView's; the editor's note line never repeats it.
    expect(screen.getByTestId("editor-notes").textContent).not.toMatch(/\bcuts?\b/);

    fireEvent.click(screen.getByRole("tab", { name: /transcript/ }));
    await settle();
    expect(state().session.view).toBe("transcript");
    expect(container.querySelector(".rc-ed--transcript")).toBeTruthy();
    expect(hoisted.mounts).toBe(1);
    expect(hoisted.unmounts).toBe(0);
  });

  it("the frame draws no caption of its own in either view (TimelineView owns it)", async () => {
    const { container } = await openDemo();
    await act(async () => {
      await rig.store.dispatch("ui.placeCaret", { boundary: 5 });
    });
    expect(container.querySelector(".rc-ed__caption, [data-testid='caption']")).toBeNull();
    await press("Tab");
    expect(state().session.view).toBe("timeline");
    expect(container.querySelector(".rc-ed__caption, [data-testid='caption']")).toBeNull();
  });

  it("a cut made in the transcript shows in the kept length in both views", async () => {
    await openDemo();
    const before = selectSequenceDuration(state());
    await act(async () => {
      await rig.store.dispatch("ui.selectTokens", { anchorToken: 0, focusToken: 40 });
    });
    await settle();
    expect(screen.getByTestId("editor-notes").textContent).toMatch(/\d+ words selected · [\d.:]+/);
    await press("Delete");
    const after = selectSequenceDuration(state());
    expect(after).toBeLessThan(before);
    expect(keptText()).toBe(formatDuration(after));
    await press("Tab");
    expect(keptText()).toBe(formatDuration(after));
    await press("Ctrl+Z");
    expect(keptText()).toBe(formatDuration(before));
  });
});

describe("transport", () => {
  it("the speed key cycles 1x, 1.5x, 2x and play toggles the player", async () => {
    await openDemo();
    fireEvent.click(screen.getByRole("button", { name: /^Speed 1×/ }));
    await settle();
    expect(state().session.playbackRate).toBe(1.5);
    expect(rig.player.rate).toBe(1.5);
    expect(screen.getByRole("button", { name: /^Speed 1.5×/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "play" }));
    await settle();
    expect(rig.player.callsOf("toggle")).toHaveLength(1);
    expect(state().playhead.playing).toBe(true);
    expect(screen.getByRole("button", { name: "pause" })).toBeTruthy();
    await act(async () => {
      rig.player.advance(2000);
    });
    expect(screen.getByTestId("playhead-time").textContent).toMatch(/^0:03\.0/);
  });
});

describe("overview strip", () => {
  it("draws bars and moves the playhead when clicked", async () => {
    await openDemo();
    expect(drawn[0]).toBe("clear");
    expect(drawn.filter((d) => d !== "clear")).toHaveLength(100);
    const strip = screen.getByTestId("overview-strip").querySelector(".rc-strip__in") as HTMLElement;
    strip.getBoundingClientRect = () => ({ left: 10, top: 0, width: 400, height: 34, right: 410, bottom: 34, x: 10, y: 0, toJSON: () => ({}) });

    fireEvent.pointerDown(strip, { clientX: 410, button: 0, pointerId: 1 });
    await settle();
    expect(state().playhead.time).toBe(selectSequenceDuration(state()));
    fireEvent.pointerMove(strip, { clientX: 210, pointerId: 1 });
    await settle();
    const mid = state().playhead.time;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(selectSequenceDuration(state()));
    fireEvent.pointerUp(strip, { clientX: 210, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 10, pointerId: 1 });
    await settle();
    expect(state().playhead.time).toBe(mid);
    fireEvent.pointerDown(strip, { clientX: 10, button: 0, pointerId: 1 });
    await settle();
    expect(state().playhead.time).toBe(0);
    const ph = screen.getByTestId("strip-playhead");
    expect(ph.style.left).toBe("0px");
  });
});

describe("transcribing, notices and dropped files", () => {
  it("a new project shows the transcribing line, then the caret", async () => {
    await setup();
    show();
    await act(async () => {
      await rig.store.dispatch("everywhere.newProject");
    });
    await settle(250);
    expect(selectTranscribing(state())).not.toBeNull();
    expect(screen.getByTestId("editor-notes").textContent).toMatch(/^transcribing · \d+%/);
    expect(hintText()).toContain("mark range");
    await settle(4000);
    expect(selectTranscribing(state())).toBeNull();
    expect(screen.getByTestId("editor-notes").textContent).not.toContain("transcribing");
  });

  // Found running the packaged app on a fresh PC: the first transcript waited for the speech
  // model download (a model_download job of no source) and the editor only said
  // "transcribing · 0%" until it was done.
  it("the first-run speech model download shows its own line with progress", async () => {
    await openDemo();
    const job = (state: "queued" | "running" | "done", progress: number) => ({
      id: "dl-1",
      kind: "model_download" as const,
      state,
      progress,
    });
    await act(async () => {
      rig.store.setState({ jobs: { ...state().jobs, "dl-1": job("running", 0.344) } });
    });
    const note = () => screen.getByTestId("editor-notes").querySelector('[data-note="model-download"]')?.textContent ?? null;
    expect(note()).toBe("downloading the speech model, once only · 34%");
    await act(async () => {
      rig.store.setState({ jobs: { ...state().jobs, "dl-1": job("done", 1) } });
    });
    expect(note()).toBeNull();
  });

  it("notices are left to the overlays' Notices: the frame shows none itself", async () => {
    await openDemo();
    await act(async () => {
      rig.store.setState({ notices: [{ id: "a", kind: "error", text: "Could not save" }] });
    });
    expect(screen.queryByText("Could not save")).toBeNull();
    expect(screen.queryByRole("list", { name: "Notices" })).toBeNull();
  });

  it("files dropped on the editor are added to the project", async () => {
    const { container } = await openDemo();
    const root = container.querySelector("[data-screen='editor']") as HTMLElement;
    const dataTransfer = { types: ["Files", "text/uri-list"], files: [], getData: () => "file:///D:/Footage/B.mp4", dropEffect: "none" };
    fireEvent.dragEnter(root, { dataTransfer });
    expect(screen.getByTestId("drop-overlay")).toBeTruthy();
    fireEvent.dragOver(root, { dataTransfer });
    fireEvent.drop(root, { dataTransfer });
    expect(screen.queryByTestId("drop-overlay")).toBeNull();
    await settle();
    expect(state().screen).toBe("editor");
    expect(state().project!.sources.map((s) => s.path)).toContain("D:\\Footage\\B.mp4");

    // A drag of text from the page is not a drop of footage.
    fireEvent.dragEnter(root, { dataTransfer: { types: ["text/plain"], files: [], getData: () => "" } });
    expect(screen.queryByTestId("drop-overlay")).toBeNull();
  });
});

describe("hint bar with a current suggestion", () => {
  it("keeps the Transcript hints, as the mockup draws it (A / D are on the suggestion's own line)", async () => {
    await openDemo();
    await press("N");
    expect(selectHintScreen(state())).toBe("suggestion");
    const hints = hintText();
    for (const label of ["play", "cut", "restore", "next suggestion", "all shortcuts"]) expect(hints).toContain(label);
    expect(hints).not.toContain("keep");
  });
});

describe("accept all suggestions", () => {
  const pendingCount = () => state().layout!.suggestions.filter((v) => v.state === "pending").length;
  const line = () => document.querySelector('[data-note="suggestions"]');

  it("the note under the player counts the suggestions and its button accepts them all; one undo brings them back", async () => {
    await openDemo();
    const before = pendingCount();
    expect(before).toBeGreaterThan(1);
    expect(line()?.textContent).toContain(`${before} suggestions`);
    const button = line()!.querySelector("button[data-accept-all]") as HTMLButtonElement;
    expect(button.textContent).toMatch(/shift a\s*accept all/i);
    const clips = state().edit!.current.clips.length;

    await act(async () => {
      fireEvent.click(button);
    });
    await settle();
    expect(pendingCount()).toBe(0);
    expect(state().edit!.current.clips.length).toBeGreaterThan(clips);
    expect(line()).toBeNull(); // nothing left to accept: the line goes away

    await press("Ctrl+Z");
    expect(pendingCount()).toBe(before);
    expect(state().edit!.current.clips.length).toBe(clips);
    expect(line()?.textContent).toContain(`${before} suggestions`);
  });

  it("is not shown in the Timeline view, where suggestions are not drawn", async () => {
    await openDemo();
    expect(line()).not.toBeNull();
    await press("Tab");
    expect(line()).toBeNull();
  });
});
