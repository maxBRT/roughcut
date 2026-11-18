// Puts the speech model and the GPU speech runtime where the installed app looks for them by
// default, so its first real start downloads nothing:
//
//   %LOCALAPPDATA%\Roughcut\speech\models\sherpa-onnx-nemo-parakeet-tdt-0.6b-v2\       fp32 model (GPU)
//   %LOCALAPPDATA%\Roughcut\speech\models\sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8\  int8 model (processor)
//   %LOCALAPPDATA%\Roughcut\speech\models\silero_vad.onnx                              voice detector
//   %LOCALAPPDATA%\Roughcut\speech\runtime\gpu\                                        transcriber.exe + CUDA runtime
//
// copied from the development downloads in .cache-dev/speech (models/ and dist/gpu/).
//
//   npm run install-speech             copy what is missing or a different size
//   npm run install-speech -- --check  only report what is there
//
// Writes nothing outside %LOCALAPPDATA%\Roughcut\speech. The app (appcore/config.rs
// default_transcriber_dir) prefers runtime\gpu over the processor-only speech-runtime\ shipped
// next to its exe when there is an NVIDIA driver; the model download (appcore/models.rs) sees
// every file at its exact size and downloads nothing.
//
// Before anything is copied (and with --check too), the transcriber in dist/gpu is started on
// the GPU with no audio. If it reports the processor or a fallback (for example because
// dist/gpu holds the processor build of onnxruntime.dll), nothing is copied and the exit code
// is 1, so a broken development runtime never replaces the user's working one.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gpuProbeArgs, probeGpu } from "./lib/gpu-probe.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FROM_MODELS = path.join(ROOT, ".cache-dev", "speech", "models");
const FROM_GPU = path.join(ROOT, ".cache-dev", "speech", "dist", "gpu");
if (!process.env.LOCALAPPDATA) {
  console.error("install-speech: LOCALAPPDATA is not set");
  process.exit(1);
}
const HOME = path.join(process.env.LOCALAPPDATA, "Roughcut", "speech");

const FP32 = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2";
const INT8 = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";
// The exact sizes rc-speech's packages expect (src-tauri/crates/rc-speech/src/models.rs).
const MODEL_FILES = [
  [`${FP32}/encoder.onnx`, 41_838_346],
  [`${FP32}/encoder.weights`, 2_435_420_160],
  [`${FP32}/decoder.onnx`, 28_883_664],
  [`${FP32}/joiner.onnx`, 6_907_577],
  [`${FP32}/tokens.txt`, 9_384],
  [`${INT8}/encoder.int8.onnx`, 652_282_309],
  [`${INT8}/decoder.int8.onnx`, 7_257_753],
  [`${INT8}/joiner.int8.onnx`, 1_739_080],
  [`${INT8}/tokens.txt`, 9_384],
  ["silero_vad.onnx", 643_854],
];

const check = process.argv.includes("--check");
const jobs = [
  ...MODEL_FILES.map(([rel, size]) => ({ from: path.join(FROM_MODELS, ...rel.split("/")), to: path.join(HOME, "models", ...rel.split("/")), size })),
  ...fs.readdirSync(FROM_GPU).map((n) => ({ from: path.join(FROM_GPU, n), to: path.join(HOME, "runtime", "gpu", n), size: fs.statSync(path.join(FROM_GPU, n)).size })),
];
if (!jobs.some((j) => path.basename(j.to) === "onnxruntime_providers_cuda.dll") || !jobs.some((j) => path.basename(j.to) === "transcriber.exe")) {
  console.error(`install-speech: ${FROM_GPU} does not hold the GPU transcriber (run transcriber/scripts/build.sh gpu)`);
  process.exit(1);
}

const probe = probeGpu(path.join(FROM_GPU, "transcriber.exe"), gpuProbeArgs(FROM_MODELS));
if (!probe.ok) {
  console.error(`install-speech: refusing to install ${FROM_GPU}: ${probe.problem}`);
  console.error("install-speech: rebuild it with transcriber/scripts/build.sh gpu; nothing was copied");
  process.exit(1);
}
console.log(`  ${FROM_GPU}: the transcriber starts on the GPU`);

let copied = 0;
let bytes = 0;
let missing = 0;
for (const j of jobs) {
  const rel = path.relative(HOME, j.to);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`refusing to write outside ${HOME}: ${j.to}`);
  const have = fs.existsSync(j.to) ? fs.statSync(j.to).size : -1;
  // transcriber.exe is small and changes with each build: compared byte for byte.
  const fresh = have === j.size && (path.basename(j.to) !== "transcriber.exe" || fs.readFileSync(j.to).equals(fs.readFileSync(j.from)));
  if (fresh) continue;
  if (check) {
    console.log(`  missing or different: ${rel}`);
    missing++;
    continue;
  }
  const src = fs.statSync(j.from);
  if (src.size !== j.size) throw new Error(`${j.from} is ${src.size} bytes, expected ${j.size}`);
  fs.mkdirSync(path.dirname(j.to), { recursive: true });
  const tmp = `${j.to}.part-copy`;
  fs.copyFileSync(j.from, tmp);
  fs.renameSync(tmp, j.to);
  copied++;
  bytes += j.size;
  console.log(`  copied ${rel} (${(j.size / 1048576).toFixed(1)} MB)`);
}
if (check) {
  console.log(missing ? `${missing} of ${jobs.length} files missing in ${HOME}` : `All ${jobs.length} files are in ${HOME}`);
  process.exit(missing ? 1 : 0);
}
console.log(`${HOME}: ${jobs.length} files in place (${copied} copied, ${(bytes / 1073741824).toFixed(2)} GB)`);
