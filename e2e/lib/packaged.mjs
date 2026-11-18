// Helpers for the scenarios that start the packaged app as a user would (first-run,
// installed-start): where its default folders are, which programs it really ran, its log.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { APP_EXE, check } from "./app.mjs";

/** %LOCALAPPDATA%\Roughcut\speech: the speech model and the GPU runtime by default. */
export const SPEECH_HOME = path.join(process.env.LOCALAPPDATA ?? "", "Roughcut", "speech");
export const MODEL_DIR = path.join(SPEECH_HOME, "models");
export const GPU_RUNTIME = path.join(SPEECH_HOME, "runtime", "gpu");
export const INT8_MODEL = path.join(MODEL_DIR, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", "encoder.int8.onnx");
export const FP32_MODEL = path.join(MODEL_DIR, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2", "encoder.weights");

/** The scenario must run against the packaged folder (ROUGHCUT_E2E_APP), not a build output. */
export function packagedAppDir() {
  check(process.env.ROUGHCUT_E2E_APP, "Set ROUGHCUT_E2E_APP to the packaged exe (dist-app/Roughcut/Roughcut.exe, npm run package)");
  const dir = path.dirname(APP_EXE);
  for (const f of ["ffmpeg.exe", "ffprobe.exe", path.join("speech-runtime", "transcriber.exe")]) {
    check(fs.existsSync(path.join(dir, f)), `${f} is not in the packaged folder ${dir}`);
  }
  return dir;
}

function listPrograms() {
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='ffmpeg.exe' OR Name='ffprobe.exe' OR Name='transcriber.exe'\" | ForEach-Object { $_.Name + '|' + $_.ExecutablePath }";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true }, (err, out) => {
      resolve(err ? [] : out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    });
  });
}

/**
 * Samples which ffmpeg, ffprobe and transcriber executables run, about once a second, until
 * stop(). Returns {stop(): Promise<Map<name, Set<path>>>}.
 */
export function startProgramSampler() {
  const seen = new Map();
  let running = true;
  const loop = (async () => {
    while (running) {
      for (const line of await listPrograms()) {
        const [name, exe] = line.split("|");
        if (!exe) continue;
        const key = name.toLowerCase();
        if (!seen.has(key)) seen.set(key, new Set());
        seen.get(key).add(path.resolve(exe).toLowerCase());
      }
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return seen;
    },
  };
}

/** The app's stdout and stderr of every launch in this folder, in order. */
export function appLog(home) {
  return fs
    .readdirSync(home)
    .filter((f) => /^app-\d+\.log$/.test(f))
    .sort()
    .map((f) => fs.readFileSync(path.join(home, f), "utf8"))
    .join("\n");
}

/** The transcriber's "ready" lines the core writes to its log: [{model, device, fallback}]. */
export { transcriberReady } from "./app.mjs";

/** Every file below `dir` with its size and modified time (for "nothing was downloaded"). */
export function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        out[path.relative(dir, p)] = `${st.size}@${st.mtimeMs}`;
      }
    }
  };
  walk(dir);
  return out;
}

/** Waits for every job of the open project's source to end; samples model downloads meanwhile. */
export async function followJobs(app, sourceId, { timeoutMs = 900_000, onSample } = {}) {
  const t0 = Date.now();
  for (;;) {
    const s = await app.state(
      (st, id) => ({
        jobs: Object.values(st.jobs).map((j) => ({ id: j.id, kind: j.kind, state: j.state, progress: j.progress, sourceId: j.sourceId ?? null })),
        assets: st.sources[id]?.assets ?? null,
        utterances: st.sources[id]?.transcript?.utterances?.length ?? 0,
        notes: [...document.querySelectorAll("[data-note]")].map((e) => [e.dataset.note, e.textContent]),
        notices: (st.notices ?? []).map((n) => n.text),
      }),
      sourceId,
    );
    if (onSample) await onSample(s, Date.now() - t0);
    const open = s.jobs.filter((j) => j.state === "queued" || j.state === "running");
    const a = s.assets;
    if (!open.length && a && a.transcript === "complete" && a.playback === "proxy") return s;
    const failed = s.jobs.filter((j) => j.state === "failed" && j.kind !== "suggest");
    check(!failed.length, "A job failed", failed);
    check(Date.now() - t0 < timeoutMs, `The import did not finish in ${timeoutMs} ms`, s);
    await new Promise((r) => setTimeout(r, 250));
  }
}
