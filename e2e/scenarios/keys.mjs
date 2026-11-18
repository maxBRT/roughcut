// Scenario "keys" (spec 1.10, every row of every table; milestone 6 "shortcut overlay and
// remapping").
//
// Each row's key is pressed, as the user would, in the context it belongs to, and must do what
// the row says AND NOTHING ELSE: before and after each press the scenario takes a digest of the
// store (screen, view, speed, hidden text, clip list, undo and redo depth, dismissed
// suggestions, selection, playhead, playing, marks, open dialogs, find box, zoom, current
// suggestion, Home selection, project count). Only the fields the row names may change.
// Then:
// - "?" lists every row of 1.10 with the key the spec gives it;
// - a key is rebound in the overlay (Split: S to X), and the new key works while S does
//   nothing; a key already taken (W, Trim end) is refused with the name of its action and the
//   old key kept; after a restart the rebinding is still in force.
//
// Files reach the app through a drop (ui.dropFiles); Ctrl+N and Ctrl+O open the real file
// dialog, which is cancelled. Going back to Home (no key in 1.10) uses ui.goHome, what the
// brand button does.

import path from "node:path";
import fs from "node:fs";
import { check, fail, sleep } from "../lib/app.mjs";
import { fixture } from "../lib/media.mjs";
import { answerFileDialog } from "../lib/filedialog.mjs";
import { rowTable } from "../lib/edge.mjs";
import { installFrameProbe } from "../lib/probe.mjs";
import { dropFiles, waitImported } from "../lib/steps.mjs";
import { settle } from "../lib/transcript.mjs";

const FRAME = 1e6 / 30;

/** The store reduced to what a key can change. Runs in the page (self-contained). */
const DIGEST = (s) => ({
  screen: s.screen,
  view: s.session.view,
  rate: s.session.playbackRate,
  hidden: s.session.cutTextHidden,
  clips: s.edit ? JSON.stringify(s.edit.current.clips.map((c) => [c.sourceId.slice(0, 6), c.start, c.end])) : null,
  nclips: s.edit ? s.edit.current.clips.length : 0,
  dismissed: s.edit ? s.edit.current.dismissed.length : 0,
  undo: s.edit ? s.edit.undo.length : 0,
  redo: s.edit ? s.edit.redo.length : 0,
  anchor: s.selection.anchor,
  focus: s.selection.focus,
  ph: s.playhead.time,
  playing: s.playhead.playing,
  speed: s.playhead.speed,
  marks: JSON.stringify(s.marks),
  export: !!s.dialogs.export,
  shortcuts: s.dialogs.shortcuts,
  locate: !!s.dialogs.locate,
  find: s.find.open,
  zoom: s.zoom,
  suggestion: s.currentSuggestion,
  homeSel: s.homeSelection,
  projects: s.projects.length,
});
const FIELDS = Object.keys(DIGEST({ session: {}, selection: {}, playhead: {}, dialogs: {}, find: {}, projects: [] }));
const SELECTION = ["anchor", "focus"];
const MOVE = ["anchor", "focus", "ph"];
const PLAY = ["playing", "speed", "ph", "anchor", "focus"];
const EDIT = ["clips", "nclips", "undo", "redo", "anchor", "focus", "ph"];

/** What the 1.10 tables list, in the spec's own notation, and the action each row is. */
const SPEC_ROWS = [
  ["everywhere.playPause", "Space"], ["everywhere.playBackward", "J"], ["everywhere.pause", "K"], ["everywhere.playForward", "L"],
  ["everywhere.speed1x", "1"], ["everywhere.speed1_5x", "2"], ["everywhere.speed2x", "3"], ["everywhere.switchView", "Tab"],
  ["everywhere.undo", "Ctrl+Z"], ["everywhere.redo", "Ctrl+Shift+Z"], ["everywhere.newProject", "Ctrl+N"], ["everywhere.addFootage", "Ctrl+O"],
  ["everywhere.export", "Ctrl+E"], ["everywhere.find", "Ctrl+F"], ["everywhere.showShortcuts", "?"], ["everywhere.escape", "Esc"],
  ["transcript.wordPrev", "←"], ["transcript.wordNext", "→"], ["transcript.linePrev", "↑"], ["transcript.lineNext", "↓"],
  ["transcript.sentencePrev", "Ctrl+←"], ["transcript.sentenceNext", "Ctrl+→"], ["transcript.paragraphPrev", "Ctrl+↑"], ["transcript.paragraphNext", "Ctrl+↓"],
  ["transcript.extendWordPrev", "Shift+←"], ["transcript.extendWordNext", "Shift+→"], ["transcript.extendLinePrev", "Shift+↑"], ["transcript.extendLineNext", "Shift+↓"],
  ["transcript.extendSentencePrev", "Ctrl+Shift+←"], ["transcript.extendSentenceNext", "Ctrl+Shift+→"],
  ["transcript.extendParagraphPrev", "Ctrl+Shift+↑"], ["transcript.extendParagraphNext", "Ctrl+Shift+↓"],
  ["transcript.cut", "Del|Backspace"], ["transcript.restore", "R"], ["transcript.markIn", "I"], ["transcript.markOut", "O"],
  ["transcript.playFromCaret", "Enter"], ["transcript.toggleCutText", "H"], ["transcript.nextSuggestion", "N"], ["transcript.prevSuggestion", "Shift+N"],
  ["transcript.acceptSuggestion", "A"], ["transcript.dismissSuggestion", "D"], ["transcript.acceptAllSuggestions", "Shift+A"],
  ["timeline.stepFrameBack", "←"], ["timeline.stepFrameForward", "→"], ["timeline.stepSecondBack", "Shift+←"], ["timeline.stepSecondForward", "Shift+→"],
  ["timeline.prevCut", "↑"], ["timeline.nextCut", "↓"], ["timeline.nudgeEndEarlier", ","], ["timeline.nudgeEndLater", "."],
  ["timeline.nudgeStartEarlier", "Shift+,"], ["timeline.nudgeStartLater", "Shift+."], ["timeline.trimStart", "Q"], ["timeline.trimEnd", "W"],
  ["timeline.split", "S"], ["timeline.removeClip", "Del"], ["timeline.moveClipEarlier", "Alt+←"], ["timeline.moveClipLater", "Alt+→"],
  ["timeline.previewCut", "/"], ["timeline.zoomIn", "+"], ["timeline.zoomOut", "-"], ["timeline.zoomFit", "0"],
];

export async function run(ctx) {
  const { runDir, log, result } = ctx;
  const t = rowTable(ctx);
  const settings = { exportFolder: path.join(runDir, "work", "out") };
  let app = await ctx.launch({ settings });
  await app.eval(installFrameProbe);
  const digest = () => app.state(DIGEST);

  /**
   * Presses `chord` and waits until `expect(before, after)` holds; then checks that no field
   * outside `changes` moved (the playhead may drift by a frame when it is not named).
   */
  async function press(chord, { changes = [], expect, timeoutMs = 4000, settleMs = 250 } = {}) {
    const before = await digest();
    await app.key(chord);
    const deadline = Date.now() + timeoutMs;
    let after = await digest();
    while (!expect(before, after)) {
      if (Date.now() > deadline) {
        await app.shot(`key-${chord.replace(/[^a-z0-9]+/gi, "_")}-timeout`).catch(() => undefined);
        fail(`${chord}: the expected effect did not happen`, { before, after });
      }
      await sleep(50);
      after = await digest();
    }
    await sleep(settleMs);
    after = await digest();
    const moved = FIELDS.filter((f) => !changes.includes(f) && JSON.stringify(before[f]) !== JSON.stringify(after[f]) && !(f === "ph" && Math.abs(before.ph - after.ph) <= FRAME + 1));
    if (moved.length) fail(`${chord} also changed ${moved.join(", ")}`, Object.fromEntries(moved.map((f) => [f, [before[f], after[f]]])));
    return { before, after };
  }
  const stop = async () => {
    if ((await digest()).playing) await press("k", { changes: PLAY, expect: (b, a) => !a.playing });
  };
  const describe = (b, a, fields) => fields.map((f) => `${f} ${JSON.stringify(b[f])}→${JSON.stringify(a[f])}`).join(", ");

  // ---------------------------------------------------------------- Home: two projects
  await dropFiles(app, [fixture("numbered-1080p60")]);
  await waitImported(app, await app.state((s) => s.project.sources[0].id));
  await app.dispatch("ui.goHome");
  await app.waitForState((s) => s.screen === "home", null, { label: "Home" });
  await dropFiles(app, [fixture("speech-2min")]);
  const sid = await app.state((s) => s.project.sources[0].id);
  await waitImported(app, sid);
  await app.waitForState((s, id) => s.sources[id]?.suggestions?.suggestions?.length >= 2, sid, { timeoutMs: 60_000, label: "suggestions" });
  await settle(app);

  // ---------------------------------------------------------------- Everywhere
  await t.row("Space", "Play / pause", async () => {
    const r1 = await press("Space", { changes: PLAY, expect: (b, a) => a.playing && a.speed > 0 });
    await sleep(500);
    const r2 = await press("Space", { changes: PLAY, expect: (b, a) => !a.playing });
    check(r2.after.ph > r1.before.ph + 300_000, "The playhead did not move while playing", { from: r1.before.ph, to: r2.after.ph });
    return `played (speed ${r1.after.speed}) and paused, ${((r2.after.ph - r1.before.ph) / 1e6).toFixed(2)} s later`;
  });
  await app.dispatch("ui.seek", { time: 30_000_000 });
  await sleep(400);
  await t.row("J", "Play backwards (silent)", async () => {
    const r = await press("j", { changes: PLAY, expect: (b, a) => a.playing && a.speed < 0 });
    await sleep(600);
    const ph = await app.state((s) => s.playhead.time);
    check(ph < r.before.ph, "J did not go backwards", { from: r.before.ph, now: ph });
    await stop();
    return `speed ${r.after.speed}, playhead ${(r.before.ph / 1e6).toFixed(2)} → ${(ph / 1e6).toFixed(2)} s`;
  });
  await t.row("K", "Pause", async () => {
    await press("l", { changes: PLAY, expect: (b, a) => a.playing });
    const r = await press("k", { changes: PLAY, expect: (b, a) => !a.playing });
    return `paused at ${(r.after.ph / 1e6).toFixed(2)} s`;
  });
  await t.row("L, L again", "Play forwards. Press L again to go faster", async () => {
    const r1 = await press("l", { changes: PLAY, expect: (b, a) => a.playing && a.speed === 1 });
    const r2 = await press("l", { changes: PLAY, expect: (b, a) => a.playing && a.speed > 1 });
    await stop();
    return `speed ${r1.after.speed} then ${r2.after.speed}`;
  });
  await t.row("1 2 3", "Playback speed 1x / 1.5x / 2x", async () => {
    const r3 = await press("3", { changes: ["rate", "speed"], expect: (b, a) => a.rate === 2 });
    const r2 = await press("2", { changes: ["rate", "speed"], expect: (b, a) => a.rate === 1.5 });
    const r1 = await press("1", { changes: ["rate", "speed"], expect: (b, a) => a.rate === 1 });
    return `rates ${r3.after.rate}, ${r2.after.rate}, ${r1.after.rate}`;
  });
  await t.row("Tab", "Switch between Transcript and Timeline", async () => {
    const r1 = await press("Tab", { changes: ["view"], expect: (b, a) => a.view === "timeline" });
    const r2 = await press("Tab", { changes: ["view"], expect: (b, a) => a.view === "transcript" });
    return `${r1.before.view} → ${r1.after.view} → ${r2.after.view}`;
  });
  await t.row("Ctrl+N", "New project from footage (the file dialog; cancelled: nothing changes)", async () => {
    const answered = answerFileDialog(app, null);
    await sleep(200);
    const before = await digest();
    await app.key("Control+n");
    const title = await answered;
    await sleep(500);
    const after = await digest();
    const moved = FIELDS.filter((f) => f !== "ph" && JSON.stringify(before[f]) !== JSON.stringify(after[f]));
    check(/new project/i.test(title), "Ctrl+N did not open the 'new project' file dialog", title);
    check(moved.length === 0, "Cancelling Ctrl+N's dialog changed something", moved);
    return `dialog "${title}" opened; cancelled, nothing changed`;
  });
  await t.row("Ctrl+O", "Add footage to this project (the file dialog; cancelled: nothing changes)", async () => {
    const answered = answerFileDialog(app, null);
    await sleep(200);
    const before = await digest();
    await app.key("Control+o");
    const title = await answered;
    await sleep(500);
    const after = await digest();
    const moved = FIELDS.filter((f) => f !== "ph" && JSON.stringify(before[f]) !== JSON.stringify(after[f]));
    check(/add|footage/i.test(title), "Ctrl+O did not open the 'add footage' file dialog", title);
    check(moved.length === 0, "Cancelling Ctrl+O's dialog changed something", moved);
    return `dialog "${title}" opened; cancelled, nothing changed`;
  });
  await t.row("Ctrl+E, Esc", "Export; Esc closes the dialog", async () => {
    await press("Control+e", { changes: ["export"], expect: (b, a) => a.export });
    await app.waitForState((s) => s.dialogs.export && !s.dialogs.export.planning, null, { label: "the plan" });
    await press("Escape", { changes: ["export"], expect: (b, a) => !a.export });
    return "opened, then closed with Esc";
  });
  await t.row("Ctrl+F, Esc", "Find in transcript; Esc closes", async () => {
    await press("Control+f", { changes: ["find"], expect: (b, a) => a.find });
    const focused = await app.eval(() => document.activeElement?.tagName === "INPUT");
    check(focused, "The find box does not have the keyboard");
    await press("Escape", { changes: ["find"], expect: (b, a) => !a.find });
    return "find box opened with the keyboard in it; Esc closed it";
  });
  await t.row("?, Esc", "Show shortcuts; Esc closes", async () => {
    await press("Shift+Slash", { changes: ["shortcuts"], expect: (b, a) => a.shortcuts });
    await settle(app);
    await app.shot("shortcuts-overlay");
    await press("Escape", { changes: ["shortcuts"], expect: (b, a) => !a.shortcuts });
    return "overlay opened and closed";
  });
  await t.row("Esc", "Clear selection", async () => {
    await app.key("Shift+ArrowRight", { times: 3 });
    const sel = await digest();
    check(sel.anchor !== sel.focus, "No selection to clear");
    const r = await press("Escape", { changes: SELECTION, expect: (b, a) => a.anchor === a.focus });
    return `selection ${sel.anchor}–${sel.focus} cleared to ${r.after.focus}`;
  });

  // ---------------------------------------------------------------- Transcript view
  // In the middle of the longest paragraph ("... Priya is building the empty states ..."),
  // reached with the arrows: Ctrl+↓ to its paragraph, then → to "Priya".
  await app.dispatch("ui.seek", { time: 0 });
  await sleep(300);
  for (let i = 0; i < 40; i++) {
    const w = await app.state((s) => s.layout.tokens.slice(s.selection.focus, s.selection.focus + 12).map((k) => k.token.text ?? "").join(" "));
    if (/Priya/.test(w)) break;
    await app.key("Control+ArrowDown");
    await sleep(60);
  }
  for (let i = 0; i < 12; i++) {
    const w = await app.state((s) => s.layout.tokens[s.selection.focus]?.token.text ?? "");
    if (w === "Priya") break;
    await app.key("ArrowRight");
    await sleep(40);
  }
  check((await app.state((s) => s.layout.tokens[s.selection.focus]?.token.text)) === "Priya", "The arrows did not reach 'Priya'");
  const moves = {};
  for (const [chord, label, dir, extend] of [
    ["ArrowRight", "Move by word", 1, false], ["ArrowLeft", "Move by word", -1, false],
    ["ArrowDown", "Move by line", 1, false], ["ArrowUp", "Move by line", -1, false],
    ["Control+ArrowRight", "Move by sentence", 1, false], ["Control+ArrowLeft", "Move by sentence", -1, false],
    ["Control+ArrowDown", "Move by paragraph", 1, false], ["Control+ArrowUp", "Move by paragraph", -1, false],
    ["Shift+ArrowRight", "Extend by word", 1, true], ["Shift+ArrowLeft", "Extend by word", -1, true],
    ["Shift+ArrowDown", "Extend by line", 1, true], ["Shift+ArrowUp", "Extend by line", -1, true],
    ["Control+Shift+ArrowRight", "Extend by sentence", 1, true], ["Control+Shift+ArrowLeft", "Extend by sentence", -1, true],
    ["Control+Shift+ArrowDown", "Extend by paragraph", 1, true], ["Control+Shift+ArrowUp", "Extend by paragraph", -1, true],
  ]) {
    await t.row(`Transcript ${chord}`, label, async () => {
      if (extend) await app.key("Escape");
      const r = await press(chord, { changes: MOVE, expect: (b, a) => Math.sign(a.focus - b.focus) === dir });
      if (extend) check(r.after.anchor === r.before.focus, "Shift did not keep the anchor", r);
      else check(r.after.anchor === r.after.focus, "A plain move left a selection", r);
      check(dir > 0 ? r.after.ph > r.before.ph : r.after.ph < r.before.ph, "The playhead did not follow the caret", r);
      moves[chord] = Math.abs(r.after.focus - r.before.focus);
      return `${describe(r.before, r.after, ["anchor", "focus"])}; playhead ${(r.before.ph / 1e6).toFixed(2)}→${(r.after.ph / 1e6).toFixed(2)} s`;
    });
  }
  await t.row("Move sizes", "a sentence is at least a word, a paragraph at least a sentence", async () => {
    check(moves.ArrowRight === 1 && moves.ArrowRight < moves["Control+ArrowRight"] && moves["Control+ArrowRight"] <= moves["Control+ArrowDown"], "Word, sentence and paragraph moves are not in order of size", moves);
    return JSON.stringify(moves);
  });
  await app.key("Escape");

  let cutClips;
  await t.row("Delete", "Cut the selection", async () => {
    await app.key("Shift+ArrowRight", { times: 3 });
    const r = await press("Delete", { changes: EDIT, expect: (b, a) => a.nclips > b.nclips && a.undo === b.undo + 1 });
    cutClips = r.after.clips;
    return `clips ${r.before.nclips}→${r.after.nclips}, undo ${r.after.undo}`;
  });
  await t.row("Ctrl+Z", "Undo", async () => {
    const r = await press("Control+z", { changes: EDIT, expect: (b, a) => a.undo === b.undo - 1 && a.redo === b.redo + 1 });
    return `clips ${r.before.nclips}→${r.after.nclips}`;
  });
  await t.row("Ctrl+Shift+Z", "Redo", async () => {
    const r = await press("Control+Shift+z", { changes: EDIT, expect: (b, a) => a.undo === b.undo + 1 && a.redo === b.redo - 1 });
    check(r.after.clips === cutClips, "Redo did not bring back exactly the cut", { cutClips, now: r.after.clips });
    return `the cut is back exactly (clips ${r.after.nclips})`;
  });
  await t.row("R", "Restore the selection", async () => {
    // Select across the cut words: from well before the cut to well after it.
    await app.key("ArrowLeft", { times: 6 });
    await app.key("Shift+ArrowRight", { times: 12 });
    const r = await press("r", { changes: EDIT, expect: (b, a) => a.nclips < b.nclips && a.undo === b.undo + 1 });
    check(r.after.nclips === 1, "R did not restore the whole selected cut", r.after.clips);
    return `clips ${r.before.nclips}→${r.after.nclips}`;
  });
  await t.row("Backspace", "Cut the word at the caret (no selection)", async () => {
    await app.key("Escape");
    const r = await press("Backspace", { changes: EDIT, expect: (b, a) => a.nclips > b.nclips && a.undo === b.undo + 1 });
    await app.key("Control+z");
    return `clips ${r.before.nclips}→${r.after.nclips}; undone`;
  });
  await t.row("I / O", "Mark the start / end of a range at the playhead", async () => {
    const r1 = await press("i", { changes: ["marks", ...SELECTION], expect: (b, a) => a.marks !== b.marks && JSON.parse(a.marks).in !== null });
    await app.key("ArrowRight", { times: 4 });
    const r2 = await press("o", { changes: ["marks", ...SELECTION], expect: (b, a) => a.marks !== b.marks && JSON.parse(a.marks).out !== null });
    // The marked range is what Delete then cuts.
    const m = JSON.parse(r2.after.marks);
    const r3 = await press("Delete", { changes: [...EDIT, "marks"], expect: (b, a) => a.nclips > b.nclips });
    const gap = await app.state((s) => [s.edit.current.clips[0].end, s.edit.current.clips[1].start]);
    const at = (x) => (typeof x === "number" ? x : x.at);
    // A mark on a word snaps to the word's cut point, in the pause just before it (spec 1.8).
    check(gap[0] <= at(m.in) + FRAME && at(m.in) - gap[0] < 400_000 && Math.abs(gap[1] - at(m.out)) <= 2 * FRAME, "Delete did not cut the marked range", { gap, m });
    await app.key("Control+z");
    return `marks ${r2.after.marks}; Delete cut ${(gap[0] / 1e6).toFixed(2)}–${(gap[1] / 1e6).toFixed(2)} s; undone`;
  });
  await app.key("Escape");
  await t.row("Enter", "Play from the caret", async () => {
    const at = await app.state((s) => s.playhead.time);
    const r = await press("Enter", { changes: PLAY, expect: (b, a) => a.playing });
    check(Math.abs(r.after.ph - at) < 1_000_000, "Enter did not play from the caret", { at, ph: r.after.ph });
    await stop();
    return `played from ${(at / 1e6).toFixed(2)} s`;
  });
  await t.row("H", "Hide / show cut text", async () => {
    await app.key("Shift+ArrowRight", { times: 2 });
    await app.key("Delete");
    await settle(app);
    const shownBefore = await app.eval(() => document.querySelectorAll("[data-pos]").length);
    const r1 = await press("h", { changes: ["hidden", ...SELECTION], expect: (b, a) => a.hidden === true });
    await settle(app);
    const shownHidden = await app.eval(() => document.querySelectorAll("[data-pos]").length);
    const r2 = await press("h", { changes: ["hidden", ...SELECTION], expect: (b, a) => a.hidden === false });
    check(shownHidden < shownBefore, "Hiding cut text showed as many words", { shownBefore, shownHidden });
    await app.key("Control+z");
    return `hidden ${r1.after.hidden}, words on screen ${shownBefore}→${shownHidden}; shown again ${!r2.after.hidden}`;
  });
  const nSug = await app.state((s, id) => s.sources[id].suggestions.suggestions.length, sid);
  await t.row("N / Shift+N", "Next / previous suggestion", async () => {
    await app.dispatch("ui.seek", { time: 0 });
  await sleep(300);
    const r1 = await press("n", { changes: ["suggestion", ...MOVE], expect: (b, a) => a.suggestion !== null && a.suggestion !== b.suggestion });
    const r2 = await press("n", { changes: ["suggestion", ...MOVE], expect: (b, a) => a.suggestion !== b.suggestion });
    const r3 = await press("Shift+n", { changes: ["suggestion", ...MOVE], expect: (b, a) => a.suggestion === r1.after.suggestion });
    return `${nSug} suggestions; ${r1.after.suggestion} → ${r2.after.suggestion} → back to ${r3.after.suggestion}`;
  });
  await t.row("A", "Accept (cut) the current suggestion", async () => {
    const r = await press("a", { changes: [...EDIT, "suggestion"], expect: (b, a) => a.nclips > b.nclips && a.undo === b.undo + 1 });
    return `clips ${r.before.nclips}→${r.after.nclips}`;
  });
  await t.row("D", "Dismiss (keep) the current suggestion", async () => {
    await app.key("n");
    const r = await press("d", { changes: ["dismissed", "undo", "redo", "suggestion", ...MOVE], expect: (b, a) => a.dismissed === b.dismissed + 1 });
    check(r.after.clips === r.before.clips, "Dismissing changed the clips");
    return `dismissed ${r.before.dismissed}→${r.after.dismissed}, clips unchanged`;
  });
  await t.row("Shift+A", "Accept all remaining suggestions", async () => {
    const left = await app.state((s, id) => {
      const sug = s.sources[id].suggestions.suggestions;
      return sug.length;
    }, sid);
    await app.key("Control+z");
    await app.key("Control+z"); // back to every suggestion pending
    const r = await press("Shift+a", { changes: [...EDIT, "suggestion", "dismissed"], expect: (b, a) => a.undo === b.undo + 1 && a.nclips >= b.nclips + Math.min(2, left) });
    await press("Control+z", { changes: [...EDIT, "suggestion", "dismissed"], expect: (b, a) => a.undo === b.undo - 1 });
    return `${left} suggestions accepted in one step (clips ${r.before.nclips}→${r.after.nclips}); one undo restored them`;
  });

  // ---------------------------------------------------------------- Timeline view
  await app.key("Tab");
  await app.waitForState((s) => s.session.view === "timeline", null, { label: "the timeline" });
  // A cut to work at: remove 20 s–25 s with S, S, Delete (rows of their own below too).
  await app.dispatch("ui.seek", { time: 10_000_000 });
  await sleep(400);
  await t.row("Timeline → / ←", "Step one frame", async () => {
    const r1 = await press("ArrowRight", { changes: MOVE, expect: (b, a) => Math.abs(a.ph - b.ph - FRAME) < 2 });
    const r2 = await press("ArrowLeft", { changes: MOVE, expect: (b, a) => Math.abs(b.ph - a.ph - FRAME) < 2 });
    return `${(r1.before.ph / 1e6).toFixed(4)} → ${(r1.after.ph / 1e6).toFixed(4)} → ${(r2.after.ph / 1e6).toFixed(4)} s`;
  });
  await t.row("Timeline Shift+→ / Shift+←", "Step one second", async () => {
    const r1 = await press("Shift+ArrowRight", { changes: MOVE, expect: (b, a) => Math.abs(a.ph - b.ph - 1e6) < 2 });
    const r2 = await press("Shift+ArrowLeft", { changes: MOVE, expect: (b, a) => Math.abs(b.ph - a.ph - 1e6) < 2 });
    return `${(r1.before.ph / 1e6).toFixed(2)} → ${(r1.after.ph / 1e6).toFixed(2)} → ${(r2.after.ph / 1e6).toFixed(2)} s`;
  });
  await t.row("Timeline S", "Split at the playhead", async () => {
    const r = await press("s", { changes: EDIT, expect: (b, a) => a.nclips === b.nclips + 1 });
    const cut = await app.state((s) => s.edit.current.clips.map((c) => c.end - c.start));
    return `clips ${r.before.nclips}→${r.after.nclips} (${cut.map((d) => (d / 1e6).toFixed(1)).join(", ")} s)`;
  });
  await app.dispatch("ui.seek", { time: 15_000_000 });
  await sleep(400);
  await app.key("s");

  await t.row("Timeline Delete", "Remove the clip under the playhead", async () => {
    await app.dispatch("ui.seek", { time: 12_000_000 });
    await sleep(400);
    const r = await press("Delete", { changes: EDIT, expect: (b, a) => a.nclips === b.nclips - 1 });
    return `clips ${r.before.nclips}→${r.after.nclips}`;
  });
  await t.row("Timeline ↓ / ↑", "Jump to next / previous cut", async () => {
    await app.dispatch("ui.seek", { time: 2_000_000 });
    await sleep(400);
    const bounds = await app.state((s) => {
      let t = 0;
      const out = [];
      for (const c of s.edit.current.clips) out.push((t += c.end - c.start));
      return out;
    });
    const r1 = await press("ArrowDown", { changes: MOVE, expect: (b, a) => a.ph > b.ph });
    check(bounds.some((x) => Math.abs(x - r1.after.ph) < 2), "↓ did not land on a cut", { ph: r1.after.ph, bounds });
    const r2 = await press("ArrowUp", { changes: MOVE, expect: (b, a) => a.ph < b.ph });
    return `${(r1.before.ph / 1e6).toFixed(2)} → cut at ${(r1.after.ph / 1e6).toFixed(3)} s → ${(r2.after.ph / 1e6).toFixed(3)} s`;
  });
  const cutAt = await app.state((s) => s.edit.current.clips[0].end - s.edit.current.clips[0].start);
  for (const [chord, label, test] of [
    ["Comma", "Nudge the end of the clip before the cut one frame earlier", (b, a) => a.clips !== b.clips],
    ["Period", "Nudge the end of the clip before the cut one frame later", (b, a) => a.clips !== b.clips],
    ["Shift+Comma", "Nudge the start of the clip after the cut one frame earlier", (b, a) => a.clips !== b.clips],
    ["Shift+Period", "Nudge the start of the clip after the cut one frame later", (b, a) => a.clips !== b.clips],
  ]) {
    await t.row(`Timeline ${chord}`, label, async () => {
      await app.dispatch("ui.seek", { time: cutAt });
      await sleep(400);
      const c0 = await app.state((s) => s.edit.current.clips.slice(0, 2).map((c) => [c.start, c.end]));
      const r = await press(chord, { changes: EDIT, expect: test });
      const c1 = await app.state((s) => s.edit.current.clips.slice(0, 2).map((c) => [c.start, c.end]));
      const d = [c1[0][1] - c0[0][1], c1[1][0] - c0[1][0]];
      const which = chord.startsWith("Shift") ? 1 : 0;
      const sign = /Comma/.test(chord) ? -1 : 1;
      check(Math.abs(d[which] - sign * FRAME) < 2 && Math.abs(d[1 - which]) < 2, `${chord} did not move the right edge by one frame`, { c0, c1 });
      await app.key("Control+z");
      return `clip ${which === 0 ? "before" : "after"} the cut: ${which === 0 ? "end" : "start"} moved ${(d[which] / 1000).toFixed(1)} ms`;
    });
  }
  await t.row("Timeline Q / W", "Trim the clip's start / end to the playhead", async () => {
    await app.dispatch("ui.seek", { time: 3_000_000 });
    await sleep(400);
    const r1 = await press("q", { changes: EDIT, expect: (b, a) => a.clips !== b.clips });
    const c1 = await app.state((s) => [s.edit.current.clips[0].start, s.edit.current.clips[0].end]);
    check(Math.abs(c1[0] - 3_000_000) < FRAME, "Q did not trim the start to the playhead", c1);
    await app.dispatch("ui.seek", { time: 4_000_000 });
    await sleep(400);
    const r2 = await press("w", { changes: EDIT, expect: (b, a) => a.clips !== b.clips });
    const c2 = await app.state((s) => [s.edit.current.clips[0].start, s.edit.current.clips[0].end]);
    check(Math.abs(c2[1] - c2[0] - 4_000_000) < FRAME * 2, "W did not trim the end to the playhead", c2);
    await app.key("Control+z");
    await app.key("Control+z");
    return `first clip ${JSON.stringify(c1)} after Q, ${JSON.stringify(c2)} after W; undone`;
  });
  await t.row("Timeline Alt+→ / Alt+←", "Move the clip later / earlier", async () => {
    await app.dispatch("ui.seek", { time: 2_000_000 });
    await sleep(400);
    const order = () => app.state((s) => s.edit.current.clips.map((c) => c.id));
    const o0 = await order();
    await press("Alt+ArrowRight", { changes: EDIT, expect: (b, a) => a.clips !== b.clips });
    const o1 = await order();
    check(o1[1] === o0[0] && o1[0] === o0[1], "Alt+→ did not move the clip one place later", { o0, o1 });
    await press("Alt+ArrowLeft", { changes: EDIT, expect: (b, a) => a.clips !== b.clips });
    const o2 = await order();
    check(JSON.stringify(o2) === JSON.stringify(o0), "Alt+← did not move it back", { o0, o2 });
    return `order ${o0.length} clips: first moved to second and back`;
  });
  await t.row("Timeline /", "Preview the nearest cut", async () => {
    await app.dispatch("ui.seek", { time: cutAt - 3_000_000 });
    await sleep(400);
    const r = await press("Slash", { changes: PLAY, expect: (b, a) => a.playing, settleMs: 0 });
    await app.waitForState((s) => !s.playhead.playing, null, { timeoutMs: 10_000, label: "the preview to end" });
    const end = await app.state((s) => s.playhead.time);
    check(r.after.ph < cutAt && end > cutAt, "The preview did not play across the cut", { from: r.after.ph, end, cutAt });
    return `played from ${(r.after.ph / 1e6).toFixed(2)} s across the cut at ${(cutAt / 1e6).toFixed(2)} s, stopped at ${(end / 1e6).toFixed(2)} s`;
  });
  await t.row("Timeline + - 0", "Zoom in / out / fit everything", async () => {
    const z1 = await press("Shift+Equal", { changes: ["zoom"], expect: (b, a) => a.zoom > b.zoom });
    await app.key("Shift+Equal");
    const z2 = await press("Minus", { changes: ["zoom"], expect: (b, a) => a.zoom < b.zoom });
    const z3 = await press("Digit0", { changes: ["zoom"], expect: (b, a) => a.zoom === 1 });
    return `zoom ${z1.before.zoom}→${z1.after.zoom}, … ${z2.before.zoom}→${z2.after.zoom}, fit ${z3.after.zoom}`;
  });

  // ---------------------------------------------------------------- Home
  await app.dispatch("ui.goHome");
  await app.waitForState((s) => s.screen === "home" && s.projects.length === 2, null, { label: "Home with two projects" });
  await t.row("Home ↓ / ↑", "Select the next / previous project", async () => {
    const r1 = await press("ArrowDown", { changes: ["homeSel"], expect: (b, a) => a.homeSel === 1 });
    const r2 = await press("ArrowUp", { changes: ["homeSel"], expect: (b, a) => a.homeSel === 0 });
    return `selection ${r1.before.homeSel}→${r1.after.homeSel}→${r2.after.homeSel}`;
  });
  await t.row("Home Delete", "Remove the selected project from the list", async () => {
    await app.key("ArrowDown");
    const id = await app.state((s) => s.projects[1].id);
    const r = await press("Delete", { changes: ["projects", "homeSel"], expect: (b, a) => a.projects === 1 });
    const stillOnDisk = fs.existsSync(path.join(app.dataDir, "projects", id, "project.json"));
    return `projects ${r.before.projects}→${r.after.projects}; its file ${stillOnDisk ? "kept" : "removed"}`;
  });
  await t.row("Home Enter", "Open the selected project", async () => {
    const r = await press("Enter", { changes: [...FIELDS], expect: (b, a) => a.screen === "editor" });
    return `opened (${r.after.nclips} clips)`;
  });

  // ---------------------------------------------------------------- the overlay lists them all
  await t.row("? lists every shortcut", "1.10: ? shows this list; every row with its key", async () => {
    await app.key("Shift+Slash");
    await app.waitForState((s) => s.dialogs.shortcuts, null, { label: "the overlay" });
    await settle(app);
    const rows = await app.eval(() =>
      Object.fromEntries([...document.querySelectorAll(".rcs-row[data-action]")].map((r) => [r.dataset.action, [...r.querySelectorAll("[title]")].map((k) => k.getAttribute("title")).join("|")])),
    );
    const missing = SPEC_ROWS.filter(([id]) => !(id in rows)).map(([id]) => id);
    const wrong = SPEC_ROWS.filter(([id, keys]) => id in rows && rows[id] !== keys).map(([id, keys]) => `${id}: shows ${rows[id]}, spec ${keys}`);
    await app.shot("overlay-all");
    check(missing.length === 0, "Rows of 1.10 missing from the overlay", missing);
    check(wrong.length === 0, "Keys in the overlay differ from 1.10", wrong);
    result.overlay = rows;
    return `${SPEC_ROWS.length} rows of 1.10 listed with the spec's keys (${Object.keys(rows).length} rows in all, with Home and Export)`;
  });

  // ---------------------------------------------------------------- rebinding
  /** Highlights the overlay row of `id` with the arrows and presses Enter on it. */
  async function captureRow(id) {
    const want = await app.eval((a) => [...document.querySelectorAll(".rcs-row[data-action]")].findIndex((r) => r.dataset.action === a), id);
    check(want >= 0, `No overlay row for ${id}`);
    await app.key("Home");
    await app.key("ArrowDown", { times: want });
    const at = await app.eval(() => document.querySelector(".rcs-row[data-active]")?.dataset.action);
    check(at === id, "The arrows did not reach the row", { at, id });
    await app.key("Enter");
    await app.waitFor((a) => document.querySelector(`.rcs-row[data-action="${a}"]`)?.hasAttribute("data-waiting"), id, { label: "the row waiting for a key" });
  }
  await t.row("Rebind a key", "1.10: remappable; the new key works and the old one does not", async () => {
    await captureRow("timeline.split");
    await app.key("x");
    await app.waitFor(() => document.querySelector('.rcs-row[data-action="timeline.split"] [title]')?.getAttribute("title") === "X", null, { label: "Split shown on X" });
    await settle(app);
    await app.shot("rebound-split");
    await app.key("Escape");
    await app.waitForState((s) => !s.dialogs.shortcuts, null, { label: "the overlay closed" });
    const saved = await app.waitForState((s) => (s.settings?.keyBindings ?? []).find((b) => b.action === "timeline.split") ?? null, null, { label: "the binding in the settings" });
    if ((await app.state((s) => s.session.view)) !== "timeline") await app.key("Tab");
    await app.waitForState((s) => s.session.view === "timeline", null, { label: "the timeline" });
    await app.dispatch("ui.seek", { time: 40_000_000 });
    await sleep(400);
    const n0 = await app.state((s) => s.edit.current.clips.length);
    await app.key("s");
    await sleep(500);
    check((await app.state((s) => s.edit.current.clips.length)) === n0, "S still splits after Split was moved to X");
    const r = await press("x", { changes: EDIT, expect: (b, a) => a.nclips === b.nclips + 1 });
    return `Split moved to X (saved ${JSON.stringify(saved)}); S does nothing; X splits (${r.before.nclips}→${r.after.nclips} clips)`;
  });
  await t.row("Rebind to a key already taken", "1.10 / 3.5.2: refused with the action that has it; the old key is kept", async () => {
    await app.key("Shift+Slash");
    await app.waitForState((s) => s.dialogs.shortcuts, null, { label: "the overlay" });
    await captureRow("timeline.trimStart");
    await app.key("w");
    const msg = await app.waitFor(() => {
      const el = document.querySelector(".rcs-status[data-error]");
      return el ? el.textContent : null;
    }, null, { label: "the refusal" });
    await settle(app);
    await app.shot("rebind-refused");
    // The refusal must be readable where the key was pressed (the row is far down the list).
    const seen = await app.eval(() => {
      const el = document.querySelector(".rcs-status[data-error]");
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + Math.min(40, r.width / 2), r.top + r.height / 2);
      return { onTop: !!hit && el.contains(hit), top: r.top, bottom: r.bottom, h: innerHeight };
    });
    check(seen.onTop && seen.top >= 0 && seen.bottom <= seen.h, "The refusal is not visible on screen (scrolled away or covered)", seen);
    await app.key("Escape"); // keep the old key
    await sleep(200);
    const keys = await app.eval(() => document.querySelector('.rcs-row[data-action="timeline.trimStart"] [title]')?.getAttribute("title"));
    const err = await app.state((s) => s.rebindError);
    await app.key("Escape");
    await app.waitForState((s) => !s.dialogs.shortcuts, null, { label: "the overlay closed" });
    check(/trim/i.test(msg) && /end/i.test(msg), "The refusal does not name the action that has W", msg);
    check(keys === "Q", "Trim start lost its key Q", keys);
    return `refused: "${msg.trim()}" (${JSON.stringify(err)}); Trim start keeps Q`;
  });
  await app.close();

  app = await ctx.launch({ settings });
  await t.row("Rebinding survives a restart", "Settings.keyBindings: still X after closing and starting the app", async () => {
    const onDisk = JSON.parse(fs.readFileSync(path.join(app.dataDir, "settings.json"), "utf8")).keyBindings;
    check(onDisk.some((b) => b.action === "timeline.split"), "settings.json does not hold the binding", onDisk);
    await app.waitForState((s) => s.screen === "home" && s.projects.length === 1, null, { label: "Home" });
    await app.key("Enter");
    await app.waitForState((s) => s.screen === "editor", null, { timeoutMs: 15_000, label: "the project open" });
    if ((await app.state((s) => s.session.view)) !== "timeline") await app.key("Tab");
    await app.waitForState((s) => s.session.view === "timeline", null, { label: "the timeline" });
    await app.dispatch("ui.seek", { time: 50_000_000 });
    await sleep(500);
    const n0 = await app.state((s) => s.edit.current.clips.length);
    await app.key("s");
    await sleep(500);
    check((await app.state((s) => s.edit.current.clips.length)) === n0, "S splits again after the restart");
    await app.key("x");
    await app.waitForState((s, n) => s.edit.current.clips.length === n + 1, n0, { label: "X to split after the restart" });
    return `settings.json ${JSON.stringify(onDisk)}; X splits, S does not`;
  });
  await app.close();
  t.finish();
}
