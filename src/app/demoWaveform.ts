/**
 * A plausible loudness curve for the stand-in's demo recording: each spoken word is a burst
 * (louder in its middle), pauses and gaps are near silence. Deterministic.
 */
import { demoDuration, demoTranscript } from "../state/core";

/** One u8 peak per 1 / `valuesPerSecond` seconds of the demo recording. */
export function createDemoWaveformValues(valuesPerSecond: number): Uint8Array {
  const seconds = demoDuration() / 1_000_000;
  const values = new Uint8Array(Math.ceil(seconds * valuesPerSecond));
  // A little room noise everywhere.
  let seed = 7;
  const rand = () => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < values.length; i++) values[i] = 3 + Math.floor(rand() * 5);
  for (const u of demoTranscript("demo").utterances) {
    for (const t of u.tokens) {
      if (t.kind === "pause") continue;
      const from = Math.floor((t.start / 1_000_000) * valuesPerSecond);
      const to = Math.min(values.length, Math.ceil((t.end / 1_000_000) * valuesPerSecond));
      const peak = t.kind === "unrecognised" ? 90 : 140 + rand() * 100;
      for (let i = from; i < to; i++) {
        const x = (i - from + 0.5) / Math.max(1, to - from); // 0..1 across the word
        const envelope = Math.sin(Math.PI * x) ** 0.6;
        values[i] = Math.max(values[i]!, Math.min(255, Math.round(peak * envelope * (0.75 + 0.25 * rand()))));
      }
    }
  }
  return values;
}
