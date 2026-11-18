/**
 * Text for the Export dialog's figures: lengths, file sizes and times, written the way the
 * mockup writes them ("41:12", "about 18 gb", "1:10 left", "took 2:54").
 */
import type { Micros, OutputFormat } from "../../types";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** A clock reading of whole seconds: "0:07", "41:12", "1:02:03". Negative or unknown counts as 0. */
export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A sequence length in microseconds as a clock reading ("41:12"), rounded down to the second. */
export function formatLength(duration: Micros): string {
  return formatClock(duration / 1_000_000);
}

/**
 * A file size in the units Windows shows (1 gb = 1024³ bytes), lower case as in the mockup.
 * `approx` rounds an estimate to whole units ("18 gb"); otherwise one decimal below 100
 * ("17.6 gb"). Nothing (0, negative or unknown) is "0 kb"; only a positive amount too small to
 * show is raised to the smallest figure ("0.1 kb", or "1 kb" approximately).
 */
export function formatBytes(bytes: number, approx = false): string {
  const b = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (b === 0) return "0 kb";
  const [value, unit] = b >= GB ? [b / GB, "gb"] : b >= MB ? [b / MB, "mb"] : [b / 1024, "kb"];
  if (approx || value >= 100) return `${Math.max(1, Math.round(value))} ${unit}`;
  const one = Math.round(value * 10) / 10;
  return `${one < 0.1 ? 0.1 : one} ${unit}`;
}

/** An estimated duration in words: "under a minute", "about 3 min", "about 1 h 10 min". */
export function formatEstimate(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `about ${h} h` : `about ${h} h ${m} min`;
}

/** Time left while running: "1:10 left", or a holding text while the core has no estimate. */
export function formatTimeLeft(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "working out time left";
  return `${formatClock(Math.ceil(seconds))} left`;
}

/** The output format in one line: "3840×2160 · 30 fps · h264 8-bit · 1 audio track". */
export function describeFormat(format: OutputFormat): string {
  const fps = format.frameRate.den > 0 ? format.frameRate.num / format.frameRate.den : 0;
  const fpsText = Number.isInteger(fps) ? String(fps) : fps.toFixed(2);
  const video = `${format.codec} ${format.bitDepth}-bit${format.hdr ? " hdr" : ""}`;
  const tracks = `${format.audioTracks} audio track${format.audioTracks === 1 ? "" : "s"}`;
  return `${format.width}×${format.height} · ${fpsText} fps · ${video} · ${tracks}`;
}

/**
 * A path shortened to at most `maxChars` characters by leaving out folders in the middle, so
 * the end (the folder's own name, or the file name) stays readable:
 * "C:\Users\me\…\exports\weekly-update.mp4". Found with real paths (e2e "edge-sources"):
 * cutting at the end showed "C:\Users\alice\.t3\scratch\2026-11-13-i-need-a-…" and hid the
 * folder and the file. When even the last part does not fit, its end is kept.
 */
export function fitPath(path: string, maxChars: number): string {
  if (path.length <= maxChars) return path;
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(sep);
  const last = parts[parts.length - 1] ?? "";
  const max = Math.max(1, Math.floor(maxChars));
  if (parts.length < 2 || last.length + 2 > max) return `…${path.slice(path.length - (max - 1))}`;
  let tail = last;
  for (let i = parts.length - 2; i >= 1; i--) {
    const next = `${parts[i]}${sep}${tail}`;
    if (`${parts[0]}${sep}…${sep}${next}`.length > max) break;
    tail = next;
  }
  const head = `${parts[0]}${sep}…${sep}${tail}`;
  return head.length <= max ? head : `…${sep}${tail}`;
}
