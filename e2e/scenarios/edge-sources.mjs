// Scenario "edge-sources" (spec 1.12, milestone 6: "Locate file", second sources, odd files).
//
// Every file is a copy (or a stream copy) of a fixture in the scenario's work folder, with a
// long real-world name, so it can be moved and deleted. Files reach the app through its real
// file dialog (Ctrl+N, Ctrl+O, Locate's Enter), answered with UI Automation, or by a drop
// (ui.dropFiles) for files the dialog's filter would not show.
//
// Rows: new project from Ctrl+N; the same file again; a byte-identical copy at another path; a
// file that is not a video (a text file named .mp4, and a .txt dropped); a video with no sound;
// an HDR 10-bit source (plan: HEVC 10-bit HDR); a source deleted while the project is open
// (noticed, export blocked); a source moved while the app is closed (Locate prompt on open,
// a different file refused, the right file accepted, edits intact, plays again).

import fs from "node:fs";
import path from "node:path";
import { check, sleep } from "../lib/app.mjs";
import { ffprobe, fixture } from "../lib/media.mjs";
import { answerFileDialog } from "../lib/filedialog.mjs";
import { noticeTexts, rowTable, screenText, withoutSound } from "../lib/edge.mjs";
import { openExport } from "../lib/exporting.mjs";
import { installFrameProbe } from "../lib/probe.mjs";
import { waitShown } from "../lib/steps.mjs";
import { settle } from "../lib/transcript.mjs";

const LONG = "Weekly design update — studio recording, take 2 (final, really final) 2026-11-13";

/** Waits until no job of `sourceId` is queued or running; returns its jobs and assets. */
async function waitQuiet(app, sourceId, timeoutMs = 120_000) {
  return app.waitForState(
    (s, id) => {
      const jobs = Object.values(s.jobs).filter((j) => j.sourceId === id);
      if (!s.sources[id]?.assets || jobs.length === 0 || jobs.some((j) => j.state === "queued" || j.state === "running")) return null;
      return { jobs: jobs.map((j) => `${j.kind}:${j.state}${j.error ? `(${j.error.code})` : ""}`), assets: s.sources[id].assets };
    },
    sourceId,
    { timeoutMs, label: `source ${sourceId}'s jobs to end`, describe: (s, id) => Object.values(s.jobs).filter((j) => j.sourceId === id) },
  );
}

async function viaDialog(app, chord, answer) {
  const answered = answerFileDialog(app, answer);
  await sleep(200);
  await app.key(chord);
  return answered;
}

export async function run(ctx) {
  const { log, runDir } = ctx;
  const t = rowTable(ctx);
  const work = path.join(runDir, "work");
  const where = path.join(work, "recordings");
  const moved = path.join(work, "moved here");
  fs.mkdirSync(where, { recursive: true });
  fs.mkdirSync(moved, { recursive: true });
  const main = path.join(where, `${LONG}.mp4`);
  fs.copyFileSync(fixture("speech-2min"), main);
  const twin = path.join(work, "copy of the same recording.mp4");
  fs.copyFileSync(main, twin);
  const other = path.join(work, "a different recording.mp4");
  fs.copyFileSync(fixture("numbered-1080p60"), other);
  const silentPic = withoutSound(fixture("numbered-1080p60"), path.join(where, "screen share without sound.mp4"));
  const fakeVideo = path.join(where, "notes from the meeting.mp4");
  fs.writeFileSync(fakeVideo, "These are meeting notes, not a video.\r\n".repeat(200));
  const textFile = path.join(where, "notes.txt");
  fs.writeFileSync(textFile, "plain notes\r\n");
  const hdr = path.join(where, "HDR screen capture 10-bit.mp4");
  fs.copyFileSync(fixture("numbered-4k-hevc10-hdr"), hdr);

  let app = await ctx.launch({ settings: { exportFolder: path.join(work, "out") } });
  await app.eval(installFrameProbe);
  let sid;

  await t.row("New project from footage (Ctrl+N)", "1.10 Ctrl+N: new project from footage; 1.7 A", async () => {
    const title = await viaDialog(app, "Control+n", main);
    await app.waitForState((s) => s.screen === "editor" && s.project?.sources.length === 1, null, { timeoutMs: 15_000, label: "the editor with the new project" });
    sid = await app.state((s) => s.project.sources[0].id);
    const name = await app.state((s) => s.project.name);
    await waitQuiet(app, sid, 180_000);
    await settle(app);
    await app.shot("long-name-transcript");
    check(name === LONG, "The project is not named after the file", { name });
    return `dialog "${title}" answered; project "${name}" imported`;
  });

  await t.row("The same file added again", "(not in 1.12) a file already in the project is not added twice", async () => {
    const before = await app.state((s) => ({ sources: s.project.sources.length, clips: s.edit.current.clips.length }));
    await viaDialog(app, "Control+o", main);
    await app.waitForState((s) => s.notices.some((n) => /already in this project/i.test(n.text)), null, { label: "the 'already in this project' notice" });
    const after = await app.state((s) => ({ sources: s.project.sources.length, clips: s.edit.current.clips.length }));
    check(after.sources === before.sources && after.clips === before.clips, "Adding the same file again changed the project", { before, after });
    return `notice ${JSON.stringify(await noticeTexts(app))}; sources ${after.sources}, clips ${after.clips}`;
  });

  await t.row("A second copy of the same recording", "(not in 1.12) a byte-identical copy elsewhere is the same recording", async () => {
    await app.dispatch("ui.dismissNotice", { id: "import" });
    await viaDialog(app, "Control+o", twin);
    await sleep(1500);
    const st = await app.state((s) => ({ sources: s.project.sources.map((r) => r.path), clips: s.edit.current.clips.length, notices: s.notices.map((n) => n.text) }));
    check(st.sources.length === 1, "A copy of the same recording became a second source", st);
    check(st.notices.some((n) => /already in this project/i.test(n)), "No notice says the copy is already in the project", st);
    return `not added; notice "${st.notices.find((n) => /already/i.test(n))}"`;
  });

  await t.row("A file that is not a video", "(1.12 implied) refused with a message; nothing changes", async () => {
    await app.dispatch("ui.dismissNotice", { id: "import" });
    const before = await app.state((s) => JSON.stringify(s.edit.current));
    await viaDialog(app, "Control+o", fakeVideo);
    await app.waitForState((s) => s.notices.some((n) => n.id === "import" && n.kind === "error"), null, { label: "an error notice for the text file" });
    const n1 = await noticeTexts(app);
    await app.shot("not-a-video");
    await app.dispatch("ui.dismissNotice", { id: "import" });
    await app.dispatch("ui.dropFiles", { paths: [textFile] });
    await app.waitForState((s) => s.notices.some((n) => n.id === "import" && n.kind === "error"), null, { label: "an error notice for the .txt" });
    const n2 = await noticeTexts(app);
    const after = await app.state((s) => JSON.stringify(s.edit.current));
    check(after === before, "A file that is not a video changed the edit");
    check(n1.some((n) => /not a video|could not be read|not.*recogni[sz]ed|cannot be (opened|used)/i.test(n)) && n2.some((n) => /not a video|could not be read|cannot be (opened|used)/i.test(n)), "The notice does not say the file is not a usable video", { n1, n2 });
    const files = await app.state((s) => s.project.sources.length);
    check(files === 1, "A file that is not a video was added", files);
    await app.dispatch("ui.dismissNotice", { id: "import" });
    return `.mp4 text file: ${JSON.stringify(n1)}; .txt dropped: ${JSON.stringify(n2)}`;
  });

  let silentId;
  await t.row("A video with no sound", "(1.12 implied) imports; no transcript work; timeline and export work", async () => {
    await viaDialog(app, "Control+o", silentPic);
    await app.waitForState((s) => s.project.sources.length === 2, null, { timeoutMs: 15_000, label: "the silent video to be added" });
    silentId = await app.state((s) => s.project.sources[1].id);
    const q = await waitQuiet(app, silentId);
    const media = await app.state((s, id) => s.project.sources.find((r) => r.id === id).media, silentId);
    check(media.audioTracks.length === 0, "The silent video was probed with sound", media);
    check(!q.jobs.some((j) => /:failed/.test(j)), "A job failed for the video with no sound", q.jobs);
    check(q.assets.playback === "proxy", "The video with no sound has no proxy", q.assets);
    const proxyFile = fs.readdirSync(path.join(app.cacheDir, silentId)).find((f) => /^proxy.*\.mp4$/.test(f));
    check(proxyFile, "No proxy file in the silent source's cache folder", fs.readdirSync(path.join(app.cacheDir, silentId)));
    const proxy = ffprobe(path.join(app.cacheDir, silentId, proxyFile));
    check(proxy.streams.some((s) => s.codec_type === "video"), "The silent source's proxy has no picture", proxy.streams);
    const notes = await app.eval(() => [...document.querySelectorAll('[data-row="untranscribed"]')].map((e) => `${e.dataset.status}: ${e.textContent}`));
    await app.key("Tab");
    await app.waitForState((s) => s.session.view === "timeline", null, { label: "the timeline" });
    await app.shot("no-sound-timeline");
    const plan = (await openExport(app)).plan;
    await app.key("Escape");
    await app.key("Tab");
    check(!plan.blockedBy, "The export is blocked with a silent source in it", plan.blockedBy);
    check(plan.format.audioTracks >= 1, "The export has no sound track although the first clip has sound", plan.format);
    return `jobs ${q.jobs.join(" ")}; transcript ${q.assets.transcript}; rows ${JSON.stringify(notes.filter((x) => /no speech|no transcript|no sound/i.test(x)))}; export plan ${plan.format.audioTracks} track(s), not blocked`;
  });

  await t.row("A source deleted while the project is open", "1.12: Locate file prompt for that source; edits intact (export must not use it)", async () => {
    const clipsBefore = await app.state((s) => JSON.stringify(s.edit.current.clips));
    fs.rmSync(silentPic);
    await app.waitForState((s, id) => s.sources[id]?.assets?.online === false, silentId, { timeoutMs: 12_000, label: "the deleted source to be noticed (5 s check)" });
    await app.waitForState((s) => s.dialogs.locate !== null, null, { timeoutMs: 3000, label: "the Locate file prompt" });
    await settle(app);
    await app.shot("deleted-locate-prompt");
    const prompt = await app.state((s) => s.dialogs.locate);
    const text = await screenText(app);
    await app.key("Escape");
    await app.waitForState((s) => s.dialogs.locate === null, null, { label: "Esc to close the prompt" });
    const plan = (await openExport(app)).plan;
    await app.shot("deleted-export-blocked");
    await app.key("Escape");
    const clipsAfter = await app.state((s) => JSON.stringify(s.edit.current.clips));
    check(prompt.sourceId === silentId, "The prompt is for another source", prompt);
    check(/moved or deleted/i.test(text), "The prompt does not say the file was moved or deleted", text.slice(0, 500));
    check(plan.blockedBy?.code === "source_missing", "The export is not blocked by the missing source", plan.blockedBy);
    check(clipsAfter === clipsBefore, "The edit changed when the source went missing");
    return `prompt for "${prompt.name}"; export blocked: ${plan.blockedBy.message}`;
  });

  // Remove the deleted source's clip so the rest of the project is exportable, then close.
  await app.key("Tab");
  await app.waitForState((s) => s.session.view === "timeline", null, { label: "the timeline" });
  const secondStart = await app.state((s) => s.edit.current.clips[0].end - s.edit.current.clips[0].start);
  await app.dispatch("ui.seek", { time: secondStart + 1_000_000 });
  await app.waitForState((s, t0) => Math.abs(s.playhead.time - t0) < 40_000, secondStart + 1_000_000, { label: "the playhead in the second clip" });
  await app.key("Delete");
  await app.waitForState((s) => s.edit.current.clips.length === 1, null, { label: "the silent clip removed" });
  // A distinctive edit to find again after the move: split at 10 s and remove 10–20 s.
  await app.dispatch("ui.seek", { time: 10_000_000 });
  await sleep(300);
  await app.key("s");
  await app.dispatch("ui.seek", { time: 20_000_000 });
  await sleep(300);
  await app.key("s");
  await app.dispatch("ui.seek", { time: 15_000_000 });
  await sleep(300);
  await app.key("Delete");
  await app.waitForState((s) => s.edit.current.clips.length === 2, null, { label: "10–20 s removed" });
  const editBefore = await app.state((s) => JSON.stringify(s.edit.current.clips.map((c) => [c.sourceId, c.start, c.end])));
  await sleep(1500);
  await app.close();

  // ---- moved while the app is closed
  const movedTo = path.join(moved, path.basename(main));
  fs.renameSync(main, movedTo);
  app = await ctx.launch({ settings: { exportFolder: path.join(work, "out") } });
  await app.eval(installFrameProbe);

  await t.row("A source moved while the app was closed", "1.12: the project opens with a Locate file prompt for that source; edits intact", async () => {
    await app.waitForState((s) => s.screen === "home" && s.projects.length === 1, null, { label: "Home with the project" });
    await app.shot("home-long-name");
    await app.key("Enter");
    await app.waitForState((s) => s.screen === "editor" && s.dialogs.locate !== null, null, { timeoutMs: 10_000, label: "the editor with the Locate prompt" });
    await settle(app);
    await app.shot("moved-locate-prompt");
    const st = await app.state((s) => ({ clips: JSON.stringify(s.edit.current.clips.map((c) => [c.sourceId, c.start, c.end])), prompt: s.dialogs.locate }));
    check(st.clips === editBefore, "The edits changed when the source moved", { before: editBefore, after: st.clips });
    check(st.prompt.sourceId === sid, "The prompt is not for the moved source", st.prompt);
    return `prompt for "${st.prompt.name}", last seen at ${st.prompt.path}; edits intact`;
  });

  await t.row("Locate file: a different file chosen", "3.7: a different file is rejected by Locate file", async () => {
    await viaDialog(app, "Enter", other);
    await app.waitForState((s) => s.dialogs.locate?.error, null, { timeoutMs: 10_000, label: "the refusal of a different file" });
    await settle(app);
    await app.shot("locate-wrong-file");
    const e = await app.state((s) => s.dialogs.locate.error);
    const text = await app.eval(() => document.querySelector(".rcl-error")?.textContent ?? "");
    const path0 = await app.state((s) => s.project.sources[0].path);
    check(e.code === "source_mismatch", "A different file was not refused as a mismatch", e);
    check(/different file/i.test(text), "The prompt does not say it is a different file", text);
    check(path0 === main, "The project's path changed to the wrong file", path0);
    return `refused: "${text}"`;
  });

  await t.row("Locate file: the moved file chosen", "1.12/3.7: the moved file keeps its fingerprint and is accepted; plays again", async () => {
    await viaDialog(app, "Enter", movedTo);
    // The prompt then moves on to the other missing source (the deleted one, still in the
    // project although no clip uses it now: undo can bring its clip back).
    await app.waitForState((s, id) => s.dialogs.locate?.sourceId !== id, sid, { timeoutMs: 10_000, label: "the prompt for this source to close" });
    const next = await app.state((s) => s.dialogs.locate && s.dialogs.locate.name);
    check(next === null || next === "screen share without sound.mp4", "The prompt moved on to an unexpected source", next);
    if (next) {
      await app.key("Escape");
      await app.waitForState((s) => s.dialogs.locate === null, null, { label: "Esc to close the second prompt" });
    }
    await app.waitForState((s, id) => s.sources[id]?.assets?.online === true && s.sources[id].assets.playback !== "none", sid, { timeoutMs: 10_000, label: "the source online again" });
    const st = await app.state((s) => ({ path: s.project.sources[0].path, clips: JSON.stringify(s.edit.current.clips.map((c) => [c.sourceId, c.start, c.end])) }));
    check(st.path === movedTo, "The project does not record the new path", st);
    check(st.clips === editBefore, "The edits changed after locating", st);
    await app.dispatch("ui.seek", { time: 12_000_000 });
    await waitShown(app, 12_000_000);
    await app.key("Space");
    await sleep(1200);
    await app.key("Space");
    const ph = await app.state((s) => s.playhead.time);
    check(ph > 12_500_000, "Playback did not move after locating", ph);
    const plan = (await openExport(app)).plan;
    await app.shot("located-export");
    await app.key("Escape");
    check(!plan.blockedBy, "The export is still blocked after locating", plan.blockedBy);
    const onDisk = JSON.parse(fs.readFileSync(path.join(app.dataDir, "projects", await app.state((s) => s.project.id), "project.json"), "utf8"));
    check(onDisk.sources[0].path === movedTo, "project.json does not hold the new path", onDisk.sources[0].path);
    return `accepted; new path saved; played to ${(ph / 1e6).toFixed(2)} s; export not blocked`;
  });
  await app.close();

  // ---- HDR 10-bit
  app = await ctx.launch({ home: "hdr", settings: { exportFolder: path.join(work, "out-hdr") } });
  await t.row("HDR 10-bit source", "2.4.8 / decisions: 10-bit HDR stays HEVC Main10 with HDR; proxy plays", async () => {
    await viaDialog(app, "Control+n", hdr);
    await app.waitForState((s) => s.screen === "editor" && s.project?.sources.length === 1, null, { timeoutMs: 15_000, label: "the HDR project" });
    const id = await app.state((s) => s.project.sources[0].id);
    const q = await waitQuiet(app, id, 120_000);
    const media = await app.state((s) => s.project.sources[0].media);
    const d = await openExport(app);
    await app.shot("hdr-export-plan");
    // A long real folder: the end of the path (the folder's own name) must stay readable.
    const shownFolder = await app.eval(() => {
      const el = document.querySelector(".rcx-folder");
      return { text: el.textContent, fits: el.scrollWidth <= el.clientWidth + 1, title: el.getAttribute("title") };
    });
    check(shownFolder.title.length > 80 && shownFolder.text.endsWith("out-hdr") && shownFolder.fits, "The long export folder is not shown with its own name in view", shownFolder);
    await app.key("Escape");
    check(media.video.bitDepth === 10 && media.video.hdr, "The HDR source was probed wrong", media.video);
    check(q.assets.playback === "proxy", "The HDR source has no proxy", q);
    check(d.plan.format.codec === "hevc" && d.plan.format.bitDepth === 10 && d.plan.format.hdr, "The export plan does not keep HEVC 10-bit HDR", d.plan.format);
    return `probed ${media.video.codec} ${media.video.bitDepth}-bit hdr=${media.video.hdr}; jobs ${q.jobs.join(" ")}; plan ${d.plan.format.codec} ${d.plan.format.bitDepth}-bit hdr=${d.plan.format.hdr}; text: ${d.text.replace(/\s+/g, " ").slice(0, 160)}`;
  });
  await app.close();
  t.finish();
}
