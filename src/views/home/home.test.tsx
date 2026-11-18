/**
 * The Home screen (spec 1.7 A) on the stand-in core: rows, preselection, missing files, the
 * empty state, the shortcut bar, and starting a project by picking or dropping files.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { attachStoreKeys, RoughcutProvider } from "../../state";
import { createTestRig, pressKey, type TestRig } from "../../state/testing";
import type { ProjectSummary } from "../../types";
import { droppedPaths, pathFromFileUri } from "./drop";
import { formatDuration, formatWhen, missingNote, rowLengths, rowStat } from "./format";
import { HomeScreen } from "./index";

const MIN = 60_000_000;

function summary(over: Partial<ProjectSummary> & { id: string }): ProjectSummary {
  return {
    name: over.id,
    rawDuration: 64 * MIN + 30_000_000,
    keptDuration: 41 * MIN + 12_000_000,
    updatedAt: "2026-11-13T10:00:00Z",
    missingSources: 0,
    ...over,
  };
}

describe("row text", () => {
  it("writes lengths as the mockup does", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(7_999_999)).toBe("0:07");
    expect(formatDuration(41 * MIN + 12_000_000)).toBe("41:12");
    expect(formatDuration(64 * MIN + 30_000_000)).toBe("1:04:30");
    expect(formatDuration(-5)).toBe("0:00");
    expect(rowLengths(summary({ id: "a" }))).toBe("41:12 kept of 1:04:30");
  });

  it("says when, relative to now", () => {
    const now = new Date(2026, 10, 13, 14, 0, 0);
    const at = (d: Date) => d.toISOString();
    expect(formatWhen(at(new Date(2026, 10, 13, 13, 59, 30)), now)).toBe("just now");
    expect(formatWhen(at(new Date(2026, 10, 13, 13, 35)), now)).toBe("25 min ago");
    expect(formatWhen(at(new Date(2026, 10, 13, 12, 0)), now)).toBe("2 h ago");
    expect(formatWhen(at(new Date(2026, 10, 12, 9, 0)), now)).toBe("yesterday");
    expect(formatWhen(at(new Date(2026, 10, 6, 9, 0)), now)).toBe("nov 6");
    expect(formatWhen(at(new Date(2025, 9, 30, 9, 0)), now)).toBe("oct 30 2025");
    expect(formatWhen("not a date", now)).toBeNull();
    // Late last night, a few hours ago: hours.
    const morning = new Date(2026, 10, 13, 2, 0);
    expect(formatWhen(at(new Date(2026, 10, 12, 23, 0)), morning)).toBe("3 h ago");
  });

  it("shows the export when it is the latest thing done, otherwise the edit", () => {
    const now = new Date(2026, 10, 13, 14, 0);
    const exportedNov6 = new Date(2026, 10, 6, 9, 0).toISOString();
    const savedJustAfter = new Date(2026, 10, 6, 9, 2).toISOString();
    expect(rowStat(summary({ id: "a", updatedAt: savedJustAfter, lastExportedAt: exportedNov6 }), now)).toBe("exported nov 6");
    const editedToday = new Date(2026, 10, 13, 12, 0).toISOString();
    expect(rowStat(summary({ id: "b", updatedAt: editedToday, lastExportedAt: exportedNov6 }), now)).toBe("edited 2 h ago");
    expect(rowStat(summary({ id: "c", updatedAt: editedToday }), now)).toBe("edited 2 h ago");
  });

  it("notes missing files", () => {
    expect(missingNote(summary({ id: "a" }))).toBeNull();
    expect(missingNote(summary({ id: "a", missingSources: 1 }))).toBe("1 file missing");
    expect(missingNote(summary({ id: "a", missingSources: 3 }))).toBe("3 files missing");
  });
});

describe("dropped paths", () => {
  it("turns file URIs into Windows paths", () => {
    expect(pathFromFileUri("file:///C:/Footage/TAKE%201.mp4")).toBe("C:\\Footage\\TAKE 1.mp4");
    expect(pathFromFileUri("file://nas/share/a.mov")).toBe("\\\\nas\\share\\a.mov");
    expect(pathFromFileUri("https://example.com/a.mp4")).toBeNull();
    expect(pathFromFileUri("not a uri")).toBeNull();
  });

  it("reads file paths first, then the URI list, without repeats", () => {
    const uriOnly = { files: [], getData: (f: string) => (f === "text/uri-list" ? "# comment\r\nfile:///D:/a.mp4\r\nfile:///D:/a.mp4\r\nfile:///D:/b.mkv" : "") };
    expect(droppedPaths(uriOnly)).toEqual(["D:\\a.mp4", "D:\\b.mkv"]);
    const withPaths = { files: [{ path: "E:\\x.mp4" }, { name: "no-path.mp4" }], getData: () => "file:///D:/ignored.mp4" };
    expect(droppedPaths(withPaths)).toEqual(["E:\\x.mp4"]);
    expect(droppedPaths(null)).toEqual([]);
    expect(droppedPaths({ files: [], getData: () => "" })).toEqual([]);
  });
});

describe("HomeScreen", () => {
  let rig: TestRig | null = null;
  let detach: (() => void) | null = null;

  afterEach(() => {
    cleanup();
    detach?.();
    detach = null;
    rig?.store.dispose();
    rig?.core.dispose();
    rig = null;
  });

  async function mount(coreOptions: Parameters<typeof createTestRig>[0] = {}) {
    rig = createTestRig({ stepMs: 5, ...coreOptions });
    await rig.store.init();
    render(
      <RoughcutProvider store={rig.store}>
        <HomeScreen />
      </RoughcutProvider>,
    );
    return rig;
  }

  const rows = () => within(screen.getByRole("listbox", { name: "Recent projects" })).getAllByRole("option");

  it("lists recent projects with kept and raw length, the most recent preselected", async () => {
    const { store } = await mount();
    const now = Date.now();
    act(() => {
      store.setState({
        projects: [
          summary({ id: "p1", name: "weekly update · nov 13", updatedAt: new Date(now - 2 * 3_600_000 - 5 * 60_000).toISOString() }),
          summary({
            id: "p2",
            name: "weekly update · nov 6",
            rawDuration: 58 * MIN + 10_000_000,
            keptDuration: 37 * MIN + 45_000_000,
            updatedAt: new Date(now - 30 * 86_400_000).toISOString(),
            lastExportedAt: new Date(now - 30 * 86_400_000).toISOString(),
          }),
        ],
        homeSelection: 0,
      });
    });
    const [first, second] = rows();
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first!.getAttribute("aria-selected")).toBe("true");
    expect(second!.getAttribute("aria-selected")).toBe("false");
    expect(first!.textContent).toContain("weekly update · nov 13");
    expect(first!.textContent).toContain("41:12 kept of 1:04:30");
    expect(first!.textContent).toContain("edited 2 h ago");
    expect(second!.textContent).toContain("37:45 kept of 58:10");
    expect(second!.textContent).toMatch(/exported [a-z]{3} \d+/);
    expect(screen.getByText("recent")).toBeTruthy();
  });

  it("shows the stand-in's project from the core, preselected", async () => {
    await mount();
    const [first] = rows();
    expect(first!.textContent).toContain("Weekly update - Nov 13");
    expect(first!.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Roughcut" })).toBeTruthy();
  });

  it("marks a project whose source files are missing", async () => {
    const { store } = await mount();
    act(() => store.setState({ projects: [summary({ id: "p1", missingSources: 2 }), summary({ id: "p2" })] }));
    const [first, second] = rows();
    expect(first!.textContent).toContain("2 files missing");
    expect(first!.getAttribute("data-missing")).toBe("true");
    expect(second!.textContent).not.toContain("missing");
  });

  it("shows an empty state with no projects", async () => {
    await mount({ seedDemo: false });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByText("no projects yet")).toBeTruthy();
    expect(screen.getByText(/press ctrl n to pick one/)).toBeTruthy();
    // Under the same "recent" heading as the list, where the first project will appear.
    expect(screen.getByText("no projects yet").closest(".rc-recent")?.querySelector(".rc-rhead")?.textContent).toBe("recent");
    expect(screen.getByRole("button", { name: "pick footage" })).toBeTruthy();
  });

  it("shows the bottom shortcut bar from the keymap", async () => {
    await mount();
    const bar = screen.getByRole("list", { name: "Shortcuts" });
    const text = bar.textContent ?? "";
    expect(text).toContain("enter");
    expect(text).toContain("open");
    expect(text).toContain("ctrl n");
    expect(text).toContain("new project");
    expect(text).toContain("all shortcuts");
  });

  it("selects on click and opens on double-click, through actions", async () => {
    const { store, core } = await mount();
    act(() => store.setState({ projects: [summary({ id: "x" }), ...store.getState().projects] }));
    const second = rows()[1]!;
    fireEvent.click(second);
    expect(store.getState().homeSelection).toBe(1);
    expect(rows()[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.doubleClick(second);
    await store.idle();
    expect(store.getState().screen).toBe("editor");
    expect(store.getState().project?.id).toBe(core.demo.projectId);
  });

  it("moves the selection with the keys and opens with Enter", async () => {
    const { store, core } = await mount();
    detach = attachStoreKeys(store, window);
    act(() => store.setState({ projects: [summary({ id: "x" }), ...store.getState().projects] }));
    act(() => {
      pressKey("ArrowDown");
    });
    expect(rows()[1]!.getAttribute("aria-selected")).toBe("true");
    act(() => {
      pressKey("Enter");
    });
    await act(() => store.idle());
    expect(store.getState().project?.id).toBe(core.demo.projectId);
  });

  it("starts a new project from pick footage", async () => {
    const { store } = await mount({ pickedFiles: ["D:\\Footage\\TAKE-9.mp4"] });
    const before = store.getState().projects.length;
    fireEvent.click(screen.getByRole("button", { name: "pick footage" }));
    await act(() => store.idle());
    const s = store.getState();
    expect(s.screen).toBe("editor");
    expect(s.project?.sources.map((r) => r.path)).toEqual(["D:\\Footage\\TAKE-9.mp4"]);
    expect(s.projects.length).toBe(before + 1);
  });

  it("shows the busy label and disables picking while importing", async () => {
    const { store } = await mount();
    act(() => store.setState({ busy: "Importing footage" }));
    expect(screen.getByRole("status").textContent).toBe("importing footage…");
    expect((screen.getByRole("button", { name: "pick footage" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("highlights the drop zone while files are dragged over the window", async () => {
    await mount();
    const zone = screen.getByLabelText("Drop footage here to start a new project");
    expect(zone.getAttribute("data-active")).toBeNull();
    fireEvent.dragEnter(window, { dataTransfer: { types: ["Files"] } });
    expect(zone.getAttribute("data-active")).toBe("true");
    fireEvent.dragLeave(window, { dataTransfer: { types: ["Files"] } });
    expect(zone.getAttribute("data-active")).toBeNull();
  });

  it("starts a new project from files dropped on the window", async () => {
    const { store } = await mount();
    const dataTransfer = {
      types: ["Files", "text/uri-list"],
      files: [],
      getData: (f: string) => (f === "text/uri-list" ? "file:///D:/Footage/TAKE-3.mp4" : ""),
    };
    fireEvent.dragEnter(window, { dataTransfer });
    fireEvent.drop(window, { dataTransfer });
    await act(() => store.idle());
    const s = store.getState();
    expect(s.screen).toBe("editor");
    expect(s.project?.sources.map((r) => r.path)).toEqual(["D:\\Footage\\TAKE-3.mp4"]);
  });
});
