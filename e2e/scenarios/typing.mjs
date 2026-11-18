// Scenario "typing" (spec 1.11 "Any cut, restore, trim or undo: instant", 2.6 "Any edit:
// under one frame").
//
// An hour-long recording (speech-2min looped 28 times with FFmpeg, no re-encode, made in the
// scenario's work folder and deleted afterwards) is imported and transcribed for real. Then,
// at the start, the middle and the end of the hour, real key presses move the caret (word,
// line, sentence, paragraph) and cut, undo and redo. For each press the page records the time
// from the key event to the first animation frame after it (the frame that paints the change)
// and to just after that paint, and checks that the change is on screen in that frame.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { check, fail, sleep } from "../lib/app.mjs";
import { fixture } from "../lib/media.mjs";
import { dropFiles, waitImported } from "../lib/steps.mjs";
import { settle } from "../lib/transcript.mjs";

const LOOPS = 28;

/** Installs the key-to-screen probe in the page. */
function installLatencyProbe() {
  if (window.__lat) return;
  const L = (window.__lat = { on: false, samples: [] });
  const caretOk = (focus) => {
    const c = document.querySelector("[data-view=transcript] [data-caret]");
    if (!c) return false;
    for (let n = c.nextElementSibling; n; n = n.nextElementSibling) if (n.dataset?.pos !== undefined) return Number(n.dataset.pos) === focus;
    for (let n = c.previousElementSibling; n; n = n.previousElementSibling) if (n.dataset?.pos !== undefined) return Number(n.dataset.pos) === focus - 1;
    return false;
  };
  window.addEventListener(
    "keydown",
    (e) => {
      if (!L.on || ["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const t0 = e.timeStamp;
      const s0 = window.__roughcut.getState();
      const sel0 = s0.selection;
      const edit0 = s0.edit.current;
      const key = `${e.ctrlKey ? "Ctrl+" : ""}${e.shiftKey ? "Shift+" : ""}${e.key}`;
      requestAnimationFrame(() => {
        const tRaf = performance.now();
        const s = window.__roughcut.getState();
        const moved = s.selection.focus !== sel0.focus || s.selection.anchor !== sel0.anchor;
        const edited = s.edit.current !== edit0;
        const onScreen = caretOk(s.selection.focus) || s.selection.anchor !== s.selection.focus;
        setTimeout(() => L.samples.push({ key, toFrame: tRaf - t0, toPainted: performance.now() - t0, moved, edited, onScreen }), 0);
      });
    },
    true,
  );
}

const stats = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { n: v.length, median: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +v[v.length - 1].toFixed(1) };
};

export async function run(ctx) {
  const { log, result } = ctx;
  const work = path.join(ctx.runDir, "work");
  const hour = path.join(work, "speech-hour.mp4");
  const t0 = Date.now();
  execFileSync("ffmpeg", ["-v", "error", "-y", "-stream_loop", String(LOOPS - 1), "-i", fixture("speech-2min"), "-c", "copy", hour], { stdio: "inherit" });
  log(`  made a ${(fs.statSync(hour).size / 1e6).toFixed(0)} MB hour-long file in ${Date.now() - t0} ms`);

  const app = await ctx.launch();
  try {
    const tDrop = Date.now();
    await dropFiles(app, [hour]);
    const sid = await app.state((s) => s.project.sources[0].id);
    const dur = await app.state((s) => s.project.sources[0].media.duration);
    check(dur > 59 * 60e6, `The looped file is ${dur / 60e6} min, not an hour`);
    await app.waitForState((s, id) => (s.sources[id]?.transcript?.utterances?.length ?? 0) > 0, sid, { timeoutMs: 60_000, label: "the first text of the hour", pollMs: 50 });
    result.hourFirstTextMs = Date.now() - tDrop;
    await app.waitForState((s, id) => s.sources[id]?.transcript?.complete, sid, { timeoutMs: 600_000, label: "the hour's transcript", pollMs: 500 });
    result.hourTranscriptMs = Date.now() - tDrop;
    const words = await app.state((s) => s.layout.tokens.length);
    log(`  hour: first text after ${result.hourFirstTextMs} ms, transcript complete after ${result.hourTranscriptMs} ms, ${words} tokens`);
    check(words > 7000, `Expected the hour to have more than 7000 tokens, it has ${words}`);

    await app.eval(installLatencyProbe);
    const measure = async (where) => {
      const keys = [
        ...Array(12).fill("ArrowRight"),
        ...Array(6).fill("ArrowDown"),
        ...Array(4).fill("ArrowUp"),
        ...Array(6).fill("Control+ArrowRight"),
        ...Array(6).fill("Control+ArrowDown"),
        ...Array(4).fill("Control+ArrowUp"),
        "Shift+ArrowRight", "Shift+ArrowRight", "Delete",
        "ArrowRight", "Shift+ArrowRight", "Delete",
        "Control+ArrowDown", "Shift+ArrowRight", "Shift+ArrowRight", "Shift+ArrowRight", "Backspace",
        "Control+z", "Control+z", "Control+z",
        "Control+Shift+z", "Control+Shift+z", "Control+Shift+z",
        "Control+z", "Control+z", "Control+z",
      ];
      await app.eval(() => {
        window.__lat.samples.length = 0;
        window.__lat.on = true;
      });
      for (const k of keys) {
        await app.key(k);
        await sleep(120); // one press at a time: each is measured on its own
      }
      await settle(app);
      await sleep(100);
      const samples = await app.eval(() => {
        window.__lat.on = false;
        return window.__lat.samples.slice();
      });
      check(samples.length === keys.length, `${where}: ${samples.length} of ${keys.length} key presses were measured`);
      const stale = samples.filter((s) => !(s.moved || s.edited) || !s.onScreen);
      if (stale.length) fail(`${where}: some key presses were not on screen in the first frame after them`, stale);
      return samples;
    };

    const all = [];
    const places = [
      ["start", 0],
      ["middle", Math.round(dur / 2)],
      ["end", dur - 60e6],
    ];
    for (const [where, at] of places) {
      await app.dispatch("ui.seek", { time: at });
      await app.waitForState((s, t) => Math.abs(s.playhead.time - t) < 100_000, at, { label: `the seek to the ${where}` });
      await sleep(500);
      const s = await measure(where);
      for (const x of s) all.push({ ...x, where });
      await app.shot(`typing-${where}`);
    }
    const kind = (k) => (k.endsWith("Delete") || k.endsWith("Backspace") ? "cut" : k.includes("+z") || k.includes("+Z") ? "undo/redo" : k.startsWith("Shift+") ? "select" : "move");
    const by = {};
    for (const x of all) (by[kind(x.key)] ??= []).push(x);
    const report = {};
    for (const [k, xs] of Object.entries(by)) report[k] = { toFrame: stats(xs.map((x) => x.toFrame)), toPainted: stats(xs.map((x) => x.toPainted)) };
    report.all = { toFrame: stats(all.map((x) => x.toFrame)), toPainted: stats(all.map((x) => x.toPainted)) };
    const refresh = await app.eval(() => new Promise((r) => {
      const ts = [];
      const f = (t) => (ts.push(t), ts.length < 61 ? requestAnimationFrame(f) : r((ts[60] - ts[0]) / 60));
      requestAnimationFrame(f);
    }));
    log(`  display refresh ${refresh.toFixed(1)} ms`);
    for (const [k, v] of Object.entries(report)) log(`  ${k.padEnd(9)} key to frame ${JSON.stringify(v.toFrame)}  key to painted ${JSON.stringify(v.toPainted)}`);
    result.refreshMs = refresh;
    result.latency = report;
    result.slowest = [...all].sort((a, b) => b.toPainted - a.toPainted).slice(0, 5);
    // Instant: the change is drawn in the frame after the key press. Allow one refresh for the
    // wait to that frame plus the work, and a few slow ones (garbage collection, the OS).
    check(report.all.toFrame.median <= refresh + 8, "Key presses are not drawn in the next frame (median)", report.all);
    check(report.all.toPainted.p95 <= 50, "One key press in twenty takes longer than 50 ms to reach the screen", report.all);
    const errors = app.consoleErrors();
    if (errors.length) fail("Console errors", errors);
  } finally {
    await app.close();
    fs.rmSync(hour, { force: true });
  }
}
