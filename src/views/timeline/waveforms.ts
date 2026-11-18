/**
 * Waveforms for the track: fetched once per address from the source's `waveformUrl` (as given,
 * no headers), decoded with `parseWaveform`, and turned into a pyramid of peaks so the loudest
 * value under any bar is found in O(log n), whatever the zoom (spec 2.4.11: drawn from
 * precomputed waveform data).
 */
import { useEffect, useMemo, useState } from "react";
import type { Micros, SourceId } from "../../types";
import { parseWaveform, type Waveform } from "../../types";

/** A decoded waveform with its peak pyramid: `levels[k][i]` is the max of values `[i*2^k, (i+1)*2^k)`. */
export interface WavePeaks {
  sourceId: SourceId;
  valuesPerSecond: number;
  count: number;
  levels: readonly Uint8Array[];
}

/** Builds the pyramid (about twice the size of the values). */
export function buildPeaks(w: Waveform): WavePeaks {
  const levels: Uint8Array[] = [w.values];
  let cur = w.values;
  while (cur.length > 1) {
    const next = new Uint8Array(Math.ceil(cur.length / 2));
    for (let i = 0; i < next.length; i++) {
      const a = cur[2 * i]!;
      const b = 2 * i + 1 < cur.length ? cur[2 * i + 1]! : 0;
      next[i] = a > b ? a : b;
    }
    levels.push(next);
    cur = next;
  }
  return { sourceId: w.header.sourceId, valuesPerSecond: w.header.valuesPerSecond, count: w.header.count, levels };
}

/** The loudest value (0..255) in source time `[from, to)`; at least the one value under `from`. 0 outside the file. */
export function peakBetween(p: WavePeaks, from: Micros, to: Micros): number {
  if (p.count === 0) return 0;
  let a = Math.floor((from * p.valuesPerSecond) / 1_000_000);
  let b = Math.ceil((to * p.valuesPerSecond) / 1_000_000);
  if (b <= a) b = a + 1;
  a = Math.max(0, a);
  b = Math.min(p.count, b);
  let best = 0;
  let level = 0;
  while (a < b) {
    const lv = p.levels[level]!;
    if (a & 1) {
      const v = lv[a++]!;
      if (v > best) best = v;
    }
    if (b & 1) {
      const v = lv[--b]!;
      if (v > best) best = v;
    }
    a >>= 1;
    b >>= 1;
    level++;
  }
  return best;
}

/** Gets the bytes at a waveform address. */
export type WaveformFetcher = (url: string) => Promise<ArrayBuffer | Uint8Array>;

/** `fetch` with no headers; a non-2xx answer is an error. */
export const fetchWaveformBytes: WaveformFetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`waveform ${res.status}`);
  return res.arrayBuffer();
};

/** One cache per fetcher, keyed by address (the address carries the per-launch token). */
const caches = new WeakMap<WaveformFetcher, Map<string, Promise<WavePeaks | null>>>();

/** Loads and decodes one waveform; null when it cannot be had (the clip is then drawn without it). */
export function loadPeaks(url: string, fetcher: WaveformFetcher = fetchWaveformBytes): Promise<WavePeaks | null> {
  let cache = caches.get(fetcher);
  if (!cache) caches.set(fetcher, (cache = new Map()));
  const hit = cache.get(url);
  if (hit) return hit;
  const p = (async () => {
    try {
      return buildPeaks(parseWaveform(await fetcher(url)));
    } catch {
      // Forget the failure so a later mount (or a new address) tries again.
      cache.delete(url);
      return null;
    }
  })();
  cache.set(url, p);
  return p;
}

/** The waveforms that have arrived, per source id, for the given addresses (null = not ready). */
export function useWaveformPeaks(
  urls: Readonly<Record<SourceId, string | null>>,
  fetcher: WaveformFetcher = fetchWaveformBytes,
): ReadonlyMap<SourceId, WavePeaks> {
  const [loaded, setLoaded] = useState<ReadonlyMap<SourceId, { url: string; peaks: WavePeaks }>>(() => new Map());

  useEffect(() => {
    let live = true;
    for (const [id, url] of Object.entries(urls)) {
      if (!url) continue;
      void loadPeaks(url, fetcher).then((peaks) => {
        if (!live || !peaks) return;
        setLoaded((prev) => {
          if (prev.get(id)?.url === url) return prev;
          const next = new Map(prev);
          next.set(id, { url, peaks });
          return next;
        });
      });
    }
    return () => {
      live = false;
    };
  }, [urls, fetcher]);

  return useMemo(() => {
    // Only waveforms whose address is still the current one for the source.
    const peaks = new Map<SourceId, WavePeaks>();
    for (const [id, entry] of loaded) if (urls[id] === entry.url) peaks.set(id, entry.peaks);
    return peaks;
  }, [loaded, urls]);
}
