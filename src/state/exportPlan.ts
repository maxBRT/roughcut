/**
 * Reading an `ExportPlan` beyond its required fields. The core may send `requiredBytes`: the
 * disk space the export needs (the file plus its temporary pieces). It is optional: an older
 * core leaves it out, and then the view shows only the core's message.
 */
import type { ExportPlan } from "../types";

/** An `ExportPlan` that may carry the optional `requiredBytes`. */
export type ExportPlanWithNeeds = ExportPlan & { requiredBytes?: number };

/** The disk space the export needs, in bytes, or null when the plan does not say. */
export function requiredBytesOf(plan: ExportPlan | null | undefined): number | null {
  const n = (plan as ExportPlanWithNeeds | null | undefined)?.requiredBytes;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}
