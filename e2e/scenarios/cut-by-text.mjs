// Scenario "cut by text" (spec 1.8 "In the transcript", 1.10 Transcript view, milestone 3).
//
// On speech-2min, with the keyboard only: move the caret by word, sentence, line and
// paragraph; select by word and cut; restore; cut across a paragraph boundary; hide and show
// cut text; mark a range with I and O and cut it. After each edit the clip list in the store,
// the struck-through words in the window and what playback shows (the cut is skipped) are
// checked. The caret follows playback, and moving the caret moves the playhead (rule 6).

import { check, fail, sleep } from "../lib/app.mjs";
import { fixture } from "../lib/media.mjs";
import { installFrameProbe } from "../lib/probe.mjs";
import { dropFiles, waitImported, waitShown } from "../lib/steps.mjs";
import { FRAME_US, clips, cutsOf, expectSkipped, expectStruck, findPhrase, playAndRecord, selection, settle, spans, tokenAt, tokens } from "../lib/transcript.mjs";

const SENTENCE_END = /[.!?]["')\]]?$/;

export async function run(ctx) {
  const { log, result } = ctx;
  const app = await ctx.launch();
  await app.eval(installFrameProbe);
  await dropFiles(app, [fixture("speech-2min")]);
  const sid = await app.state((s) => s.project.sources[0].id);
  await waitImported(app, sid);
  const duration = await app.state((s) => s.project.sources[0].media.duration);
  const full = await clips(app);
  check(full.length === 1, "Expected one clip after the import", full);
  const toks = await tokens(app);
  log(`  transcript: ${toks.length} tokens; starts "${toks.slice(0, 12).map((t) => t[1]).join(" ")}"`);
  const view = await app.state((s) => ({ view: s.session.view, sel: s.selection, ph: s.playhead.time }));
  check(view.view === "transcript" && view.sel.focus === 0 && view.ph === 0, "The editor did not open on the Transcript view with the caret at the start", view);

  /** Presses keys, lets the view draw, and returns the selection and playhead. */
  const press = async (key, times = 1) => {
    await app.key(key, { times });
    await settle(app);
    return app.state((s) => ({ anchor: s.selection.anchor, focus: s.selection.focus, time: s.playhead.time, at: s.playhead.position?.at ?? null }));
  };
  /** The playhead is where the caret's token starts (on the frame holding its first moment). */
  const expectPlayheadAtCaret = async (st, what) => {
    const t = toks[st.focus];
    check(st.at !== null && st.at <= t[3] + 1 && st.at > t[3] - FRAME_US - 1, `${what}: moving the caret did not move the playhead to "${t[1]}"`, { st, token: t });
    await waitShown(app, st.time);
  };

  // ---- Move by word
  let st = await press("ArrowRight", 3);
  check(st.focus === 3 && st.anchor === 3, "Three presses of → did not move the caret three words", st);
  await expectPlayheadAtCaret(st, "→");
  st = await press("ArrowLeft");
  check(st.focus === 2 && st.anchor === 2, "← did not move the caret back a word", st);
  await expectPlayheadAtCaret(st, "←");

  // ---- Move by sentence
  const s0 = st.focus;
  st = await press("Control+ArrowRight");
  check(st.focus > s0 && SENTENCE_END.test(toks[st.focus - 1][1]), "Ctrl+→ did not move to the start of the next sentence", { from: s0, st, before: toks[st.focus - 1] });
  for (let p = s0; p < st.focus - 1; p++) check(!SENTENCE_END.test(toks[p][1]), "Ctrl+→ skipped a sentence", { from: s0, to: st.focus, end: toks[p] });
  await expectPlayheadAtCaret(st, "Ctrl+→");
  const s1 = st.focus;
  st = await press("Control+ArrowRight");
  check(st.focus > s1 && SENTENCE_END.test(toks[st.focus - 1][1]), "A second Ctrl+→ did not reach the next sentence", st);
  st = await press("Control+ArrowLeft");
  check(st.focus === s1, "Ctrl+← did not go back to the start of the previous sentence", { want: s1, st });
  await expectPlayheadAtCaret(st, "Ctrl+←");

  // ---- Move by paragraph
  const paraStarts = await app.state((s) => {
    const out = [];
    let p = 0;
    for (const b of s.layout.blocks) {
      if (b.kind !== "paragraph") continue;
      out.push(p);
      p += b.tokens.length;
    }
    return out;
  });
  st = await press("Control+ArrowUp");
  const pa = st.focus;
  check(paraStarts.includes(pa) && pa <= s1, "Ctrl+↑ did not go to the start of the paragraph", { st, paraStarts });
  st = await press("Control+ArrowDown");
  check(st.focus === paraStarts.find((p) => p > pa), "Ctrl+↓ did not go to the start of the next paragraph", { from: pa, st, paraStarts });
  await expectPlayheadAtCaret(st, "Ctrl+↓");
  const domStart = await app.eval((p) => [...document.querySelectorAll('[data-row="paragraph"]')].some((r) => Number(r.dataset.start) === p && r.querySelector("[data-caret]")), st.focus);
  check(domStart, "The caret is not drawn at the start of that paragraph's row");

  // ---- Move by line (each paragraph here fits on one line)
  const caretTop = () => app.eval(() => document.querySelector("[data-view=transcript] [data-caret]")?.getBoundingClientRect().top ?? null);
  const top0 = await caretTop();
  const l0 = st.focus;
  st = await press("ArrowDown");
  const top1 = await caretTop();
  check(st.focus > l0 && top1 - top0 > 15 && top1 - top0 < 80, "↓ did not move the caret down one line", { l0, st, top0, top1 });
  st = await press("ArrowUp");
  check(st.focus === l0, "↑ did not come back up to the same place", { l0, st });

  // ---- Select by word and cut
  st = await press("Control+ArrowUp", 4);
  check(st.focus === 0, "Ctrl+↑ did not reach the start", st);
  st = await press("ArrowRight", 3);
  st = await press("Shift+ArrowRight", 2);
  check(st.anchor === 3 && st.focus === 5, "Shift+→ twice did not select two words", st);
  let dom = await app.eval(() => [...document.querySelectorAll("[data-view=transcript] .rc-sel[data-pos]")].map((e) => Number(e.dataset.pos)));
  check(JSON.stringify(dom) === "[3,4]", "The window does not show the two words selected", dom);
  await app.shot("selected-two-words");
  st = await press("Delete");
  let cl = await clips(app);
  let cuts = cutsOf(cl, duration);
  log(`  cut "${toks[3][1]} ${toks[4][1]}": clips ${JSON.stringify(spans(cl))}`);
  check(cl.length === 2 && cuts.length === 1, "Delete did not make one cut", cl);
  const [ca, cb] = cuts[0];
  check(Math.abs(ca - toks[3][5]) <= FRAME_US / 2 + 1 && Math.abs(cb - toks[5][5]) <= FRAME_US / 2 + 1, "The cut does not cover exactly the selected words", { cut: cuts[0], from: toks[3], to: toks[5] });
  check(st.focus === 5 && st.anchor === 5, "After the cut the caret is not after the cut words", st);
  await expectStruck(app, 0, 11, new Set([3, 4]), "After cutting two words");
  await app.shot("cut-two-words");
  let seen = await playAndRecord(app, 800_000, 2500);
  let span = expectSkipped(seen, cuts, "Playing across the cut");
  check(span[0] < ca && span[1] > cb, "Playback did not run across the cut", { span, cuts });
  result.firstCut = { cut: cuts[0], words: [toks[3][1], toks[4][1]] };

  // ---- Restore it: select the struck words and press R
  st = await press("Control+ArrowUp", 2);
  st = await press("ArrowRight", 3);
  st = await press("Shift+ArrowRight", 2);
  check(st.anchor === 3 && st.focus === 5, "Could not select the cut words", st);
  st = await press("r");
  cl = await clips(app);
  check(JSON.stringify(spans(cl)) === JSON.stringify(spans(full)), "R did not restore the cut words", { cl, full });
  await expectStruck(app, 0, 11, new Set(), "After restoring");

  // ---- Cut across a paragraph boundary: the last word of the first paragraph and the first of the second
  st = await press("Control+ArrowDown");
  const p2 = st.focus;
  check(p2 === paraStarts[1], "Ctrl+↓ did not go to the second paragraph", { st, paraStarts });
  st = await press("ArrowLeft");
  st = await press("Shift+ArrowRight", 2);
  check(st.anchor === p2 - 1 && st.focus === p2 + 1, "Could not select across the paragraph boundary", st);
  st = await press("Backspace");
  cl = await clips(app);
  cuts = cutsOf(cl, duration);
  log(`  cut "${toks[p2 - 1][1]} | ${toks[p2][1]}": clips ${JSON.stringify(spans(cl))}`);
  check(cuts.length === 1, "Backspace across the paragraph boundary did not make one cut", cl);
  check(Math.abs(cuts[0][0] - toks[p2 - 1][5]) <= FRAME_US / 2 + 1 && Math.abs(cuts[0][1] - toks[p2 + 1][5]) <= FRAME_US / 2 + 1, "The cut across paragraphs does not cover the two words and the gap between them", { cut: cuts[0], a: toks[p2 - 1], b: toks[p2 + 1] });
  await expectStruck(app, 0, p2 + 6, new Set([p2 - 1, p2]), "After cutting across paragraphs");
  await app.shot("cut-across-paragraphs");
  seen = await playAndRecord(app, 2_000_000, 3000);
  span = expectSkipped(seen, cuts, "Playing across the paragraph cut");
  check(span[0] < cuts[0][0] && span[1] > cuts[0][1], "Playback did not run across the paragraph cut", { span, cuts });
  const crossCut = cuts[0];

  // ---- Hide and show cut text
  const count = toks.length;
  await press("h");
  let hid = await app.state((s) => ({ hidden: s.session.cutTextHidden, n: s.layout.tokens.length }));
  dom = await app.eval(() => ({ cutShown: document.querySelectorAll('[data-view=transcript] [data-keep="cut"]').length, note: !!document.querySelector("[data-cut-hidden]") }));
  check(hid.hidden && hid.n === count - 2 && dom.cutShown === 0 && dom.note, "H did not hide the cut text", { hid, dom });
  const firstRow = await app.eval(() => document.querySelector('[data-row="paragraph"] .rc-tx-p__text')?.textContent);
  check(!firstRow.includes(toks[p2 - 1][1]), "The hidden cut word still shows in the first paragraph", firstRow);
  await app.shot("cut-text-hidden");
  await press("h");
  hid = await app.state((s) => ({ hidden: s.session.cutTextHidden, n: s.layout.tokens.length }));
  check(!hid.hidden && hid.n === count, "H did not show the cut text again", hid);
  await expectStruck(app, 0, p2 + 6, new Set([p2 - 1, p2]), "After showing cut text again");

  // ---- Mark with I and O while the caret is on the words, then Delete cuts the marked range
  const bill = findPhrase(toks, "the billing page");
  const andAt = bill + 3; // "and" after "the billing page,"
  st = await press("Control+ArrowUp", 3);
  st = await press("Control+ArrowDown", 2);
  check(st.focus <= bill, "Expected to be at or before the paragraph with 'the billing page'", { st, bill });
  st = await press("ArrowRight", bill - st.focus);
  check(st.focus === bill, "Could not move the caret to 'the billing page'", { st, bill });
  await press("i");
  st = await press("ArrowRight", 3);
  check(st.focus === andAt, "Could not move to the word after 'page'", st);
  await press("o");
  const marks = await app.state((s) => s.marks);
  dom = await app.eval(() => [...document.querySelectorAll("[data-mark]")].map((e) => e.dataset.mark));
  check(marks.in && marks.out && dom.includes("in") && dom.includes("out"), "I and O did not set and show the marks", { marks, dom });
  await app.shot("marked-range");
  const beforeMarkCut = await clips(app);
  st = await press("Delete");
  cl = await clips(app);
  cuts = cutsOf(cl, duration);
  const newCut = cuts.find((c) => !(Math.abs(c[0] - crossCut[0]) < 1 && Math.abs(c[1] - crossCut[1]) < 1));
  log(`  marked cut: ${JSON.stringify(newCut)} for "${toks.slice(bill, andAt).map((t) => t[1]).join(" ")}"`);
  check(cl.length === beforeMarkCut.length + 1 && newCut, "Delete with I and O set did not cut the marked range", cl);
  const cutWords = (await tokens(app)).filter((t) => t[2] === "cut").map((t) => t[0]);
  const want = [p2 - 1, p2, bill, bill + 1, bill + 2];
  check(JSON.stringify(cutWords) === JSON.stringify(want), "The marked cut did not cut exactly the words from I to O", { cut: cutWords.map((p) => toks[p][1]), want: want.map((p) => toks[p][1]) });
  check(!(await app.state((s) => s.marks.in || s.marks.out)), "The marks were not cleared by the cut");
  await expectStruck(app, bill - 4, andAt + 3, new Set([bill, bill + 1, bill + 2]), "After cutting the marked range");
  await app.shot("cut-marked-range");
  const seqOf = await app.state((s, at) => {
    let t = 0;
    for (const c of s.edit.current.clips) {
      if (at >= c.start && at < c.end) return t + (at - c.start);
      t += c.end - c.start;
    }
    return null;
  }, newCut[0] - 1_500_000);
  seen = await playAndRecord(app, seqOf, 3000);
  span = expectSkipped(seen, cuts, "Playing across the marked cut");
  check(span[0] < newCut[0] && span[1] > newCut[1], "Playback did not run across the marked cut", { span, newCut });

  // ---- The caret follows playback (Enter plays from the caret) ...
  st = await press("Control+ArrowUp", 4);
  st = await press("Control+ArrowDown", 3);
  const startFocus = st.focus;
  await app.key("Enter");
  await app.waitForState((s) => s.playhead.playing, null, { timeoutMs: 3000, label: "Enter to play from the caret" });
  const follow = [];
  for (let i = 0; i < 6; i++) {
    await sleep(400);
    follow.push(await app.state((s) => ({ focus: s.selection.focus, anchor: s.selection.anchor, at: s.playhead.position?.at, sid: s.playhead.position?.sourceId, playing: s.playhead.playing })));
  }
  await app.key("Space");
  await app.waitForState((s) => !s.playhead.playing, null, { timeoutMs: 3000, label: "pause" });
  const now = await tokens(app);
  for (const f of follow) {
    const want = tokenAt(now, f.sid, f.at);
    // The caret sits before the word being spoken (allow the word just before, for the time between two samples).
    check(f.playing && f.focus === f.anchor && (f.focus === want || f.focus === want + 1 || f.focus === want - 1), "The caret does not follow playback", { f, want: now[want] });
  }
  check(follow[follow.length - 1].focus > startFocus + 3, "The caret did not move along while playing", { startFocus, follow });
  result.caretFollow = follow.map((f) => [f.focus, f.at]);

  // ... and playback follows the caret
  const after = await press("ArrowRight");
  await expectPlayheadAtCaret(after, "→ after playing");
  const caretOnScreen = await app.eval(() => {
    const c = document.querySelector("[data-view=transcript] [data-caret]");
    const sc = document.querySelector("[data-tx-scroller]");
    if (!c || !sc) return null;
    const r = c.getBoundingClientRect();
    const b = sc.getBoundingClientRect();
    return r.top >= b.top && r.bottom <= b.bottom;
  });
  check(caretOnScreen, "The caret is not scrolled into view");
  await app.shot("caret-after-playing");

  const errors = app.consoleErrors();
  if (errors.length) fail("Console errors", errors);
  await app.close();
}
