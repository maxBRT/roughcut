# Building Roughcut

Roughcut is a Tauri 2 app: a Rust core (Cargo workspace) and a TypeScript + React interface built with Vite. The spec is `docs/SPEC.md`. Part 3 has the plan; section 3.3 has the module layout.

## 1. Load the environment (every shell, every time)

The tools are not on PATH by default.

```bash
# Bash (Git Bash)
source "<project>/tools/env.sh"
```

```powershell
# PowerShell
. "<project>/tools/env.ps1"
```

This gives you:

- cargo and rustup (Rust 1.100) on the **GNU target** (`stable-x86_64-pc-windows-gnu`). `RUSTUP_TOOLCHAIN` is set to it, and `rust-toolchain.toml` pins it too.
- gcc, windres and dlltool from a portable WinLibs MinGW-w64 (UCRT, gcc 16.2) in `%LOCALAPPDATA%\Programs\winlibs-mingw64\bin`.
- node and npm (Node 26).
- ffmpeg and ffprobe 9.0.2 (full build, with NVENC).

**Why GNU and not MSVC:** this machine has no MSVC linker or Windows SDK, and installing Visual Studio Build Tools needs administrator rights. The GNU target links with the MinGW gcc and needs no installation. Do not switch the toolchain back to MSVC.

## 2. Parallel work: one target directory per track

Several agents build at the same time. Cargo locks its target directory, so each agent uses its own:

```bash
export CARGO_TARGET_DIR="<project>/target-tracks/<your-track-name>"
```

```powershell
$env:CARGO_TARGET_DIR = "<project>/target-tracks/<your-track-name>"
```

The first build in a new target directory compiles Tauri and its dependencies, which took about 8 minutes on this PC. Later builds are incremental. `target/` and `target-tracks/` are ignored by git.

Each core module is its own crate, so you can build and test yours without compiling anyone else's unfinished code: `cargo test -p <crate>` compiles only that crate and the crates it depends on.

## 3. Build, run and test

All commands run from the project root (`roughcut/`) after step 1.

| What | Command |
| --- | --- |
| Install interface dependencies (once, or after package.json changes) | `npm install` |
| Build the whole Rust workspace | `cargo build --workspace` |
| Test one crate | `cargo test -p rc-types` (or any crate name below) |
| Test the whole workspace | `cargo test --workspace` |
| Type-check the interface | `npm run typecheck` |
| Test the interface (Vitest, jsdom) | `npm test` |
| Build the interface into `dist/` | `npm run build` (runs the type check first) |
| Regenerate the TypeScript types from Rust | `npm run gen:types` |
| Run the app in development, with hot reload | `npm run tauri dev` |
| Build a runnable debug app with the interface embedded | `npm run tauri -- build --debug --no-bundle` |
| Generate test media | `npm run fixtures` (script owned by the fixtures track) |
| Drive the built app end to end (real core, FFmpeg, transcriber; stand-in `claude`) | `npm run e2e` (every scenario in order: import, play, two-sources, resume, cut-by-text, undo, find, suggestions, autosave, typing, timeline, export, export-cases, whole-job, edge-sources, edge-speech, edge-formats, edge-cache, edge-close, keys; about 15 minutes) or `npm run e2e -- <name> [<name>...]`. `npm run e2e -- speed-hour` (only when named) makes an hour of 4K from the fixtures, imports, edits (300 cuts) and exports it and records each speed target of spec 1.11/2.6 against the measurement in `result.json` (`table`); about 25 minutes, GPU-heavy. Needs the debug app built first (rebuild it after any `cargo test -p roughcut`, which can replace `target/debug/roughcut.exe` with a plain cargo build that loads the dev server). Every run happens on a hidden Windows desktop (`e2e/lib/hidden.mjs`): no window, file dialog or sound reaches the user's screen. Exports go to a folder under the run folder (the scenarios write `exportFolder` into the launch's settings) and are deleted after checking; Show in folder writes its target to `reveal.log` (`ROUGHCUT_TEST_REVEAL_LOG`) instead of opening Explorer, and Copy path puts back the clipboard text it found. Only `--real-claude` (`suggestions`, `speed-hour`) runs the installed `claude` (one real call on the user's subscription); every other run uses rc-suggest's stand-in. Each scenario starts from empty folders under `.cache-dev/e2e/<run>/<scenario>/` (screenshots in `shots/`, numbers in `result.json`; the edge scenarios list each spec 1.12 situation in `rows` with what happened and pass or fail), exits non-zero on failure, and leaves no process running. A launch on the harness's own transcriber and model folders must transcribe on the GPU: every "transcriber ready" line in its log has to say device Gpu with no fallback, or the scenario fails (`App.checkTranscriberDevice`, run by `e2e/run.mjs`). Code in `e2e/`. `ROUGHCUT_E2E_APP=<exe>` runs the scenarios against another build, for example the packaged `dist-app/Roughcut/Roughcut.exe` (the stand-in `claude` still comes from `target/debug`). Two more run only when named and need `ROUGHCUT_E2E_APP` pointing at the packaged exe: `first-run` (only `ROUGHCUT_DATA_DIR`, `ROUGHCUT_CACHE_DIR` and `ROUGHCUT_CLAUDE` = the stand-in are set, ffmpeg and the transcriber are taken off PATH; the app must use its own ffmpeg and `speech-runtime\`, download the speech model into `%LOCALAPPDATA%\Roughcut\speech\models` with the progress line shown, then import, transcribe and export; it refuses to run once that model is there) and `installed-start` (after `npm run install-speech`; no `ROUGHCUT_` variable but `ROUGHCUT_CLAUDE`, so the user's real data and cache folders are used: refuses if they hold a project, checks the transcript is made on the GPU from `runtime\gpu` with no download, then removes its project and cache through the app). |
| Release build, self-contained folder | `npm run package -- --build` (release build, then assemble `dist-app/Roughcut/`; plain `npm run package` reuses the release build). See "Packaging" below. |
| Installer (per-user NSIS, built, not run) | `npm run package -- --installer` |
| Put the speech model and GPU runtime where the installed app looks (this PC only) | `npm run install-speech` (`-- --check` only reports). Both first start `.cache-dev/speech/dist/gpu/transcriber.exe` on the GPU with no audio and refuse (exit 1, nothing copied) when it reports the processor or a fallback (`scripts/lib/gpu-probe.mjs`) |

**Runnable app.** `npm run tauri -- build --debug --no-bundle` builds the interface, then the app, and writes `target/debug/roughcut.exe` (or `$CARGO_TARGET_DIR/debug/roughcut.exe`). That exe runs on its own. It needs `WebView2Loader.dll` next to it, and the build copies it there automatically. Any installer must ship that DLL beside the exe.

A plain `cargo build` also produces `roughcut.exe`, but that build loads the interface from the Vite dev server at `http://localhost:1420`, so it shows nothing unless `npm run dev` is running.

The app crate also builds two test programs, `rc-test-standin-claude` and `rc-test-standin-transcriber` (rc-suggest's and rc-speech's stand-ins, used by `cargo test -p roughcut` and `npm run e2e`). They need the crate feature `test-helpers`, which is on by default; the installer build passes `--no-default-features` because Tauri's bundler ships every binary of the crate.

### Packaging

`scripts/package.mjs` (`npm run package`, after sourcing `tools/env.sh`) assembles `dist-app/Roughcut/` (git-ignored) from the release build (`npm run tauri -- build --no-bundle`; `--build` runs it first):

| File | From |
| --- | --- |
| `Roughcut.exe` | `target/release/roughcut.exe` |
| `WebView2Loader.dll` | `target/release/` (the GNU build puts it there) |
| `ffmpeg.exe`, `ffprobe.exe`, `ffmpeg-LICENSE.txt` | the FFmpeg 9.0.2 full build on PATH (`tools/env.sh`); the app looks next to its exe first |
| `speech-runtime\transcriber.exe`, `sherpa-onnx-c-api.dll`, `onnxruntime.dll`, `onnxruntime_providers_shared.dll` | `.cache-dev/speech/dist/cpu` (the processor runtime, 22 MB; `transcriber/scripts/build.sh cpu`) |
| `README.txt` | written by the script: how to start, where things are kept, how to remove everything |

The script checks with MinGW's `objdump` that the exe and each speech file import only DLLs that are in System32 or shipped beside them, and prints the size (489 MB on 2026-11-15). The speech model is not shipped: the app downloads the processor model (482 MB) on first use as a `model_download` job, shown as "downloading the speech model, once only · N%" under the player. The GPU runtime (2.3 GB) is not in the folder either: when the PC has an NVIDIA driver and `%LOCALAPPDATA%\Roughcut\speech\runtime\gpu` holds `transcriber.exe` and `onnxruntime_providers_cuda.dll`, the app uses that folder instead of `speech-runtime\` (`appcore/config.rs` `choose_transcriber_dir`), and then also downloads the fp32 model in the background. `npm run install-speech` (`scripts/install-speech.mjs`) copies the fp32 and int8 models, the voice detector and `.cache-dev/speech/dist/gpu` there from `.cache-dev`, so no download is needed on this PC; it writes nothing outside `%LOCALAPPDATA%\Roughcut\speech`. The app does not download the GPU runtime itself.

`npm run package -- --installer` then builds `target/release/bundle/nsis/Roughcut_0.1.0_x64-setup.exe` with `src-tauri/tauri.installer.conf.json` merged in: NSIS, `installMode: currentUser` (no administrator rights; installs to `%LOCALAPPDATA%\Roughcut`, beside the app's `cache\` and `speech\` folders, which its uninstaller leaves alone), and the folder's extra files as resources. The first build downloads NSIS 3.13 and `nsis_tauri_utils.dll` into `%LOCALAPPDATA%\tauri`. The script checks the compiled `installer.nsi`: exactly the app, `WebView2Loader.dll` and the folder's files, current user only. The resources are also copied next to `target/release/roughcut.exe` by Tauri (about 440 MB of FFmpeg).

`npm run tauri dev` starts Vite on port 1420 (a fixed port; the dev server listens on 127.0.0.1 only) and runs the app against it.

### Where the app finds its files and programs

The core (`src-tauri/src/appcore/config.rs`, `AppConfig::from_env`) reads these environment variables at launch. Each is optional; unset or empty means the default.

| Variable | What it points at | Default |
| --- | --- | --- |
| `ROUGHCUT_DATA_DIR` | Projects (`projects/<id>/project.json`) and `settings.json` | `%APPDATA%\Roughcut` |
| `ROUGHCUT_CACHE_DIR` | The per-source cache (proxies, waveforms, transcripts, suggestions, export work folder) | `%LOCALAPPDATA%\Roughcut\cache` |
| `ROUGHCUT_FFMPEG_DIR` | Folder holding `ffmpeg.exe` and `ffprobe.exe` (read by rc-media) | next to the app's exe, then `PATH` |
| `ROUGHCUT_TRANSCRIBER_DIR` | Folder holding `transcriber.exe` and its runtime DLLs | `%LOCALAPPDATA%\Roughcut\speech\runtime\gpu` when it holds the GPU runtime, the PC has an NVIDIA driver and the folder next to the exe has only the processor runtime (the packaged app); otherwise `speech-runtime\` next to the app's exe. The app crate's build script (`src-tauri/build.rs`) fills `target/<profile>/speech-runtime` from `.cache-dev/speech/dist/gpu` (or `cpu` when there is no GPU build) with copies (`src-tauri/build_mirror.rs`; never hard links: the installer build once wrote the processor DLLs through such links into `dist/gpu`), so the built app transcribes with no variable set. It is not named `transcriber` because Cargo writes the transcriber binary under that name next to the exe. |
| `ROUGHCUT_MODEL_DIR` | The speech model folder (passed as `--model-dir`) | `%LOCALAPPDATA%\Roughcut\speech\models`, downloaded on first use as a `model_download` job |
| `ROUGHCUT_CLAUDE` | The `claude` program | `%USERPROFILE%\.local\bin\claude.exe`, then `PATH` |
| `ROUGHCUT_TEST_FREE_BYTES` | Test hook: the free space, in bytes, the export plan and the export assume at every destination (used by `npm run e2e -- export-cases` for "not enough disk space") | unset: ask Windows |

For development, point them at the files under `.cache-dev` so nothing is downloaded and your real projects are untouched:

```bash
export ROUGHCUT_TRANSCRIBER_DIR="$PWD/.cache-dev/speech/dist/gpu"   # built by transcriber/scripts/build.sh gpu
export ROUGHCUT_MODEL_DIR="$PWD/.cache-dev/speech/models"
export ROUGHCUT_DATA_DIR="$TEMP/roughcut-dev/data" ROUGHCUT_CACHE_DIR="$TEMP/roughcut-dev/cache"
```

The app crate's end-to-end tests (`cargo test -p roughcut --test e2e`) use the real FFmpeg, the transcriber in `ROUGHCUT_TRANSCRIBER_DIR` (default `.cache-dev/speech/dist/gpu`), the model in `ROUGHCUT_MODEL_DIR` (default `.cache-dev/speech/models`), rc-suggest's stand-in `claude`, and temporary data and cache folders. They never run the real `claude`.

**Whole-workspace test run.** A plain `cargo test --workspace` builds `transcriber` against the processor-only sherpa-onnx package, so the transcriber's GPU tests (`speech`, `hour`, `review_cuda_fallback`) fail with "GPU not used: onnxruntime_providers_cuda.dll is not next to the transcriber". Point them at the GPU build (`transcriber/scripts/build.sh gpu`), as `transcriber/README.md` says:

```bash
export ROUGHCUT_TRANSCRIBER_DIR="$PWD/.cache-dev/speech/dist/gpu" ROUGHCUT_MODEL_DIR="$PWD/.cache-dev/speech/models"
export TRANSCRIBER_EXE="$PWD/.cache-dev/speech/dist/gpu/transcriber.exe"
cargo test --workspace     # about 9 minutes once compiled (401 tests); the slow ones are listed below
```

Slow test binaries (measured 2026-11-15): `transcriber --test hour` (240 s, an hour of audio on the GPU and the processor), `rc-media --test export_fixtures` (109 s of 4K exports), `transcriber --test speech` (64 s), `roughcut --test e2e` (42 s), `rc-media --test proxy_fixtures` (18 s). Everything else finishes in under 5 s per binary.

## 4. Shared types

Every type that is saved to disk or crosses between the interface and the core is defined once, in Rust, in `src-tauri/crates/rc-types` (spec 3.4). The interface imports them from `src/types` (`import type { Project } from "../types"`).

- `src/types/generated.ts` is generated by `npm run gen:types`, which runs `cargo run -p rc-types --bin gen-ts`. Never edit it by hand.
- Generator: **ts-rs 12**. One file holds every type, so the spec's aliases (`Micros`, `SourceId`, ...) are used by name. 64-bit integers become `number`, never `bigint`.
- Event names (spec 3.5.5) are `rc_types::events::*` constants in Rust and `EVENTS` in TypeScript. `EventPayloads` maps each event name to its payload type.
- JSON is camelCase. Optional (`?:`) fields are left out when absent; `T | null` fields are written as `null`. `Token` is tagged by `kind`. `bitDepth` and `playbackRate` are bare numbers.
- After changing a type in `rc-types`, run `npm run gen:types`. The test `generated_typescript_is_current_and_has_no_bigint` in `cargo test -p rc-types` fails while the generated file is out of date.

## 5. Layout and owners

The layout follows spec 3.3, with one deliberate change: each core module is a separate crate in a Cargo workspace (root `Cargo.toml`), not a folder inside one crate. Shared dependency versions are declared once in `[workspace.dependencies]`. A crate uses them with `serde = { workspace = true }`.

### Core (Rust)

| Path | Crate | Spec module | Responsibility |
| --- | --- | --- | --- |
| `src-tauri/` | `roughcut` (binary; lib `roughcut_lib`) | app shell + `api` | Tauri app. `src-tauri/src/api/` is the only door into the core: the commands of 3.5.4 and the events of 3.5.5. |
| `src-tauri/crates/rc-types` | `rc-types` | (shared) | Every type in 3.4, event names and payloads from 3.5.5, and the TypeScript generator. |
| `src-tauri/crates/rc-project` | `rc-project` | `project` | Project files: create, list, read, save atomically, remove, upgrade. |
| `src-tauri/crates/rc-source` | `rc-source` | `source` | Fingerprint, probe result, locating and verifying files. |
| `src-tauri/crates/rc-cache` | `rc-cache` | `cache` | Per-source cache folders, sizes, the size limit. |
| `src-tauri/crates/rc-jobs` | `rc-jobs` | `jobs` | The job runner: queue, run, report, cancel. |
| `src-tauri/crates/rc-media` | `rc-media` | `media` | Every FFmpeg task (3.5.9). |
| `src-tauri/crates/rc-server` | `rc-server` | `server` | The media server on 127.0.0.1 (3.5.6). |
| `src-tauri/crates/rc-speech` | `rc-speech` | `speech` | Transcriber client and transcript building. |
| `src-tauri/crates/rc-suggest` | `rc-suggest` | `suggest` | Claude runner and dead-air detection (3.5.8). |
| `src-tauri/crates/rc-settings` | `rc-settings` | `settings` | Settings file; any API key in Windows Credential Manager. |
| `transcriber/` | `transcriber` (binary) | transcriber program | Audio in, timed words out (3.5.7). |

Which modules may use which is set by spec 3.3 and 3.6. Express that with crate dependencies (for example `rc-jobs` may depend on `rc-media`, `rc-speech`, `rc-suggest` and `rc-cache`). Every crate depends on `rc-types`.

### Interface (TypeScript + React, `src/`)

| Folder | Spec module | Responsibility |
| --- | --- | --- |
| `src/edit/` | `edit` | The clip list and its commands (3.5.1). Uses nothing. |
| `src/transcript/` | `transcript` | Words and selections, mapped to and from the clip list. |
| `src/player/` | `player` | Playback of a sequence (3.5.3). |
| `src/keys/` | `keys` | Shortcuts mapped to actions (3.5.2). |
| `src/state/` | `state` | The store and the typed client for the core. The only interface module that talks to the core. |
| `src/views/` | `views` | Home, Transcript, Timeline, Export, shortcut overlay. |
| `src/ui/` | `ui` | Design tokens and shared components from the mockups. |
| `src/types/` | (shared) | Generated types; see section 4. |

Interface tests are `src/**/*.test.ts(x)` and run with Vitest in jsdom. TypeScript is strict, with `noUncheckedIndexedAccess`.

### Other folders

| Path | Owner |
| --- | --- |
| `tools/` | Environment scripts (`env.sh`, `env.ps1`). Add lines; do not remove them. |
| `fixtures/` | Scripts that generate test media (`fixtures/generate.mjs`). Output goes to `fixtures/out/`, which git ignores. |
| `spikes/` | Milestone 0 experiments. Excluded from the Cargo workspace. |
| `.cache-dev/` | Large downloads (models, test media). Ignored by git. |
| `scripts/` | `package.mjs` (the app folder and installer), `install-speech.mjs` (speech files into `%LOCALAPPDATA%\Roughcut\speech`), `screenshot.mjs`. |
| `dist-app/Roughcut/` | The packaged app (`npm run package`). Ignored by git. |
| `README.md` | For the user: what the app does, how to start it, keys, where things are kept, known limits. |
