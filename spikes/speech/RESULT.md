# Speech-to-text spike: result

Milestone 0, risks 1, 2 and 6 (spec 2.8). Run on 13 Nov 2026 on the build PC (RTX 4070 SUPER, driver 617.14, Ryzen 7 5700X).

**Main caveat:** there was no real recording from the user. Everything below comes from substitute audio (section 1). The bake-off on a real recording that spec 2.4.4 asks for has **not** been done. Read the model ranking as provisional.

## 0. Recommendation in short

- **Model:** keep **Parakeet TDT 0.6B v2** as the default. Ship the **int8** package for the processor; use the **fp32** package when the GPU path is installed. Keep v3 as a configured alternative, and decide between them on the user's first real recording (section 3 explains why v3 is not ruled out).
- **Default device: processor.** v2 int8 on the CPU did one hour of audio in 2 min 20 s in the quietest run, already inside the "a few minutes" target. The GPU path **works** (risk 2 retired): one hour took 40 to 95 s. But it needs about 2.3 GB of NVIDIA DLLs plus a 2.5 GB fp32 model. Offer it as an optional extra, or ship it if installer size does not matter.
- **Qwen3-ASR-1.7B + aligner:** runs (Python, GPU). Its word times are far tighter than Parakeet's. But on real speech it **dropped most fillers** (12 of 33 kept, against 25 to 28 for Parakeet) and had a higher error rate. That fails the product's first requirement, so it is **not** the transcriber. Its aligner remains the fallback for risk 6 if word ends cannot be tightened locally.
- **Integration route:** a Rust program built with the **x86_64-pc-windows-gnu** toolchain. It uses the **official `sherpa-onnx` crate 2.0.1** (feature `shared`, no defaults) and links the **official prebuilt sherpa-onnx C API DLLs**. Proven: `transcriber-spike/` reads PCM on stdin and streams JSON-line segments with timed words, on CPU and GPU.

## 1. Test audio and what it can and cannot show

| Audio | What it is | Ground truth | Shows | Cannot show |
| --- | --- | --- | --- | --- |
| `monologue_clean.wav` (139.8 s) | 25 scripted lines in Windows TTS (Microsoft David), each synthesized alone and joined with 1 to 8 s silences. Contains 3 retake groups (7 lines), 2 abandoned sentences, 4 asides, 7 fillers (uh, um, you know). Noise floor -70 dBFS. | Line start/end measured from each line's audio; word starts from the synthesizer's own SpeakProgress positions (about ±50 ms) | Whether identical or near-identical repeats are kept, fillers *as a TTS voice says them*, text in silence, where word ends land relative to known line ends | Real disfluency: a TTS "uh" is clean and articulated, and real retakes are rarely word-for-word |
| `monologue_noisy.wav` | Same, plus steady brown noise at about -42 dBFS RMS and 12 keyboard-like clicks inside the 6, 7 and 8 s silences | Same | Text invented during noisy silence and clicks | Real room noise, music, breathing |
| `ami_B_300_600.wav` (300 s) | Real spontaneous English: AMI Meeting Corpus ES2002a, project manager's headset (channel 1), 300 to 600 s. CC BY 4.0. | AMI manual word transcript with word times; 422 scored words, 33 fillers, 6 immediate repeats | Real voice, real fillers ("um", "uh", "mm"), real self-repeats, word timing against a human-checked reference | A single-speaker monologue (other speakers bleed in at low level), studio audio. AMI word times are themselves aligned, not hand-marked to the millisecond. |
| `hour.wav` (3600 s) | `monologue_clean` + `ami_B_300_600` looped to one hour | None | Speed only | Accuracy |

Scripts that make them: `script/monologue.json`, `script/synth_lines.ps1`, `script/build_monologue.py`. AMI audio comes from `https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/ES2002a/audio/ES2002a.Headset-1.wav` and annotations from `https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip`. The audio lives in `.cache-dev/speech/audio/`.

## 2. What was measured

All Parakeet runs went through the spike transcriber (Silero VAD inside, threshold 0.5, min silence 0.5 s, min speech 0.25 s, max speech 20 s, 250 ms padding around each VAD segment, greedy search). CPU runs used 8 threads; GPU runs used 4 threads for the CPU side. Qwen ran on the same VAD segments, also padded by 250 ms.

### 2.1 Accuracy and behaviour

WER uses the script or AMI reference, lower-cased, without punctuation, with "20"/"40-minute" mapped to words. A filler counts as kept if a filler token appears there in any spelling (uh/ah/um).

| Run | Monologue clean WER | Monologue noisy WER | Fillers kept (mono, of 7) | Retake lines kept (of 7) | Abandoned kept (of 2) | Words invented in silence (clean / noisy) | AMI real speech WER | AMI fillers kept (of 33) | AMI repeats kept (of 6) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v2 int8, CPU | 0.4% | 0.8% | 6 / 5 | 7 | 2 | 0 / 0 | 10.2% (S21 D11 I11) | 25 | 6 |
| v2 fp32, GPU | 0.8% | 0.8% | 5 / 5 | 7 | 2 | 0 / 0 | 10.2% (S21 D10 I12) | 27 | 6 |
| v3 int8, CPU | 0.8% | 1.2% | 5 / 5 | 7 | 2 | 0 / 0 | 7.1% (S13 D14 I3) | 28 | 6 |
| v3 fp32, GPU | 0.4% | 0.4% | 6 / 6 | 7 | 2 | 0 / 0 | 6.9% (S14 D8 I7) | 28 | 6 |
| Qwen3-ASR-1.7B + ForcedAligner-0.6B, GPU, bf16 | 1.2% | 1.2% | 5 / 5 | 7 | 2 | 0 / 0 | 13.5% (S24 D27 I6) | **12** | 6 |

Observations:

- **Retakes and abandoned sentences:** every model kept every repeated line, including the line said three times in a row, and both abandoned sentences ("And then we", "If you don't, you press"). On real speech, all models kept all 6 immediate repeats ("I I", "the the"…). The worry about v2 skipping repeated words did not show up here.
- **Fillers lost by all models:** "Uh, so, the third step…" lost its "Uh" in every run. The cause is the **voice detector, not the model**: Silero marked speech from 98.15 s, and the "Uh" lies at 97.56 to about 98.0 s. A 500 ms pad did not recover it. With threshold 0.3 and min speech 0.1 s it was kept ("Uh, so, …"), but neighbouring lines then merged: 23 segments instead of 25 on the clean file and 16 on the noisy one. This is the most important tuning trade-off for the product (section 4.4). The other lost filler is the "uh" in "is, uh, um, a" in some runs, transcribed as "a".
- **Qwen tidies real fillers:** on the TTS monologue Qwen kept fillers about as well as Parakeet, but on real speech it dropped 21 of 33. That is what spec 2.4.4 suspected of language-model-based recognisers.
- **No invented text** in any silence, clean or noisy, including the clicks, for any model. Note that the VAD removes the silences before the model sees them, so this mostly tests the VAD plus padding. Over the one-hour file, `speech_without_words` fired 0 times for v2 and v3 fp32. **v3 int8 fired 8 times**: the same 2.8 s stretch of real AMI speech in every loop, which v2 int8 transcribed as "were just like in terms of like the wealth of the country." So v3 int8 dropped a whole utterance. The safety net caught it, as designed.

### 2.2 Word times (risk 6)

Times are in seconds; a positive number means late. "Line" means the first word start or last word end compared with the true line start or end (monologue, 25 lines). "End before pause" is the last word's end minus the true end of speech, for lines followed by a pause of 1 s or more.

| Run | Line start error, mean / median / max abs | Last-word end overshoot into pause, mean / median / max | Word start vs synth positions, mean abs | AMI word start error, median / mean abs | AMI word end error, median / mean abs |
| --- | --- | --- | --- | --- | --- |
| v2 int8 CPU (clean) | -0.10 / -0.12 / 0.58 | +0.25 / +0.26 / 0.35 | 0.058 | +0.03 / 0.10 | +0.02 / 0.16 |
| v2 int8 CPU (noisy) | -0.11 / -0.12 / 0.55 | **+0.35 / +0.33 / 0.89** | 0.065 | | |
| v2 fp32 GPU (clean) | -0.10 / -0.13 / 0.58 | +0.19 / +0.23 / 0.33 | 0.062 | +0.03 / 0.11 | +0.02 / 0.16 |
| v3 int8 CPU (clean) | -0.19 / -0.22 / 0.34 | +0.16 / +0.16 / 0.25 | 0.076 | +0.02 / 0.09 | 0.00 / 0.16 |
| v3 fp32 GPU (noisy) | -0.17 / -0.25 / 0.55 | +0.39 / +0.41 / 0.81 | 0.089 | +0.03 / 0.10 | +0.01 / 0.16 |
| Qwen + aligner (clean) | +0.01 / -0.02 / 0.58 | **+0.01 / +0.01 / 0.06** | **0.025** | +0.01 / 0.05 | -0.01 / 0.13 |

(The 0.55 to 0.58 maxima are the clipped "Uh" line, where the first word found is "So".)

- **Per-word times are available** from Parakeet through sherpa-onnx: one start per token (on an 80 ms grid, the encoder frame) and, for TDT, a **duration per token**. Word start = first token's start; word end = the latest token start + duration in the word. The spike does this grouping (tokens with a leading space start a new word; punctuation attaches to the previous word). sherpa's own `words` field stays empty for this model.
- **Word starts are good:** within about 60 to 90 ms on average, and the first word of an utterance tends to start about 0.1 s (v2) to 0.2 s (v3) early.
- **Word ends stretch into a following pause:** by +0.2 to +0.4 s on average, up to +0.9 s with background noise. This confirms spec 2.4.5: ends must be clamped using the VAD and the sound level before cut points are placed. The VAD's own segment end was +0.07 s mean (clean) and +0.35 s median (noisy) after the true end, so the VAD alone is not a tight clamp in noise either. An energy-based clamp is needed.
- Qwen's aligner is much tighter (ends within 0.06 s). If the local clamp proves insufficient on real footage, running Qwen3-ForcedAligner over Parakeet's text is the fallback that risk 6 names, at the cost of shipping Python/PyTorch or porting the aligner.

### 2.3 Speed on the one-hour file

Wall time includes model load, reading PCM from an `ffmpeg` pipe, VAD and decoding, measured inside the transcriber. **The machine was shared with other agents** (Rust compiles, an Edge instance, the user's apps, and in two runs my own pip install). Each row lists every run made, so the spread is visible. Rows marked † ran with known extra load.

| Model and device | Wall time for 1 h (each run) | × real time (wall) | Decode only | VAD only |
| --- | --- | --- | --- | --- |
| v2 fp32, GPU, batch 1 | 77 s; 95 s | 47×; 38× | 55 s; 68 s | 17 s; 21 s |
| v2 fp32, GPU, batch 4 | 88 s; 65 s; **40 s** | 41×; 56×; **90×** | 25 s; 30 s; 21 s | 15 to 22 s |
| v3 fp32, GPU, batch 1 | 96 s; 82 s | 37×; 44× | 55 s; 58 s | 17 to 19 s |
| v3 fp32, GPU, batch 4 | 41 s; 73 s | 87×; 49× | 21 s; 29 s | 15 to 18 s |
| v2 fp16, GPU | 172 s | 21× | 137 s | 27 s |
| v2 int8, GPU | 256 s | 14× | 220 s | 19 s |
| v2 int8, CPU, 8 threads | 283 s †; **140 s** | 13× †; **26×** | 205 s †; 112 s | 29 s †; 22 s |
| v3 int8, CPU, 8 threads | 164 s; 148 s; 139 s | 22×; 24×; 26× | 134 s; 116 s; 109 s | 19 to 24 s |
| Qwen3-ASR-1.7B + aligner, GPU (first 600 s only) | n/a | 24× decode only (600 s in 24.6 s), load 5 to 22 s | | |

- **GPU, best config:** fp32 model, `decode_multiple_streams` with batches of 4 VAD segments: **40 to 88 s per hour**. Batch 16 was slower in a short test (padding to the longest segment).
- **CPU:** int8, **about 2.3 to 2.8 min per hour** when the machine is not otherwise loaded. Either path meets "a few minutes".
- **Do not use int8 or fp16 on the GPU:** int8 is slower than the CPU, and fp16 is slower than fp32 with this ONNX Runtime 1.28.2 CUDA build.
- **VAD costs 15 to 29 s per hour** on one thread, serially before decoding in the spike. In the product, run the VAD in its own thread so it overlaps decoding; that saves about 20 s per hour on the GPU path.
- Model load: 2 to 4 s for fp32 on GPU, 2 to 6 s for int8 on CPU (12 s on a cold disk once).
- GPU memory: the transcriber added about 1 GB with fp32 v2 (`nvidia-smi` total, not per process). Qwen peaked at about 7.5 GB over baseline.

## 3. Choosing v2 or v3

- On our audio they tie on the script (0.4 to 1.2% WER), keep the same retakes and fillers, and run at the same speed.
- On the 5 minutes of real meeting speech, **v3 was better** (6.9 to 7.1% against 10.2%, and 28 against 25 to 27 fillers).
- Against v3: the sherpa-onnx model card measures v2 at 6.48% and v3 at 11.16% on 300 FLEURS English clips. v3 starts words about 0.1 s earlier than v2. **v3 int8 dropped a whole utterance** that v2 transcribed (section 2.1). v3 is multilingual, so it can switch language on accented or unclear speech.
- **Decision:** v2 stays the default, as the spec says, because the larger published English test favours it and our evidence for v3 is one 5-minute sample. The transcriber takes a model folder, so switching is a configuration change. Re-run `script/run_matrix.sh quality` + `script/analyze.py` on the user's first real recording; if v3 wins clearly there, switch, using the fp32 package (not int8).

## 4. Integration route for `transcriber/` (spec 3.5.7)

### 4.1 What to link

- **Crate:** `sherpa-onnx = { version = "=2.0.1", default-features = false, features = ["shared"] }`, published by k2-fsa ("Raw FFI bindings to the sherpa-onnx C API" via `sherpa-onnx-sys` 2.0.1). It has safe wrappers for `OfflineRecognizer` (transducer, with `model_type = "nemo_transducer"`), `VoiceActivityDetector` (Silero), `decode_multiple_streams`, and per-token `timestamps` and `durations`.
- **Build-time setting:** `SHERPA_ONNX_LIB_DIR=<folder containing sherpa-onnx-c-api.dll and sherpa-onnx-c-api.lib>`. With this set, `sherpa-onnx-sys`'s build script downloads nothing. It emits `rustc-link-lib=dylib=sherpa-onnx-c-api` and `dylib=onnxruntime`, and copies every DLL in that folder into `target/<profile>/`. GNU ld consumes the MSVC import library `sherpa-onnx-c-api.lib` directly. The linker drops the unused onnxruntime reference, so the finished exe imports only `sherpa-onnx-c-api.dll` (plus Windows UCRT and system DLLs).
- **Toolchain:** `stable-x86_64-pc-windows-gnu` (rustc 1.100.0) with the project's WinLibs MinGW from `tools/env.sh`. **Verified to build and run.** One build-dependency (`getrandom` via ureq/rustls, used by the downloader) needs `dlltool.exe`. Without WinLibs on PATH the build fails with `error calling dlltool 'dlltool.exe': program not found`. `ring` also compiles C with gcc.
- **Do not use the `static` feature** (the crate's default): it links MSVC static libraries (`win-x64-static-MT-Release-lib`), which the GNU toolchain cannot use. **Do not build sherpa-onnx from source**, because there is no MSVC on this machine.
- The same exe works with either DLL set (CPU-only or CUDA), because the C API is identical. Build once against either `lib/` folder.

Exact build command (Git Bash):

```bash
source "<project>/tools/env.sh"
export SHERPA_ONNX_LIB_DIR="<project>/.cache-dev/speech/runtime/sherpa-onnx-v2.0.1-cuda-12.x-cudnn-9.x-onnxruntime1.28.2-win-x64-cuda/lib"
export CARGO_TARGET_DIR="<project>/.cache-dev/speech/build/transcriber-spike-target"
cd "<project>/spikes/speech/transcriber-spike" && cargo build --release
```

### 4.2 Runtime artifacts (official, no installer, no admin rights)

| Artifact | URL | Download | Used for |
| --- | --- | --- | --- |
| sherpa-onnx v2.0.1, CPU, shared, static CRT | `https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-win-x64-shared-MT-Release-no-tts.tar.bz2` | 25.6 MB | CPU DLLs (`lib/`), `.lib` for linking, CLI tools |
| sherpa-onnx v2.0.1, CUDA 12 / cuDNN 9, ORT 1.28.2 | `https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-cuda-12.x-cudnn-9.x-onnxruntime1.28.2-win-x64-cuda.tar.bz2` | 597 MB | GPU DLLs. **Contains no NVIDIA libraries.** A `cuda-13.x` variant also exists (481 MB), but was not tested. |
| CUDA runtime 12.9.79 | `https://developer.download.nvidia.com/compute/cuda/redist/cuda_cudart/windows-x86_64/cuda_cudart-windows-x86_64-12.9.79-archive.zip` | 3.5 MB | `cudart64_12.dll` |
| cuBLAS 12.9.2.10 | `https://developer.download.nvidia.com/compute/cuda/redist/libcublas/windows-x86_64/libcublas-windows-x86_64-12.9.2.10-archive.zip` | 550 MB | `cublas64_12.dll`, `cublasLt64_12.dll` |
| cuDNN 9.28.1.4 for CUDA 12 | `https://developer.download.nvidia.com/compute/cudnn/redist/cudnn/windows-x86_64/cudnn-windows-x86_64-9.28.1.4_cuda12-archive.zip` | 1.89 GB | `cudnn*64_9.dll` |
| Silero VAD | `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx` | 644 KB | VAD |
| Parakeet v2 int8 (CPU) | `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2` | 482 MB (631 MB unpacked) | `encoder.int8.onnx` 652 MB, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt` |
| Parakeet v3 int8 (CPU) | `…/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2` | 487 MB | same names |
| Parakeet v2 fp32 (GPU) | `https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2/resolve/main/{encoder.onnx,encoder.weights,decoder.onnx,joiner.onnx,tokens.txt}` | 2.51 GB | `encoder.onnx` 42 MB + `encoder.weights` 2.44 GB (external data, must sit next to it), `decoder.onnx` 29 MB, `joiner.onnx` 7 MB |
| Parakeet v3 fp32 (GPU) | `https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3/resolve/main/…` (same names) | 2.55 GB | same names |
| Parakeet v2 fp16 | `https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-fp16/…` | 1.26 GB | not recommended (slower on GPU) |

NVIDIA's redistributable archives are plain zips. Download them with curl; no installer or administrator rights are needed. Index files: `https://developer.download.nvidia.com/compute/cuda/redist/redistrib_12.9.2.json` and `https://developer.download.nvidia.com/compute/cudnn/redist/redistrib_9.28.1.json`. The licence terms for redistributing them inside an app were not reviewed. Check the NVIDIA CUDA and cuDNN SLA "redistributable" lists before shipping.

### 4.3 Files that must sit next to the executable

**CPU (about 22 MB + model):**

| File | Size |
| --- | --- |
| `transcriber.exe` | 1.7 MB (spike) |
| `sherpa-onnx-c-api.dll` | 3.7 MB |
| `onnxruntime.dll` | 17.8 MB |
| `onnxruntime_providers_shared.dll` | 0.1 MB |

The CPU package's DLLs use the static CRT, so no Visual C++ runtime is needed. The Rust exe needs only the UCRT (`api-ms-win-crt-*`), which ships with Windows 10 and 11.

**GPU (about 2.37 GB + model):** take these from the CUDA package `lib/` and the NVIDIA zips. The modules actually loaded during a GPU run are marked "loaded" (checked with `Get-Process … .Modules`).

| File | Size | Source | Loaded |
| --- | --- | --- | --- |
| `sherpa-onnx-c-api.dll` | 4.3 MB | CUDA package | yes |
| `onnxruntime.dll` | 16.3 MB | CUDA package | yes |
| `onnxruntime_providers_shared.dll` | 0.02 MB | CUDA package | yes |
| `onnxruntime_providers_cuda.dll` | 496.7 MB | CUDA package | yes |
| `cudart64_12.dll` | 0.6 MB | cuda_cudart zip `bin/` | yes |
| `cublas64_12.dll` | 102.5 MB | libcublas zip `bin/` | yes |
| `cublasLt64_12.dll` | 668.7 MB | libcublas zip `bin/` | yes |
| `cudnn64_9.dll` | 0.3 MB | cudnn zip `bin/x64/` | yes |
| `cudnn_graph64_9.dll` | 99.9 MB | cudnn | yes |
| `cudnn_ops64_9.dll` | 90.1 MB | cudnn | yes |
| `cudnn_adv64_9.dll` | 229.6 MB | cudnn | yes |
| `cudnn_engines_precompiled64_9.dll` | 522.3 MB | cudnn | yes |
| `cudnn_engines_runtime_compiled64_9.dll` | 44.0 MB | cudnn | yes |
| `cudnn_engines_tensor_ir64_9.dll` | 0.2 MB | cudnn | yes |
| `cudnn_heuristic64_9.dll` | 94.8 MB | cudnn | yes |
| `cudnn_cnn64_9.dll`, `cudnn_ext64_9.dll` | 3.0 MB | cudnn | not loaded in this run; ship them anyway (tiny) |
| `MSVCP140.dll`, `MSVCP140_1.dll`, `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll` | | Visual C++ 2015-2022 runtime | yes. The CUDA onnxruntime build uses the dynamic CRT. They were loaded from System32 here; ship app-local copies or require the VC++ redistributable. |

`onnxruntime_providers_tensorrt.dll` is in the package but not needed. Not shipping it was tested: the spike's deploy folder has no TensorRT DLL.

### 4.4 Settings that worked

- Recognizer: `model_type = "nemo_transducer"`, `decoding_method = "greedy_search"`, `feat_config = {16000, 80}` (defaults; sherpa reads `feat_dim=128` from the model metadata), `num_threads = 8` (CPU) or `4` (GPU), `provider = "cpu"` or `"cuda"`.
- Model file choice: CPU → `encoder.int8.onnx`/`decoder.int8.onnx`/`joiner.int8.onnx`; GPU → `encoder.onnx` (+`encoder.weights`)/`decoder.onnx`/`joiner.onnx`. Same `tokens.txt` for both.
- GPU batching: collect VAD segments and call `decode_multiple_streams` on **4** at a time; flush at end of input. For streaming, flush whatever is waiting after about 2 s so text keeps appearing.
- VAD (Silero via sherpa): window 512 samples, `min_silence_duration 0.5`, `max_speech_duration 20` (the model card says to split long audio into ≤ 15 to 20 s chunks at silences), buffer 60 s. Feed the recognizer the **original audio from VAD start − 250 ms to VAD end + 250 ms**, not the VAD's own sample copy.
  - With `threshold 0.5`, `min_speech_duration 0.25`, segments matched the script exactly (25 of 25 lines, no merges) but missed one soft initial "Uh".
  - With `threshold 0.3`, `min_speech_duration 0.1`, the "Uh" was kept and some lines with 1 to 1.5 s pauses merged.
  - **Suggested start:** 0.3 / 0.1. Derive pause chips from word gaps after end clamping, not from segment boundaries. Re-check on real footage.
- Word grouping and end clamping as in section 2.2. Expect ends 0.2 to 0.4 s late (up to 0.9 s in noise) and the first word of a segment up to 0.25 s early (it can start at the padded window start).
- The sherpa-onnx v2 model card says very quiet input degrades results (upstream issue k2-fsa/sherpa-onnx#4024) and recommends normalising gain. AMI headset audio at -39 dB mean was fine. Normalising to about -20 dBFS peak in the FFmpeg audio job was not tested here.

### 4.5 Detecting the device actually used

- ONNX Runtime prints nothing on stderr about provider choice, even with `debug = true`.
- **Do not `LoadLibrary("onnxruntime_providers_cuda.dll")` yourself**: outside onnxruntime it fails with WinError 1114 (DLL initialisation failed), because the provider host has not been set.
- The spike pre-checks `cudart64_12.dll`, `cublasLt64_12.dll`, `cublas64_12.dll`, `cudnn64_9.dll` and `onnxruntime_providers_shared.dll` with `LoadLibraryW`. If any fails, it falls back to CPU and says so in `ready.fallback_reason`. That catches missing NVIDIA DLLs.
- **Not verified:** what happens when those DLLs load but CUDA itself fails (old driver, no GPU). The real transcriber should also confirm that a CUDA module is loaded after `OfflineRecognizer::create`, for example by checking `GetModuleHandleW("onnxruntime_providers_cuda.dll")` together with `cudnn_graph64_9.dll`. Test this by running on a machine without the NVIDIA DLLs.

### 4.6 The spike program

`transcriber-spike/src/main.rs` (about 400 lines) already follows spec 3.5.7.

Command line: `--model-dir <dir> --device gpu|cpu --vad <silero_vad.onnx> [--threads N] [--batch N] [--pad-ms N] [--vad-threshold F] [--min-silence F] [--min-speech F] [--max-speech F] [--raw] [--debug]`

- Reads s16le 16 kHz mono on stdin.
- Writes `ready` (model, device, fallback reason), `segment` (start, end, text, words[{text,start,end}]), `speech_without_words`, `progress` (every 30 s of audio), `done` (every VAD speech range, plus timing stats) and `error` (code, message, exit 1).
- `--raw` adds the token list, token starts and TDT durations to each segment.
- Ready-to-run folders: `.cache-dev/speech/deploy-cpu/` (exe + 3 DLLs) and `.cache-dev/speech/deploy-gpu/` (exe + 17 DLLs).

Example:

```bash
ffmpeg -v error -i input.wav -f s16le -ac 1 -ar 16000 - \
  | .cache-dev/speech/deploy-gpu/transcriber-spike.exe \
      --model-dir .cache-dev/speech/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2 \
      --vad .cache-dev/speech/models/silero_vad.onnx --device gpu --threads 4 --batch 4
```

Things the real program needs that the spike lacks:

- the VAD in its own thread;
- a timed flush of the batch;
- a post-create GPU check (4.5);
- a cap on how much audio is buffered. The spike keeps 30 s behind the VAD.

## 5. Qwen3-ASR-1.7B: how it was run

- **Route:** Python 3.12 venv at `.cache-dev/speech/venv-qwen` (5.0 GB). It holds `torch 2.9.1+cu128`, installed from the wheel (`https://download.pytorch.org/whl/cu128/torch-2.9.1%2Bcu128-cp312-cp312-win_amd64.whl`; pip's own download of the newest torch failed its hash check twice, probably truncated). It also holds `qwen-asr==0.0.6` installed with `--no-deps`, then `transformers==4.57.6 accelerate==1.12.0 librosa soundfile qwen-omni-utils nagisa==0.2.11 pytz`. `soynlp` (Korean only) has no wheel and was skipped; the import still works.
- **Models:** `Qwen/Qwen3-ASR-1.7B` (4.7 GB) and `Qwen/Qwen3-ForcedAligner-0.6B` (1.8 GB) from Hugging Face, in `.cache-dev/speech/qwen/`. Total disk is about 11 GB.
- **Script:** `script/qwen_run.py`, bf16 on `cuda:0`, batch 8, language forced to English, `return_time_stamps=True`.
- **Not tried:** Qwen on the CPU, and the vLLM backend.
- **Native route:** sherpa-onnx 2.0.1 does have a `qwen3_asr` model type, and the official asr-models release has `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25` (879 MB). Third-party exports of 1.7B exist on Hugging Face (for example `Sporer/sherpa-onnx-qwen3-asr-1.7B-fp16`). None of these give word times, and there is no sherpa-onnx forced aligner, so the native route does not satisfy the word-time requirement. Not run.

## 6. Not measured, and why

- **The user's real recording:** none was supplied. Every accuracy figure is from TTS speech or 5 minutes of a meeting headset. Fillers and retakes in a real solo recording, with real room noise and music, are untested. **Repeat the quality matrix on the first real recording before locking the model.**
- Clean GPU timings: the machine was shared throughout, so speed is given as ranges over 2 to 3 runs.
- Whisper and other models in the spec's table were not re-tested.
- Qwen on the CPU, Qwen speed on the full hour (measured on the first 600 s only), and Qwen GPU memory beyond a single `nvidia-smi` peak.
- The CUDA 13 sherpa-onnx build.
- GPU behaviour when CUDA fails after the DLLs load (4.5).
- Behaviour while FFmpeg is encoding the proxy on the same GPU at the same time.
- Gain normalisation for quiet recordings.

## 7. Files

- `spikes/speech/script/`: `monologue.json` (script), `synth_lines.ps1` (TTS per line + word positions), `build_monologue.py` (joins lines, writes truth), `run_matrix.sh` (`quality`, `speed`, `speed2`), `analyze.py` (scoring), `qwen_run.py`.
- `spikes/speech/transcriber-spike/`: the Rust spike (`Cargo.toml`, `src/main.rs`).
- `spikes/speech/recorded/`: **raw transcriber output for later tests** (`<audio>__<model>__<device>_b1.jsonl`, exactly the JSON-line messages above, with `--raw` token data for Parakeet). Also `monologue_truth.json` (line and word truth), `ami_B_300_600_reference.json` (AMI reference words, CC BY 4.0, AMI Consortium), `analysis.json` and `analysis_summary.txt` (the scores above).
- `.cache-dev/speech/`: `runtime/` (both sherpa packages unpacked), `nvidia/` (unpacked NVIDIA zips), `models/` (v2/v3 int8, v2/v3 fp32, v2 fp16, `silero_vad.onnx`), `deploy-cpu/`, `deploy-gpu/`, `audio/` (test audio incl. `hour.wav`), `runs/` (one-hour run outputs, stderr logs, `speed1.log`, `speed2.log`), `qwen/`, `venv-qwen/`, `venv-tools/` (numpy, soundfile, pefile for the scripts), `downloads/` (original archives).
