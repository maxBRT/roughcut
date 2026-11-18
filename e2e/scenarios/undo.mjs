// Scenario "undo" (spec 1.8 "Everywhere": undo and redo cover every edit in both views; 3.5.1
// each command is one undo step; milestone 2 "Undo reverses any edit exactly").
//
// On speech-2min: a long mixed series of edits from the keyboard in both views (text cuts, a
// restore, a suggestion accepted and one dismissed, split, nudge, trim, move, remove, a marked
// cut, accept all). The edit (clips and dismissed ranges) is recorded after each. Then Ctrl+Z
// back to the start, half of it in the Transcript view and half in the Timeline view, comparing
// with the recorded edit at every step, and Ctrl+Shift+Z forward again the same way. At every
// step the Transcript view's struck-through words agree with the clip list.

import { check, fail } from "../lib/app.mjs";
import { fixture } from "../lib/media.mjs";
import { installFrameProbe } from "../lib/probe.mjs";
import { dropFiles, waitImported } from "../lib/steps.mjs";
import { settle } from "../lib/transcript.mjs";

/** Tokens whose keep state disagrees with the clip list (cut = less than a frame of it kept). */
function keepMismatches(s) {
  const frame = (1e6 * s.project.frameRate.den) / s.project.frameRate.num;
  const bad = [];
  for (const t of s.layout.tokens) {
    const { start, end } = t.token;
    let kept = 0;
    for (const c of s.edit.current.clips) if (c.sourceId === t.address.sourceId) kept += Math.max(0, Math.min(end, c.end) - Math.max(start, c.start));
    const len = end - start;
    const want = len <= 0 ? null : kept < frame && kept < len ? "cut" : len - kept < frame ? "kept" : "partial";
    if (want && want !== t.keep) bad.push({ text: t.token.text, start, end, kept, keep: t.keep, want });
  }
  return bad;
}

export async function run(ctx) {
  const { log, result } = ctx;
  const app = await ctx.launch();
  await app.eval(installFrameProbe);
  await dropFiles(app, [fixture("speech-2min")]);
  const sid = await app.state((s) => s.project.sources[0].id);
  await waitImported(app, sid);
  await app.waitForState((s, id) => s.sources[id]?.suggestions?.suggestions.length >= 2, sid, { label: "suggestions" });

  const read = () => app.state((s) => ({ edit: JSON.stringify({ clips: s.edit.current.clips.map((c) => [c.sourceId.slice(0, 6), c.start, c.end]), dismissed: s.edit.current.dismissed.map((d) => [d.start, d.end]) }), undo: s.edit.undo.length, redo: s.edit.redo.length, view: s.session.view }));
  const checkView = async (what) => {
    const bad = await app.state(keepMismatches);
    if (bad.length) fail(`${what}: the Transcript layout disagrees with the clip list`, bad.slice(0, 8));
    const shown = await app.eval(() => [...document.querySelectorAll('[data-view="transcript"] [data-keep="cut"]')].length);
    return shown;
  };
  const view = async (want) => {
    const now = (await read()).view;
    if (now !== want) await app.key("Tab");
    await app.waitForState((s, v) => s.session.view === v, want, { label: `the ${want} view` });
  };

  const history = [await read()];
  const steps = [];
  /** One edit: presses the keys (the last one makes the edit) and checks it changed the edit. */
  const edit = async (name, viewName, keys) => {
    await view(viewName);
    for (const k of keys) {
      await app.key(k);
      await settle(app);
    }
    const now = await read();
    const prev = history[history.length - 1];
    check(now.edit !== prev.edit, `"${name}" (${keys.join(", ")}) changed nothing`, now);
    check(now.undo === prev.undo + 1 && now.redo === 0, `"${name}" is not exactly one undo step`, { before: [prev.undo, prev.redo], after: [now.undo, now.redo] });
    history.push(now);
    steps.push(name);
    await checkView(`After "${name}"`);
    log(`  ${String(steps.length).padStart(2)} ${name}: ${JSON.parse(now.edit).clips.length} clips, ${JSON.parse(now.edit).dismissed.length} dismissed`);
  };

  await edit("cut three words", "transcript", ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "Shift+ArrowRight", "Shift+ArrowRight", "Shift+ArrowRight", "Delete"]);
  await edit("cut the word at the caret", "transcript", ["Control+ArrowDown", "Control+ArrowDown", "Delete"]);
  await edit("dismiss a suggestion", "transcript", ["n", "d"]);
  await edit("restore the first cut", "transcript", [...Array(30).fill("Control+ArrowUp"), "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "Shift+ArrowRight", "Shift+ArrowRight", "Shift+ArrowRight", "r"]);
  await edit("split", "timeline", ["Shift+ArrowRight", "Shift+ArrowRight", "Shift+ArrowRight", "s"]);
  await edit("nudge an edge", "timeline", ["ArrowDown", ","]);
  await edit("trim a start to the playhead", "timeline", ["Shift+ArrowRight", "Shift+ArrowRight", "q"]);
  await edit("move a clip earlier", "timeline", ["Alt+ArrowLeft"]);
  await edit("move a clip later", "timeline", ["Alt+ArrowRight"]);
  await edit("split again", "timeline", ["Shift+ArrowRight", "s"]);
  await edit("remove a clip", "timeline", ["ArrowUp", "Delete"]);
  const goTop = Array(40).fill("Control+ArrowUp");
  await edit("cut a sentence", "transcript", [...goTop, "Control+ArrowDown", "Control+ArrowDown", "Control+ArrowDown", "Control+ArrowDown", "Control+Shift+ArrowRight", "Delete"]);
  await edit("cut a marked range", "transcript", ["Control+ArrowDown", "Control+ArrowDown", "i", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "o", "Delete"]);
  await edit("accept all remaining suggestions", "transcript", ["Shift+A"]);
  await app.shot("after-all-edits");
  const n = steps.length;
  result.steps = steps;

  // ---- Undo all: half in the Transcript view, half in the Timeline view
  for (let i = n; i > 0; i--) {
    const where = i > n / 2 ? "transcript" : "timeline";
    await view(where);
    await app.key("Control+z");
    await settle(app);
    const now = await read();
    check(now.edit === history[i - 1].edit, `Ctrl+Z in the ${where} view did not undo "${steps[i - 1]}" exactly`, { want: JSON.parse(history[i - 1].edit), got: JSON.parse(now.edit) });
    check(now.undo === i - 1 && now.redo === n - i + 1, "Undo and redo counts are wrong", now);
    await checkView(`After undoing "${steps[i - 1]}"`);
  }
  await app.key("Control+z");
  await settle(app);
  check((await read()).edit === history[0].edit, "Ctrl+Z with nothing to undo changed the edit");
  await view("transcript");
  const struck = await checkView("Back at the start");
  check(struck === 0, `${struck} words are still struck through after undoing everything`);
  await app.shot("all-undone");

  // ---- Redo all: half in the Timeline view, half in the Transcript view
  for (let i = 1; i <= n; i++) {
    const where = i <= n / 2 ? "timeline" : "transcript";
    await view(where);
    await app.key("Control+Shift+z");
    await settle(app);
    const now = await read();
    check(now.edit === history[i].edit, `Ctrl+Shift+Z in the ${where} view did not redo "${steps[i - 1]}" exactly`, { want: JSON.parse(history[i].edit), got: JSON.parse(now.edit) });
    await checkView(`After redoing "${steps[i - 1]}"`);
  }
  await app.key("Control+Shift+z");
  await settle(app);
  check((await read()).edit === history[n].edit, "Ctrl+Shift+Z with nothing to redo changed the edit");
  await app.shot("all-redone");

  // ---- A new edit after an undo drops the redo steps
  await app.key("Control+z");
  await settle(app);
  await view("timeline");
  await app.key("Shift+ArrowRight");
  await settle(app);
  await app.key("s");
  await settle(app);
  const branched = await read();
  check(branched.redo === 0 && branched.undo === n, "A new edit after an undo did not clear redo", branched);

  const errors = app.consoleErrors();
  if (errors.length) fail("Console errors", errors);
  await app.close();
}
