// Starts a transcriber on the GPU with no audio and reads which device it reports, so a GPU
// runtime folder holding the processor build of onnxruntime / sherpa-onnx (it falls back to the
// processor and says so) is told apart from a working one. Used by install-speech.mjs.
//
//   probeGpu(command, args)            -> { ok, device, fallback, problem, stderr }
//   gpuProbeArgs(modelDir)             -> the transcriber arguments for that probe
//   readyOf(stdout)                    -> the transcriber's `ready` message, or null

import { spawnSync } from "node:child_process";

/** The `ready` line of the transcriber's protocol (transcriber/src/protocol.rs), or null. */
export function readyOf(stdout) {
  for (const line of String(stdout).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const m = JSON.parse(t);
      if (m && m.type === "ready") return m;
    } catch {
      // not a protocol line
    }
  }
  return null;
}

/** Arguments that make the transcriber load the fp32 model on the GPU and stop at once. */
export function gpuProbeArgs(modelDir) {
  return ["--model-dir", modelDir, "--device", "gpu"];
}

/**
 * Runs `command args` with empty standard input (no window) and checks that it reports
 * device "gpu" without a fallback.
 */
export function probeGpu(command, args, { timeoutMs = 180_000 } = {}) {
  const r = spawnSync(command, args, { input: "", encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  const stderr = (r.stderr || "").trim();
  if (r.error) return { ok: false, device: null, fallback: null, problem: `could not start ${command}: ${r.error.message}`, stderr };
  const ready = readyOf(r.stdout);
  if (!ready) {
    const last = stderr.split(/\r?\n/).filter(Boolean).pop() || `exit code ${r.status}`;
    return { ok: false, device: null, fallback: null, problem: `the transcriber did not start: ${last}`, stderr };
  }
  if (ready.device !== "gpu" || ready.fallback) {
    const why = stderr.split(/\r?\n/).find((l) => /GPU not used|Fallback to cpu|ENABLE_GPU/i.test(l));
    return {
      ok: false,
      device: ready.device,
      fallback: ready.fallback,
      problem: `the transcriber ran on the ${ready.device === "gpu" ? "GPU with a fallback" : "processor"}, not the GPU${why ? ` (${why.trim()})` : ""}`,
      stderr,
    };
  }
  return { ok: true, device: ready.device, fallback: false, problem: null, stderr };
}
