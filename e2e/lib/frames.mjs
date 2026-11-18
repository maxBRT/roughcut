// Reads the frame number burned into the numbered fixtures (README: "the frame index, 0-based,
// 5 digits, large in the centre"), from a video file decoded by FFmpeg or from a screenshot of
// the player. No OCR library: the five digit cells are cut out at fixed places, binarised, and
// compared with templates made from the fixture itself (every frame of the source, whose index
// is known from its position), so the reader is checked against the truth before it is used.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { E2E_ROOT, check, fail } from "./app.mjs";

/** The digit strip, as fractions of the picture (measured on the fixtures: 5 cells, x 0.253–0.745, y 0.389–0.611). */
const BOX = { x: 0.248, y: 0.38, w: 0.492, h: 0.24 };
const W = 200;
const H = 48;
const CELL = W / 5;
const CELL_PX = CELL * H;

/** The filter that turns any picture into the W×H grey digit strip. */
export const STRIP_FILTER = `crop=trunc(iw*${BOX.w}):trunc(ih*${BOX.h}):trunc(iw*${BOX.x}):trunc(ih*${BOX.y}),scale=${W}:${H}:flags=area,format=gray`;

/** Every frame of `file` (or the first `max`) as W×H grey strips, in decode order. */
export function decodeStrips(file, { stream = "v:0", max } = {}) {
  const args = ["-v", "fatal", "-i", file, "-map", `0:${stream}`, "-vf", STRIP_FILTER, "-fps_mode", "passthrough"];
  if (max) args.push("-frames:v", String(max));
  args.push("-f", "rawvideo", "-");
  const buf = execFileSync("ffmpeg", args, { maxBuffer: 1024 * 1024 * 1024 });
  const n = buf.length / (W * H);
  check(Number.isInteger(n), `Decoded strip data of ${file} is not a whole number of frames`);
  const out = [];
  for (let i = 0; i < n; i++) out.push(buf.subarray(i * W * H, (i + 1) * W * H));
  return out;
}

/** The strip of one picture file's bytes (PNG from a screenshot). */
export function stripOfImage(png) {
  const buf = execFileSync("ffmpeg", ["-v", "error", "-f", "image2pipe", "-i", "-", "-vf", STRIP_FILTER, "-frames:v", "1", "-f", "rawvideo", "-"], {
    input: png,
    maxBuffer: 16 * 1024 * 1024,
  });
  check(buf.length === W * H, `Screenshot strip has ${buf.length} bytes, expected ${W * H}`);
  return buf;
}

/** Ink (1) or paper (0) per pixel, by the midpoint of the strip's darkest and brightest; null when blank. */
function binarise(strip) {
  let lo = 255;
  let hi = 0;
  for (const v of strip) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi - lo < 40) return null;
  const mid = (lo + hi) / 2;
  const bits = new Uint8Array(strip.length);
  for (let i = 0; i < strip.length; i++) bits[i] = strip[i] > mid ? 1 : 0;
  return bits;
}

function cellOf(bits, p) {
  const out = new Uint8Array(CELL_PX);
  for (let y = 0; y < H; y++) for (let x = 0; x < CELL; x++) out[y * CELL + x] = bits[y * W + p * CELL + x];
  return out;
}

function digitsOf(n) {
  return String(n).padStart(5, "0").split("").map(Number);
}

/**
 * A reader for one fixture, or several (a list: each place's digit is the best match over all of
 * their templates, for an export that mixes sources). Templates: for each of the 5 places and
 * each digit seen there, the majority of that cell over every frame with that digit. Cached in
 * .cache-dev/e2e/digit-templates.
 */
export function readerFor(fixtureFile) {
  return makeReader((Array.isArray(fixtureFile) ? fixtureFile : [fixtureFile]).map(templatesFor));
}

function templatesFor(fixtureFile) {
  const dir = path.join(E2E_ROOT, "digit-templates");
  fs.mkdirSync(dir, { recursive: true });
  const st = fs.statSync(fixtureFile);
  const cache = path.join(dir, `${path.basename(fixtureFile)}-${st.size}-v1.json`);
  let templates;
  if (fs.existsSync(cache)) {
    templates = JSON.parse(fs.readFileSync(cache, "utf8")).map((place) => Object.fromEntries(Object.entries(place).map(([d, t]) => [d, Uint8Array.from(t)])));
  } else {
    const strips = decodeStrips(fixtureFile);
    const sums = [0, 1, 2, 3, 4].map(() => new Map());
    strips.forEach((s, n) => {
      const bits = binarise(s);
      if (!bits) fail(`Frame ${n} of ${fixtureFile} has no digits`);
      digitsOf(n).forEach((d, p) => {
        const cell = cellOf(bits, p);
        const e = sums[p].get(d) ?? { count: 0, sum: new Uint32Array(CELL_PX) };
        e.count++;
        for (let i = 0; i < CELL_PX; i++) e.sum[i] += cell[i];
        sums[p].set(d, e);
      });
    });
    templates = sums.map((m) => Object.fromEntries([...m].map(([d, e]) => [d, Uint8Array.from(e.sum, (v) => (v * 2 >= e.count ? 1 : 0))])));
    fs.writeFileSync(cache, JSON.stringify(templates.map((place) => Object.fromEntries(Object.entries(place).map(([d, t]) => [d, [...t]])))));
    // The reader must read its own source exactly before anything relies on it.
    const r = makeReader([templates]);
    const wrong = strips.map((s, n) => [n, r.read(s)]).filter(([n, got]) => got.value !== n);
    if (wrong.length) {
      fs.rmSync(cache, { force: true });
      fail(`The frame-number reader misreads ${wrong.length} frames of ${fixtureFile}`, wrong.slice(0, 10));
    }
  }
  return templates;
}

function makeReader(sets) {
  return {
    /** { value, worst } where worst is the largest share of mismatched pixels in a cell (0 = perfect). null value when blank. */
    read(strip) {
      const bits = binarise(strip);
      if (!bits) return { value: null, worst: 1 };
      let value = 0;
      let worst = 0;
      for (let p = 0; p < 5; p++) {
        const cell = cellOf(bits, p);
        let best = -1;
        let bestD = Infinity;
        for (const [d, t] of sets.flatMap((templates) => Object.entries(templates[p]))) {
          let diff = 0;
          for (let i = 0; i < CELL_PX; i++) diff += cell[i] ^ t[i];
          if (diff < bestD) {
            bestD = diff;
            best = Number(d);
          }
        }
        value = value * 10 + best;
        worst = Math.max(worst, bestD / CELL_PX);
      }
      // More than a fifth of a cell wrong: this is not a clean digit (a blend, a blank, a wrong picture).
      return worst > 0.2 ? { value: null, worst, guess: value } : { value, worst };
    },
  };
}

/** Reads every frame of a video file with `reader`: an array of frame numbers (null where unreadable). */
export function readFile(reader, file, opts) {
  return decodeStrips(file, opts).map((s) => reader.read(s).value);
}
