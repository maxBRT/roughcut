// Runs the player harness in a real Microsoft Edge window and prints the measurements.
//
//   source tools/env.sh && node src/player/harness/run.mjs [--tag NAME] [--rates 1,1.5,2]
//       [--sets one,mix] [--no-switch] [--timeout 900] [--headless]
//
// 1. Makes the second test source if missing: source B = source A from 60 s on (ffmpeg).
//    Source A is the experiment's media: .cache-dev/player/proxy_h264_8bit.mp4 (720p proxy)
//    and orig_h264_8bit.mp4 (4K original); every frame carries a 13-bit frame marker.
// 2. Builds the page (main.ts + the player) with Vite into target-tracks/player/harness-dist.
// 3. Starts server.mjs and an Edge window with a throwaway profile (the experiment's flags),
//    waits for results/<tag>_done.json, closes Edge and the servers, deletes the profile.
// 4. Prints the tables from analyze.mjs.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const TRACK = join(ROOT, "target-tracks", "player");
const DIST = join(TRACK, "harness-dist");
const MEDIA_DIR = join(TRACK, "harness-media");
const RESULTS = join(HERE, "results");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PAGE_PORT = 8771;
const MEDIA_PORT = 8772;

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const tag = opt("tag", `run${Date.now().toString(36)}`);
const timeoutS = Number(opt("timeout", "900"));
const query = new URLSearchParams({
  tag,
  rates: opt("rates", "1,1.5,2"),
  sets: opt("sets", "one,mix"),
  switch: args.includes("--no-switch") ? "0" : "1",
  media: `http://127.0.0.1:${MEDIA_PORT}`,
});

const A_PROXY = join(ROOT, ".cache-dev", "player", "proxy_h264_8bit.mp4");
const A_ORIG = join(ROOT, ".cache-dev", "player", "orig_h264_8bit.mp4");
const B_PROXY = join(MEDIA_DIR, "proxy_b.mp4");
for (const f of [A_PROXY, A_ORIG]) {
  if (!existsSync(f)) {
    console.error(`missing test media ${f}: run spikes/player/make_media.py first`);
    process.exit(1);
  }
}
if (!existsSync(B_PROXY)) {
  mkdirSync(MEDIA_DIR, { recursive: true });
  console.log("making source B (source A from 60 s, 60 s long) ...");
  const ff = spawnSync(
    "ffmpeg",
    ["-y", "-hide_banner", "-loglevel", "error", "-ss", "60", "-i", A_PROXY, "-t", "60", "-map", "0:v:0", "-map", "0:a:0",
      "-fps_mode", "cfr", "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "high",
      "-g", "15", "-keyint_min", "15", "-bf", "0", "-sc_threshold", "0", "-force_key_frames", "expr:gte(t,n_forced*0.5)",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000", "-movflags", "+faststart", B_PROXY],
    { stdio: "inherit" },
  );
  if (ff.status !== 0) {
    console.error("ffmpeg failed");
    process.exit(1);
  }
}

console.log("building the harness page ...");
const { build } = await import("vite");
await build({
  root: HERE,
  configFile: false,
  base: "./",
  logLevel: "warn",
  publicDir: false,
  build: { outDir: DIST, emptyOutDir: true, target: "es2022", sourcemap: true },
});

mkdirSync(RESULTS, { recursive: true });
const done = join(RESULTS, `${tag}_done.json`);
if (existsSync(done)) unlinkSync(done);
const mediaMap = JSON.stringify({ "A/proxy": A_PROXY, "A/original": A_ORIG, "B/proxy": B_PROXY });
const server = spawn(process.execPath, [join(HERE, "server.mjs"), DIST, RESULTS, mediaMap, String(PAGE_PORT), String(MEDIA_PORT)], {
  stdio: "inherit",
  env: { ...process.env, HARNESS_MEDIA_LOG: join(RESULTS, `${tag}_media.log`) },
});
await new Promise((r) => setTimeout(r, 800));

const profile = mkdtempSync(join(tmpdir(), "roughcut-player-edge-"));
const flags = [
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling", "--disable-features=msEdgeSidebarV2,EdgeCollections",
  "--window-size=1280,900", "--window-position=40,40",
];
if (args.includes("--headless")) flags.push("--headless=new");
const url = `http://127.0.0.1:${PAGE_PORT}/index.html?${query}`;
console.log(`opening Edge: ${url}`);
const edge = spawn(EDGE, [...flags, url], { stdio: "ignore" });

const t0 = Date.now();
let ok = false;
while ((Date.now() - t0) / 1000 < timeoutS) {
  if (existsSync(done) && statSync(done).size > 0) {
    ok = true;
    break;
  }
  if (server.exitCode !== null) {
    console.error("server exited early");
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}

spawnSync("taskkill", ["/T", "/F", "/PID", String(edge.pid)], { stdio: "ignore" });
spawnSync("powershell", ["-NoProfile", "-Command",
  `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${profile.split(/[\\/]/).pop()}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
  { stdio: "ignore" });
try {
  await fetch(`http://127.0.0.1:${PAGE_PORT}/quit`);
} catch {
  /* already gone */
}
server.kill();
await new Promise((r) => setTimeout(r, 1500));
rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });

console.log(ok ? `finished in ${Math.round((Date.now() - t0) / 1000)} s` : "TIMEOUT");
if (existsSync(done)) console.log(spawnSync("node", ["-e", `process.stdout.write(require('fs').readFileSync(${JSON.stringify(done)},'utf8'))`]).stdout.toString());
const an = spawnSync(process.execPath, [join(HERE, "analyze.mjs"), tag, RESULTS], { encoding: "utf8" });
process.stdout.write(an.stdout);
process.stderr.write(an.stderr);
process.exit(ok ? 0 : 1);
