/**
 * The frame grid (spec 2.4.2, 3.4 rule 1): the TypeScript twin of `rc_types::grid`.
 * Hand-written, not generated; both sides are checked against the same vectors in
 * `src-tauri/crates/rc-types/testdata/contract_vectors.json` (see `contract.test.ts`).
 *
 * Frame `k` of a rate `num/den` starts at `k * 1e6 * den / num` microseconds rounded to the
 * nearest whole microsecond, halves up:
 *
 *     frameToMicros(k) = floor((k * 1_000_000 * den + floor(num / 2)) / num)
 *
 * Everything else is defined by those grid points. All arithmetic is exact (BigInt), so
 * the results are the core's to the microsecond. Every snap of a time to the grid in the
 * interface (`edit`, `transcript`, `player`) goes through these functions.
 */
import type { Micros, Rational } from "./generated";

const M = 1_000_000n;

function floorDiv(a: bigint, b: bigint): bigint {
  // b > 0 here.
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

function int(name: string, v: number): bigint {
  if (!Number.isSafeInteger(v)) throw new RangeError(`${name} must be a safe integer, got ${v}`);
  return BigInt(v);
}

function rateParts(rate: Rational): [bigint, bigint] {
  const num = int("rate.num", rate.num);
  const den = int("rate.den", rate.den);
  if (num <= 0n || den <= 0n) throw new RangeError(`frame rate must be positive, got ${rate.num}/${rate.den}`);
  return [num, den];
}

/** Where frame `frame` starts, in whole microseconds (rounded half up). */
export function frameToMicros(frame: number, rate: Rational): Micros {
  const [num, den] = rateParts(rate);
  return Number(floorDiv(int("frame", frame) * M * den + num / 2n, num));
}

/** The last frame whose grid point is at or before `t`. */
export function microsToFrameFloor(t: Micros, rate: Rational): number {
  const [num, den] = rateParts(rate);
  return Number(floorDiv((int("t", t) + 1n) * num - 1n - num / 2n, M * den));
}

/** The grid point at or before `t`. */
export function floorToFrame(t: Micros, rate: Rational): Micros {
  return frameToMicros(microsToFrameFloor(t, rate), rate);
}

/** The grid point at or after `t`. */
export function ceilToFrame(t: Micros, rate: Rational): Micros {
  const k = microsToFrameFloor(t, rate);
  const at = frameToMicros(k, rate);
  return at === t ? at : frameToMicros(k + 1, rate);
}

/** The grid point nearest `t`; when `t` is exactly halfway, the later one. */
export function snapToFrame(t: Micros, rate: Rational): Micros {
  const k = microsToFrameFloor(t, rate);
  const before = frameToMicros(k, rate);
  const after = frameToMicros(k + 1, rate);
  return t - before < after - t ? before : after;
}

/** Whether `t` sits exactly on the grid. */
export function isOnFrameGrid(t: Micros, rate: Rational): boolean {
  return floorToFrame(t, rate) === t;
}

/**
 * The end of the one clip `create_project` makes for a source: its duration floored to the
 * sequence grid. `null` when the source is shorter than one frame (it gets no clip).
 */
export function firstClipEnd(duration: Micros, sequenceRate: Rational): Micros | null {
  const end = floorToFrame(duration, sequenceRate);
  return end > 0 ? end : null;
}
