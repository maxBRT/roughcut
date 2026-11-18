/**
 * Structural checks for the types the core returns (spec 3.4), used by the tests to
 * prove a result really has the documented shape. Each throws with a path on mismatch.
 */
import { expect } from "vitest";

type Check = (v: unknown, path: string) => void;

const fail = (path: string, what: string, v: unknown) => {
  throw new Error(`${path}: expected ${what}, got ${JSON.stringify(v)}`);
};

export const str: Check = (v, p) => {
  if (typeof v !== "string") fail(p, "string", v);
};
export const num: Check = (v, p) => {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(p, "number", v);
};
export const int: Check = (v, p) => {
  if (typeof v !== "number" || !Number.isInteger(v)) fail(p, "integer", v);
};
export const bool: Check = (v, p) => {
  if (typeof v !== "boolean") fail(p, "boolean", v);
};
export const oneOf =
  (...values: unknown[]): Check =>
  (v, p) => {
    if (!values.includes(v)) fail(p, values.join("|"), v);
  };
export const nullable =
  (c: Check): Check =>
  (v, p) => {
    if (v !== null) c(v, p);
  };
export const arr =
  (c: Check): Check =>
  (v, p) => {
    if (!Array.isArray(v)) return fail(p, "array", v);
    v.forEach((x, i) => c(x, `${p}[${i}]`));
  };
/** Required fields, plus optional ones (absent, or present with the right type). Extra fields fail. */
export const obj =
  (req: Record<string, Check>, opt: Record<string, Check> = {}): Check =>
  (v, p) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return fail(p, "object", v);
    const o = v as Record<string, unknown>;
    for (const [k, c] of Object.entries(req)) {
      if (!(k in o)) fail(`${p}.${k}`, "a field", undefined);
      c(o[k], `${p}.${k}`);
    }
    for (const [k, c] of Object.entries(opt)) if (k in o) c(o[k], `${p}.${k}`);
    for (const k of Object.keys(o)) if (!(k in req) && !(k in opt)) fail(`${p}.${k}`, "no such field", o[k]);
  };

export const rational = obj({ num: int, den: int });
export const sourceRange = obj({ sourceId: str, start: int, end: int });
export const sourcePosition = obj({ sourceId: str, at: int });
export const errorCode = oneOf(
  "source_missing", "source_unreadable", "source_mismatch", "disk_full", "nothing_to_export",
  "export_failed", "gpu_unavailable", "transcriber_failed", "claude_missing", "claude_signed_out",
  "claude_limit", "claude_offline", "claude_bad_answer", "cancelled", "internal",
);
export const appErrorShape = obj({ code: errorCode, message: str }, { detail: str });
export const mediaInfo = obj({
  duration: int,
  container: str,
  video: obj({
    codec: str, width: int, height: int, frameRate: rational, variableFrameRate: bool,
    bitDepth: oneOf(8, 10), hdr: bool,
  }),
  audioTracks: arr(obj({ index: int, codec: str, channels: int, sampleRate: int }, { title: str })),
  speechTrack: int,
  directPlayable: bool,
});
export const sourceRef = obj({ id: str, path: str, addedAt: str, media: mediaInfo });
export const clip = obj({ id: str, sourceId: str, start: int, end: int });
export const editState = obj({ clips: arr(clip), dismissed: arr(sourceRange) });
export const editDocument = obj({ current: editState, undo: arr(editState), redo: arr(editState) });
export const sessionState = obj({
  view: oneOf("transcript", "timeline"),
  playhead: nullable(sourcePosition),
  playbackRate: oneOf(1, 1.5, 2),
  cutTextHidden: bool,
});
export const exportResult = obj({ path: str, duration: int, bytes: int, tookSeconds: num, finishedAt: str });
export const project = obj(
  {
    schemaVersion: int, id: str, name: str, createdAt: str, updatedAt: str, frameRate: rational,
    sources: arr(sourceRef), edit: editDocument, session: sessionState,
  },
  { lastExport: exportResult },
);
export const projectSummary = obj(
  { id: str, name: str, rawDuration: int, keptDuration: int, updatedAt: str, missingSources: int },
  { lastExportedAt: str },
);
const tokenBase = { start: int, end: int, cutBefore: int };
export const token: Check = (v, p) => {
  const kind = (v as { kind?: unknown } | null)?.kind;
  if (kind === "word") obj({ kind: str, ...tokenBase, text: str })(v, p);
  else if (kind === "pause" || kind === "unrecognised") obj({ kind: str, ...tokenBase })(v, p);
  else fail(p, "token", v);
};
export const utterance = obj({ index: int, start: int, end: int, tokens: arr(token) });
export const transcript = obj({ schemaVersion: int, sourceId: str, model: str, complete: bool, utterances: arr(utterance) });
export const suggestion = obj(
  {
    id: str,
    kind: oneOf("retake", "false_start", "aside", "dead_air"),
    origin: oneOf("claude", "local"),
    range: sourceRange,
    reason: str,
  },
  { keptVersionAt: int },
);
export const suggestionSet = obj({ schemaVersion: int, sourceId: str, suggestions: arr(suggestion) }, { claudeModel: str });
export const sourceAssets = obj({
  sourceId: str,
  online: bool,
  playback: oneOf("none", "original", "proxy"),
  playbackUrl: nullable(str),
  waveformUrl: nullable(str),
  transcript: oneOf("none", "partial", "complete"),
  suggestions: oneOf("none", "working", "ready", "unavailable"),
});
export const jobStatus = obj(
  {
    id: str,
    kind: oneOf("probe", "proxy", "waveform", "audio", "transcribe", "suggest", "export"),
    state: oneOf("queued", "running", "done", "failed", "cancelled"),
    progress: num,
  },
  { sourceId: str, projectId: str, secondsLeft: num, error: appErrorShape },
);
export const outputFormat = obj({
  codec: oneOf("h264", "hevc"), width: int, height: int, frameRate: rational, bitDepth: oneOf(8, 10),
  hdr: bool, audioTracks: int,
});
export const exportPlan = obj(
  { duration: int, format: outputFormat, estimatedBytes: int, estimatedSeconds: num, freeBytes: int, notices: arr(str) },
  { blockedBy: appErrorShape },
);
export const claudeStatus = obj({ installed: bool, versionTested: bool, signedIn: bool }, { version: str, authMethod: str });
export const settings = obj({
  schemaVersion: int, exportFolder: str,
  keyBindings: arr(obj({ action: str, context: oneOf("everywhere", "home", "transcript", "timeline", "export"), chord: str })),
  speechModel: str, speechDevice: oneOf("auto", "gpu", "cpu"), claudeModel: str,
  claudeAuth: oneOf("subscription", "api_key"), claudeCodeVersionTested: str, cacheLimitBytes: int,
});
export const openedProject = obj({ project, assets: arr(sourceAssets) });
export const cacheUsage = obj({ usedBytes: int, limitBytes: int });
export const nothing: Check = (v, p) => {
  if (v !== undefined) fail(p, "undefined", v);
};

/** Asserts `value` has the shape `check` describes. */
export function expectShape(check: Check, value: unknown, path = "result"): void {
  expect(() => check(value, path)).not.toThrow();
}
