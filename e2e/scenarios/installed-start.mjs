// Scenario "installed-start": the packaged app started with no ROUGHCUT_ variable at all, after
// npm run install-speech put the speech model and the GPU runtime under
// %LOCALAPPDATA%\Roughcut\speech (what the user's first real start finds).
//
//   ROUGHCUT_E2E_APP=dist-app/Roughcut/Roughcut.exe npm run e2e -- installed-start
//
// The app must transcribe fixtures/out/speech-2min.mp4 on the GPU with the transcriber from
// runtime\gpu, start no model download and change no file of the model or the runtime. It uses
// the user's real data and cache folders (%APPDATA%\Roughcut, %LOCALAPPDATA%\Roughcut\cache),
// so it refuses to run when they already hold a project, and removes its project and the
// cache it made through the app (Home's remove, clear_cache) before it closes. Apart from
// ROUGHCUT_CLAUDE (rc-suggest's stand-in, App `bare`) no ROUGHCUT_ variable is set.

import fs from "node:fs";
import path from "node:path";
import { check } from "../lib/app.mjs";
import { fixture } from "../lib/media.mjs";
import { FP32_MODEL, GPU_RUNTIME, INT8_MODEL, MODEL_DIR, appLog, followJobs, packagedAppDir, snapshot, startProgramSampler, transcriberReady } from "../lib/packaged.mjs";

const DATA = path.join(process.env.APPDATA ?? "", "Roughcut");
const CACHE = path.join(process.env.LOCALAPPDATA ?? "", "Roughcut", "cache");
const entries = (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []);

export async function run(ctx) {
  const { log, result, runDir } = ctx;
  const appDir = packagedAppDir().toLowerCase();
  for (const f of [FP32_MODEL, INT8_MODEL, path.join(GPU_RUNTIME, "transcriber.exe"), path.join(GPU_RUNTIME, "onnxruntime_providers_cuda.dll")]) {
    check(fs.existsSync(f), `${f} is missing (npm run install-speech)`);
  }
  check(entries(path.join(DATA, "projects")).length === 0, `${DATA}\\projects already holds projects; this scenario would share the user's real data folder with them`);
  const cacheBefore = new Set(entries(CACHE));
  const before = { models: snapshot(MODEL_DIR), runtime: snapshot(GPU_RUNTIME) };

  const app = await ctx.launch({ bare: "defaults" });
  result.launchToReadyMs = app.readyMs;
  const programs = startProgramSampler();
  const t0 = Date.now();
  await app.dispatch("ui.dropFiles", { paths: [fixture("speech-2min")] });
  await app.waitForState((s) => s.screen === "editor" && s.project?.sources.length === 1, null, { timeoutMs: 15_000, label: "the editor to open" });
  const { sid, projectId } = await app.state((s) => ({ sid: s.project.sources[0].id, projectId: s.project.id }));
  const downloads = new Set();
  let firstTextMs = null;
  const done = await followJobs(app, sid, {
    timeoutMs: 300_000,
    onSample(s, ms) {
      for (const j of s.jobs.filter((x) => x.kind === "model_download")) downloads.add(j.id);
      if (firstTextMs === null && s.utterances > 0) firstTextMs = ms;
    },
  });
  const seen = await programs.stop();
  result.importMs = Date.now() - t0;
  result.firstTextMs = firstTextMs;
  result.programs = Object.fromEntries([...seen].map(([k, v]) => [k, [...v]]));
  result.transcriber = transcriberReady(appLog(runDir));
  result.notices = done.notices;
  log(`  import ${result.importMs} ms, first text ${firstTextMs} ms; programs ${JSON.stringify(result.programs)}; transcriber ${JSON.stringify(result.transcriber)}`);
  await app.shot("transcribed");

  check(downloads.size === 0, "A model download was started although the model is installed", [...downloads]);
  check(result.transcriber.length >= 1, "The app's log has no 'transcriber ready' line");
  check(result.transcriber.every((r) => r.device === "gpu" && !r.fallback), "The transcript was not made on the GPU", result.transcriber);
  check(seen.has("transcriber.exe") && [...seen.get("transcriber.exe")].every((p) => p === path.join(GPU_RUNTIME, "transcriber.exe").toLowerCase()), "The transcriber did not run from the installed GPU runtime", result.programs);
  check(seen.has("ffmpeg.exe") && [...seen.get("ffmpeg.exe")].every((p) => p.startsWith(appDir + path.sep)), "ffmpeg did not come from the packaged folder", result.programs);
  const after = { models: snapshot(MODEL_DIR), runtime: snapshot(GPU_RUNTIME) };
  check(JSON.stringify(after) === JSON.stringify(before), "Files of the installed model or runtime changed", { before, after });
  const tr = await app.state((s, id) => ({ complete: s.sources[id].transcript.complete, utterances: s.sources[id].transcript.utterances.length }), sid);
  result.transcript = tr;
  check(tr.complete && tr.utterances >= 20, "The transcript is missing or short", tr);

  // ---- Leave the user's folders as they were: remove the project, then its cache.
  await app.dispatch("ui.goHome");
  await app.waitForState((s) => s.screen === "home", null, { label: "Home" });
  await app.eval(async (id) => {
    await window.__TAURI_INTERNALS__.invoke("remove_project", { projectId: id });
    await window.__TAURI_INTERNALS__.invoke("clear_cache");
  }, projectId);
  await app.close();
  const leftProjects = entries(path.join(DATA, "projects"));
  const leftCache = entries(CACHE).filter((e) => !cacheBefore.has(e));
  result.leftBehind = { data: entries(DATA), projects: leftProjects, cache: leftCache };
  log(`  left behind: ${JSON.stringify(result.leftBehind)}`);
  check(leftProjects.length === 0, "The project was not removed from the user's data folder", leftProjects);
  check(leftCache.length === 0, "The cache folders of the test recording were not removed", leftCache);
}
