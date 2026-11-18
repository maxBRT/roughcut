/**
 * Review tests (track player-review): defects found in an independent review of the player.
 * Each test describes the expected behaviour; a failing one is a defect for the fixer.
 */
import { describe, expect, it } from "vitest";
import type { Clip, Rational } from "../types";
import { frameToMicros } from "../types";
import { Player } from "./Player";
import { FakeEnvironment } from "./testing";
import type { PlayerEvent, PlayerSource } from "./types";

const FPS = 30;
const R: Rational = { num: FPS, den: 1 };
const us = (frame: number) => frameToMicros(frame, R);
const URL_A = "http://127.0.0.1:9/media/A/proxy?token=t";
const URL_B = "http://127.0.0.1:9/media/B/proxy?token=t";
const BROKEN_A = "http://127.0.0.1:9/media/A/original?token=t"; // not in the library: errors
const BROKEN_B = "http://127.0.0.1:9/media/B/original?token=t";

const clip = (id: string, sourceId: string, f0: number, f1: number): Clip => ({ id, sourceId, start: us(f0), end: us(f1) });

function sources(map: Record<string, string | null>): Record<string, PlayerSource> {
  const out: Record<string, PlayerSource> = {};
  for (const [id, url] of Object.entries(map)) out[id] = { url, duration: 120_000_000 };
  return out;
}

function setup() {
  const env = new FakeEnvironment(1000 / 60);
  env.library.set(URL_A, { fps: FPS, durationS: 120, seekMs: 8 });
  env.library.set(URL_B, { fps: FPS, durationS: 120, seekMs: 8 });
  const player = new Player({ environment: env });
  const events: PlayerEvent[] = [];
  player.subscribe((e) => events.push(e));
  return { env, player, events };
}

describe("review: media errors", () => {
  it("recovers when the proxy arrives after the original failed and play was pressed", async () => {
    // Spec 2.4.2: the original may not be playable; the player must become available when
    // the proxy is ready.
    const { env, player, events } = setup();
    const clips = [clip("a", "A", 300, 400)];
    player.load({ clips, sources: sources({ A: BROKEN_A }), frameRate: R });
    await env.clock.advance(100);
    expect(events.some((e) => e.type === "error" && e.error.code === "media_error")).toBe(true);
    // The user presses Space before the proxy is ready.
    void player.play();
    await env.clock.advance(200);
    // The proxy is ready: the core reports a new playbackUrl and state calls load again.
    player.load({ clips, sources: sources({ A: URL_A }), frameRate: R });
    await env.clock.advance(500);
    expect(env.top()?.src).toBe(URL_A);
  });

  it("a seek after a media error still lands (later seeks are not blocked)", async () => {
    const { env, player } = setup();
    const clips = [clip("a", "A", 300, 400), clip("b", "B", 100, 200)];
    player.load({ clips, sources: sources({ A: URL_A, B: BROKEN_B }), frameRate: R });
    await env.clock.advance(100);
    // Into the broken source twice, then back to source A.
    void player.seek(us(100) + us(10));
    await env.clock.advance(100);
    void player.seek(us(100) + us(20));
    await env.clock.advance(100);
    void player.seek(us(50));
    await env.clock.advance(300);
    expect(player.frame.position).toEqual({ sourceId: "A", at: us(350) });
    expect(env.top()?.shownFrame).toBe(350);
  });

  it("does not hang at a cut into a source whose element failed to load", async () => {
    const { env, player, events } = setup();
    const clips = [clip("a", "A", 300, 315), clip("b", "B", 100, 200)];
    player.load({ clips, sources: sources({ A: URL_A, B: BROKEN_B }), frameRate: R });
    await env.clock.advance(100);
    void player.play();
    await env.clock.advance(2000);
    // Playback must stop (and say so) rather than report playing forever.
    expect(events.some((e) => e.type === "error" && e.error.sourceId === "B")).toBe(true);
    expect(player.frame.playing).toBe(false);
  });
});

describe("review: edits while playing", () => {
  it("an edit that removes the moment under the playhead stops showing the removed frames", async () => {
    const { env, player } = setup();
    const clips = [clip("a", "A", 300, 600)];
    player.load({ clips, sources: sources({ A: URL_A }), frameRate: R });
    await env.clock.advance(200);
    void player.play();
    await env.clock.advance(1000); // around source frame 330
    const at = player.frame.position!.at;
    expect(at).toBeGreaterThan(us(320));
    expect(at).toBeLessThan(us(345));
    // Delete source frames 320..400 (the words under the playhead).
    player.load({ clips: [clip("a", "A", 300, 320), clip("a2", "A", 400, 600)], sources: sources({ A: URL_A }), frameRate: R });
    await env.clock.advance(300); // allow a seek to land
    env.recording = true;
    await env.clock.advance(1000);
    env.recording = false;
    const removed = env.screen.filter((s) => s.frame >= 320 && s.frame < 400);
    expect(removed).toEqual([]);
    // What is reported matches what is on screen.
    expect(player.frame.position!.at).toBe(us(env.top()!.shownFrame));
  });
});
