// Drives the real Roughcut app: the built exe (target/debug/roughcut.exe) with the real core,
// FFmpeg and transcriber, inside its WebView2 window, reached over the Chrome DevTools
// protocol (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>).
//
// Every run gets its own data, cache and WebView2 folders under .cache-dev/e2e/, so the user's
// real projects, settings and browser profile are never touched. claude is rc-suggest's
// stand-in (never the installed program).

// First: restarts this run on a desktop that is never shown (see hidden.mjs). Nothing may
// open a window on the user's screen; they use this PC while the tests run.
import { visibleRun } from "./hidden.mjs";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..");
export const E2E_ROOT = path.join(ROOT, ".cache-dev", "e2e");
export const FIXTURES = path.join(ROOT, "fixtures", "out");
const TARGET = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(ROOT, "target");
// ROUGHCUT_E2E_APP=<exe> runs the scenarios against another build of the app, for example the
// packaged dist-app/Roughcut/Roughcut.exe (npm run package).
export const APP_EXE = process.env.ROUGHCUT_E2E_APP ? path.resolve(process.env.ROUGHCUT_E2E_APP) : path.join(TARGET, "debug", "roughcut.exe");
const STANDIN_CLAUDE = path.join(TARGET, "debug", "rc-test-standin-claude.exe");
const RECORDED_CLAUDE = path.join(ROOT, "src-tauri", "crates", "rc-suggest", "tests", "data", "recorded", "success-150.stdout.txt");

/** Programs the core starts, plus the app itself: none may be left when a scenario ends. */
export const WATCHED_PROCESSES = ["roughcut.exe", "ffmpeg.exe", "ffprobe.exe", "transcriber.exe", "rc-test-standin-claude.exe"];

export class TestFailure extends Error {}

/** The transcriber's "ready" lines the core writes to its log: [{model, device, fallback}]. */
export function transcriberReady(log) {
  return [...log.matchAll(/roughcut: transcriber ready: model (.*), device (\w+), fallback (\w+)/g)].map((m) => ({
    model: m[1],
    device: m[2].toLowerCase(),
    fallback: m[3] === "true",
  }));
}

/** Fails the scenario with a message (and the details, as JSON, when given). */
export function fail(message, details) {
  throw new TestFailure(details === undefined ? message : `${message}\n${JSON.stringify(details, null, 2)}`);
}

export function check(cond, message, details) {
  if (!cond) fail(message, details);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The user's own copy of the app: the packaged folder (dist-app/) and what it starts from the
 * app's folders under the user's local application data. The user may be working in it while
 * the tests run, so those processes are never counted, refused over or killed, unless this run
 * is itself testing the packaged app (ROUGHCUT_E2E_APP pointing into dist-app/).
 */
const USER_APP_DIRS = [path.join(ROOT, "dist-app"), process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Roughcut") : null]
  .filter(Boolean)
  .map((d) => d.toLowerCase() + path.sep);
const TESTING_PACKAGED_APP = USER_APP_DIRS.some((d) => APP_EXE.toLowerCase().startsWith(d));

function executablePaths(pids) {
  // Only called when a watched name is running, so the usual case stays one quick tasklist.
  const paths = new Map();
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.Path)" }`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    for (const line of out.split(/\r?\n/)) {
      const i = line.indexOf("|");
      if (i > 0) paths.set(Number(line.slice(0, i)), line.slice(i + 1).trim());
    }
  } catch {
    /* they exited meanwhile */
  }
  return paths;
}

/** Image names of running processes from the watched list, with their pids (the user's own copy of the app left out). */
export function watchedProcesses() {
  const out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
  const found = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line);
    if (m && WATCHED_PROCESSES.includes(m[1].toLowerCase())) found.push({ name: m[1], pid: Number(m[2]) });
  }
  if (!found.length || TESTING_PACKAGED_APP) return found;
  const paths = executablePaths(found.map((f) => f.pid));
  return found.filter((f) => {
    const exe = (paths.get(f.pid) ?? "").toLowerCase();
    return !USER_APP_DIRS.some((d) => exe.startsWith(d));
  });
}

function findOnPath(exe) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return dir;
  }
  return null;
}

/** A fresh folder for one scenario run: data, cache, WebView2 profile, shots, log. */
export function freshRunDir(scenario, runId) {
  const dir = path.join(E2E_ROOT, runId, scenario);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const sub of ["data", "cache", "webview", "shots", "work"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}

// Posts WM_CLOSE to the app's own window (class "Tauri Window"), which is what the title bar's
// close button does. Not Process.CloseMainWindow: on the hidden desktop the process also hosts
// Windows' text-input indicator windows, and .NET picks one of those as the "main window".
const CLOSE_SCRIPT = String.raw`
param([int]$ProcId)
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class RcClose {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static int Close(uint pid) {
    int n = 0;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (p == pid && c.ToString() == "Tauri Window") { PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); n++; }
      return true; }, IntPtr.Zero);
    return n;
  }
}
"@
if ([RcClose]::Close([uint32]$ProcId) -eq 0) { exit 3 }
`;

let nextPort = 9400 + Math.floor(Math.random() * 300);

/**
 * One launch of the app. `start()` spawns it and connects; `close()` closes the window as a
 * user would (WM_CLOSE) and waits until the app and every child it started have exited.
 */
export class App {
  /**
   * `home`: a folder under the run folder for this launch's data, cache and WebView2 profile
   * (a launch that must start from nothing, after another launch in the same scenario).
   */
  /**
   * `bare`: start the app as a user would, with no ROUGHCUT_ variable but the data and cache
   * folders and ROUGHCUT_CLAUDE, so it finds FFmpeg, the transcriber and the speech model in
   * its default places. The folders that hold ffmpeg, ffprobe or the transcriber are taken off
   * PATH, so no program outside the app's own folders can be used. ROUGHCUT_CLAUDE stays: it
   * points at rc-suggest's stand-in, because the installed claude in %USERPROFILE%\.local\bin
   * is the first place the app looks and automated runs never call it. (Hiding it by pointing
   * USERPROFILE elsewhere stops WebView2 from opening its debugging port, so the harness could
   * not reach the page.)
   * `bare: "defaults"` leaves out the data and cache folders too: the user's real
   * %APPDATA%\Roughcut and %LOCALAPPDATA%\Roughcut\cache.
   */
  constructor(runDir, { log = console.log, env = {}, home, settings, bare = false, expectGpu } = {}) {
    this.runDir = runDir;
    this.bare = bare;
    this.home = home ? path.join(runDir, home) : runDir;
    for (const sub of ["data", "cache", "webview"]) fs.mkdirSync(path.join(this.home, sub), { recursive: true });
    // Settings the app reads at launch (for example `exportFolder`, so an export never lands in
    // the user's real Videos folder). Only written when there is no settings file yet.
    const settingsFile = path.join(this.home, "data", "settings.json");
    if (settings && !fs.existsSync(settingsFile)) fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    this.log = log;
    this.extraEnv = env;
    this.console = [];
    this.proc = null;
    this.browser = null;
    this.page = null;
    this.launchedAt = 0;
    this.logPaths = [];
    // A launch on the development GPU runtime (the harness's own transcriber and model folders,
    // device not forced to the processor) must transcribe on the GPU: a run that silently fell
    // back to the processor once hid a broken GPU runtime (see checkTranscriberDevice). A launch
    // that hides the GPU (CUDA_VISIBLE_DEVICES) or passes `expectGpu: false` is exempt.
    this.expectGpu =
      expectGpu ?? (!bare && !("ROUGHCUT_TRANSCRIBER_DIR" in env) && !("ROUGHCUT_MODEL_DIR" in env) && !("CUDA_VISIBLE_DEVICES" in env) && settings?.speechDevice !== "cpu");
  }

  /** Every "transcriber ready" line this App's launches wrote. */
  transcriberStarts() {
    return this.logPaths.flatMap((f) => (fs.existsSync(f) ? transcriberReady(fs.readFileSync(f, "utf8")) : []));
  }

  /**
   * Fails when a launch that should transcribe on the GPU (expectGpu) started a transcriber on
   * the processor or with a fallback. Returns the starts seen.
   */
  checkTranscriberDevice() {
    const starts = this.transcriberStarts();
    if (!this.expectGpu) return starts;
    const bad = starts.filter((r) => r.device !== "gpu" || r.fallback);
    check(bad.length === 0, `The transcriber did not run on the GPU in ${bad.length} of ${starts.length} starts (the development GPU runtime in .cache-dev/speech/dist/gpu may be broken; see npm run install-speech -- --check)`, bad);
    return starts;
  }

  get dataDir() {
    return path.join(this.home, "data");
  }
  get cacheDir() {
    return path.join(this.home, "cache");
  }

  async start({ timeoutMs = 30_000 } = {}) {
    check(fs.existsSync(APP_EXE), `The app is not built: ${APP_EXE} is missing (npm run tauri -- build --debug --no-bundle)`);
    check(fs.existsSync(path.join(path.dirname(APP_EXE), "WebView2Loader.dll")), "WebView2Loader.dll is not next to the app");
    check(fs.existsSync(STANDIN_CLAUDE), `The stand-in claude is not built: ${STANDIN_CLAUDE}`);
    const running = watchedProcesses();
    check(running.length === 0, "Processes from an earlier run are still alive; refusing to start a second copy", running);

    const ffmpegDir = findOnPath("ffmpeg.exe");
    check(ffmpegDir, "ffmpeg.exe is not on PATH (source tools/env.sh first)");
    this.port = nextPort++;
    const env = this.bare ? this.bareEnv() : {
      ...process.env,
      ROUGHCUT_DATA_DIR: this.dataDir,
      ROUGHCUT_CACHE_DIR: this.cacheDir,
      ROUGHCUT_FFMPEG_DIR: ffmpegDir,
      ROUGHCUT_TRANSCRIBER_DIR: path.join(ROOT, ".cache-dev", "speech", "dist", "gpu"),
      ROUGHCUT_MODEL_DIR: path.join(ROOT, ".cache-dev", "speech", "models"),
      ROUGHCUT_CLAUDE: STANDIN_CLAUDE,
      RC_STANDIN_REPLIES: `${RECORDED_CLAUDE}|0`,
      RC_STANDIN_LOG: path.join(this.runDir, "claude-calls.jsonl"),
      // "Show in folder" writes what it would open here instead of opening File Explorer
      // (exporting.mjs reads it); a visible run opens the real window.
      ...(visibleRun ? {} : { ROUGHCUT_TEST_REVEAL_LOG: path.join(this.runDir, "reveal.log") }),
      WEBVIEW2_USER_DATA_FOLDER: path.join(this.home, "webview"),
      // The last four keep the page drawing and its timers running although the window is on a
      // desktop nobody sees (Chromium would otherwise treat it as covered and slow it down).
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${this.port} --autoplay-policy=no-user-gesture-required --mute-audio --disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`,
      ...this.extraEnv,
    };
    // No test talks to GitHub or installs an update, unless a launch passes ROUGHCUT_NO_UPDATE: "".
    env.ROUGHCUT_NO_UPDATE ??= "1";
    // Never let a real API key reach the core (the stand-in reports API-key auth if it sees one).
    delete env.ANTHROPIC_API_KEY;
    const logPath = path.join(this.runDir, `app-${Date.now()}.log`);
    this.logPaths.push(logPath);
    const logFile = fs.openSync(logPath, "a");
    this.launchedAt = Date.now();
    this.proc = spawn(APP_EXE, [], { env, stdio: ["ignore", logFile, logFile], windowsHide: false });
    this.exited = new Promise((resolve) => this.proc.once("exit", (code) => resolve(code)));
    this.proc.once("exit", () => fs.closeSync(logFile));

    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
      if (this.proc.exitCode !== null) fail(`The app exited at launch with code ${this.proc.exitCode}`);
      try {
        this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.port}`, { timeout: 2000 });
        break;
      } catch (e) {
        lastErr = e;
        await sleep(200);
      }
    }
    check(this.browser, `Could not connect to the app's WebView2 on port ${this.port}: ${lastErr}`);
    while (Date.now() < deadline) {
      const pages = this.browser.contexts().flatMap((c) => c.pages());
      this.page = pages.find((p) => !p.url().startsWith("devtools:")) ?? null;
      if (this.page) break;
      await sleep(100);
    }
    check(this.page, "The app's page never appeared");
    this.page.on("console", (m) => {
      const entry = { at: Date.now() - this.launchedAt, type: m.type(), text: m.text() };
      this.console.push(entry);
      if (m.type() === "error" || m.type() === "warning") this.log(`  [console.${m.type()}] ${m.text()}`);
    });
    this.page.on("pageerror", (e) => {
      this.console.push({ at: Date.now() - this.launchedAt, type: "pageerror", text: String(e) });
      this.log(`  [pageerror] ${e}`);
    });
    await this.waitFor(() => window.__roughcut?.scenarioReady === true && window.__roughcut.getState().ready, null, {
      timeoutMs: Math.max(1000, deadline - Date.now()),
      label: "the store to load (window.__roughcut ready)",
    });
    const core = await this.page.evaluate(() => window.__roughcut.core);
    check(core === "tauri", `The app runs on the ${core} core, not the real one`);
    this.readyMs = Date.now() - this.launchedAt;
    return this;
  }

  /** The environment of a `bare` launch (see the constructor). */
  bareEnv() {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (/^(ROUGHCUT_|RC_STANDIN_|ANTHROPIC_|WEBVIEW2_)/i.test(k)) continue;
      env[k] = v;
    }
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const tools = ["ffmpeg.exe", "ffprobe.exe", "transcriber.exe"];
    env[pathKey] = (env[pathKey] ?? "")
      .split(path.delimiter)
      .filter((d) => d && !tools.some((t) => fs.existsSync(path.join(d, t))))
      .join(path.delimiter);
    return {
      ...env,
      ROUGHCUT_CLAUDE: STANDIN_CLAUDE,
      RC_STANDIN_REPLIES: `${RECORDED_CLAUDE}|0`,
      RC_STANDIN_LOG: path.join(this.runDir, "claude-calls.jsonl"),
      // bare: "defaults" leaves even these out: the app uses %APPDATA% and %LOCALAPPDATA%.
      ...(this.bare === "defaults" ? {} : { ROUGHCUT_DATA_DIR: this.dataDir, ROUGHCUT_CACHE_DIR: this.cacheDir }),
      WEBVIEW2_USER_DATA_FOLDER: path.join(this.home, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${this.port} --autoplay-policy=no-user-gesture-required --mute-audio --disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`,
      ...this.extraEnv,
    };
  }

  /** Runs `fn(arg)` in the page and returns its result. */
  eval(fn, arg) {
    return this.page.evaluate(fn, arg);
  }

  /** The store's state, reduced by `pick` (a function run in the page). */
  state(pick = (s) => s, arg) {
    return this.page.evaluate(
      ([src, a]) => {
        // eslint-disable-next-line no-new-func
        const f = new Function(`return (${src})`)();
        return f(window.__roughcut.getState(), a);
      },
      [pick.toString(), arg],
    );
  }

  dispatch(action, payload) {
    return this.page.evaluate(([a, p]) => window.__roughcut.dispatch(a, p), [action, payload]);
  }

  /**
   * Waits until `fn(arg)`, run in the page, returns something truthy; returns that value.
   * On time-out fails with `label` and the value of `describe` (run in the page) at that moment.
   */
  async waitFor(fn, arg, { timeoutMs = 10_000, label = "a condition", describe, pollMs = 50 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let v;
      try {
        v = await this.page.evaluate(fn, arg);
      } catch (e) {
        v = undefined;
        if (Date.now() >= deadline) fail(`Error while waiting for ${label}: ${e}`);
      }
      if (v) return v;
      if (Date.now() >= deadline) {
        const seen = describe ? await this.page.evaluate(describe, arg).catch((e) => String(e)) : undefined;
        await this.shot(`timeout-${label.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}`).catch(() => undefined);
        fail(`Timed out after ${timeoutMs} ms waiting for ${label}`, seen);
      }
      await sleep(pollMs);
    }
  }

  /** Waits for a store condition: `pred(state, arg)` is a function run in the page. */
  waitForState(pred, arg, opts = {}) {
    return this.waitFor(
      ([src, a]) => {
        const f = new Function(`return (${src})`)();
        return f(window.__roughcut.getState(), a);
      },
      [pred.toString(), arg, opts.describe ? opts.describe.toString() : null],
      {
        ...opts,
        // The page cannot see this closure: the describe function goes over as source text.
        describe: opts.describe
          ? ([, a, desc]) => {
              const f = new Function(`return (${desc})`)();
              return f(window.__roughcut.getState(), a);
            }
          : undefined,
      },
    );
  }

  /** Screenshot (PNG bytes) of the picture the player shows: the top video's displayed frame, letterbox removed. */
  async playerPicture() {
    const r = await this.page.evaluate(() => {
      const v = [...document.querySelectorAll("video[data-player-slot]")].find((x) => x.style.zIndex === "2");
      if (!v || !v.videoWidth) return null;
      const b = v.getBoundingClientRect();
      const s = Math.min(b.width / v.videoWidth, b.height / v.videoHeight);
      const w = v.videoWidth * s;
      const h = v.videoHeight * s;
      return { x: b.left + (b.width - w) / 2, y: b.top + (b.height - h) / 2, width: w, height: h };
    });
    if (!r) fail("No video is on top of the player");
    return this.page.screenshot({ clip: r });
  }

  /** Presses a chord the way the user would ("Space", "Control+Z", "Shift+ArrowRight", "?"). */
  async key(chord, { times = 1, delayMs = 0 } = {}) {
    for (let i = 0; i < times; i++) {
      await this.page.keyboard.press(chord);
      if (delayMs) await sleep(delayMs);
    }
  }

  /** Saves a screenshot of the window to shots/NN-name.png and returns its path. */
  async shot(name) {
    // Numbered across every launch in this scenario's folder.
    const n = fs.readdirSync(path.join(this.runDir, "shots")).length + 1;
    const file = path.join(this.runDir, "shots", `${String(n).padStart(2, "0")}-${name}.png`);
    await this.page.screenshot({ path: file });
    return file;
  }

  /** Console errors seen so far (and page errors). */
  consoleErrors() {
    return this.console.filter((c) => c.type === "error" || c.type === "pageerror");
  }

  /**
   * Closes the window as the user would (WM_CLOSE through CloseMainWindow), then waits for the
   * app and everything it started to exit. Fails when the app does not exit by itself.
   */
  async close({ timeoutMs = 20_000 } = {}) {
    if (!this.proc) return;
    const pid = this.proc.pid;
    if (this.proc.exitCode === null) {
      try {
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `& {${CLOSE_SCRIPT}} ${pid}`], { stdio: "ignore" });
      } catch {
        /* already gone */
      }
    }
    const code = await Promise.race([this.exited, sleep(timeoutMs).then(() => "timeout")]);
    try {
      await this.browser?.close();
    } catch {
      /* the app took its browser with it */
    }
    this.browser = null;
    this.page = null;
    this.proc = null;
    if (code === "timeout") {
      killAll();
      fail(`The app did not exit within ${timeoutMs} ms of closing its window`);
    }
    await this.assertNothingLeft();
    return code;
  }

  /**
   * Ends the app abruptly, as a crash or a power cut would: no close request, no chance to
   * save (TerminateProcess on the app and everything it started). Returns the time it died.
   */
  async kill() {
    if (!this.proc) return null;
    const pid = this.proc.pid;
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
    const at = Date.now();
    const code = await Promise.race([this.exited, sleep(10_000).then(() => "timeout")]);
    check(code !== "timeout", "The app did not die when killed");
    try {
      await this.browser?.close();
    } catch {
      /* the window went with the process */
    }
    this.browser = null;
    this.page = null;
    this.proc = null;
    killAll();
    await this.assertNothingLeft();
    return at;
  }

  /** Every child (FFmpeg, transcriber, claude) must be gone shortly after the app exits. */
  async assertNothingLeft(waitMs = 5000) {
    const deadline = Date.now() + waitMs;
    let left = watchedProcesses();
    while (left.length && Date.now() < deadline) {
      await sleep(200);
      left = watchedProcesses();
    }
    if (left.length) {
      killAll();
      fail("Processes were left running after the app exited", left);
    }
  }
}

/** Last resort: kill every watched process (used only after a failure). */
export function killAll() {
  for (const p of watchedProcesses()) {
    try {
      execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* gone */
    }
  }
}

/** Waits for a file to exist (and be non-empty). */
export async function waitForFile(file, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.statSync(file).size > 0) return;
    } catch {
      /* not yet */
    }
    await sleep(100);
  }
  fail(`Timed out waiting for ${label ?? file}`);
}
