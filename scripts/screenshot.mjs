#!/usr/bin/env node
/**
 * Takes one screenshot of a page with the installed Microsoft Edge (headless), through
 * playwright-core. It starts nothing itself: run `npm run dev` (or any server) first.
 *
 *   node scripts/screenshot.mjs <address> <out.png> [WIDTHxHEIGHT] [--wait MS] [--strict]
 *
 * - WIDTHxHEIGHT: the viewport, default 1440x900.
 * - --wait MS: extra time to wait after the page is ready (default 400).
 * - --strict: exit with code 2 when the page logged an error or threw.
 *
 * "Ready" means: the page loaded, and when the page is Roughcut, `window.__roughcut.scenarioReady`
 * is true (the address's scenario has been set up; see src/state/README.md), and the fonts
 * have loaded. Console errors, warnings and uncaught exceptions are printed to stderr.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node scripts/screenshot.mjs <address> <out.png> [WIDTHxHEIGHT] [--wait MS] [--strict]");
  process.exit(1);
}

const args = process.argv.slice(2);
const positional = [];
let waitMs = 400;
let strict = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--wait") {
    waitMs = Number(args[++i]);
    if (!Number.isFinite(waitMs) || waitMs < 0) usage("--wait needs a number of milliseconds");
  } else if (a === "--strict") strict = true;
  else if (a.startsWith("--")) usage(`unknown option ${a}`);
  else positional.push(a);
}
const [address, outArg, sizeArg = "1440x900"] = positional;
if (!address || !outArg) usage();
const size = /^(\d+)x(\d+)$/.exec(sizeArg);
if (!size) usage(`bad size ${sizeArg}: use WIDTHxHEIGHT, e.g. 1440x900`);
const viewport = { width: Number(size[1]), height: Number(size[2]) };
const out = resolve(outArg);
mkdirSync(dirname(out), { recursive: true });

const problems = [];
const browser = await chromium.launch({ channel: "msedge", headless: true });
let failed = false;
try {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (msg) => {
    const type = msg.type();
    const where = msg.location()?.url;
    if (type === "error" || type === "warning") problems.push(`console.${type}: ${msg.text()}${where ? ` (${where})` : ""}`);
  });
  page.on("pageerror", (err) => problems.push(`uncaught: ${err.message}`));
  await page.goto(address, { waitUntil: "load", timeout: 30_000 });
  // Roughcut tells when the address's scenario is set up; other pages are ready on load.
  await page
    .waitForFunction(
      () => {
        const rc = window.__roughcut;
        return rc === undefined ? document.readyState === "complete" : rc.scenarioReady === true;
      },
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => problems.push("not ready: window.__roughcut.scenarioReady stayed false for 15 s"));
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  if (waitMs > 0) await page.waitForTimeout(waitMs);
  await page.screenshot({ path: out });
  console.log(`${out} (${viewport.width}x${viewport.height})`);
} catch (e) {
  failed = true;
  console.error(`screenshot failed: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close();
}
for (const p of problems) console.error(p);
if (failed) process.exit(1);
if (strict && problems.some((p) => !p.startsWith("console.warning"))) process.exit(2);
