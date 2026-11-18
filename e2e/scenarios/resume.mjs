// Scenario "resume" (spec UC8, milestone 1 "Closing and reopening the app resumes it", 1.12
// "App closed or crashed mid-edit").
//
// Import speech-2min, cut a suggestion with N and A, switch to the Timeline view, set 2x and
// move the playhead; close the window. Start the app again: the project is first on Home and
// selected, Enter opens it with the same clips, undo history, playhead, view and speed, its
// proxy, waveform and transcript are used as they are (no job runs, no cache file is
// rewritten). Then move the playhead and close the window at once, before the autosave's
// timer: the next start still opens at that position; the same for an edit (S, split).

import fs from "node:fs";
import path from "node:path";
import { check, fail, sleep } from "../lib/app.mjs";
import { fixture, listFiles } from "../lib/media.mjs";
import { installFrameProbe } from "../lib/probe.mjs";
import { dropFiles, seekTo, waitImported, waitSaved, waitShown } from "../lib/steps.mjs";

const FPS = 30;
const frame = (k) => Math.floor((k * 1e6) / FPS + 0.5);

const snapshot = (s) => ({
  projectId: s.project?.id ?? null,
  name: s.project?.name ?? null,
  clips: s.edit?.current.clips ?? null,
  undo: s.edit?.undo.length ?? null,
  redo: s.edit?.redo.length ?? null,
  view: s.session.view,
  rate: s.session.playbackRate,
  sessionPlayhead: s.session.playhead,
  playhead: s.playhead.time,
  position: s.playhead.position,
});

export async function run(ctx) {
  const { log, result } = ctx;
  const file = fixture("speech-2min");

  // ---- First launch: import and edit
  let app = await ctx.launch();
  await app.eval(installFrameProbe);
  await dropFiles(app, [file]);
  const sid = await app.state((s) => s.project.sources[0].id);
  await waitImported(app, sid);
  await app.waitForState((s, id) => s.sources[id]?.suggestions?.suggestions.length > 0, sid, { label: "suggestions" });
  await app.key("n");
  await app.waitForState((s) => s.currentSuggestion !== null, null, { label: "N to land on a suggestion" });
  await app.key("a");
  await app.waitForState((s) => s.edit.current.clips.length === 2, null, { label: "A to cut the suggestion", describe: (s) => s.edit.current.clips });
  await app.key("Tab");
  await app.waitForState((s) => s.session.view === "timeline", null, { label: "the Timeline view" });
  await app.key("3");
  await app.waitForState((s) => s.session.playbackRate === 2, null, { label: "2x" });
  log(`  after N, A, Tab, 3: ${JSON.stringify(await app.state((s) => s.playhead))}`);
  check(!(await app.state((s) => s.playhead.playing)), "Playback started by itself while editing");
  await seekTo(app, frame(1500));
  await waitSaved(app);
  const before = await app.state(snapshot);
  log(`  before closing: ${JSON.stringify(before)}`);
  check(before.undo === 1, "Expected one undo step after one cut", before);
  // The cache's "last-used" stamp (for its size limit) may change; the work it holds may not.
  const cacheWork = (dir) => listFiles(dir).filter((f) => path.basename(f.rel) !== "last-used");
  const cacheBefore = cacheWork(app.cacheDir);
  const projectFile = path.join(app.dataDir, "projects", before.projectId, "project.json");
  check(fs.existsSync(projectFile), `No project file at ${projectFile}`);
  // Suggestion calls (claude -p) the stand-in claude saw; status checks at launch do not count.
  const claudeCalls = () => {
    const log = path.join(ctx.runDir, "claude-calls.jsonl");
    if (!fs.existsSync(log)) return 0;
    return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).filter((l) => JSON.parse(l).args[0] === "-p").length;
  };
  const callsBefore = claudeCalls();
  check(callsBefore === 1, `Expected one suggestion call during the import, saw ${callsBefore}`);
  await app.shot("before-close");
  await app.close();
  log("  closed; no roughcut, ffmpeg, transcriber or claude process left");

  // ---- Second launch: Home lists it first and selected; Enter opens it as it was
  app = await ctx.launch();
  await app.eval(installFrameProbe);
  const home = await app.state((s) => ({ screen: s.screen, projects: s.projects.map((p) => ({ id: p.id, name: p.name, kept: p.keptDuration })), selection: s.homeSelection }));
  log(`  home after restart: ${JSON.stringify(home)}`);
  check(home.screen === "home", "The app did not start on Home");
  check(home.projects[0]?.id === before.projectId && home.selection === 0, "The project is not first and selected on Home", home);
  const kept = before.clips.reduce((n, c) => n + c.end - c.start, 0);
  check(home.projects[0].kept === kept, "Home shows a different kept length", { home: home.projects[0].kept, kept });
  await app.shot("home-after-restart");
  const t0 = Date.now();
  await app.key("Enter");
  await app.waitForState((s) => s.screen === "editor" && s.project !== null, null, { label: "Enter to open the project" });
  result.openMs = Date.now() - t0;
  const after = await app.state(snapshot);
  log(`  reopened in ${result.openMs} ms: ${JSON.stringify(after)}`);
  for (const k of ["projectId", "clips", "undo", "redo", "view", "rate", "sessionPlayhead", "playhead", "position"]) {
    check(JSON.stringify(after[k]) === JSON.stringify(before[k]), `After reopening, ${k} differs`, { before: before[k], after: after[k] });
  }
  const assets = await app.state((s, id) => s.sources[id]?.assets, sid);
  check(assets && assets.playback === "proxy" && assets.waveformUrl && assets.transcript === "complete" && assets.suggestions === "ready", "The reopened project's source is not ready at once", assets);
  await waitShown(app, after.playhead, FPS);
  await sleep(3000);
  const jobs = await app.state((s) => Object.values(s.jobs).map((j) => `${j.kind}:${j.state}`));
  check(jobs.length === 0, "Jobs ran when the project was reopened", jobs);
  const cacheAfter = cacheWork(app.cacheDir);
  check(
    JSON.stringify(cacheAfter.map((f) => [f.rel, f.size, f.mtimeMs])) === JSON.stringify(cacheBefore.map((f) => [f.rel, f.size, f.mtimeMs])),
    "Cache files changed when the project was reopened",
    { before: cacheBefore.map((f) => f.rel), after: cacheAfter.map((f) => f.rel) },
  );
  check(claudeCalls() === callsBefore, "claude was asked for suggestions again on reopening");
  await app.shot("reopened");

  // Undo history survived: Ctrl+Z restores the cut suggestion.
  await app.key("Control+z");
  await app.waitForState((s) => s.edit.current.clips.length === 1, null, { label: "Ctrl+Z to undo the cut made before the restart" });
  await app.key("Control+Shift+z");
  await app.waitForState((s) => s.edit.current.clips.length === 2, null, { label: "Ctrl+Shift+Z to redo it" });

  // ---- Move the playhead and close at once (before the 2 s autosave timer)
  await waitSaved(app);
  await seekTo(app, frame(2400));
  const moved = await app.state((s) => ({ playhead: s.playhead.time, position: s.playhead.position, pending: s.save.pending }));
  log(`  moved to ${moved.playhead} and closing at once (save pending: ${moved.pending})`);
  await app.close();
  app = await ctx.launch();
  await app.eval(installFrameProbe);
  await app.key("Enter");
  await app.waitForState((s) => s.screen === "editor" && s.project !== null, null, { label: "Enter to open the project again" });
  const third = await app.state(snapshot);
  log(`  third start: playhead ${third.playhead}, ${JSON.stringify(third.position)}`);
  result.closeRightAfterMove = { moved: moved.playhead, reopened: third.playhead };
  check(third.playhead === moved.playhead && JSON.stringify(third.position) === JSON.stringify(moved.position), "Closing the window right after moving the playhead lost the new position", { moved, reopened: third.position });
  check(JSON.stringify(third.clips) === JSON.stringify(before.clips), "The clips changed across restarts", third.clips);

  // ---- An edit made right before closing is kept too (S splits at the playhead)
  await waitShown(app, third.playhead, FPS);
  await app.key("s");
  await app.waitForState((s) => s.edit.current.clips.length === 3, null, { label: "S to split", describe: (s) => s.edit.current.clips });
  const split = await app.state((s) => s.edit.current.clips);
  await app.close();
  app = await ctx.launch();
  await app.key("Enter");
  await app.waitForState((s) => s.screen === "editor" && s.project !== null, null, { label: "Enter to open the project a fourth time" });
  const fourth = await app.state(snapshot);
  check(JSON.stringify(fourth.clips) === JSON.stringify(split), "Closing the window right after an edit lost the edit", { split, reopened: fourth.clips });
  check(fourth.undo === 2, `Expected two undo steps (the cut and the split), found ${fourth.undo}`);
  log("  an edit made right before closing was kept");

  const errors = app.consoleErrors();
  if (errors.length) fail("Console errors", errors);
  await app.close();
}
