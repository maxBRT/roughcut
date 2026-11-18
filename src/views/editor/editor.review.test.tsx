/**
 * Review tests (viewEditor-review): defects found in the Editor frame. The real Timeline view
 * and the real App are used where the defect is in how the frame combines with them.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { RoughcutProvider, selectCutPoints, selectSequenceDuration } from "../../state";
import { createTestRig, type TestRig } from "../../state/testing";
import { installRecordingCanvas } from "../timeline/testing";
import { EditorScreen } from "./index";

let rig: TestRig;
const state = () => rig.store.getState();
let canvasMock: ReturnType<typeof installRecordingCanvas>;

beforeEach(() => {
  canvasMock = installRecordingCanvas();
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in tests")));
});

afterEach(() => {
  cleanup();
  rig?.store.dispose();
  rig?.core.dispose();
  canvasMock.restore();
  vi.unstubAllGlobals();
});

/** Demo project, cut into three clips, in the Timeline view. */
async function openWithCuts(): Promise<void> {
  rig = createTestRig({ stepMs: 20 });
  await rig.store.init();
  await rig.store.dispatch("ui.openProject", { projectId: rig.core.demo.projectId });
  await rig.store.idle();
  const d = selectSequenceDuration(state());
  await rig.store.dispatch("ui.setView", { view: "timeline" });
  await rig.store.dispatch("ui.seek", { time: Math.round(d / 3) });
  await rig.store.dispatch("timeline.split");
  await rig.store.dispatch("ui.seek", { time: Math.round((2 * d) / 3) });
  await rig.store.dispatch("timeline.split");
  await rig.store.idle();
  expect(selectCutPoints(state()).length).toBeGreaterThan(0);
}

function showEditor() {
  return render(
    <RoughcutProvider store={rig.store}>
      <EditorScreen />
    </RoughcutProvider>,
  );
}

describe("review: Timeline view note line", () => {
  it("does not say 'cut 0 of N' when the playhead is before the first cut", async () => {
    await openWithCuts();
    await rig.store.dispatch("ui.seek", { time: 0 });
    await rig.store.idle();
    showEditor();
    const notes = screen.getByTestId("editor-notes").textContent ?? "";
    expect(notes).not.toMatch(/cut 0 of/);
  });
});

describe("review: the frame combined with the real Timeline view", () => {
  it("shows the caption once", async () => {
    await openWithCuts();
    await rig.store.dispatch("ui.seek", { time: Math.round(selectSequenceDuration(state()) / 6) });
    await rig.store.idle();
    const { container } = showEditor();
    await act(async () => {
      await rig.store.idle();
    });
    const captions = container.querySelectorAll(".rc-ed__caption, .tlv-caption");
    expect(captions.length).toBe(1);
  });

  it("shows the cut counter once", async () => {
    await openWithCuts();
    await rig.store.dispatch("ui.seek", { time: Math.round(selectSequenceDuration(state()) / 2) });
    await rig.store.idle();
    showEditor();
    const hits = screen.queryAllByText(/^cut \d+ of \d+$/);
    expect(hits.length).toBe(1);
  });
});

describe("review: notices in the running App", () => {
  it("each notice is shown once on the editor screen", async () => {
    rig = createTestRig({ stepMs: 20 });
    render(<App store={rig.store} />);
    await act(async () => {
      await rig.store.idle();
      await rig.store.dispatch("ui.openProject", { projectId: rig.core.demo.projectId });
      await rig.store.idle();
    });
    expect(state().screen).toBe("editor");
    await act(async () => {
      rig.store.setState({ notices: [{ id: "n1", kind: "warning", text: "Claude is not signed in" }] });
    });
    expect(screen.getAllByText("Claude is not signed in")).toHaveLength(1);
  });
});
