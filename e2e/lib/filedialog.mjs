// Drives the Windows file dialog the app opens (Ctrl+N, Ctrl+O, Locate file, the Export
// dialog's "change folder"), the way the user would answer it: the path put into the "File
// name" (or "Folder") box and Open (or Select Folder) pressed, or Cancel. It talks to the real
// dialog of the real app through its Win32 controls (the common dialog's fixed control ids:
// 1148 the name box, 1 Open, 2 Cancel), from Windows PowerShell; nothing in the page is replaced.

import { spawn } from "node:child_process";
import { fail } from "./app.mjs";

const SCRIPT = String.raw`
param([int]$ProcId, [string]$Answer, [string]$Mode, [int]$TimeoutMs)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RcDlg {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && Cls(h) == "#32770") { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  /** The Edit inside the control with this id (a ComboBoxEx32 / ComboBox), or the control itself. */
  public static IntPtr NameBox(IntPtr dlg) {
    IntPtr result = IntPtr.Zero;
    foreach (int id in new[] { 1148, 1152 }) {
      EnumChildWindows(dlg, (h, l) => {
        if (GetDlgCtrlID(h) == id) {
          if (Cls(h) == "Edit") { result = h; return false; }
          EnumChildWindows(h, (c, l2) => { if (Cls(c) == "Edit") { result = c; return false; } return true; }, IntPtr.Zero);
          if (result != IntPtr.Zero) return false;
        }
        return true; }, IntPtr.Zero);
      if (result != IntPtr.Zero) return result;
    }
    return result;
  }
  public static IntPtr Button(IntPtr dlg, int id) {
    IntPtr result = IntPtr.Zero;
    EnumChildWindows(dlg, (h, l) => { if (GetDlgCtrlID(h) == id && Cls(h) == "Button") { result = h; return false; } return true; }, IntPtr.Zero);
    return result;
  }
}
"@
$WM_SETTEXT = 0x000C; $BM_CLICK = 0x00F5
$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$dlg = [IntPtr]::Zero
while ((Get-Date) -lt $deadline -and $dlg -eq [IntPtr]::Zero) {
  $dlg = [RcDlg]::Find([uint32]$ProcId)
  if ($dlg -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 150 }
}
if ($dlg -eq [IntPtr]::Zero) { Write-Output 'NO_DIALOG|'; exit 3 }
$title = [RcDlg]::Title($dlg)
if ($Mode -eq 'cancel') {
  $c = [IntPtr]::Zero
  while ($c -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) { $c = [RcDlg]::Button($dlg, 2); if ($c -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 150 } }
  [void][RcDlg]::PostMessage($c, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
  Write-Output "CANCELLED|$title"; exit 0
}
$edit = [IntPtr]::Zero
while ($edit -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
  $edit = [RcDlg]::NameBox($dlg)
  if ($edit -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 150 }
}
if ($edit -eq [IntPtr]::Zero) { Write-Output "NO_NAME_BOX|$title"; exit 4 }
Start-Sleep -Milliseconds 200
[void][RcDlg]::SendMessage($edit, $WM_SETTEXT, [IntPtr]::Zero, $Answer)
$ok = [RcDlg]::Button($dlg, 1)
if ($ok -eq [IntPtr]::Zero) { Write-Output "NO_OPEN_BUTTON|$title"; exit 5 }
# Posted, not sent: the click runs the dialog's own loop, which must not wait on this script.
[void][RcDlg]::PostMessage($ok, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
# A folder picker given a folder may first navigate into it; press again until it closes.
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 300
  if (-not [RcDlg]::IsWindow($dlg)) { Write-Output "ANSWERED|$title"; exit 0 }
  if ($i % 3 -eq 2) {
    [void][RcDlg]::SendMessage([RcDlg]::NameBox($dlg), $WM_SETTEXT, [IntPtr]::Zero, $Answer)
    [void][RcDlg]::PostMessage([RcDlg]::Button($dlg, 1), $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
  }
}
$b = [RcDlg]::Button($dlg, 2); if ($b -ne [IntPtr]::Zero) { [void][RcDlg]::PostMessage($b, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) }
Write-Output "STILL_OPEN|$title"; exit 6
`;

function runScript(args, timeoutMs) {
  return new Promise((resolve) => {
    const ps = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `& {${SCRIPT}} ${args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(" ")}`],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let out = "";
    let err = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => ps.kill(), timeoutMs + 15_000);
    ps.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
  });
}

/**
 * Starts waiting for the app's file dialog and answers it with `answer` (a file or folder path),
 * or presses Cancel when `answer` is null. Returns a promise for the dialog's title. Call it
 * BEFORE pressing the key that opens the dialog, and await it afterwards.
 */
export function answerFileDialog(app, answer, { timeoutMs = 15_000 } = {}) {
  const pid = app.proc?.pid;
  if (!pid) fail("The app is not running, so no file dialog can be answered");
  return runScript([pid, answer ?? "", answer === null ? "cancel" : "answer", timeoutMs], timeoutMs).then((r) => {
    const [status, title] = (r.out.split(/\r?\n/).pop() ?? "").split("|");
    if (r.code !== 0 || (status !== "ANSWERED" && status !== "CANCELLED")) {
      fail(`The file dialog could not be answered (${r.out || "no output"})`, { code: r.code, stderr: r.err.slice(0, 2000) });
    }
    return title ?? "";
  });
}
