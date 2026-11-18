/**
 * Review tests (track viewHome-review): while the store is busy importing or opening, the
 * Home screen disables "pick footage", but a window drop or a row double-click still dispatch
 * and start a second import / open on top of the first.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RoughcutProvider } from "../../state";
import { createTestRig, type TestRig } from "../../state/testing";
import { HomeScreen } from "./index";

describe("Home while busy (review)", () => {
  let rig: TestRig | null = null;
  afterEach(() => {
    cleanup();
    rig?.store.dispose();
    rig?.core.dispose();
    rig = null;
  });

  async function mount() {
    rig = createTestRig({ stepMs: 5 });
    await rig.store.init();
    render(
      <RoughcutProvider store={rig.store}>
        <HomeScreen />
      </RoughcutProvider>,
    );
    return rig;
  }

  it("does not start another project when files are dropped while importing", async () => {
    const { store, core } = await mount();
    const before = (await core.listProjects()).length;
    act(() => store.setState({ busy: "Importing footage" }));
    // "pick footage" is disabled here...
    expect((screen.getByRole("button", { name: "pick footage" }) as HTMLButtonElement).disabled).toBe(true);
    // ...but a drop on the window still creates a project.
    const dataTransfer = {
      types: ["Files", "text/uri-list"],
      files: [],
      getData: (f: string) => (f === "text/uri-list" ? "file:///D:/Footage/TAKE-4.mp4" : ""),
    };
    fireEvent.dragEnter(window, { dataTransfer });
    fireEvent.drop(window, { dataTransfer });
    await act(() => store.idle());
    expect((await core.listProjects()).length).toBe(before);
  });

  it("does not open a project on double-click while another is opening", async () => {
    const { store } = await mount();
    act(() => store.setState({ busy: "Opening project" }));
    const row = within(screen.getByRole("listbox", { name: "Recent projects" })).getAllByRole("option")[0]!;
    fireEvent.doubleClick(row);
    await act(() => store.idle());
    expect(store.getState().screen).toBe("home");
  });
});
