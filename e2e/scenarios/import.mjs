// Scenario "import" (spec 3.2 milestone 1, use cases UC1 and UC2, screens 1.7 A and B).
//
// From no projects at all (the Home screen's empty state), make a project from
// fixtures/out/speech-2min.mp4. The editor opens at once and is usable while work goes on:
// the original plays before the proxy exists, text appears while transcription is still
// running, the progress line shows; when everything is done the proxy has replaced the
// original at the same position, the waveform is there and dead-air suggestions are there.

import fs from "node:fs";
import path from "node:path";
import { check, fail, sleep } from "../lib/app.mjs";
import { ffprobe, fixture, listFiles, manifest } from "../lib/media.mjs";
import { installAudioTap, installFrameProbe, readProbes, topVideo } from "../lib/probe.mjs";

export async function run(ctx) {
  const { log, result } = ctx;
  const app = await ctx.launch();
  const timings = (result.timings = { launchToReadyMs: app.readyMs });
  await app.eval(installAudioTap);
  await app.eval(installFrameProbe);

  // ---- Home, empty state
  const home = await app.state((s) => ({ screen: s.screen, projects: s.projects.length }));
  check(home.screen === "home" && home.projects === 0, "The app did not start on an empty Home screen", home);
  const emptyText = await app.eval(() => document.querySelector(".rc-home__empty-title")?.textContent ?? null);
  check(emptyText === "no projects yet", `Home's empty state is not shown (found ${JSON.stringify(emptyText)})`);
  await app.shot("home-empty");

  // ---- Drop the file on the window (the drop handler dispatches ui.dropFiles)
  const file = fixture("speech-2min");
  const t0 = Date.now();
  const dropped = app.dispatch("ui.dropFiles", { paths: [file] });
  await app.waitForState((s) => s.screen === "editor" && s.project !== null && s.edit !== null, null, {
    timeoutMs: 10_000,
    label: "the editor to open",
  });
  timings.dropToEditorMs = Date.now() - t0;
  await dropped;
  const opened = await app.state((s) => {
    const src = s.project.sources[0];
    return {
      name: s.project.name,
      sources: s.project.sources.length,
      sourceId: src.id,
      path: src.path,
      duration: src.media.duration,
      clips: s.edit.current.clips.map((c) => [c.sourceId, c.start, c.end]),
      directPlayable: src.media.directPlayable,
    };
  });
  log(`  editor open after ${timings.dropToEditorMs} ms: ${JSON.stringify(opened)}`);
  check(opened.sources === 1 && opened.path === file, "The project does not hold the dropped file", opened);
  check(opened.name === "speech-2min", `Project name is ${opened.name}`);
  const man = manifest().fixtures["speech-2min"];
  check(Math.abs(opened.duration - man.durationUs) < 50_000, "Probed duration differs from the file", { probed: opened.duration, expected: man.durationUs });
  check(opened.clips.length === 1 && opened.clips[0][1] === 0, "The new project should be one clip of the whole file", opened.clips);
  const sid = opened.sourceId;

  // ---- Playable at once, on the original (before the proxy exists)
  await app.waitForState((s, id) => s.sources[id]?.assets?.playback && s.sources[id].assets.playback !== "none", sid, {
    timeoutMs: 5000,
    label: "a playback address for the new source",
  });
  timings.dropToPlayableMs = Date.now() - t0;
  const before = await app.state((s, id) => ({ pb: s.sources[id].assets.playback, proxyJob: Object.values(s.jobs).find((j) => j.kind === "proxy")?.state }), sid);
  check(before.pb === "original", "The proxy was ready before the original could be tried; the original-first path was not exercised", before);
  check(timings.dropToPlayableMs < 5000, `Drop to playable took ${timings.dropToPlayableMs} ms (spec 1.11: under 5 s)`);

  await app.key("Space");
  await app.waitForState((s) => s.playhead.playing, null, { timeoutMs: 3000, label: "playback to start on the original" });
  const tPlay = Date.now();
  const phStart = await app.state((s) => s.playhead.time);
  await sleep(1000);
  const onOriginal = await app.eval(topVideo);
  const ph1 = await app.state((s) => ({ t: s.playhead.time, playing: s.playhead.playing, pb: s.sources[Object.keys(s.sources)[0]].assets.playback }));
  log(`  playing on ${onOriginal.src}: playhead ${phStart} -> ${ph1.t} in ~1 s; top video ${JSON.stringify(onOriginal)}`);
  check(onOriginal.src === "original", "The picture is not coming from the original while the proxy is being made", onOriginal);
  check(ph1.playing && ph1.t - phStart > 700_000, "Playback on the original did not advance about 1 s in 1 s", { phStart, ph1 });
  check(onOriginal.lastFrame !== null && Math.abs(onOriginal.lastFrame * 1e6 - ph1.t) < 300_000, "The original's frames do not follow the playhead", { onOriginal, ph1 });
  await app.shot("playing-original");
  // The switch to the proxy is looked for in every frame sample from here on. (Clearing the
  // samples once the first text had arrived missed it whenever the proxy came within the same
  // tenth of a second as that text: seen with first text at 7269 ms and the proxy at 7336 ms.)
  const probeSince = await app.eval(() => performance.now());

  // ---- Text appears while transcription is still running; the progress line shows
  const firstText = await app.waitForState(
    (s, id) => {
      const job = Object.values(s.jobs).filter((j) => j.kind === "transcribe" && j.sourceId === id).pop();
      const n = s.sources[id]?.transcript?.utterances?.length ?? 0;
      return n > 0 ? { n, jobState: job?.state, progress: job?.progress, complete: s.sources[id].transcript.complete } : null;
    },
    sid,
    { timeoutMs: 30_000, label: "the first transcript text", pollMs: 20 },
  );
  timings.dropToFirstTextMs = Date.now() - t0;
  const dom = await app.eval(() => ({
    paragraphs: document.querySelectorAll('[data-row="paragraph"]').length,
    note: document.querySelector('[data-note="transcribing"]')?.textContent ?? null,
    arriving: document.querySelectorAll("[data-arriving]").length,
    noTranscript: [...document.querySelectorAll('[data-row="untranscribed"]')].map((e) => e.textContent),
  }));
  log(`  first text after ${timings.dropToFirstTextMs} ms: ${JSON.stringify(firstText)} dom ${JSON.stringify(dom)}`);
  check(firstText.jobState === "running" && !firstText.complete, "Text only appeared once transcription had finished", firstText);
  check(timings.dropToFirstTextMs < 30_000, "First text took longer than 30 s (spec 1.11)");
  await app.shot("text-arriving");

  // ---- The proxy replaces the original at the same position (while playing)
  await app.waitForState((s, id) => s.sources[id]?.assets?.playback === "proxy", sid, { timeoutMs: 60_000, label: "the proxy" });
  timings.dropToProxyMs = Date.now() - t0;
  await app.waitFor(() => {
    const vids = [...document.querySelectorAll("video[data-player-slot]")];
    const top = vids.find((v) => v.style.zIndex === "2");
    return top && (top.currentSrc || top.src).includes("/proxy");
  }, null, { timeoutMs: 5000, label: "the player to switch to the proxy" });
  await sleep(600);
  const sw = await app.eval(readProbes, probeSince);
  const stillPlaying = await app.state((s) => s.playhead.playing);
  check(stillPlaying, "Playback stopped when the proxy arrived");
  const switchReport = analyseSwitch(sw.samples);
  log(`  proxy ready after ${timings.dropToProxyMs} ms; switch: ${JSON.stringify(switchReport)}`);
  result.proxySwitch = switchReport;
  check(switchReport.found, "No switch from the original to the proxy was seen in the frame samples", switchReport);
  check(switchReport.jumpMs <= 70, `The picture jumped ${switchReport.jumpMs} ms of media time at the switch to the proxy (more than about two frames)`, switchReport);
  check(switchReport.stallMs <= 120, `The picture stalled ${switchReport.stallMs} ms at the switch to the proxy`, switchReport);
  check(switchReport.backwards === 0, "The picture went backwards at the switch", switchReport);

  await app.key("Space");
  await app.waitForState((s) => !s.playhead.playing, null, { timeoutMs: 3000, label: "pause" });
  log(`  played ${((Date.now() - tPlay) / 1000).toFixed(1)} s across the switch`);

  // ---- Everything finishes
  const done = await app.waitForState(
    (s, id) => {
      const jobs = Object.values(s.jobs).filter((j) => j.sourceId === id);
      const busy = jobs.filter((j) => j.state === "queued" || j.state === "running");
      const a = s.sources[id]?.assets;
      if (busy.length || !a || a.transcript !== "complete" || (a.suggestions !== "ready" && a.suggestions !== "unavailable")) return null;
      return { jobs: jobs.map((j) => `${j.kind}:${j.state}`), assets: a };
    },
    sid,
    { timeoutMs: 120_000, label: "every import job to finish" },
  );
  timings.dropToAllDoneMs = Date.now() - t0;
  log(`  all done after ${timings.dropToAllDoneMs} ms: ${done.jobs.join(" ")}`);
  const failed = done.jobs.filter((j) => !j.endsWith(":done"));
  check(failed.length === 0, "Some import jobs did not finish", done.jobs);
  for (const k of ["proxy", "audio", "waveform", "transcribe", "suggest"]) {
    check(done.jobs.includes(`${k}:done`), `No finished ${k} job`, done.jobs);
  }
  check(done.assets.waveformUrl, "No waveform address");
  check(done.assets.suggestions === "ready", `Suggestions are ${done.assets.suggestions}`);

  // Progress line is gone, text is complete
  const final = await app.eval(() => ({
    note: document.querySelector('[data-note="transcribing"]')?.textContent ?? null,
    paragraphs: document.querySelectorAll('[data-row="paragraph"]').length,
    untranscribed: [...document.querySelectorAll('[data-row="untranscribed"]')].map((e) => e.textContent),
  }));
  check(final.note === null, `The transcribing line is still shown: ${final.note}`);
  check(final.paragraphs > 5, "Too few paragraphs shown", final);
  check(final.untranscribed.length === 0, "Untranscribed rows are left after the transcript completed", final);

  // ---- The transcript matches the fixture's script (roughly: the words are there)
  const tr = await app.state((s, id) => {
    const t = s.sources[id].transcript;
    const words = t.utterances.flatMap((u) => u.tokens.filter((k) => k.kind === "word").map((k) => k.text));
    return { utterances: t.utterances.length, firstIndex: t.utterances[0]?.index, words, complete: t.complete };
  }, sid);
  const norm = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
  const expected = new Set(man.speech.fullText.split(/\s+/).map(norm).filter(Boolean));
  const recognised = tr.words.map(norm).filter((w) => expected.has(w)).length;
  log(`  transcript: ${tr.utterances} utterances, ${tr.words.length} words, ${recognised} in the script; first index ${tr.firstIndex}`);
  check(tr.complete && tr.words.length > 200, "Transcript too short", { words: tr.words.length });
  check(recognised / tr.words.length > 0.85, "The transcript does not match the spoken script", { recognised, words: tr.words.length });
  check(tr.firstIndex === 1, `Utterance numbers start at ${tr.firstIndex}, not 1 (spec 3.4)`);

  // ---- Dead-air suggestions sit in the fixture's long pauses
  const sugg = await app.state((s, id) => s.sources[id].suggestions.suggestions.map((g) => ({ kind: g.kind, origin: g.origin, start: g.range.start, end: g.range.end, reason: g.reason })), sid);
  const dead = sugg.filter((g) => g.kind === "dead_air");
  log(`  suggestions: ${JSON.stringify(sugg)}`);
  check(dead.length > 0, "No dead-air suggestions");
  const pauses = man.speech.longPauses;
  for (const d of dead) {
    check(d.origin === "local", "A dead-air suggestion did not come from the local detector", d);
    const inside = pauses.some((p) => d.start >= p.startSec * 1e6 - 100_000 && d.end <= p.endSec * 1e6 + 100_000);
    check(inside, "A dead-air suggestion is not inside one of the fixture's long pauses", { d, pauses });
  }
  for (const p of pauses.filter((p) => p.durationSec >= 3)) {
    check(dead.some((d) => d.start < p.endSec * 1e6 && d.end > p.startSec * 1e6), `The ${p.durationSec} s pause at ${p.startSec} s has no dead-air suggestion`, dead);
  }
  const lines = await app.eval(() => [...document.querySelectorAll("[data-suggestion-line]")].map((e) => e.textContent));
  check(lines.some((l) => l.includes("dead air")), "No dead-air line is shown under the transcript", lines);

  // ---- Waveform: the file is served and drawn
  const wf = await app.eval(async (url) => {
    const r = await fetch(url);
    const buf = new Uint8Array(await r.arrayBuffer());
    const nl = buf.indexOf(10);
    const header = JSON.parse(new TextDecoder().decode(buf.slice(0, nl)));
    const values = buf.slice(nl + 1);
    let loud = 0;
    for (const v of values) if (v > 20) loud++;
    const c = document.querySelector(".rc-strip__canvas");
    let lit = 0;
    if (c) {
      const g = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < g.length; i += 4) if (g[i] > 0) lit++;
    }
    return { status: r.status, header, bytes: values.length, loud, canvas: c ? [c.width, c.height] : null, lit };
  }, done.assets.waveformUrl);
  log(`  waveform: ${JSON.stringify(wf)}`);
  check(wf.status === 200 && wf.header.count === wf.bytes, "The waveform file is not served whole", wf);
  check(Math.abs(wf.header.count / wf.header.valuesPerSecond - man.durationSec) < 1, "The waveform does not cover the file", wf);
  check(wf.loud > wf.bytes * 0.3 && wf.loud < wf.bytes * 0.95, "The waveform does not look like speech with pauses", wf);
  check(wf.canvas && wf.lit > 500, "The overview strip draws nothing", wf);

  // ---- Files on disk: project file and the proxy, checked with ffprobe
  const files = listFiles(app.cacheDir);
  const proxyFile = files.find((f) => f.rel.endsWith("proxy.mp4"));
  check(proxyFile, "No proxy file in the cache", files.map((f) => f.rel));
  check(!files.some((f) => /\.part|\.tmp|partial/i.test(f.rel)), "Unfinished files are left in the cache", files.map((f) => f.rel));
  const pp = ffprobe(proxyFile.path);
  const pv = pp.streams.find((s) => s.codec_type === "video");
  const pa = pp.streams.find((s) => s.codec_type === "audio");
  const proxyInfo = { codec: pv?.codec_name, w: pv?.width, h: pv?.height, fps: pv?.r_frame_rate, dur: Number(pp.format.duration), audio: pa?.codec_name, bytes: proxyFile.size };
  log(`  proxy file: ${JSON.stringify(proxyInfo)}`);
  check(pv && pv.codec_name === "h264" && pv.height === 720, "The proxy is not 720p H.264", proxyInfo);
  check(pa, "The proxy has no sound");
  check(Math.abs(Number(pp.format.duration) - man.durationSec) < 0.1, "The proxy's length differs from the source", proxyInfo);
  const projects = listFiles(path.join(app.dataDir, "projects")).filter((f) => f.rel.endsWith("project.json"));
  check(projects.length === 1, "Expected one project file", projects);
  const pj = JSON.parse(fs.readFileSync(projects[0].path, "utf8"));
  check(pj.sources?.[0]?.path === file, "The project file does not name the footage", pj.sources);
  result.proxy = proxyInfo;
  result.transcript = { utterances: tr.utterances, words: tr.words.length, matchingScript: recognised };
  result.deadAir = dead;

  await app.shot("all-done");
  const errors = app.consoleErrors();
  if (errors.length) fail("Console errors", errors);
  log(`  timings: ${JSON.stringify(timings)}`);
  await app.close();
}

/**
 * Finds the original -> proxy handover in rAF samples [t, slot, mediaTime, src, playing,
 * playhead, currentTime] and measures it: the media-time jump across it relative to the
 * wall-clock time that passed, the longest time the picture did not change around it, and
 * how often media time went backwards.
 */
function analyseSwitch(samples) {
  const i = samples.findIndex((s, k) => k > 0 && s[3] === "proxy" && samples[k - 1][3] === "original" && s[2] !== null);
  if (i < 0) return { found: false, kinds: [...new Set(samples.map((s) => s[3]))], n: samples.length };
  // Last original frame and first proxy frame shown.
  let j = i - 1;
  while (j > 0 && samples[j][2] === null) j--;
  const a = samples[j];
  let k = i;
  while (k < samples.length - 1 && samples[k][2] === null) k++;
  const b = samples[k];
  const wallMs = b[0] - a[0];
  const mediaMs = (b[2] - a[2]) * 1000;
  // Longest stretch with the same frame on screen within +-1 s of the switch.
  let stall = 0;
  let runStart = null;
  let backwards = 0;
  const win = samples.filter((s) => Math.abs(s[0] - samples[i][0]) < 1000 && s[2] !== null);
  for (let n = 1; n < win.length; n++) {
    if (win[n][2] < win[n - 1][2] - 1e-4) backwards++;
    if (win[n][2] === win[n - 1][2]) {
      runStart ??= win[n - 1][0];
      stall = Math.max(stall, win[n][0] - runStart);
    } else runStart = null;
  }
  return {
    found: true,
    lastOriginalFrame: a[2],
    firstProxyFrame: b[2],
    wallMs: Math.round(wallMs * 10) / 10,
    mediaMs: Math.round(mediaMs * 10) / 10,
    jumpMs: Math.round(Math.abs(mediaMs - wallMs) * 10) / 10,
    stallMs: Math.round(stall * 10) / 10,
    backwards,
  };
}
