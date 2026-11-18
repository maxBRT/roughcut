/**
 * Time labels for the Transcript view. Plain functions so the rows and the tests share them.
 */
import type { Micros } from "../../types";
import { formatTimeLeft } from "../editor/format";

/** "0:09", "12:40", "1:04:30": whole seconds, floored (the paragraph times of the mockup). */
export function formatClock(t: Micros): string {
  const total = Math.max(0, Math.floor(t / 1_000_000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A length in seconds with one decimal: "3.1s". */
export function formatLength(t: Micros): string {
  return `${(Math.max(0, t) / 1_000_000).toFixed(1)}s`;
}

/**
 * The time left while transcribing, worded exactly as the player panel's note says it
 * ("about 3 min left", "under a minute left"), so the two never disagree on screen.
 */
export function formatSecondsLeft(seconds: number): string {
  return formatTimeLeft(seconds) ?? "";
}
