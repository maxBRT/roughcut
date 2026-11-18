// Scenario "edge-cache" (spec 2.4.9 "the cache can be deleted at any time and is rebuilt on
// demand", 3.3 cache "removes the least recently used sources when over the limit", 3.7 "the
// cache limit removes the least recently used source and nothing in use"; milestone 6 "cache
// size limit").
//
// 1. Cache limit reached: with a 5 MB limit in settings.json, project A (speech-2min) is
//    imported and edited, then project B is made with Ctrl+N. A's cache folder (not in use)
//    is removed; B's (in use) stays although it is over the limit by itself.
// 2. Rebuilt on demand: on the next launch A is opened from Home. Its edits are intact, it
//    plays at once from the original, and its proxy, waveform and transcript are made again.
//    B's cache, no longer in use, is removed in turn.
// 3. The cache folder deleted while the app is closed: the whole folder goes; the next launch
//    opens A from Home with its edits, and everything is made again.

import fs from "node:fs";
import path from "node:path";
import { check, sleep } from "../lib/app.mjs";
import { fixture, listFiles } from "../lib/media.mjs";
import { answerFileDialog } from "../lib/filedialog.mjs";
import { rowTable } from "../lib/edge.mjs";
import { installFrameProbe } from "../lib/probe.mjs";
import { dropFiles, waitImported, waitSaved, waitShown } from "../lib/steps.mjs";
import { settle } from "../lib/transcript.mjs";

const LIMIT = 5 * 1024 * 1024;
const clipsOf = (app) => app.state((s) => JSON.stringify(s.edit.current.clips.map((c) => [c.sourceId, c.start, c.end])));
const cachedFiles = (app, id) => listFiles(path.join(app.cacheDir, id)).map((f) => f.rel).sort();

/** Opens the Home row named `name` with the arrow keys and Enter. */
async function openByName(app, name) {
  await app.waitForState((s) => s.screen === "home" && s.projects.length > 0, null, { label: "Home" });
  const names = await app.state((s) => s.projects.map((p) => p.name));
  const want = names.indexOf(name);
  check(want >= 0, `No project named ${name} on Home`, names);
  for (let i = 0; i < names.length && (await app.state((s) => s.homeSelection)) !== want; i++) await app.key("ArrowDown");
  check((await app.state((s) => s.homeSelection)) === want, "The arrow keys did not reach the project");
  await app.key("Enter");
  await app.waitForState((s, n) => s.screen === "editor" && s.project?.name === n, name, { timeoutMs: 15_000, label: `${name} open` });
}

/** Plays one second from 1 s and returns how far the playhead got. */
async function playsFrom(app, at) {
  await app.dispatch("ui.seek", { time: at });
  await waitShown(app, at);
  await app.key("Space");
  await sleep(1000);
  await app.key("Space");
  return app.state((s) => s.playhead.time);
}

export async function run(ctx) {
  const { runDir } = ctx;
  const t = rowTable(ctx);
  const settings = { exportFolder: path.join(runDir, "work", "out"), cacheLimitBytes: LIMIT };

  let app = await ctx.launch({ settings });
  await app.eval(installFrameProbe);
  let idA;
  let idB;
  let nameA;
  let editA;

  await t.row("Cache limit reached", "3.3/3.7: the least recently used source not in use is removed; nothing in use is", async () => {
    await dropFiles(app, [fixture("speech-2min")]);
    idA = await app.state((s) => s.project.sources[0].id);
    nameA = await app.state((s) => s.project.name);
    await waitImported(app, idA);
    const filesA = cachedFiles(app, idA);
    // An edit to find again: remove 0:10–0:20 on the timeline.
    await app.key("Tab");
    await app.waitForState((s) => s.session.view === "timeline", null, { label: "the timeline" });
    for (const at of [10_000_000, 20_000_000]) {
      await app.dispatch("ui.seek", { time: at });
      await app.waitForState((s, x) => Math.abs(s.playhead.time - x) < 40_000, at, { label: "the seek" });
      await app.key("s");
    }
    await app.dispatch("ui.seek", { time: 15_000_000 });
    await app.waitForState((s) => Math.abs(s.playhead.time - 15_000_000) < 40_000, null, { label: "the seek" });
    await app.key("Delete");
    await app.waitForState((s) => s.edit.current.clips.length === 2, null, { label: "0:10–0:20 removed" });
    editA = await clipsOf(app);
    await waitSaved(app);
    const bytesA = listFiles(path.join(app.cacheDir, idA)).reduce((n, f) => n + f.size, 0);
    check(bytesA > LIMIT, "A's cache is under the limit, so the row would not test it", bytesA);

    // Project B from Ctrl+N and the real file dialog.
    const answered = answerFileDialog(app, fixture("numbered-1080p60"));
    await sleep(200);
    await app.key("Control+n");
    await answered;
    await app.waitForState((s, a) => s.screen === "editor" && s.project && s.project.sources[0].id !== a, idA, { timeoutMs: 15_000, label: "project B open" });
    idB = await app.state((s) => s.project.sources[0].id);
    await waitImported(app, idB);
    const deadline = Date.now() + 5000;
    while (fs.existsSync(path.join(app.cacheDir, idA)) && Date.now() < deadline) await sleep(100);
    const leftA = fs.existsSync(path.join(app.cacheDir, idA)) ? cachedFiles(app, idA) : null;
    const filesB = cachedFiles(app, idB);
    check(leftA === null, "A's cache was not removed although the cache is over its limit and A is not open", leftA);
    check(filesB.includes("proxy.mp4") && filesB.includes("waveform.bin"), "B's cache (in use) was removed", filesB);
    await app.shot("project-b");
    return `A's cache (${(bytesA / 1048576).toFixed(1)} MB: ${filesA.join(", ")}) removed when B was made; B's kept while open (${filesB.join(", ")})`;
  });
  await app.close();

  app = await ctx.launch({ settings });
  await app.eval(installFrameProbe);
  await t.row("A source's cache removed by the limit, opened again", "2.4.9: rebuilt on demand; edits intact; plays from the original meanwhile", async () => {
    const t0 = Date.now();
    await openByName(app, nameA);
    const edit = await clipsOf(app);
    check(edit === editA, "A's edits changed", { editA, edit });
    const playback = await app.waitForState((s, id) => s.sources[id]?.assets?.playback !== "none" && s.sources[id]?.assets?.playback, idA, { label: "A playable" });
    const reached = await playsFrom(app, 1_000_000);
    check(reached > 1_500_000, "A does not play while its cache is rebuilt", reached);
    const done = await waitImported(app, idA);
    const ms = Date.now() - t0;
    const files = cachedFiles(app, idA);
    check(["proxy.mp4", "transcript.json", "waveform.bin"].every((f) => files.includes(f)), "A's cache was not rebuilt", files);
    const words = await app.state((s, id) => s.sources[id].transcript.utterances.flatMap((u) => u.tokens).filter((k) => k.kind === "word").length, idA);
    check(words > 250, "A's transcript was not made again", words);
    const deadline = Date.now() + 5000;
    while (fs.existsSync(path.join(app.cacheDir, idB)) && Date.now() < deadline) await sleep(100);
    check(!fs.existsSync(path.join(app.cacheDir, idB)), "B's cache was not removed now that B is not open", cachedFiles(app, idB));
    await settle(app);
    await app.shot("a-rebuilt");
    return `opened with edits intact, played from the ${playback} at once (to ${(reached / 1e6).toFixed(2)} s); rebuilt in ${(ms / 1000).toFixed(1)} s (${done.jobs.join(" ")}), ${words} words; B's cache removed`;
  });
  await app.close();

  // ------------------------------------------------------------- cache folder deleted
  fs.rmSync(app.cacheDir, { recursive: true, force: true });
  check(!fs.existsSync(app.cacheDir), "The cache folder could not be deleted");
  app = await ctx.launch({ settings });
  await app.eval(installFrameProbe);
  await t.row("Cache folder deleted while the app was closed", "2.4.9: can be deleted at any time and is rebuilt on demand; edits intact", async () => {
    await openByName(app, nameA);
    const edit = await clipsOf(app);
    check(edit === editA, "A's edits changed", { editA, edit });
    const done = await waitImported(app, idA);
    const files = cachedFiles(app, idA);
    check(["proxy.mp4", "transcript.json", "waveform.bin"].every((f) => files.includes(f)), "The cache was not rebuilt", files);
    const reached = await playsFrom(app, 30_000_000);
    check(reached > 30_500_000, "A does not play after the rebuild", reached);
    await settle(app);
    await app.shot("rebuilt-after-delete");
    return `rebuilt (${done.jobs.join(" ")}): ${files.join(", ")}; edits intact; plays`;
  });
  await app.close();
  t.finish();
}
