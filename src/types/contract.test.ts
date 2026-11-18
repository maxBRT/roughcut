/**
 * The shared contract vectors (also checked by `cargo test -p rc-types`, tests/contract_vectors.rs),
 * plus compile-time checks that the token types match spec 3.4.
 */
import { describe, expect, it } from "vitest";
import {
  ceilToFrame,
  encodeWaveform,
  firstClipEnd,
  floorToFrame,
  frameToMicros,
  isOnFrameGrid,
  mediaUrl,
  MEDIA_TOKEN_PARAM,
  microsToFrameFloor,
  parseWaveform,
  snapToFrame,
  type MediaItem,
  type PauseToken,
  type Rational,
  type Token,
  type UnrecognisedToken,
  type WaveformHeader,
  type WordToken,
} from "./index";
import vectorsJson from "../../src-tauri/crates/rc-types/testdata/contract_vectors.json";

interface Vectors {
  frameGrid: {
    frameToMicros: { rate: Rational; frame: number; micros: number }[];
    times: { rate: Rational; t: number; frameFloor: number; floor: number; ceil: number; snap: number; onGrid: boolean }[];
  };
  firstClipEnd: { duration: number; rate: Rational; end: number | null }[];
  mediaUrl: { base: string; token: string; sourceId: string; item: MediaItem; url: string }[];
  waveform: { header: WaveformHeader; values: number[]; hex: string; bad: { why: string; hex: string }[] };
}

const vectors = vectorsJson as unknown as Vectors;

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));

describe("frame grid (shared vectors)", () => {
  it("frameToMicros", () => {
    for (const c of vectors.frameGrid.frameToMicros) expect(frameToMicros(c.frame, c.rate), JSON.stringify(c)).toBe(c.micros);
  });
  it("floor, ceil, snap, on grid", () => {
    expect(vectors.frameGrid.times.length).toBeGreaterThan(50);
    for (const c of vectors.frameGrid.times) {
      const at = JSON.stringify(c);
      expect(microsToFrameFloor(c.t, c.rate), at).toBe(c.frameFloor);
      expect(floorToFrame(c.t, c.rate), at).toBe(c.floor);
      expect(ceilToFrame(c.t, c.rate), at).toBe(c.ceil);
      expect(snapToFrame(c.t, c.rate), at).toBe(c.snap);
      expect(isOnFrameGrid(c.t, c.rate), at).toBe(c.onGrid);
    }
  });
  it("first clip end", () => {
    for (const c of vectors.firstClipEnd) expect(firstClipEnd(c.duration, c.rate), JSON.stringify(c)).toBe(c.end);
  });
  it("rejects non-integers and bad rates", () => {
    expect(() => frameToMicros(1.5, { num: 30, den: 1 })).toThrow(RangeError);
    expect(() => snapToFrame(10, { num: 0, den: 1 })).toThrow(RangeError);
  });
});

describe("media addresses (shared vectors)", () => {
  it("mediaUrl", () => {
    expect(MEDIA_TOKEN_PARAM).toBe("token");
    for (const c of vectors.mediaUrl) expect(mediaUrl(c.base, c.token, c.sourceId, c.item)).toBe(c.url);
  });
});

describe("waveform file (shared fixture)", () => {
  const w = vectors.waveform;
  it("encodes to the fixture bytes and parses back", () => {
    const bytes = encodeWaveform(w.header, Uint8Array.from(w.values));
    expect(Array.from(bytes)).toEqual(Array.from(fromHex(w.hex)));
    const parsed = parseWaveform(fromHex(w.hex).buffer);
    expect(parsed.header).toEqual(w.header);
    expect(Array.from(parsed.values)).toEqual(w.values);
  });
  it("refuses malformed files", () => {
    for (const bad of w.bad) expect(() => parseWaveform(fromHex(bad.hex)), bad.why).toThrow();
    expect(() => encodeWaveform({ ...w.header, count: 4 }, Uint8Array.from(w.values))).toThrow();
  });
});

describe("token types match spec 3.4", () => {
  it("each named token type carries its kind", () => {
    const word: WordToken = { kind: "word", start: 0, end: 10, cutBefore: 0, text: "Hi" };
    const pause: PauseToken = { kind: "pause", start: 10, end: 20, cutBefore: 10 };
    const unrec: UnrecognisedToken = { kind: "unrecognised", start: 20, end: 30, cutBefore: 20 };
    const kindOf = (t: WordToken): "word" => t.kind;
    const tokens: Token[] = [word, pause, unrec];
    expect(kindOf(word)).toBe("word");
    expect(tokens.map((t) => (t.kind === "word" ? t.text : t.kind))).toEqual(["Hi", "pause", "unrecognised"]);
    // @ts-expect-error a PauseToken has no text
    const wrong: PauseToken = { kind: "pause", start: 0, end: 1, cutBefore: 0, text: "x" };
    expect(wrong.kind).toBe("pause");
  });
});
