// Scenario "edge-formats" (spec 1.12 "Recording with several audio tracks", "Sources with
// different resolutions or frame rates", milestone 6 "variable frame rate").
//
// 1. Several audio tracks, the speech on the second: a recording made from speech-2min with
//    three titled tracks ("Main mix" a 1 kHz tone, "Lav mic" the speech, "Camera mic" silence).
//    The transcript is made from the microphone track (it holds the script), and the export
//    keeps all three tracks (ffprobe), each the length of the sequence.
// 2. Variable frame rate (fixtures numbered-vfr): imported, its proxy has a constant rate and
//    the same length, it plays, and the export plan says it is converted to a constant rate.
// 3. Sources with different formats (speech-2min 1080p30, then numbered-1080p60 added): the
//    one-line notice, and the plan follows the first clip (1080p30) with its notice.

import fs from "node:fs";
import path from "node:path";
import { check, sleep } from "../lib/app.mjs";
import { ffprobe, fixture, listFiles, manifest } from "../lib/media.mjs";
import { ffmpeg, noticeTexts, rowTable } from "../lib/edge.mjs";
import { openExport, runExport } from "../lib/exporting.mjs";
import { installFrameProbe } from "../lib/probe.mjs";
import { dropFiles, waitImported, waitShown } from "../lib/steps.mjs";
import { settle } from "../lib/transcript.mjs";

const norm = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, "");

async function plays(app, at) {
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
  const work = path.join(runDir, "work");
  const out = path.join(work, "out");

  // ------------------------------------------------------------- several audio tracks
  const multi = path.join(work, "interview with three tracks.mp4");
  const src = fixture("speech-2min");
  const dur = manifest().fixtures["speech-2min"].durationSec;
  ffmpeg([
    "-i", src,
    "-f", "lavfi", "-i", `sine=frequency=1000:sample_rate=48000:duration=${dur}`,
    "-f", "lavfi", "-i", `anullsrc=channel_layout=stereo:sample_rate=48000`,
    "-map", "0:v", "-map", "1:a", "-map", "0:a", "-map", "2:a",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-shortest",
    "-metadata:s:a:0", "title=Main mix", "-metadata:s:a:1", "title=Lav mic", "-metadata:s:a:2", "title=Camera mic",
    multi,
  ]);
  let app = await ctx.launch({ home: "multi", settings: { exportFolder: out } });
  await app.eval(installFrameProbe);
  await t.row("Recording with several audio tracks", "1.12: all tracks are kept in the export; the transcript uses the microphone track", async () => {
    await dropFiles(app, [multi]);
    const id = await app.state((s) => s.project.sources[0].id);
    await waitImported(app, id);
    const media = await app.state((s) => s.project.sources[0].media);
    check(media.audioTracks.length === 3, "Not three audio tracks", media.audioTracks);
    check(media.speechTrack === 1, "The microphone track was not chosen for the transcript", { speechTrack: media.speechTrack, tracks: media.audioTracks.map((a) => a.title) });
    const words = await app.state((s, i) => s.sources[i].transcript.utterances.flatMap((u) => u.tokens).filter((k) => k.kind === "word").map((k) => k.text), id);
    const expected = new Set(manifest().fixtures["speech-2min"].speech.fullText.split(/\s+/).map(norm).filter(Boolean));
    const inScript = words.map(norm).filter((w) => expected.has(w)).length;
    check(words.length > 200 && inScript / words.length > 0.85, "The transcript is not the speech on the microphone track", { words: words.length, inScript });
    await settle(app);
    await app.shot("three-tracks-transcript");
    const d = await openExport(app);
    check(d.plan.format.audioTracks === 3, "The export plan does not keep all three tracks", d.plan.format);
    const r = await runExport(app);
    check(r.result, "The export failed", r.error);
    const p = ffprobe(r.result.path);
    const audio = p.streams.filter((s) => s.codec_type === "audio");
    check(audio.length === 3, "The exported file does not have three audio tracks", audio.map((a) => a.tags));
    const titles = audio.map((a) => a.tags?.title ?? a.tags?.name ?? null);
    const handlers = audio.map((a) => a.tags?.handler_name ?? null);
    check(JSON.stringify(handlers) === JSON.stringify(["Main mix", "Lav mic", "Camera mic"]), "The exported tracks have no handler names", handlers);
    check(JSON.stringify(titles) === JSON.stringify(["Main mix", "Lav mic", "Camera mic"]), "The exported tracks lost their names", titles);
    for (const a of audio) check(Math.abs(Number(a.duration) - dur) < 0.1, "An exported track is not the sequence's length", { duration: a.duration, dur });
    await app.key("Escape");
    fs.rmSync(r.result.path, { force: true });
    return `speech track ${media.speechTrack} ("${media.audioTracks[media.speechTrack].title}"); transcript ${words.length} words, ${inScript} in the script; export has ${audio.length} tracks (titles ${JSON.stringify(titles)}), each ${Number(audio[0].duration).toFixed(2)} s`;
  });
  await app.close();
  fs.rmSync(multi, { force: true });

  // ------------------------------------------------------------- variable frame rate
  app = await ctx.launch({ home: "vfr", settings: { exportFolder: out } });
  await app.eval(installFrameProbe);
  await t.row("Variable frame rate", "milestone 6 / 2.4.8: imported and played; the export is at a constant rate (and says so)", async () => {
    await dropFiles(app, [fixture("numbered-vfr")]);
    const id = await app.state((s) => s.project.sources[0].id);
    const q = await app.waitForState(
      (s, i) => {
        const jobs = Object.values(s.jobs).filter((j) => j.sourceId === i);
        if (jobs.length === 0 || jobs.some((j) => j.state === "queued" || j.state === "running")) return null;
        return { jobs: jobs.map((j) => `${j.kind}:${j.state}`), assets: s.sources[i].assets };
      },
      id,
      { timeoutMs: 120_000, label: "the VFR import" },
    );
    const media = await app.state((s) => s.project.sources[0].media);
    check(media.video.variableFrameRate, "The VFR source was not seen as variable", media.video);
    check(q.assets.playback === "proxy", "No proxy for the VFR source", q);
    const proxyFile = listFiles(path.join(app.cacheDir, id)).find((f) => f.rel === "proxy.mp4");
    const pv = ffprobe(proxyFile.path);
    const v = pv.streams.find((s) => s.codec_type === "video");
    check(v.r_frame_rate === v.avg_frame_rate, "The proxy's frame rate is not constant", { r: v.r_frame_rate, avg: v.avg_frame_rate });
    check(Math.abs(Number(pv.format.duration) - 30) < 0.1, "The proxy is not as long as the source", pv.format.duration);
    const reached = await plays(app, 10_000_000);
    check(reached > 10_600_000, "The VFR source does not play", reached);
    const d = await openExport(app);
    await app.shot("vfr-export-plan");
    await app.key("Escape");
    check(!d.plan.blockedBy, "The VFR export is blocked", d.plan.blockedBy);
    check(d.plan.notices.some((n) => /variable frame rate/i.test(n)), "The plan does not say the variable rate is made constant", d.plan.notices);
    return `seen as VFR (${media.video.frameRate.num}/${media.video.frameRate.den}); jobs ${q.jobs.join(" ")}; proxy ${v.r_frame_rate} constant, ${Number(pv.format.duration).toFixed(2)} s; played to ${(reached / 1e6).toFixed(2)} s; plan: ${d.plan.notices.join(" ")}`;
  });

  // ------------------------------------------------------------- different formats
  await t.row("Sources with different resolutions or frame rates", "1.12: allowed; the export follows the first clip's format; a one-line notice says so", async () => {
    // Added after the VFR source (1920x1080, about 30 fps): a 60 fps source.
    await dropFiles(app, [fixture("numbered-1080p60")]);
    await app.waitForState((s) => s.notices.some((n) => n.id === "mixed"), null, { timeoutMs: 10_000, label: "the mixed-format notice" });
    await settle(app);
    await app.shot("mixed-notice");
    const notice = await app.eval(() => {
      const el = [...document.querySelectorAll("[role=status], [role=alert], .rc-notice")].find((e) => /differ in format/i.test(e.textContent));
      if (!el) return null;
      const lh = parseFloat(getComputedStyle(el.querySelector("p, span") ?? el).lineHeight) || 20;
      const textEl = [...el.querySelectorAll("*")].find((e) => e.children.length === 0 && /differ in format/i.test(e.textContent)) ?? el;
      return { text: el.textContent.trim(), lines: Math.round(textEl.getBoundingClientRect().height / lh) };
    });
    check(notice, "The mixed-format notice is not on screen", await noticeTexts(app));
    check(notice.lines <= 1, "The mixed-format notice is more than one line", notice);
    const d = await openExport(app);
    await app.key("Escape");
    const first = await app.state((s) => s.project.sources[0].media.video);
    check(d.plan.format.width === first.width && d.plan.format.height === first.height, "The export does not follow the first clip's size", { plan: d.plan.format, first });
    check(d.plan.notices.some((n) => /differ/i.test(n)), "The plan has no notice about the mixed sources", d.plan.notices);
    return `notice "${notice.text}" (${notice.lines} line); plan ${d.plan.format.width}x${d.plan.format.height} @ ${d.plan.format.frameRate.num}/${d.plan.format.frameRate.den}; ${d.plan.notices.join(" ")}`;
  });
  await app.close();
  fs.rmSync(out, { recursive: true, force: true });
  t.finish();
}
