// Mic: mono at the context's rate in, 16 kHz 16-bit PCM out, 40 ms per message. Loaded as a module of its own
// (never a blob: URL): the app's Content-Security-Policy allows scripts from this origin only.
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.step = sampleRate / 16000; this.pos = 0; this.out = new Int16Array(640); this.n = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos), f = this.pos - i
      const s = i + 1 < ch.length ? ch[i] * (1 - f) + ch[i + 1] * f : ch[i]
      this.out[this.n++] = Math.max(-1, Math.min(1, s)) * 0x7fff
      if (this.n === this.out.length) { this.port.postMessage(this.out.buffer.slice(0)); this.n = 0 }
      this.pos += this.step
    }
    this.pos -= ch.length
    return true
  }
}
registerProcessor('devdash-capture', Capture)
