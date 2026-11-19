// Speaker: 24 kHz 16-bit PCM in, resampled to the context's rate. "clear" stops at once (barge-in) and always ends a
// pause too: a pause left on after a clear silenced every reply after it. "pause" holds, and a mark says when
// everything before it has been heard. After silence it starts only once ~300 ms is buffered, or the sentence is
// complete (a mark arrived), so network jitter doesn't cut words apart. It reports when sound starts again (and how
// long it was quiet) and every underrun in the middle of a sentence, for the server's timing log.
const JITTER_S = 0.3
class Playback extends AudioWorkletProcessor {
  constructor() {
    super(); this.q = []; this.pos = 0; this.step = 24000 / sampleRate; this.paused = false; this.idle = 0; this.sounding = false; this.buffered = 0; this.afterMark = true
    this.port.onmessage = (e) => {
      const m = e.data
      if (m.pcm) { const pcm = new Int16Array(m.pcm); this.q.push({ pcm }); this.buffered += pcm.length }
      else if (m.mark !== undefined) this.q.push({ mark: m.mark })
      else if (m.cmd === 'clear') { this.q = []; this.pos = 0; this.idle = 0; this.buffered = 0; this.paused = false; this.sounding = false; this.afterMark = true }
      else if (m.cmd === 'pause') this.paused = true
      else if (m.cmd === 'resume') this.paused = false
    }
  }
  /** Enough to start without stuttering: ~300 ms queued, or everything up to a mark (the sentence is whole). */
  ready() {
    if (this.buffered - this.pos >= JITTER_S * 24000) return true
    return this.q.some((c) => c.mark !== undefined)
  }
  process(_in, outputs) {
    const out = outputs[0][0]
    if (this.paused) return true
    if (!this.sounding && this.q.length && !this.ready()) { this.idle += out.length; return true }
    let wrote = false
    let ranDry = false
    for (let k = 0; k < out.length; k++) {
      while (this.q.length && this.q[0].mark !== undefined) { this.port.postMessage({ played: this.q.shift().mark }); this.afterMark = true }
      const c = this.q[0]
      if (!c) { ranDry = !this.afterMark; break }
      const i = Math.floor(this.pos)
      if (i >= c.pcm.length) { this.q.shift(); this.pos -= c.pcm.length; this.buffered -= c.pcm.length; k--; continue }
      out[k] = c.pcm[i] / 0x8000
      this.pos += this.step
      wrote = true
      this.afterMark = false
    }
    // The queue ran empty with no mark: mid-sentence, the audio didn't arrive in time.
    if (ranDry && wrote) this.port.postMessage({ underrun: true })
    if (wrote && !this.sounding) this.port.postMessage({ playing: (this.idle * 1000) / sampleRate })
    if (wrote) this.idle = 0
    else this.idle += out.length
    this.sounding = wrote
    for (let ch = 1; ch < outputs[0].length; ch++) outputs[0][ch].set(out)
    return true
  }
}
registerProcessor('devdash-playback', Playback)
