// Runs the end-to-end scenarios against the real app.
//
//   npm run e2e                 every scenario, in order
//   npm run e2e -- play resume  only those
//
// Each scenario starts from empty data, cache and WebView2 folders under
// .cache-dev/e2e/<run id>/<scenario>/ (screenshots in shots/, measurements in result.json).
// Exits non-zero when any scenario fails. The app is always closed afterwards and no
// roughcut, ffmpeg, transcriber or claude process is left.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { App, E2E_ROOT, TestFailure, freshRunDir, killAll, watchedProcesses } from "./lib/app.mjs";

const ORDER = ["import", "play", "two-sources", "resume", "cut-by-text", "undo", "find", "suggestions", "autosave", "typing", "timeline", "export", "export-cases", "whole-job", "edge-sources", "edge-speech", "edge-formats", "edge-cache", "edge-close", "keys"];
// Run only when named: an hour of 4K made from the fixtures (about 0.5 GB, deleted afterwards);
// the packaged app's first run and its start with the speech files installed (both need
// ROUGHCUT_E2E_APP=dist-app/Roughcut/Roughcut.exe; see scenarios/first-run.mjs).
const ON_REQUEST = ["speed-hour", "first-run", "installed-start"];
const scenarioDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "scenarios");

const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const keep = process.argv.includes("--keep");
const unknown = wanted.filter((w) => !ORDER.includes(w) && !ON_REQUEST.includes(w));
if (unknown.length) {
  console.error(`Unknown scenario(s): ${unknown.join(", ")}. Known: ${[...ORDER, ...ON_REQUEST].join(", ")}`);
  process.exit(2);
}
const names = wanted.length ? wanted : ORDER;
const runId = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);

const before = watchedProcesses();
if (before.length) {
  console.error("Refusing to run: these processes are already running:", before);
  process.exit(2);
}

const results = [];
for (const name of names) {
  const mod = await import(pathToFileURL(path.join(scenarioDir, `${name}.mjs`)).href);
  const runDir = freshRunDir(name, runId);
  const t0 = Date.now();
  const lines = [];
  const log = (...a) => {
    const line = a.join(" ");
    lines.push(line);
    console.log(line);
  };
  log(`\n=== ${name} (${runDir})`);
  const apps = [];
  const ctx = {
    runDir,
    log,
    result: {},
    /** Starts a new launch of the app on this scenario's folders. */
    async launch(opts) {
      const app = new App(runDir, { log, ...opts });
      apps.push(app);
      await app.start();
      log(`  app ready ${app.readyMs} ms after launch (port ${app.port})`);
      return app;
    },
  };
  let error = null;
  try {
    await mod.run(ctx);
  } catch (e) {
    error = e;
  }
  for (const app of apps) {
    if (error && app.page) {
      try {
        log(`  failure screenshot: ${await app.shot("failure")}`);
      } catch {
        /* the window is gone */
      }
    }
    if (app.proc) {
      try {
        await app.close();
      } catch (e) {
        error ??= e;
      }
    }
    try {
      const starts = app.checkTranscriberDevice();
      if (starts.length) {
        ctx.result.transcriberStarts = [...(ctx.result.transcriberStarts ?? []), ...starts];
        log(`  transcriber starts: ${starts.map((r) => `${r.device}${r.fallback ? " (fallback)" : ""}`).join(", ")}${app.expectGpu ? "" : " (GPU not required for this launch)"}`);
      }
    } catch (e) {
      error ??= e;
    }
    const errs = app.consoleErrors();
    if (errs.length && !error) error = new TestFailure(`Console errors in the app:\n${errs.map((e) => `  ${e.type}: ${e.text}`).join("\n")}`);
  }
  killAll();
  const left = watchedProcesses();
  if (left.length && !error) error = new TestFailure(`Processes left: ${JSON.stringify(left)}`);
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  ctx.result.passed = !error;
  ctx.result.seconds = Number(seconds);
  if (error) ctx.result.error = String(error.stack ?? error);
  fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(ctx.result, null, 2));
  fs.writeFileSync(path.join(runDir, "log.txt"), lines.join("\n"));
  if (error) console.log(`FAIL ${name} (${seconds} s): ${error instanceof TestFailure ? error.message : error.stack}`);
  else console.log(`PASS ${name} (${seconds} s)`);
  results.push({ name, passed: !error, seconds });
  if (!error && !keep) {
    // The cache holds proxies and audio; keep the shots, logs and results.
    for (const home of new Set([runDir, ...apps.map((a) => a.home)])) {
      for (const sub of ["cache", "work", "webview"]) fs.rmSync(path.join(home, sub), { recursive: true, force: true });
    }
  }
}

console.log("\nSummary:");
for (const r of results) console.log(`  ${r.passed ? "PASS" : "FAIL"} ${r.name} (${r.seconds} s)`);
console.log(`Run folder: ${path.join(E2E_ROOT, runId)}`);
process.exit(results.every((r) => r.passed) ? 0 : 1);
