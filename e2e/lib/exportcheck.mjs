// Checks an exported MP4 against the edit that made it, from the file alone: every frame's
// burned-in number (so the right frame is on each side of every cut and the count is exact),
// the beeps of every audio track against the frames that should carry them (sound and picture
// within a frame of each other, to the end), the stream layout and the format.

import { execFileSync } from "node:child_process";
import { check, fail } from "./app.mjs";
import { readFile } from "./frames.mjs";
import { ffprobe } from "./media.mjs";
import { findBeepsInSamples } from "../../fixtures/verify.mjs";

/** One audio track of a file as mono float samples at 48 kHz. */
function decodeTrack(file, track) {
  const buf = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", `0:a:${track}`, "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], {
    maxBuffer: 1024 * 1024 * 1024,
  });
  const copy = Buffer.from(buf.subarray(0, buf.length - (buf.length % 4)));
  return new Float32Array(copy.buffer, copy.byteOffset, copy.length / 4);
}

/** The frame numbers an edit should give: `segments` are [first, end) source frame ranges in order. */
export function expectedFrames(segments) {
  const out = [];
  for (const [a, b] of segments) for (let n = a; n < b; n++) out.push(n);
  return out;
}

/**
 * Verifies `file`. `segments`: [first, end) source frames per kept clip, in order. `fps`: output
 * rate. `format`: {codec, bitDepth, hdr, width, height, audioTracks}. `beepEvery`: frames between
 * beeps in the source (one per whole second). For mixed or variable-rate sources the caller
 * passes `frames` (every output frame's number) and `onsets` (beep start times in the output,
 * seconds) instead. Returns the measurements.
 */
export function verifyExport(file, reader, { segments, frames, onsets, fps, format, beepEvery = fps }) {
  const info = ffprobe(file);
  const v = info.streams.filter((s) => s.codec_type === "video");
  const a = info.streams.filter((s) => s.codec_type === "audio");
  check(v.length === 1, `${file}: ${v.length} video streams`);
  const vs = v[0];
  const fr = vs.r_frame_rate.split("/").map(Number);
  const out = {
    codec: vs.codec_name,
    profile: vs.profile,
    pixFmt: vs.pix_fmt,
    width: vs.width,
    height: vs.height,
    frameRate: vs.r_frame_rate,
    colorTransfer: vs.color_transfer ?? null,
    colorPrimaries: vs.color_primaries ?? null,
    audioTracks: a.length,
    audio: a.map((s) => ({ codec: s.codec_name, channels: s.channels, duration: Number(s.duration) })),
    videoDuration: Number(vs.duration),
    bytes: Number(info.format.size),
  };
  check(out.codec === format.codec, `The export's codec is ${out.codec}, expected ${format.codec}`, out);
  check(out.width === format.width && out.height === format.height, `The export is ${out.width}x${out.height}`, out);
  check(Math.abs(fr[0] / fr[1] - fps) < 1e-6, `The export's frame rate is ${vs.r_frame_rate}, expected ${fps}`, out);
  const tenBit = /10/.test(out.pixFmt);
  check(tenBit === (format.bitDepth === 10), `The export's pixel format is ${out.pixFmt}, expected ${format.bitDepth}-bit`, out);
  if (format.hdr) check(out.colorTransfer === "smpte2084" && out.colorPrimaries === "bt2020", "The export lost its HDR signalling", out);
  else check(out.colorTransfer !== "smpte2084", "An SDR source exported as HDR", out);
  check(out.audioTracks === format.audioTracks, `The export has ${out.audioTracks} audio tracks, expected ${format.audioTracks}`, out);

  // Every frame, by its burned-in number.
  const want = frames ?? expectedFrames(segments);
  const got = readFile(reader, file);
  out.frames = got.length;
  out.expectedFrames = want.length;
  const wrong = [];
  for (let i = 0; i < Math.max(got.length, want.length); i++) if (got[i] !== want[i]) wrong.push({ i, got: got[i] ?? "none", want: want[i] ?? "none" });
  // Both sides of every cut, for the record.
  const cuts = [];
  let i = 0;
  for (const [s, e] of frames ? [] : segments) {
    cuts.push({ at: i, first: got[i], wantFirst: s, last: got[i + (e - s) - 1], wantLast: e - 1 });
    i += e - s;
  }
  out.cuts = cuts;
  if (wrong.length) fail(`${file}: ${wrong.length} frames are not the ones the edit keeps (${got.length} frames, expected ${want.length})`, { first: wrong.slice(0, 12), cuts });

  // Sound against picture: every frame whose number is a multiple of `beepEvery` starts a beep
  // in every track, within a frame; no other beep onsets.
  const frameS = 1 / fps;
  const wantOnsets = onsets === false ? [] : onsets ?? got.map((n, k) => (n % beepEvery === 0 ? k * frameS : null)).filter((x) => x !== null);
  out.tracks = [];
  for (let t = 0; t < a.length; t++) {
    const samples = decodeTrack(file, t);
    const audioS = samples.length / 48000;
    const beeps = findBeepsInSamples(samples, 48000);
    const found = beeps.map((b) => b.onset);
    const errs = wantOnsets.map((w) => {
      const near = found.reduce((best, o) => (Math.abs(o - w) < Math.abs(best - w) ? o : best), Infinity);
      return near - w;
    });
    const extra = found.filter((o) => !wantOnsets.some((w) => Math.abs(o - w) <= frameS));
    const worst = Math.max(...errs.map(Math.abs));
    const last = errs[errs.length - 1];
    const tr = {
      track: t,
      beeps: found.length,
      expected: wantOnsets.length,
      worstMs: Math.round(worst * 1e4) / 10,
      lastBeepMs: Math.round(last * 1e4) / 10,
      freqHz: beeps.length ? Math.round(beeps[beeps.length - 1].freqHz) : null,
      audioSeconds: audioS,
    };
    out.tracks.push(tr);
    if (onsets !== false) check(worst <= frameS, `Audio track ${t}: a beep is ${tr.worstMs} ms from its frame (more than a frame)`, { tr, errs: errs.map((e) => Math.round(e * 1e4) / 10) });
    if (onsets !== false) check(extra.length === 0, `Audio track ${t}: beeps where no beep frame is`, { extra, wantOnsets });
    check(Math.abs(audioS - got.length * frameS) <= frameS, `Audio track ${t} lasts ${audioS.toFixed(3)} s, the picture ${(got.length * frameS).toFixed(3)} s`, tr);
  }
  return out;
}

/**
 * The source frames the export's frame-rate rule puts in output slots k .. k+n-1 at `rate` fps
 * (rc-media, spikes/export/RESULT.md): the last source frame whose time, rounded to the nearest
 * slot, is at most the slot. `times`: every source frame's time in seconds, ascending.
 */
export function fpsRuleFrames(times, rate, k, n) {
  // The manifest gives times to 6 decimals (frames are on a 1/60 s grid): a half slot (x.5)
  // rounds up, as the exact integer arithmetic does, so allow for the 6-decimal rounding.
  const slots = times.map((t) => Math.floor(t * rate + 0.5 + 1e-4));
  const out = [];
  for (let p = k; p < k + n; p++) {
    let j = 0;
    for (let i = 0; i < slots.length && slots[i] <= p; i++) j = i;
    out.push(j);
  }
  return out;
}

/**
 * Where beeps start in the output: `clips` are [sourceStartSec, lengthSec] in output order; the
 * source beeps at every whole second.
 */
export function beepOnsetsFor(clips) {
  const out = [];
  let at = 0;
  for (const [s, len] of clips) {
    for (let w = Math.ceil(s - 1e-6); w < s + len - 1e-6; w++) out.push(at + (w - s));
    at += len;
  }
  return out;
}
