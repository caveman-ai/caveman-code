// The call's AudioWorklets, loaded by src/call/media.ts. Plain JavaScript: a worklet runs as is.
// The microphone: a gentle low-pass, then resampled to the engine's rate; 20 ms frames of 16-bit PCM out.
class Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.rate = options.processorOptions.rate;
    this.step = sampleRate / this.rate;
    this.pos = 0;
    this.lp = 0;
    this.alpha = Math.min(1, (2 * Math.PI * (this.rate * 0.45)) / sampleRate);
    this.prev = 0;
    this.size = Math.round(this.rate * 0.02);
    this.frame = new Int16Array(this.size);
    this.n = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const x = (this.lp += this.alpha * (input[i] - this.lp));
      // Linear interpolation between the last sample and this one at every output step that falls between them.
      while (this.pos <= 1) {
        const y = this.prev + (x - this.prev) * this.pos;
        const s = Math.max(-1, Math.min(1, y));
        this.frame[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === this.size) {
          // Transferred, the frame's buffer is detached (its length reads 0): the next frame is sized from this.size.
          this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
          this.frame = new Int16Array(this.size);
          this.n = 0;
        }
        this.pos += this.step;
      }
      this.pos -= 1;
      this.prev = x;
    }
    return true;
  }
}
registerProcessor("caveman-capture", Capture);

// The voice: 16-bit PCM at the engine's rate in, resampled to the context's, out of a ring buffer. It starts once a
// little is buffered (so the first word never stutters), holds while told to (the ring plays through first), and
// says when it starts and stops sounding, so the page knows when the Chief is audibly speaking.
class Player extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.step = options.processorOptions.rate / sampleRate;
    this.buf = new Float32Array(sampleRate * 30);
    this.read = 0;
    this.write = 0;
    this.frac = 0;
    this.last = 0;
    this.held = false;
    this.playing = false;
    this.prebuffer = Math.round(sampleRate * 0.06);
    this.lastPush = 0;
    this.fade = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m === "flush") return this.flush();
      if (m === "hold") return void (this.held = true);
      if (m === "release") return void (this.held = false);
      this.push(new Int16Array(m));
    };
  }
  size() {
    return (this.write - this.read + this.buf.length) % this.buf.length;
  }
  push(pcm) {
    this.lastPush = currentFrame;
    for (let i = 0; i < pcm.length; i++) {
      const x = pcm[i] / 0x8000;
      // Upsampled with linear interpolation; the fraction carries across chunks so nothing clicks at their seams.
      while (this.frac < 1) {
        this.buf[this.write] = this.last + (x - this.last) * this.frac;
        this.write = (this.write + 1) % this.buf.length;
        this.frac += this.step;
      }
      this.frac -= 1;
      this.last = x;
    }
  }
  flush() {
    // A 6 ms fade, then silence: talking over it never pops. Nothing sounding: just drop what waits.
    if (this.playing) this.fade = Math.round(sampleRate * 0.006);
    else this.read = this.write;
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    const queued = this.size();
    // Starts once 60 ms wait, or sooner for a short line that has all arrived (nothing new for 40 ms).
    if (!this.playing && !this.held && queued > 0 && (queued >= this.prebuffer || currentFrame - this.lastPush > sampleRate * 0.04)) {
      this.playing = true;
      this.port.postMessage("playing");
    }
    for (let i = 0; i < out.length; i++) {
      if (!this.playing || this.held || this.size() === 0) {
        out[i] = 0;
        continue;
      }
      let s = this.buf[this.read];
      this.read = (this.read + 1) % this.buf.length;
      if (this.fade > 0) {
        s *= this.fade / (sampleRate * 0.006);
        if (--this.fade === 0) this.read = this.write;
      }
      out[i] = s;
    }
    if (this.playing && this.size() === 0) {
      this.playing = false;
      this.port.postMessage("drained");
    }
    return true;
  }
}
registerProcessor("caveman-player", Player);
