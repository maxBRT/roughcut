import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { encodeWaveform, parseWaveform } from "../../types";
import { buildPeaks, loadPeaks, peakBetween } from "./waveforms";

const S = 1_000_000;

function waveform(values: number[], valuesPerSecond = 100, sourceId = "src") {
  return parseWaveform(encodeWaveform({ sourceId, valuesPerSecond, count: values.length }, Uint8Array.from(values)));
}

describe("peak pyramid", () => {
  it("finds the loudest value under a span", () => {
    const p = buildPeaks(waveform([1, 9, 3, 200, 4, 5, 6, 7, 0, 250], 10)); // one value per 0.1 s
    expect(peakBetween(p, 0, 0.2 * S)).toBe(9);
    expect(peakBetween(p, 0.2 * S, 0.3 * S)).toBe(3);
    expect(peakBetween(p, 0, 1 * S)).toBe(250);
    expect(peakBetween(p, 0.4 * S, 0.9 * S)).toBe(7);
    // A span thinner than one value still reads the value under it.
    expect(peakBetween(p, 0.31 * S, 0.31 * S)).toBe(200);
    // Outside the file: silence.
    expect(peakBetween(p, 5 * S, 6 * S)).toBe(0);
  });

  it("agrees with a linear scan on random data", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 700 }),
        fc.integer({ min: 0, max: 800 }),
        fc.integer({ min: 0, max: 800 }),
        (values, i, j) => {
          const p = buildPeaks(waveform(values, 100));
          const a = Math.min(i, j);
          const b = Math.max(i, j);
          // Span [a, b) in values = [a/100, b/100) seconds.
          const from = a * 10_000;
          const to = b * 10_000;
          const lo = Math.max(0, a);
          const hi = Math.min(values.length, Math.max(b, a + 1));
          let expected = 0;
          for (let k = lo; k < hi; k++) expected = Math.max(expected, values[k]!);
          expect(peakBetween(p, from, to)).toBe(expected);
        },
      ),
    );
  });
});

describe("loading", () => {
  it("fetches each address once and decodes it", async () => {
    const bytes = encodeWaveform({ sourceId: "s1", valuesPerSecond: 50, count: 3 }, Uint8Array.from([1, 2, 3]));
    const fetcher = vi.fn(async () => bytes);
    const [a, b] = await Promise.all([loadPeaks("http://x/media/s1/waveform?token=t", fetcher), loadPeaks("http://x/media/s1/waveform?token=t", fetcher)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("http://x/media/s1/waveform?token=t");
    expect(a).toBe(b);
    expect(a?.count).toBe(3);
    expect(a?.valuesPerSecond).toBe(50);
  });

  it("gives null for a failed fetch or a bad file, and tries again later", async () => {
    let n = 0;
    const fetcher = vi.fn(async () => {
      n++;
      if (n === 1) throw new Error("404");
      if (n === 2) return new TextEncoder().encode("not a waveform");
      return encodeWaveform({ sourceId: "s", valuesPerSecond: 1, count: 1 }, Uint8Array.from([9]));
    });
    expect(await loadPeaks("u", fetcher)).toBeNull();
    expect(await loadPeaks("u", fetcher)).toBeNull();
    expect((await loadPeaks("u", fetcher))?.count).toBe(1);
  });
});
