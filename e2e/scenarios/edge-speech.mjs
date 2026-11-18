// Scenario "edge-speech" (spec 1.12 rows about the transcript, and the software paths).
//
// - Footage with no speech (fixtures silence-only): an empty transcript with a note; the
//   timeline works as normal (split, remove, undo).
// - A video with no sound at all: the same note, nothing fails.
// - Transcript not ready yet: with rc-speech's stand-in transcriber reading slowly, the progress
//   line shows above the text while playing, marking a range with I / O and cutting it, and
//   splitting on the timeline already work.
// - Speech the transcriber could not turn into words: the stand-in replays speech-2min's
//   recorded transcriber output with one segment reported as speech without words; the
//   transcript shows an "unrecognised speech" block that can be played, cut and restored.
// - The transcriber missing (an empty transcriber folder) and the transcriber failing (the
//   stand-in exits mid-way): a one-line notice; proxy, waveform, playing and editing still work,
//   and the transcript is not left half-made.
// - No GPU (CUDA_VISIBLE_DEVICES=-1 hides the GPU from the transcriber and FFmpeg's NVENC):
//   the transcript is made on the processor and the proxy with the software encoder; the
//   export, which needs NVENC (spec 2.4.8), is refused with a clear message and nothing written.

import fs from "node:fs";
import path from "node:path";
import { ROOT, check, sleep } from "../lib/app.mjs";
import { ffprobe, fixture, listFiles } from "../lib/media.mjs";
import { linkTree, noticeTexts, rowTable, withoutSound } from "../lib/edge.mjs";
import { openExport } from "../lib/exporting.mjs";
import { installFrameProbe } from "../lib/probe.mjs";
import { dropFiles, waitShown } from "../lib/steps.mjs";
import { settle } from "../lib/transcript.mjs";

const TARGET = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(ROOT, "target");
const STANDIN_TX = path.join(TARGET, "debug", "rc-test-standin-transcriber.exe");
const RECORDING = path.join(ROOT, "src-tauri", "crates", "rc-speech", "tests", "data", "speech-2min.v2-int8.cpu.jsonl");
const MODELS = path.join(ROOT, ".cache-dev", "speech", "models");

async function waitQuiet(app, sourceId, timeoutMs = 120_000) {
  return app.waitForState(
    (s, id) => {
      const jobs = Object.values(s.jobs).filter((j) => j.sourceId === id);
      if (!s.sources[id]?.assets || jobs.length === 0 || jobs.some((j) => j.state === "queued" || j.state === "running")) return null;
      return { jobs: jobs.map((j) => `${j.kind}:${j.state}${j.error ? `(${j.error.code})` : ""}`), assets: s.sources[id].assets, errors: jobs.filter((j) => j.error).map((j) => j.error) };
    },
    sourceId,
    { timeoutMs, label: `source ${sourceId}'s jobs to end`, describe: (s, id) => Object.values(s.jobs).filter((j) => j.sourceId === id) },
  );
}

const firstSource = (app) => app.state((s) => s.project.sources[0].id);
const untranscribedRows = (app) => app.eval(() => [...document.querySelectorAll('[data-row="untranscribed"]')].map((e) => `${e.dataset.status}: ${e.textContent.trim()}`));

/** A transcriber folder holding the stand-in, and a model folder (hard links) with its orders. */
function standin(work, name, config) {
  const txDir = path.join(work, `tx-${name}`);
  fs.mkdirSync(txDir, { recursive: true });
  fs.copyFileSync(STANDIN_TX, path.join(txDir, "transcriber.exe"));
  const modelDir = linkTree(MODELS, path.join(work, `models-${name}`));
  fs.writeFileSync(path.join(modelDir, "standin.json"), JSON.stringify(config));
  return { ROUGHCUT_TRANSCRIBER_DIR: txDir, ROUGHCUT_MODEL_DIR: modelDir };
}

/** Timeline split, remove and undo on whatever is loaded; returns a short text. */
async function timelineWorks(app, at) {
  await app.key("Tab");
  await app.waitForState((s) => s.session.view === "timeline", null, { label: "the timeline" });
  const n0 = await app.state((s) => s.edit.current.clips.length);
  const u0 = await app.state((s) => s.edit.undo.length);
  await app.dispatch("ui.seek", { time: at });
  await app.waitForState((s, t) => Math.abs(s.playhead.time - t) < 40_000, at, { label: "the seek" });
  await app.key("s");
  await app.waitForState((s, n) => s.edit.current.clips.length === n + 1, n0, { label: "S to split" });
  await app.key("Delete");
  await app.waitForState((s, n) => s.edit.current.clips.length === n, n0, { label: "Delete to remove the clip under the playhead" });
  const kept = await app.state((s) => s.edit.current.clips.reduce((n, c) => n + c.end - c.start, 0));
  await app.key("Control+z");
  await app.key("Control+z");
  await app.waitForState((s, [n, u]) => s.edit.current.clips.length === n && s.edit.undo.length === u, [n0, u0], { label: "two undos" });
  await app.key("Tab");
  await app.waitForState((s) => s.session.view === "transcript", null, { label: "the transcript view" });
  return `split, remove (kept ${(kept / 1e6).toFixed(1)} s) and undo work`;
}

export async function run(ctx) {
  const { runDir, log } = ctx;
  const t = rowTable(ctx);
  const work = path.join(runDir, "work");
  fs.mkdirSync(work, { recursive: true });

  // ---------------------------------------------------------------- no speech, no sound
  let app = await ctx.launch({ home: "nospeech" });
  await t.row("Footage with no speech", "1.12: empty transcript with a note; the timeline works as normal", async () => {
    await dropFiles(app, [fixture("silence-only")]);
    const id = await firstSource(app);
    const q = await waitQuiet(app, id);
    await settle(app);
    await app.shot("no-speech");
    const tx = await app.state((s, i) => ({ complete: s.sources[i].transcript?.complete, words: (s.sources[i].transcript?.utterances ?? []).flatMap((u) => u.tokens).filter((k) => k.kind === "word").length }), id);
    const rows = await untranscribedRows(app);
    check(q.assets.transcript === "complete" && tx.complete && tx.words === 0, "The silent recording's transcript is not complete and empty", { q, tx });
    check(rows.some((r) => /^silent: .*no speech/.test(r)), "No 'no speech' note in the transcript", rows);
    const tl = await timelineWorks(app, 8_000_000);
    return `jobs ${q.jobs.join(" ")}; note ${JSON.stringify(rows)}; ${tl}`;
  });

  await t.row("A video with no sound track", "(1.12 implied) imports; the transcript says there is no speech; nothing fails", async () => {
    const file = withoutSound(fixture("numbered-1080p60"), path.join(work, "no sound.mp4"));
    await dropFiles(app, [file]);
    const id = await app.state((s) => s.project.sources[1].id);
    const q = await waitQuiet(app, id);
    await app.dispatch("ui.seek", { time: 25_000_000 });
    await sleep(500);
    await settle(app);
    await app.shot("no-sound-transcript");
    const rows = await untranscribedRows(app);
    check(!q.jobs.some((j) => /failed/.test(j)), "A job failed for the video with no sound", q.jobs);
    check(rows.filter((r) => /no speech/.test(r)).length >= 2, "The source with no sound has no 'no speech' note", rows);
    return `jobs ${q.jobs.join(" ")}; rows ${JSON.stringify(rows)}`;
  });
  await app.close();

  // ---------------------------------------------------------------- not ready yet + unrecognised
  // speech-2min's recorded output, with the segment at 0:36 ("Next, the billing page.") reported
  // as speech without words.
  const lines = fs.readFileSync(RECORDING, "utf8").split(/\r?\n/).filter(Boolean);
  let unrec = null;
  const edited = lines.map((l) => {
    const m = JSON.parse(l);
    if (!unrec && m.type === "segment" && m.words?.[0]?.text === "Next,") {
      unrec = { start: m.start, end: m.end };
      return JSON.stringify({ type: "speech_without_words", start: m.start, end: m.end });
    }
    return l;
  });
  check(unrec, "The recording has no segment starting 'Next,'");
  const recording = path.join(work, "speech-2min-unrecognised.jsonl");
  fs.writeFileSync(recording, edited.join("\n") + "\n");
  app = await ctx.launch({ home: "slow", env: standin(work, "slow", { scenario: "slow_reader", recording, readDelayMs: 25 }) });
  await app.eval(installFrameProbe);
  await t.row("Transcript not ready yet", "1.12: progress line above the text; playing, marking ranges and timeline editing already work", async () => {
    await dropFiles(app, [fixture("speech-2min")]);
    const id = await firstSource(app);
    await app.waitForState((s, i) => (s.sources[i]?.transcript?.utterances.length ?? 0) > 1 && Object.values(s.jobs).some((j) => j.sourceId === i && j.kind === "transcribe" && j.state === "running"), id, {
      timeoutMs: 60_000,
      label: "the first text while transcribing",
    });
    await settle(app);
    await app.shot("not-ready-progress");
    const line = await app.eval(() => document.querySelector(".rc-tx-progress, [data-part=progress], .rc-tx-note")?.textContent ?? document.body.innerText.match(/transcribing[^\n]*/)?.[0] ?? null);
    check(line && /transcribing/i.test(line), "No progress line while transcribing", line);
    // Play: Space at 1 s.
    await app.dispatch("ui.seek", { time: 1_000_000 });
    await waitShown(app, 1_000_000);
    await app.key("Space");
    await sleep(800);
    await app.key("Space");
    const played = await app.state((s) => s.playhead.time);
    check(played > 1_400_000, "Space did not play while transcribing", played);
    // Mark 2 s to 3 s with I and O and cut it.
    await app.dispatch("ui.seek", { time: 2_000_000 });
    await waitShown(app, 2_000_000);
    await app.key("i");
    await app.dispatch("ui.seek", { time: 3_000_000 });
    await waitShown(app, 3_000_000);
    await app.key("o");
    await app.key("Delete");
    await app.waitForState((s) => s.edit.current.clips.length === 2, null, { label: "the marked range cut" });
    const cut = await app.state((s) => s.edit.current.clips.map((c) => [c.start, c.end]));
    const still = await app.state((s, i) => Object.values(s.jobs).some((j) => j.sourceId === i && j.kind === "transcribe" && j.state === "running"), id);
    const tl = await timelineWorks(app, 60_000_000);
    const stillAfter = await app.state((s, i) => Object.values(s.jobs).some((j) => j.sourceId === i && j.kind === "transcribe" && j.state === "running"), id);
    check(still && stillAfter, "The transcription ended before the edits were made, so the row did not test editing while transcribing");
    return `progress "${line.trim()}"; played to ${(played / 1e6).toFixed(2)} s; I/O cut gives ${JSON.stringify(cut)}; ${tl}; transcription still running throughout`;
  });

  await t.row("Speech the transcriber could not turn into words", "1.12: an 'unrecognised speech' block; it can be played, kept or cut like any text", async () => {
    const id = await firstSource(app);
    await waitQuiet(app, id, 120_000);
    await app.key("Control+z");
    await app.waitForState((s) => s.edit.current.clips.length === 1, null, { label: "the I/O cut undone" });
    const tok = await app.state((s) => {
      const t0 = s.layout.tokens.findIndex((k) => k.token.kind === "unrecognised");
      return t0 < 0 ? null : { pos: t0, start: s.layout.tokens[t0].token.start, end: s.layout.tokens[t0].token.end };
    });
    check(tok, "No unrecognised token in the layout");
    check(Math.abs(tok.start - unrec.start) < 300_000, "The unrecognised block is not where the transcriber said", { tok, unrec });
    const shown = await app.eval(() => [...document.querySelectorAll("[data-pos]")].map((e) => e.textContent).find((x) => /unrecognised speech/.test(x)) ?? null);
    await app.dispatch("ui.seek", { time: tok.start + 50_000 });
    await sleep(400);
    await settle(app);
    await app.shot("unrecognised-block");
    check(shown, "No 'unrecognised speech' block on screen");
    await app.dispatch("ui.selectTokens", { anchorToken: tok.pos, focusToken: tok.pos });
    await app.key("Delete");
    await app.waitForState((s) => s.edit.current.clips.length === 2, null, { label: "the unrecognised block cut" });
    const gap = await app.state((s) => [s.edit.current.clips[0].end, s.edit.current.clips[1].start]);
    check(gap[0] <= tok.start + 40_000 && gap[1] >= tok.end - 40_000, "Cutting the block did not remove its time", { gap, tok });
    await app.key("Control+z");
    await app.waitForState((s) => s.edit.current.clips.length === 1, null, { label: "undo" });
    // The first frame inside the block (word times are not on the frame grid).
    const from = Math.round((Math.ceil((tok.start * 30) / 1e6) * 1e6) / 30);
    await app.dispatch("ui.seek", { time: from });
    await waitShown(app, from);
    await app.key("Space");
    await sleep(700);
    await app.key("Space");
    const ph = await app.state((s) => s.playhead.time);
    check(ph > tok.start + 400_000, "The block did not play", ph);
    return `"${shown}" at ${(tok.start / 1e6).toFixed(2)} s; cut removed ${(gap[0] / 1e6).toFixed(2)}–${(gap[1] / 1e6).toFixed(2)} s; undo; played through it`;
  });
  await app.close();

  // ---------------------------------------------------------------- transcriber missing
  const empty = path.join(work, "no-transcriber");
  fs.mkdirSync(empty, { recursive: true });
  app = await ctx.launch({ home: "missing", env: { ROUGHCUT_TRANSCRIBER_DIR: empty } });
  await app.eval(installFrameProbe);
  await t.row("The transcriber is missing", "(1.12 implied) a one-line notice; playing and editing still work; no model download", async () => {
    await dropFiles(app, [fixture("speech-2min")]);
    const id = await firstSource(app);
    const q = await waitQuiet(app, id);
    await settle(app);
    await app.shot("transcriber-missing");
    const notices = await noticeTexts(app);
    check(q.jobs.some((j) => /^transcribe:failed\(transcriber_failed\)/.test(j)), "The transcription did not fail with transcriber_failed", q.jobs);
    check(!q.jobs.some((j) => /model_download/.test(j)), "A model download started", q.jobs);
    check(q.assets.playback === "proxy" && q.assets.waveformUrl, "Proxy or waveform missing", q.assets);
    check(q.assets.transcript === "none", "The transcript is left half-made", q.assets.transcript);
    check(notices.some((n) => /not installed/i.test(n)), "No notice says the transcriber is not installed", notices);
    const tl = await timelineWorks(app, 30_000_000);
    return `jobs ${q.jobs.join(" ")}; notice ${JSON.stringify(notices)}; ${tl}`;
  });
  await app.close();

  // ---------------------------------------------------------------- transcriber failing
  app = await ctx.launch({ home: "crash", env: standin(work, "crash", { scenario: "crash", recording: RECORDING, afterSegments: 4, exitCode: 7 }) });
  await app.eval(installFrameProbe);
  await t.row("The transcriber fails mid-way", "3.7 speech: a crash becomes transcriber_failed, not an app crash; nothing half-made", async () => {
    await dropFiles(app, [fixture("speech-2min")]);
    const id = await firstSource(app);
    const q = await waitQuiet(app, id);
    await settle(app);
    await app.shot("transcriber-crashed");
    const notices = await noticeTexts(app);
    const words = await app.state((s, i) => (s.sources[i].transcript?.utterances ?? []).length, id);
    check(q.jobs.some((j) => /^transcribe:failed\(transcriber_failed\)/.test(j)), "The crash did not become transcriber_failed", q.jobs);
    check(q.assets.transcript === "none" && words === 0, "The partial transcript was left after the crash", { a: q.assets.transcript, words });
    check(notices.some((n) => /Transcription failed/i.test(n)), "No notice about the failed transcription", notices);
    const tl = await timelineWorks(app, 30_000_000);
    return `jobs ${q.jobs.join(" ")}; notice ${JSON.stringify(notices)}; ${tl}`;
  });
  await app.close();

  // ---------------------------------------------------------------- no GPU
  const out = path.join(work, "out-nogpu");
  app = await ctx.launch({ home: "nogpu", env: { CUDA_VISIBLE_DEVICES: "-1" }, settings: { exportFolder: out } });
  await app.eval(installFrameProbe);
  await t.row("No GPU available", "2.4.4/2.6: transcript on the processor, proxy on the software encoder; export needs NVENC (2.4.8): refused with a message", async () => {
    const t0 = Date.now();
    await dropFiles(app, [fixture("speech-2min")]);
    const id = await firstSource(app);
    const q = await waitQuiet(app, id, 300_000);
    const took = Date.now() - t0;
    const notices = await noticeTexts(app);
    check(q.assets.transcript === "complete", "No transcript without the GPU", q);
    check(q.assets.playback === "proxy", "No proxy without the GPU", q);
    const words = await app.state((s, i) => s.sources[i].transcript.utterances.flatMap((u) => u.tokens).filter((k) => k.kind === "word").length, id);
    check(words > 200, "The processor transcript is too short", words);
    const proxyFile = listFiles(path.join(app.cacheDir, id)).find((f) => /proxy.*\.mp4$/.test(f.rel));
    const enc = ffprobe(proxyFile.path).streams.find((s) => s.codec_type === "video");
    const d = await openExport(app);
    let exported = "not started";
    if (!d.plan.blockedBy) {
      await app.key("Enter");
      await app.waitForState((s) => s.dialogs.export === null || s.dialogs.export.error || s.dialogs.export.phase === "done", null, { timeoutMs: 60_000, label: "the export to end" });
      exported = await app.state((s) => JSON.stringify(s.dialogs.export?.error ?? s.dialogs.export?.phase ?? s.notices.map((n) => n.text)));
    }
    await settle(app);
    await app.shot("no-gpu-export");
    // What the user reads: one plain sentence with what to do; FFmpeg's output folded away.
    const shownAlert = await app.eval(() => {
      const a = document.querySelector('.rcx-blocked[role="alert"]');
      if (!a) return null;
      return { visible: [...a.querySelectorAll("p")].map((p) => p.textContent).join(" | "), folded: a.querySelector("details")?.open === false };
    });
    if (!d.plan.blockedBy) {
      check(shownAlert && /graphics driver/i.test(shownAlert.visible) && !/CUDA_ERROR|nvenc @/i.test(shownAlert.visible), "The export error does not say what to do in plain words", shownAlert);
      check(shownAlert.folded, "FFmpeg's output is not folded away", shownAlert);
    }
    const files = listFiles(out);
    check(files.length === 0 || files.every((f) => f.size > 1000 && !/\.part$/.test(f.rel)), "A half-written export was left", files);
    const msg = d.plan.blockedBy?.message ?? exported;
    check(/GPU|NVENC|graphics/i.test(msg), "The export's message does not say the GPU is needed", { blocked: d.plan.blockedBy, exported });
    await app.key("Escape");
    return `import done in ${(took / 1000).toFixed(1)} s; ${words} words; proxy ${enc.codec_name} ${enc.width}x${enc.height} (encoder tag ${enc.tags?.encoder ?? "?"}); notices ${JSON.stringify(notices)}; export: ${msg}`;
  });
  await app.close();
  fs.rmSync(out, { recursive: true, force: true });
  t.finish();
}
