// Scenario "speed-hour" (spec 1.11 / 2.6 speed budget, milestone 6 "every target in 1.11 is
// measured on this PC and recorded"). Run only when named: npm run e2e -- speed-hour
// [--real-claude].
//
// A one-hour 4K source is made from the fixtures by stream copy (numbered-4k-h264's picture
// looped, speech-2min's sound looped; about 0.5 GB, deleted afterwards) and imported into the
// real app. Measured against the targets:
//   launch to Home; drop to editor; drop to playable (the original plays); first text;
//   transcript complete; proxy ready; suggestions after the transcript (the real claude only
//   with --real-claude: ONE call on the user's subscription; otherwise rc-suggest's stand-in);
//   memory of the app and every program it started (peak while importing, and after);
//   then about 300 cuts made with the keyboard (time from key to the painted change for each),
//   scrolling the transcript with the mouse wheel (frame times), zooming the timeline in and out
//   (key to painted, frame times), and the export of the result (times real time, ffprobe).
// result.json holds every figure and `table`, the target against the measurement.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, fail, sleep } from "../lib/app.mjs";
import { countFrames, ffprobe, fixture } from "../lib/media.mjs";
import { ffmpeg } from "../lib/edge.mjs";
import { openExport, runExport } from "../lib/exporting.mjs";
import { startMemorySampler, summariseMemory } from "../lib/memory.mjs";
import { installFrameProbe } from "../lib/probe.mjs";
import { dropFiles } from "../lib/steps.mjs";
import { settle } from "../lib/transcript.mjs";

const HOUR_S = 3600;
const CUTS = 300;
const REAL_CLAUDE = process.env.ROUGHCUT_REAL_CLAUDE || path.join(os.homedir(), ".local", "bin", "claude.exe");

/** Key-to-screen probe: for each key press, the time to the next animation frame and to just after it is painted. */
function installKeyProbe() {
  if (window.__kp) return;
  const K = (window.__kp = { on: false, samples: [] });
  window.addEventListener(
    "keydown",
    (e) => {
      if (!K.on || ["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const t0 = e.timeStamp;
      const s0 = window.__roughcut.getState();
      const edit0 = s0.edit?.current;
      const zoom0 = s0.zoom;
      const key = `${e.ctrlKey ? "Ctrl+" : ""}${e.shiftKey ? "Shift+" : ""}${e.key}`;
      const sel0 = { ...s0.selection };
      const undo0 = s0.edit?.undo.length ?? 0;
      requestAnimationFrame(() => {
        const tRaf = performance.now();
        const s = window.__roughcut.getState();
        const changed = s.edit?.current !== edit0 || s.zoom !== zoom0;
        setTimeout(() => {
          const sample = { key, toFrame: tRaf - t0, toPainted: performance.now() - t0, changed, sel0 };
          K.samples.push(sample);
          // Whether it happened at all (later than the first frame, or never).
          setTimeout(() => {
            const s2 = window.__roughcut.getState();
            sample.changedLater = s2.edit?.current !== edit0 || s2.zoom !== zoom0;
            sample.undoDelta = (s2.edit?.undo.length ?? 0) - undo0;
            if (!sample.changed) {
              const toks = s.layout?.tokens ?? [];
              const a = Math.min(sel0.anchor, sel0.focus);
              const b = Math.max(sel0.anchor, sel0.focus);
              sample.selected = toks.slice(a, Math.max(b, a + 1)).map((t) => `${t.token.kind === "word" ? t.token.text : "<" + t.token.kind + ">"}${t.keep === true ? "" : ":" + t.keep}`);
            }
          }, 300);
        }, 0);
      });
    },
    true,
  );
}

/** Records animation-frame times until stopped (window.__fr.stop() returns the intervals). */
function startFrameRecorder() {
  const R = (window.__fr = { ts: [], on: true });
  const f = (t) => {
    R.ts.push(t);
    if (R.on) requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
  R.stop = () => {
    R.on = false;
    const d = [];
    for (let i = 1; i < R.ts.length; i++) d.push(R.ts[i] - R.ts[i - 1]);
    return d;
  };
}

const stats = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { n: v.length, median: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +v[v.length - 1].toFixed(1) };
};

export async function run(ctx) {
  const { log, result, runDir } = ctx;
  const realClaude = process.argv.includes("--real-claude");
  const work = path.join(runDir, "work");
  const out = path.join(work, "out");
  const hour = path.join(work, "weekly update, one hour 4K.mp4");
  const table = (result.table = []);
  const row = (moment, target, measured, pass, note = "") => {
    table.push({ moment, target, measured, pass, note });
    log(`  ${pass ? "MEETS" : "MISSES"} ${moment}: ${measured} (target ${target})${note ? ` — ${note}` : ""}`);
  };

  // ---------------------------------------------------------------- the hour of 4K
  let t0 = Date.now();
  ffmpeg([
    "-stream_loop", "-1", "-i", fixture("numbered-4k-h264"),
    "-stream_loop", "-1", "-i", fixture("speech-2min"),
    "-map", "0:v", "-map", "1:a", "-c", "copy", "-t", String(HOUR_S), "-movflags", "+faststart", hour,
  ]);
  const probe = ffprobe(hour);
  const v = probe.streams.find((s) => s.codec_type === "video");
  log(`  made ${path.basename(hour)}: ${(fs.statSync(hour).size / 1e6).toFixed(0)} MB, ${v.width}x${v.height} ${v.codec_name}, ${Number(probe.format.duration).toFixed(1)} s, in ${Date.now() - t0} ms`);
  check(v.width === 3840 && Math.abs(Number(probe.format.duration) - HOUR_S) < 2, "The hour-long source is not an hour of 4K", { w: v.width, d: probe.format.duration });

  const env = realClaude ? { ROUGHCUT_CLAUDE: REAL_CLAUDE, RC_STANDIN_REPLIES: "", RC_STANDIN_LOG: "" } : {};
  if (realClaude) check(fs.existsSync(REAL_CLAUDE), `The installed claude is not at ${REAL_CLAUDE}`);
  const app = await ctx.launch({ env, settings: { exportFolder: out } });
  const mem = startMemorySampler(app.proc.pid, path.join(runDir, "memory.jsonl"), 2000);
  try {
    row("Launch to Home", "under 2 s", `${(app.readyMs / 1000).toFixed(2)} s`, app.readyMs < 2000, "process start to the store ready on Home");
    await app.eval(installFrameProbe);
    await sleep(3000); // a baseline memory sample with nothing open
    const idleMem = summariseMemory(mem.read());

    // ---------------------------------------------------------------- import
    const tDrop = Date.now();
    const toEditor = await dropFiles(app, [hour]);
    const sid = await app.state((s) => s.project.sources[0].id);
    await app.waitForState((s, id) => s.sources[id]?.assets?.playback && s.sources[id].assets.playback !== "none", sid, { timeoutMs: 30_000, label: "a playback address", pollMs: 20 });
    // Playable means it plays: Space, and the picture moves.
    await app.waitFor(() => [...document.querySelectorAll("video[data-player-slot]")].some((x) => x.readyState >= 2), null, { timeoutMs: 30_000, label: "the first frame of the original", pollMs: 20 });
    const tPlayable = Date.now() - tDrop;
    const pb = await app.state((s, id) => s.sources[id].assets.playback, sid);
    await app.key("Space");
    await sleep(1000);
    await app.key("Space");
    const moved = await app.state((s) => s.playhead.time);
    check(moved > 500_000, "The original did not play right after the drop", moved);
    row("Drop to editor", "(part of 'drop to playable')", `${(toEditor / 1000).toFixed(2)} s`, toEditor < 5000);
    row("Drop to playable", "under 5 s", `${(tPlayable / 1000).toFixed(2)} s (playing the ${pb})`, tPlayable < 5000);

    await app.waitForState((s, id) => (s.sources[id]?.transcript?.utterances?.length ?? 0) > 0, sid, { timeoutMs: 120_000, label: "the first text", pollMs: 100 });
    const tFirst = Date.now() - tDrop;
    row("First transcript text", "under 30 s", `${(tFirst / 1000).toFixed(1)} s`, tFirst < 30_000);
    await app.shot("first-text");

    let tTranscript = null;
    let tProxy = null;
    let tSuggest = null;
    const deadline = Date.now() + 40 * 60_000;
    let lastLog = 0;
    for (;;) {
      const st = await app.state(
        (s, id) => ({
          tx: s.sources[id]?.transcript?.complete === true,
          proxy: s.sources[id]?.assets?.playback === "proxy",
          sug: !!s.sources[id]?.suggestions?.claudeModel,
          sugErr: s.sources[id]?.suggestionsError?.code ?? null,
          jobs: Object.values(s.jobs).filter((j) => j.sourceId === id).map((j) => `${j.kind}:${j.state}:${Math.round(j.progress * 100)}%`),
        }),
        sid,
      );
      const now = Date.now() - tDrop;
      if (st.tx && tTranscript === null) tTranscript = now;
      if (st.proxy && tProxy === null) tProxy = now;
      if ((st.sug || st.sugErr) && tSuggest === null) tSuggest = now;
      if (now - lastLog > 30_000) {
        lastLog = now;
        log(`  ${(now / 1000).toFixed(0)} s: ${st.jobs.join(" ")}`);
      }
      if (tTranscript !== null && tProxy !== null && tSuggest !== null) {
        result.suggestionsError = st.sugErr;
        break;
      }
      if (Date.now() > deadline) fail("The import of the hour did not finish in 40 minutes", st);
      await sleep(500);
    }
    const importMem = summariseMemory(mem.read(tDrop));
    const tokensN = await app.state((s) => s.layout.tokens.length);
    row("Full transcript of one hour", "a few minutes (2.6: about 1 min on the GPU)", `${(tTranscript / 60000).toFixed(2)} min (${tokensN} tokens)`, tTranscript < 5 * 60_000);
    row("Proxy of one hour of 4K", "2.4.2: 5 to 8 minutes", `${(tProxy / 60000).toFixed(2)} min`, tProxy < 8 * 60_000);
    const sugAfter = tSuggest - tTranscript;
    row(
      "Suggestions after the transcript",
      "under 1 min",
      `${(sugAfter / 1000).toFixed(1)} s (${realClaude ? "the real claude, one call" : "stand-in claude"}${result.suggestionsError ? `, failed: ${result.suggestionsError}` : ""})`,
      sugAfter < 60_000 && !result.suggestionsError,
      realClaude ? "" : "not a measurement of Claude: run with --real-claude",
    );
    result.timings = { launchMs: app.readyMs, dropToEditorMs: toEditor, dropToPlayableMs: tPlayable, firstTextMs: tFirst, transcriptMs: tTranscript, proxyMs: tProxy, suggestionsMs: tSuggest };
    result.memory = { idle: idleMem, import: importMem };
    row("Memory while importing (app + WebView2 + FFmpeg + transcriber)", "no target in the spec", `peak ${importMem.peakTotalPrivateMB} MB private, ${importMem.peakTotalWorkingSetMB} MB working set; by kind ${JSON.stringify(importMem.peakByKindPrivateMB)}`, true);
    row("Graphics memory while importing", "2.4.10: the speech model under 2 GB of the 12 GB", `${importMem.peakGpuUsedMiB ?? "?"} MiB used on the card at the peak (all programs)`, (importMem.peakGpuUsedMiB ?? 0) < 12 * 1024, "whole card, not per program (WDDM gives no per-process figure)");
    await settle(app);
    await app.shot("imported");

    // ---------------------------------------------------------------- 300 cuts by keyboard
    await app.eval(installKeyProbe);
    await app.dispatch("ui.seek", { time: 0 });
    await sleep(500);
    const cutT0 = Date.now();
    await app.eval(() => {
      window.__kp.samples.length = 0;
      window.__kp.on = true;
    });
    for (let i = 0; i < CUTS; i++) {
      await app.key("Control+ArrowDown", { times: 2 });
      await app.key("Shift+ArrowRight", { times: 2 });
      await app.key("Delete");
      await sleep(30);
    }
    await settle(app);
    await sleep(500); // each sample notes 300 ms later whether its key had any effect
    const keySamples = await app.eval(() => {
      window.__kp.on = false;
      return window.__kp.samples.slice();
    });
    const nClips = await app.state((s) => s.edit.current.clips.length);
    log(`  ${CUTS} cuts made with ${keySamples.length} key presses in ${((Date.now() - cutT0) / 1000).toFixed(0)} s; ${nClips} clips`);
    const undoN = await app.state((s) => s.edit.undo.length);
    log(`  undo depth ${undoN}`);
    check(nClips >= CUTS * 0.9, `Only ${nClips} clips after ${CUTS} cuts`);
    const refresh = await app.eval(() => new Promise((r) => {
      const ts = [];
      const f = (t) => (ts.push(t), ts.length < 61 ? requestAnimationFrame(f) : r((ts[60] - ts[0]) / 60));
      requestAnimationFrame(f);
    }));
    const dels = keySamples.filter((k) => k.key === "Delete");
    const notFirst = dels.filter((d) => !d.changed);
    result.cutsNotInFirstFrame = notFirst.map(({ key, toFrame, toPainted, changedLater, undoDelta, sel0, selected }) => ({ key, toFrame, toPainted, changedLater, undoDelta, sel0, selected }));
    row("Cuts drawn in the frame after the key", "instant: every cut", `${dels.length - notFirst.length} of ${dels.length}; ${notFirst.filter((d) => d.changedLater).length} later, ${notFirst.filter((d) => !d.changedLater).length} never (see cutsNotInFirstFrame)`, notFirst.length === 0);
    const late = dels.slice(-50); // the last 50, with 250+ cuts already in the edit
    const moves = keySamples.filter((k) => k.key !== "Delete");
    // Undo and redo at 300 cuts.
    await app.eval(() => {
      window.__kp.samples.length = 0;
      window.__kp.on = true;
    });
    for (let i = 0; i < 10; i++) {
      await app.key("Control+z");
      await sleep(60);
    }
    for (let i = 0; i < 10; i++) {
      await app.key("Control+Shift+z");
      await sleep(60);
    }
    const undoSamples = await app.eval(() => {
      window.__kp.on = false;
      return window.__kp.samples.slice();
    });
    result.edits = { refreshMs: +refresh.toFixed(2), cuts: stats(dels.map((d) => d.toPainted)), cutsLast50: stats(late.map((d) => d.toPainted)), cutsToFrame: stats(dels.map((d) => d.toFrame)), moves: stats(moves.map((d) => d.toPainted)), undoRedo: stats(undoSamples.map((d) => d.toPainted)) };
    row("Any cut (with up to 300 cuts in the edit)", `instant; 2.6: under one frame (${refresh.toFixed(1)} ms here)`, `key to painted: median ${result.edits.cuts.median} ms, p95 ${result.edits.cuts.p95} ms, max ${result.edits.cuts.max} ms; last 50: median ${result.edits.cutsLast50.median} ms`, result.edits.cuts.p95 <= 50, "pass limit: p95 under 50 ms (no visible delay), as in the typing scenario");
    row("Undo / redo at 300 cuts", "instant", `median ${result.edits.undoRedo.median} ms, p95 ${result.edits.undoRedo.p95} ms`, result.edits.undoRedo.p95 <= 50);
    row("Caret moves at 300 cuts", "instant", `median ${result.edits.moves.median} ms, p95 ${result.edits.moves.p95} ms`, result.edits.moves.p95 <= 50);
    await app.shot("after-300-cuts");

    // ---------------------------------------------------------------- scrolling the transcript
    const box = await app.eval(() => {
      const els = [...document.querySelectorAll("[data-view=transcript] *")].filter((e) => e.scrollHeight > e.clientHeight + 100 && getComputedStyle(e).overflowY !== "visible");
      const el = els.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (!el) return null;
      el.dataset.e2eScroller = "1";
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: el.scrollTop, height: el.scrollHeight };
    });
    check(box, "No scrolling transcript found");
    await app.page.mouse.move(box.x, box.y);
    await app.eval(startFrameRecorder);
    const blanks = [];
    for (let i = 0; i < 120; i++) {
      await app.page.mouse.wheel(0, i < 60 ? 400 : -400);
      await sleep(16);
      if (i % 10 === 9) {
        blanks.push(
          await app.eval(() => {
            const el = document.querySelector("[data-e2e-scroller]");
            const r = el.getBoundingClientRect();
            return [...el.querySelectorAll("[data-pos]")].filter((w) => {
              const b = w.getBoundingClientRect();
              return b.bottom > r.top && b.top < r.bottom;
            }).length;
          }),
        );
      }
    }
    const scrollFrames = await app.eval(() => window.__fr.stop());
    const scrolled = await app.eval(() => document.querySelector("[data-e2e-scroller]").scrollTop);
    result.scroll = { frames: stats(scrollFrames), longFrames: scrollFrames.filter((d) => d > 2.5 * refresh).length, wordsInView: blanks, scrollTopAfter: scrolled };
    check(blanks.every((n) => n > 20), "The transcript showed an empty view while scrolling", blanks);
    row("Scrolling the transcript (300 cuts, 7,700 words)", "smooth", `frame interval median ${result.scroll.frames.median} ms, p95 ${result.scroll.frames.p95} ms, max ${result.scroll.frames.max} ms; ${result.scroll.longFrames} of ${scrollFrames.length} frames over 2.5 refreshes; words always in view (${Math.min(...blanks)}+)`, result.scroll.frames.p95 <= 3 * refresh);

    // ---------------------------------------------------------------- timeline zoom
    await app.key("Tab");
    await app.waitForState((s) => s.session.view === "timeline", null, { label: "the timeline" });
    await app.dispatch("ui.seek", { time: 30 * 60e6 });
    await sleep(800);
    await app.eval(() => {
      window.__kp.samples.length = 0;
      window.__kp.on = true;
    });
    await app.eval(startFrameRecorder);
    for (let r = 0; r < 2; r++) {
      for (let i = 0; i < 8; i++) {
        await app.key("Shift+Equal");
        await sleep(120);
      }
      for (let i = 0; i < 8; i++) {
        await app.key("Minus");
        await sleep(120);
      }
    }
    await app.key("Digit0");
    await sleep(200);
    const zoomFrames = await app.eval(() => window.__fr.stop());
    const zoomKeys = await app.eval(() => {
      window.__kp.on = false;
      return window.__kp.samples.slice();
    });
    result.zoom = { keys: stats(zoomKeys.map((k) => k.toPainted)), frames: stats(zoomFrames), maxZoom: 256 };
    row("Drawing the timeline while zooming (300 clips)", "smooth; instant", `zoom key to painted median ${result.zoom.keys.median} ms, p95 ${result.zoom.keys.p95} ms; frame interval p95 ${result.zoom.frames.p95} ms`, result.zoom.keys.p95 <= 50);
    await app.shot("timeline-300-cuts");
    const memAfterEdits = summariseMemory(mem.read(Date.now() - 10_000));
    result.memory.afterEdits = memAfterEdits;
    row("Memory with 300 cuts, nothing running", "no target in the spec", `${memAfterEdits.lastTotalPrivateMB} MB private (${JSON.stringify(memAfterEdits.peakByKindPrivateMB)})`, true);

    // ---------------------------------------------------------------- export
    const d = await openExport(app);
    check(!d.plan.blockedBy, "The export is blocked", d.plan.blockedBy);
    const seqUs = d.plan.duration;
    const r = await runExport(app, { timeoutMs: 3 * 3600_000 });
    check(r.result, "The export failed", r.error);
    const exportMem = summariseMemory(mem.read(Date.now() - r.wallMs));
    const speed = seqUs / 1e6 / (r.wallMs / 1000);
    const ep = ffprobe(r.result.path);
    const ev = ep.streams.find((s) => s.codec_type === "video");
    const frames = countFrames(r.result.path);
    const wantFrames = Math.round((seqUs * 30) / 1e6);
    result.export = { sequenceS: seqUs / 1e6, wallS: r.wallMs / 1000, speed: +speed.toFixed(2), estimateS: d.plan.estimatedSeconds, bytes: r.result.bytes, codec: ev.codec_name, w: ev.width, h: ev.height, frames, wantFrames, memory: exportMem };
    await app.shot("export-done");
    await app.key("Escape");
    fs.rmSync(r.result.path, { force: true });
    check(ev.width === 3840 && Math.abs(frames - wantFrames) <= 1, "The exported file is not the sequence", result.export);
    row("Export of the result (4K, 300 cuts)", "much faster than real time; 2.6 hoped 4-6x, ~3x accepted", `${(seqUs / 60e6).toFixed(1)} min of video in ${(r.wallMs / 60000).toFixed(1)} min = ${speed.toFixed(2)}x real time (estimate said ${(d.plan.estimatedSeconds / 60).toFixed(1)} min); ${frames} frames`, speed >= 2.5);
    row("Memory while exporting", "no target in the spec", `peak ${exportMem.peakTotalPrivateMB} MB private; by kind ${JSON.stringify(exportMem.peakByKindPrivateMB)}`, true);
  } finally {
    mem.stop();
    try {
      await app.close();
    } finally {
      fs.rmSync(hour, { force: true });
      fs.rmSync(out, { recursive: true, force: true });
    }
  }
  const missed = table.filter((x) => !x.pass);
  if (missed.length) fail(`${missed.length} speed target(s) missed`, missed);
}
