// Scenario "whole-job" (spec 1.2 the weekly job, 1.5 user flow, milestone 4 "the whole weekly
// job works"): from an empty Home screen to an exported MP4, with the keyboard only, timed, a
// screenshot at each step.
//
// 1. New project from two files: speech-2min (the talk) and silence-only (a silent screen
//    capture, same 1080p30 format). The files arrive through ui.dropFiles, which is what both a
//    drop and Ctrl+N's file picker lead to (a script cannot drive the system picker).
// 2. Wait for the text and the suggestions (stand-in claude with its recorded answer).
// 3. Accept some suggestions: N A, N A, then N D (keep one).
// 4. Cut two bad takes by text: Ctrl+F finds the start of a first take still kept, Esc, ← to its
//    start, Ctrl+Shift+→ selects to the end of the sentence, Delete.
// 5. Fix one cut on the timeline by a few frames: Tab, ↓ to the next cut, then . three times.
// 6. Export: Ctrl+E, Enter; the file holds exactly the kept frames, in order.

import fs from "node:fs";
import path from "node:path";
import { ROOT, check, fail } from "../lib/app.mjs";
import { fixture, manifest } from "../lib/media.mjs";
import { readerFor } from "../lib/frames.mjs";
import { waitImported } from "../lib/steps.mjs";
import { verifyExport } from "../lib/exportcheck.mjs";
import { openExport, runExport } from "../lib/exporting.mjs";
import { clips, findPhrase, settle, tokens } from "../lib/transcript.mjs";

const FPS = 30;
const frameOf = (t) => Math.round((t * FPS) / 1e6);

/**
 * A claude -p answer (the recorded envelope of rc-suggest's test data, with its structured
 * output replaced) proposing what the fixture's script planted: the false start s03, the aside
 * s10 with the take before it (keep s11), the first two takes of group C (keep s18) and the
 * aside s20. Quotes are the transcript's own words in those sentences' time.
 */
function claudeReply(utterances, man) {
  const words = utterances.flatMap((u) => u.tokens.filter((t) => t.kind === "word").map((t) => ({ u: u.index, text: t.text, start: t.start, end: t.end })));
  const sentence = (id) => man.sentences.find((x) => x.id === id);
  const inside = (ids) => {
    const ss = ids.map(sentence);
    return words.filter((w) => ss.some((x) => w.start >= x.startUs - 400_000 && w.start < x.endUs - 100_000));
  };
  const make = (kind, ids, keepId, reason) => {
    const ws = inside(ids);
    if (!ws.length) fail(`No transcript words in ${ids.join(", ")}`);
    const s = { kind, first_utterance: ws[0].u, last_utterance: ws[ws.length - 1].u, quote: ws.map((w) => w.text).join(" "), reason };
    if (keepId) s.keep_utterance = inside([keepId])[0].u;
    return s;
  };
  const suggestions = [
    make("false_start", ["s03"], null, "Sentence restarted"),
    make("aside", ["s09", "s10"], "s11", "Redone after the aside"),
    make("retake", ["s16", "s17"], "s18", "Said three times; the last take is complete"),
    make("aside", ["s20"], null, "Lost notes"),
  ];
  const recorded = path.join(ROOT, "src-tauri", "crates", "rc-suggest", "tests", "data", "recorded", "success-150.stdout.txt");
  const envelope = JSON.parse(fs.readFileSync(recorded, "utf8"));
  envelope.structured_output = { suggestions };
  return JSON.stringify(envelope);
}

export async function run(ctx) {
  const { log, result, runDir } = ctx;
  const talk = fixture("speech-2min");
  const screen = fixture("silence-only");
  const man = manifest().fixtures["speech-2min"].speech;
  const reader = readerFor([talk, screen]);
  const out = path.join(runDir, "exports");
  const steps = (result.steps = []);
  const t0 = Date.now();
  let last = t0;
  // Claude is the stand-in, answering for this transcript: its reply file is written once the
  // text is complete, from the real utterances (the stand-in waits 5 s, then reads it).
  const replyFile = path.join(runDir, "claude-reply.json");
  const app = await ctx.launch({ settings: { exportFolder: out }, env: { RC_STANDIN_REPLIES: `${replyFile}|0`, RC_STANDIN_SLEEP_MS: "5000" } });
  const step = async (name, extra = {}) => {
    const now = Date.now();
    const shot = await app.shot(name);
    steps.push({ step: name, ms: now - last, atMs: now - t0, ...extra });
    log(`  [${((now - t0) / 1000).toFixed(1)} s] ${name} (${now - last} ms) ${Object.keys(extra).length ? JSON.stringify(extra) : ""}`);
    last = now;
    return shot;
  };
  await step("home");

  // ---- 1. New project from two files
  check((await app.state((s) => s.screen)) === "home", "The app did not start on Home");
  await app.dispatch("ui.dropFiles", { paths: [talk, screen] });
  await app.waitForState((s) => s.screen === "editor" && s.project?.sources.length === 2, null, { timeoutMs: 15_000, label: "a project of the two files" });
  const ids = await app.state((s) => s.project.sources.map((r) => r.id));
  const opened = await app.state((s) => ({ name: s.project.name, clips: s.edit.current.clips.length, notices: s.notices.map((n) => n.text) }));
  check(opened.clips === 2, "The new project is not the two files end to end", opened);
  await step("project-open", opened);

  // ---- 2. Wait for the text and the suggestions
  const utterances = await app.waitForState((s, id) => (s.sources[id]?.transcript?.complete ? s.sources[id].transcript.utterances : null), ids[0], {
    timeoutMs: 120_000,
    label: "the talk's transcript",
  });
  fs.writeFileSync(replyFile, claudeReply(utterances, man));
  for (const id of ids) await waitImported(app, id);
  await app.waitForState((s, id) => s.sources[id]?.assets?.suggestions === "ready" || s.sources[id]?.assets?.suggestions === "unavailable", ids[0], {
    timeoutMs: 120_000,
    label: "Claude's suggestions for the talk",
    describe: (s, id) => s.sources[id]?.assets,
  });
  const sugg = await app.state((s) => s.layout.suggestions.filter((v) => v.state === "pending").map((v) => ({ kind: v.suggestion.kind, origin: v.suggestion.origin })));
  check(sugg.filter((x) => x.origin === "claude").length >= 2, "Fewer than two suggestions from Claude", sugg);
  await step("text-and-suggestions", { suggestions: sugg.length, claude: sugg.filter((x) => x.origin === "claude").length });

  // ---- 3. Accept two suggestions, keep one
  for (const [k, what] of [["a", "accept"], ["a", "accept"], ["d", "keep"]]) {
    const before = await app.state((s) => s.layout.suggestions.filter((v) => v.state === "pending").length);
    await app.key("n");
    await app.waitForState((s) => s.layout.suggestions.some((v) => v.state === "pending"), null, { label: "a pending suggestion" });
    await settle(app);
    await app.key(k);
    await app.waitForState((s, b) => s.layout.suggestions.filter((v) => v.state === "pending").length === b - 1, before, { label: `${what} to settle the suggestion` });
    await settle(app);
  }
  const applied = await app.state((s) => s.layout.suggestions.filter((v) => v.state === "applied").map((v) => [v.suggestion.kind, v.suggestion.range.start, v.suggestion.range.end]));
  check(applied.length === 2, "Two suggestions should be applied", applied);
  await step("suggestions-reviewed", { applied: applied.length });

  // ---- 4. Cut two bad takes by text (first takes of retake groups that are still kept)
  const groups = man.retakeGroups.map((g) => man.sentences.find((x) => x.id === g.sentences[0]));
  let cutTakes = 0;
  for (const take of groups) {
    if (cutTakes === 2) break;
    const toks = await tokens(app);
    const startWords = take.words.slice(0, 3).map((w) => w.text).join(" ");
    let at;
    try {
      at = findPhrase(toks, startWords);
    } catch {
      log(`  ${take.id}: "${startWords}" not found`);
      continue;
    }
    // Only a take whose words are all still kept, and whose start is the first place said.
    // (Word times from the transcriber start up to a few hundred ms before the script's line times.)
    const inTake = toks.filter((t) => t[6] === ids[0] && t[3] >= take.startUs - 400_000 && t[3] < take.endUs - 100_000 && !t[1].startsWith("<"));
    if (inTake.length < 4 || inTake.some((t) => t[2] !== "kept") || inTake[0][0] !== at) {
      log(`  ${take.id} not a candidate: ${inTake.length} words, at ${at}, first ${inTake[0]?.[0]}, states ${inTake.map((t) => t[1] + ":" + t[2]).join(" ")}`);
      continue;
    }
    await app.key("Control+f");
    await app.waitFor(() => document.activeElement?.getAttribute("aria-label") === "Find in transcript", null, { label: "the find box" });
    await app.key("Control+a");
    await app.page.keyboard.type(startWords.toLowerCase(), { delay: 20 });
    await app.waitForState((s, q) => s.find.query === q, startWords.toLowerCase(), { label: "the query" });
    await settle(app);
    const m = await app.state((s) => ({ index: s.find.index, first: s.find.matches[s.find.index]?.from }));
    check(m.first === at, "Find did not go to the first take", { m, at, startWords });
    await app.key("Escape");
    await settle(app);
    const hits = await app.eval(() => document.querySelectorAll(".rc-tx-find-hit").length);
    check(hits === 0, `After Esc closed the find box, ${hits} words are still highlighted as matches`);
    await app.key("ArrowLeft");
    await app.key("Control+Shift+ArrowRight");
    await settle(app);
    const sel = await app.state((s) => ({ ...s.selection }));
    const from = Math.min(sel.anchor, sel.focus);
    const to = Math.max(sel.anchor, sel.focus);
    const selected = toks.slice(from, to).map((t) => t[1]).join(" ");
    check(from === at, "← after Esc did not put the caret at the take's start", { sel, at });
    check(toks[to - 1][4] <= take.endUs + 300_000 && toks[to - 1][4] >= take.endUs - 600_000, "Ctrl+Shift+→ did not select to the end of the take", { selected, takeEnd: take.endUs, selEnd: toks[to - 1][4] });
    await app.key("Delete");
    await settle(app);
    const after = await tokens(app);
    const struck = after.slice(from, to).filter((t) => !t[1].startsWith("<"));
    check(struck.every((t) => t[2] === "cut"), "Delete did not cut the whole take", struck.filter((t) => t[2] !== "cut").map((t) => t[1]));
    const next = man.sentences.find((x) => x.index === take.index + 1);
    const nextWords = after.filter((t) => t[6] === ids[0] && t[3] >= next.startUs && t[4] <= next.endUs && !t[1].startsWith("<"));
    check(nextWords.length > 0 && nextWords.every((t) => t[2] === "kept"), "Cutting the take also cut the line after it", nextWords.filter((t) => t[2] !== "kept"));
    cutTakes++;
    await step(`bad-take-${cutTakes}-cut`, { take: take.id, text: selected.slice(0, 80) });
  }
  check(cutTakes === 2, `Only ${cutTakes} bad takes were left to cut by text`);

  // ---- 5. Fix one cut on the timeline: three frames later
  await app.key("Tab");
  await app.waitForState((s) => s.session.view === "timeline", null, { label: "the Timeline view" });
  await app.key("ArrowUp", { times: 40 });
  await app.key("ArrowDown");
  await settle(app);
  const before = await clips(app);
  const cutAt = await app.state((s) => s.playhead.time);
  const idx = (() => {
    let t = 0;
    for (let i = 0; i < before.length; i++) {
      t += before[i].end - before[i].start;
      if (Math.abs(t - cutAt) < 50) return i;
    }
    return -1;
  })();
  check(idx >= 0, "↓ did not land on a cut", { cutAt, before });
  await app.key(".", { times: 3, delayMs: 50 });
  await settle(app);
  const fixed = await clips(app);
  check(frameOf(fixed[idx].end) - frameOf(before[idx].end) === 3 && fixed[idx].start === before[idx].start, "The cut did not move three frames later", { before: before[idx], after: fixed[idx] });
  check(fixed.length === before.length && fixed.every((c, i) => i === idx || (c.start === before[i].start && c.end === before[i].end)), "Fixing one cut changed other clips", { before, fixed });
  await step("cut-fixed-on-timeline", { clip: idx + 1, endFrames: [frameOf(before[idx].end), frameOf(fixed[idx].end)] });

  // ---- 6. Export
  const d = await openExport(app);
  check(!d.plan.blockedBy, "The export is blocked", d.plan.blockedBy);
  await step("export-confirm", { length: d.plan.duration, estimatedSeconds: d.plan.estimatedSeconds, notices: d.plan.notices });
  const exp = await runExport(app);
  check(!exp.error, "The export failed", exp.error);
  await step("export-done", { tookSeconds: exp.result.tookSeconds, bytes: exp.result.bytes });
  const total = Date.now() - t0;

  const final = await clips(app);
  const kept = final.map((c) => [c.sourceId === ids[0] ? 0 : 1, frameOf(c.start), frameOf(c.end)]);
  const frames = kept.flatMap(([, a, b]) => Array.from({ length: b - a }, (_, i) => a + i));
  check(exp.result.duration === final.reduce((n, c) => n + (c.end - c.start), 0) || Math.abs(frameOf(exp.result.duration) - frames.length) === 0, "The export's length is not the sequence's", { result: exp.result.duration, frames: frames.length });
  const checked = verifyExport(exp.result.path, reader, {
    frames,
    onsets: false,
    fps: FPS,
    format: { codec: "h264", bitDepth: 8, hdr: false, width: 1920, height: 1080, audioTracks: 1 },
  });
  log(`  file: ${checked.frames} frames (expected ${frames.length}), ${kept.length} clips, audio ${checked.tracks.map((t) => t.audioSeconds.toFixed(3)).join(", ")} s`);
  result.totalMs = total;
  result.export = { tookSeconds: exp.result.tookSeconds, lengthSeconds: exp.result.duration / 1e6, speedTimesRealTime: Math.round((exp.result.duration / 1e6 / exp.result.tookSeconds) * 100) / 100 };
  result.file = { frames: checked.frames, clips: kept.length, bytes: checked.bytes };
  log(`  the whole job took ${(total / 1000).toFixed(1)} s from Home to the exported file`);
  await app.key("Escape");
  const errors = app.consoleErrors();
  if (errors.length) fail("Console errors", errors);
  await app.close();
  fs.rmSync(out, { recursive: true, force: true });
}
