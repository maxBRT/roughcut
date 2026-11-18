/**
 * Player unit tests against stand-in video elements and a stand-in clock (spec 3.7, player
 * row): handover happens at the right frame, the position is kept when the proxy replaces the
 * original, and the cases listed for the module (short clips, quick cuts, mixed sources, a
 * seek during a handover, a missing address, the end, an empty sequence).
 */
import { describe, expect, it } from "vitest";
import type { Clip, Rational } from "../types";
import { frameToMicros } from "../types";
import { Player } from "./Player";
import type { FakeMedia, ScreenSample } from "./testing";
import { FakeEnvironment } from "./testing";
import type { PlayerEvent, PlayerFrame, PlayerSource } from "./types";

const FPS = 30;
const R: Rational = { num: FPS, den: 1 };
const us = (frame: number) => frameToMicros(frame, R);
const URL_A = "http://127.0.0.1:9/media/A/proxy?token=t";
const URL_B = "http://127.0.0.1:9/media/B/proxy?token=t";
const URL_A_ORIG = "http://127.0.0.1:9/media/A/original?token=t";

function c(id: string, sourceId: string, f0: number, f1: number): Clip {
  return { id, sourceId, start: us(f0), end: us(f1) };
}

interface Setup {
  env: FakeEnvironment;
  player: Player;
  events: PlayerEvent[];
  frames: PlayerFrame[];
}

function setup(opts: { refreshMs?: number; media?: Record<string, FakeMedia> } = {}): Setup {
  const env = new FakeEnvironment(opts.refreshMs ?? 1000 / 144);
  const media: Record<string, FakeMedia> = {
    [URL_A]: { fps: FPS, durationS: 120, seekMs: 8 },
    [URL_B]: { fps: FPS, durationS: 120, seekMs: 8 },
    [URL_A_ORIG]: { fps: FPS, durationS: 120, seekMs: 80, loadMs: 60 },
    ...opts.media,
  };
  for (const [k, v] of Object.entries(media)) env.library.set(k, v);
  const player = new Player({ environment: env });
  const events: PlayerEvent[] = [];
  const frames: PlayerFrame[] = [];
  player.subscribe((e) => {
    events.push(e);
    if (e.type === "frame") frames.push(e.frame);
  });
  return { env, player, events, frames };
}

function sources(map: Record<string, string | null>): Record<string, PlayerSource> {
  const out: Record<string, PlayerSource> = {};
  for (const [id, url] of Object.entries(map)) out[id] = { url, duration: 120_000_000 };
  return out;
}

/** Advances the stand-in clock until the player's promise settles. */
async function settle(s: Setup, p: Promise<unknown>): Promise<void> {
  let done = false;
  void p.finally(() => {
    done = true;
  });
  const ok = await s.env.clock.advanceUntil(() => done, 10_000, 2);
  if (!ok) throw new Error("player promise did not settle");
}

const sourceOfUrl = (url: string) => (url.includes("/media/A/") ? "A" : url.includes("/media/B/") ? "B" : "?");

interface Analysis {
  wrong: ScreenSample[];
  regressions: ScreenSample[];
  shown: Set<number>;
  /** Per cut: the sequence frames either side and how long the outgoing last frame stayed. */
  cuts: { index: number; firstIn: number | null; lastOutShownAt: number | null; extraMs: number | null; lastOutShown: boolean }[];
  firstShown: Map<number, number>;
}

/** Maps every screen sample to a sequence frame, in playing order. */
function analyse(samples: readonly ScreenSample[], clips: readonly Clip[], rate = 1): Analysis {
  const cum: number[] = [0];
  for (const cl of clips) cum.push(cum[cum.length - 1]! + Math.round(((cl.end - cl.start) * FPS) / 1e6));
  const wrong: ScreenSample[] = [];
  const regressions: ScreenSample[] = [];
  const shown = new Set<number>();
  const firstShown = new Map<number, number>();
  let last = -1;
  for (const s of samples) {
    if (!s.url || s.frame < 0) continue;
    const src = sourceOfUrl(s.url);
    const candidates: number[] = [];
    clips.forEach((cl, i) => {
      const f0 = Math.round((cl.start * FPS) / 1e6);
      const f1 = Math.round((cl.end * FPS) / 1e6);
      if (cl.sourceId === src && s.frame >= f0 && s.frame < f1) candidates.push(cum[i]! + s.frame - f0);
    });
    const next = candidates.filter((k) => k >= last).sort((a, b) => a - b)[0];
    if (next === undefined) {
      if (candidates.length) regressions.push(s);
      else wrong.push(s);
      continue;
    }
    last = next;
    shown.add(next);
    if (!firstShown.has(next)) firstShown.set(next, s.t);
  }
  const frameMs = 1000 / FPS / rate;
  const cuts = clips.slice(1).map((_, j) => {
    const i = j + 1;
    const lastOut = cum[i]! - 1;
    const firstIn = firstShown.get(cum[i]!) ?? null;
    const lastOutShownAt = firstShown.get(lastOut) ?? null;
    return {
      index: i,
      firstIn,
      lastOutShownAt,
      lastOutShown: lastOutShownAt !== null,
      extraMs: firstIn !== null && lastOutShownAt !== null ? firstIn - lastOutShownAt - frameMs : null,
    };
  });
  return { wrong, regressions, shown, cuts, firstShown };
}

/** 14 clips, 13 cuts: forward and backward jumps, clips of 1 to 45 frames. */
const SEQ = [
  c("c0", "A", 300, 330),
  c("c1", "A", 600, 645),
  c("c2", "A", 100, 103),
  c("c3", "A", 900, 904),
  c("c4", "A", 950, 951),
  c("c5", "A", 960, 990),
  c("c6", "A", 50, 56),
  c("c7", "A", 1200, 1215),
  c("c8", "A", 1300, 1302),
  c("c9", "A", 1310, 1312),
  c("c10", "A", 1320, 1323),
  c("c11", "A", 700, 740),
  c("c12", "A", 10, 15),
  c("c13", "A", 2000, 2030),
];

async function playThrough(s: Setup, clips: readonly Clip[], rate: 1 | 1.5 | 2) {
  s.player.load({ clips, sources: sources({ A: URL_A, B: URL_B }), frameRate: R });
  await s.env.clock.advance(200);
  s.player.setRate(rate);
  s.env.recording = true;
  s.events.length = 0;
  void s.player.play();
  const ended = await s.env.clock.advanceUntil(() => s.events.some((e) => e.type === "ended"), 60_000, 5);
  await s.env.clock.advance(100);
  s.env.recording = false;
  return { ended, a: analyse(s.env.screen, clips, rate) };
}

describe("handover at cuts", () => {
  for (const refresh of [1000 / 144, 1000 / 60]) {
    for (const rate of [1, 1.5, 2] as const) {
      it(`shows the right frame on each side of every cut (${Math.round(1000 / refresh)} Hz, ${rate}x)`, async () => {
        const s = setup({ refreshMs: refresh });
        const { ended, a } = await playThrough(s, SEQ, rate);
        expect(ended).toBe(true);
        expect(a.wrong).toEqual([]);
        expect(a.regressions).toEqual([]);
        const total = SEQ.reduce((n, cl) => n + Math.round(((cl.end - cl.start) * FPS) / 1e6), 0);
        const frameMs = 1000 / FPS / rate;
        for (const cut of a.cuts) {
          // The incoming clip starts on its first frame.
          expect(cut.firstIn, `cut ${cut.index}`).not.toBeNull();
          // The gap at the cut is under one frame either way.
          if (cut.extraMs !== null) {
            expect(Math.abs(cut.extraMs), `cut ${cut.index}`).toBeLessThan(frameMs);
          }
          // At 1x and 1.5x the outgoing clip's last frame is always shown.
          if (rate < 2) expect(cut.lastOutShown, `cut ${cut.index}`).toBe(true);
        }
        // No frame is lost at 1x and 1.5x (the very first one may have been on screen for
        // less than a refresh before recording began). At 2x on 60 Hz, where a frame lasts
        // one refresh, at most one frame per clip is skipped.
        const missing = [...Array(total).keys()].filter((k) => k > 0 && !a.shown.has(k)).length;
        if (rate < 2 || refresh < 10) expect(missing).toBe(0);
        else expect(missing).toBeLessThanOrEqual(SEQ.length);
        expect(s.player.frame.playing).toBe(false);
        expect(s.player.frame.time).toBe(s.player.duration - (us(2030) - us(2029)));
      });
    }
  }

  it("measures the display refresh at run time", async () => {
    const s = setup({ refreshMs: 1000 / 144 });
    await s.env.clock.advance(500);
    expect(s.player.refreshMs).toBeCloseTo(1000 / 144, 3);
    const t = setup({ refreshMs: 1000 / 60 });
    await t.env.clock.advance(500);
    expect(t.player.refreshMs).toBeCloseTo(1000 / 60, 3);
  });

  it("reports every displayed frame with sequence time and source position", async () => {
    const s = setup();
    const clips = [c("a", "A", 300, 310), c("b", "A", 100, 105)];
    await playThrough(s, clips, 1);
    const playingFrames = s.frames.filter((f) => f.playing);
    const times = playingFrames.map((f) => f.time);
    expect(times).toEqual([...times].sort((x, y) => x - y));
    const reported = new Set(playingFrames.map((f) => f.position!.at));
    for (let f = 300; f < 310; f++) expect(reported.has(us(f))).toBe(true);
    for (let f = 100; f < 105; f++) expect(reported.has(us(f))).toBe(true);
    const atCut = playingFrames.find((f) => f.position!.at === us(100))!;
    expect(atCut.time).toBe(us(310) - us(300));
    expect(atCut.position!.sourceId).toBe("A");
  });

  it("ramps the sound out and in over a few ms at each cut", async () => {
    const s = setup();
    const clips = [c("a", "A", 300, 310), c("b", "A", 100, 110)];
    await playThrough(s, clips, 1);
    const ramps = s.env.audio.calls.filter((x) => x.op === "ramp");
    // play: ramp in; cut: out 0 + in 1 at the same moment; end: ramp out.
    const cut = ramps.findIndex((r, i) => r.value === 0 && ramps[i + 1]?.value === 1 && ramps[i + 1]!.t === r.t);
    expect(cut).toBeGreaterThan(0);
    expect(ramps[cut]!.ms).toBe(5);
    expect(ramps[cut + 1]!.ms).toBe(5);
    expect(ramps[cut]!.index).not.toBe(ramps[cut + 1]!.index);
  });
});

describe("hard cases", () => {
  it("handles clips shorter than the pre-roll (slow seeks) without showing a wrong frame", async () => {
    const s = setup({ media: { [URL_A]: { fps: FPS, durationS: 120, seekMs: 70 } } });
    const clips = [c("a", "A", 300, 330), c("b", "A", 100, 102), c("c", "A", 900, 901), c("d", "A", 500, 520)];
    const { ended, a } = await playThrough(s, clips, 2);
    expect(ended).toBe(true);
    expect(a.wrong).toEqual([]);
    expect(a.regressions).toEqual([]);
    for (const cut of a.cuts) expect(cut.firstIn).not.toBeNull();
    // Waiting for a 70 ms seek inside a 1-frame clip is reported as buffering.
    expect(s.events.some((e) => e.type === "buffering")).toBe(false);
  });

  it("reports buffering when a handover waits longer than the threshold", async () => {
    const s = setup({ media: { [URL_A]: { fps: FPS, durationS: 120, seekMs: 400 } } });
    const clips = [c("a", "A", 300, 303), c("b", "A", 100, 110)];
    const { ended, a } = await playThrough(s, clips, 1);
    expect(ended).toBe(true);
    expect(a.wrong).toEqual([]);
    const end = s.events.findIndex((e) => e.type === "ended");
    const buf = s.events.slice(0, end).filter((e) => e.type === "buffering").map((e) => (e as { buffering: boolean }).buffering);
    // The first load's seek (400 ms) and the wait at the cut each report true then false.
    expect(buf).toEqual([true, false, true, false]);
  });

  it("crosses several cuts in quick succession", async () => {
    const s = setup();
    const clips = [c("a", "A", 300, 320), c("b", "A", 10, 11), c("c", "A", 20, 21), c("d", "A", 30, 32), c("e", "A", 40, 41), c("f", "A", 500, 520)];
    for (const rate of [1, 2] as const) {
      // Back to the start first: the previous run ended on the last frame.
      await settle(s, s.player.seek(0));
      s.env.screen.length = 0;
      s.events.length = 0;
      const { ended, a } = await playThrough(s, clips, rate);
      expect(ended).toBe(true);
      expect(a.wrong).toEqual([]);
      expect(a.regressions).toEqual([]);
      if (rate === 1) expect(a.shown.size).toBe(20 + 1 + 1 + 2 + 1 + 20);
    }
  });

  it("crosses cuts between neighbouring clips from different sources", async () => {
    const s = setup();
    const clips = [c("a", "A", 300, 320), c("b", "B", 300, 315), c("c", "B", 50, 53), c("d", "A", 700, 702), c("e", "A", 900, 930), c("f", "B", 10, 20)];
    const { ended, a } = await playThrough(s, clips, 1);
    expect(ended).toBe(true);
    expect(a.wrong).toEqual([]);
    expect(a.regressions).toEqual([]);
    expect(a.shown.size).toBe(20 + 15 + 3 + 2 + 30 + 10);
    // Each element switched address while waiting, never while on top.
    expect(s.env.videos.reduce((n, v) => n + v.srcChanges, 0)).toBeGreaterThanOrEqual(4);
  });

  it("a seek while the next clip is being prepared wins over the handover", async () => {
    const s = setup({ media: { [URL_A]: { fps: FPS, durationS: 120, seekMs: 120 } } });
    const clips = [c("a", "A", 300, 306), c("b", "A", 100, 160), c("c", "A", 900, 960)];
    s.player.load({ clips, sources: sources({ A: URL_A }), frameRate: R });
    await s.env.clock.advance(400);
    void s.player.play();
    await s.env.clock.advance(150); // near the end of clip a; clip b's prepare is in flight
    const target = us(6) + us(60) - us(0) + (us(920) - us(900)); // clip c, source frame 920
    s.env.recording = true;
    void s.player.seek(target);
    await s.env.clock.advanceUntil(() => s.player.frame.position?.at === us(920), 3000, 5);
    expect(s.player.frame.position).toEqual({ sourceId: "A", at: us(920) });
    await s.env.clock.advance(500);
    s.env.recording = false;
    // Still playing, from the seek target, and clip b was never shown after the seek.
    expect(s.player.frame.playing).toBe(true);
    const after = s.env.screen.filter((x) => x.frame >= 0);
    expect(after.some((x) => x.frame >= 100 && x.frame < 160)).toBe(false);
    expect(after[after.length - 1]!.frame).toBeGreaterThan(925);
  });

  it("an edit while a seek is on its way lands where that seek asked, moved onto the new clips", async () => {
    // Found in the real app: Ctrl+↓ (a seek), then Delete and Ctrl+Z before the slow seek had
    // landed. The player went back to the frame on screen before the seek, so the next Space
    // played from there while the store's playhead (and caret) said otherwise.
    const s = setup({ media: { [URL_A]: { fps: FPS, durationS: 120, seekMs: 150 } } });
    const one = [c("a", "A", 0, 900)];
    s.player.load({ clips: one, sources: sources({ A: URL_A }), frameRate: R });
    await s.env.clock.advance(400);
    expect(s.player.frame.position).toEqual({ sourceId: "A", at: 0 });
    // Seek to source frame 600, then (seek still on its way) cut frames 300 to 330.
    const seeking = s.player.seek(us(600));
    await s.env.clock.advance(20);
    s.player.load({ clips: [c("a", "A", 0, 300), c("b", "A", 330, 900)], sources: sources({ A: URL_A }), frameRate: R });
    await settle(s, seeking);
    await s.env.clock.advance(400);
    expect(s.player.frame.position).toEqual({ sourceId: "A", at: us(600) });
    expect(s.player.frame.time).toBe(us(300) + us(600) - us(330));
    // And with the asked-for moment itself cut: the same sequence time on the new clips.
    const again = s.player.seek(us(100));
    await s.env.clock.advance(20);
    s.player.load({ clips: [c("a", "A", 0, 90), c("b", "A", 330, 900)], sources: sources({ A: URL_A }), frameRate: R });
    await settle(s, again);
    await s.env.clock.advance(400);
    expect(s.player.frame.time).toBe(us(100));
    expect(s.player.frame.position).toEqual({ sourceId: "A", at: us(340) });
  });

  it("reports a source with no address and resumes once it has one", async () => {
    const s = setup();
    const clips = [c("a", "A", 300, 310), c("b", "B", 100, 130)];
    s.player.load({ clips, sources: sources({ A: URL_A, B: null }), frameRate: R });
    await s.env.clock.advance(100);
    void s.player.play();
    await s.env.clock.advance(1000);
    // Stopped at the cut on the last frame it could show, with an error naming the source.
    const err = s.events.find((e) => e.type === "error");
    expect(err).toEqual({ type: "error", error: expect.objectContaining({ code: "no_address", sourceId: "B" }) });
    expect(s.player.frame.playing).toBe(false);
    expect(s.player.frame.position).toEqual({ sourceId: "A", at: us(309) });
    // Seeking into the clip without an address blanks the picture.
    await settle(s, s.player.seek(us(310) - us(300) + us(5)));
    await s.env.clock.advance(50);
    expect(s.env.top()).toBeNull();
    expect(s.player.frame.position).toEqual({ sourceId: "B", at: us(105) });
    // The address arrives: the frame appears at the same position.
    s.player.load({ clips, sources: sources({ A: URL_A, B: URL_B }), frameRate: R });
    await s.env.clock.advance(200);
    expect(s.env.top()?.src).toBe(URL_B);
    expect(s.env.top()?.shownFrame).toBe(105);
    expect(s.player.frame.position).toEqual({ sourceId: "B", at: us(105) });
  });

  it("stops at the end of the sequence, reports ended, and plays again from the start", async () => {
    const s = setup();
    const clips = [c("a", "A", 300, 310)];
    const { ended } = await playThrough(s, clips, 1);
    expect(ended).toBe(true);
    expect(s.events.filter((e) => e.type === "ended")).toHaveLength(1);
    expect(s.player.frame).toMatchObject({ playing: false, position: { sourceId: "A", at: us(309) } });
    void s.player.play();
    await s.env.clock.advanceUntil(() => s.player.frame.playing, 1000, 5);
    await s.env.clock.advance(60);
    expect(s.player.frame.position!.at).toBeLessThan(us(305));
  });

  it("does nothing harmful with an empty sequence", async () => {
    const s = setup();
    s.player.load({ clips: [], sources: {}, frameRate: R });
    await s.env.clock.advance(50);
    expect(s.player.frame).toEqual({ time: 0, position: null, playing: false, speed: 0 });
    await settle(s, s.player.play());
    await settle(s, s.player.step({ frames: 1 }));
    await settle(s, s.player.shuttle("J"));
    await settle(s, s.player.previewCut(0));
    await s.env.clock.advance(200);
    expect(s.player.frame.playing).toBe(false);
    expect(s.player.duration).toBe(0);
    expect(s.env.top()).toBeNull();
    // Everything cut while playing: the player stops and blanks.
    s.player.load({ clips: [c("a", "A", 0, 30)], sources: sources({ A: URL_A }), frameRate: R });
    await s.env.clock.advance(100);
    void s.player.play();
    await s.env.clock.advance(200);
    s.player.load({ clips: [], sources: sources({ A: URL_A }), frameRate: R });
    await s.env.clock.advance(50);
    expect(s.player.frame).toEqual({ time: 0, position: null, playing: false, speed: 0 });
    expect(s.env.videos.every((v) => v.paused)).toBe(true);
  });
});

describe("original and proxy", () => {
  it("keeps the position when the proxy replaces the original while paused", async () => {
    const s = setup();
    const clips = [c("a", "A", 300, 400)];
    s.player.load({ clips, sources: sources({ A: URL_A_ORIG }), frameRate: R });
    await s.env.clock.advance(300);
    await settle(s, s.player.seek(us(337) - us(300)));
    await s.env.clock.advance(300);
    expect(s.env.top()?.src).toBe(URL_A_ORIG);
    expect(s.env.top()?.shownFrame).toBe(337);
    const before = s.player.frame;
    s.env.recording = true;
    s.player.load({ clips, sources: sources({ A: URL_A }), frameRate: R });
    await s.env.clock.advance(300);
    s.env.recording = false;
    expect(s.player.frame).toEqual(before);
    expect(s.env.top()?.src).toBe(URL_A);
    expect(s.env.top()?.shownFrame).toBe(337);
    // The picture never showed anything else meanwhile.
    expect(s.env.screen.every((x) => x.frame === 337)).toBe(true);
  });

  it("switches from the original to the proxy at the same moment while playing", async () => {
    const s = setup();
    const clips = [c("a", "A", 300, 600)];
    s.player.load({ clips, sources: sources({ A: URL_A_ORIG }), frameRate: R });
    await s.env.clock.advance(400);
    s.env.recording = true;
    void s.player.play();
    await s.env.clock.advance(1000);
    const seeksBefore = s.env.videos.map((v) => v.seekCount);
    s.player.load({ clips, sources: sources({ A: URL_A }), frameRate: R });
    await s.env.clock.advance(1500);
    s.env.recording = false;
    expect(s.player.frame.playing).toBe(true);
    expect(s.env.top()?.src).toBe(URL_A);
    // Continuous: every source frame shown once in order, none skipped, none repeated out of order.
    const a = analyse(s.env.screen, clips);
    expect(a.wrong).toEqual([]);
    expect(a.regressions).toEqual([]);
    const shownFrames = [...a.shown].sort((x, y) => x - y);
    for (let i = 1; i < shownFrames.length; i++) expect(shownFrames[i]! - shownFrames[i - 1]!).toBe(1);
    // The switch happened on the waiting element (one seek), not by re-seeking the playing one.
    const seeksAfter = s.env.videos.map((v) => v.seekCount);
    expect(seeksAfter[0]! - seeksBefore[0]! + (seeksAfter[1]! - seeksBefore[1]!)).toBe(1);
  });
});

describe("controls", () => {
  const clips = [c("a", "A", 300, 330), c("b", "B", 100, 103), c("c", "A", 900, 960)];
  async function ready() {
    const s = setup();
    s.player.load({ clips, sources: sources({ A: URL_A, B: URL_B }), frameRate: R });
    await s.env.clock.advance(200);
    return s;
  }

  it("steps by frames across cuts, both ways, showing the right frame each time", async () => {
    const s = await ready();
    await settle(s, s.player.seek(us(28) - us(0)));
    const expected = [328, 329, 100, 101, 102, 900, 901];
    for (const f of expected.slice(1)) {
      void s.player.step({ frames: 1 });
      await s.env.clock.advance(40);
      expect(s.player.frame.position!.at).toBe(us(f));
      expect(s.env.top()!.shownFrame).toBe(f);
    }
    for (const f of [...expected].reverse().slice(1)) {
      void s.player.step({ frames: -1 });
      await s.env.clock.advance(40);
      expect(s.player.frame.position!.at).toBe(us(f));
      expect(s.env.top()!.shownFrame).toBe(f);
    }
  });

  it("steps by seconds, clamped to the sequence", async () => {
    const s = await ready();
    void s.player.step({ seconds: 1 });
    await s.env.clock.advance(50);
    expect(s.player.frame.position).toEqual({ sourceId: "B", at: us(100) });
    void s.player.step({ seconds: 10 });
    await s.env.clock.advance(50);
    expect(s.player.frame.position).toEqual({ sourceId: "A", at: us(959) });
    void s.player.step({ seconds: -100 });
    await s.env.clock.advance(50);
    expect(s.player.frame.time).toBe(0);
  });

  it("scrubs with one seek in flight, always to the latest position", async () => {
    const s = setup({ media: { [URL_A]: { fps: FPS, durationS: 120, seekMs: 60 } } });
    const long = [c("a", "A", 0, 3000)];
    s.player.load({ clips: long, sources: sources({ A: URL_A }), frameRate: R });
    await s.env.clock.advance(200);
    const seeks0 = s.env.videos.reduce((n, v) => n + v.seekCount, 0);
    let last = 0;
    for (let i = 1; i <= 60; i++) {
      last = us(i * 20);
      void s.player.seek(last);
      await s.env.clock.advance(1000 / 144);
    }
    await s.env.clock.advance(300);
    const seeks = s.env.videos.reduce((n, v) => n + v.seekCount, 0) - seeks0;
    expect(s.player.frame.time).toBe(last);
    expect(s.env.top()!.shownFrame).toBe(1200);
    // About 420 ms of drag with 60 ms seeks: one at a time, not 60.
    expect(seeks).toBeLessThanOrEqual(12);
  });

  it("sets the rate on both elements with pitch preserved", async () => {
    const s = await ready();
    void s.player.play();
    await s.env.clock.advance(100);
    s.player.setRate(1.5);
    expect(s.player.frame.speed).toBe(1.5);
    expect(s.env.videos.every((v) => v.playbackRate === 1.5 && v.preservesPitch)).toBe(true);
    s.player.setRate(2);
    expect(s.player.rate).toBe(2);
    expect(s.env.videos.every((v) => v.playbackRate === 2)).toBe(true);
  });

  it("J K L: L plays and goes faster, K pauses, J plays backwards without sound", async () => {
    const s = await ready();
    await settle(s, s.player.seek(us(30) + us(3) - us(0) + (us(950) - us(900))));
    await settle(s, s.player.shuttle("L"));
    await s.env.clock.advance(50);
    expect(s.player.frame).toMatchObject({ playing: true, speed: 1 });
    await settle(s, s.player.shuttle("L"));
    expect(s.player.frame.speed).toBe(1.5);
    await settle(s, s.player.shuttle("L"));
    await settle(s, s.player.shuttle("L"));
    await settle(s, s.player.shuttle("L"));
    expect(s.player.frame.speed).toBe(4);
    await settle(s, s.player.shuttle("K"));
    await s.env.clock.advance(50);
    expect(s.player.frame.playing).toBe(false);
    expect(s.env.videos.every((v) => v.paused)).toBe(true);

    const start = s.player.frame.time;
    await settle(s, s.player.shuttle("J"));
    expect(s.env.audio.muted).toBe(true);
    const back: number[] = [];
    const off = s.player.subscribe((e) => {
      if (e.type === "frame") back.push(e.frame.time);
    });
    await s.env.clock.advance(1000);
    off();
    expect(s.player.frame).toMatchObject({ playing: true, speed: -1 });
    expect(back.length).toBeGreaterThan(15);
    expect(back).toEqual([...back].sort((x, y) => y - x));
    expect(start - s.player.frame.time).toBeGreaterThan(800_000);
    expect(s.env.videos.every((v) => v.paused)).toBe(true);
    // Back across the cut into clip b, then to the start, where it stops.
    await settle(s, s.player.shuttle("J"));
    expect(s.player.frame.speed).toBe(-1.5);
    await s.env.clock.advance(3000);
    expect(s.player.frame).toMatchObject({ playing: false, time: 0 });
    expect(s.env.audio.muted).toBe(false);
    // L after J plays forwards again with sound.
    await settle(s, s.player.shuttle("J"));
    await settle(s, s.player.shuttle("L"));
    await s.env.clock.advance(100);
    expect(s.player.frame).toMatchObject({ playing: true, speed: 1 });
    expect(s.env.audio.muted).toBe(false);
  });

  it("previews a cut from two seconds before to two seconds after", async () => {
    const s = setup();
    const long = [c("a", "A", 0, 150), c("b", "B", 600, 750)];
    s.player.load({ clips: long, sources: sources({ A: URL_A, B: URL_B }), frameRate: R });
    await s.env.clock.advance(200);
    s.env.recording = true;
    void s.player.previewCut(us(150));
    await s.env.clock.advance(6000);
    s.env.recording = false;
    expect(s.player.frame.playing).toBe(false);
    const a = analyse(s.env.screen, long);
    expect(a.wrong).toEqual([]);
    // Frame 0 was on screen before the preview started.
    const shown = [...a.shown].filter((k) => k !== 0).sort((x, y) => x - y);
    expect(shown[0]).toBe(150 - 60);
    expect(shown[shown.length - 1]).toBe(150 + 59);
    expect(s.player.frame.position).toEqual({ sourceId: "B", at: us(659) });
    expect(s.events.some((e) => e.type === "ended")).toBe(false);
  });

  it("keeps the source moment when an edit changes the clips while paused", async () => {
    const s = await ready();
    await settle(s, s.player.seek(us(30) + us(3) - us(0) + (us(920) - us(900))));
    await s.env.clock.advance(50);
    expect(s.player.frame.position).toEqual({ sourceId: "A", at: us(920) });
    // Remove clip b: the same source moment moves earlier in the sequence.
    s.player.load({ clips: [clips[0]!, clips[2]!], sources: sources({ A: URL_A, B: URL_B }), frameRate: R });
    await s.env.clock.advance(50);
    expect(s.player.frame.position).toEqual({ sourceId: "A", at: us(920) });
    expect(s.player.frame.time).toBe(us(30) + (us(920) - us(900)));
    // Cut the moment itself: the sequence time is kept instead.
    const t = s.player.frame.time;
    s.player.load({ clips: [clips[0]!, c("c", "A", 930, 960)], sources: sources({ A: URL_A }), frameRate: R });
    await s.env.clock.advance(100);
    expect(s.player.frame.time).toBe(t);
    expect(s.player.frame.position).toEqual({ sourceId: "A", at: us(950) });
    expect(s.env.top()!.shownFrame).toBe(950);
  });

  it("an edit while playing keeps playing without re-seeking the playing element", async () => {
    const s = await ready();
    await settle(s, s.player.seek(us(33)));
    void s.player.play();
    await s.env.clock.advance(300);
    const top = s.env.top()!;
    const seeks = top.seekCount;
    const atBefore = s.player.frame.position!.at;
    // Cut the end of clip c, ahead of the playhead.
    s.player.load({ clips: [clips[0]!, clips[1]!, c("c", "A", 900, 940)], sources: sources({ A: URL_A, B: URL_B }), frameRate: R });
    await s.env.clock.advance(200);
    expect(s.player.frame.playing).toBe(true);
    expect(s.env.top()).toBe(top);
    expect(top.seekCount).toBe(seeks);
    expect(s.player.frame.position!.at).toBeGreaterThan(atBefore);
    const ended = await s.env.clock.advanceUntil(() => s.events.some((e) => e.type === "ended"), 5000, 10);
    expect(ended).toBe(true);
    expect(s.player.frame.position).toEqual({ sourceId: "A", at: us(939) });
  });

  it("reports a media error and stops", async () => {
    const s = setup();
    s.player.load({ clips: [c("a", "A", 0, 30)], sources: sources({ A: "http://127.0.0.1:9/media/A/broken?token=t" }), frameRate: R });
    await s.env.clock.advance(100);
    expect(s.events.find((e) => e.type === "error")).toEqual({ type: "error", error: expect.objectContaining({ code: "media_error", sourceId: "A" }) });
  });

  it("pressing play on a source that failed reports it each time, without retrying in a loop", async () => {
    const s = setup();
    const broken = "http://127.0.0.1:9/media/A/broken?token=t";
    s.player.load({ clips: [c("a", "A", 0, 30)], sources: sources({ A: broken }), frameRate: R });
    await s.env.clock.advance(100);
    const errors = () => s.events.filter((e) => e.type === "error" && e.error.code === "media_error").length;
    const srcChanges = () => s.env.videos.reduce((n, v) => n + v.srcChanges, 0);
    const before = srcChanges();
    await settle(s, s.player.play());
    await s.env.clock.advance(200);
    await settle(s, s.player.play());
    await s.env.clock.advance(200);
    expect(errors()).toBe(3);
    expect(s.player.frame.playing).toBe(false);
    // The failed address is not loaded again while the sources keep giving it.
    expect(srcChanges()).toBe(before);
  });

  it("tries a failed address again once it left the sources and came back", async () => {
    const s = setup();
    const flaky = "http://127.0.0.1:9/media/A/flaky?token=t";
    const clips = [c("a", "A", 0, 30)];
    s.player.load({ clips, sources: sources({ A: flaky }), frameRate: R });
    await s.env.clock.advance(100);
    expect(s.events.some((e) => e.type === "error")).toBe(true);
    s.player.load({ clips, sources: sources({ A: null }), frameRate: R });
    await s.env.clock.advance(50);
    s.env.library.set(flaky, { fps: FPS, durationS: 120, seekMs: 8 });
    s.player.load({ clips, sources: sources({ A: flaky }), frameRate: R });
    await s.env.clock.advance(200);
    expect(s.env.top()?.src).toBe(flaky);
    expect(s.env.top()?.shownFrame).toBe(0);
    await settle(s, s.player.play());
    await s.env.clock.advance(200);
    expect(s.player.frame.playing).toBe(true);
  });

  it("a proxy that fails to load while playing leaves the original playing", async () => {
    const s = setup();
    const clips = [c("a", "A", 300, 600)];
    s.player.load({ clips, sources: sources({ A: URL_A_ORIG }), frameRate: R });
    await s.env.clock.advance(400);
    void s.player.play();
    await s.env.clock.advance(500);
    s.player.load({ clips, sources: sources({ A: "http://127.0.0.1:9/media/A/badproxy?token=t" }), frameRate: R });
    s.env.recording = true;
    await s.env.clock.advance(1000);
    s.env.recording = false;
    expect(s.events.some((e) => e.type === "error" && e.error.code === "media_error")).toBe(true);
    expect(s.player.frame.playing).toBe(true);
    expect(s.env.top()?.src).toBe(URL_A_ORIG);
    const a = analyse(s.env.screen, clips);
    expect(a.wrong).toEqual([]);
    expect(a.regressions).toEqual([]);
  });

  it("an edit while playing that keeps the moment but moves it to another clip keeps playing", async () => {
    const s = setup();
    s.player.load({ clips: [c("a", "A", 300, 600)], sources: sources({ A: URL_A }), frameRate: R });
    await s.env.clock.advance(200);
    void s.player.play();
    await s.env.clock.advance(500); // around source frame 315
    const top = s.env.top()!;
    const seeks = top.seekCount;
    // Cut source frames 305..310, behind the playhead: the moment now lies in the second clip.
    s.player.load({ clips: [c("a", "A", 300, 305), c("a2", "A", 310, 600)], sources: sources({ A: URL_A }), frameRate: R });
    await s.env.clock.advance(300);
    expect(s.player.frame.playing).toBe(true);
    expect(s.env.top()).toBe(top);
    expect(top.seekCount).toBe(seeks);
    expect(s.player.frame.position!.at).toBe(us(top.shownFrame));
  });

  it("dispose releases the elements and the audio", async () => {
    const s = await ready();
    void s.player.play();
    await s.env.clock.advance(100);
    s.player.dispose();
    expect(s.env.videos.every((v) => v.paused && v.src === "")).toBe(true);
    expect(s.env.audio.disposed).toBe(true);
  });
});
