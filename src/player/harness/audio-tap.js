// Copied from spikes/player/audio-tap.js (measurement only).
// Measurement only: an AudioWorklet that records the RMS of the RIGHT channel (the continuous
// 440 Hz tone in the test media) for every 128-sample render quantum, and posts them in batches.
// A gap at a cut shows up as a run of quanta with low RMS.
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(512);
    this.n = 0;
    this.frame0 = 0;
    this.on = false;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.on = true; this.n = 0; }
      if (e.data === 'stop') { this.flush(); this.on = false; }
    };
  }
  flush() {
    if (this.n) this.port.postMessage({ frame0: this.frame0, rms: this.buf.slice(0, this.n) });
    this.n = 0;
  }
  process(inputs) {
    if (!this.on) return true;
    const ch = inputs[0] && inputs[0][1] ? inputs[0][1] : (inputs[0] && inputs[0][0]);
    let s = 0;
    if (ch) for (let i = 0; i < ch.length; i++) s += ch[i] * ch[i];
    if (this.n === 0) this.frame0 = currentFrame;
    this.buf[this.n++] = ch ? Math.sqrt(s / ch.length) : 0;
    if (this.n === this.buf.length) this.flush();
    return true;
  }
}
registerProcessor('tap', Tap);
