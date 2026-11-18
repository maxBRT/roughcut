# transcriber

The separate transcriber program (spec 3.3, 3.5.7): 16 kHz mono audio in on standard input, timed
words out on standard output, one JSON message per line. Parakeet TDT 0.6B v2 through sherpa-onnx
2.0.1 (fp32 on the GPU, int8 on the processor), with the Silero voice detector inside. The `speech`
module (`rc-speech`) starts it; nothing else in Roughcut links against it.

Decisions come from the speech experiment, `spikes/speech/RESULT.md`.

## Protocol

```
transcriber --model-dir <folder> --device <auto|gpu|cpu> [--vad-model <file>]
```

Optional tuning flags, not part of the protocol: `--model <family>` (default
`sherpa-onnx-nemo-parakeet-tdt-0.6b-v2`), `--threads <n>` (default 4 on the GPU, 8 on the
processor), `--batch <n>` (stretches decoded together on the GPU, default 4).

- **Standard input:** raw s16le PCM, 16 kHz, mono, until end of input. An odd final byte is ignored.
- **Standard output:** UTF-8, one JSON object per line, flushed after each line. Times are whole
  microseconds from the start of the audio (sample `n` is at `floor(n * 62.5)` µs).

```
{"type":"ready","model":"sherpa-onnx-nemo-parakeet-tdt-0.6b-v2 (sherpa-onnx 2.0.1)","device":"gpu","fallback":false}
{"type":"segment","start":123,"end":456,"words":[{"text":"Hello","start":123,"end":300}]}
{"type":"speech_without_words","start":123,"end":456}
{"type":"progress","audioSeconds":12.5}
{"type":"done","speechRanges":[{"start":123,"end":456}]}
{"type":"error","code":"model_missing"|"model_load_failed"|"bad_arguments"|"internal","message":"..."}
```

- Order: `ready` first (or a single `error`), then `segment` / `speech_without_words` / `progress`
  in time order, then exactly one `done`. Exit code 0 only after `done`; after `error` the exit
  code is 1. If standard output is closed by the reader, the program exits with code 3.
- `segment` start/end cover the stretch the voice detector found, widened to include its words.
  Segments never overlap and come in order; words never go back in time and lie inside their
  segment. Word text keeps the model's punctuation and capitals (`"Okay,"`).
- Word ends are the model's raw ends (they can run 0.2 to 0.9 s into a following pause; spec
  2.4.5 makes `speech` tighten them). A first word can start up to 0.25 s before its speech range
  (the decode window is padded).
- `speechRanges` in `done` are the voice detector's own ranges, in order, not overlapping.
- `progress` comes about once a second of wall time, never goes back.
- `fallback` is true when `--device gpu` was asked for, or `--device auto` found the GPU runtime
  and the fp32 model, but the processor is used. `--device auto` on a processor-only installation
  reports `"device":"cpu","fallback":false`. The reason is written to standard error.
- Error codes: `bad_arguments` (unknown flag, missing value, bad device), `model_missing` (no
  model folder, no complete model variant, no voice detector file), `model_load_failed` (files
  present but onnxruntime refused them, e.g. truncated, or a damaged `tokens.txt`), `internal` (anything else, including a
  panic).

### Model folder

`--model-dir` holds one sub-folder per variant, named as sherpa-onnx publishes them (as in
`.cache-dev/speech/models/`):

| Sub-folder | Files | Used for |
| --- | --- | --- |
| `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2` | `encoder.onnx` + `encoder.weights`, `decoder.onnx`, `joiner.onnx`, `tokens.txt` (2.5 GB) | GPU |
| `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8` | `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt` (631 MB) | processor |
| `silero_vad.onnx` (a file, beside the sub-folders or one level up) | | voice detector, unless `--vad-model` is given |

A folder that itself contains `tokens.txt` is taken as one variant. Download URLs are in
`spikes/speech/RESULT.md` section 4.2.

### How it works

- A reader thread decodes PCM, feeds the Silero detector in 512-sample windows (threshold 0.3,
  0.5 s of silence closes a stretch, 0.1 s minimum speech, stretches longer than 20 s cut at the
  quietest short pause) and keeps only the last ~30 s of audio.
- Each closed stretch is cut from the original audio with 250 ms of padding on each side (never
  overlapping the neighbouring stretch's window) and queued; anything longer than 24 s is split
  again at the quietest 20 ms between 8 s and 20 s. The queue holds 8 pieces, so a slow decoder
  slows reading (pipe back-pressure) rather than growing memory.
- The decoding thread transcribes each piece as soon as it is queued (on the GPU up to 4 waiting
  pieces at once) and writes its `segment` line immediately. Tokens are grouped into words (a
  token starting with a space opens a word; word end = latest token start + TDT duration).
- GPU choice: the CUDA prerequisites (`cudart64_12`, `cublasLt64_12`, `cublas64_12`, `cudnn64_9`,
  `onnxruntime_providers_shared`) are loaded first, then `cudaGetDeviceCount` (called from
  `cudart64_12.dll`) must succeed with at least one device; without one (old driver, GPU
  disabled, `CUDA_VISIBLE_DEVICES=-1`) onnxruntime would quietly run the 2.5 GB fp32 model on the
  processor. After the recognizer is created the program checks that both
  `onnxruntime_providers_cuda.dll` and `cudnn_graph64_9.dll` are loaded: onnxruntime loads the
  provider DLL even when the CUDA session then fails, but only a working provider loads cuDNN's
  graph library (so it is deliberately not in the preflight list). Any failure drops the fp32
  recognizer and loads the int8 model on the processor, with `"fallback":true`.
- Model check: before anything reaches sherpa-onnx, each variant's `tokens.txt` is read: every
  line must be `<symbol> <id>` with ids 0, 1, 2, ... in order, and `<blk>` must be present
  (sherpa-onnx calls `exit()` without a word on stdout otherwise; `<blk>` is the last line, so an
  interrupted download loses it). A damaged variant is skipped with a fallback when the other one
  is intact, and gives `model_load_failed` when it was the only one.

## Building

Always load the environment first (`source tools/env.sh`). The program links the official
prebuilt sherpa-onnx C API DLLs through the `sherpa-onnx` crate 2.0.1 (feature `shared`). Its
build script reads **`SHERPA_ONNX_LIB_DIR`**: the folder with `sherpa-onnx-c-api.lib` and the
DLLs. It links against that folder and **copies every DLL in it into `target/<profile>/`**, next
to `transcriber.exe`, so the built program runs in place. Without the variable it downloads the
CPU package from GitHub instead.

```bash
transcriber/scripts/setup-sdk.sh [cpu|gpu|all]   # fetch and unpack into .cache-dev/speech/sdk/{cpu,gpu}
transcriber/scripts/build.sh     [cpu|gpu|all]   # release build + ready-to-run .cache-dev/speech/dist/{cpu,gpu}
```

For development and tests (the GPU folder also runs on the processor):

```bash
export CARGO_TARGET_DIR="$PWD/target-tracks/transcriber"
export SHERPA_ONNX_LIB_DIR="$PWD/.cache-dev/speech/sdk/gpu"
cargo test -p transcriber --lib                                   # unit tests
cargo test -p transcriber --test speech -- --nocapture            # fixture, streaming, error cases (~4 min)
cargo test -p transcriber --test hour -- --nocapture --test-threads 1   # one hour, GPU and processor
```

`TRANSCRIBER_EXE=<path to an exe>` makes the integration tests run a deployed folder instead of
the cargo-built program; `TRANSCRIBER_MODEL_DIR` overrides `.cache-dev/speech/models`. The tests
need `fixtures/out/speech-2min.wav` (`npm run fixtures`).

The exe itself imports only `sherpa-onnx-c-api.dll` plus Windows system DLLs and the UCRT
(`api-ms-win-crt-*`, part of Windows 10/11).

## Files that must sit next to transcriber.exe (what an installer ships)

Exactly what `scripts/build.sh` puts in `.cache-dev/speech/dist/<variant>/`. Ship **one** of the
two sets.

**Processor only** (about 22 MB), from the sherpa-onnx package
`sherpa-onnx-v2.0.1-win-x64-shared-MT-Release-no-tts.tar.bz2`, folder `lib/`:

| File | Size |
| --- | --- |
| `transcriber.exe` | 1.8 MB |
| `sherpa-onnx-c-api.dll` | 3.7 MB |
| `onnxruntime.dll` | 17.8 MB |
| `onnxruntime_providers_shared.dll` | 0.1 MB |

These DLLs use the static C runtime: no Visual C++ runtime needed.

**GPU, with processor fallback** (about 2.3 GB):

| File | Where it comes from |
| --- | --- |
| `transcriber.exe` | this crate |
| `sherpa-onnx-c-api.dll`, `onnxruntime.dll`, `onnxruntime_providers_shared.dll`, `onnxruntime_providers_cuda.dll` | `sherpa-onnx-v2.0.1-cuda-12.x-cudnn-9.x-onnxruntime1.28.2-win-x64-cuda.tar.bz2`, `lib/` (do **not** ship `onnxruntime_providers_tensorrt.dll`) |
| `cudart64_12.dll` | NVIDIA `cuda_cudart-windows-x86_64-12.9.79-archive.zip`, `bin/` |
| `cublas64_12.dll`, `cublasLt64_12.dll` | NVIDIA `libcublas-windows-x86_64-12.9.2.10-archive.zip`, `bin/` |
| `cudnn64_9.dll`, `cudnn_adv64_9.dll`, `cudnn_cnn64_9.dll`, `cudnn_engines_precompiled64_9.dll`, `cudnn_engines_runtime_compiled64_9.dll`, `cudnn_engines_tensor_ir64_9.dll`, `cudnn_ext64_9.dll`, `cudnn_graph64_9.dll`, `cudnn_heuristic64_9.dll`, `cudnn_ops64_9.dll` | NVIDIA `cudnn-windows-x86_64-9.28.1.4_cuda12-archive.zip`, `bin/x64/` |
| `msvcp140.dll`, `msvcp140_1.dll`, `vcruntime140.dll`, `vcruntime140_1.dll` | Visual C++ 2015-2022 runtime (`build.sh` copies them from System32). The CUDA build of onnxruntime imports them; **without them the program cannot start at all**, not even on the processor, because `onnxruntime.dll` is loaded with the exe. Ship them app-local or install the VC++ redistributable. |

Plus a current NVIDIA driver on the PC (not shipped). URLs: `spikes/speech/RESULT.md` 4.2 and
`scripts/setup-sdk.sh`. The NVIDIA redistribution terms were not reviewed (see RESULT.md).

The models are not shipped in the installer (spec 2.7: downloaded on first run) and go in the
folder passed as `--model-dir`.
