/**
 * Starting the app in a plain browser: the stand-in core is chosen, window.__roughcut is
 * published, and every address scenario puts the app in the state it names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectKeyScope } from "../state";
import { bootRoughcut, scenarioFromAddress, type RoughcutHandle } from "./boot";
import { SCENARIO_NAMES } from "./scenarios";

let handle: RoughcutHandle | null = null;

async function boot(search: string): Promise<RoughcutHandle> {
  window.history.replaceState(null, "", `/${search}`);
  handle = bootRoughcut(window);
  await vi.waitFor(() => expect(handle!.scenarioReady).toBe(true), { timeout: 5000, interval: 5 });
  return handle;
}

beforeEach(() => {
  if (!URL.createObjectURL) {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:test" });
  }
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  handle?.clock?.pause();
  handle?.store.dispose();
  handle?.standin?.dispose();
  handle = null;
  delete window.__roughcut;
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("bootRoughcut in a plain browser", () => {
  it("uses the stand-in core, says so in one place, and publishes the store", async () => {
    const h = await boot("");
    expect(h.core).toBe("standin");
    expect(document.documentElement.dataset.core).toBe("standin");
    expect(window.__roughcut).toBe(h);
    expect(h.getState().ready).toBe(true);
    expect(h.getState().projects.map((p) => p.name)).toEqual(["Weekly update - Nov 13"]);
    // The stand-in's jobs follow real time when no scenario is named.
    expect(h.clock!.running).toBe(true);
    await h.dispatch("ui.openProject", { projectId: h.standin!.demo.projectId });
    expect(h.getState().screen).toBe("editor");
    // Demo media: a waveform the timeline can read, a video address on the dev server.
    const assets = h.getState().sources[h.standin!.demo.sourceId]!.assets!;
    expect(assets.playbackUrl).toMatch(/^\/fixtures\/out\/speech-2min\.mp4\?/);
    expect(assets.waveformUrl).toMatch(/^blob:/);
  });

  it("reads the scenario from the address", () => {
    expect(scenarioFromAddress("?scenario=timeline&live=1")).toBe("timeline");
    expect(scenarioFromAddress("?scenario=")).toBeNull();
    expect(scenarioFromAddress("")).toBeNull();
  });

  it("an unknown scenario is reported, not hung on", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = await boot("?scenario=nope");
    expect(h.scenarioError).toMatch(/Unknown scenario "nope"/);
    expect(h.getState().notices.some((n) => n.id === "scenario")).toBe(true);
  });
});

describe("every scenario sets up the state it names", () => {
  const checks: Record<string, (h: RoughcutHandle) => void> = {
    home: (h) => {
      expect(h.getState().screen).toBe("home");
      expect(h.getState().projects.map((p) => p.name)).toEqual([
        "Weekly update - Nov 13",
        "Weekly update - Nov 6",
        "Weekly update - Oct 30",
      ]);
      expect(h.getState().homeSelection).toBe(0);
    },
    "home-empty": (h) => {
      expect(h.getState().screen).toBe("home");
      expect(h.getState().projects).toEqual([]);
    },
    transcribing: (h) => {
      const s = h.getState();
      expect(s.screen).toBe("editor");
      const t = s.sources[s.project!.sources[0]!.id]!.transcript!;
      expect(t.complete).toBe(false);
      expect(t.utterances.length).toBeGreaterThan(0);
    },
    transcript: (h) => {
      const s = h.getState();
      expect(s.session.view).toBe("transcript");
      expect(s.currentSuggestion).not.toBeNull();
      expect(s.edit!.current.clips.length).toBeGreaterThan(1);
    },
    find: (h) => {
      const s = h.getState();
      expect(s.find.open).toBe(true);
      expect(s.find.query).toBe("first thing");
      expect(s.find.matches.length).toBeGreaterThan(0);
      expect(s.find.matches.some((m) => m.hidden || s.layout!.tokens[m.from]?.keep === "cut")).toBe(true);
    },
    timeline: (h) => {
      const s = h.getState();
      expect(s.session.view).toBe("timeline");
      expect(s.edit!.current.clips.length).toBeGreaterThan(3);
      expect(s.playhead.time).toBeGreaterThan(0);
    },
    "export-confirm": (h) => {
      const d = h.getState().dialogs.export!;
      expect(d.phase).toBe("confirm");
      expect(d.plan).not.toBeNull();
      expect(d.plan!.blockedBy).toBeUndefined();
    },
    "export-running": (h) => {
      const d = h.getState().dialogs.export!;
      expect(d.phase).toBe("running");
      expect(d.progress).toBeGreaterThan(0.2);
      expect(d.progress).toBeLessThan(1);
    },
    "export-done": (h) => {
      const d = h.getState().dialogs.export!;
      expect(d.phase).toBe("done");
      expect(d.result!.path).toMatch(/\.mp4$/);
    },
    "export-disk-full": (h) => {
      const plan = h.getState().dialogs.export!.plan! as { blockedBy?: { code: string }; requiredBytes?: number };
      expect(plan.blockedBy!.code).toBe("disk_full");
      expect(plan.requiredBytes).toBeGreaterThan(0);
    },
    "export-nothing": (h) => {
      expect(h.getState().edit!.current.clips).toEqual([]);
      expect(h.getState().dialogs.export!.plan!.blockedBy!.code).toBe("nothing_to_export");
    },
    "export-missing": (h) => {
      expect(h.getState().dialogs.export!.plan!.blockedBy!.code).toBe("source_missing");
    },
    "export-failed": (h) => {
      const d = h.getState().dialogs.export!;
      expect(d.phase).toBe("confirm");
      expect(d.error!.code).toBe("export_failed");
    },
    "export-shortcuts": (h) => {
      expect(h.getState().dialogs.export!.phase).toBe("confirm");
      expect(h.getState().dialogs.shortcuts).toBe(true);
      expect(selectKeyScope(h.getState())).toBe("everywhere");
    },
    shortcuts: (h) => {
      expect(h.getState().dialogs.shortcuts).toBe(true);
      expect(h.getState().dialogs.export).toBeNull();
    },
    locate: (h) => {
      expect(h.getState().dialogs.locate!.name).toBe("TAKE-1.mp4");
    },
    notice: (h) => {
      const n = h.getState().notices.find((x) => x.id === "claude")!;
      expect(n.retry!.action).toBe("ui.retryClaude");
    },
    mixed: (h) => {
      expect(h.getState().project!.sources).toHaveLength(2);
      expect(h.getState().notices.some((n) => n.id === "mixed")).toBe(true);
    },
  };

  it("has a check for every scenario", () => {
    expect(Object.keys(checks).sort()).toEqual([...SCENARIO_NAMES].sort());
  });

  for (const name of SCENARIO_NAMES) {
    it(name, async () => {
      const h = await boot(`?scenario=${name}`);
      expect(h.scenarioError).toBeNull();
      expect(h.scenario).toBe(name);
      expect(h.clock!.running).toBe(false); // a scenario is a still
      checks[name]!(h);
    });
  }
});
