/**
 * Text of a Home row (spec 1.7 A, mockups/screens/home.png): "41:12 kept of 1:04:30",
 * "edited 2 h ago", "exported nov 6". Pure functions, so they are tested without a screen.
 */
import type { Micros, ProjectSummary } from "../../types";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

/** An export saved up to this long before the last save still counts as the latest thing done. */
const EXPORT_GRACE_MS = 5 * 60_000;

/** A length as the mockup writes it: "0:07", "41:12", "1:04:30" (whole seconds, rounded down). */
export function formatDuration(micros: Micros): string {
  const total = Math.max(0, Math.floor(micros / 1_000_000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * When something happened, relative to `now`: "just now", "5 min ago", "2 h ago",
 * "yesterday", then the day ("nov 6", with the year when it is not this year's).
 * An unreadable timestamp gives null.
 */
export function formatWhen(iso: string, now: Date): string | null {
  const at = new Date(iso);
  const t = at.getTime();
  if (Number.isNaN(t)) return null;
  const ago = now.getTime() - t;
  if (ago < 60_000) return "just now";
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)} min ago`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  // Hours for today, and for late last night when it was less than 12 hours ago.
  if (t >= startOfToday || (t >= startOfYesterday && ago < 12 * 3_600_000)) {
    return `${Math.floor(ago / 3_600_000)} h ago`;
  }
  if (t >= startOfYesterday) return "yesterday";
  const day = `${MONTHS[at.getMonth()]} ${at.getDate()}`;
  return at.getFullYear() === now.getFullYear() ? day : `${day} ${at.getFullYear()}`;
}

/**
 * The right-hand text of a row: "exported …" when the last export is the latest thing that
 * happened to the project (saved within a few minutes after it count as the same moment),
 * otherwise "edited …".
 */
export function rowStat(p: ProjectSummary, now: Date): string {
  const updated = new Date(p.updatedAt).getTime();
  if (p.lastExportedAt !== undefined) {
    const exported = new Date(p.lastExportedAt).getTime();
    if (!Number.isNaN(exported) && (Number.isNaN(updated) || updated - exported <= EXPORT_GRACE_MS)) {
      const when = formatWhen(p.lastExportedAt, now);
      if (when !== null) return `exported ${when}`;
    }
  }
  const when = formatWhen(p.updatedAt, now);
  return when === null ? "edited" : `edited ${when}`;
}

/** The kept and raw lengths: "41:12 kept of 1:04:30". */
export function rowLengths(p: ProjectSummary): string {
  return `${formatDuration(p.keptDuration)} kept of ${formatDuration(p.rawDuration)}`;
}

/** The missing-source note, or null when every file is where it was: "1 file missing". */
export function missingNote(p: ProjectSummary): string | null {
  if (p.missingSources <= 0) return null;
  return p.missingSources === 1 ? "1 file missing" : `${p.missingSources} files missing`;
}
