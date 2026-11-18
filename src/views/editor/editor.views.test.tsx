/**
 * The Editor frame with the real Transcript and Timeline views and the real player (spec 3.7,
 * "state and views": a change in one view appears in the other). These catch what the frame
 * and the views draw twice when combined, which the stand-in views of editor.test.tsx cannot.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoughcutProvider, selectClips, selectSequenceDuration } from "../../state";
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

async function settle(): Promise<void> {
  await act(async () => {
    await rig.store.idle();
  });
}

async function openDemoInEditor() {
  rig = createTestRig({ stepMs: 20 });
  await rig.store.init();
  await rig.store.dispatch("ui.openProject", { projectId: rig.core.demo.projectId });
  await rig.store.idle();
  const view = render(
    <RoughcutProvider store={rig.store}>
      <EditorScreen />
    </RoughcutProvider>,
  );
  await settle();
  return view;
}

describe("EditorScreen with the real views", () => {
  it("a cut made in the Transcript view shows in the Timeline view, with one caption and one cut counter", async () => {
    const { container } = await openDemoInEditor();
    expect(container.querySelector("section[data-view='transcript']")).toBeTruthy();
    expect(container.querySelector("section[data-view='timeline']")).toBeNull();
    const clipsBefore = selectClips(state()).length;
    const keptBefore = selectSequenceDuration(state());

    // Cut a run of words in the middle of the transcript, from the Transcript view.
    await act(async () => {
      await rig.store.dispatch("ui.selectTokens", { anchorToken: 20, focusToken: 40 });
      await rig.store.dispatch("transcript.cut");
      await rig.store.idle();
    });
    const clipsAfter = selectClips(state()).length;
    expect(clipsAfter).toBe(clipsBefore + 1);
    expect(selectSequenceDuration(state())).toBeLessThan(keptBefore);

    await act(async () => {
      await rig.store.dispatch("ui.setView", { view: "timeline" });
      await rig.store.dispatch("ui.seek", { time: 0 });
      await rig.store.idle();
    });
    expect(container.querySelector("section[data-view='timeline']")).toBeTruthy();
    expect(container.querySelector("section[data-view='transcript']")).toBeNull();
    // The timeline's track shows the clip the transcript cut made.
    expect(screen.getByRole("img", { name: `Timeline track, ${clipsAfter} clips` })).toBeTruthy();

    // One caption and one counter: both are TimelineView's.
    expect(container.querySelectorAll(".rc-ed__caption, .tlv-caption")).toHaveLength(1);
    const counters = screen.queryAllByText(/^(cut \d+ of \d+|\d+ cuts?|no cuts( yet)?)$/);
    expect(counters).toHaveLength(1);
    // Before the first cut it is never "cut 0 of N", anywhere on the screen.
    expect(container.textContent ?? "").not.toMatch(/cut 0 of/);
    expect(screen.getByTestId("editor-notes").textContent ?? "").not.toMatch(/\bcuts?\b/);
  });

  it("the frame shows no notice itself in either view (the overlays' Notices does)", async () => {
    await openDemoInEditor();
    await act(async () => {
      rig.store.setState({ notices: [{ id: "n1", kind: "warning", text: "Claude is not signed in" }] });
    });
    expect(screen.queryByText("Claude is not signed in")).toBeNull();
    await act(async () => {
      await rig.store.dispatch("ui.setView", { view: "timeline" });
      await rig.store.idle();
    });
    expect(screen.queryByText("Claude is not signed in")).toBeNull();
  });
});
