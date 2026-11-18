// Helpers for the edge-case scenarios (spec 1.12): one record per situation, what the spec
// says, what happened, pass or fail. A scenario goes through all its rows, then fails if any
// row failed, so one run gives the whole table.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TestFailure, fail } from "./app.mjs";

/** A table of rows for `ctx.result.rows`. */
export function rowTable(ctx) {
  const rows = (ctx.result.rows ??= []);
  return {
    rows,
    /** Runs one row; `fn` returns what happened (a short text). A failure is recorded, not thrown. */
    async row(situation, spec, fn) {
      const t0 = Date.now();
      let happened;
      let pass = true;
      try {
        happened = await fn();
      } catch (e) {
        pass = false;
        happened = e instanceof TestFailure ? e.message : String(e.stack ?? e);
      }
      rows.push({ situation, spec, happened, pass, ms: Date.now() - t0 });
      ctx.log(`  ${pass ? "PASS" : "FAIL"} [${situation}] ${String(happened).split("\n")[0].slice(0, 300)}`);
      return pass;
    },
    /** Fails the scenario when any row failed. */
    finish() {
      const bad = rows.filter((r) => !r.pass);
      if (bad.length) fail(`${bad.length} of ${rows.length} row(s) failed:\n${bad.map((r) => `- ${r.situation}: ${r.happened}`).join("\n")}`);
    },
  };
}

/** ffmpeg with the given arguments (errors only). */
export function ffmpeg(args) {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
}

/** Copies the picture of `src` without its sound (stream copy). */
export function withoutSound(src, out) {
  ffmpeg(["-i", src, "-map", "0:v", "-c", "copy", "-an", out]);
  return out;
}

/** A folder whose files are hard links to every file under `from` (no copy, no space). */
export function linkTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) linkTree(a, b);
    else if (!fs.existsSync(b)) {
      try {
        fs.linkSync(a, b);
      } catch {
        fs.copyFileSync(a, b);
      }
    }
  }
  return to;
}

/** The visible text of the window, whitespace folded. */
export function screenText(app) {
  return app.eval(() => document.body.innerText.replace(/\s+/g, " "));
}

/** Notice texts in the store. */
export function noticeTexts(app) {
  return app.state((s) => s.notices.map((n) => `${n.kind}: ${n.text}`));
}

/** Folder size in bytes (recursive). */
export function dirBytes(dir) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
  }
  return n;
}
