// FFmpeg helpers for the scenarios: probing files the app wrote, and making a test clip.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, fail } from "./app.mjs";

/** ffprobe's JSON for a file (format and streams). */
export function ffprobe(file) {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(out);
  } catch (e) {
    fail(`ffprobe could not read ${file}: ${e.stderr ?? e}`);
  }
}

/** Number of video frames (decoded count). */
export function countFrames(file) {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  );
  return Number(out.trim());
}

export function manifest() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, "manifest.json"), "utf8"));
}

export function fixture(name) {
  const f = path.join(FIXTURES, `${name}.mp4`);
  if (!fs.existsSync(f)) fail(`Fixture ${f} is missing (npm run fixtures)`);
  return f;
}

/**
 * A 1920x1080, 30 fps clip with a continuous 440 Hz tone (amplitude 0.375, RMS about 0.27) on both channels (so any gap in
 * the sound at a cut shows as a dip), `seconds` long, H.264 + AAC in MP4.
 */
export function makeToneClip(file, seconds = 40) {
  execFileSync(
    "ffmpeg",
    [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", `testsrc2=size=1920x1080:rate=30:duration=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      "-filter_complex", "[1:a]volume=3,aformat=channel_layouts=stereo[a]",
      "-map", "0:v", "-map", "[a]",
      "-c:v", "h264_nvenc", "-preset", "p4", "-g", "60", "-bf", "0", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
      file,
    ],
    { stdio: "inherit" },
  );
  return file;
}

/** Files under a folder, recursively, with sizes and modification times. */
export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        out.push({ path: p, rel: path.relative(dir, p), size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}
