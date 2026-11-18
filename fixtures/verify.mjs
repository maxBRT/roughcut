// Helpers for tests that check generated media (fixtures and exports).
// Node built-ins only; needs ffmpeg and ffprobe on PATH.
//
//   import { countFrames, frameTimestamps, findBeepOnsets } from '../fixtures/verify.mjs';
//
// All times are seconds (floating point) unless the name says otherwise.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, ffprobeJson } from './lib/proc.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_OUT = join(HERE, 'out');
export const PROJECT_ROOT = resolve(HERE, '..');

/** Read fixtures/out/manifest.json (throws if fixtures were not generated: run `npm run fixtures`). */
export function readManifest() {
  const p = join(FIXTURES_OUT, 'manifest.json');
  if (!existsSync(p)) throw new Error(`fixture manifest missing: ${p} (run "npm run fixtures")`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** Absolute path of a fixture's main file by name, e.g. fixturePath('numbered-4k-h264'). */
export function fixturePath(name) {
  const m = readManifest();
  const f = m.fixtures[name];
  if (!f) throw new Error(`unknown fixture "${name}"; known: ${Object.keys(m.fixtures).join(', ')}`);
  return join(PROJECT_ROOT, f.path);
}

/** ffprobe -show_format -show_streams as parsed JSON. */
export function probe(file) {
  return ffprobeJson(file, ['-show_format', '-show_streams']);
}

/**
 * Count the video frames of a file.
 * decode=true (default) decodes every frame (exact, slower: a few seconds for 30 s of 4K).
 * decode=false counts packets (fast; equal to frames for the codecs used here).
 */
export async function countFrames(file, { stream = 0, decode = true } = {}) {
  const sel = `v:${stream}`;
  const args = decode
    ? ['-count_frames', '-select_streams', sel, '-show_entries', 'stream=nb_read_frames']
    : ['-count_packets', '-select_streams', sel, '-show_entries', 'stream=nb_read_packets'];
  const j = await ffprobeJson(file, args);
  const s = j.streams?.[0];
  if (!s) throw new Error(`${file}: no video stream ${stream}`);
  const n = Number(decode ? s.nb_read_frames : s.nb_read_packets);
  if (!Number.isFinite(n)) throw new Error(`${file}: ffprobe gave no frame count`);
  return n;
}

/**
 * Presentation timestamps of every video frame, ascending, in seconds.
 * decode=false (default) reads packet timestamps (fast, no decoding) and sorts them;
 * decode=true reads decoded-frame best-effort timestamps.
 */
export async function frameTimestamps(file, { stream = 0, decode = false } = {}) {
  const sel = `v:${stream}`;
  const args = decode
    ? ['-select_streams', sel, '-show_entries', 'frame=best_effort_timestamp_time']
    : ['-select_streams', sel, '-show_entries', 'packet=pts_time'];
  const j = await ffprobeJson(file, args);
  const list = decode ? j.frames || [] : j.packets || [];
  const ts = list
    .map((p) => Number(decode ? p.best_effort_timestamp_time : p.pts_time))
    .filter((x) => Number.isFinite(x));
  ts.sort((a, b) => a - b);
  return ts;
}

/** Frame durations (differences between consecutive timestamps) and whether they are all equal. */
export function frameRateSummary(timestamps, toleranceSec = 0.0005) {
  const deltas = [];
  for (let i = 1; i < timestamps.length; i++) deltas.push(timestamps[i] - timestamps[i - 1]);
  const min = Math.min(...deltas);
  const max = Math.max(...deltas);
  return { frames: timestamps.length, minDelta: min, maxDelta: max, constant: max - min <= toleranceSec, deltas };
}

/**
 * Decode one audio track to mono 32-bit float PCM (channels averaged unless channel is given).
 * @returns {Promise<{sampleRate:number, samples:Float32Array}>}
 */
export async function decodeAudio(file, { track = 0, sampleRate = 48000, channel = null } = {}) {
  const af = channel === null ? ['-ac', '1'] : ['-af', `pan=mono|c0=c${channel}`];
  const r = await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', file,
    '-map', `0:a:${track}`, ...af, '-ar', String(sampleRate), '-f', 'f32le', '-c:a', 'pcm_f32le', 'pipe:1',
  ]);
  const b = r.stdout;
  const copy = Buffer.from(b.subarray(0, b.length - (b.length % 4)));
  return { sampleRate, samples: new Float32Array(copy.buffer, copy.byteOffset, copy.length / 4) };
}

/**
 * Find beeps (tone bursts separated by silence) in already-decoded samples.
 * A beep starts at the first sample whose magnitude exceeds `threshold` (relative to the
 * track's peak) after at least `minGapSec` below it. Returns objects:
 *   { onset, end, duration, freqHz, peak }   (seconds; freqHz from zero crossings)
 */
export function findBeepsInSamples(samples, sampleRate, { threshold = 0.1, minGapSec = 0.3, absoluteThreshold = 1e-4 } = {}) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak < absoluteThreshold) return [];
  const thr = peak * threshold;
  const minGap = Math.round(minGapSec * sampleRate);
  const beeps = [];
  let cur = null;
  let lastLoud = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > thr) {
      if (cur === null || i - lastLoud > minGap) {
        if (cur) beeps.push(cur);
        cur = { start: i, last: i, peak: a };
      } else {
        cur.last = i;
        if (a > cur.peak) cur.peak = a;
      }
      lastLoud = i;
    }
  }
  if (cur) beeps.push(cur);
  return beeps.map((b) => {
    let crossings = 0;
    for (let i = b.start + 1; i <= b.last; i++) {
      if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++;
    }
    const dur = (b.last - b.start + 1) / sampleRate;
    return {
      onset: b.start / sampleRate,
      end: (b.last + 1) / sampleRate,
      duration: dur,
      freqHz: dur > 0 ? crossings / 2 / dur : 0,
      peak: b.peak,
    };
  });
}

/** Decode an audio track and return its beeps (see findBeepsInSamples). */
export async function findBeeps(file, { track = 0, sampleRate = 48000, ...opts } = {}) {
  const { samples } = await decodeAudio(file, { track, sampleRate });
  return findBeepsInSamples(samples, sampleRate, opts);
}

/** Decode an audio track and return beep onset times in seconds, ascending. */
export async function findBeepOnsets(file, opts = {}) {
  return (await findBeeps(file, opts)).map((b) => b.onset);
}

/** Peak absolute sample value (0..1) of an audio track; 0 means digital silence. */
export async function audioPeak(file, { track = 0, sampleRate = 48000 } = {}) {
  const { samples } = await decodeAudio(file, { track, sampleRate });
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  return peak;
}

/**
 * For the numbered fixtures: frame index shown at time t of a CFR file with frame rate fps.
 * (The burned-in number of frame i is i, counted from 0.)
 */
export function frameAt(t, fps) {
  return Math.floor(t * fps + 1e-6);
}
