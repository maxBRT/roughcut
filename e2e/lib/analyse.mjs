// Turns what the in-page probes recorded (lib/probe.mjs) into numbers.
//
// samples: [t, slot, mediaTime, src, playing, playheadTime, currentTime, visible, sourceId] per animation frame
// audio:   [context, t, rms] per 128-sample block (t on the performance.now clock)

const EPS = 0.002; // seconds: media times of the same frame agree to well under this

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);

/** Median interval between animation frames (the display refresh), ms. */
export function refreshMs(samples) {
  const d = [];
  for (let i = 1; i < samples.length; i++) d.push(samples[i][0] - samples[i - 1][0]);
  return r1(median(d));
}

/**
 * One cut crossed while playing: the outgoing clip ends at `outEnd` (exclusive, seconds of its
 * source) and the incoming clip starts at `inStart` (seconds of its source). `fps` is the
 * frame rate, `rate` the playback speed. Measures, as the player experiment did
 * (spikes/player/RESULT.md):
 * - extraMs: time from the first sample showing the outgoing clip's last frame to the first
 *   showing the incoming clip's first frame, minus one frame at this speed (0 is perfect,
 *   negative means the last frame was cut short);
 * - wrong: samples that showed a frame that is not in the sequence around the cut (a frame
 *   inside the cut range, or the outgoing source past its end);
 * - lastFrameShown: whether the outgoing clip's last frame was on screen at all;
 * - firstHeldMs: how long the incoming first frame stayed on screen;
 * - audio: the longest stretch below a third of the steady level within -100..+300 ms of the
 *   picture's change, and dropouts elsewhere in the run.
 */
export function analyseCut(probe, { outEnd, inStart, fps, rate, outSlotSource, inSlotSource, playFrom, outSourceId, inSourceId }) {
  const fd = 1 / fps;
  const lastKept = outEnd - fd;
  const S = probe.samples.filter((s) => s[2] !== null && s[4] === 1);
  const isLast = (s) => Math.abs(s[2] - lastKept) < EPS && (!outSlotSource || s[3] === outSlotSource) && (!outSourceId || s[8] === outSourceId);
  // The incoming clip is on screen from the first sample showing one of its first frames (its
  // very first frame may be skipped at 2x; that is reported, not hidden).
  const isIncoming = (s) =>
    s[2] > inStart - EPS && s[2] < inStart + 0.25 * rate && (!inSlotSource || s[3] === inSlotSource) && (!inSourceId || s[8] === inSourceId);
  const iLast = S.findIndex(isLast);
  const iIn = S.findIndex((s, i) => i > iLast && isIncoming(s));
  const out = { rate, outEnd, inStart, samples: S.length };
  if (iIn < 0) return { ...out, crossed: false, seen: [...new Set(S.map((s) => r1(s[2] * 1000) / 1000))].slice(-20) };
  out.crossed = true;
  out.firstIncomingShown = S[iIn][2];
  out.incomingFramesSkipped = Math.round((S[iIn][2] - inStart) * fps);
  out.lastFrameShown = iLast >= 0 && iLast < iIn;
  // When the last kept frame was never shown, measure from the last outgoing frame that was.
  let iOut = out.lastFrameShown ? iLast : -1;
  if (iOut < 0) {
    for (let i = iIn - 1; i >= 0; i--) {
      if (S[i][2] < outEnd - EPS) {
        iOut = i;
        break;
      }
    }
    // First sample showing that frame
    if (iOut >= 0) {
      const mt = S[iOut][2];
      while (iOut > 0 && Math.abs(S[iOut - 1][2] - mt) < EPS) iOut--;
    }
  }
  out.lastShownOutgoing = iOut >= 0 ? S[iOut][2] : null;
  const ideal = (fd * 1000) / rate;
  out.idealMs = r1(ideal);
  out.gapMs = iOut >= 0 ? r1(S[iIn][0] - S[iOut][0]) : null;
  out.extraMs = iOut >= 0 && out.lastFrameShown ? r1(S[iIn][0] - S[iOut][0] - ideal) : null;
  // Wrong frames between the outgoing last frame and 300 ms after the incoming first frame.
  const tIn = S[iIn][0];
  const from = iOut >= 0 ? S[iOut][0] : tIn - 200;
  const win = S.filter((s) => s[0] >= from && s[0] <= tIn + 300);
  // Before the change: nothing past the outgoing clip's last frame. After it (300 ms): only
  // the incoming clip's own frames, from its first one onwards.
  const wrongSamples = win.filter((s) =>
    s[0] < tIn
      ? s[2] > lastKept + EPS || (outSourceId && s[8] !== outSourceId)
      : s[2] < inStart - EPS || s[2] > inStart + 0.4 * rate + EPS || (inSourceId && s[8] !== inSourceId),
  );
  out.wrong = wrongSamples.length;
  if (wrongSamples.length) out.wrongFrames = wrongSamples.slice(0, 5).map((s) => [r1(s[0] - tIn), s[2], s[3]]);
  let k = iIn;
  while (k < S.length - 1 && Math.abs(S[k + 1][2] - S[iIn][2]) < EPS) k++;
  out.firstHeldMs = k + 1 < S.length ? r1(S[k + 1][0] - tIn) : null;

  // Sound
  const A = probe.audio;
  if (A.length) {
    const steadyWin = A.filter((b) => b[1] > playFrom + 250);
    const steady = median(steadyWin.map((b) => b[2])) ?? 0;
    out.audioLevel = Math.round(steady * 1000) / 1000;
    const low = steady / 3;
    const around = A.filter((b) => b[1] >= tIn - 100 && b[1] <= tIn + 300);
    out.audioDipMs = r1(longestRun(around, (b) => b[2] < low));
    const elsewhere = A.filter((b) => b[1] > playFrom + 250 && (b[1] < tIn - 150 || b[1] > tIn + 350));
    out.audioDropoutsElsewhereMs = r1(longestRun(elsewhere, (b) => b[2] < low));
    // First loud block from 200 ms before the picture change (a sound that starts at the
    // incoming clip's first frame, such as a beep, should start with the picture).
    const onset = A.find((b) => b[1] >= tIn - 200 && b[2] > 0.05);
    out.soundOnsetVsPictureMs = onset ? r1(onset[1] - tIn) : null;
  }
  return out;
}

function longestRun(blocks, pred) {
  let best = 0;
  let start = null;
  let prevT = null;
  for (const b of blocks) {
    if (pred(b)) {
      if (start === null || (prevT !== null && b[1] - prevT > 10)) start = b[1];
      best = Math.max(best, b[1] - start + (128 / 48000) * 1000);
    } else start = null;
    prevT = b[1];
  }
  return best;
}

/** Playhead speed (sequence µs per wall ms / 1000) over samples while playing. */
export function playheadRate(samples) {
  const S = samples.filter((s) => s[4] === 1 && s[5] !== null);
  if (S.length < 10) return null;
  const a = S[Math.floor(S.length * 0.2)];
  const b = S[S.length - 1];
  return Math.round(((b[5] - a[5]) / 1000 / (b[0] - a[0])) * 1000) / 1000;
}

export function summarise(cuts) {
  const by = (xs) => ({
    median: r1(median(xs)),
    min: xs.length ? r1(Math.min(...xs)) : null,
    max: xs.length ? r1(Math.max(...xs)) : null,
  });
  const ex = cuts.map((c) => c.extraMs).filter((x) => x !== null && x !== undefined);
  const dips = cuts.map((c) => c.audioDipMs).filter((x) => x !== null && x !== undefined);
  return {
    cuts: cuts.length,
    crossed: cuts.filter((c) => c.crossed).length,
    extraMs: by(ex),
    wrong: cuts.reduce((n, c) => n + (c.wrong ?? 0), 0),
    lastFrameNeverShown: cuts.filter((c) => c.crossed && !c.lastFrameShown).length,
    firstFrameSkipped: cuts.filter((c) => c.crossed && c.incomingFramesSkipped > 0).length,
    audioDipMs: by(dips),
  };
}
