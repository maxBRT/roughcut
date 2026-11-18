// Driving the Export dialog with its keys (spec 1.7 E, 1.10: Ctrl+E, Enter, Esc, C) and
// checking what Show in folder and Copy path did on the desktop.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { check, sleep } from "./app.mjs";
import { visibleRun } from "./hidden.mjs";
import { settle } from "./transcript.mjs";

/** Ctrl+E, then waits for the plan; returns {plan, folder, fileName, summary text}. */
export async function openExport(app) {
  await app.key("Control+e");
  const d = await app.waitForState((s) => (s.dialogs.export && !s.dialogs.export.planning && (s.dialogs.export.plan || s.dialogs.export.error) ? s.dialogs.export : null), null, {
    timeoutMs: 20_000,
    label: "the export plan",
    describe: (s) => s.dialogs.export,
  });
  await settle(app);
  const text = await app.eval(() => document.querySelector(".rcx-pane--a")?.innerText ?? "");
  return { ...d, text };
}

/**
 * Enter, then follows the export to its end, sampling progress and time left every 100 ms.
 * Returns {result, samples:[{ms, progress, secondsLeft, shown}], wallMs}.
 */
export async function runExport(app, { timeoutMs = 600_000, onRunning } = {}) {
  const t0 = Date.now();
  await app.key("Enter");
  const samples = [];
  let shotTaken = false;
  for (;;) {
    const s = await app.state((st) => {
      const d = st.dialogs.export;
      return d && { phase: d.phase, progress: d.progress, secondsLeft: d.secondsLeft, error: d.error, result: d.result };
    });
    check(s, "The export dialog closed while exporting");
    if (s.phase === "confirm" && s.error) return { error: s.error, samples, wallMs: Date.now() - t0 };
    if (s.phase === "running") {
      const shown = await app.eval(() => {
        const el = document.querySelector('.rcx-part[data-active="true"]');
        return el ? el.innerText.replace(/\s+/g, " ").trim() : null;
      });
      samples.push({ ms: Date.now() - t0, progress: s.progress, secondsLeft: s.secondsLeft, shown });
      if (!shotTaken && s.progress > 0.3) {
        shotTaken = true;
        await app.shot("export-running");
        if (onRunning) await onRunning();
      }
    }
    if (s.phase === "done") return { result: s.result, samples, wallMs: Date.now() - t0 };
    check(Date.now() - t0 < timeoutMs, `The export did not finish in ${timeoutMs} ms`, s);
    await sleep(100);
  }
}

/** File Explorer windows open now: their folder paths (lower case). */
export function explorerWindows() {
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "(New-Object -ComObject Shell.Application).Windows() | ForEach-Object { try { $_.Document.Folder.Self.Path } catch {} }"],
    { encoding: "utf8" },
  );
  return out.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean);
}

/**
 * The focused and selected items' paths in the Explorer window showing `folder`, or null when
 * none shows it. (On Windows 11, SelectedItems() over COM stays empty for a window opened with
 * /select; FocusedItem is the item /select named.)
 */
export function explorerSelection(folder) {
  const ps = `(New-Object -ComObject Shell.Application).Windows() | ForEach-Object { try { if ($_.Document.Folder.Self.Path -ieq '${folder.replace(/'/g, "''")}') { 'WINDOW'; $f = $_.Document.FocusedItem; if ($f) { $f.Path }; $_.Document.SelectedItems() | ForEach-Object { $_.Path } } } catch {} }`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.includes("WINDOW")) return null;
  return lines.filter((l) => l !== "WINDOW");
}

/** Closes the Explorer windows showing `folder` (the ones Show in folder opened). */
export function closeExplorer(folder) {
  const ps = `(New-Object -ComObject Shell.Application).Windows() | ForEach-Object { try { if ($_.Document.Folder.Self.Path -ieq '${folder.replace(/'/g, "''")}') { $_.Quit() } } catch {} }`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore" });
}

export function clipboardText() {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8" }).replace(/\r?\n$/, "");
}

export function setClipboardText(t) {
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Set-Clipboard -Value '${t.replace(/'/g, "''")}'`], { stdio: "ignore" });
}

/**
 * In the done stage: Enter (Show in folder) opens Explorer at the file, selected; returns what
 * was seen. A normal (hidden) run checks the File Explorer argument the app wrote to
 * reveal.log (ROUGHCUT_TEST_REVEAL_LOG) so no window opens on the user's screen; a visible run
 * (ROUGHCUT_E2E_VISIBLE=1) checks the real Explorer window.
 */
export async function checkShowInFolder(app, file) {
  if (!visibleRun) {
    const log = path.join(app.runDir, "reveal.log");
    const before = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean).length : 0;
    await app.key("Enter");
    let lines = [];
    for (let i = 0; i < 50 && lines.length <= before; i++) {
      await sleep(100);
      lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean) : [];
    }
    check(lines.length > before, "Show in folder did not ask File Explorer for anything", { log, lines });
    const last = lines[lines.length - 1];
    check(last.toLowerCase() === `/select,"${file}"`.toLowerCase(), "Show in folder asked File Explorer for the wrong thing", { last, file });
    return [file];
  }
  const folder = path.dirname(file);
  closeExplorer(folder);
  await app.key("Enter");
  let sel = null;
  for (let i = 0; i < 50 && !(sel && sel.length); i++) {
    await sleep(200);
    sel = explorerSelection(folder);
  }
  check(sel !== null, `Show in folder did not open an Explorer window at ${folder}`, { open: explorerWindows() });
  check(sel.some((p) => p.toLowerCase() === file.toLowerCase()), "Show in folder opened the folder but the file is not selected", { sel, file });
  closeExplorer(folder);
  return sel;
}

/** In the done stage: C (Copy path) puts the file's path on the clipboard. */
export async function checkCopyPath(app, file) {
  // The user's clipboard text is put back afterwards.
  let before = null;
  try {
    before = clipboardText();
  } catch {
    before = null;
  }
  setClipboardText("roughcut-e2e: not copied yet");
  try {
    await app.key("c");
    await app.waitForState((s) => s.dialogs.export?.copied === true, null, { label: "the path to be copied" });
    const clip = clipboardText();
    check(clip === file, `Copy path put "${clip}" on the clipboard, expected "${file}"`);
    return clip;
  } finally {
    if (before) setClipboardText(before);
  }
}
