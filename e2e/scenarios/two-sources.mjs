// Scenario "two-sources" (spec UC5, 1.12 "Sources with different resolutions or frame rates").
//
// A project from speech-2min (1080p30) gets numbered-4k-h264 (2160p30, 30 s, a beep starting
// exactly on every whole second) dropped on the editor as a second source. It is appended to the
// end of the sequence, imported (proxy, waveform, transcript), the mixed-format notice shows, and
// playing across the join goes from the first source's last frame to the second's first frame
// within about a frame, with the second source's sound starting with its picture.

import { check, fail, sleep } from "../lib/app.mjs";
import { fixture, manifest } from "../lib/media.mjs";
import { installAudioTap, installFrameProbe, readProbes, resetProbes } from "../lib/probe.mjs";
import { analyseCut, summarise } from "../lib/analyse.mjs";
import { dropFiles, seekTo, setPlaying, waitImported } from "../lib/steps.mjs";

const FPS = 30;
const frame = (k) => Math.floor((k * 1e6) / FPS + 0.5);

export async function run(ctx) {
  const { log, result } = ctx;
  const first = fixture("speech-2min");
  const second = fixture("numbered-4k-h264");
  const man = manifest().fixtures["numbered-4k-h264"];
  const app = await ctx.launch();
  await app.eval(installAudioTap);
  await app.eval(installFrameProbe);
  await dropFiles(app, [first]);
  const a = await app.state((s) => s.project.sources[0].id);
  await waitImported(app, a);
  const before = await app.state((s) => ({ clips: s.edit.current.clips, playhead: s.playhead.time, projectId: s.project.id }));
  check(before.clips.length === 1, "Expected one clip before adding footage", before.clips);

  // ---- Drop the 4K file on the editor: it is added to this project, at the end
  const t0 = Date.now();
  const ms = await dropFiles(app, [second]);
  const added = await app.state((s) => ({
    projectId: s.project.id,
    sources: s.project.sources.map((r) => ({ id: r.id, path: r.path, w: r.media.video.width, h: r.media.video.height, d: r.media.duration })),
    clips: s.edit.current.clips.map((c) => ({ sourceId: c.sourceId, start: c.start, end: c.end })),
    notices: s.notices.map((n) => n.text),
    playhead: s.playhead.time,
  }));
  log(`  added in ${ms} ms: ${JSON.stringify(added)}`);
  check(added.projectId === before.projectId, "Dropping on the editor made a new project instead of adding to this one");
  check(added.sources.length === 2 && added.sources[1].path === second, "The second file is not the project's second source", added.sources);
  const b = added.sources[1].id;
  check(added.sources[1].w === 3840 && added.sources[1].h === 2160, "The 4K source was probed wrong", added.sources[1]);
  check(added.clips.length === 2, "Expected two clips", added.clips);
  check(JSON.stringify(added.clips[0]) === JSON.stringify(before.clips[0] && { sourceId: before.clips[0].sourceId, start: before.clips[0].start, end: before.clips[0].end }), "The first clip changed when footage was added", added.clips);
  check(added.clips[1].sourceId === b && added.clips[1].start === 0 && added.clips[1].end === frame(man.video.frameCount), "The new footage is not appended whole at the end", { clip: added.clips[1], frames: man.video.frameCount });
  check(added.playhead === before.playhead, "Adding footage moved the playhead", { before: before.playhead, after: added.playhead });
  check(
    added.notices.some((t) => t.includes("differ in format")),
    "No notice that the recordings differ in format (spec 1.12)",
    added.notices,
  );
  await app.waitForState((s, id) => s.sources[id]?.assets?.playback && s.sources[id].assets.playback !== "none", b, { timeoutMs: 5000, label: "the 4K source to be playable" });
  result.addToPlayableMs = Date.now() - t0;
  const imported = await waitImported(app, b);
  result.addToImportedMs = Date.now() - t0;
  log(`  4K source playable after ${result.addToPlayableMs} ms, imported after ${result.addToImportedMs} ms: ${imported.jobs.join(" ")}`);
  const tx = await app.state((s, id) => ({ complete: s.sources[id].transcript?.complete, words: s.sources[id].transcript?.utterances.flatMap((u) => u.tokens).filter((t) => t.kind === "word").length }), b);
  log(`  4K source transcript: ${JSON.stringify(tx)}`);
  const headers = await app.state((s) => s.layout.blocks.filter((x) => x.kind === "source").map((x) => x.name));
  check(headers.length === 2 && headers[1] === "numbered-4k-h264.mp4", "The transcript does not hold both sources", headers);
  // The caret follows the playhead: at the join the transcript shows the second source's header.
  await seekTo(app, added.clips[0].end);
  await sleep(300);
  const shown = await app.eval(() => [...document.querySelectorAll('[data-row="source"]')].map((e) => e.textContent));
  check(shown.includes("numbered-4k-h264.mp4"), "With the playhead at the join, the second source's header is not on screen", shown);
  await app.shot("two-sources-transcript");
  await app.key("Tab");
  await app.waitForState((s) => s.session.view === "timeline", null, { label: "the Timeline view" });
  await app.shot("two-sources-timeline");

  // ---- Play across the join
  const join = added.clips[0].end; // sequence time of the join
  const joinK = Math.round((join * FPS) / 1e6);
  const measured = [];
  for (const [key, rate, reps] of [["1", 1, 3], ["3", 2, 2]]) {
    await app.key(key);
    await app.waitForState((s, r) => s.session.playbackRate === r, rate, { label: `rate ${rate}` });
    for (let rep = 0; rep < reps; rep++) {
      await seekTo(app, frame(joinK - Math.round(1.2 * rate * FPS)));
      await sleep(150);
      const since = await app.eval(resetProbes);
      await setPlaying(app, true);
      const playFrom = await app.eval(() => performance.now());
      await sleep(2100);
      await setPlaying(app, false);
      const p = await app.eval(readProbes, since);
      measured.push(
        analyseCut(p, { outEnd: join / 1e6, inStart: 0, fps: FPS, rate, outSlotSource: "proxy", inSlotSource: "proxy", outSourceId: a, inSourceId: b, playFrom }),
      );
    }
  }
  for (const m of measured) {
    log(`  join @${m.rate}x: extra ${m.extraMs} ms (gap ${m.gapMs}, ideal ${m.idealMs}), wrong ${m.wrong}, last frame shown ${m.lastFrameShown}, first incoming ${m.firstIncomingShown} (skipped ${m.incomingFramesSkipped}), first held ${m.firstHeldMs} ms, beep onset vs picture ${m.soundOnsetVsPictureMs} ms`);
  }
  // The same beep measure away from any join: the 4K source's beeps at 3.0 and 4.0 s against
  // the first time frames 90 and 120 are on screen. This is the steady offset between sound and
  // picture in the window (Web Audio adds its output latency to the sound).
  await app.key("1");
  await app.waitForState((s) => s.session.playbackRate === 1, null, { label: "rate 1" });
  await seekTo(app, join + frame(75));
  await sleep(150);
  const since = await app.eval(resetProbes);
  await setPlaying(app, true);
  await sleep(1900);
  await setPlaying(app, false);
  const steadyProbe = await app.eval(readProbes, since);
  const latency = await app.eval(() => window.__rcAudio.contexts.map((c) => ({ baseLatencyMs: c.baseLatency * 1000, outputLatencyMs: c.outputLatency * 1000 })));
  const steady = [3, 4].map((sec) => {
    const shown = steadyProbe.samples.find((x) => x[8] === b && Math.abs(x[2] - sec) < 0.002);
    const onset = shown && steadyProbe.audio.find((x) => x[1] >= shown[0] - 200 && x[2] > 0.05);
    return { second: sec, onsetVsPictureMs: shown && onset ? Math.round((onset[1] - shown[0]) * 10) / 10 : null };
  });
  log(`  steady sound vs picture (no join): ${JSON.stringify(steady)}; audio context latency ${JSON.stringify(latency)}`);
  check(steady.every((x) => x.onsetVsPictureMs !== null), "The beeps away from the join were not found", steady);
  const steadyMean = steady.reduce((n, x) => n + x.onsetVsPictureMs, 0) / steady.length;
  result.soundVsPicture = { steady, latency, steadyMeanMs: Math.round(steadyMean * 10) / 10 };

  result.join = { byRate: { 1: summarise(measured.filter((m) => m.rate === 1)), 2: summarise(measured.filter((m) => m.rate === 2)) }, all: measured };
  await app.shot("after-join");
  for (const m of measured) {
    check(m.crossed, "The second source's first frames never showed after the join", m);
    check(m.wrong === 0, "A wrong frame was shown at the join", m);
    check(m.incomingFramesSkipped <= (m.rate >= 2 ? 1 : 0), `${m.incomingFramesSkipped} frame(s) of the second source were skipped`, m);
    check(m.gapMs !== null && m.gapMs <= 1000 / FPS / m.rate + 2 * 17, `The picture took ${m.gapMs} ms to cross the join`, m);
    check(
      m.soundOnsetVsPictureMs !== null && Math.abs(m.soundOnsetVsPictureMs - steadyMean) <= 25,
      `At the join the second source's sound started ${m.soundOnsetVsPictureMs} ms from its picture; away from joins the offset is ${steadyMean.toFixed(1)} ms`,
      m,
    );
  }

  const errors = app.consoleErrors();
  if (errors.length) fail("Console errors", errors);
  await app.close();
}
