/**
 * The whole interface, joined up (spec 3.7, "state and views"): the real App with the real
 * Home, Editor, Transcript, Timeline and Export views, the overlays and the store's key wiring,
 * on the stand-in core. Each use case of spec 1.6 is done with key presses sent to whatever has
 * focus, and checked on screen. Only the video player is a stand-in (FakePlayer behind a mocked
 * PlayerView): jsdom plays no video. Also covers the cross-module fixes of the integration step.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { createRoughcutStore, selectClips, selectKeyScope, type RoughcutStore } from "../state";
import { appError } from "../state/core";
import { createTestRig, FakePlayer, pressKey, type TestRig } from "../state/testing";
import type { Transcript } from "../types";
import { installRecordingCanvas } from "../views/timeline/testing";

const players = vi.hoisted(() => ({ current: null as unknown }));

// The one stand-in: a PlayerView that hands the store a FakePlayer instead of a <video> player.
vi.mock("../player", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../player")>();
  const React = await import("react");
  function PlayerView({ onPlayer }: { onPlayer: (p: unknown) => void }) {
    React.useEffect(() => {
      onPlayer(players.current);
      return () => onPlayer(null);
    }, [onPlayer]);
    return React.createElement("div", { "data-testid": "player" });
  }
  return { ...actual, PlayerView };
});

let rig: TestRig;
let copied: string[];
let canvasMock: ReturnType<typeof installRecordingCanvas>;
const state = () => rig.store.getState();

// ---- jsdom lays nothing out: give the transcript scroller a size so its rows render ----
const VIEW_HEIGHT = 2000;
const realRect = Element.prototype.getBoundingClientRect;
const realClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!;
const realClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!;
const isScroller = (el: Element) => el instanceof HTMLElement && el.dataset.txScroller !== undefined;

function stubLayout(): void {
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get(this: Element) {
      return isScroller(this) ? VIEW_HEIGHT : 0;
    },
  });
  Object.defineProperty(Element.prototype, "clientWidth", {
    configurable: true,
    get(this: Element) {
      return isScroller(this) ? 900 : 0;
    },
  });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (isScroller(this)) {
      return { x: 0, y: 0, top: 0, left: 0, right: 900, bottom: VIEW_HEIGHT, width: 900, height: VIEW_HEIGHT, toJSON: () => ({}) } as DOMRect;
    }
    return realRect.call(this);
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  stubLayout();
  canvasMock = installRecordingCanvas();
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in tests")));
});

afterEach(() => {
  cleanup();
  rig?.store.dispose();
  rig?.core.dispose();
  canvasMock.restore();
  vi.unstubAllGlobals();
  Element.prototype.getBoundingClientRect = realRect;
  Object.defineProperty(Element.prototype, "clientHeight", realClientHeight);
  Object.defineProperty(Element.prototype, "clientWidth", realClientWidth);
  vi.useRealTimers();
});

// ---- helpers ----

async function start(coreOptions: Parameters<typeof createTestRig>[0] = {}): Promise<void> {
  copied = [];
  rig = createTestRig(
    { stepMs: 100, transcriptBatches: 4, ...coreOptions },
    { clipboard: { writeText: async (t) => void copied.push(t) } },
  );
  players.current = rig.player;
  render(<App store={rig.store} />);
  await settle();
}

/** Lets every action, save and render in flight finish. */
async function settle(): Promise<void> {
  await act(async () => {
    await rig.store.idle();
  });
}

/** Presses keys one after another on whatever has focus, as a keyboard does. */
async function key(...chords: string[]): Promise<void> {
  for (const chord of chords) {
    await act(async () => {
      pressKey(chord, document.activeElement ?? document.body);
      await rig.store.idle();
    });
  }
}

/** Lets the stand-in core's jobs (and the store's autosave) run for `ms`. */
async function run(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await rig.store.idle();
  });
  await settle();
}

const heading = () => screen.getByRole("heading", { level: 1 }).textContent;
const tokens = (keep?: string) =>
  document.querySelectorAll(`[data-view='transcript'] [data-pos]${keep ? `[data-keep='${keep}']` : ""}`);
const words = () => document.querySelectorAll("[data-view='transcript'] [data-kind='word']");
const notes = () => screen.getByTestId("editor-notes").textContent ?? "";
const kept = () => screen.getByTestId("kept-length").textContent;
const suggestionLines = () => document.querySelectorAll("[data-suggestion-line]");
const dialog = (name: string) => screen.queryByRole("dialog", { name });
const trackLabel = () => screen.getByRole("img", { name: /^Timeline track/ }).getAttribute("aria-label");

/** A promise and the function that settles it. */
function gate<T = void>(): { promise: Promise<T>; open: (value: T) => void } {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** From Home: Enter opens the selected project (the demo). */
async function openDemoFromHome(): Promise<void> {
  expect(heading()).toBe("Roughcut");
  await key("Enter");
  expect(heading()).toBe("Weekly update - Nov 13");
}

// ---- the use cases of spec 1.6 ----

describe("UC1 import footage, UC2 timed transcript", () => {
  it("Ctrl+N opens a playable project at once; the text streams in while you already work", async () => {
    await start();
    expect(screen.getByText("Weekly update - Nov 13")).toBeTruthy(); // the Home list
    await key("Ctrl+N");
    expect(heading()).toBe("TAKE-2");
    expect(screen.getByTestId("player")).toBeTruthy();
    expect(words()).toHaveLength(0);
    expect(document.querySelector("[data-row='untranscribed']")).toBeTruthy();
    // The project is shown before the core's first assets event: the player reports no
    // address, which is not yet a reason to tell the user anything (finding: false notice).
    expect(document.body.textContent).not.toMatch(/cannot play yet/);

    // The core reports the original as playable (spec 2.4.2): still no notice, nothing to fix.
    await run(100);
    expect(state().sources[state().project!.sources[0]!.id]!.assets!.playback).toBe("original");
    expect(document.body.textContent).not.toMatch(/cannot play yet/);
    expect(state().playerError).toBeNull();
    expect(words()).toHaveLength(0);

    // Before any text: mark a range while playing and cut it from the keyboard (spec 1.7 B).
    await key("Space");
    expect(state().playhead.playing).toBe(true);
    act(() => rig.player.advance(2000));
    await key("I");
    act(() => rig.player.advance(1000));
    await key("O", "Space", "Delete");
    expect(selectClips(state())).toHaveLength(2);
    await key("Ctrl+Z");
    expect(selectClips(state())).toHaveLength(1);

    await run(150);
    expect(notes()).toMatch(/transcribing · \d+%/);
    const first = words().length;
    expect(first).toBeGreaterThan(0);
    expect(document.querySelector("[data-arriving]")).toBeTruthy();
    await run(100);
    expect(words().length).toBeGreaterThan(first);

    await run(3000);
    expect(notes()).not.toMatch(/transcribing/);
    expect(document.querySelector("[data-arriving]")).toBeNull();
    expect(suggestionLines().length).toBeGreaterThan(0); // UC3 starts on its own
  });

  it("a second Ctrl+N, drop or Enter while an import runs starts nothing (one at a time)", async () => {
    await start();
    const wait = gate();
    const original = rig.core.createProject.bind(rig.core);
    const create = vi.spyOn(rig.core, "createProject").mockImplementation(async (paths) => {
      await wait.promise;
      return original(paths);
    });
    const open = vi.spyOn(rig.core, "openProject");
    await act(async () => {
      pressKey("Ctrl+N", document.body);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(state().busy).toBe("Importing footage");
    await act(async () => {
      pressKey("Ctrl+N", document.body);
      pressKey("Enter", document.body);
      void rig.store.dispatch("ui.dropFiles", { paths: ["D:\\Footage\\Other.mp4"] });
    });
    expect(screen.getByRole("status").textContent).toBe("importing footage…");
    wait.open();
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(heading()).toBe("TAKE-2");
    expect(state().busy).toBeNull();
  });
});

describe("UC3 review suggested cuts", () => {
  it("N lands on a suggestion, A cuts it, D keeps the next, Shift+A takes the rest in one undo step", async () => {
    await start();
    await openDemoFromHome();
    const pending = suggestionLines().length;
    expect(pending).toBeGreaterThan(3);

    await key("N");
    const current = document.querySelector<HTMLElement>("[data-suggestion-line][data-current]")!;
    expect(current).toBeTruthy();
    const first = current.dataset.suggestionLine!;
    expect(tokens("cut")).toHaveLength(0);
    await key("A");
    expect(tokens("cut").length).toBeGreaterThan(0);
    expect(document.querySelector(`[data-suggestion-line='${first}']`)).toBeNull();
    expect(suggestionLines()).toHaveLength(pending - 1);

    await key("N");
    const second = document.querySelector<HTMLElement>("[data-suggestion-line][data-current]")!.dataset.suggestionLine!;
    const cutBefore = tokens("cut").length;
    await key("D");
    expect(document.querySelector(`[data-suggestion-line='${second}']`)).toBeNull();
    expect(tokens("cut")).toHaveLength(cutBefore);

    const keptBefore = kept();
    await key("Shift+A");
    expect(suggestionLines()).toHaveLength(0);
    expect(kept()).not.toBe(keptBefore);
    await key("Ctrl+Z");
    expect(suggestionLines()).toHaveLength(pending - 2);
    expect(kept()).toBe(keptBefore);
  });
});

describe("UC4 cut bad takes by deleting text", () => {
  it("Shift+arrows and Delete strike words through; H hides them; R restores; the timeline shows the cut", async () => {
    await start();
    await openDemoFromHome();
    const keptBefore = kept();
    await key("ArrowRight", "ArrowRight", "ArrowRight", "Shift+ArrowRight", "Shift+ArrowRight");
    expect(notes()).toMatch(/^2 words selected · /);
    await key("Delete");
    expect([...tokens("cut")].map((t) => (t as HTMLElement).dataset.pos)).toEqual(["3", "4"]);
    expect(kept()).not.toBe(keptBefore);

    await key("Tab");
    expect(trackLabel()).toBe("Timeline track, 2 clips");
    await key("Tab");
    expect(document.querySelector("[data-view='transcript']")).toBeTruthy();

    await key("H");
    expect(tokens("cut")).toHaveLength(0);
    expect(document.querySelector("[data-cut-hidden]")!.textContent).toMatch(/^cut text hidden/);
    await key("H");
    expect(tokens("cut")).toHaveLength(2);

    await key("Shift+ArrowLeft", "Shift+ArrowLeft", "R");
    expect(tokens("cut")).toHaveLength(0);
    expect(kept()).toBe(keptBefore);
  });

  it("a selection of pause chips only is described as silence, not '0 words'", async () => {
    await start();
    await openDemoFromHome();
    const chip = document.querySelector<HTMLElement>("[data-view='transcript'] [data-kind='pause']")!;
    await act(async () => {
      fireEvent.mouseDown(chip, { button: 0, detail: 2 });
      await rig.store.idle();
    });
    expect(notes()).toMatch(/^silence selected · \d/);
  });

  it("the find box steps with Enter / Shift+Enter itself, and a match in hidden cut text shows it", async () => {
    await start();
    await openDemoFromHome();
    await key("Ctrl+F");
    const input = screen.getByRole("searchbox", { name: "Find in transcript" }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    await act(async () => {
      fireEvent.change(input, { target: { value: "first thing" } });
      await rig.store.idle();
    });
    const status = () => document.querySelector("[data-find-status]")!.textContent;
    const total = state().find.matches.length;
    expect(total).toBeGreaterThan(2);
    expect(status()).toBe(`1 of ${total}`);
    await key("Enter");
    expect(status()).toBe(`2 of ${total}`);
    await key("Shift+Enter");
    expect(status()).toBe(`1 of ${total}`);
    expect(rig.player.callsOf("play")).toHaveLength(0); // Enter in the box is not "play from the caret"
    expect(document.activeElement).toBe(input);

    // Cut the first match and hide cut text: it is still found, inside the hidden text.
    await key("Escape");
    expect(screen.queryByRole("searchbox")).toBeNull();
    await key("Delete", "H");
    expect(state().session.cutTextHidden).toBe(true);
    expect(tokens("cut")).toHaveLength(0);
    await key("Ctrl+F");
    const again = screen.getByRole("searchbox", { name: "Find in transcript" }) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(again, { target: { value: "" } });
      await rig.store.idle();
    });
    await act(async () => {
      fireEvent.change(again, { target: { value: "first thing" } });
      await rig.store.idle();
    });
    // The first match from the caret is the hidden one right at the caret (after the cut):
    // landing on it shows the cut text (spec 1.8.10), struck through and highlighted.
    expect(state().find.matches).toHaveLength(total);
    expect(state().session.cutTextHidden).toBe(false);
    expect(status()).toBe(`1 of ${total}`);
    expect(document.querySelectorAll(".rc-tx-find-hit--current[data-keep='cut']")).toHaveLength(2);
    await key("Enter");
    expect(status()).toBe(`2 of ${total}`);
    expect(document.activeElement).toBe(again);
  });

  it("a kept clip with no speech is shown as a 'no speech' row", async () => {
    await start();
    const sourceId = rig.core.demo.sourceId;
    const empty: Transcript = { schemaVersion: 1, sourceId, model: "test", complete: true, utterances: [] };
    vi.spyOn(rig.core, "getTranscript").mockResolvedValue(empty);
    await openDemoFromHome();
    const row = document.querySelector<HTMLElement>("[data-row='untranscribed']")!;
    expect(row.dataset.status).toBe("silent");
    expect(row.textContent).toMatch(/no speech · 0:00 – \d+:\d\d/);
    expect(words()).toHaveLength(0);
  });
});

describe("UC5 add and reorder recordings", () => {
  it("Ctrl+O appends a recording; Alt+Left on the timeline moves it first, and the transcript follows", async () => {
    await start();
    await openDemoFromHome();
    await key("Ctrl+O");
    const headers = () => [...document.querySelectorAll(".rc-tx-src")].map((h) => h.textContent);
    // The new recording is appended: its header is at the end of a long transcript, off screen.
    expect(state().project!.sources.map((r) => r.path)).toEqual(["D:\\Footage\\TAKE-1.mp4", "D:\\Footage\\TAKE-2.mp4"]);
    expect(headers()[0]).toBe("TAKE-1.mp4");
    await key("Tab", "ArrowDown"); // to the cut between the two recordings
    expect(trackLabel()).toBe("Timeline track, 2 clips");
    await key("Alt+ArrowLeft");
    const ids = selectClips(state()).map((c) => c.sourceId);
    expect(ids[0]).toBe(state().project!.sources[1]!.id);
    await key("Tab");
    expect(headers()[0]).toBe("TAKE-2.mp4");
  });
});

describe("UC6 fine-tune cuts on the timeline", () => {
  it("jump to a cut, nudge its edge, split, remove a clip, undo", async () => {
    await start();
    await openDemoFromHome();
    await key("ArrowRight", "ArrowRight", "ArrowRight", "Shift+ArrowRight", "Shift+ArrowRight", "Delete");
    await key("Tab");
    expect(selectKeyScope(state())).toBe("timeline");
    expect(trackLabel()).toBe("Timeline track, 2 clips");
    await key("ArrowUp", "ArrowUp"); // back to the cut before the caret, then to the start
    expect(state().playhead.time).toBe(0);
    await key("ArrowDown"); // to the cut
    expect(state().playhead.time).toBe(selectClips(state())[0]!.end - selectClips(state())[0]!.start);
    const [a] = selectClips(state());
    const endBefore = a!.end;
    await key(".");
    expect(selectClips(state())[0]!.end).toBeGreaterThan(endBefore);
    await key("Ctrl+Z");
    expect(selectClips(state())[0]!.end).toBe(endBefore);

    await key("Shift+ArrowRight", "S");
    expect(trackLabel()).toBe("Timeline track, 3 clips");
    await key("Delete");
    expect(trackLabel()).toBe("Timeline track, 2 clips");
    await key("Ctrl+Z", "Ctrl+Z");
    expect(trackLabel()).toBe("Timeline track, 2 clips");
    expect(screen.getByText(/^cut \d+ of \d+$|^\d+ cuts?$/)).toBeTruthy();
  });
});

describe("UC7 export an MP4", () => {
  it("Ctrl+E, Enter, wait; Enter shows the file, C copies its path, Esc closes", async () => {
    await start();
    await openDemoFromHome();
    await key("Ctrl+E");
    expect(dialog("export")).toBeTruthy();
    expect(within(dialog("export")!).getByText(/full quality/)).toBeTruthy();
    await key("Enter");
    expect(screen.getByRole("dialog", { name: /^exporting weekly-update-nov-13-/ })).toBeTruthy();
    await run(5000);
    const done = screen.getByRole("dialog", { name: "export done" });
    const path = state().dialogs.export!.result!.path;
    expect(within(done).getByText(path)).toBeTruthy();
    await key("Enter");
    expect(rig.core.revealed).toEqual([path]);
    await key("C");
    expect(copied).toEqual([path]);
    await key("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(state().project!.lastExport?.path).toBe(path);
  });

  it("the ? overlay over the Export dialog takes the keys: Enter exports nothing, Esc closes only the overlay", async () => {
    await start();
    await openDemoFromHome();
    const startExport = vi.spyOn(rig.core, "startExport");
    const pickFolder = vi.spyOn(rig.core, "pickFolder");
    await key("Ctrl+E", "?");
    expect(dialog("shortcuts")).toBeTruthy();
    expect(selectKeyScope(state())).toBe("everywhere");
    // Behind the overlay the dialog's own keys do nothing (C would change the folder).
    await key("C");
    expect(pickFolder).not.toHaveBeenCalled();
    expect(state().dialogs.export?.phase).toBe("confirm");
    await key("Escape");
    expect(dialog("shortcuts")).toBeNull();
    expect(dialog("export")).toBeTruthy();
    await key("Enter");
    expect(startExport).toHaveBeenCalledTimes(1);
  });

  it("not enough disk space: the dialog says so with the amount needed, and Enter does nothing", async () => {
    await start({ errors: { diskFull: true } });
    await openDemoFromHome();
    await key("Ctrl+E");
    const alert = within(dialog("export")!).getByRole("alert");
    expect(alert.querySelector("[data-needed]")!.textContent).toMatch(/^Needs about \d+ gb · [\d.]+ gb free$/);
    await key("Enter");
    expect(state().dialogs.export?.phase).toBe("confirm");
  });

  it("a notice's Retry works with the Export dialog open", async () => {
    await start();
    await openDemoFromHome();
    await run(2500); // whatever opening the project left to save
    rig.core.failNext("save_edit", appError("internal", "The disk is busy."));
    await key("3"); // a change of speed is saved after a while
    await run(2500);
    const notice = screen.getByRole("list", { name: "Notices" }).querySelector<HTMLElement>("[data-id='save']")!;
    await key("Ctrl+E");
    expect(dialog("export")).toBeTruthy();
    const save = vi.spyOn(rig.core, "saveEdit");
    await act(async () => {
      fireEvent.click(within(notice).getByRole("button", { name: "retry" }));
      await rig.store.idle();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[aria-label='Notices'] [data-id='save']")).toBeNull();
    expect(state().save.error).toBeNull();
  });
});

describe("UC8 resume a project later", () => {
  it("reopened from Home with Enter: the cut, its undo and the mixed-format notice are all back", async () => {
    await start({ pickedFiles: ["D:\\Footage\\TAKE-3.mp4", "D:\\Footage\\SCREEN.mov"] });
    await key("Ctrl+N");
    const mixed = () => screen.queryByRole("list", { name: "Notices" })?.querySelector("[data-id='mixed']") ?? null;
    expect(mixed()).toBeTruthy();
    await run(3000); // transcripts in
    await key("ArrowRight", "Shift+ArrowRight", "Shift+ArrowRight", "Delete");
    expect(tokens("cut")).toHaveLength(2);
    await run(500); // autosave
    const projectId = state().project!.id;

    // The app is closed and started again on the same core.
    cleanup();
    rig.store.dispose();
    const player = new FakePlayer();
    players.current = player;
    const store: RoughcutStore = createRoughcutStore({ core: rig.core, player });
    rig = { ...rig, store, player };
    render(<App store={store} />);
    await settle();
    expect(heading()).toBe("Roughcut");
    expect(state().projects[0]!.id).toBe(projectId);
    expect(mixed()).toBeNull();

    await key("Enter");
    expect(heading()).toBe("TAKE-3");
    expect(tokens("cut")).toHaveLength(2);
    expect(mixed()).toBeTruthy(); // spec 1.12: shown again on reopening
    await key("Ctrl+Z");
    expect(tokens("cut")).toHaveLength(0);
  });

  it("Enter pressed twice while a project opens opens it once", async () => {
    await start();
    const wait = gate();
    const original = rig.core.openProject.bind(rig.core);
    const open = vi.spyOn(rig.core, "openProject").mockImplementation(async (id) => {
      await wait.promise;
      return original(id);
    });
    await act(async () => {
      pressKey("Enter", document.body);
      await Promise.resolve();
      pressKey("Enter", document.body);
    });
    expect(state().busy).toBe("Opening project");
    wait.open();
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    expect(heading()).toBe("Weekly update - Nov 13");
  });
});

describe("Locate file (spec 1.12)", () => {
  it("the prompt is modal for keys; Enter locates once even if pressed again while the picker is open", async () => {
    await start();
    rig.core.setErrors({ missingSources: [rig.core.demo.sourceId] });
    await openDemoFromHome();
    expect(dialog("locate file")).toBeTruthy();
    await key("ArrowRight", "Delete");
    expect(tokens("cut")).toHaveLength(0); // view keys do nothing behind it

    const picked = gate<string[] | null>();
    const pick = vi.spyOn(rig.core, "pickFiles").mockImplementation(() => picked.promise);
    await act(async () => {
      pressKey("Enter", document.body);
      pressKey("Enter", document.body);
    });
    expect(pick).toHaveBeenCalledTimes(1);
    picked.open(["E:\\Moved\\TAKE-1.mp4"]);
    await settle();
    expect(dialog("locate file")).toBeNull();
    expect(state().project!.sources[0]!.path).toBe("E:\\Moved\\TAKE-1.mp4");
  });

  it("Esc closes the prompt for this session", async () => {
    await start();
    rig.core.setErrors({ missingSources: [rig.core.demo.sourceId] });
    await openDemoFromHome();
    await key("Escape");
    expect(dialog("locate file")).toBeNull();
    expect(selectKeyScope(state())).toBe("transcript");
  });
});

describe("Home", () => {
  it("lists the projects most recent first and opens the selected one with Enter", async () => {
    await start();
    expect(state().project).toBeNull();
    await openDemoFromHome();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "roughcut" }));
      await rig.store.idle();
    });
    expect(heading()).toBe("Roughcut");
    await key("Enter");
    expect(heading()).toBe("Weekly update - Nov 13");
  });
});
