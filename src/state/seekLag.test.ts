/**
 * Found driving the real app: the real player finishes a seek a little after it is asked for
 * and reports the frames of earlier seeks on the way. Three quick → then O marked the word
 * the caret had already left, because a late frame moved the playhead back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SequenceTime } from "../types";
import { createStandinCore } from "./core";
import { createRoughcutStore, type RoughcutStore } from "./store";
import { FakePlayer, pressKey } from "./testing";
import { attachStoreKeys } from "./wiring";

/** A player whose seeks land only when `land()` is called, reporting every earlier target on the way. */
class LaggingPlayer extends FakePlayer {
  private queue: { t: SequenceTime; resolve: () => void; landed: boolean }[] = [];
  override seek(t: SequenceTime): Promise<void> {
    return new Promise((resolve) => this.queue.push({ t, resolve, landed: false }));
  }
  /**
   * The first `n` seeks (all by default) land in the order asked, each reporting its frame as
   * FakePlayer.seek does. A seek's promise resolves only once the latest seek has landed, as
   * the real player's does.
   */
  async land(n = this.queue.length): Promise<void> {
    for (const s of this.queue.slice(0, n)) {
      if (s.landed) continue;
      s.landed = true;
      await super.seek(s.t);
    }
    if (n >= this.queue.length) {
      const q = this.queue;
      this.queue = [];
      for (const s of q) s.resolve();
    }
  }
  get waiting(): number {
    return this.queue.length;
  }
}

let store: RoughcutStore;
let player: LaggingPlayer;
let core: ReturnType<typeof createStandinCore>;
let detach: () => void;

beforeEach(async () => {
  vi.useFakeTimers();
  core = createStandinCore({ stepMs: 100 });
  player = new LaggingPlayer();
  store = createRoughcutStore({ core, player });
  detach = attachStoreKeys(store, window);
  await store.init();
  pressKey("Enter"); // open the demo project
  await store.idle();
  await player.land();
  await store.idle();
});

afterEach(() => {
  detach();
  store.dispose();
  core.dispose();
  vi.useRealTimers();
});

async function press(...chords: string[]): Promise<void> {
  for (const c of chords) {
    pressKey(c);
    await store.idle();
  }
}

describe("a seek the player finishes late", () => {
  it("does not move the playhead back to an earlier caret position, so O marks where the caret is", async () => {
    const s = () => store.getState();
    expect(s().screen).toBe("editor");
    await press("ArrowRight", "ArrowRight", "ArrowRight");
    expect(player.waiting).toBe(3);
    const caret = s().selection.focus;
    const want = s().layout!.tokens[caret]!.token.start;
    expect(s().playhead.position!.at).toBe(want);

    // The first two seeks land while the third is still on its way, reporting older frames.
    await player.land(2);
    await store.idle();
    expect(s().playhead.position!.at).toBe(want);
    await press("I");
    await player.land();
    await store.idle();

    await press("ArrowRight", "ArrowRight");
    await player.land(1);
    await store.idle();
    await press("O");
    const outWant = s().layout!.tokens[s().selection.focus]!.token.start;
    await player.land();
    await store.idle();
    const marks = s().marks;
    expect(marks.in).toEqual({ sourceId: s().layout!.tokens[caret]!.address.sourceId, at: want });
    expect(marks.out).toEqual({ sourceId: s().layout!.tokens[caret]!.address.sourceId, at: outWant });
    expect(s().playhead.position!.at).toBe(outWant);
  });

  it("Shift+→ then S at once splits where the step lands, not where the playhead was (Timeline view)", async () => {
    const s = () => store.getState();
    await press("Tab");
    expect(s().session.view).toBe("timeline");
    // Steps land late in the real player; the store must already be where they go.
    player.step = () => new Promise<void>(() => undefined); // not on screen yet in this test
    const before = s().playhead.time;
    const count = s().edit!.current.clips.length;
    await press("Shift+ArrowRight", "Shift+ArrowRight", "S");
    expect(s().playhead.time).toBe(before + 2_000_000);
    const clips = s().edit!.current.clips;
    expect(clips.length).toBe(count + 1);
    const boundaries: number[] = [];
    let t = 0;
    for (const c of clips) boundaries.push((t += c.end - c.start));
    // The split lands on the frame nearest the playhead.
    expect(boundaries.some((b) => Math.abs(b - (before + 2_000_000)) < 34_000)).toBe(true);
  });

  it("a seek from the timeline still takes the frame the player landed on", async () => {
    const s = () => store.getState();
    await store.dispatch("ui.seek", { time: 1_234_567 });
    await player.land();
    await store.idle();
    expect(s().playhead.time).toBe(player.frame.time);
  });
});
