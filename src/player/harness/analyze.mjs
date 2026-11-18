// Turns the harness results (results/<tag>_*.json) into the numbers reported for the player.
// Usage: node analyze.mjs <tag> [resultsDir]
//
// Definitions (the experiment's, spikes/player/analyze.py):
//   transition  time from the first sample showing the outgoing clip's last shown frame to the
//               first sample showing the incoming clip's first frame; ideal = one frame at the rate.
//   extra       transition minus ideal (0 = seamless; negative = last frame cut short). The "gap"
//               at a cut is max(0, extra); spec 3.7 asks for it to stay under one frame.
//   wrong       a sample showing a frame not in the sequence, or out of order. unreadable: marker
//               did not decode. stall: one frame held more than 3 frame durations.
//   audio dip   time the tone is below 1/3 of its level within -50..+250 ms of a cut.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const tag = process.argv[2];
const dir = process.argv[3] ?? join(HERE, "results");
if (!tag) {
  console.error("usage: node analyze.mjs <tag> [resultsDir]");
  process.exit(2);
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const f1 = (x) => (x === null || x === undefined ? "n/a" : (Math.round(x * 10) / 10).toFixed(1));

function runsOf(samples) {
  const out = [];
  for (const [t, f, kind] of samples) {
    const last = out[out.length - 1];
    if (last && last.f === f) {
      last.n++;
      last.t1 = t;
    } else out.push({ f, t0: t, t1: t, n: 1, kind });
  }
  return out;
}

function analyseSequence(d) {
  const ideal = 1000 / d.fps / d.rate;
  const index = new Map(d.expected.map((m, i) => [m, i]));
  const total = d.expected.length;
  let rs = runsOf(d.samples);
  // Start at the first frame of the first clip on screen (the very first frame can be up for
  // less than a refresh when play starts).
  const first = rs.findIndex((r) => (index.get(r.f) ?? Infinity) < d.cum[1]);
  let last = -1;
  rs.forEach((r, i) => {
    if (r.f === d.expected[total - 1]) last = i;
  });
  rs = rs.slice(first, last + 1);
  let wrong = 0;
  let unreadable = 0;
  let maxpos = -1;
  const shown = new Set();
  const wrongAt = [];
  for (const r of rs) {
    if (r.f < 0) {
      unreadable += r.n;
      continue;
    }
    const k = index.get(r.f);
    if (k === undefined || k < maxpos) {
      wrong += r.n;
      r.wrong = true;
      wrongAt.push(r.f);
      continue;
    }
    maxpos = k;
    shown.add(k);
  }
  const clipOf = (k) => {
    let c = 0;
    while (c + 1 < d.cum.length && d.cum[c + 1] <= k) c++;
    return c;
  };
  const firstRun = new Map();
  rs.forEach((r, i) => {
    if (!firstRun.has(r.f)) firstRun.set(r.f, i);
  });
  const cuts = [];
  for (let c = 1; c < d.cum.length; c++) {
    const F = d.expected[d.cum[c]];
    const L = d.expected[d.cum[c] - 1];
    const iF = firstRun.get(F);
    if (iF === undefined) {
      cuts.push({ c, missing: true });
      continue;
    }
    let iL = -1;
    for (let i = iF - 1; i >= 0; i--) {
      const k = index.get(rs[i].f);
      if (k !== undefined && clipOf(k) === c - 1 && !rs[i].wrong) {
        iL = i;
        break;
      }
    }
    if (iL < 0) {
      cuts.push({ c, missing: true });
      continue;
    }
    // First sample of the last-shown frame of the outgoing clip.
    let iL0 = iL;
    while (iL0 > 0 && rs[iL0 - 1].f === rs[iL].f) iL0--;
    const transition = rs[iF].t0 - rs[iL0].t0;
    const hold = iF + 1 < rs.length ? rs[iF + 1].t0 - rs[iF].t0 : null;
    const wrongBetween = rs.slice(iL + 1, iF).some((r) => r.wrong);
    cuts.push({ c, at: rs[iF].t0, lastShown: rs[iL].f === L, transition, extra: transition - ideal, hold, wrongBetween });
  }
  const good = cuts.filter((x) => !x.missing);
  const extras = good.map((x) => x.extra);
  // The last frame stays up after the end by design: not a stall.
  const stalls = rs.slice(0, -1).filter((r) => r.f >= 0 && r.t1 - r.t0 > 3 * ideal + 1).length;
  // Audio: the tone level per quantum, on the page's performance.now() timeline.
  let dips = [];
  let dropouts = 0;
  if (d.audio && d.audio.stamp && d.audio.batches.length) {
    const sr = d.audio.sampleRate;
    const q = [];
    for (const b of d.audio.batches)
      b.rms.forEach((v, i) => q.push([d.audio.stamp.performanceTime + (((b.frame0 + i * 128) / sr) - d.audio.stamp.contextTime) * 1000, v]));
    const t0 = rs.length ? rs[0].t0 : 0;
    const t1 = rs.length ? rs[rs.length - 1].t1 : 0;
    const during = q.filter(([t]) => t >= t0 && t <= t1);
    const level = median(during.map(([, v]) => v)) ?? 0;
    const qms = (128 / sr) * 1000;
    const low = (v) => v < level / 3;
    dips = good.map((cut) => during.filter(([t, v]) => t >= cut.at - 50 && t <= cut.at + 250 && low(v)).length * qms);
    // Away from cuts: runs of low quanta longer than 10 ms.
    let run = 0;
    for (const [t, v] of during) {
      const nearCut = good.some((cut) => t >= cut.at - 60 && t <= cut.at + 260);
      if (low(v) && !nearCut) {
        run += qms;
      } else {
        if (run > 10) dropouts++;
        run = 0;
      }
    }
    if (run > 10) dropouts++;
  }
  // Cuts whose gap reached one frame, with the length of the clip before and after (a clip
  // shorter than the waiting element's prepare leaves it no time to get ready).
  const overFrame = good
    .filter((x) => x.extra >= ideal)
    .map((x) => ({ cut: x.c, extra: x.extra, outFrames: d.cum[x.c] - d.cum[x.c - 1], inFrames: (d.cum[x.c + 1] ?? total) - d.cum[x.c] }));
  return {
    overFrame,
    set: d.set,
    rate: d.rate,
    ended: d.ended,
    refreshMs: d.refreshMs,
    cuts: cuts.length,
    missingCuts: cuts.filter((x) => x.missing).length,
    extraMedian: median(extras),
    extraMin: extras.length ? Math.min(...extras) : null,
    extraMax: extras.length ? Math.max(...extras) : null,
    gapMax: extras.length ? Math.max(0, ...extras) : null,
    ideal,
    underOneFrame: extras.every((x) => x < ideal),
    wrongSamples: wrong,
    wrongCuts: good.filter((x) => x.wrongBetween).length,
    wrongFrames: [...new Set(wrongAt)].slice(0, 10),
    unreadable,
    stalls,
    lastNeverShown: good.filter((x) => !x.lastShown).length,
    framesNeverShown: total - shown.size,
    holdMedian: median(good.map((x) => x.hold).filter((x) => x !== null)),
    holdMax: Math.max(...good.map((x) => x.hold ?? 0)),
    dipMedian: median(dips),
    dipMax: dips.length ? Math.max(...dips) : null,
    dropouts,
  };
}

function analyseSwitch(d) {
  const ideal = 1000 / d.fps;
  const rs = runsOf(d.samples.filter(([, f]) => f >= 0));
  const switches = d.loads.map((load) => {
    const want = load.to === "proxy" ? 1 : 0;
    const i = rs.findIndex((r) => r.t0 >= load.t && r.kind === want);
    if (i <= 0) return { to: load.to, seen: false };
    const prev = rs[i - 1];
    return {
      to: load.to,
      seen: true,
      afterMs: rs[i].t0 - load.t,
      oldLast: prev.f,
      newFirst: rs[i].f,
      step: rs[i].f - prev.f,
      extra: rs[i].t0 - prev.t0 - ideal,
    };
  });
  let backwards = 0;
  let skipped = 0;
  for (let i = 1; i < rs.length; i++) {
    const s = rs[i].f - rs[i - 1].f;
    if (s < 0) backwards++;
    if (s > 1) skipped += s - 1;
  }
  return { switches, backwards, skipped, unreadable: d.samples.filter(([, f]) => f === -1).length };
}

const files = readdirSync(dir).filter((f) => f.startsWith(`${tag}_`) && f.endsWith(".json"));
const load = (f) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const seq = files.filter((f) => f.includes("_seq_")).map((f) => analyseSequence(load(f)));
seq.sort((a, b) => (a.set === b.set ? a.rate - b.rate : a.set < b.set ? 1 : -1));
console.log(`\n## Cuts (${tag}), refresh measured by the player: ${seq.map((s) => f1(s.refreshMs)).join(", ")} ms\n`);
console.log("| Sources | Rate (ideal frame) | Cuts | Extra: median (min .. max) ms | Gap max ms | Under one frame | Wrong frame shown (cuts / samples) | Unreadable | Stalls | Last frame never shown | Frames never shown | First incoming frame held, median (max) ms | Audio dip median (max) ms | Audio dropouts away from cuts | Ended |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const s of seq)
  console.log(
    `| ${s.set === "one" ? "one" : "two (mixed)"} | ${s.rate}x (${f1(s.ideal)}) | ${s.cuts - s.missingCuts}/${s.cuts} | ${f1(s.extraMedian)} (${f1(s.extraMin)} .. ${f1(s.extraMax)}) | ${f1(s.gapMax)} | ${s.underOneFrame ? "yes" : "NO"} | ${s.wrongCuts} / ${s.wrongSamples}${s.wrongFrames.length ? " " + JSON.stringify(s.wrongFrames) : ""} | ${s.unreadable} | ${s.stalls} | ${s.lastNeverShown} | ${s.framesNeverShown} | ${f1(s.holdMedian)} (${f1(s.holdMax)}) | ${f1(s.dipMedian)} (${f1(s.dipMax)}) | ${s.dropouts} | ${s.ended} |`,
  );
for (const s of seq)
  for (const o of s.overFrame)
    console.log(
      `\nGap of one frame or more: ${s.set} ${s.rate}x, cut ${o.cut}: extra ${f1(o.extra)} ms; clip before ${o.outFrames} frames (${f1(o.outFrames * s.ideal)} ms at this rate), clip after ${o.inFrames} frames`,
    );
const sw = files.find((f) => f.endsWith("_switch_play.json"));
if (sw) {
  const a = analyseSwitch(load(sw));
  console.log(`\n## Original <-> proxy while playing (${tag})\n`);
  console.log("| Switch to | Visible after (ms) | Last old frame | First new frame | Step | Extra at switch (ms) |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const s of a.switches)
    console.log(s.seen ? `| ${s.to} | ${f1(s.afterMs)} | ${s.oldLast} | ${s.newFirst} | ${s.step} | ${f1(s.extra)} |` : `| ${s.to} | not seen | | | | |`);
  console.log(`\nWhole run: ${a.backwards} backward jumps, ${a.skipped} frames skipped, ${a.unreadable} unreadable samples.`);
}
const sp = files.find((f) => f.endsWith("_switch_paused.json"));
if (sp) {
  const d = load(sp);
  console.log(`\n## Original -> proxy while paused (${tag})\n`);
  console.log("| Frame | Marker before | Marker after | Switch visible after (ms) | Reported position kept |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const r of d.results) console.log(`| ${r.frame} | ${r.before} | ${r.after} | ${f1(r.ms)} | ${r.reportedSame} |`);
}
const st = files.find((f) => f.endsWith("_steps.json"));
if (st) {
  const d = load(st);
  const ok = d.steps.filter((s) => s.got === s.want).length;
  console.log(`\n## Steps (${tag}): ${ok} / ${d.steps.length} showed the right frame; median ${f1(median(d.steps.map((s) => s.ms)))} ms, max ${f1(Math.max(...d.steps.map((s) => s.ms)))} ms`);
}
