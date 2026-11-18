// Scenario "play" (spec 3.2 milestones 1 and 2, 1.10 "Everywhere" and "Timeline view" keys,
// 2.4.3 playback and skipping cuts).
//
// A 40 s 1080p30 clip with a continuous 440 Hz tone (made here with FFmpeg, so a gap in the
// sound shows as a dip) is imported. Then, with the keyboard: play and pause, frame and second
// steps, J K L shuttle, speeds 1, 1.5 and 2, and a seek by clicking. Two ranges are cut with
// I, O and Delete, and playback across both cuts is measured at each speed with the video
// elements' frame callbacks: the picture should go from the last kept frame to the first kept
// frame after the cut within about a frame, and the sound should carry on.

import path from "node:path";
import fs from "node:fs";
import { check, fail, sleep } from "../lib/app.mjs";
import { makeToneClip } from "../lib/media.mjs";
import { installAudioTap, installFrameProbe, readProbes, resetProbes, topVideo } from "../lib/probe.mjs";
import { analyseCut, playheadRate, refreshMs, summarise } from "../lib/analyse.mjs";
import { dropFiles, seekTo, setPlaying, waitImported, waitShown } from "../lib/steps.mjs";

const FPS = 30;
const frame = (k) => Math.floor((k * 1e6) / FPS + 0.5); // the sequence's frame grid (round half up)
const SEC = 1_000_000;

export async function run(ctx) {
  const { log, result } = ctx;
  const clip = makeToneClip(path.join(ctx.runDir, "work", "tone-40s.mp4"), 40);
  const app = await ctx.launch();
  await app.eval(installAudioTap);
  await app.eval(installFrameProbe);
  await dropFiles(app, [clip]);
  const sid = await app.state((s) => s.project.sources[0].id);
  const imported = await waitImported(app, sid);
  log(`  imported: ${imported.jobs.join(" ")}`);
  const duration = await app.state((s) => s.edit.current.clips.reduce((n, c) => n + c.end - c.start, 0));
  check(duration === frame(1200), `The clip is ${duration} µs long, not 40 s`);
  result.refreshMs = null;

  // ---- Space: play and pause, at 1x
  await seekTo(app, frame(60));
  let since = await app.eval(resetProbes);
  await setPlaying(app, true);
  await sleep(1500);
  await setPlaying(app, false);
  let p = await app.eval(readProbes, since);
  result.refreshMs = refreshMs(p.samples);
  const rate1 = playheadRate(p.samples);
  const after = await app.state((s) => s.playhead.time);
  await sleep(400);
  const later = await app.state((s) => s.playhead);
  log(`  Space: played at ${rate1}x, paused at ${after} (still ${later.time}, playing ${later.playing}); refresh ${result.refreshMs} ms; sound tapped from ${p.masters} output(s)`);
  check(p.masters >= 1, "The player's sound output was not found");
  check(rate1 !== null && Math.abs(rate1 - 1) < 0.08, `Playback ran at ${rate1}x, not 1x`);
  check(!later.playing && later.time === after, "Pause did not hold the playhead", { after, later });
  const level = p.audio.filter((b) => b[2] > 0.1).length;
  check(level > p.audio.length * 0.5, "No sound while playing", { blocks: p.audio.length, loud: level });

  // ---- 1 2 3: speeds
  const speeds = {};
  for (const [key, want] of [["2", 1.5], ["3", 2], ["1", 1]]) {
    await app.key(key);
    await app.waitForState((s, r) => s.session.playbackRate === r, want, { timeoutMs: 2000, label: `rate ${want}` });
    since = await app.eval(resetProbes);
    await setPlaying(app, true);
    await sleep(1500);
    const vrate = await app.eval(() => {
      const top = [...document.querySelectorAll("video[data-player-slot]")].find((v) => v.style.zIndex === "2");
      return top?.playbackRate;
    });
    await setPlaying(app, false);
    p = await app.eval(readProbes, since);
    const r = playheadRate(p.samples);
    const loud = p.audio.filter((b) => b[2] > 0.1).length / Math.max(1, p.audio.length);
    speeds[want] = { playheadRate: r, elementRate: vrate, soundShare: Math.round(loud * 100) / 100 };
    log(`  key ${key}: ${JSON.stringify(speeds[want])}`);
    check(vrate === want, `The video element plays at ${vrate}, not ${want}`);
    check(r !== null && Math.abs(r - want) < 0.1 * want, `Playback ran at ${r}x, not ${want}x`);
    check(loud > 0.5, `No sound at ${want}x`);
  }
  result.speeds = speeds;

  // ---- Timeline view: frame and second steps
  await app.key("Tab");
  await app.waitForState((s) => s.session.view === "timeline", null, { label: "the Timeline view" });
  await seekTo(app, frame(300));
  const steps = [];
  for (const [key, delta] of [["ArrowRight", 1], ["ArrowRight", 1], ["ArrowLeft", 1 * -1], ["Shift+ArrowRight", 30], ["Shift+ArrowLeft", -30], ["ArrowLeft", -1]]) {
    const from = await app.state((s) => s.playhead.time);
    const k = Math.round((from * FPS) / 1e6);
    const t0 = Date.now();
    await app.key(key);
    const shown = await waitShown(app, frame(k + delta), FPS);
    steps.push({ key, from: k, to: k + delta, shownMediaTime: shown.shown, ms: Date.now() - t0 });
  }
  log(`  steps: ${steps.map((s) => `${s.key} ${s.from}->${s.to} (${s.ms} ms)`).join(", ")}`);
  result.steps = steps;
  await app.shot("timeline-stepped");

  // ---- J K L
  await seekTo(app, frame(600));
  since = await app.eval(resetProbes);
  await app.key("l");
  await app.waitForState((s) => s.playhead.playing && s.playhead.speed === 1, null, { label: "L: forwards at 1x" });
  await sleep(800);
  await app.key("l");
  await app.waitForState((s) => s.playhead.playing && s.playhead.speed === 1.5, null, { label: "L again: forwards at 1.5x", describe: (s) => s.playhead });
  await sleep(800);
  await app.key("k");
  await app.waitForState((s) => !s.playhead.playing, null, { label: "K: pause" });
  const atK = await app.state((s) => s.playhead.time);
  p = await app.eval(readProbes, since);
  const fwd = { start: frame(600), atK, rate: playheadRate(p.samples) };
  check(atK > frame(600) + 1.5 * SEC, "L, L did not play forwards about 2 s worth", fwd);

  since = await app.eval(resetProbes);
  await app.key("j");
  await app.waitForState((s) => s.playhead.playing && s.playhead.speed < 0, null, { label: "J: backwards", describe: (s) => s.playhead });
  await sleep(1200);
  const back = await app.state((s) => s.playhead);
  await app.key("k");
  await app.waitForState((s) => !s.playhead.playing, null, { label: "K: pause after J" });
  p = await app.eval(readProbes, since);
  const backTimes = p.samples.filter((s) => s[2] !== null).map((s) => s[2]);
  const distinct = new Set(backTimes.map((t) => Math.round(t * FPS))).size;
  const backLoud = p.audio.filter((b) => b[2] > 0.01).length;
  const shuttle = { forwards: fwd, backFrom: atK, backTo: back.time, backSpeed: back.speed, distinctFramesBack: distinct, loudBlocksBack: backLoud, audioBlocks: p.audio.length };
  log(`  J K L: ${JSON.stringify(shuttle)}`);
  result.shuttle = shuttle;
  check(back.time < atK - 0.7 * SEC, "J did not play backwards", shuttle);
  check(distinct > 20, "Backwards play showed too few frames", shuttle);
  check(backLoud === 0, "Backwards play was not silent", shuttle);

  // ---- Seek by clicking on the timeline and on the overview strip
  const clickAt = async (selector, fraction) => {
    const box = await app.page.locator(selector).first().boundingBox();
    check(box, `Nothing to click: ${selector}`);
    await app.page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
    await app.waitForState((s) => !s.playhead.playing, null, { label: "no playback after a click" });
    await sleep(300);
    return app.state((s) => s.playhead.time);
  };
  const clicks = {};
  clicks.timeline = await clickAt(".tlv-panel canvas", 0.25);
  await app.key("Tab");
  await app.waitForState((s) => s.session.view === "transcript", null, { label: "the Transcript view" });
  clicks.strip = await clickAt(".rc-strip__canvas", 0.75);
  log(`  clicks: timeline at 25% -> ${clicks.timeline}, strip at 75% -> ${clicks.strip}`);
  result.clicks = clicks;
  check(Math.abs(clicks.timeline - 0.25 * duration) < 0.04 * duration, "A click at a quarter of the timeline did not seek near a quarter", clicks);
  check(Math.abs(clicks.strip - 0.75 * duration) < 0.03 * duration, "A click at three quarters of the strip did not seek near three quarters", clicks);
  await waitShown(app, clicks.strip, FPS);

  // ---- Cut two ranges with I, O and Delete (Transcript view)
  const cutRange = async (fromK, toK) => {
    await seekTo(app, frame(fromK));
    await app.key("i");
    await seekTo(app, frame(toK));
    await app.key("o");
    await app.waitForState((s) => s.marks.in !== null && s.marks.out !== null, null, { label: "both marks" });
    await app.key("Delete");
  };
  await cutRange(300, 360); // source 10.0 .. 12.0 s
  await app.waitForState((s) => s.edit.current.clips.length === 2, null, { label: "the first cut", describe: (s) => s.edit.current.clips });
  await cutRange(600 - 60, 705 - 60); // source 20.0 .. 23.5 s, which now plays 2 s earlier
  await app.waitForState((s) => s.edit.current.clips.length === 3, null, { label: "the second cut", describe: (s) => s.edit.current.clips });
  const clips = await app.state((s) => s.edit.current.clips.map((c) => [c.start, c.end]));
  log(`  clips after cutting: ${JSON.stringify(clips)}`);
  check(
    JSON.stringify(clips) === JSON.stringify([[0, frame(300)], [frame(360), frame(600)], [frame(705), frame(1200)]]),
    "The cuts did not remove exactly 10.0-12.0 s and 20.0-23.5 s",
    clips,
  );
  await app.shot("two-cuts");

  // ---- Play across both cuts at 1x, 1.5x and 2x, measured
  const cutsAt = [
    { seq: frame(300), outEnd: 10.0, inStart: 12.0 }, // sequence 10.0 s
    { seq: frame(540), outEnd: 20.0, inStart: 23.5 }, // sequence 18.0 s
  ];
  const measured = [];
  for (const [key, rate] of [["1", 1], ["2", 1.5], ["3", 2]]) {
    await app.key(key);
    await app.waitForState((s, r) => s.session.playbackRate === r, rate, { label: `rate ${rate}` });
    for (const c of cutsAt) {
      for (let rep = 0; rep < 3; rep++) {
        const lead = Math.round(1.2 * rate * FPS);
        await seekTo(app, frame(Math.round((c.seq * FPS) / 1e6) - lead));
        await sleep(150);
        since = await app.eval(resetProbes);
        await setPlaying(app, true);
        const playFrom = await app.eval(() => performance.now());
        await sleep(((1.2 + 0.9) * 1000));
        await setPlaying(app, false);
        p = await app.eval(readProbes, since);
        const m = analyseCut(p, { outEnd: c.outEnd, inStart: c.inStart, fps: FPS, rate, outSlotSource: "proxy", inSlotSource: "proxy", playFrom });
        measured.push(m);
      }
    }
  }
  for (const m of measured) log(`  cut ${m.outEnd}->${m.inStart} @${m.rate}x: extra ${m.extraMs} ms (gap ${m.gapMs}, ideal ${m.idealMs}), wrong ${m.wrong}, last frame shown ${m.lastFrameShown}, first incoming frame ${m.firstIncomingShown} (skipped ${m.incomingFramesSkipped}), first held ${m.firstHeldMs} ms, sound dip ${m.audioDipMs} ms, dropouts elsewhere ${m.audioDropoutsElsewhereMs} ms, level ${m.audioLevel}`);
  const byRate = {};
  for (const rate of [1, 1.5, 2]) byRate[rate] = summarise(measured.filter((m) => m.rate === rate));
  result.cutCrossing = { refreshMs: result.refreshMs, byRate, all: measured };
  log(`  summary: ${JSON.stringify(byRate)}`);
  fs.writeFileSync(path.join(ctx.runDir, "cuts.json"), JSON.stringify(measured, null, 2));

  for (const m of measured) {
    check(m.crossed, "Playback never showed the first frame after a cut", m);
    check(m.wrong === 0, "A frame from inside a cut (or past the clip's end) was shown", m);
    check(m.incomingFramesSkipped <= (m.rate >= 2 ? 1 : 0), `${m.incomingFramesSkipped} frame(s) after the cut were never shown at ${m.rate}x`, m);
    const frameMs = 1000 / FPS / m.rate;
    check(m.gapMs !== null && m.gapMs <= frameMs + 2 * (result.refreshMs ?? 17) + 2, `The picture took ${m.gapMs} ms to cross the cut (one frame is ${frameMs.toFixed(1)} ms)`, m);
    check(m.audioDipMs !== undefined && m.audioDipMs <= 25, `The sound dropped for ${m.audioDipMs} ms at the cut`, m);
    check(m.audioDropoutsElsewhereMs !== undefined && m.audioDropoutsElsewhereMs <= 10, `The sound dropped for ${m.audioDropoutsElsewhereMs} ms away from the cut`, m);
  }

  const errors = app.consoleErrors();
  if (errors.length) fail("Console errors", errors);
  await app.close();
  fs.rmSync(clip, { force: true });
}
