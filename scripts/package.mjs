// Assembles the self-contained app folder dist-app/Roughcut/ (spec 2.7: what is shipped).
//
//   npm run package                      assemble from the release build that is already there
//   npm run package -- --build           run the release build first (npm run tauri -- build --no-bundle)
//   npm run package -- --installer       also build the per-user NSIS installer from the folder
//                                        (src-tauri/tauri.installer.conf.json); it is built, never run
//
// Run after sourcing tools/env.sh (ffmpeg.exe and ffprobe.exe are taken from PATH, the
// MinGW objdump checks what the exe imports).
//
// The folder holds:
//   Roughcut.exe            the release build of the app (target/release/roughcut.exe)
//   WebView2Loader.dll      must sit next to the exe (GNU build)
//   ffmpeg.exe, ffprobe.exe the pinned FFmpeg build with NVENC; the app looks next to its exe first
//   ffmpeg-LICENSE.txt      that build's licence
//   speech-runtime\         the transcriber and its processor runtime (.cache-dev/speech/dist/cpu),
//                           the folder the app looks in by default
//   README.txt              how to start it, where things are kept, how to remove everything
//
// The speech model is not shipped: the app downloads it on first use (about 0.5 GB). The GPU
// runtime (2.3 GB) is not in the folder either; the app uses it when it is installed under
// %LOCALAPPDATA%\Roughcut\speech\runtime\gpu (scripts/install-speech.mjs puts it there).

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(ROOT, "target");
const RELEASE = path.join(TARGET, "release");
const OUT = path.join(ROOT, "dist-app", "Roughcut");
const SPEECH_CPU = path.join(ROOT, ".cache-dev", "speech", "dist", "cpu");
/** Exactly what the processor build of the transcriber needs (transcriber/README.md). */
const SPEECH_FILES = ["transcriber.exe", "sherpa-onnx-c-api.dll", "onnxruntime.dll", "onnxruntime_providers_shared.dll"];
/** DLLs shipped beside the exe; everything else it imports must come with Windows. */
const SHIPPED_DLLS = ["webview2loader.dll"];
const SYSTEM32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
/** True for a DLL every Windows 10/11 PC has: an API set name or a file in System32. */
const isWindowsDll = (name) => /^(api|ext)-ms-win-/i.test(name) || fs.existsSync(path.join(SYSTEM32, name));

const args = process.argv.slice(2);
const log = (...a) => console.log(...a);

function die(message) {
  console.error(`package: ${message}`);
  process.exit(1);
}

/** Runs a fixed command line (no user input in it) through the shell, as npm needs on Windows. */
function run(cmd, cmdArgs) {
  const line = [cmd, ...cmdArgs].join(" ");
  log(`> ${line}`);
  execSync(line, { cwd: ROOT, stdio: "inherit" });
}

function findOnPath(exe) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return dir;
  }
  return null;
}

function copy(from, to) {
  if (!fs.existsSync(from)) die(`missing ${from}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/** DLL names a PE file imports, read with MinGW's objdump; null when objdump is not there. */
function importsOf(file) {
  if (!findOnPath("objdump.exe")) return null;
  const out = execFileSync("objdump", ["-p", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return [...out.matchAll(/DLL Name:\s*(\S+)/g)].map((m) => m[1]);
}

function folderBytes(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? folderBytes(p) : fs.statSync(p).size;
  }
  return n;
}

const README = `Roughcut
========

A rough-cut video editor: import a recording, remove bad takes by editing its transcript,
put clips end to end and export an MP4.

Start
-----
Double-click Roughcut.exe in this folder. Nothing needs installing; the folder can live
anywhere (keep its files together). The first transcript downloads the speech model
(about 0.5 GB) once; the line under the player shows its progress.

Needs on this PC: Windows 10 or 11 with the WebView2 runtime (part of Windows 11), an NVIDIA
graphics card with a current driver (export uses it), and, for suggestions, Claude Code
installed and signed in (run "claude" once in a terminal).

Press ? in the app for every keyboard shortcut.

Where things are kept
---------------------
  Projects and settings   %APPDATA%\\Roughcut
  Cache (proxies, audio,   %LOCALAPPDATA%\\Roughcut\\cache
  transcripts, waveforms)  (size limit in the app; clearing it never touches your recordings)
  Speech model and GPU     %LOCALAPPDATA%\\Roughcut\\speech
  speech runtime
  Window data (WebView2)   %LOCALAPPDATA%\\app.roughcut.editor
  Exported videos          your Videos folder, or the folder you chose in the Export dialog

Your recordings are never moved, changed or copied into these folders.

Remove everything
-----------------
Close Roughcut, then delete:
  this folder
  %APPDATA%\\Roughcut
  %LOCALAPPDATA%\\Roughcut
  %LOCALAPPDATA%\\app.roughcut.editor
(Paste each path into the File Explorer address bar.) Nothing else was written: no registry
entries, no shortcuts, no changes to PATH. Exported videos are yours and stay where they are.

Included programs
-----------------
ffmpeg.exe and ffprobe.exe: FFmpeg 9.0.2 full build (gyan.dev), GPL; see ffmpeg-LICENSE.txt.
speech-runtime\\: the transcriber with sherpa-onnx 2.0.1 and ONNX Runtime (Apache-2.0 / MIT).
Speech model (downloaded): NVIDIA Parakeet TDT 0.6B v2, CC-BY-4.0.
`;

if (args.includes("--build")) run("npm", ["run", "tauri", "--", "build", "--no-bundle"]);

const appExe = path.join(RELEASE, "roughcut.exe");
const loader = path.join(RELEASE, "WebView2Loader.dll");
if (!fs.existsSync(appExe)) die(`${appExe} is missing: run npm run tauri -- build --no-bundle (or npm run package -- --build)`);
if (!fs.existsSync(loader)) die(`${loader} is missing; the GNU release build copies it there`);
const ffmpegDir = findOnPath("ffmpeg.exe");
if (!ffmpegDir || !fs.existsSync(path.join(ffmpegDir, "ffprobe.exe"))) die("ffmpeg.exe and ffprobe.exe are not on PATH (source tools/env.sh first)");
for (const f of SPEECH_FILES) if (!fs.existsSync(path.join(SPEECH_CPU, f))) die(`${path.join(SPEECH_CPU, f)} is missing: run transcriber/scripts/build.sh cpu`);

// Every program and library must start on a PC without the build tools: everything it imports
// is either part of Windows or shipped in its own folder.
function checkImports(file, shipped) {
  const imports = importsOf(file);
  if (!imports) {
    log(`objdump not on PATH: the imports of ${path.basename(file)} were not checked`);
    return;
  }
  const names = [...new Set(imports.map((d) => d.toLowerCase()))];
  const foreign = names.filter((d) => !shipped.includes(d) && !isWindowsDll(d));
  if (foreign.length) die(`${file} imports DLLs that are neither part of Windows nor shipped: ${foreign.join(", ")}`);
  log(`${path.basename(file)} imports ${names.length} DLLs, all part of Windows or shipped beside it`);
}
checkImports(appExe, SHIPPED_DLLS);
const speechDlls = SPEECH_FILES.filter((f) => f.endsWith(".dll")).map((f) => f.toLowerCase());
for (const f of SPEECH_FILES) checkImports(path.join(SPEECH_CPU, f), speechDlls);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
copy(appExe, path.join(OUT, "Roughcut.exe"));
copy(loader, path.join(OUT, "WebView2Loader.dll"));
copy(path.join(ffmpegDir, "ffmpeg.exe"), path.join(OUT, "ffmpeg.exe"));
copy(path.join(ffmpegDir, "ffprobe.exe"), path.join(OUT, "ffprobe.exe"));
const ffLicense = path.join(ffmpegDir, "..", "LICENSE");
if (fs.existsSync(ffLicense)) copy(ffLicense, path.join(OUT, "ffmpeg-LICENSE.txt"));
for (const f of SPEECH_FILES) copy(path.join(SPEECH_CPU, f), path.join(OUT, "speech-runtime", f));
fs.writeFileSync(path.join(OUT, "README.txt"), README.replace(/\n/g, "\r\n"));

const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push([path.relative(OUT, p), fs.statSync(p).size]);
  }
};
walk(OUT);
for (const [f, size] of files) log(`  ${f.padEnd(44)} ${(size / 1048576).toFixed(1).padStart(8)} MB`);
log(`Assembled ${OUT}: ${files.length} files, ${(folderBytes(OUT) / 1048576).toFixed(1)} MB`);

if (args.includes("--installer")) {
  // Tauri bundles the release build into an NSIS installer for the current user only
  // (no administrator rights), with the folder's extra files as resources.
  // Also: --no-default-features leaves out the crate's test stand-ins (feature test-helpers), which
  // the bundler would otherwise ship as extra programs; stale copies of them from an earlier
  // release build are removed so they cannot be picked up either.
  const dir = path.join(RELEASE, "bundle", "nsis");
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of ["rc-test-standin-claude.exe", "rc-test-standin-transcriber.exe"]) fs.rmSync(path.join(RELEASE, f), { force: true });
  run("npm", ["run", "tauri", "--", "build", "--bundles", "nsis", "--config", "src-tauri/tauri.installer.conf.json", "--", "--no-default-features"]);
  const setups = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".exe")) : [];
  if (!setups.length) die(`no installer was written to ${dir}`);
  // What the installer holds, from the script NSIS compiled: the app, WebView2Loader.dll and
  // exactly the folder's extra files; no test program.
  const nsi = fs.readFileSync(path.join(RELEASE, "nsis", "x64", "installer.nsi"), "utf8");
  const shipped = [...nsi.matchAll(/File \/a "\/oname=([^"]+)"/g)].map((m) => m[1].toLowerCase()).sort();
  const expected = ["webview2loader.dll", "readme.txt", "ffmpeg-license.txt", "ffmpeg.exe", "ffprobe.exe", ...SPEECH_FILES.map((f) => `speech-runtime\\${f}`.toLowerCase())].sort();
  if (JSON.stringify(shipped) !== JSON.stringify(expected)) die(`the installer's extra files are ${shipped.join(", ")}; expected ${expected.join(", ")}`);
  if (!/!define INSTALLMODE "currentUser"/.test(nsi)) die("the installer is not set to install for the current user only");
  log(`Installer files: the app, ${shipped.join(", ")}; installs for the current user only`);
  for (const s of setups) log(`Installer: ${path.join(dir, s)} (${(fs.statSync(path.join(dir, s)).size / 1048576).toFixed(1)} MB)`);
}
