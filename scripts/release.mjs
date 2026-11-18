// Ships a new version: builds the installer, signs it for the in-app updater, pushes the code
// and publishes a GitHub release. Installed copies of the app then offer the update at their
// next start.
//
//   npm run release                       next patch version (0.1.4 -> 0.1.5)
//   npm run release -- minor              0.1.4 -> 0.2.0        (also: major, or an exact 1.2.3)
//   npm run release -- --notes "What changed"
//   npm run release -- --test             run the unit tests first (npm test)
//   npm run release -- --no-publish       build and sign only; nothing is committed or uploaded
//
// Run after sourcing tools/env.sh (or use release.ps1, which does that). Needs:
//   - the signing key made once with `tauri signer generate` (default: ~/.tauri/roughcut.key,
//     or ROUGHCUT_SIGNING_KEY=<file>). Keep it: without it installed copies cannot be updated.
//   - this PC signed in to GitHub for git (the token git already uses is read with
//     `git credential fill`; it is never printed or stored).
//
// What it does, in order: bumps the version (package.json, package-lock.json,
// src-tauri/tauri.conf.json), builds the app folder and the per-user installer
// (scripts/package.mjs --build --installer), writes latest.json for the updater, commits
// everything that changed, tags v<version>, pushes, creates the GitHub release and uploads the
// installer, its signature and latest.json.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(ROOT, "target");
const NSIS_DIR = path.join(TARGET, "release", "bundle", "nsis");
const TAURI_CONF = path.join(ROOT, "src-tauri", "tauri.conf.json");

const die = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};
const step = (message) => console.log(`\n== ${message}`);

/** Runs a program in the project folder, its output shown; stops the release if it fails. */
function run(program, args, options = {}) {
  const r = spawnSync(program, args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" && program === "npm", ...options });
  if (r.status !== 0) die(`${program} ${args.join(" ")} failed (exit ${r.status ?? r.signal})`);
}
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const gitOk = (...args) => spawnSync("git", args, { cwd: ROOT, stdio: "ignore" }).status === 0;

// ---------------------------------------------------------------- arguments

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  if (i + 1 >= args.length) die(`${name} needs a value`);
  return args[i + 1];
};
const notesArg = valueOf("--notes");
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--notes");
if (positional.length > 1) die(`one version at most, got: ${positional.join(" ")}`);
const publish = !flag("--no-publish");

const current = JSON.parse(fs.readFileSync(TAURI_CONF, "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(current)) die(`the version in src-tauri/tauri.conf.json is "${current}", expected three numbers`);

function nextVersion(from, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [major, minor, patch] = from.split(".").map(Number);
  if (how === "major") return `${major + 1}.0.0`;
  if (how === "minor") return `${major}.${minor + 1}.0`;
  if (how === "patch") return `${major}.${minor}.${patch + 1}`;
  die(`"${how}" is not a version: use patch, minor, major or an exact 1.2.3`);
}
const version = nextVersion(current, positional[0] ?? "patch");
const tag = `v${version}`;
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  return x[0] !== y[0] ? x[0] > y[0] : x[1] !== y[1] ? x[1] > y[1] : x[2] > y[2];
};

// ---------------------------------------------------------------- checks before anything changes

const keyFile = process.env.ROUGHCUT_SIGNING_KEY ?? path.join(os.homedir(), ".tauri", "roughcut.key");
if (!fs.existsSync(keyFile)) die(`the signing key ${keyFile} is missing (make one with: npm run tauri -- signer generate --ci -w "${keyFile}", and put its .pub text in src-tauri/tauri.conf.json)`);

let owner = null;
let repo = null;
let token = null;
if (publish) {
  if (!gitOk("rev-parse", "--git-dir")) die("this folder is not a git repository");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") die(`releases are made from main; this is ${branch}`);
  let remote;
  try {
    remote = git("remote", "get-url", "origin");
  } catch {
    die("there is no git remote named origin");
  }
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  if (!m) die(`origin (${remote}) is not a GitHub repository`);
  [, owner, repo] = m;
  if (gitOk("rev-parse", "-q", "--verify", `refs/tags/${tag}`)) die(`the tag ${tag} already exists`);
  if (!newer(version, current) && version !== current) die(`${version} is not newer than ${current}`);
  token = githubToken();
  if (!token) die("git has no stored sign-in for github.com (push once by hand, or sign in with Git Credential Manager)");
}

/** The token git itself uses for github.com (Git Credential Manager), without prompting. */
function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const r = spawnSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
    env: { ...process.env, GCM_INTERACTIVE: "never", GIT_TERMINAL_PROMPT: "0" },
  });
  return /^password=(.+)$/m.exec(r.stdout ?? "")?.[1]?.trim() ?? null;
}

async function github(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "roughcut-release",
      ...headers,
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) die(`GitHub said ${res.status} to ${method} ${url.replace(/\?.*/, "")}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------- version

step(`Roughcut ${current} -> ${version}${publish ? `, to github.com/${owner}/${repo}` : " (build only)"}`);
if (version !== current) {
  // tauri.conf.json decides the app's version (what the updater compares); the Rust crates keep
  // theirs, so a release does not rebuild every crate.
  fs.writeFileSync(TAURI_CONF, fs.readFileSync(TAURI_CONF, "utf8").replace(/("version":\s*")\d+\.\d+\.\d+(")/, `$1${version}$2`));
  run("npm", ["version", version, "--no-git-tag-version", "--allow-same-version"], { stdio: "ignore" });
}

if (flag("--test")) {
  step("Unit tests");
  run("npm", ["test"]);
}

// ---------------------------------------------------------------- build and sign

step("Build the app and the installer");
const setupName = `Roughcut_${version}_x64-setup.exe`;
const setup = path.join(NSIS_DIR, setupName);
const sig = `${setup}.sig`;
fs.rmSync(setup, { force: true });
fs.rmSync(sig, { force: true });
run("node", ["scripts/package.mjs", "--build", "--installer"], {
  env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: fs.readFileSync(keyFile, "utf8").trim(), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "" },
});
if (!fs.existsSync(setup)) die(`the installer ${setup} was not written`);
if (!fs.existsSync(sig)) die(`the installer was not signed (${sig} is missing): is "createUpdaterArtifacts" on in src-tauri/tauri.installer.conf.json?`);

const notes = notesArg ?? `Roughcut ${version}`;
const latest = path.join(NSIS_DIR, "latest.json");
fs.writeFileSync(
  latest,
  JSON.stringify(
    {
      version,
      notes,
      pub_date: new Date().toISOString(),
      platforms: {
        "windows-x86_64": {
          signature: fs.readFileSync(sig, "utf8").trim(),
          url: `https://github.com/${owner ?? "OWNER"}/${repo ?? "REPO"}/releases/download/${tag}/${setupName}`,
        },
      },
    },
    null,
    2,
  ),
);
const megabytes = (fs.statSync(setup).size / 1024 / 1024).toFixed(1);
console.log(`\nInstaller: ${setup} (${megabytes} MB), signed`);
if (!publish) {
  console.log("Not published (--no-publish). The version change is left in the working folder.");
  process.exit(0);
}

// ---------------------------------------------------------------- commit, tag, push

step("Commit, tag and push");
git("add", "-A");
if (!gitOk("diff", "--cached", "--quiet")) git("commit", "-m", `Release ${tag}`, "-m", notes);
git("tag", "-a", tag, "-m", `Roughcut ${version}`);
run("git", ["push", "origin", "main"]);
run("git", ["push", "origin", tag]);

// ---------------------------------------------------------------- the GitHub release

step("Publish the release");
const api = `https://api.github.com/repos/${owner}/${repo}`;
const release = await github(
  "POST",
  `${api}/releases`,
  JSON.stringify({
    tag_name: tag,
    name: `Roughcut ${version}`,
    body: `${notes}\n\n**Install:** download \`${setupName}\` below and run it (Windows 10 or 11, NVIDIA graphics card). It installs for your user only; no administrator rights. Installed copies update themselves from here.`,
    draft: true,
  }),
);
const uploads = release.upload_url.replace(/\{.*$/, "");
for (const [file, name, type] of [
  [setup, setupName, "application/octet-stream"],
  [sig, `${setupName}.sig`, "text/plain"],
  [latest, "latest.json", "application/json"],
]) {
  process.stdout.write(`  uploading ${name} ...`);
  await github("POST", `${uploads}?name=${encodeURIComponent(name)}`, fs.readFileSync(file), { "Content-Type": type });
  console.log(" done");
}
// Published only once every file is there, so no installed copy ever sees half a release.
const published = await github("PATCH", `${api}/releases/${release.id}`, JSON.stringify({ draft: false, make_latest: "true" }));

console.log(`\nReleased ${tag}: ${published.html_url}`);
console.log(`Download: https://github.com/${owner}/${repo}/releases/latest/download/${setupName}`);
