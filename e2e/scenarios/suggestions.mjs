// Scenario "suggestions" (spec 1.9, 1.10 N / Shift+N / A / D / Shift+A, 1.12 "Claude
// unavailable or over the usage limit", milestone 5).
//
// 1. With the stand-in claude: the dead-air suggestions from the import. N and Shift+N step
//    through them (selected, playhead at the start, its reason line current); A cuts exactly its
//    range, D dismisses it, Shift+A accepts all in one step, and Ctrl+Z undoes each.
// 2. Claude signed out (the stand-in's `auth status` says so): the one-line notice with Retry;
//    everything else keeps working (cut, undo, play, the dead-air suggestions, the timeline).
// 3. Over the usage limit, then offline, then a bad answer, then success: each shows its one-line
//    notice with Retry, and pressing Retry asks again and moves to the next.
// 4. Only with `--real-claude` (npm run e2e -- suggestions --real-claude): ONE real call of the
//    installed claude on the user's subscription for speech-2min. The suggestions arrive, each
//    sits on text the fixture's script planted as a retake, false start or aside, and accepting
//    one cuts exactly its text. Without the flag no real call is made, so a plain `npm run e2e`
//    never spends the user's subscription.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, check, fail, sleep } from "../lib/app.mjs";
import { fixture, manifest } from "../lib/media.mjs";
import { installFrameProbe } from "../lib/probe.mjs";
import { dropFiles, waitImported } from "../lib/steps.mjs";
import { FRAME_US, clips, cutsOf, settle, tokens } from "../lib/transcript.mjs";

const DATA = path.join(ROOT, "src-tauri", "crates", "rc-suggest", "tests", "data");
const rec = (f) => path.join(DATA, "recorded", f);
const syn = (f) => path.join(DATA, "synthetic", f);
const REAL_CLAUDE = process.env.ROUGHCUT_REAL_CLAUDE || path.join(os.homedir(), ".local", "bin", "claude.exe");

/** The pending suggestions in document order: id, kind, origin, range, covered positions. */
const pending = (app) =>
  app.state((s) =>
    s.layout.suggestions
      .filter((v) => v.state === "pending")
      .map((v) => ({ id: v.suggestion.id, kind: v.suggestion.kind, origin: v.suggestion.origin, reason: v.suggestion.reason, keptAt: v.suggestion.keptVersionAt ?? null, range: [v.suggestion.range.start, v.suggestion.range.end], first: v.firstPosition, last: v.lastPosition })),
  );
const suggestionStates = (app) => app.state((s) => Object.fromEntries(s.layout.suggestions.map((v) => [v.suggestion.id, v.state])));
const editNow = (app) => app.state((s) => JSON.stringify({ clips: s.edit.current.clips.map((c) => [c.start, c.end]), dismissed: s.edit.current.dismissed.map((d) => [d.start, d.end]) }));

let launches = 0;
/** A launch on its own empty data and cache folders, with speech-2min imported. */
async function importSpeech(ctx, env) {
  const app = await ctx.launch({ env, home: `launch-${++launches}` });
  await app.eval(installFrameProbe);
  await dropFiles(app, [fixture("speech-2min")]);
  const sid = await app.state((s) => s.project.sources[0].id);
  await waitImported(app, sid);
  return { app, sid };
}

/** The new cut range after an edit: the cut ranges now that were not cut before. */
function newCuts(before, after, duration) {
  const a = cutsOf(before, duration);
  return cutsOf(after, duration).filter((c) => !a.some((x) => Math.abs(x[0] - c[0]) < 1 && Math.abs(x[1] - c[1]) < 1));
}

/** Accepting suggestion `g` (current) with A cut exactly its range (snapped to the frame grid). */
async function expectAcceptCutsExactly(app, g, duration, what) {
  const before = await clips(app);
  await app.key("a");
  await settle(app);
  const after = await clips(app);
  const added = newCuts(before, after, duration);
  check(added.length === 1, `${what}: A did not make exactly one new cut`, { before, after });
  const [a, b] = added[0];
  check(Math.abs(a - g.range[0]) <= FRAME_US / 2 + 1 && Math.abs(b - g.range[1]) <= FRAME_US / 2 + 1, `${what}: A cut something other than the suggestion's range`, { cut: added[0], range: g.range });
  const states = await suggestionStates(app);
  check(states[g.id] === "applied", `${what}: the suggestion is not marked applied`, states[g.id]);
  const toks = await tokens(app);
  const covered = toks.filter((t) => t[4] > g.range[0] + FRAME_US && t[3] < g.range[1] - FRAME_US);
  // Words inside are cut whole; a pause the suggestion trims (dead air leaves a little in place) is partly cut.
  const notCut = covered.filter((t) => (t[1].startsWith("<") ? t[2] === "kept" : t[2] !== "cut" && t[4] - t[3] > FRAME_US * 2));
  check(notCut.length === 0, `${what}: words inside the suggestion are not struck through`, notCut);
  const outside = toks.filter((t) => t[2] === "cut" && (t[4] <= g.range[0] || t[3] >= g.range[1]));
  return { cut: added[0], covered: covered.map((t) => t[1]).join(" "), outsideCut: outside.length };
}

/** The editor still works with no Claude: cut and undo a word, play, the timeline. */
async function expectEverythingElseWorks(app, what) {
  const before = await editNow(app);
  await app.key("Control+ArrowDown");
  await app.key("Delete");
  await settle(app);
  check((await editNow(app)) !== before, `${what}: Delete did not cut`);
  await app.key("Control+z");
  await settle(app);
  check((await editNow(app)) === before, `${what}: Ctrl+Z did not undo`);
  const t0 = await app.state((s) => s.playhead.time);
  await app.key("Space");
  await app.waitForState((s) => s.playhead.playing, null, { timeoutMs: 3000, label: `${what}: playback` });
  await sleep(700);
  await app.key("Space");
  await app.waitForState((s) => !s.playhead.playing, null, { timeoutMs: 3000, label: `${what}: pause` });
  const t1 = await app.state((s) => s.playhead.time);
  check(t1 - t0 > 300_000, `${what}: playback did not advance`, { t0, t1 });
  await app.key("Tab");
  await app.waitForState((s) => s.session.view === "timeline", null, { label: `${what}: the Timeline view` });
  await app.key("Tab");
  await app.waitForState((s) => s.session.view === "transcript", null, { label: `${what}: back to the Transcript view` });
  const dead = (await pending(app)).filter((g) => g.kind === "dead_air");
  check(dead.length > 0, `${what}: the dead-air suggestions are gone`);
  // N (or Shift+N when the caret is past the last one) still reviews them.
  await app.key("n");
  await settle(app);
  if ((await app.state((s) => s.currentSuggestion)) === null) await app.key("Shift+N");
  await app.waitForState((s) => s.currentSuggestion !== null, null, { label: `${what}: N or Shift+N` });
  await app.key("Escape");
}

/** Exactly one Claude notice, one line, with a Retry button; returns its text. */
async function expectClaudeNotice(app, want, what) {
  const n = await app.waitFor(
    () => {
      const els = [...document.querySelectorAll(".rc-notice")];
      const c = els.filter((e) => /claude/i.test(e.textContent ?? ""));
      if (c.length === 0) return null;
      const el = c[0];
      const text = el.querySelector(".rc-notice__text")?.textContent ?? "";
      const lh = parseFloat(getComputedStyle(el.querySelector(".rc-notice__text")).lineHeight) || 20;
      return { count: c.length, text, oneLine: el.querySelector(".rc-notice__text").getBoundingClientRect().height < lh * 1.6, retry: [...el.querySelectorAll("button")].map((b) => b.textContent.trim().toLowerCase()) };
    },
    null,
    { timeoutMs: 30_000, label: `${what}: the Claude notice` },
  );
  check(n.count === 1, `${what}: more than one Claude notice`, n);
  check(want.test(n.text), `${what}: the notice says "${n.text}"`);
  check(n.oneLine, `${what}: the notice is not one line`, n);
  check(n.retry.some((b) => b.includes("retry")), `${what}: the notice has no Retry`, n);
  return n.text;
}

async function clickRetry(app) {
  await app.page.locator(".rc-notice", { hasText: /claude/i }).getByRole("button", { name: /retry/i }).click();
}

export async function run(ctx) {
  const { log, result } = ctx;
  const realClaude = process.argv.includes("--real-claude");

  // ---- 1. Dead-air suggestions from the import, reviewed with the keyboard
  {
    const { app } = await importSpeech(ctx, {});
    const duration = await app.state((s) => s.project.sources[0].media.duration);
    const original = await editNow(app);
    const all = await pending(app);
    log(`  pending after import: ${JSON.stringify(all.map((g) => [g.kind, g.origin, g.range]))}`);
    const P = all.filter((g) => g.kind === "dead_air");
    check(P.length >= 2, "Expected at least two dead-air suggestions", all);
    const at = (g) => app.state((s, id) => ({ current: s.currentSuggestion === id, sel: s.selection, at: s.playhead.position?.at, line: !!document.querySelector(`[data-suggestion-line="${id}"][data-current]`) }), g.id);
    const expectCurrent = async (g, what) => {
      await settle(app);
      const c = await at(g);
      check(c.current, `${what}: the current suggestion is not ${g.id}`, c);
      check(Math.min(c.sel.anchor, c.sel.focus) === g.first && Math.max(c.sel.anchor, c.sel.focus) === g.last + 1, `${what}: the suggestion is not selected`, { sel: c.sel, g });
      check(c.line, `${what}: its reason line is not shown as current`);
      const inView = await app.eval((id) => {
        const l = document.querySelector(`[data-suggestion-line="${id}"]`)?.getBoundingClientRect();
        const b = document.querySelector("[data-tx-scroller]")?.getBoundingClientRect();
        return l && b ? { line: [l.top, l.bottom], box: [b.top, b.bottom], ok: l.top >= b.top && l.bottom <= b.bottom } : null;
      }, g.id);
      check(inView?.ok, `${what}: the suggestion's reason line (with its A and D keys) is not fully in view`, inView);
    };
    await app.key("n");
    await expectCurrent(all[0], "N");
    await app.shot("dead-air-current");
    await app.key("n");
    await expectCurrent(all[1], "N again");
    await app.key("Shift+N");
    await expectCurrent(all[0], "Shift+N");

    // A cuts exactly its range; Ctrl+Z undoes it.
    const g0 = all[0];
    const accepted = await expectAcceptCutsExactly(app, g0, duration, "A on a dead-air suggestion");
    log(`  A cut ${JSON.stringify(accepted)}`);
    await app.shot("dead-air-accepted");
    await app.key("Control+z");
    await settle(app);
    check((await editNow(app)) === original, "Ctrl+Z did not undo the accepted suggestion");
    check((await suggestionStates(app))[g0.id] === "pending", "The suggestion is not pending again after undo");

    // D dismisses (keeps the material); Ctrl+Z brings the suggestion back.
    // Undo leaves the caret where the suggestion was: Shift+N (or N) gets back to it.
    for (let i = 0; i < 4 && (await app.state((s) => s.currentSuggestion)) !== g0.id; i++) await app.key(i < 2 ? "Shift+N" : "n");
    await expectCurrent(g0, "N / Shift+N after undo");
    await app.key("d");
    await settle(app);
    let st = await app.state((s) => ({ clips: s.edit.current.clips.length, dismissed: s.edit.current.dismissed.map((d) => [d.start, d.end]) }));
    check(st.clips === 1 && st.dismissed.length === 1 && st.dismissed[0][0] <= g0.range[0] && st.dismissed[0][1] >= g0.range[1], "D did not dismiss the suggestion without cutting", st);
    check((await suggestionStates(app))[g0.id] === "dismissed", "The suggestion is not dismissed");
    const lineGone = await app.eval((id) => !document.querySelector(`[data-suggestion-line="${id}"]`), g0.id);
    check(lineGone, "The dismissed suggestion's line is still shown");
    // Next goes to the next one, never back to the dismissed one.
    await app.key("n");
    await settle(app);
    check((await app.state((s) => s.currentSuggestion)) !== g0.id, "N went back to the dismissed suggestion");
    await app.key("Control+z");
    await settle(app);
    check((await editNow(app)) === original && (await suggestionStates(app))[g0.id] === "pending", "Ctrl+Z did not bring the dismissed suggestion back");

    // Shift+A accepts every pending one in one step; one Ctrl+Z undoes all.
    const undoBefore = await app.state((s) => s.edit.undo.length);
    await app.key("Shift+A");
    await settle(app);
    const states = await suggestionStates(app);
    check(all.every((g) => states[g.id] === "applied"), "Shift+A did not accept every pending suggestion", states);
    const added = newCuts(JSON.parse(original).clips.map(([start, end]) => ({ start, end })), await clips(app), duration);
    check(added.length === all.length, "Shift+A did not cut each suggestion", { added, all: all.map((g) => g.range) });
    check((await app.state((s) => s.edit.undo.length)) === undoBefore + 1, "Shift+A was not one undo step");
    await app.shot("accept-all");
    await app.key("Control+z");
    await settle(app);
    check((await editNow(app)) === original, "One Ctrl+Z did not undo Shift+A");
    const notices = await app.state((s) => s.notices.map((n) => n.text));
    check(!notices.some((t) => /claude/i.test(t)), "A Claude notice is shown although the stand-in answered", notices);
    result.deadAir = all.map((g) => ({ range: g.range, reason: g.reason }));
    await app.close();
  }

  // ---- 2. Signed out: notice with Retry, everything else works
  {
    const { app } = await importSpeech(ctx, {
      RC_STANDIN_AUTH: rec("auth-status-signed-out.json.stdout.txt"),
      RC_STANDIN_AUTH_EXIT: "1",
      RC_STANDIN_REPLIES: `${rec("print-signed-out.stdout.txt")}|1`,
    });
    const text = await expectClaudeNotice(app, /signed out/i, "Signed out");
    log(`  signed out: "${text}"`);
    await app.shot("notice-signed-out");
    await expectEverythingElseWorks(app, "Signed out");
    await clickRetry(app);
    await sleep(500);
    await expectClaudeNotice(app, /signed out/i, "Signed out, after Retry");
    result.signedOut = text;
    await app.close();
  }

  // ---- 3. Limit, then offline, then a bad answer (retried once by itself), then success
  {
    const counter = path.join(ctx.runDir, "work", "claude-counter.txt");
    const { app, sid } = await importSpeech(ctx, {
      RC_STANDIN_COUNTER: counter,
      RC_STANDIN_REPLIES: [
        `${syn("limit.stdout.txt")}|1`,
        `${rec("print-offline-retries2.stdout.txt")}|1`,
        `${syn("garbage.stdout.txt")}|0`,
        `${syn("garbage.stdout.txt")}|0`,
        `${rec("success-150.stdout.txt")}|0`,
      ].join(";"),
    });
    const steps = [
      [/usage limit/i, "Usage limit"],
      [/could not be reached|offline/i, "Offline"],
      [/could not be used|answer/i, "Bad answer"],
    ];
    const texts = [];
    for (const [re, what] of steps) {
      const text = await expectClaudeNotice(app, re, what);
      texts.push(text);
      log(`  ${what}: "${text}"`);
      await app.shot(`notice-${what.toLowerCase().replace(/ /g, "-")}`);
      await expectEverythingElseWorks(app, what);
      await clickRetry(app);
      await app.waitFor((t) => ![...document.querySelectorAll(".rc-notice__text")].some((e) => e.textContent === t), text, { label: `${what}: Retry to replace the notice` });
    }
    await app.waitForState((s, id) => s.sources[id]?.assets?.suggestions === "ready" && !s.sources[id].suggestionsError, sid, { timeoutMs: 30_000, label: "suggestions after the last Retry" });
    await sleep(500);
    const left = await app.state((s) => s.notices.map((n) => n.text));
    check(!left.some((t) => /claude/i.test(t)), "A Claude notice is still shown after Claude answered", left);
    const calls = fs.readFileSync(counter, "utf8").trim();
    check(calls === "5", `Expected 5 calls of the stand-in (limit, offline, bad answer twice, success), saw ${calls}`);
    result.notices = texts;
    await app.close();
  }

  // ---- 4. One real call on the user's subscription (only when asked for)
  if (!realClaude) {
    log("  real Claude: not run (add --real-claude to make one real call on the subscription)");
    result.realClaude = "not run";
    return;
  }
  check(fs.existsSync(REAL_CLAUDE), `The installed claude is not at ${REAL_CLAUDE}`);
  const env = { ROUGHCUT_CLAUDE: REAL_CLAUDE, RC_STANDIN_REPLIES: "", RC_STANDIN_LOG: "" };
  const t0 = Date.now();
  const { app, sid } = await importSpeech(ctx, env);
  const done = await app.waitForState(
    (s, id) => {
      const a = s.sources[id]?.assets;
      if (s.sources[id]?.suggestionsError) return { error: s.sources[id].suggestionsError };
      return a?.suggestions === "ready" && s.sources[id].suggestions?.suggestions.some((g) => g.origin === "claude") ? { ok: true } : null;
    },
    sid,
    { timeoutMs: 240_000, label: "Claude's suggestions", pollMs: 500 },
  );
  if (done.error) fail("The real Claude call failed", done.error);
  result.realClaudeMs = Date.now() - t0;
  const man = manifest().fixtures["speech-2min"].speech;
  const planted = man.sentences.filter((x) => !x.keep);
  const all = await pending(app);
  const claude = all.filter((g) => g.origin === "claude");
  const toks = await tokens(app);
  const report = claude.map((g) => {
    const words = toks.filter((t) => t[4] > g.range[0] && t[3] < g.range[1] && !t[1].startsWith("<"));
    const inPlanted = words.filter((t) => planted.some((p) => (t[3] + t[4]) / 2e6 >= p.startSec - 0.3 && (t[3] + t[4]) / 2e6 <= p.endSec + 0.3));
    const hits = planted.filter((p) => g.range[0] < p.endUs && g.range[1] > p.startUs).map((p) => p.id);
    return { kind: g.kind, reason: g.reason, keptAt: g.keptAt, words: words.map((t) => t[1]).join(" "), share: words.length ? inPlanted.length / words.length : 0, planted: hits, g };
  });
  for (const r of report) log(`  claude ${r.kind} [${r.planted.join(",")}] ${(r.share * 100).toFixed(0)}%: "${r.words}" (${r.reason})`);
  const found = planted.filter((p) => claude.some((g) => g.range[0] < p.endUs && g.range[1] > p.startUs)).map((p) => p.id);
  log(`  planted ${planted.length}: found ${found.length} (${found.join(", ")}) in ${(result.realClaudeMs / 1000).toFixed(1)} s`);
  result.realClaude = { suggestions: report.map(({ g, ...r }) => r), planted: planted.map((p) => p.id), found };
  check(claude.length > 0, "Claude made no suggestions");
  const wrong = report.filter((r) => r.share < 0.8);
  check(wrong.length === 0, "Some of Claude's suggestions do not sit on a planted retake, false start or aside", wrong.map(({ g, ...r }) => r));
  check(found.length >= Math.ceil(planted.length / 2), "Claude found fewer than half of the planted retakes, false starts and asides", { found, planted: planted.map((p) => p.id) });
  const lines = await app.eval(() => [...document.querySelectorAll("[data-suggestion-line]")].map((e) => e.textContent));
  check(lines.length >= claude.length, "Not every suggestion has its reason line", lines);
  // Accept the first Claude suggestion with N ... A.
  let first = null;
  for (let i = 0; i < all.length + 1 && !first; i++) {
    await app.key("n");
    await settle(app);
    const cur = await app.state((s) => s.currentSuggestion);
    first = claude.find((g) => g.id === cur) ?? null;
  }
  check(first, "N never landed on a Claude suggestion");
  await app.shot("claude-suggestion-current");
  const duration = await app.state((s) => s.project.sources[0].media.duration);
  const acc = await expectAcceptCutsExactly(app, first, duration, "A on a Claude suggestion");
  check(acc.outsideCut === 0, "Accepting the Claude suggestion cut words outside it", acc);
  log(`  accepted: ${JSON.stringify(acc)}`);
  result.realClaude.accepted = acc;
  await app.shot("claude-suggestion-accepted");
  await app.close();
}
