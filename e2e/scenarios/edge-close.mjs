// Scenario "edge-close" (spec 1.12 "App closed or crashed mid-edit", "Export cancelled or
// interrupted"; milestone 1 "Closing and reopening the app resumes it").
//
// 1. Closing the window during an import (the proxy, audio and transcription all running):
//    the app exits by itself within the harness's 20 s, leaves no FFmpeg or transcriber, and
//    leaves no half-written file in the cache that passes for a finished one. The next launch
//    opens the project from Home with the edit made during the import, and the import resumes
//    and finishes (full transcript, proxy).
// 2. Closing the window during an export: the app exits, no FFmpeg is left, nothing is left at
//    the destination (no MP4, no .part) and the export work folder is empty. The project
//    opens again with its edits as they were.

import fs from "node:fs";
import path from "node:path";
import { check, sleep } from "../lib/app.mjs";
import { fixture, listFiles } from "../lib/media.mjs";
import { ffmpeg, rowTable } from "../lib/edge.mjs";
import { openExport } from "../lib/exporting.mjs";
import { installFrameProbe } from "../lib/probe.mjs";
import { dropFiles, waitImported, waitSaved } from "../lib/steps.mjs";
import { settle } from "../lib/transcript.mjs";

const clipsOf = (app) => app.state((s) => JSON.stringify(s.edit.current.clips.map((c) => [c.sourceId, c.start, c.end])));

/** Opens the only project from Home with Enter. */
async function openFromHome(app) {
  await app.waitForState((s) => s.screen === "home" && s.projects.length === 1, null, { label: "Home with the project" });
  await app.key("Enter");
  await app.waitForState((s) => s.screen === "editor" && s.project, null, { timeoutMs: 15_000, label: "the project open" });
}

export async function run(ctx) {
  const { runDir, log } = ctx;
  const t = rowTable(ctx);
  const out = path.join(runDir, "work", "out");

  // ------------------------------------------------------------- close during an import
  let app = await ctx.launch({ settings: { exportFolder: out } });
  await app.eval(installFrameProbe);
  let sid;
  let editBefore;
  await t.row("Window closed during an import", "1.12 / UC8: the app closes cleanly; reopening resumes the import with the edits intact", async () => {
    // speech-2min four times over (8.5 min, stream copy), so the proxy is still being made
    // when the first text has arrived.
    const long = path.join(runDir, "work", "speech four times.mp4");
    ffmpeg(["-stream_loop", "3", "-i", fixture("speech-2min"), "-c", "copy", long]);
    await dropFiles(app, [long]);
    sid = await app.state((s) => s.project.sources[0].id);
    // Wait until the transcription has sent some text and the proxy is part-way.
    const at = await app.waitForState(
      (s, id) => {
        const j = Object.values(s.jobs).filter((x) => x.sourceId === id);
        const tx = j.find((x) => x.kind === "transcribe");
        const px = j.find((x) => x.kind === "proxy");
        return (s.sources[id]?.transcript?.utterances.length ?? 0) > 0 && tx?.state === "running" && px?.state === "running" ? { tx: tx.progress, px: px.progress } : null;
      },
      sid,
      { timeoutMs: 30_000, label: "the import part-way (text arriving, proxy running)" },
    );
    // An edit made while importing: split at 10 s and remove the first 10 s (timeline keys).
    await app.key("Tab");
    await app.waitForState((s) => s.session.view === "timeline", null, { label: "the timeline" });
    await app.dispatch("ui.seek", { time: 10_000_000 });
    await app.waitForState((s) => Math.abs(s.playhead.time - 10_000_000) < 40_000, null, { label: "the seek" });
    await app.key("s");
    await app.dispatch("ui.seek", { time: 5_000_000 });
    await app.waitForState((s) => Math.abs(s.playhead.time - 5_000_000) < 40_000, null, { label: "the seek" });
    await app.key("Delete");
    await app.waitForState((s) => s.edit.current.clips.length === 1 && s.edit.current.clips[0].start === 10_000_000, null, { label: "the first 10 s removed" });
    editBefore = await clipsOf(app);
    const stillRunning = await app.state((s, id) => Object.values(s.jobs).filter((j) => j.sourceId === id && j.state === "running").map((j) => j.kind), sid);
    check(stillRunning.includes("proxy"), "The proxy finished before the window was closed; the row would not test closing mid-import", stillRunning);
    await app.shot("import-before-close");
    const t0 = Date.now();
    await app.close(); // fails if the app does not exit, or leaves FFmpeg or the transcriber
    const closeMs = Date.now() - t0;
    const cacheFiles = listFiles(path.join(app.cacheDir, sid)).map((f) => f.rel);
    check(!cacheFiles.includes("proxy.mp4"), "A proxy is recorded as finished although the import was stopped", cacheFiles);
    check(!cacheFiles.includes("transcript.json"), "A transcript is recorded as finished although the import was stopped", cacheFiles);

    app = await ctx.launch({ settings: { exportFolder: out } });
    await app.eval(installFrameProbe);
    await openFromHome(app);
    const editAfter = await clipsOf(app);
    check(editAfter === editBefore, "The edit made during the import was lost", { editBefore, editAfter });
    const done = await waitImported(app, sid, 180_000);
    const words = await app.state((s, id) => s.sources[id].transcript.utterances.flatMap((u) => u.tokens).filter((k) => k.kind === "word").length, sid);
    check(words > 1000, "The resumed transcription is incomplete", words);
    await settle(app);
    await app.shot("import-resumed");
    return `closed with jobs at transcribe ${(at.tx * 100).toFixed(0)}% / proxy ${(at.px * 100).toFixed(0)}% in ${closeMs} ms, no process left; cache then held ${JSON.stringify(cacheFiles)}; reopened with the edit intact; import resumed (${done.jobs.join(" ")}), ${words} words`;
  });

  // ------------------------------------------------------------- close during an export
  await t.row("Window closed during an export", "1.12: the partial file is removed; the project is untouched", async () => {
    await dropFiles(app, [fixture("numbered-4k-h264")]);
    const id2 = await app.state((s) => s.project.sources[1].id);
    await waitImported(app, id2, 180_000);
    await waitSaved(app);
    const before = await clipsOf(app);
    const d = await openExport(app);
    check(!d.plan.blockedBy, "The export is blocked", d.plan.blockedBy);
    await app.key("Enter");
    const p = await app.waitForState((s) => (s.dialogs.export?.phase === "running" && s.dialogs.export.progress > 0.15 ? s.dialogs.export.progress : null), null, {
      timeoutMs: 60_000,
      label: "the export part-way",
      describe: (s) => s.dialogs.export,
    });
    const midway = listFiles(out).map((f) => f.rel);
    await app.shot("export-before-close");
    const t0 = Date.now();
    await app.close();
    const closeMs = Date.now() - t0;
    const left = listFiles(out);
    check(left.length === 0, "Closing during the export left files at the destination", left);
    const work = listFiles(path.join(app.cacheDir, ".work"));
    check(work.length === 0, "Closing during the export left the export's work files", work.map((f) => f.rel));

    app = await ctx.launch({ settings: { exportFolder: out } });
    await openFromHome(app);
    const after = await clipsOf(app);
    check(after === before, "The project changed when the export was interrupted", { before, after });
    const last = await app.state((s) => s.project.lastExport ?? null);
    check(!last, "The interrupted export is recorded as the last export", last);
    await settle(app);
    await app.shot("after-interrupted-export");
    return `closed at ${(p * 100).toFixed(0)}% (destination then held ${JSON.stringify(midway)}) in ${closeMs} ms; nothing left at the destination or in the work folder; project unchanged`;
  });
  await app.close();
  fs.rmSync(out, { recursive: true, force: true });
  log(`  rows: ${t.rows.length}`);
  t.finish();
}
