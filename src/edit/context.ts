/**
 * What every edit command needs to know besides the clip list: the sequence frame rate and
 * each source's duration, in project order (spec 3.5.1).
 */
import type { Micros, Rational, SourceId, SourceRef } from "../types";
import { firstClipEnd } from "../types";

/** One source as the edit module sees it. */
export interface EditSource {
  id: SourceId;
  /** The probed duration of the file, in microseconds. */
  duration: Micros;
}

/** The context passed to every command. `sources` is in project order. */
export interface EditContext {
  frameRate: Rational;
  sources: readonly EditSource[];
}

/** Builds an `EditContext` from a project (its frame rate and its sources). */
export function contextFromProject(project: { frameRate: Rational; sources: readonly SourceRef[] }): EditContext {
  return {
    frameRate: project.frameRate,
    sources: project.sources.map((s) => ({ id: s.id, duration: s.media.duration })),
  };
}

/** Internal: the context with fast lookups. */
export interface Resolved {
  rate: Rational;
  /** Source end on the grid (the duration floored), by source id. */
  ends: Map<SourceId, Micros>;
  /** Position of each source in project order. */
  order: Map<SourceId, number>;
}

/** Internal: resolves a context once per command. */
export function resolve(ctx: EditContext): Resolved {
  const ends = new Map<SourceId, Micros>();
  const order = new Map<SourceId, number>();
  ctx.sources.forEach((s, i) => {
    ends.set(s.id, firstClipEnd(s.duration, ctx.frameRate) ?? 0);
    if (!order.has(s.id)) order.set(s.id, i);
  });
  return { rate: ctx.frameRate, ends, order };
}
