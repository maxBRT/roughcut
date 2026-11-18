// Scenario "export-cases" (spec 1.12 rows on export, 2.4.8 "Mixed sources", milestone 6):
//
// - cancel part-way: Esc while running leaves nothing at the destination (no file, no .part),
//   no temporary folder, no FFmpeg, and the project untouched;
// - nothing to export (every clip removed): export is refused with a note;
// - nothing to export (all the text selected with the keyboard and deleted): no clip is left,
//   not even the silence before the first word, and export is refused the same way;
// - a file of the same name already in the folder: the plan says it will be replaced, and the
//   export replaces it with the new file;
// - not enough space at the destination (ROUGHCUT_TEST_FREE_BYTES): blocked before starting,
//   with the amount needed shown;
// - two sources of different formats (4K30 then 1080p60): the notice, and the export follows
//   the first clip with the right frames of the second (the frame-rate rule);
// - the variable-frame-rate fixture: constant 30 fps with the frames the rule picks, beeps kept;
// - the three-audio-track fixture: all three tracks, each in sync.

import fs from "node:fs";
import path from "node:path";
import { check, fail, sleep, watchedProcesses } from "../lib/app.mjs";
import { fixture, listFiles, manifest } from "../lib/media.mjs";
import { readerFor } from "../lib/frames.mjs";
import { dropFiles, waitImported } from "../lib/steps.mjs";
import { beepOnsetsFor, expectedFrames, fpsRuleFrames, verifyExport } from "../lib/exportcheck.mjs";
import { openExport, runExport } from "../lib/exporting.mjs";
import { settle } from "../lib/transcript.mjs";
import { cutTwoRanges } from "./export.mjs";

const FPS = 30;
const F = (k) => Math.floor((k * 1e6) / FPS + 0.5);

async function seekFrame(app, k) {
  await app.dispatch("ui.seek", { time: F(k) });
  await app.waitForState((s, t) => Math.abs(s.playhead.time - t) <= 2, F(k), { label: `the playhead at frame ${k}` });
}

async function project(ctx, home, files, { env, settingsFolder } = {}) {
  const out = settingsFolder ?? path.join(ctx.runDir, `out-${home}`);
  const app = await ctx.launch({ home, env, settings: { exportFolder: out } });
  for (const f of files) {
    await dropFiles(app, [f]);
    const id = await app.state((s) => s.project.sources[s.project.sources.length - 1].id);
    await waitImported(app, id);
  }
  await app.key("Tab");
  await app.waitForState((s) => s.session.view === "timeline", null, { label: "the Timeline view" });
  return { app, out };
}

async function finish(app) {
  const errors = app.consoleErrors();
  if (errors.length) fail("Console errors", errors);
  await app.close();
}


// ---------------------------------------------------------------- cancel, nothing, same name

async function cancelNothingSameName(ctx) {
  const { log, result } = ctx;
  const file = fixture("numbered-4k-h264");
  const { app, out } = await project(ctx, "cancel", [file]);
  const before = await app.state((s) => JSON.stringify(s.edit.current));

  // ---- Cancel part-way
  const d = await openExport(app);
  check(!d.plan.blockedBy, "The export is blocked", d.plan.blockedBy);
  await app.key("Enter");
  await app.waitForState((s) => s.dialogs.export?.phase === "running" && s.dialogs.export.progress > 0.3, null, { timeoutMs: 60_000, label: "the export to pass 30%" });
  const at = await app.state((s) => s.dialogs.export.progress);
  const during = listFiles(out).map((f) => f.rel);
  await app.shot("cancel-running");
  await app.key("Escape");
  await app.waitForState((s) => s.dialogs.export === null, null, { label: "Esc to cancel the export" });
  const notice = await app.state((s) => s.notices.map((n) => n.text));
  await app.shot("cancelled");
  check(notice.some((t) => /cancelled/i.test(t)), "No notice says the export was cancelled", notice);
  // The job ends, its FFmpegs stop, and nothing is left.
  await app.waitForState((s) => Object.values(s.jobs).filter((j) => j.kind === "export").every((j) => j.state !== "running" && j.state !== "queued"), null, {
    timeoutMs: 10_000,
    label: "the export job to end",
    describe: (s) => Object.values(s.jobs).filter((j) => j.kind === "export"),
  });
  await sleep(1500);
  const left = listFiles(out);
  check(left.length === 0, "Cancelling left files at the destination", left);
  const work = listFiles(path.join(app.cacheDir)).filter((f) => /work|export|piece|\.part/i.test(f.rel));
  check(work.length === 0, "Cancelling left the export's temporary files in the cache", work);
  const ff = watchedProcesses().filter((p) => p.name.toLowerCase().startsWith("ffmpeg"));
  check(ff.length === 0, "FFmpeg is still running after the cancel", ff);
  const after = await app.state((s) => JSON.stringify(s.edit.current));
  check(after === before, "Cancelling the export changed the project");
  const job = await app.state((s) => Object.values(s.jobs).filter((j) => j.kind === "export").map((j) => j.state));
  log(`  cancel at ${(at * 100).toFixed(0)}%: files during ${JSON.stringify(during)}, after none; job ${JSON.stringify(job)}; notice ${JSON.stringify(notice)}`);
  result.cancel = { atProgress: at, filesDuring: during, jobStates: job };

  // ---- Nothing to export: remove the only clip
  await seekFrame(app, 100);
  await app.key("Delete");
  await app.waitForState((s) => s.edit.current.clips.length === 0, null, { label: "every clip removed" });
  await settle(app);
  await app.shot("nothing-kept");
  const note = await app.eval(() => document.body.innerText);
  await app.key("Control+e");
  await sleep(800);
  const nothing = await app.state((s) => s.dialogs.export && { phase: s.dialogs.export.phase, blocked: s.dialogs.export.plan?.blockedBy ?? s.dialogs.export.error });
  await app.shot("nothing-to-export");
  const shown = await app.eval(() => document.body.innerText.replace(/\s+/g, " "));
  if (nothing) {
    check(nothing.blocked && nothing.blocked.code === "nothing_to_export", "With nothing kept the export dialog does not say there is nothing to export", nothing);
    await app.key("Enter");
    await sleep(800);
    const ph = await app.state((s) => s.dialogs.export?.phase ?? null);
    check(ph !== "running" && ph !== "done", "Enter started an export with nothing kept", ph);
    await app.key("Escape");
  }
  check(/nothing|everything (is|was) cut/i.test(shown), "No note says there is nothing to export", shown.slice(0, 400));
  check(!/0×0|about 0 kb/i.test(shown), "With nothing kept the dialog shows figures for an empty file", shown.slice(0, 600));
  check(listFiles(out).length === 0, "An export with nothing kept wrote a file", listFiles(out));
  log(`  nothing to export: dialog ${JSON.stringify(nothing)}; note shown`);
  result.nothing = { dialog: nothing, noteBefore: /everything is cut|no clips/i.test(note) };
  await app.key("Control+z");
  await app.waitForState((s) => s.edit.current.clips.length === 1, null, { label: "undo to bring the clip back" });

  // ---- A file of the same name already there
  const d2 = await openExport(app);
  const target = path.join(out, `${d2.fileName}${d2.fileName.toLowerCase().endsWith(".mp4") ? "" : ".mp4"}`);
  await app.key("Escape");
  await app.waitForState((s) => s.dialogs.export === null, null, { label: "Esc to close the dialog" });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(target, "an older export the user made earlier");
  const d3 = await openExport(app);
  await app.shot("same-name-confirm");
  log(`  same name: plan notices ${JSON.stringify(d3.plan.notices)}, blocked ${JSON.stringify(d3.plan.blockedBy ?? null)}; text: ${d3.text.replace(/\s+/g, " ")}`);
  check(d3.plan.notices.some((n) => /already/i.test(n) && /replace/i.test(n)), "The plan does not say a file of that name is already there and will be replaced", d3.plan.notices);
  check(/already/i.test(d3.text), "The confirm stage does not show that the file is already there", d3.text);
  const run = await runExport(app);
  check(!run.error, "Exporting over an existing file failed", run.error);
  check(run.result.path.toLowerCase() === target.toLowerCase(), "The export did not go to the name shown", { result: run.result.path, target });
  const replaced = fs.statSync(target).size;
  check(replaced === run.result.bytes && replaced > 1000, "The old file was not replaced by the export", { size: replaced });
  check(listFiles(out).length === 1, "The folder holds more than the export", listFiles(out));
  result.sameName = { notices: d3.plan.notices, bytes: replaced };
  await app.shot("same-name-done");
  await app.key("Escape");
  await finish(app);
  fs.rmSync(out, { recursive: true, force: true });
}

// ---------------------------------------------------------------- everything cut by text

async function everythingCutByText(ctx) {
  const { log, result } = ctx;
  const out = path.join(ctx.runDir, "out-alltext");
  const app = await ctx.launch({ home: "alltext", settings: { exportFolder: out } });
  await dropFiles(app, [fixture("speech-2min")]);
  const sid = await app.state((s) => s.project.sources[0].id);
  await waitImported(app, sid);
  const first = await app.state((s) => ({ view: s.session.view, n: s.layout.tokens.length, firstStart: s.layout.tokens[0].token.start, cutBefore: s.layout.tokens[0].token.cutBefore }));
  check(first.view === "transcript" && first.n > 100, "The editor did not open on the Transcript view with the transcript", first);
  check(first.cutBefore > 0, "The first word's cut point is at the very start, so this case tests nothing", first);
  // Keyboard only: to the start of the text, then select paragraph by paragraph to its end.
  await app.key("Control+ArrowUp", { times: 3 });
  await settle(app);
  let sel = await app.state((s) => ({ ...s.selection }));
  check(sel.anchor === 0 && sel.focus === 0, "Ctrl+↑ did not put the caret at the start of the text", sel);
  let presses = 0;
  while (sel.focus < first.n && presses < 200) {
    await app.key("Control+Shift+ArrowDown");
    presses++;
    sel = await app.state((s) => ({ ...s.selection }));
  }
  check(sel.anchor === 0 && sel.focus === first.n, "Ctrl+Shift+↓ did not select the whole text", { sel, tokens: first.n, presses });
  await settle(app);
  await app.shot("all-text-selected");
  await app.key("Delete");
  await app.waitForState((s) => s.edit.current.clips.length === 0, null, {
    label: "no clip left after deleting all the text",
    describe: (s) => s.edit.current.clips,
  });
  await settle(app);
  await app.shot("all-text-cut");
  const struck = await app.state((s) => s.layout.tokens.filter((t) => t.keep !== "cut").length);
  check(struck === 0, "Some text is not shown as cut", { notCut: struck });
  const d = await openExport(app);
  await app.shot("all-text-export");
  const blocked = d.plan?.blockedBy ?? d.error ?? null;
  check(blocked && blocked.code === "nothing_to_export", "With all the text cut the export is not blocked as nothing to export", { plan: d.plan, error: d.error });
  const shown = await app.eval(() => document.body.innerText.replace(/\s+/g, " "));
  check(/nothing|everything (is|was) cut/i.test(shown), "No note says there is nothing to export", shown.slice(0, 400));
  check(!/about \d+ [kmg]b/i.test(d.text), "The confirm stage gives a file size with all the text cut", d.text);
  await app.key("Enter");
  await sleep(800);
  const ph = await app.state((s) => s.dialogs.export?.phase ?? null);
  check(ph !== "running" && ph !== "done", "Enter started an export with all the text cut", ph);
  check(listFiles(out).length === 0, "An export with all the text cut wrote a file", listFiles(out));
  await app.key("Escape");
  await app.waitForState((s) => s.dialogs.export === null, null, { label: "Esc to close the dialog" });
  await app.key("Control+z");
  await app.waitForState((s, dur) => s.edit.current.clips.length === 1 && s.edit.current.clips[0].start === 0 && s.edit.current.clips[0].end === dur, await app.state((s) => s.project.sources[0].media.duration), {
    label: "undo to bring the whole source back",
    describe: (s) => s.edit.current.clips,
  });
  log(`  everything cut by text: ${first.n} tokens selected in ${presses} presses of Ctrl+Shift+↓, no clip left, blocked ${JSON.stringify(blocked)}`);
  result.everythingCutByText = { tokens: first.n, presses, firstWordStart: first.firstStart, firstCutBefore: first.cutBefore, blockedBy: blocked };
  await finish(app);
  fs.rmSync(out, { recursive: true, force: true });
}

// ---------------------------------------------------------------- not enough space

async function noSpace(ctx) {
  const { log, result } = ctx;
  const { app, out } = await project(ctx, "nospace", [fixture("numbered-4k-h264")], { env: { ROUGHCUT_TEST_FREE_BYTES: "1000000" } });
  const d = await openExport(app);
  await app.shot("no-space-confirm");
  const b = d.plan.blockedBy;
  log(`  no space: blocked ${JSON.stringify(b)}, required ${d.plan.requiredBytes}, free ${d.plan.freeBytes}; text ${d.text.replace(/\s+/g, " ")}`);
  check(b && b.code === "disk_full", "With 1 MB free the export is not blocked for disk space", d.plan);
  check(d.plan.freeBytes === 1_000_000 && d.plan.requiredBytes > d.plan.freeBytes, "The plan's free and needed space are wrong", d.plan);
  const mb = d.plan.requiredBytes / 1e6;
  check(/needs?|need/i.test(d.text) && /\d+(\.\d+)? (mb|gb)/i.test(d.text), "The confirm stage does not show the amount needed", d.text);
  // Every figure for the space needed on the screen is the same (one unit system throughout).
  const needs = [...d.text.matchAll(/needs about (\d+(?:\.\d+)? [kmg]b)/gi)].map((m) => m[1].toLowerCase());
  check(needs.length >= 1 && new Set(needs).size === 1, "The screen gives different amounts for the space needed", needs);
  await app.key("Enter");
  await sleep(1000);
  const phase = await app.state((s) => s.dialogs.export?.phase);
  check(phase === "confirm", `Enter started a blocked export (phase ${phase})`);
  check(listFiles(out).length === 0, "A blocked export wrote something", listFiles(out));
  result.noSpace = { requiredMB: Math.round(mb * 10) / 10, text: d.text.replace(/\s+/g, " ") };
  await app.key("Escape");
  await finish(app);
}

// ---------------------------------------------------------------- mixed formats

async function mixed(ctx) {
  const { log, result } = ctx;
  const a = fixture("numbered-4k-h264");
  const b = fixture("numbered-1080p60");
  const { app, out } = await project(ctx, "mixed", [a, b]);
  const notices = await app.state((s) => s.notices.map((n) => n.text));
  check(notices.some((t) => /differ in format/i.test(t)), "No notice that the recordings differ in format", notices);
  // Keep the first 3 s of each: A [0, 90), B [0, 90) (sequence frames).
  for (const k of [90, 990]) {
    await seekFrame(app, k);
    await app.key("s");
  }
  await seekFrame(app, 100);
  await app.key("Delete");
  await seekFrame(app, 200);
  await app.key("Delete");
  const clips = await app.state((s) => s.edit.current.clips.map((c) => [c.sourceId, c.start, c.end]));
  check(clips.length === 2 && clips[0][2] === F(90) && clips[1][1] === 0 && clips[1][2] === F(90), "The mixed edit is not the two 3 s clips", clips);
  const d = await openExport(app);
  await app.shot("mixed-confirm");
  log(`  mixed plan: ${JSON.stringify(d.plan)}`);
  check(d.plan.notices.some((n) => /^Sources differ; the export follows the first clip/.test(n)), "The plan has no notice that sources differ", d.plan.notices);
  check(/differ/i.test(d.text), "The confirm stage does not show the mixed-format notice", d.text);
  check(d.plan.format.width === 3840 && d.plan.format.frameRate.num === 30, "The export does not follow the first clip's format", d.plan.format);
  const run = await runExport(app);
  check(!run.error, "The mixed export failed", run.error);
  const times60 = Array.from({ length: 1800 }, (_, i) => i / 60);
  const frames = [...expectedFrames([[0, 90]]), ...fpsRuleFrames(times60, 30, 0, 90)];
  const checked = verifyExport(run.result.path, readerFor([a, b]), {
    frames,
    onsets: beepOnsetsFor([[0, 3], [0, 3]]),
    fps: 30,
    format: { codec: "h264", bitDepth: 8, hdr: false, width: 3840, height: 2160, audioTracks: 1 },
  });
  log(`  mixed file: ${checked.frames} frames, second clip starts ${JSON.stringify(frames.slice(90, 94))}, tracks ${JSON.stringify(checked.tracks)}`);
  result.mixed = { notices: d.plan.notices, file: checked };
  await app.key("Escape");
  await finish(app);
  fs.rmSync(out, { recursive: true, force: true });
}

// ---------------------------------------------------------------- variable frame rate

async function vfr(ctx) {
  const { log, result } = ctx;
  const file = fixture("numbered-vfr");
  const man = manifest().fixtures["numbered-vfr"];
  const { app, out } = await project(ctx, "vfr", [file]);
  // Keep [0, 300) and [420, 900) of the 30 fps grid: 0–10 s and 14–30 s.
  for (const k of [300, 420]) {
    await seekFrame(app, k);
    await app.key("s");
  }
  await seekFrame(app, 350);
  await app.key("Delete");
  const d = await openExport(app);
  await app.shot("vfr-confirm");
  log(`  vfr plan: ${JSON.stringify(d.plan)}`);
  check(d.plan.duration === F(780), `The VFR plan's length is ${d.plan.duration}, expected ${F(780)}`);
  check(d.plan.notices.some((n) => /variable frame rate/i.test(n)), "The plan has no notice about the variable frame rate", d.plan.notices);
  const run = await runExport(app);
  check(!run.error, "The VFR export failed", run.error);
  const times = man.video.frameTimestampsSec;
  const frames = [...fpsRuleFrames(times, 30, 0, 300), ...fpsRuleFrames(times, 30, 420, 480)];
  const checked = verifyExport(run.result.path, readerFor(file), {
    frames,
    onsets: beepOnsetsFor([[0, 10], [14, 16]]),
    fps: 30,
    format: { codec: "h264", bitDepth: 8, hdr: false, width: 3840, height: 2160, audioTracks: 1 },
  });
  const pts = (await import("../../fixtures/verify.mjs")).frameTimestamps;
  const ts = await pts(run.result.path);
  const deltas = ts.slice(1).map((t, i) => t - ts[i]);
  check(deltas.every((x) => Math.abs(x - 1 / 30) < 0.0006), "The VFR export is not constant 30 fps", { min: Math.min(...deltas), max: Math.max(...deltas) });
  log(`  vfr file: ${checked.frames} frames at constant 30 fps; repeated source frames ${frames.length - new Set(frames).size}; tracks ${JSON.stringify(checked.tracks)}`);
  result.vfr = { notices: d.plan.notices, file: checked };
  await app.key("Escape");
  await finish(app);
  fs.rmSync(out, { recursive: true, force: true });
}

// ---------------------------------------------------------------- three audio tracks

async function threeTracks(ctx) {
  const { log, result } = ctx;
  const file = fixture("numbered-3audio");
  const { app, out } = await project(ctx, "3audio", [file]);
  await app.key("Tab");
  const segments = await cutTwoRanges(app);
  const d = await openExport(app);
  check(d.plan.format.audioTracks === 3, "The plan does not keep the three audio tracks", d.plan.format);
  check(/3 audio tracks/i.test(d.text), "The confirm stage does not say 3 audio tracks", d.text);
  await app.shot("3audio-confirm");
  const run = await runExport(app);
  check(!run.error, "The three-track export failed", run.error);
  const checked = verifyExport(run.result.path, readerFor(file), {
    segments,
    fps: 30,
    format: { codec: "h264", bitDepth: 8, hdr: false, width: 3840, height: 2160, audioTracks: 3 },
  });
  const freqs = checked.tracks.map((t) => t.freqHz);
  check(Math.abs(freqs[0] - 1000) < 30 && Math.abs(freqs[1] - 500) < 15 && Math.abs(freqs[2] - 2000) < 60, "The three tracks are not the source's three tracks in order", freqs);
  check(checked.audio[0].channels === 2 && checked.audio[1].channels === 1 && checked.audio[2].channels === 1, "The tracks' channel counts changed", checked.audio);
  log(`  3 tracks: ${JSON.stringify(checked.tracks)}`);
  result.threeTracks = checked;
  await app.key("Escape");
  await finish(app);
  fs.rmSync(out, { recursive: true, force: true });
}

export async function run(ctx) {
  await cancelNothingSameName(ctx);
  await everythingCutByText(ctx);
  await noSpace(ctx);
  await mixed(ctx);
  await vfr(ctx);
  await threeTracks(ctx);
}
