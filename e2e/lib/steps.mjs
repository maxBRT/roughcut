// Steps several scenarios share.

import { check, sleep } from "./app.mjs";

/** Drops `files` on the window (what the drop handler does) and waits for the editor. */
export async function dropFiles(app, files) {
  const t0 = Date.now();
  const before = await app.state((s) => (s.project ? s.project.sources.length : 0));
  await app.dispatch("ui.dropFiles", { paths: files });
  await app.waitForState((s, n) => s.screen === "editor" && s.project && s.project.sources.length >= n, before + files.length, {
    timeoutMs: 15_000,
    label: "the dropped files to be in the open project",
  });
  return Date.now() - t0;
}

/** Waits until a source has no queued or running job and its proxy, waveform and transcript are done. */
export async function waitImported(app, sourceId, timeoutMs = 180_000) {
  return app.waitForState(
    (s, id) => {
      const jobs = Object.values(s.jobs).filter((j) => j.sourceId === id);
      if (jobs.some((j) => j.state === "queued" || j.state === "running")) return null;
      const a = s.sources[id]?.assets;
      if (!a || a.playback !== "proxy" || !a.waveformUrl || a.transcript !== "complete") return null;
      return { jobs: jobs.map((j) => `${j.kind}:${j.state}`), assets: a };
    },
    sourceId,
    {
      timeoutMs,
      label: `source ${sourceId} to finish importing`,
      describe: (s, id) => ({ jobs: Object.values(s.jobs).filter((j) => j.sourceId === id), assets: s.sources[id]?.assets }),
    },
  );
}

/**
 * Seeks the player to a sequence time (as a click on the timeline does: `ui.seek`) and
 * waits until it is paused there with the right frame on screen.
 */
export async function seekTo(app, time, { fps = 30 } = {}) {
  await app.dispatch("ui.seek", { time });
  return waitShown(app, time, fps);
}

/** Waits until the playhead is at `time` and the top video shows the frame at that time. */
export async function waitShown(app, time, fps = 30, timeoutMs = 5000) {
  return app.waitFor(
    ([t, f]) => {
      const st = window.__roughcut.getState();
      const pos = st.playhead.position;
      // Sequence times after a cut sit up to 1 µs per cut below the frame grid.
      if (Math.abs(st.playhead.time - t) > 50 || !pos) return null;
      const vids = [...document.querySelectorAll("video[data-player-slot]")];
      const top = vids.find((v) => v.style.zIndex === "2");
      if (!top || top.seeking) return null;
      const shown = window.__rcFrames?.last.get(Number(top.dataset.playerSlot))?.mt;
      const want = pos.at / 1e6;
      // The frame on screen is the one holding the playhead's source moment.
      const ok = shown !== undefined && shown <= want + 0.002 && shown > want - 1 / f + 0.002;
      return ok ? { shown, want, ct: top.currentTime } : null;
    },
    [time, fps],
    {
      timeoutMs,
      label: `the frame at ${time} µs on screen`,
      describe: ([t]) => {
        const st = window.__roughcut.getState();
        const vids = [...document.querySelectorAll("video[data-player-slot]")];
        const top = vids.find((v) => v.style.zIndex === "2");
        return {
          want: t,
          playhead: st.playhead,
          top: top && { ct: top.currentTime, seeking: top.seeking, last: window.__rcFrames?.last.get(Number(top.dataset.playerSlot)) },
        };
      },
    },
  );
}

/** Presses Space and waits for the store to say playing (or not). */
export async function setPlaying(app, playing) {
  const now = await app.state((s) => s.playhead.playing);
  if (now !== playing) await app.key("Space");
  await app.waitForState((s, p) => s.playhead.playing === p, playing, { timeoutMs: 3000, label: playing ? "playback" : "pause" });
}

/** Waits for the autosave to have written everything (no pending or running save). */
export async function waitSaved(app, timeoutMs = 10_000) {
  await sleep(50);
  await app.waitForState((s) => !s.save.pending && !s.save.saving && s.save.lastSavedAt !== null && !s.save.error, null, {
    timeoutMs,
    label: "the autosave",
    describe: (s) => s.save,
  });
}

export function assertClose(actual, expected, tol, what) {
  check(Math.abs(actual - expected) <= tol, `${what}: ${actual}, expected ${expected} ± ${tol}`);
}
