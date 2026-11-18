/**
 * Self-update: the store asks the core once at start whether a newer release exists, offers
 * it in a one-line notice, and its button saves the project before the installer runs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestRig, type TestRig } from "./testing";

let rig: TestRig;

afterEach(() => {
  rig?.store.dispose();
  rig?.core.dispose();
  vi.useRealTimers();
});

const updateNotice = () => rig.store.getState().notices.find((n) => n.id === "update");

describe("update notice", () => {
  it("is not shown when the core has no updater (the stand-in, a development build)", async () => {
    rig = createTestRig({ stepMs: 100, transcriptBatches: 2 });
    await rig.store.init();
    await rig.store.idle();
    expect(updateNotice()).toBeUndefined();
  });

  it("is not shown when this is the newest version, or when the check fails", async () => {
    rig = createTestRig({ stepMs: 100, transcriptBatches: 2 });
    rig.core.checkForUpdate = () => Promise.resolve(null);
    await rig.store.init();
    await rig.store.idle();
    expect(updateNotice()).toBeUndefined();
    rig.store.dispose();
    rig.core.dispose();

    rig = createTestRig({ stepMs: 100, transcriptBatches: 2 });
    rig.core.checkForUpdate = () => Promise.reject(new Error("offline"));
    await rig.store.init();
    await rig.store.idle();
    expect(updateNotice()).toBeUndefined();
    expect(rig.store.getState().ready).toBe(true);
  });

  it("offers a newer version, and the button saves the project and then installs", async () => {
    vi.useFakeTimers();
    rig = createTestRig({ stepMs: 100, transcriptBatches: 2 });
    rig.core.checkForUpdate = () => Promise.resolve({ version: "9.9.9", notes: null });
    const order: string[] = [];
    const saveEdit = rig.core.saveEdit.bind(rig.core);
    rig.core.saveEdit = async (...args) => {
      await saveEdit(...args);
      order.push("saved");
    };
    rig.core.installUpdate = () => {
      order.push("installed");
      return Promise.resolve();
    };
    await rig.store.init();
    await rig.store.idle();

    const notice = updateNotice();
    expect(notice?.text).toBe("Roughcut 9.9.9 is available.");
    expect(notice?.retry).toEqual({ label: "Update and restart", action: "ui.installUpdate" });

    // An edit not saved yet (the autosave would come two seconds later).
    await rig.store.dispatch("ui.openProject", { projectId: rig.core.demo.projectId });
    await rig.store.idle();
    await rig.store.dispatch("ui.seek", { time: 40_000_000 });
    expect(rig.store.getState().save.pending).toBe(true);

    await rig.store.dispatch("ui.installUpdate");
    expect(order).toEqual(["saved", "installed"]);
    expect(rig.store.getState().save.pending).toBe(false);
  });

  it("says why when the update cannot be installed, and offers to try again", async () => {
    rig = createTestRig({ stepMs: 100, transcriptBatches: 2 });
    rig.core.checkForUpdate = () => Promise.resolve({ version: "9.9.9", notes: null });
    let attempts = 0;
    rig.core.installUpdate = () => {
      attempts++;
      return Promise.reject({ code: "internal", message: "the download stopped" });
    };
    await rig.store.init();
    await rig.store.idle();
    await rig.store.dispatch("ui.installUpdate");

    const notice = updateNotice();
    expect(notice?.kind).toBe("error");
    expect(notice?.text).toBe("Could not update: the download stopped");
    expect(notice?.retry).toEqual({ label: "Retry", action: "ui.installUpdate" });
    await rig.store.dispatch("ui.installUpdate");
    expect(attempts).toBe(2);
  });
});
