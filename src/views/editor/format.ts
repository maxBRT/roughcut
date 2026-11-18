/**
 * Time formats the editor frame shows: lengths ("41:12", "1:04:30"), the playhead read-out
 * ("0:28.2") and time left ("about 3 min left").
 */
import type { Micros } from "../../types";

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** A length in whole seconds: "0:09", "41:12", "1:04:30". Negative values show as 0:00. */
export function formatDuration(us: Micros): string {
  const total = Math.max(0, Math.floor(us / 1_000_000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/**
 * Sequence times drift from the frame grid by up to 1 µs per cut (each clip's length is a
 * difference of two grid times), so a frame that starts on a tenth can sit just under it
 * (79 999 999 µs for 1:20.0 after one cut). Rounding down ignores anything this close.
 */
export const GRID_DRIFT_US = 500;

/** A playhead time to the tenth of a second, rounded down: "0:28.2", "1:02:03.4". */
export function formatTimecode(us: Micros): string {
  const tenths = Math.max(0, Math.floor((us + GRID_DRIFT_US) / 100_000));
  return `${formatDuration(Math.floor(tenths / 10) * 1_000_000)}.${tenths % 10}`;
}

/** Seconds as a short length for the selection note: "3.2 s", "1:04". */
export function formatSeconds(us: Micros): string {
  const s = Math.max(0, us) / 1_000_000;
  return s < 60 ? `${(Math.floor(s * 10) / 10).toFixed(1)} s` : formatDuration(us);
}

/** Time left for a background task: "about 3 min left", "under a minute left"; null when unknown. */
export function formatTimeLeft(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 50) return "under a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `about ${Math.max(1, minutes)} min left`;
  return `about ${Math.round(minutes / 60)} h left`;
}
