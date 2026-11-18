// Scenario "timeline" (spec 1.7 D, 1.8 "On the timeline", 1.10 Timeline view; milestone 2).
//
// On speech-2min (1080p30 with its frame number burned in, and real speech for the caption):
// Tab switches views keeping the playhead and the selection; then every Timeline key of 1.10
// is pressed as the user would (step, jump between cuts, nudge both edges both ways, trim to
// the playhead, split, remove, move earlier and later, zoom in, out and to fit), and the mouse
// places the playhead, drags an edge and drags a clip. After each step the clip list, the
// picture at the playhead (its frame number read from a screenshot of the player), the canvas
// (clips, gaps, outline, waveform, playhead), the caption and "cut n of m" are checked. Finally
// undo walks every edit back to the single original clip and redo replays them exactly.

import path from "node:path";
import { check, fail, sleep } from "../lib/app.mjs";
import { fixture } from "../lib/media.mjs";
import { readerFor } from "../lib/frames.mjs";
import { dropFiles, waitImported } from "../lib/steps.mjs";
import { checkDrawing, expectPicture, readTrack, sourceFrameAt, timelineState } from "../lib/track.mjs";
import { settle, tokens } from "../lib/transcript.mjs";

const FPS = 30;
const F = (k) => Math.floor((k * 1e6) / FPS + 0.5);
const frameOf = (t) => Math.floor((t * FPS) / 1e6 + 1e-3);
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

export async function run(ctx) {
  const { log, result, runDir } = ctx;
  const file = fixture("speech-2min");
  const reader = readerFor(file);
  const app = await ctx.launch({ settings: { exportFolder: path.join(runDir, "exports") } });
  await dropFiles(app, [file]);
  const sid = await app.state((s) => s.project.sources[0].id);
  await waitImported(app, sid);
  const D = await app.state((s) => s.project.sources[0].media.duration);
  const toks = await tokens(app);
  const words = toks.filter((t) => !t[1].startsWith("<"));
  const steps = (result.steps = []);
  let shotN = 0;

  /** The clip list as [start, end] pairs, in sequence order. */
  const spans = (st) => st.clips.map((c) => [c.start, c.end]);
  const sameSpans = (a, b) => a.length === b.length && a.every((x, i) => near(x[0], b[i][0]) && near(x[1], b[i][1]));

  /**
   * Waits for the store to settle, then checks the clip list (when `clips` is given), the
   * playhead (when `at` is given), the drawing, the picture and the caption; screenshots.
   */
  async function verify(what, { clips, at, picture = true, waveform = true } = {}) {
    await settle(app);
    let st = await timelineState(app);
    if (at !== undefined) {
      st = await app
        .waitForState((s, t) => (Math.abs(s.playhead.time - t) <= 2 ? true : null), at, { timeoutMs: 3000, label: `${what}: the playhead at ${at}`, describe: (s) => s.playhead })
        .then(() => timelineState(app));
    }
    if (clips) check(sameSpans(spans(st), clips), `${what}: the clip list is wrong`, { got: spans(st), want: clips });
    await settle(app);
    await sleep(60);
    const tr = await readTrack(app);
    checkDrawing(tr, st, what, { waveform });
    let shown = null;
    if (picture && st.playhead < st.duration - 1000) {
      const want = sourceFrameAt(st, st.playhead, FPS).frame;
      shown = (await expectPicture(app, reader, want, what)).value;
    }
    // Caption: the word holding the playhead's source moment is the bold one.
    const pos = st.position;
    const w = pos && words.find((t) => t[6] === pos.sourceId && t[3] <= pos.at && pos.at < t[4] && t[2] !== "cut");
    if (w) check(tr.caption.bold === w[1], `${what}: the caption's current word is "${tr.caption.bold}", the playhead is in "${w[1]}"`, tr.caption);
    if (w) check(tr.caption.text.includes(w[1]), `${what}: the caption does not show the word at the playhead`, tr.caption);
    const name = `${String(++shotN).padStart(2, "0")}-${what.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}`;
    await app.shot(name);
    steps.push({ what, clips: spans(st), playhead: st.playhead, frame: shown, counter: tr.counter, caption: tr.caption.text, zoom: tr.zoomText });
    log(`  ${what}: clips ${JSON.stringify(spans(st).map(([a, b]) => [frameOf(a), frameOf(b)]))} playhead f${frameOf(st.playhead)} picture ${shown} | ${tr.counter} | ${tr.zoomText} | "${tr.caption.text}"`);
    return st;
  }

  // ---- A. Tab carries the playhead and the selection both ways
  await app.key("ArrowRight", { times: 6, delayMs: 40 });
  await app.key("Shift+ArrowRight", { times: 3, delayMs: 40 });
  await settle(app);
  await sleep(300);
  const inText = await timelineState(app);
  check(inText.view === "transcript" && inText.selection.anchor !== inText.selection.focus, "Could not make a selection in the Transcript view", inText);
  const selectedText = await app.eval(() => [...document.querySelectorAll('[data-view="transcript"] .rc-sel')].map((e) => e.textContent).join(" "));
  await app.shot("selection-in-transcript");
  await app.key("Tab");
  await app.waitForState((s) => s.session.view === "timeline", null, { label: "the Timeline view after Tab" });
  const inTimeline = await verify("tab to timeline");
  check(inTimeline.playhead === inText.playhead, "Tab to the timeline moved the playhead", { before: inText.playhead, after: inTimeline.playhead });
  check(
    inTimeline.selection.anchor === inText.selection.anchor && inTimeline.selection.focus === inText.selection.focus,
    "Tab to the timeline dropped the selection",
    { before: inText.selection, after: inTimeline.selection },
  );
  // The waveform follows the sound: flat in the fixture's 6 s pause (90.6–96.6 s), tall in speech (68–84 s).
  {
    const tr = await readTrack(app);
    const sx = tr.width / D;
    const barsIn = (a, b) => tr.clips[0].bars.filter(([x]) => x >= a * 1e6 * sx && x <= b * 1e6 * sx).map(([, h]) => h);
    const pause = barsIn(91.5, 95.5);
    const speech = barsIn(68, 84).sort((a, b) => a - b);
    const median = speech[Math.floor(speech.length / 2)];
    log(`  waveform: ${pause.length} bars in the pause, max ${Math.max(...pause)} px; ${speech.length} in speech, median ${median} px`);
    check(pause.length > 5 && Math.max(...pause) <= 3, "The waveform is not flat in the 6 s pause", pause);
    check(speech.length > 20 && median >= 10, "The waveform is not tall where there is speech", speech);
    result.waveform = { pauseMaxPx: Math.max(...pause), speechMedianPx: median };
  }
  await app.key("Tab");
  await app.waitForState((s) => s.session.view === "transcript", null, { label: "the Transcript view after Tab" });
  await settle(app);
  const back = await timelineState(app);
  const selectedBack = await app.eval(() => [...document.querySelectorAll('[data-view="transcript"] .rc-sel')].map((e) => e.textContent).join(" "));
  check(back.playhead === inText.playhead, "Tab back to the transcript moved the playhead", { before: inText.playhead, after: back.playhead });
  check(back.selection.anchor === inText.selection.anchor && back.selection.focus === inText.selection.focus, "Tab back to the transcript lost the selection", { before: inText.selection, after: back.selection });
  check(selectedBack === selectedText && selectedText.length > 0, "The transcript does not show the same words selected after Tab twice", { selectedText, selectedBack });
  await app.shot("selection-back-in-transcript");
  log(`  Tab both ways kept playhead ${inText.playhead} and selection "${selectedText}"`);
  await app.key("Escape");
  await app.key("Tab");
  await app.waitForState((s) => s.session.view === "timeline", null, { label: "the Timeline view" });

  // ---- B. Click on the ruler places the playhead (real pointer), then step by frames and seconds
  const box = await app.eval(() => {
    const r = document.querySelector('canvas[data-part="track"]').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const xOf = (t, dur) => box.x + (t / dur) * box.w;
  await app.page.mouse.click(xOf(F(300), D) + 0.5, box.y + 10);
  let st = await app.waitForState((s) => (Math.abs(s.playhead.time - 10e6) < 200_000 ? s.playhead.time : null), null, { label: "a click on the ruler to place the playhead near 0:10" });
  check(st % 1 === 0 && Math.abs(st - F(frameOf(st))) <= 1, "A click placed the playhead off the frame grid", { t: st });
  const T0 = F(frameOf(st));
  await verify("click on the ruler", { at: T0, clips: [[0, D]] });
  await app.key("ArrowRight", { times: 3, delayMs: 60 });
  await verify("three frames on", { at: T0 + F(3) - 0 });
  await app.key("ArrowLeft");
  await verify("one frame back", { at: F(frameOf(T0) + 2) });
  await app.key("Shift+ArrowRight");
  await verify("one second on", { at: F(frameOf(T0) + 2 + FPS) });
  await app.key("Shift+ArrowLeft");
  const T1 = F(frameOf(T0) + 2);
  await verify("one second back", { at: T1 });

  // ---- C. Split twice, then step between the cuts
  await app.key("s");
  await verify("split", { clips: [[0, T1], [T1, D]], at: T1 });
  await app.key("Shift+ArrowRight", { times: 5, delayMs: 60 });
  const T2 = T1 + F(5 * FPS);
  await verify("five seconds on", { at: T2 });
  await app.key("s");
  await verify("second split", { clips: [[0, T1], [T1, T2], [T2, D]], at: T2 });
  await app.key("ArrowUp");
  await verify("previous cut", { at: T1 });
  await app.key("ArrowDown");
  await verify("next cut", { at: T2 });
  await app.key("ArrowDown");
  // Past the last cut the playhead goes to the end: the last frame is shown (the player lands on it).
  await app.waitForState((s, d) => s.playhead.time >= d - 33_400, D, { label: "the playhead at the end after the last cut" });
  await verify("next cut at the last one goes to the end", { picture: false });
  await expectPicture(app, reader, 3827, "at the end");
  await app.key("ArrowUp");
  await verify("previous cut from the end", { at: T2 });
  await app.key("ArrowUp");
  await app.key("ArrowUp");
  await verify("previous cut from the first cut goes to the start", { at: 0 });

  // ---- D. Remove the middle clip
  await app.key("ArrowDown");
  await app.key("Shift+ArrowRight", { times: 2, delayMs: 60 });
  await verify("into the middle clip", { at: T1 + F(2 * FPS) });
  await app.key("Delete");
  await verify("remove the clip under the playhead", { clips: [[0, T1], [T2, D]], at: T1 });

  // ---- E. Nudge both edges of the cut, both ways (playhead at the cut)
  await app.key(",");
  await verify("nudge the end before the cut a frame earlier", { clips: [[0, T1 - F(1)], [T2, D]], at: T1 - F(1) });
  await app.key("ArrowLeft");
  await verify("the frame before the nudged cut", { at: T1 - F(2) });
  await app.key("ArrowRight");
  await app.key(".");
  await verify("nudge the end before the cut a frame later", { clips: [[0, T1], [T2, D]], at: T1 });
  await app.key("Shift+,");
  await verify("nudge the start after the cut a frame earlier", { clips: [[0, T1], [T2 - F(1), D]], at: T1 });
  await app.key("Shift+.");
  await verify("nudge the start after the cut a frame later", { clips: [[0, T1], [T2, D]], at: T1 });

  // ---- F. Trim the clip's start and end to the playhead
  await app.key("Shift+ArrowRight", { times: 2, delayMs: 60 });
  await verify("two seconds into the second clip", { at: T1 + F(2 * FPS) });
  await app.key("q");
  await verify("trim the start to the playhead", { clips: [[0, T1], [T2 + F(2 * FPS), D]], at: T1 });
  await app.key("Shift+ArrowRight", { times: 3, delayMs: 60 });
  await verify("three seconds on", { at: T1 + F(3 * FPS) });
  await app.key("w");
  const B = [T2 + F(2 * FPS), T2 + F(5 * FPS)];
  await verify("trim the end to the playhead", { clips: [[0, T1], B], picture: false });

  // ---- G. Split the first clip, then move clips earlier and later
  const H = F(Math.round(frameOf(T1) / 2));
  await app.dispatch("ui.seek", { time: F(60) });
  await verify("seek into the first clip", { at: F(60) });
  await app.key("ArrowDown");
  await verify("next cut", { at: T1 });
  await app.key("ArrowUp");
  await verify("back to the start", { at: 0 });
  await app.key("Shift+ArrowRight", { times: Math.round(H / 1e6), delayMs: 40 });
  const S = F(Math.round(H / 1e6) * FPS);
  await verify("into the first clip", { at: S });
  await app.key("s");
  const A1 = [0, S];
  const A2 = [S, T1];
  await verify("split the first clip", { clips: [A1, A2, B], at: S });
  await app.key("ArrowLeft", { times: 15, delayMs: 30 });
  await verify("half a second back, in the first clip", { at: S - F(15) });
  await app.key("Alt+ArrowRight");
  let moved = await verify("move the clip later", { clips: [A2, A1, B] });
  check(sourceFrameAt(moved, moved.playhead).frame === frameOf(S) - 15, "After moving the clip later the playhead is not on the same frame of it", moved);
  await app.key("Alt+ArrowRight");
  moved = await verify("move the clip later again", { clips: [A2, B, A1] });
  check(sourceFrameAt(moved, moved.playhead).frame === frameOf(S) - 15, "After moving the clip to the end the playhead is not on the same frame of it", moved);
  await app.key("Alt+ArrowRight");
  await verify("move the last clip later does nothing", { clips: [A2, B, A1] });
  await app.key("Alt+ArrowLeft");
  await verify("move the clip earlier", { clips: [A2, A1, B] });
  await app.key("Alt+ArrowLeft");
  await verify("move the clip earlier again", { clips: [A1, A2, B] });

  // ---- H. Zoom in, out and to fit
  await app.key("Shift+Equal"); // "+" on a US keyboard
  await app.waitForState((s) => s.zoom === 2, null, { label: "zoom 2 after +" });
  await verify("zoom in");
  await app.key("Shift+Equal"); // "+" on a US keyboard
  await app.waitForState((s) => s.zoom === 4, null, { label: "zoom 4 after + again" });
  await verify("zoom in again");
  await app.key("-");
  await app.waitForState((s) => s.zoom === 2, null, { label: "zoom 2 after -" });
  await verify("zoom out");
  await app.key("0");
  await app.waitForState((s) => s.zoom === 1, null, { label: "fit after 0" });
  await verify("zoom to fit");

  // ---- I. The mouse: drag the last clip's start edge 40 px left, then drag that clip to the front
  st = await timelineState(app);
  const scale = box.w / st.duration;
  const yTrack = box.y + 30 + 46;
  // B is the third clip: drag its start edge to the left by 40 px (brings back cut material
  // before it, up to the frame grid).
  const bStartX = box.x + st.starts[2] * scale;
  await app.page.mouse.move(bStartX + 1, yTrack);
  await app.page.mouse.down();
  for (let k = 1; k <= 8; k++) await app.page.mouse.move(bStartX + 1 - 5 * k, yTrack);
  await sleep(100);
  await app.shot("dragging-an-edge");
  await app.page.mouse.up();
  const want = B[0] - Math.round((40 / scale) * FPS / 1e6) * F(1);
  st = await app.waitForState((s, b0) => (s.edit.current.clips[2].start !== b0 ? s.edit.current.clips.map((c) => [c.start, c.end]) : null), B[0], {
    label: "the edge drag to trim the clip",
  });
  check(Math.abs(st[2][0] - want) <= F(2), "Dragging the edge 40 px trimmed to the wrong time", { got: st[2], want, scale });
  check(st[2][0] % 1 === 0 && Math.abs(st[2][0] - F(frameOf(st[2][0]))) <= 1, "An edge drag left the edge off the frame grid", st[2]);
  const B2 = [st[2][0], B[1]];
  await verify("drag an edge", { clips: [A1, A2, B2] });

  st = await timelineState(app);
  const bMid = box.x + ((st.starts[2] + st.starts[3]) / 2) * scale;
  await app.page.mouse.move(bMid, yTrack);
  await app.page.mouse.down();
  for (let k = 1; k <= 20; k++) await app.page.mouse.move(bMid + ((box.x + 4 - bMid) * k) / 20, yTrack);
  await sleep(100);
  await app.shot("dragging-a-clip");
  await app.page.mouse.up();
  await verify("drag a clip to the front", { clips: [B2, A1, A2] });

  // ---- J. Undo every edit back to the original clip, then redo them all
  const finalSpans = spans(await timelineState(app));
  let undos = 0;
  for (; undos < 40; undos++) {
    const n = await app.state((s) => s.edit.undo.length);
    if (n === 0) break;
    await app.key("Control+z");
    await settle(app);
  }
  await verify("undo everything", { clips: [[0, D]] });
  for (let i = 0; i < undos; i++) {
    await app.key("Control+Shift+z");
    await settle(app);
  }
  await verify("redo everything", { clips: finalSpans });
  result.undoSteps = undos;
  log(`  ${undos} undo steps back to one clip; redo restored ${JSON.stringify(finalSpans)}`);

  const errors = app.consoleErrors();
  if (errors.length) fail("Console errors", errors);
  await app.close();
}
