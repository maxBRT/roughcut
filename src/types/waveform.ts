/**
 * The waveform file (spec 3.4 `WaveformHeader`, 3.5.6): the TypeScript twin of
 * `rc_types::waveform`. Hand-written, not generated; checked against the shared fixture in
 * `contract.test.ts`.
 *
 * Layout: `WaveformHeader` as compact UTF-8 JSON ending in one line feed (0x0A), then exactly
 * `count` bytes, each a u8 peak loudness on a linear scale (0 = silence, 255 = full scale);
 * value `i` covers `[i / valuesPerSecond, (i + 1) / valuesPerSecond)` seconds of the source.
 * Served as `application/octet-stream`.
 */
import type { WaveformHeader } from "./generated";

export const WAVEFORM_CONTENT_TYPE = "application/octet-stream";

export interface Waveform {
  header: WaveformHeader;
  /** One u8 peak loudness per slice, `header.count` of them. */
  values: Uint8Array;
}

function isHeader(v: unknown): v is WaveformHeader {
  if (typeof v !== "object" || v === null) return false;
  const h = v as Record<string, unknown>;
  return (
    typeof h.sourceId === "string" &&
    Number.isSafeInteger(h.valuesPerSecond) &&
    (h.valuesPerSecond as number) > 0 &&
    Number.isSafeInteger(h.count) &&
    (h.count as number) >= 0
  );
}

/** Reads a waveform file, e.g. `parseWaveform(await (await fetch(assets.waveformUrl)).arrayBuffer())`. Throws if the bytes do not follow the layout. */
export function parseWaveform(buf: ArrayBuffer | Uint8Array): Waveform {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const nl = bytes.indexOf(0x0a);
  if (nl < 0) throw new Error("waveform file has no header line");
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, nl)));
  } catch (e) {
    throw new Error(`waveform header is not valid: ${String(e)}`);
  }
  if (!isHeader(header)) throw new Error("waveform header is not valid: missing or wrong fields");
  const values = bytes.slice(nl + 1);
  if (values.length !== header.count) {
    throw new Error(`waveform header says ${header.count} values but ${values.length} were found`);
  }
  return { header: { sourceId: header.sourceId, valuesPerSecond: header.valuesPerSecond, count: header.count }, values };
}

/** The bytes of a waveform file (for the stand-in core and tests). `header.count` must equal `values.length`. */
export function encodeWaveform(header: WaveformHeader, values: Uint8Array): Uint8Array {
  if (header.count !== values.length) {
    throw new Error(`waveform header says ${header.count} values but ${values.length} were given`);
  }
  const json = new TextEncoder().encode(
    JSON.stringify({ sourceId: header.sourceId, valuesPerSecond: header.valuesPerSecond, count: header.count }),
  );
  const out = new Uint8Array(json.length + 1 + values.length);
  out.set(json, 0);
  out[json.length] = 0x0a;
  out.set(values, json.length + 1);
  return out;
}
