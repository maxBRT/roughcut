/**
 * Found in the real app (e2e "import"): right after an import the transcription is running but
 * has sent no text yet. The Transcript view said "no transcript · 0:00 – 2:07", as if the
 * footage would never get one, while the player panel said "transcribing · 0%".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectTranscribing } from "./selectors";
import { createTestRig, FakePlayer, type TestRig } from "./testing";
import { createStandinCore } from "./core";
import { createRoughcutStore } from "./store";
import type { JobStatus } from "../types";

let rig: TestRig;
const state = () => rig.store.getState();

async function run(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await rig.store.idle();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  rig?.store.dispose();
  rig?.core.dispose();
  vi.useRealTimers();
});

const NOT_YET = { code: "internal" as const, message: "no transcript yet" };

const untranscribed = () =>
  (state().layout?.blocks ?? []).filter((b) => b.kind === "untranscribed").map((b) => (b as { status: string }).status);

describe("a transcription that has started but sent no text yet", () => {
  it("shows the source's kept time as text on its way, not as having no transcript", async () => {
    rig = createTestRig({ stepMs: 100, transcriptBatches: 4 });
    await rig.store.init();
    // As with the real core, the store holds no transcript yet: the core's first assets event
    // says "none", so nothing is fetched before the first utterances arrive.
    rig.core.failNext("get_transcript", NOT_YET);
    await rig.store.dispatch("everywhere.newProject");
    await rig.store.idle();
    const id = state().project!.sources[0]!.id;

    await run(100); // the import's first step: the transcribe job runs, no text yet
    const job = Object.values(state().jobs).find((j) => j.kind === "transcribe" && j.sourceId === id);
    expect(job?.state).toBe("running");
    expect(state().sources[id]?.transcript ?? null).toBeNull();
    expect(untranscribed()).toEqual(["partial"]);

    // Text arrives, then the transcript completes: no stand-in block is left behind.
    for (let i = 0; i < 40 && !state().sources[id]?.transcript?.complete; i++) await run(100);
    expect(state().sources[id]?.transcript?.complete).toBe(true);
    expect(untranscribed()).not.toContain("partial");
  });

  it("shows no transcript once the transcription is no longer running", async () => {
    rig = createTestRig({ stepMs: 100, transcriptBatches: 4 });
    await rig.store.init();
    // As with the real core, the store holds no transcript yet: the core's first assets event
    // says "none", so nothing is fetched before the first utterances arrive.
    rig.core.failNext("get_transcript", NOT_YET);
    await rig.store.dispatch("everywhere.newProject");
    await rig.store.idle();
    const id = state().project!.sources[0]!.id;
    await run(100);
    const job = Object.values(state().jobs).find((j) => j.kind === "transcribe" && j.sourceId === id)!;
    expect(untranscribed()).toEqual(["partial"]);

    await rig.store.dispatch("ui.cancelJob", { jobId: job.id });
    await run(100);
    expect(state().jobs[job.id]?.state).toBe("cancelled");
    expect(state().sources[id]?.transcript ?? null).toBeNull();
    expect(untranscribed()).toEqual(["none"]);
  });
});

describe("a transcription that failed (found in the real app, e2e edge-speech)", () => {
  it("is not shown as 'transcribing' once no transcription is running", async () => {
    // With the transcriber missing, the player panel kept saying "transcribing · 0%" and the
    // hint bar kept the transcribing hints, although the job had failed.
    rig = createTestRig({ stepMs: 100, transcriptBatches: 4 });
    await rig.store.init();
    rig.core.failNext("get_transcript", NOT_YET);
    await rig.store.dispatch("everywhere.newProject");
    await rig.store.idle();
    const id = state().project!.sources[0]!.id;
    await run(100);
    expect(selectTranscribing(state())).not.toBeNull();
    const job = Object.values(state().jobs).find((j) => j.kind === "transcribe" && j.sourceId === id)!;
    await rig.store.dispatch("ui.cancelJob", { jobId: job.id });
    await run(100);
    expect(state().sources[id]?.assets?.transcript).not.toBe("complete");
    expect(selectTranscribing(state())).toBeNull();
  });

  it("gets its notice even when it failed before the new project was in the store", async () => {
    // The transcriber missing fails within milliseconds, while create_project is still
    // returning: the job's failure event came before the project, so no notice was shown.
    const core = createStandinCore({ stepMs: 100, transcriptBatches: 4 });
    const handlers: ((j: JobStatus) => void)[] = [];
    const wrapped: typeof core = Object.assign(Object.create(core) as typeof core, {
      onJobUpdated(h: (j: JobStatus) => void) {
        handlers.push(h);
        return core.onJobUpdated(h);
      },
      async createProject(paths: string[]) {
        const p = await core.createProject(paths);
        const failed: JobStatus = {
          id: "early-failure",
          kind: "transcribe",
          state: "failed",
          progress: 0,
          sourceId: p.sources[0]!.id,
          projectId: p.id,
          error: { code: "transcriber_failed", message: "The transcriber is not installed, so no transcript can be made." },
        };
        for (const h of handlers) h(failed);
        return p;
      },
    });
    const player = new FakePlayer();
    const store = createRoughcutStore({ core: wrapped, player });
    rig = { store, core, player };
    await store.init();
    await store.dispatch("everywhere.newProject");
    await store.idle();
    const texts = store.getState().notices.map((n) => n.text);
    expect(texts.some((t) => /Transcription failed .*not installed/.test(t))).toBe(true);
  });
});

describe("the transcribing progress line", () => {
  it("never shows less than the share of the source that already has text", async () => {
    // Seen in the real app: the transcriber reports progress once a second, so text up to
    // 0:16 of 2:07 was on screen while the line still said "transcribing · 0%".
    rig = createTestRig({ stepMs: 100, transcriptBatches: 4 });
    await rig.store.init();
    await rig.store.dispatch("everywhere.newProject");
    await rig.store.idle();
    const id = state().project!.sources[0]!.id;
    for (let i = 0; i < 20 && (state().sources[id]?.transcript?.utterances.length ?? 0) === 0; i++) await run(100);
    const s = state();
    const utterances = s.sources[id]!.transcript!.utterances;
    expect(utterances.length).toBeGreaterThan(0);
    const share = utterances[utterances.length - 1]!.end / s.project!.sources[0]!.media.duration;
    expect(share).toBeGreaterThan(0.05);
    // The job has not reported any progress yet.
    const jobs = Object.fromEntries(
      Object.entries(s.jobs).map(([k, j]) => [k, j.kind === "transcribe" ? { ...j, state: "running" as const, progress: 0 } : j]),
    );
    const line = selectTranscribing({ ...s, jobs });
    expect(line).not.toBeNull();
    expect(line!.progress).toBeCloseTo(share, 5);
  });
});

/**
 * Found in the real app (e2e "edge-speech", the transcriber failing mid-way): the core dropped
 * the partial transcript and said `transcript: "none"`, but the store kept the four utterances
 * it had been sent, so the Transcript view showed half a transcript for a failed transcription.
 */
describe("a transcription that fails after sending some text", () => {
  it("drops the text shown so far and shows the source as untranscribed", async () => {
    rig = createTestRig({ stepMs: 100, transcriptBatches: 4, errors: { transcriberCrashAfter: 2 } });
    await rig.store.init();
    await rig.store.dispatch("everywhere.newProject");
    await rig.store.idle();
    const id = state().project!.sources[0]!.id;

    await run(300); // two batches of text have arrived
    expect(state().sources[id]?.transcript?.utterances.length ?? 0).toBeGreaterThan(0);

    for (let i = 0; i < 20; i++) {
      const job = Object.values(state().jobs).find((j) => j.kind === "transcribe" && j.sourceId === id);
      if (job?.state === "failed") break;
      await run(100);
    }
    const job = Object.values(state().jobs).find((j) => j.kind === "transcribe" && j.sourceId === id);
    expect(job?.state).toBe("failed");
    expect(state().sources[id]?.assets?.transcript).toBe("none");
    expect(state().sources[id]?.transcript ?? null).toBeNull();
    expect((state().layout?.tokens ?? []).filter((t) => t.token.kind === "word")).toEqual([]);
    expect(untranscribed()).not.toContain("arriving");
    expect(state().notices.some((n) => /Transcription failed/.test(n.text))).toBe(true);

    // Nothing brings the dropped text back later (a late fetch, the rest of the import).
    await run(2000);
    expect(state().sources[id]?.transcript ?? null).toBeNull();
  });
});
