// Memory of the app and the programs it started, sampled while a scenario runs.
//
// A window-less PowerShell loop walks the process tree under the app (roughcut.exe, its
// WebView2 processes, FFmpeg, the transcriber, claude) every `everyMs` and appends one JSON line
// per sample: private bytes (commit) and working set per process, plus the graphics card's
// memory in use (nvidia-smi). It ends by itself when the app exits; stop() ends it at once.

import { spawn } from "node:child_process";
import fs from "node:fs";

const SCRIPT = String.raw`
param([int]$Root, [string]$Out, [int]$EveryMs)
$ErrorActionPreference = 'SilentlyContinue'
$smi = (Get-Command nvidia-smi -ErrorAction SilentlyContinue).Source
while ($true) {
  if (-not (Get-Process -Id $Root -ErrorAction SilentlyContinue)) { break }
  $all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount
  $kids = @{}
  foreach ($p in $all) { $k = [int]$p.ParentProcessId; if (-not $kids.ContainsKey($k)) { $kids[$k] = New-Object System.Collections.ArrayList }; [void]$kids[$k].Add($p) }
  $tree = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  $rootProc = $all | Where-Object { $_.ProcessId -eq $Root }
  if ($rootProc) { $queue.Enqueue($rootProc) }
  while ($queue.Count -gt 0) {
    $p = $queue.Dequeue(); [void]$tree.Add($p)
    if ($kids.ContainsKey([int]$p.ProcessId)) { foreach ($c in $kids[[int]$p.ProcessId]) { if ($c.ProcessId -ne $p.ProcessId) { $queue.Enqueue($c) } } }
  }
  $procs = @($tree | ForEach-Object { @{ pid = [int]$_.ProcessId; name = $_.Name; priv = [int64]$_.PrivatePageCount; ws = [int64]$_.WorkingSetSize } })
  $gpu = $null; $gpuApps = $null
  if ($smi) {
    $gpu = (& $smi --query-gpu=memory.used --format=csv,noheader,nounits) -join ''
    $gpuApps = (& $smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits) -join ';'
  }
  $line = @{ t = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); procs = $procs; gpuUsedMiB = $gpu; gpuApps = $gpuApps } | ConvertTo-Json -Compress -Depth 4
  Add-Content -Path $Out -Value $line -Encoding UTF8
  Start-Sleep -Milliseconds $EveryMs
}
`;

/** Starts sampling the tree under `pid` into `file` (JSON lines). */
export function startMemorySampler(pid, file, everyMs = 2000) {
  fs.writeFileSync(file, "");
  const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `& {${SCRIPT}} ${pid} '${file.replace(/'/g, "''")}' ${everyMs}`], {
    stdio: "ignore",
    windowsHide: true,
  });
  return {
    stop() {
      try {
        ps.kill();
      } catch {
        /* gone */
      }
    },
    /** Samples from `fromMs` to `toMs` (epoch ms), each summarised by process kind. */
    read(fromMs = 0, toMs = Infinity) {
      const out = [];
      for (const line of fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
        if (!line.trim()) continue;
        let s;
        try {
          s = JSON.parse(line.replace(/^﻿/, ""));
        } catch {
          continue;
        }
        if (s.t < fromMs || s.t > toMs) continue;
        const procs = Array.isArray(s.procs) ? s.procs : s.procs ? [s.procs] : [];
        const kind = (n) => {
          n = n.toLowerCase();
          return n === "roughcut.exe" ? "app" : n.startsWith("msedgewebview2") ? "webview" : n.startsWith("ffmpeg") || n.startsWith("ffprobe") ? "ffmpeg" : n.startsWith("transcriber") ? "transcriber" : n.startsWith("claude") ? "claude" : "other";
        };
        const by = {};
        for (const p of procs) {
          const k = kind(p.name);
          by[k] ??= { priv: 0, ws: 0, n: 0 };
          by[k].priv += p.priv;
          by[k].ws += p.ws;
          by[k].n += 1;
        }
        const total = procs.reduce((a, p) => ({ priv: a.priv + p.priv, ws: a.ws + p.ws }), { priv: 0, ws: 0 });
        out.push({ t: s.t, by, total, gpuUsedMiB: Number(s.gpuUsedMiB) || null, gpuApps: s.gpuApps });
      }
      return out;
    },
  };
}

/** Peak and last values (MB) of a list of samples from read(). */
export function summariseMemory(samples) {
  const mb = (b) => Math.round(b / 1048576);
  if (!samples.length) return null;
  const peak = (f) => Math.max(...samples.map(f));
  const kinds = [...new Set(samples.flatMap((s) => Object.keys(s.by)))];
  const last = samples[samples.length - 1];
  return {
    samples: samples.length,
    peakTotalPrivateMB: mb(peak((s) => s.total.priv)),
    peakTotalWorkingSetMB: mb(peak((s) => s.total.ws)),
    lastTotalPrivateMB: mb(last.total.priv),
    peakByKindPrivateMB: Object.fromEntries(kinds.map((k) => [k, mb(peak((s) => s.by[k]?.priv ?? 0))])),
    peakByKindWorkingSetMB: Object.fromEntries(kinds.map((k) => [k, mb(peak((s) => s.by[k]?.ws ?? 0))])),
    peakGpuUsedMiB: Math.max(0, ...samples.map((s) => s.gpuUsedMiB ?? 0)) || null,
  };
}
