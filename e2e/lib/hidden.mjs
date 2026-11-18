// Keeps every end-to-end run off the user's screen.
//
// Importing this module (lib/app.mjs does, first thing) restarts the current Node process on a
// separate Windows desktop that is never shown, and exits with that run's exit code. The app,
// its file dialogs, File Explorer windows and the helper scripts all inherit that desktop, so
// nothing appears on the user's screen and nothing takes the keyboard from the user.
//
// The restarted process sees ROUGHCUT_E2E_DESKTOP set and runs normally.
// To watch a run on the real screen instead, set ROUGHCUT_E2E_VISIBLE=1 (only when the user
// asks to watch; they use this PC while tests run).

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = "RoughcutE2E";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const source = path.join(here, "hidden-desktop.cs");
const launcher = path.join(root, ".cache-dev", "tools", "rc-hidden-desktop.exe");

function ensureLauncher() {
  if (fs.existsSync(launcher) && fs.statSync(launcher).mtimeMs >= fs.statSync(source).mtimeMs) return launcher;
  const windir = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  const csc = path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  if (!fs.existsSync(csc)) throw new Error(`Cannot build the hidden-desktop launcher: ${csc} is missing`);
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  // Built under a temporary name so two runs starting together never see half a file.
  const tmp = `${launcher}.${process.pid}.tmp.exe`;
  execFileSync(csc, ["/nologo", "/optimize+", "/platform:x64", "/target:exe", `/out:${tmp}`, source], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    fs.renameSync(tmp, launcher);
  } catch {
    fs.rmSync(tmp, { force: true }); // another run got there first
  }
  return launcher;
}

/** True when this process already runs on the hidden desktop (or was told to stay visible). */
export const onHiddenDesktop = process.env.ROUGHCUT_E2E_DESKTOP === DESKTOP;
export const visibleRun = process.env.ROUGHCUT_E2E_VISIBLE === "1";

if (process.platform === "win32" && !onHiddenDesktop && !visibleRun) {
  const exe = ensureLauncher();
  const r = spawnSync(exe, [DESKTOP, process.execPath, ...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, ROUGHCUT_E2E_DESKTOP: DESKTOP },
    windowsHide: true,
  });
  if (r.error) {
    console.error(`Could not restart on the hidden desktop: ${r.error.message}`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}
