// Roughcut player spike: a sequence player that crosses cuts with two stacked <video> elements.
// Spec 2.4.3 / 3.5.3. Read RESULT.md next to this file for the measured behaviour.
//
// Model: a sequence is a list of clips {src, start, end}; start/end are FRAME indices in the source
// (end exclusive). The app stores microseconds; frame = Math.round(us * fps / 1e6) on the frame grid.
//
// Technique in one paragraph:
//   Two <video> elements are stacked in the same box. The one on top (z-index 2) plays the current
//   clip. The one underneath is paused on the first frame of the next clip ("prepared"). Each frame
//   callback (requestVideoFrameCallback) of the playing element gives the exact media time of the
//   frame just presented and the time it is expected on screen; from that we compute the moment the
//   clip's last frame should leave the screen ("swap target"). A requestAnimationFrame loop applies the
//   swap in the main frame that will be displayed at that target: z-index flip, play() on the
//   incoming element, a few-millisecond gain ramp in Web Audio (out 1->0, in 0->1), then the outgoing
//   element is paused and re-prepared for the clip after next.

const HIDDEN = 1, SHOWN = 2;

export class SequencePlayer {
  /**
   * @param {HTMLElement} stage  positioned container; two <video> are created inside
   * @param {object} opts
   *   fps            sequence frame rate (30)
   *   rampMs         audio ramp on each side of a cut (5)
   *   swapLead       when to apply the swap, in display refreshes before the target (2)
   *   watchdogMs     report a prepare (seek) that has not landed after this long (400)
   *   watchdogRetry  re-issue such a seek (did NOT help in the spike; off)
   *   onFrame        ({seqFrame, clipIndex, srcFrame, playing}) on every displayed frame
   *   onEvent        (name, detail) for measurement: 'swap', 'stall', 'ready', ...
   */
  constructor(stage, opts = {}) {
    this.fps = opts.fps || 30;
    this.rampMs = opts.rampMs ?? 5;
    // Measured at 144 Hz: lead 1 shows the outgoing clip's next frame for one refresh at ~2% of cuts;
    // lead 2 never did, and shortens the clip's last frame by ~1 refresh (6-10 ms). See RESULT.md.
    this.swapLead = opts.swapLead ?? 2;
    this.watchdogMs = opts.watchdogMs ?? 400;
    this.watchdogRetry = opts.watchdogRetry ?? false;
    this.onFrame = opts.onFrame || (() => {});
    this.onEvent = opts.onEvent || (() => {});
    this.clips = [];
    this.seqStart = [];            // sequence frame at which each clip starts
    this.rate = 1;
    this.playing = false;
    this.shuttling = false;

    this.els = [0, 1].map(i => {
      const v = document.createElement('video');
      v.preload = 'auto';
      v.playsInline = true;
      v.disablePictureInPicture = true;
      v.preservesPitch = true;   // the default in Chromium; set explicitly for clarity
      v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;background:#000;object-fit:contain';
      v.style.zIndex = String(i === 0 ? SHOWN : HIDDEN);
      stage.appendChild(v);
      for (const name of ['waiting', 'stalled']) v.addEventListener(name, () => this.onEvent(name, { slot: i }));
      return v;
    });
    this.slot = this.els.map(() => ({ clip: -1, frame: -1, ready: false, token: 0, readyPromise: null }));
    this.cur = 0;                  // index of the element on top
    this.ci = 0;                   // current clip index
    this.seqFrame = 0;             // last displayed sequence frame
    this.swapTarget = null;        // performance.now() time at which the current clip's last frame ends
    this.stalled = false;
    this.vsync = 1000 / 60;        // refined from rAF deltas
    this._lastRaf = 0;
    this._rvfcToken = 0;

    // Web Audio: element -> per-element gain -> master -> speakers. The gains carry the cut ramps.
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.gains = this.els.map(el => {
      const g = this.ctx.createGain();
      g.gain.value = 0;
      this.ctx.createMediaElementSource(el).connect(g);
      g.connect(this.master);
      return g;
    });

    const raf = (t) => { this._tick(t); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
  }

  get visible() { return this.els[this.cur]; }
  get hidden() { return this.els[1 - this.cur]; }
  get duration() { return this.seqStart.length ? this.seqStart.at(-1) + this._len(this.clips.length - 1) : 0; }
  _len(i) { return this.clips[i].end - this.clips[i].start; }

  // ---- Load: clips + playback addresses. Keeps the sequence position.
  async load(clips) {
    const keep = this.seqFrame;
    this.clips = clips.map(c => ({ ...c }));
    let acc = 0;
    this.seqStart = this.clips.map(c => { const s = acc; acc += c.end - c.start; return s; });
    await this.seek(Math.min(keep, Math.max(0, this.duration - 1)));
  }

  locate(seqFrame) {
    // binary search: last clip whose seqStart <= seqFrame
    let lo = 0, hi = this.clips.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.seqStart[mid] <= seqFrame) lo = mid; else hi = mid - 1; }
    return { ci: lo, srcFrame: this.clips[lo].start + (seqFrame - this.seqStart[lo]) };
  }

  // ---- Prepare an element: load the clip's source and park it, paused, on `frame`.
  _prepare(slotIdx, ci, frame) {
    const el = this.els[slotIdx], s = this.slot[slotIdx], clip = this.clips[ci];
    if (s.clip === ci && s.frame === frame && s.readyPromise) return s.readyPromise;
    const token = ++s.token;
    if (s.resolve) s.resolve(false);          // release anyone waiting on the superseded prepare
    Object.assign(s, { clip: ci, frame, ready: false });
    const t0 = performance.now();
    s.readyPromise = new Promise(resolve => {
      s.resolve = resolve;
      const url = new URL(clip.src, location.href).href;
      if (el.src !== url) el.src = url;
      if (!el.paused) el.pause();
      // Park 1 ms after the frame's start time. Exactly k/fps can round down into frame k-1;
      // the middle of the frame (k+0.5)/fps lands on the right frame but then play() runs the
      // first frame for only half its duration (measured: 14 ms instead of 33 ms at 1x).
      el.currentTime = frame / this.fps + 0.001;
      const done = () => {
        if (s.token !== token) return;          // superseded by a newer prepare
        s.ready = true;
        s.resolve = null;
        this.onEvent('ready', { slot: slotIdx, ci, frame, ms: performance.now() - t0 });
        resolve(true);
      };
      // 'seeked' fires in Chromium once the pipeline has prerolled the target frame.
      el.addEventListener('seeked', done, { once: true });
      // Watchdog: a seek that has not landed after `watchdogMs` is issued again (see RESULT.md).
      const kick = (n) => setTimeout(() => {
        if (s.token !== token || s.ready) return;
        const b = el.buffered, ranges = [];
        for (let i = 0; i < b.length; i++) ranges.push([+b.start(i).toFixed(2), +b.end(i).toFixed(2)]);
        this.onEvent('slowPrepare', { slot: slotIdx, ci, frame, n, readyState: el.readyState,
          networkState: el.networkState, seeking: el.seeking, buffered: ranges, retry: this.watchdogRetry });
        if (this.watchdogRetry) el.currentTime = frame / this.fps + 0.001;
        if (n < 20) kick(n + 1);
      }, this.watchdogMs);
      kick(1);
    });
    return s.readyPromise;
  }

  // ---- Transport
  async play() {
    if (this.playing || !this.clips.length) return;
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this.stopShuttle();
    if (this.seqFrame >= this.duration - 1) await this.seek(0);
    this.playing = true;
    const s = this.slot[this.cur];
    await s.readyPromise;
    this._rampIn(this.cur);
    this.visible.playbackRate = this.rate;
    this._watch(this.cur);
    await this.visible.play();
    this._prepareNext();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.swapTarget = null;
    this._rampOut(this.cur);
    const el = this.visible;
    setTimeout(() => { if (!this.playing) el.pause(); }, this.rampMs + 2);
  }

  setRate(r) {
    this.rate = r;
    for (const el of this.els) el.playbackRate = r;
  }

  /** Seek to a sequence frame. Resolves when that frame is on screen. */
  async seek(seqFrame) {
    seqFrame = Math.max(0, Math.min(Math.round(seqFrame), this.duration - 1));
    const wasPlaying = this.playing;
    if (wasPlaying) { this.playing = false; this.visible.pause(); this._rampOut(this.cur, 0); }
    this.swapTarget = null;
    const { ci, srcFrame } = this.locate(seqFrame);
    // If the hidden element already holds exactly this frame, show it: instant.
    const h = this.slot[1 - this.cur];
    let target = this.cur;
    if (h.clip === ci && h.frame === srcFrame) target = 1 - this.cur;
    await this._prepare(target, ci, srcFrame);
    if (target !== this.cur) this._show(target);
    this.ci = ci;
    this.seqFrame = seqFrame;
    this.onFrame({ seqFrame, clipIndex: ci, srcFrame, playing: wasPlaying });
    if (wasPlaying) { await this.play(); } else { this._prepareNext(); }
  }

  /** Step by n frames (negative = backwards). Pauses first. */
  async step(n) {
    if (this.playing) this.pause();
    return this.seek(this.seqFrame + n);
  }

  /** Silent backwards play: rapid backward seeks, paced to `rate` x real time. */
  async shuttleBack(rate = 1) {
    if (this.playing) this.pause();
    this.shuttling = true;
    this.master.gain.value = 0;
    const startFrame = this.seqFrame, t0 = performance.now();
    let shown = 0;
    while (this.shuttling) {
      const elapsed = (performance.now() - t0) / 1000;
      const target = Math.max(0, startFrame - Math.round(elapsed * this.fps * rate));
      if (target !== this.seqFrame) { await this.seek(target); shown++; }
      else await new Promise(r => requestAnimationFrame(r));
      if (target === 0) break;
    }
    this.shuttling = false;
    this.master.gain.value = 1;
    return { shown, seconds: (performance.now() - t0) / 1000 };
  }
  stopShuttle() { this.shuttling = false; this.master.gain.value = 1; }

  // ---- Internals

  _show(slotIdx) {
    this.els[slotIdx].style.zIndex = String(SHOWN);
    this.els[1 - slotIdx].style.zIndex = String(HIDDEN);
    this.cur = slotIdx;
  }

  _prepareNext() {
    const next = this.ci + 1;
    if (next < this.clips.length) this._prepare(1 - this.cur, next, this.clips[next].start);
  }

  _rampIn(slotIdx, ms = this.rampMs) {
    const g = this.gains[slotIdx].gain, t = this.ctx.currentTime;
    g.cancelScheduledValues(t); g.setValueAtTime(0, t); g.linearRampToValueAtTime(1, t + ms / 1000);
  }
  _rampOut(slotIdx, ms = this.rampMs) {
    const g = this.gains[slotIdx].gain, t = this.ctx.currentTime;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + Math.max(ms, 0.5) / 1000);
  }

  // Frame callbacks of the playing element: report position, compute the swap target.
  _watch(slotIdx) {
    const token = ++this._rvfcToken, el = this.els[slotIdx];
    const cb = (now, md) => {
      if (token !== this._rvfcToken || !this.playing) return;
      const clip = this.clips[this.ci];
      const f = Math.round(md.mediaTime * this.fps);
      if (f >= clip.start && f < clip.end) {
        this.seqFrame = this.seqStart[this.ci] + (f - clip.start);
        this.onFrame({ seqFrame: this.seqFrame, clipIndex: this.ci, srcFrame: f, playing: true });
      }
      // Time at which frame `clip.end` (the first frame NOT in the clip) would appear.
      const frameMs = 1000 / this.fps / this.rate;
      this.swapTarget = md.expectedDisplayTime + (clip.end - f) * frameMs;
      if (f >= clip.end - 1 && !this.slot[1 - this.cur].ready && this.ci + 1 < this.clips.length) {
        // Next clip is not prepared in time (very short clip): freeze on the last frame.
        el.pause();
        this.stalled = true;
        this.onEvent('stall', { ci: this.ci, at: performance.now() });
      }
      if (f >= clip.end) this._cut();   // overshoot: we are late, cut now
      else el.requestVideoFrameCallback(cb);
    };
    el.requestVideoFrameCallback(cb);
  }

  _tick(t) {
    if (this._lastRaf) {
      const d = t - this._lastRaf;
      if (d > 4 && d < 50) this.vsync += (d - this.vsync) * 0.05;
    }
    this._lastRaf = t;
    if (!this.playing || this.swapTarget == null) return;
    // A style change made now is displayed at about t + vsync. Swap in the frame that lands on target.
    if (t + this.swapLead * this.vsync >= this.swapTarget - this.vsync / 2) this._cut();
  }

  async _cut() {
    if (!this.playing || this._cutting) return;
    this._cutting = true;
    try { await this._cutNow(); } finally { this._cutting = false; }
  }

  async _cutNow() {
    this.swapTarget = null;
    const next = this.ci + 1;
    const out = this.cur, inn = 1 - this.cur;
    if (next >= this.clips.length) {     // end of sequence
      this.playing = false;
      this._rampOut(out);
      setTimeout(() => this.els[out].pause(), this.rampMs + 2);
      this.onEvent('end', {});
      return;
    }
    const s = this.slot[inn];
    if (!s.ready || s.clip !== next) {
      this.els[out].pause();
      this.stalled = true;
      const t0 = performance.now();
      this.onEvent('stall', { ci: this.ci });
      await this._prepare(inn, next, this.clips[next].start);
      this.onEvent('stallEnd', { ci: this.ci, ms: performance.now() - t0 });
      if (!this.playing) return;
    }
    this.stalled = false;
    const tSwap = performance.now();
    const elIn = this.els[inn], elOut = this.els[out];
    this._show(inn);
    this.ci = next;
    elIn.playbackRate = this.rate;
    this._watch(inn);
    elIn.play();
    this._rampOut(out);
    this._rampIn(inn);
    this.onEvent('swap', { ci: next, at: tSwap, ctxTime: this.ctx.currentTime, ts: this.ctx.getOutputTimestamp() });
    setTimeout(() => {
      elOut.pause();
      this.gains[out].gain.value = 0;
      this._prepareNext();
    }, this.rampMs + 2);
  }
}
