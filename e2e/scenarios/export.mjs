// Scenario "export" (spec 1.7 E, 2.4.8, milestone 4: "the exported file is as long as the
// sequence to the frame, picture and sound stay in sync to the end").
//
// For the 4K H.264 fixture and the 4K HEVC 10-bit HDR fixture (each 900 numbered frames with a
// beep starting on every whole second): cut two ranges on the timeline with its keys, open the
// Export dialog with Ctrl+E, read the plan, confirm with Enter, follow the progress and the time
// left, then check the file: exactly the kept frames in order (read from the burned-in numbers),
// every beep within a frame of its frame in every audio track up to the end, the source's
// format kept. In the done stage Enter shows the file in Explorer (selected) and C copies its
// path. The export's speed is recorded.

import fs from "node:fs";
import path from "node:path";
import { check, fail } from "../lib/app.mjs";
import { fixture, manifest } from "../lib/media.mjs";
import { readerFor } from "../lib/frames.mjs";
import { dropFiles, waitImported } from "../lib/steps.mjs";
import { verifyExport } from "../lib/exportcheck.mjs";
import { checkCopyPath, checkShowInFolder, openExport, runExport } from "../lib/exporting.mjs";
import { settle } from "../lib/transcript.mjs";

const FPS = 30;
const F = (k) => Math.floor((k * 1e6) / FPS + 0.5);

/** Seeks (as a click on the timeline does) to sequence frame k and waits for it. */
async function seekFrame(app, k) {
  await app.dispatch("ui.seek", { time: F(k) });
  await app.waitForState((s, t) => Math.abs(s.playhead.time - t) <= 2, F(k), { label: `the playhead at frame ${k}` });
}

/**
 * Splits at source frames 155, 247, 600 and 700 with S, then removes [155, 247) and [600, 700)
 * with Delete: kept [0, 155), [247, 600), [700, 900) = 708 frames.
 */
export async function cutTwoRanges(app) {
  await app.key("Tab");
  await app.waitForState((s) => s.session.view === "timeline", null, { label: "the Timeline view" });
  for (const k of [155, 247, 600, 700]) {
    await seekFrame(app, k);
    await app.key("s");
  }
  await seekFrame(app, 200);
  await app.key("Delete");
  await seekFrame(app, 520);
  await app.key("Delete");
  await settle(app);
  const clips = await app.state((s) => s.edit.current.clips.map((c) => [Math.round((c.start * 30) / 1e6), Math.round((c.end * 30) / 1e6)]));
  check(JSON.stringify(clips) === JSON.stringify([[0, 155], [247, 600], [700, 900]]), "The timeline edit did not give the expected clips", clips);
  return [[0, 155], [247, 600], [700, 900]];
}

async function exportOne(ctx, name, format) {
  const { log, runDir } = ctx;
  const file = fixture(name);
  const man = manifest().fixtures[name];
  const reader = readerFor(file);
  const out = path.join(runDir, `exports-${name}`);
  const app = await ctx.launch({ home: name, settings: { exportFolder: out } });
  await dropFiles(app, [file]);
  const sid = await app.state((s) => s.project.sources[0].id);
  await waitImported(app, sid);
  const segments = await cutTwoRanges(app);
  const frames = segments.reduce((n, [a, b]) => n + b - a, 0);

  // ---- Confirm stage
  const d = await openExport(app);
  await app.shot(`${name}-confirm`);
  check(!d.error, "Planning the export failed", d.error);
  const plan = d.plan;
  log(`  ${name} plan: ${JSON.stringify(plan)}`);
  log(`  ${name} confirm text: ${d.text.replace(/\s+/g, " ")}`);
  check(!plan.blockedBy, "The export is blocked", plan.blockedBy);
  check(plan.duration === F(frames), `The plan's length is ${plan.duration} µs, the sequence is ${F(frames)} µs`);
  check(plan.format.codec === format.codec && plan.format.bitDepth === format.bitDepth && plan.format.hdr === format.hdr, "The plan's format does not follow the source", plan.format);
  check(plan.estimatedBytes > 0 && plan.estimatedSeconds > 0, "The plan has no size or time estimate", plan);
  check(d.folder === out, `The dialog saves to ${d.folder}, settings say ${out}`);
  check(/0:23/.test(d.text), "The confirm stage does not show the length 0:23", d.text);
  check(/about \d+(\.\d+)? (mb|gb)/i.test(d.text), "The confirm stage does not show the estimated size", d.text);

  // ---- Running stage, then done
  const run = await runExport(app);
  check(!run.error, "The export failed", run.error);
  await app.shot(`${name}-done`);
  const result = run.result;
  log(`  ${name} result: ${JSON.stringify(result)}; ${run.samples.length} progress samples over ${run.wallMs} ms`);
  const progress = run.samples.map((s) => s.progress);
  check(run.samples.length >= 3, "Too few progress samples (the export ran too fast to watch?)", run.samples);
  check(progress.every((p, i) => i === 0 || p >= progress[i - 1] - 1e-9), "Progress went backwards", progress);
  const mid = run.samples.filter((s) => s.progress > 0.05 && s.progress < 0.95);
  check(mid.length > 0, "No progress was shown between 5% and 95%", run.samples);
  check(mid.some((s) => s.secondsLeft !== null && s.secondsLeft > 0 && /left/.test(s.shown ?? "")), "No time left was shown while exporting", mid);
  check(mid.some((s) => /\d+%/.test(s.shown ?? "")), "No percentage was shown while exporting", mid);
  const doneText = await app.eval(() => document.querySelector('.rcx-part[data-active="true"]')?.innerText.replace(/\s+/g, " ") ?? "");
  log(`  ${name} done text: ${doneText}`);
  check(result.path === path.join(out, path.basename(result.path)) && result.path.toLowerCase().endsWith(".mp4"), "The file is not in the chosen folder", result);
  check(fs.existsSync(result.path) && fs.statSync(result.path).size === result.bytes, "The file on disk is not the one reported", result);
  check(fs.readdirSync(out).length === 1, "The export folder holds more than the export", fs.readdirSync(out));
  check(result.duration === F(frames), `The result says ${result.duration} µs, the sequence is ${F(frames)} µs`);
  check(/took/.test(doneText), "The done stage does not say how long it took", doneText);

  // ---- The file
  const checked = verifyExport(result.path, reader, {
    segments,
    fps: FPS,
    format: { ...format, width: man.video.width, height: man.video.height, audioTracks: man.audioTracks.length },
  });
  log(`  ${name} file: ${JSON.stringify({ ...checked, tracks: checked.tracks })}`);

  // ---- Show in folder (Enter) and Copy path (C)
  const sel = await checkShowInFolder(app, result.path);
  log(`  show in folder: Explorer opened ${path.dirname(result.path)} with ${JSON.stringify(sel)} selected`);
  await checkCopyPath(app, result.path);
  log("  copy path: the clipboard held the file's path");
  await app.shot(`${name}-copied`);
  await app.key("Escape");
  await app.waitForState((s) => s.dialogs.export === null, null, { label: "Esc to close the done stage" });

  const speed = frames / FPS / result.tookSeconds;
  const errors = app.consoleErrors();
  if (errors.length) fail("Console errors", errors);
  await app.close();
  fs.rmSync(result.path, { force: true });
  return {
    plan: { durationUs: plan.duration, estimatedBytes: plan.estimatedBytes, estimatedSeconds: plan.estimatedSeconds, format: plan.format, notices: plan.notices },
    result,
    speedTimesRealTime: Math.round(speed * 100) / 100,
    estimateVsActual: Math.round((plan.estimatedSeconds / result.tookSeconds) * 100) / 100,
    sizeEstimateVsActual: Math.round((plan.estimatedBytes / result.bytes) * 100) / 100,
    file: checked,
    progressSamples: run.samples.length,
  };
}

export async function run(ctx) {
  const { log, result } = ctx;
  result.h264 = await exportOne(ctx, "numbered-4k-h264", { codec: "h264", bitDepth: 8, hdr: false });
  log(`  H.264: ${result.h264.speedTimesRealTime}x real time (${result.h264.result.tookSeconds.toFixed(1)} s for ${(result.h264.plan.durationUs / 1e6).toFixed(1)} s)`);
  result.hevc = await exportOne(ctx, "numbered-4k-hevc10-hdr", { codec: "hevc", bitDepth: 10, hdr: true });
  log(`  HEVC 10-bit HDR: ${result.hevc.speedTimesRealTime}x real time (${result.hevc.result.tookSeconds.toFixed(1)} s for ${(result.hevc.plan.durationUs / 1e6).toFixed(1)} s)`);
}
