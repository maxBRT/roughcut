// Proves the self-update end to end, on the hidden desktop: starts the INSTALLED app (which
// must be older than the latest GitHub release), waits for the update notice, presses its
// button, and checks that the app comes back as the new version.
//
//   node e2e/manual/check-update.mjs
//
// Not part of npm run e2e: it needs a real installed copy and a newer published release, it
// talks to GitHub, and it really updates the installed app. Run after sourcing tools/env.sh.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const installed = path.join(process.env.LOCALAPPDATA, "Roughcut", "roughcut.exe");
if (!fs.existsSync(installed)) {
  console.error(`The app is not installed (${installed} is missing)`);
  process.exit(2);
}
// Before lib/app.mjs is loaded: it reads this to decide which exe to start.
process.env.ROUGHCUT_E2E_APP = installed;
const { App, check, freshRunDir, killAll, sleep } = await import("../lib/app.mjs");

const fileVersion = () =>
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Item '${installed}').VersionInfo.ProductVersion`], { encoding: "utf8" }).trim();
const appVersion = (page) => page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:app|version"));

const runDir = freshRunDir("check-update", "manual");
const before = fileVersion();
console.log(`installed before: ${before}`);

// Updates allowed for this one launch (every other test launch has them switched off).
const app = new App(runDir, { env: { ROUGHCUT_NO_UPDATE: "" }, expectGpu: false });
let failed = null;
try {
  await app.start();
  const running = await appVersion(app.page);
  console.log(`running: ${running} (port ${app.port})`);

  const notice = await app.waitForState((s) => s.notices.find((n) => n.id === "update") ?? null, null, {
    timeoutMs: 30_000,
    label: "the update notice",
    describe: (s) => s.notices,
  });
  console.log(`notice: "${notice.text}" [${notice.retry?.label}]`);
  check(notice.retry?.action === "ui.installUpdate", "The update notice has no install button", notice);
  console.log(`screenshot: ${await app.shot("update-notice")}`);

  // The button: the app downloads the installer, runs it and exits; the installer starts the
  // new version, which inherits this launch's environment (same folders, same debugging port).
  const exited = app.exited;
  app.page.evaluate(() => void window.__roughcut.dispatch("ui.installUpdate")).catch(() => undefined);
  const code = await Promise.race([exited, sleep(300_000).then(() => "timeout")]);
  check(code !== "timeout", "The app did not exit to install the update within 5 minutes", await app.state((s) => s.notices).catch(() => null));
  console.log(`the old version exited (code ${code}); waiting for the new one`);
  await app.browser?.close().catch(() => undefined);

  let browser = null;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && !browser) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${app.port}`, { timeout: 2000 }).catch(() => null);
    if (!browser) await sleep(500);
  }
  check(browser, "The new version did not start after the update (nothing answered on the debugging port)");
  let page = null;
  while (Date.now() < deadline && !page) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools:")) ?? null;
    if (!page) await sleep(200);
  }
  check(page, "The new version has no page");
  await page.waitForFunction(() => window.__roughcut?.getState().ready === true, null, { timeout: 30_000 });
  const after = await appVersion(page);
  const stillOffered = await page.evaluate(() => window.__roughcut.getState().notices.some((n) => n.id === "update"));
  await page.screenshot({ path: path.join(runDir, "shots", "after-update.png") });
  console.log(`running after the update: ${after}; file version ${fileVersion()}; update still offered: ${stillOffered}`);
  check(after !== running, `The app restarted but is still version ${after}`);
  check(notice.text.includes(after), `The notice offered "${notice.text}" but the app is now ${after}`);
  check(!stillOffered, "The new version still offers an update");
  await browser.close().catch(() => undefined);
  console.log(`PASS: ${running} updated itself to ${after}`);
} catch (e) {
  failed = e;
  console.error(`FAIL: ${e.message ?? e}`);
} finally {
  killAll();
}
process.exit(failed ? 1 : 0);
