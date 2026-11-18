// Scenario "autosave" (spec 1.8 "Everywhere": there is no save command, closing the app loses
// nothing; 1.12 "App closed or crashed mid-edit": reopening restores the project to the last
// edit).
//
// On speech-2min: each edit is in project.json on disk a moment after it is made (measured).
// Then the app is killed abruptly (TerminateProcess, no close request) at three moments: right
// after an edit has been saved, right after a burst of edits (before the save timer), and while
// the transcript is still being made (an import under way). After each restart the project is
// on Home, opens cleanly with Enter, and holds every edit except at most the last moment's.

import fs from "node:fs";
import path from "node:path";
import { check, fail, sleep } from "../lib/app.mjs";
import { fixture, listFiles } from "../lib/media.mjs";
import { installFrameProbe } from "../lib/probe.mjs";
import { dropFiles, waitImported } from "../lib/steps.mjs";
import { settle } from "../lib/transcript.mjs";

const clipsOf = (edit) => JSON.stringify(edit.current.clips.map((c) => [c.sourceId, c.start, c.end]));

export async function run(ctx) {
  const { log, result } = ctx;
  let app = await ctx.launch();
  await app.eval(installFrameProbe);
  await dropFiles(app, [fixture("speech-2min")]);
  const sid = await app.state((s) => s.project.sources[0].id);
  await waitImported(app, sid);
  const projectId = await app.state((s) => s.project.id);
  const file = path.join(app.dataDir, "projects", projectId, "project.json");
  const onDisk = () => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      return { unreadable: String(e) };
    }
  };
  const storeClips = () => app.state((s) => JSON.stringify(s.edit.current.clips.map((c) => [c.sourceId, c.start, c.end])));
  /** Waits until project.json holds the store's clips; returns how long that took. */
  const waitOnDisk = async (what, timeoutMs = 3000) => {
    const want = await storeClips();
    const t0 = Date.now();
    for (;;) {
      const p = onDisk();
      if (p.edit && clipsOf(p.edit) === want) return Date.now() - t0;
      if (Date.now() - t0 > timeoutMs) fail(`${what}: the edit is not on disk ${timeoutMs} ms after it was made`, { want, disk: p.edit ? clipsOf(p.edit) : p });
      await sleep(20);
    }
  };

  // ---- Each edit is on disk a moment after it is made
  const delays = [];
  for (const keys of [["ArrowRight", "ArrowRight", "Delete"], ["Control+ArrowDown", "Delete"], ["Control+z"], ["Control+Shift+z"], ["n", "a"]]) {
    for (const k of keys) await app.key(k);
    await settle(app);
    delays.push(await waitOnDisk(`After ${keys.join(" ")}`));
  }
  log(`  edit to disk: ${delays.join(", ")} ms`);
  result.editToDiskMs = delays;
  check(Math.max(...delays) < 1500, "An edit took more than 1.5 s to reach the disk", delays);
  const disk = onDisk();
  check(disk.edit.undo.length === (await app.state((s) => s.edit.undo.length)), "The undo history on disk differs from the app's", { disk: disk.edit.undo.length });

  // ---- Kill right after an edit has been saved: nothing is lost
  await app.key("Control+ArrowDown");
  await app.key("Delete");
  await settle(app);
  await waitOnDisk("The edit before the first kill");
  const saved = await storeClips();
  const undoSaved = await app.state((s) => s.edit.undo.length);
  await app.kill();
  log("  killed after a saved edit");
  app = await ctx.launch();
  let home = await app.state((s) => ({ screen: s.screen, projects: s.projects.map((p) => p.id), notices: s.notices.map((n) => n.text) }));
  check(home.screen === "home" && home.projects[0] === projectId, "After the kill the project is not first on Home", home);
  check(home.notices.length === 0, "Notices after restarting from a kill", home.notices);
  await app.key("Enter");
  await app.waitForState((s) => s.screen === "editor" && s.project !== null, null, { label: "Enter to open the project after the kill" });
  check((await storeClips()) === saved, "A saved edit was lost when the app was killed", { saved, now: await storeClips() });
  check((await app.state((s) => s.edit.undo.length)) === undoSaved, "The undo history was lost when the app was killed");
  await app.shot("reopened-after-kill");

  // ---- Kill right after a burst of edits, before the save timer: at most the burst's last moment is lost
  await app.waitForState((s, id) => s.sources[id]?.assets?.transcript === "complete", sid, { label: "the transcript after reopening" });
  const states = [await storeClips()];
  for (const keys of [["Control+ArrowDown", "Delete"], ["Control+ArrowDown", "Shift+ArrowRight", "Delete"], ["Control+ArrowDown", "Delete"]]) {
    for (const k of keys) await app.key(k);
    await settle(app);
    states.push(await storeClips());
  }
  await waitOnDisk("The burst's edits").catch(() => undefined); // may or may not have been written yet; the kill below is immediate
  await app.key("Control+ArrowDown");
  await app.key("Delete");
  await settle(app);
  states.push(await storeClips());
  const killedAt = await app.kill();
  const diskAfter = onDisk();
  check(diskAfter.edit, "project.json is unreadable after the kill", diskAfter);
  const kept = states.indexOf(clipsOf(diskAfter.edit));
  log(`  killed ${killedAt ? "right after" : "after"} a burst: disk holds edit ${kept} of ${states.length - 1}`);
  check(kept >= states.length - 2, "More than the last edit was lost when the app was killed right after it", { kept, of: states.length - 1 });
  result.burstKept = { kept, of: states.length - 1 };
  app = await ctx.launch();
  await app.key("Enter");
  await app.waitForState((s) => s.screen === "editor" && s.project !== null, null, { label: "Enter to open the project after the second kill" });
  const reopened = await storeClips();
  check(reopened === states[kept], "The project did not open as it was on disk", { reopened, disk: states[kept] });
  const errs = app.consoleErrors();
  check(errs.length === 0, "Console errors after reopening a killed project", errs);
  const leftovers = listFiles(path.dirname(file)).map((f) => f.rel).filter((r) => !/^project\.json(\.bak)?$/.test(r));
  check(leftovers.length === 0, "Half-written files are left beside the project file", leftovers);

  // ---- Kill during an import (proxy, transcript and suggestions still being made)
  await app.key("Control+z");
  await settle(app);
  await waitOnDisk("The undo before the import");
  const beforeAdd = await storeClips();
  await dropFiles(app, [fixture("numbered-4k-h264")]);
  await app.waitForState((s) => Object.values(s.jobs).some((j) => j.state === "running"), null, { label: "the second source's import to be running" });
  await waitOnDisk("Adding footage");
  const withSecond = await storeClips();
  check(withSecond !== beforeAdd, "Adding footage did not change the clips");
  await app.kill();
  log("  killed during an import");
  app = await ctx.launch();
  await app.key("Enter");
  await app.waitForState((s) => s.screen === "editor" && s.project !== null, null, { label: "Enter to open the project after the third kill" });
  check((await storeClips()) === withSecond, "The added footage was lost when the app was killed during its import");
  const second = await app.state((s) => s.project.sources[1]?.id);
  await waitImported(app, second, 240_000);
  log("  the interrupted import finished after the restart");
  await app.shot("import-resumed");
  const tmp = listFiles(app.cacheDir).filter((f) => /\.part|\.tmp|partial/i.test(f.rel));
  check(tmp.length === 0, "Unfinished cache files are left after the import resumed", tmp.map((f) => f.rel));

  const errors = app.consoleErrors();
  if (errors.length) fail("Console errors", errors);
  await app.close();
}
