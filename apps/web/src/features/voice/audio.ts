// The browser half of voice mode: the mic in, Hamasa's voice out, over one WebSocket to the server (which holds the keys
// and talks to the providers). One AudioContext for both, at the device's own rate: echo cancellation works best that
// way (Firefox needs it), and Safari misbehaves with a forced 16 kHz context. Everything starts from a tap (iOS).

import { inShell } from '@/lib/shell'
import { micError } from './ready'
// no-inline: a data: URL would be blocked like a blob: one (script-src 'self'); these must be real files.
import captureUrl from './capture.worklet.js?url&no-inline'
import playbackUrl from './playback.worklet.js?url&no-inline'

export type ServerState = 'listening' | 'hearing' | 'thinking' | 'working' | 'speaking'
export type Phase = 'off' | 'starting' | 'live' | 'paused' | 'ended' | 'error'
export type Mode = 'hands-free' | 'ptt'
export type VoiceSnapshot = {
  phase: Phase
  state: ServerState | null
  mode: Mode
  muted: boolean
  pttDown: boolean
  /** What they're saying right now (their words as recognised). */
  heard: string
  /** What Hamasa is saying. */
  saying: string
  /** They talked over the reply and it stopped: true until their next message goes out. */
  stopped: boolean
  /** A pause after their words: it waits a moment for more before sending (they can send now). */
  holding: boolean
  error: string | null
  /** Why the last conversation ended, when it ended by itself. */
  ended: 'idle' | 'cap' | 'background' | null
  sessionId: string | null
}

type AudioSessionNavigator = Navigator & { audioSession?: { type: string } }

/** A voice conversation: start() from a tap, then subscribe for its state. */
/** Whether the page's Permissions-Policy lets it use the microphone; null where the browser can't tell (Safari). */
function micPolicy(): boolean | null {
  const d = document as Document & { permissionsPolicy?: { allowsFeature(f: string): boolean }; featurePolicy?: { allowsFeature(f: string): boolean } }
  const p = d.permissionsPolicy ?? d.featurePolicy
  return p ? p.allowsFeature('microphone') : null
}

/** `session`: one of their own sessions; none: their chat with Hamasa. */
export function createVoiceClient(o: { page: () => string; session?: string }) {
  let snap: VoiceSnapshot = { phase: 'off', state: null, mode: 'hands-free', muted: false, pttDown: false, heard: '', saying: '', stopped: false, holding: false, error: null, ended: null, sessionId: null }
  const listeners = new Set<() => void>()
  const set = (p: Partial<VoiceSnapshot>) => { snap = { ...snap, ...p }; for (const l of listeners) l() }

  let ctx: AudioContext | null = null
  let mic: MediaStream | null = null
  let capture: AudioWorkletNode | null = null
  let playback: AudioWorkletNode | null = null
  let ws: WebSocket | null = null
  let wake: { release(): Promise<void> } | null = null
  let gen = 0
  let ready = false
  let lastPage = ''
  let pageTimer: ReturnType<typeof setInterval> | undefined

  const send = (m: object) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)) }
  // The browser's side of the diagnostics, sent in batches: states, playback, audio dropped as stale. No content.
  let notes: Record<string, unknown>[] = []
  let dropped = 0
  const note = (kind: string, data: Record<string, number | string | boolean> = {}) => { if (notes.length < 200) notes.push({ kind, at: Date.now(), ...data }) }
  const sendNotes = () => {
    if (dropped) { note('dropped_audio', { frames: dropped }); dropped = 0 }
    if (notes.length) { send({ type: 'events', list: notes.splice(0, 100) }) }
  }
  const sendPage = () => {
    const p = o.page()
    if (p !== lastPage) { lastPage = p; send({ type: 'page', page: p }) }
  }

  async function keepAwake() {
    try {
      wake = await (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null
    } catch { wake = null } // not allowed now (battery saver): the screen may lock, which pauses voice
  }
  // The page went to the background or the screen locked: phones take the mic away, so it pauses until a tap.
  const onVisibility = () => {
    if (document.visibilityState === 'hidden' && (snap.phase === 'live' || snap.phase === 'starting')) stop('background')
  }

  function teardown() {
    clearInterval(pageTimer)
    document.removeEventListener('visibilitychange', onVisibility)
    ws?.close()
    ws = null
    mic?.getTracks().forEach((t) => t.stop())
    mic = null
    capture?.disconnect()
    playback?.disconnect()
    capture = playback = null
    void ctx?.close().catch(() => {})
    ctx = null
    void wake?.release().catch(() => {})
    wake = null
    ready = false
    try { (navigator as AudioSessionNavigator).audioSession!.type = 'auto' } catch { /* not Safari */ }
  }

  function stop(why: VoiceSnapshot['ended'] = null) {
    note('stop', { why: why ?? 'tap', ctx: ctx?.state ?? 'none' })
    sendNotes()
    send({ type: 'stop' })
    teardown()
    set({ phase: why === 'background' ? 'paused' : why ? 'ended' : 'off', state: null, heard: '', saying: '', pttDown: false, ended: why })
  }
  function fail(message: string) {
    teardown()
    set({ phase: 'error', state: null, error: message, heard: '', saying: '' })
  }

  function onMessage(e: MessageEvent) {
    if (e.data instanceof ArrayBuffer) {
      const b = new Uint8Array(e.data)
      if (b[0] !== (gen & 255) || b.length < 3) { dropped++; return } // audio from before a barge-in
      const pcm = e.data.slice(1)
      playback?.port.postMessage({ pcm }, [pcm])
      return
    }
    let m: Record<string, unknown>
    try { m = JSON.parse(String(e.data)) } catch { return }
    switch (m.type) {
      case 'ready':
        ready = true
        lastPage = ''
        sendPage()
        set({ phase: 'live', sessionId: String(m.sessionId), error: null })
        return
      case 'state':
        note('state', { state: String(m.state), ctx: ctx?.state ?? 'none' })
        set({ state: m.state as ServerState, ...(m.state === 'listening' ? { saying: '' } : {}), ...(m.state === 'thinking' ? { heard: '', stopped: false } : {}), ...(m.state !== 'hearing' ? { holding: false } : {}) })
        return
      case 'transcript': return set({ heard: String(m.text ?? '') })
      case 'holding': return set({ holding: Number(m.ms) > 0 })
      case 'utterance': return set({ heard: String(m.text ?? '') })
      case 'mark':
        playback?.port.postMessage({ mark: m.id })
        return set({ saying: String(m.text ?? '') })
      case 'flush':
        note('flush', { gen: Number(m.gen) })
        gen = Number(m.gen)
        playback?.port.postMessage({ cmd: 'clear' })
        return set({ saying: '', stopped: true })
      case 'pause': note('pause'); return void playback?.port.postMessage({ cmd: 'pause' })
      case 'resume': note('resume'); return void playback?.port.postMessage({ cmd: 'resume' })
      case 'error': return set({ error: String(m.message ?? 'Something went wrong.') })
      case 'ended': {
        const r = m.reason
        if (r === 'idle' || r === 'cap') return stop(r)
        if (r === 'error') return fail(snap.error ?? 'Voice mode stopped.')
        return stop()
      }
    }
  }

  return {
    get: () => snap,
    subscribe(l: () => void) { listeners.add(l); return () => void listeners.delete(l) },

    /** From a tap: the browser asks for the mic the first time. */
    async start(mode: Mode = snap.mode) {
      if (snap.phase === 'starting' || snap.phase === 'live') return
      set({ phase: 'starting', mode, error: null, ended: null, heard: '', saying: '', stopped: false, state: null, muted: false, pttDown: false })
      try {
        // All of this in the same tap: iOS only lets sound play and the mic open from one.
        ctx = new AudioContext({ latencyHint: 'interactive' })
        const resumed = ctx.resume()
        try { (navigator as AudioSessionNavigator).audioSession!.type = 'play-and-record' } catch { /* not Safari */ }
        // The site's own policy or an insecure page: no prompt would ever show, so say why before asking.
        if (!window.isSecureContext || micPolicy() === false || !navigator.mediaDevices?.getUserMedia) throw new DOMException('', 'NotAllowedError')
        mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
        await resumed
        const c = ctx
        await Promise.all([c.audioWorklet.addModule(captureUrl), c.audioWorklet.addModule(playbackUrl)])
        capture = new AudioWorkletNode(c, 'devdash-capture')
        playback = new AudioWorkletNode(c, 'devdash-playback', { outputChannelCount: [Math.min(2, c.destination.maxChannelCount || 2)] })
        const silent = c.createGain()
        silent.gain.value = 0
        c.createMediaStreamSource(mic).connect(capture).connect(silent).connect(c.destination)
        playback.connect(c.destination)
        playback.port.onmessage = (e) => {
          if (e.data?.played !== undefined) send({ type: 'played', id: e.data.played })
          else if (e.data?.playing !== undefined) { send({ type: 'playing', idleMs: e.data.playing }); note('playback_start', { idleMs: Math.round(e.data.playing) }) }
          else if (e.data?.underrun) send({ type: 'underrun' })
        }
        capture.port.onmessage = (e) => {
          if (!ready || snap.muted || (snap.mode === 'ptt' && !snap.pttDown) || ws?.readyState !== WebSocket.OPEN) return
          ws.send(e.data as ArrayBuffer)
        }
        // A call or Siri takes the audio: back when it can, else wait for a tap.
        c.onstatechange = () => {
          note('audio_context', { state: c.state })
          if (c.state === 'running' || snap.phase !== 'live') return
          void c.resume().catch(() => {}).then(() => { if (c.state !== 'running' && snap.phase === 'live') stop('background') })
        }
        mic.getAudioTracks()[0]?.addEventListener('ended', () => { if (snap.phase === 'live') stop('background') })
        document.addEventListener('visibilitychange', onVisibility)
        void keepAwake()

        const proto = location.protocol === 'https:' ? 'wss' : 'ws'
        ws = new WebSocket(`${proto}://${location.host}/api/voice/ws?mode=${mode}${o.session ? `&session=${o.session}` : ''}`)
        ws.binaryType = 'arraybuffer'
        ws.onmessage = onMessage
        ws.onclose = () => { if (snap.phase === 'starting' || snap.phase === 'live') fail(snap.error ?? 'The connection dropped. Tap to start again.') }
        pageTimer = setInterval(() => { if (ready) { sendPage(); sendNotes() } }, 2_000)
      } catch (err) {
        const e = err as DOMException
        fail(micError({ name: e.name, message: e.message, secure: window.isSecureContext, policyAllows: micPolicy(), hasMediaDevices: !!navigator.mediaDevices?.getUserMedia, inApp: inShell() }))
      }
    },
    stop: () => stop(),
    setMuted(muted: boolean) { set({ muted }) },
    setMode(mode: Mode) {
      send({ type: 'mode', mode })
      set({ mode, pttDown: false })
    },
    /** Push-to-talk: held down, then let go. */
    ptt(down: boolean) {
      if (snap.mode !== 'ptt' || down === snap.pttDown) return
      set({ pttDown: down })
      send({ type: 'ptt', down })
    },
    /** Send what they said now, without waiting out the pause. */
    sendNow: () => { send({ type: 'send' }); set({ holding: false }) },
    /** Stop it talking, without saying anything. */
    interrupt: () => send({ type: 'interrupt' }),
  }
}
export type VoiceClient = ReturnType<typeof createVoiceClient>
