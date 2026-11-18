// @vitest-environment node
import { describe, expect, it } from "vitest";
import { gpuProbeArgs, probeGpu, readyOf } from "./gpu-probe.mjs";

// A stand-in transcriber: node printing what the real one prints for each kind of runtime.
function fake(stdoutLines, stderrLines = [], code = 0) {
  const script = [
    ...stderrLines.map((l) => `process.stderr.write(${JSON.stringify(l + "\n")});`),
    ...stdoutLines.map((l) => `process.stdout.write(${JSON.stringify(l + "\n")});`),
    `process.exit(${code});`,
  ].join("");
  return [process.execPath, ["-e", script]];
}

describe("GPU probe of a transcriber runtime (install-speech)", () => {
  it("accepts a transcriber that is ready on the GPU", () => {
    const r = probeGpu(...fake(['{"type":"ready","model":"m","device":"gpu","fallback":false}', '{"type":"done","speechRanges":[]}']));
    expect(r).toMatchObject({ ok: true, device: "gpu", fallback: false, problem: null });
  });

  it("refuses the processor build of onnxruntime in the GPU folder (it falls back to the processor)", () => {
    const r = probeGpu(
      ...fake(
        ['{"type":"ready","model":"m-int8","device":"cpu","fallback":true}', '{"type":"done","speechRanges":[]}'],
        ["Please compile with -DSHERPA_ONNX_ENABLE_GPU=ON to use cuda. Fallback to cpu!", "transcriber: GPU not used: onnxruntime did not start its CUDA provider"],
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.device).toBe("cpu");
    expect(r.fallback).toBe(true);
    expect(r.problem).toMatch(/processor, not the GPU/);
    expect(r.problem).toMatch(/ENABLE_GPU|GPU not used/);
  });

  it("refuses a transcriber that fails before it is ready", () => {
    const r = probeGpu(...fake(['{"type":"error","code":"model_missing","message":"no model"}'], ["transcriber: no model"], 1));
    expect(r.ok).toBe(false);
    expect(r.problem).toBe("the transcriber did not start: transcriber: no model");
  });

  it("refuses a program that cannot be started", () => {
    const r = probeGpu("C:/no/such/folder/transcriber.exe", gpuProbeArgs("C:/no/models"));
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/^could not start/);
  });

  it("reads the ready line among other output", () => {
    expect(readyOf('noise\r\n{"type":"ready","model":"m","device":"gpu","fallback":false}\r\n{"type":"done"}')).toEqual({ type: "ready", model: "m", device: "gpu", fallback: false });
    expect(readyOf("{not json\n")).toBeNull();
    expect(gpuProbeArgs("D:/m")).toEqual(["--model-dir", "D:/m", "--device", "gpu"]);
  });
});
