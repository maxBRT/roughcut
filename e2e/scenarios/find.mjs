// Scenario "find" (spec 1.8 rule 10: Ctrl+F searches kept and cut text and jumps to each
// match; 1.10 Ctrl+F, Esc).
//
// On speech-2min: Ctrl+F, type a phrase that spans words, step through the matches with Enter
// and Shift+Enter (the selection, the playhead and the highlighted words follow), find text
// that is cut (also while cut text is hidden: jumping there shows it), and Esc returns to the
// transcript, where the arrow keys move the caret again instead of typing.

import { check, fail, sleep } from "../lib/app.mjs";
import { fixture } from "../lib/media.mjs";
import { installFrameProbe } from "../lib/probe.mjs";
import { dropFiles, waitImported, waitShown } from "../lib/steps.mjs";
import { findPhrase, norm, settle, tokens } from "../lib/transcript.mjs";

export async function run(ctx) {
  const { log, result } = ctx;
  const app = await ctx.launch();
  await app.eval(installFrameProbe);
  await dropFiles(app, [fixture("speech-2min")]);
  const sid = await app.state((s) => s.project.sources[0].id);
  await waitImported(app, sid);
  const toks = await tokens(app);
  const phrase = "billing page";
  const want = [];
  for (let p = 0; ; ) {
    const i = (() => {
      for (let q = p; q + 1 < toks.length; q++) if (norm(toks[q][1]) === "billing" && norm(toks[q + 1][1]) === "page") return q;
      return -1;
    })();
    if (i < 0) break;
    want.push(i);
    p = i + 1;
  }
  log(`  "${phrase}" is at positions ${JSON.stringify(want)}`);
  check(want.length >= 2, `Expected "${phrase}" at least twice in the transcript`, want);

  const findState = () =>
    app.state((s) => ({
      open: s.find.open,
      query: s.find.query,
      matches: s.find.matches.map((m) => [m.from, m.to, !!m.hidden]),
      index: s.find.index,
      sel: s.selection,
      at: s.playhead.position?.at ?? null,
      time: s.playhead.time,
      hidden: s.session.cutTextHidden,
    }));
  const focusIsFind = () => app.eval(() => document.activeElement?.getAttribute("aria-label") === "Find in transcript");
  const status = () => app.eval(() => document.querySelector("[data-find-status]")?.textContent ?? null);
  const highlighted = () =>
    app.eval(() => ({
      current: [...document.querySelectorAll("[data-view=transcript] [data-pos].rc-tx-find-hit--current")].map((e) => Number(e.dataset.pos)),
      all: [...document.querySelectorAll("[data-view=transcript] [data-pos].rc-tx-find-hit")].map((e) => Number(e.dataset.pos)),
    }));
  /** The match `k` is current: selected, highlighted, the playhead at its first word. */
  const expectAt = async (k, what) => {
    const f = await findState();
    const p = want[k];
    check(f.index === k, `${what}: the current match is ${f.index}, expected ${k}`, f);
    check(Math.min(f.sel.anchor, f.sel.focus) === p && Math.max(f.sel.anchor, f.sel.focus) === p + 2, `${what}: the match is not selected`, { sel: f.sel, want: [p, p + 2] });
    // The playhead goes to the match, or for cut words (which never play) to the next kept word.
    const now = await tokens(app);
    let q = p;
    while (q < now.length && now[q][2] === "cut") q++;
    const first = now[q];
    check(f.at !== null && Math.abs(f.at - first[3]) < 40_000, `${what}: the playhead did not jump to the match`, { at: f.at, word: first });
    await waitShown(app, f.time);
    await settle(app);
    const h = await highlighted();
    check(JSON.stringify(h.current) === JSON.stringify([p, p + 1]), `${what}: the window does not highlight the current match`, h);
    const st = await status();
    check(st === `${k + 1} of ${want.length}`, `${what}: the find box says "${st}"`);
  };

  // ---- Ctrl+F, type a phrase spanning two words
  await app.key("Control+f");
  await app.waitForState((s) => s.find.open, null, { label: "Ctrl+F to open the find box" });
  await app.waitFor(() => document.activeElement?.getAttribute("aria-label") === "Find in transcript", null, { label: "the find box to take the keyboard" });
  await app.page.keyboard.type(phrase, { delay: 30 });
  await app.waitForState((s, q) => s.find.query === q, phrase, { label: "the query" });
  await settle(app);
  const f0 = await findState();
  log(`  matches: ${JSON.stringify(f0.matches)}`);
  check(JSON.stringify(f0.matches.map((m) => m[0])) === JSON.stringify(want), "Find did not find every place the phrase is said", { got: f0.matches, want });
  check(f0.matches.every((m) => m[1] - m[0] === 2), "A match does not cover both words", f0.matches);
  await expectAt(0, "Typing the phrase");
  await app.shot("find-first-match");

  // ---- Enter and Shift+Enter step through the matches (the keyboard stays in the find box)
  await app.key("Enter");
  await settle(app);
  await expectAt(1, "Enter");
  check(await focusIsFind(), "Enter took the keyboard out of the find box");
  check(!(await app.state((s) => s.playhead.playing)), "Enter in the find box started playback");
  await app.shot("find-second-match");
  await app.key("Shift+Enter");
  await settle(app);
  await expectAt(0, "Shift+Enter");
  await app.key("Shift+Enter");
  await settle(app);
  await expectAt(want.length - 1, "Shift+Enter from the first match (wraps to the last)");
  await app.key("Enter");
  await settle(app);
  await expectAt(0, "Enter from the last match (wraps to the first)");

  // ---- Esc returns to the transcript: the arrows move the caret, letters are keys again
  await app.key("Escape");
  await app.waitForState((s) => !s.find.open, null, { label: "Esc to close the find box" });
  check(!(await focusIsFind()), "The find box still has the keyboard after Esc");
  const selBefore = await app.state((s) => s.selection);
  await app.key("ArrowRight");
  await settle(app);
  const selAfter = await app.state((s) => s.selection);
  // → on a selection puts the caret at its end; the next → moves on a word.
  const end = Math.max(selBefore.anchor, selBefore.focus);
  check(selAfter.anchor === end && selAfter.focus === end, "After Esc, → did not put the caret at the end of the found words", { selBefore, selAfter });
  await app.key("ArrowRight");
  await settle(app);
  const sel2 = await app.state((s) => s.selection);
  check(sel2.focus === end + 1 && sel2.anchor === end + 1, "After Esc, → did not move the caret in the transcript", { selAfter, sel2 });

  // ---- Cut the first match, then find it again: cut text is searched too
  await app.key("Control+f");
  await app.waitFor(() => document.activeElement?.getAttribute("aria-label") === "Find in transcript", null, { label: "the find box again" });
  const reopened = await app.eval(() => {
    const i = document.activeElement;
    return { value: i.value, selStart: i.selectionStart, selEnd: i.selectionEnd };
  });
  check(reopened.value === phrase && reopened.selStart === 0 && reopened.selEnd === phrase.length, "Ctrl+F did not reopen the box with the last query selected", reopened);
  await app.key("Enter"); // to the first match? the current one is the first; Enter goes on to the second
  await app.key("Shift+Enter");
  await settle(app);
  await expectAt(0, "Back on the first match");
  await app.key("Escape");
  await app.waitForState((s) => !s.find.open, null, { label: "Esc" });
  await app.key("Delete"); // cuts the selected match
  await settle(app);
  const cut = (await tokens(app)).filter((t) => t[2] === "cut").map((t) => t[0]);
  check(JSON.stringify(cut) === JSON.stringify([want[0], want[0] + 1]), "Delete did not cut exactly the found words", { cut, want: [want[0], want[0] + 1] });

  // Hide cut text, then find: the cut match is found and jumping to it shows cut text again.
  await app.key("h");
  await app.waitForState((s) => s.session.cutTextHidden, null, { label: "H to hide cut text" });
  await app.key("Control+f");
  await app.waitFor(() => document.activeElement?.getAttribute("aria-label") === "Find in transcript", null, { label: "the find box" });
  await app.page.keyboard.type("BILLING  PAGE", { delay: 20 }); // replaces the selected query; case and spaces do not matter
  await settle(app);
  let f = await findState();
  log(`  with cut text hidden: ${JSON.stringify({ matches: f.matches, index: f.index, hidden: f.hidden })}`);
  check(f.matches.length === want.length, "Find with cut text hidden did not find the cut match", f.matches);
  check(f.matches[0][2] === true || !f.hidden, "The cut match is not marked as hidden", f.matches);
  // Step to the cut (first) match.
  for (let i = 0; i < want.length && (await findState()).index !== 0; i++) {
    await app.key("Enter");
    await settle(app);
  }
  f = await findState();
  check(f.index === 0 && !f.hidden, "Jumping to a match in hidden cut text did not show the cut text", f);
  await expectAt(0, "The cut match");
  const struck = await app.eval((p) => [p, p + 1].map((q) => document.querySelector(`[data-view=transcript] [data-pos="${q}"]`)?.dataset.keep), want[0]);
  check(struck.every((k) => k === "cut"), "The found cut words are not shown struck through", struck);
  await app.shot("find-cut-match");

  // A phrase that is not there
  await app.key("Control+a");
  await app.page.keyboard.type("purple elephant", { delay: 10 });
  await settle(app);
  f = await findState();
  check(f.matches.length === 0 && (await status()) === "no matches", "A phrase that is not said still found something", { f, status: await status() });
  await app.key("Escape");
  await app.waitForState((s) => !s.find.open, null, { label: "Esc" });
  check(!(await focusIsFind()), "The find box kept the keyboard");
  // Keys act on the transcript again: Ctrl+Z restores the cut.
  await app.key("Control+z");
  await settle(app);
  const after = (await tokens(app)).filter((t) => t[2] === "cut").length;
  check(after === 0, "Ctrl+Z after closing find did not undo the cut", { after });
  result.matches = want;

  const errors = app.consoleErrors();
  if (errors.length) fail("Console errors", errors);
  await app.close();
}
