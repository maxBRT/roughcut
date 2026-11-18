// Scenario "first-run" (spec 2.7, 2.4.9, 3.2 milestone 6 "first-run model download,
// installer"): the packaged app on a PC where it has never run.
//
//   ROUGHCUT_E2E_APP=dist-app/Roughcut/Roughcut.exe npm run e2e -- first-run
//
// Only ROUGHCUT_DATA_DIR and ROUGHCUT_CACHE_DIR are set (empty folders under the run folder),
// plus ROUGHCUT_CLAUDE for rc-suggest's stand-in (automated runs never call the installed
// claude); no other ROUGHCUT_ variable, and no ffmpeg or transcriber on PATH (App `bare`). The
// app must find its own ffmpeg, ffprobe and transcriber next to its exe, download the speech
// model into its default folder (%LOCALAPPDATA%\Roughcut\speech\models) with the progress on
// screen, then import, transcribe and export fixtures/out/speech-2min.mp4.
//
// It can only be checked once on a PC: it refuses to run when the speech model is already in
// the default folder (installed-start checks the other case). The downloaded model is left
// there, as a user's first run would leave it.

import fs from "node:fs";
import path from "node:path";
import { check } from "../lib/app.mjs";
import { ffprobe, fixture, manifest } from "../lib/media.mjs";
import { openExport, runExport } from "../lib/exporting.mjs";
import { INT8_MODEL, MODEL_DIR, SPEECH_HOME, appLog, followJobs, packagedAppDir, startProgramSampler, transcriberReady } from "../lib/packaged.mjs";

export async function run(ctx) {
  const { log, result, runDir } = ctx;
  const appDir = packagedAppDir().toLowerCase();
  check(!fs.existsSync(INT8_MODEL), `The speech model is already in ${MODEL_DIR}: a first run can no longer be seen on this PC (run installed-start instead)`);
  result.speechHomeBefore = fs.existsSync(SPEECH_HOME) ? fs.readdirSync(SPEECH_HOME) : null;

  const app = await ctx.launch({ bare: true });
  result.launchToReadyMs = app.readyMs;
  const home = await app.state((s) => ({ screen: s.screen, projects: s.projects.length }));
  check(home.screen === "home" && home.projects === 0, "The packaged app did not start on an empty Home screen", home);
  await app.shot("home-empty");

  // Exports go to this run's folder, set as the user would set it (the dialog's "change
  // folder" stores it with update_settings), so nothing reaches the user's Videos folder.
  const exportDir = path.join(runDir, "work");
  fs.mkdirSync(exportDir, { recursive: true });
  await app.eval(async (folder) => {
    const settings = await window.__TAURI_INTERNALS__.invoke("update_settings", { changes: { exportFolder: folder } });
    window.__roughcut.store.setState({ settings });
  }, exportDir);

  const programs = startProgramSampler();
  const t0 = Date.now();
  await app.dispatch("ui.dropFiles", { paths: [fixture("speech-2min")] });
  await app.waitForState((s) => s.screen === "editor" && s.project?.sources.length === 1, null, { timeoutMs: 15_000, label: "the editor to open" });
  const sid = await app.state((s) => s.project.sources[0].id);

  // ---- The model download, with its progress on screen
  const downloads = [];
  const noteTexts = new Set();
  let shot = false;
  const done = await followJobs(app, sid, {
    async onSample(s, ms) {
      for (const j of s.jobs.filter((x) => x.kind === "model_download")) downloads.push({ ms, id: j.id, state: j.state, progress: j.progress });
      const note = s.notes.find(([k]) => k === "model-download");
      if (note) noteTexts.add(note[1]);
      if (note && !shot && s.jobs.some((j) => j.kind === "model_download" && j.progress > 0.2)) {
        shot = true;
        await app.shot("model-download");
      }
    },
  });
  const seen = await programs.stop();
  result.importMs = Date.now() - t0;
  const ids = [...new Set(downloads.map((d) => d.id))];
  result.download = {
    jobs: ids.length,
    samples: downloads.length,
    firstMs: downloads[0]?.ms ?? null,
    lastRunningMs: downloads.filter((d) => d.state === "running").pop()?.ms ?? null,
    notes: [...noteTexts].slice(0, 5).concat(noteTexts.size > 5 ? [`… ${noteTexts.size} different lines`] : []),
    final: ids.map((id) => downloads.filter((d) => d.id === id).pop()),
  };
  log(`  model download: ${JSON.stringify(result.download)}`);
  check(ids.length >= 1, "No model_download job was seen");
  for (const id of ids) {
    const p = downloads.filter((d) => d.id === id && d.state === "running").map((d) => d.progress);
    check(p.every((v, i) => i === 0 || v >= p[i - 1]), "The download's progress went backwards", p);
    check(new Set(p).size > 3, "The download's progress did not move on screen", p);
  }
  check(result.download.final.every((d) => d.state === "done"), "A model download did not finish", result.download.final);
  check([...noteTexts].some((t) => /^downloading the speech model, once only · \d+%/.test(t)), "The download line was not shown under the player", [...noteTexts]);
  check(fs.existsSync(INT8_MODEL) && fs.existsSync(path.join(MODEL_DIR, "silero_vad.onnx")), `The model is not in ${MODEL_DIR} after the download`);
  check(!fs.existsSync(path.join(MODEL_DIR, ".downloads")) || fs.readdirSync(path.join(MODEL_DIR, ".downloads")).every((f) => !f.endsWith(".part")), "Partial downloads were left behind");

  // ---- Its own programs were used
  result.programs = Object.fromEntries([...seen].map(([k, v]) => [k, [...v]]));
  log(`  programs run: ${JSON.stringify(result.programs)}`);
  for (const name of ["ffmpeg.exe", "transcriber.exe"]) {
    check(seen.has(name), `No ${name} was seen running`, result.programs);
    check([...seen.get(name)].every((p) => p.startsWith(appDir + path.sep)), `${name} did not come from the packaged folder`, result.programs);
  }
  check([...seen.get("transcriber.exe")].every((p) => p === path.join(appDir, "speech-runtime", "transcriber.exe")), "The transcriber was not the one in speech-runtime", result.programs);
  const ready = transcriberReady(appLog(runDir));
  result.transcriber = ready;
  check(ready.length >= 1, "The app's log has no 'transcriber ready' line");

  // ---- The transcript
  const tr = await app.state((s, id) => {
    const t = s.sources[id].transcript;
    return { complete: t.complete, model: t.model, utterances: t.utterances.length, firstIndex: t.utterances[0]?.index, words: t.utterances.reduce((n, u) => n + u.tokens.filter((k) => k.kind === "word").length, 0) };
  }, sid);
  result.transcript = tr;
  log(`  transcript: ${JSON.stringify(tr)}; notices ${JSON.stringify(done.notices)}`);
  result.notices = done.notices;
  check(tr.complete && tr.utterances >= 20 && tr.words >= 200, "The transcript is missing or short", tr);
  check(tr.firstIndex === 1, "Utterances are not numbered from 1", tr);
  await app.shot("transcribed");

  // ---- Export
  const plan = await openExport(app);
  check(plan.plan && !plan.plan.blockedBy, "The export is blocked", plan);
  const out = await runExport(app, { timeoutMs: 300_000 });
  check(out.result, "The export failed", out.error);
  await app.shot("exported");
  const file = out.result.path;
  check(path.dirname(file) === exportDir && fs.existsSync(file), "The exported file is not in the chosen folder", out.result);
  const probe = ffprobe(file);
  const seconds = Number(probe.format.duration);
  const expected = manifest().fixtures["speech-2min"].durationUs / 1e6;
  result.export = { file, seconds, wallMs: out.wallMs, video: probe.streams.find((s) => s.codec_type === "video")?.codec_name, audio: probe.streams.filter((s) => s.codec_type === "audio").length };
  log(`  export: ${JSON.stringify(result.export)}`);
  check(Math.abs(seconds - expected) < 0.2 && result.export.audio >= 1, "The exported file is not the whole recording with sound", { ...result.export, expected });
  fs.rmSync(file, { force: true });
  await app.close();
}
