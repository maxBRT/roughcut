// Measurement code that runs inside the app's page (WebView2).
//
// installAudioTap: must run before the player is made (that is, before the editor opens). It
//   catches the player's master gain when it is connected to the speakers and routes it through
//   a recorder and then a gain of 0, so nothing is played out loud during a test. The recorder
//   keeps the RMS level of every 128-sample block with its time on the performance.now clock.
// installFrameProbe: follows both <video data-player-slot> elements with their frame callbacks
//   (requestVideoFrameCallback) and, on every animation frame, records which element is on top
//   (z-index 2), the media time of the last frame it presented and whether it is the proxy or
//   the original.

export function installAudioTap() {
  if (window.__rcAudio) return;
  const rec = { blocks: [], masters: 0, contexts: [] };
  window.__rcAudio = rec;
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode && !this.__rcTap) {
      const ctx = this.context;
      const proc = ctx.createScriptProcessor(256, 2, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      const ctxIndex = rec.contexts.length;
      rec.contexts.push(ctx);
      proc.onaudioprocess = (e) => {
        const ts = ctx.getOutputTimestamp();
        // performance.now at the start of this buffer's playback
        const perf0 = ts.performanceTime + (e.playbackTime - ts.contextTime) * 1000;
        const a = e.inputBuffer.getChannelData(0);
        const b = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : a;
        const sr = e.inputBuffer.sampleRate;
        for (let o = 0; o < a.length; o += 128) {
          let s = 0;
          for (let i = o; i < o + 128 && i < a.length; i++) s += (a[i] * a[i] + b[i] * b[i]) / 2;
          rec.blocks.push([ctxIndex, perf0 + (o / sr) * 1000, Math.sqrt(s / 128)]);
        }
        if (rec.blocks.length > 400_000) rec.blocks.splice(0, 100_000);
      };
      origConnect.call(this, proc);
      origConnect.call(proc, mute);
      origConnect.call(mute, dest);
      this.__rcTap = true;
      rec.masters++;
      return dest;
    }
    return origConnect.call(this, dest, ...rest);
  };
}

export function installFrameProbe() {
  if (window.__rcFrames) return;
  const P = { samples: [], frames: [], attached: new WeakSet(), last: new Map(), on: true };
  window.__rcFrames = P;
  const kind = (src) => (src.includes("/proxy") ? "proxy" : src.includes("/original") ? "original" : src ? "other" : "none");
  const attach = (v) => {
    if (P.attached.has(v)) return;
    P.attached.add(v);
    const slot = Number(v.dataset.playerSlot);
    const cb = (now, md) => {
      P.last.set(slot, { mt: md.mediaTime, edt: md.expectedDisplayTime, now, src: kind(v.currentSrc || v.src), pf: md.presentedFrames });
      if (P.on) P.frames.push([slot, now, md.expectedDisplayTime, md.mediaTime, md.presentedFrames]);
      if (P.frames.length > 200_000) P.frames.splice(0, 50_000);
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  };
  const loop = (t) => {
    const vids = [...document.querySelectorAll("video[data-player-slot]")];
    vids.forEach(attach);
    const top = vids.find((v) => v.style.zIndex === "2");
    if (top && P.on) {
      const slot = Number(top.dataset.playerSlot);
      const l = P.last.get(slot);
      const st = window.__roughcut?.getState();
      P.samples.push([
        t,
        slot,
        l ? l.mt : null,
        kind(top.currentSrc || top.src),
        top.paused ? 0 : 1,
        st ? st.playhead.time : null,
        top.currentTime,
        top.style.opacity === "0" ? 0 : 1,
        (/\/media\/([^/]+)\//.exec(top.currentSrc || top.src) || [])[1] ?? null,
      ]);
      if (P.samples.length > 200_000) P.samples.splice(0, 50_000);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

/** Clears what the probes recorded (call right before a measured stretch). */
export function resetProbes() {
  if (window.__rcFrames) {
    window.__rcFrames.samples.length = 0;
    window.__rcFrames.frames.length = 0;
  }
  if (window.__rcAudio) window.__rcAudio.blocks.length = 0;
  return performance.now();
}

/** What the probes recorded since `since` (performance.now ms). */
export function readProbes(since) {
  const F = window.__rcFrames;
  const A = window.__rcAudio;
  return {
    now: performance.now(),
    samples: F ? F.samples.filter((s) => s[0] >= since) : [],
    frames: F ? F.frames.filter((f) => f[1] >= since) : [],
    audio: A ? A.blocks.filter((b) => b[1] >= since - 50) : [],
    masters: A ? A.masters : 0,
  };
}

/** The top video element now: slot, kind of address, currentTime, paused. */
export function topVideo() {
  const vids = [...document.querySelectorAll("video[data-player-slot]")];
  const top = vids.find((v) => v.style.zIndex === "2");
  if (!top) return null;
  const src = top.currentSrc || top.src;
  return {
    slot: Number(top.dataset.playerSlot),
    src: src.includes("/proxy") ? "proxy" : src.includes("/original") ? "original" : src ? "other" : "none",
    currentTime: top.currentTime,
    paused: top.paused,
    readyState: top.readyState,
    lastFrame: window.__rcFrames?.last.get(Number(top.dataset.playerSlot))?.mt ?? null,
    videos: vids.length,
  };
}
