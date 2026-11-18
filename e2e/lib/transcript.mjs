// Reading the Transcript view and the edit, for the editing scenarios: what the store says
// (layout tokens, clips, selection) and what the window shows (struck-through words).

import { check, fail, sleep } from "./app.mjs";
import { readProbes, resetProbes } from "./probe.mjs";

export const FPS = 30;
export const FRAME_US = 1e6 / FPS;

/** Words compared without case or punctuation. */
export const norm = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, "");

/** The layout's tokens: [position, text, keep, start, end, cutBefore, sourceId]. */
export function tokens(app) {
  return app.state((s) =>
    s.layout.tokens.map((t, p) => [p, t.token.kind === "word" ? t.token.text : `<${t.token.kind}>`, t.keep, t.token.start, t.token.end, t.token.cutBefore, t.address.sourceId]),
  );
}

/** Position of the first token where `phrase` (space-separated words) starts, at or after `from`. */
export function findPhrase(toks, phrase, from = 0) {
  const want = phrase.split(/\s+/).map(norm);
  for (let p = from; p + want.length <= toks.length; p++) {
    if (want.every((w, k) => norm(toks[p + k][1]) === w)) return p;
  }
  fail(`The phrase "${phrase}" is not in the transcript`, toks.slice(0, 60).map((t) => t[1]).join(" "));
}

export const clips = (app) => app.state((s) => s.edit.current.clips.map((c) => ({ id: c.id, sourceId: c.sourceId, start: c.start, end: c.end })));
export const selection = (app) => app.state((s) => ({ ...s.selection }));

/** The clip list's source ranges as [start, end] pairs (one source). */
export const spans = (cl) => cl.map((c) => [c.start, c.end]);

/** The cut ranges of one source: the complement of its clips in [0, duration). */
export function cutsOf(cl, duration) {
  const kept = cl.map((c) => [c.start, c.end]).sort((a, b) => a[0] - b[0]);
  const out = [];
  let t = 0;
  for (const [s, e] of kept) {
    if (s > t) out.push([t, s]);
    t = Math.max(t, e);
  }
  if (t < duration - FRAME_US) out.push([t, duration]);
  return out;
}

/**
 * What the window shows for document positions [from, to): each token's text, whether it is
 * struck through (computed style), its data-keep and whether it is selected. Scrolls the caret
 * into view first by waiting for the rows to be rendered (the list is virtualised).
 */
export async function shown(app, from, to) {
  return app.eval(
    ([a, b]) => {
      const out = [];
      for (let p = a; p < b; p++) {
        const el = document.querySelector(`[data-view="transcript"] [data-pos="${p}"]`);
        if (!el) {
          out.push({ p, missing: true });
          continue;
        }
        const cs = getComputedStyle(el);
        out.push({
          p,
          text: el.textContent,
          keep: el.dataset.keep,
          struck: cs.textDecorationLine.includes("line-through") || el.className.includes("rc-pause--cut"),
          selected: el.className.includes("rc-sel") || el.className.includes("rc-pause--sel"),
        });
      }
      return out;
    },
    [from, to],
  );
}

/**
 * Asserts the view shows exactly the tokens in `cut` (a Set of positions) struck through among
 * [from, to), and the layout agrees (keep === "cut"), and nothing else in that window is.
 */
export async function expectStruck(app, from, to, cut, what) {
  const toks = await tokens(app);
  const view = await shown(app, from, to);
  const wrong = [];
  for (const v of view) {
    const want = cut.has(v.p);
    const t = toks[v.p];
    if (v.missing) wrong.push({ p: v.p, text: t?.[1], problem: "not rendered" });
    else if (v.struck !== want || (t[2] === "cut") !== want) wrong.push({ p: v.p, text: t[1], keep: t[2], struck: v.struck, want });
  }
  if (wrong.length) fail(`${what}: the struck-through words are wrong`, wrong);
}

/** The token containing (or the caret token for) a source moment, by cut points, from the layout. */
export function tokenAt(toks, sourceId, at) {
  let best = -1;
  for (const t of toks) if (t[6] === sourceId && t[5] <= at + 1) best = t[0];
  return best;
}

/**
 * Plays from sequence time `from` for `ms` and returns every moment of source time the top
 * video showed (rAF samples while playing), so a caller can check a cut range was skipped.
 */
export async function playAndRecord(app, from, ms) {
  await app.dispatch("ui.seek", { time: from });
  await app.waitForState((s, t) => Math.abs(s.playhead.time - t) < 50 && !s.playhead.playing, from, { label: "the seek before playing" });
  await sleep(300);
  const since = await app.eval(resetProbes);
  await app.key("Space");
  await app.waitForState((s) => s.playhead.playing, null, { timeoutMs: 3000, label: "playback to start" });
  await sleep(ms);
  await app.key("Space");
  await app.waitForState((s) => !s.playhead.playing, null, { timeoutMs: 3000, label: "pause" });
  const probe = await app.eval(readProbes, since);
  return probe.samples.filter((s) => s[4] === 1 && s[2] !== null && s[7] === 1).map((s) => ({ t: s[0], mt: s[2] * 1e6, src: s[8], ph: s[5] }));
}

/** Fails when playback showed any frame inside one of `cuts` ([start, end] µs), with a frame of slack. */
export function expectSkipped(samples, cuts, what) {
  check(samples.length > 20, `${what}: too few frames were seen while playing`, { n: samples.length });
  const inside = samples.filter((s) => cuts.some(([a, b]) => s.mt > a + FRAME_US && s.mt < b - FRAME_US));
  if (inside.length) fail(`${what}: playback showed cut material`, { cuts, inside: inside.slice(0, 10) });
  const span = [Math.min(...samples.map((s) => s.mt)), Math.max(...samples.map((s) => s.mt))];
  return span;
}

/** Waits until the store and the view have settled on the latest key press (two animation frames). */
export async function settle(app) {
  await app.eval(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}
