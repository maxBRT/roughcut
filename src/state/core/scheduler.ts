/**
 * Timers for the stand-in core, so tests can drive its jobs deterministically.
 *
 * - `realScheduler` uses the global `setTimeout` at call time, so Vitest fake timers
 *   (`vi.useFakeTimers()` / `vi.advanceTimersByTime`) control it too.
 * - `ManualScheduler` runs nothing until told to: `advance(ms)` or `runAll()`.
 */
export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

export class ManualScheduler implements Scheduler {
  private now = 0;
  private nextId = 1;
  private timers: Timer[] = [];

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.push({ id, at: this.now + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  /** Milliseconds advanced so far. */
  get time(): number {
    return this.now;
  }

  /** Timers still waiting. */
  get pending(): number {
    return this.timers.length;
  }

  /** Runs, in time order, every timer due within the next `ms` milliseconds. */
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const next = this.popDue(until);
      if (!next) break;
      this.now = next.at;
      next.fn();
    }
    this.now = until;
  }

  /** Runs timers until none are left (including ones scheduled meanwhile). Throws after `limit` timers. */
  runAll(limit = 100_000): void {
    let n = 0;
    for (;;) {
      const next = this.popDue(Number.POSITIVE_INFINITY);
      if (!next) return;
      if (++n > limit) throw new Error("ManualScheduler.runAll: too many timers");
      this.now = Math.max(this.now, next.at);
      next.fn();
    }
  }

  private popDue(until: number): Timer | undefined {
    let best: Timer | undefined;
    for (const t of this.timers) {
      if (t.at <= until && (!best || t.at < best.at || (t.at === best.at && t.id < best.id))) best = t;
    }
    if (best) this.timers = this.timers.filter((t) => t !== best);
    return best;
  }
}
