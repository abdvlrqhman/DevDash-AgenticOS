import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { Mic, MicOff, Square, X } from 'lucide-react'
import { Orb, type OrbState } from '@/components/app/orb'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { voiceBlocker } from './ready'
import { createVoiceClient, type VoiceClient, type VoiceSnapshot } from './audio'

export const voiceQuery = queryOptions({ queryKey: ['voice'], queryFn: () => unwrap(api.api.voice.$get()), staleTime: 30_000 })
export type VoiceSettingsState = Awaited<ReturnType<typeof voiceQuery.queryFn & {}>>

/** The panel's voice conversation: one client while the chat is open; closing the chat ends it. */
export function useVoice(page: () => string, session?: string) {
  const [client] = useState(() => createVoiceClient({ page, session }))
  useEffect(() => () => client.stop(), [client])
  const snap = useSyncExternalStore(client.subscribe, client.get)
  return { client, snap }
}


// Voice settings live in Account → Voice. Opened from a session or Hamasa, they offer the way back there.
let returnTo: { path: string; label: string } | null = null
export const voiceReturn = () => returnTo
/** Where "Voice mode settings" goes, remembering where it came from. */
export function openVoiceSettings(navigate: (o: { to: string; hash?: string }) => unknown, from?: { path: string; label: string }) {
  returnTo = from ?? null
  void navigate({ to: '/account', hash: 'voice' })
}

/**
 * The chat header's voice button, always there. Set up, it starts talking. Not yet (off, no keys, no voice, the cap),
 * a tap, or hovering on a desk, shows why, with the way to Voice settings.
 */
export function VoiceButton({ v, snap, onStart, onSetup, cannot }: {
  v: VoiceSettingsState | undefined; snap: VoiceSnapshot; onStart: () => void; onSetup: () => void
  /** Why it can't be used here (a session they only watch): a tap says so. */
  cannot?: string
}) {
  const on = snap.phase === 'starting' || snap.phase === 'live'
  const blocker = cannot ?? voiceBlocker(v)
  const [open, setOpen] = useState(false)
  const hide = useRef<ReturnType<typeof setTimeout>>(undefined)
  const hover = (show: boolean) => (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return
    clearTimeout(hide.current)
    if (show) setOpen(true)
    else hide.current = setTimeout(() => setOpen(false), 200)
  }
  const button = (
    <Button variant="ghost" size="icon" aria-pressed={on} disabled={on} aria-label={cannot ? 'Voice mode (not available here)' : blocker ? 'Voice mode (not set up)' : 'Talk (voice mode)'}
      title={blocker ? undefined : 'Talk (voice mode)'} onClick={blocker ? undefined : onStart}
      className={cn('size-9 shrink-0 rounded-full', blocker ? 'text-muted-foreground/60' : 'text-muted-foreground')}>
      <Mic />
    </Button>
  )
  if (!blocker) return button
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild onPointerEnter={hover(true)} onPointerLeave={hover(false)}>{button}</PopoverTrigger>
      <PopoverContent align="end" className="w-64" onOpenAutoFocus={(e) => e.preventDefault()} onPointerEnter={hover(true)} onPointerLeave={hover(false)}>
        <p className="text-sm text-pretty">{blocker}</p>
        {!cannot && <Button size="sm" className="mt-3 w-full" onClick={() => { setOpen(false); onSetup() }}>Voice settings</Button>}
      </PopoverContent>
    </Popover>
  )
}

const LABEL: Record<NonNullable<VoiceSnapshot['state']>, string> = {
  listening: 'Listening', hearing: 'Listening', thinking: 'Thinking', working: 'Working on it', speaking: 'Speaking',
}
const ORB: Record<NonNullable<VoiceSnapshot['state']>, OrbState> = {
  listening: 'listening', hearing: 'listening', thinking: 'solving', working: 'working', speaking: 'composing',
}

/**
 * Voice mode where the message box was: how it's going (the orb and a word), what they're saying or what Hamasa
 * says, and the controls. The conversation itself fills the chat above, written as always.
 */
export function VoiceBar({ client, snap, onSettings }: { client: VoiceClient; snap: VoiceSnapshot; onSettings: () => void }) {
  const live = snap.phase === 'live'
  const st = live ? snap.state : null
  const caption = st === 'speaking' ? snap.saying : snap.heard
  const status = snap.phase === 'starting' ? 'Starting…'
    : snap.phase === 'paused' ? 'Paused'
    : snap.phase === 'ended' ? (snap.ended === 'cap' ? 'Monthly voice cap reached' : 'Voice ended')
    : snap.phase === 'error' ? 'Voice mode stopped'
    : snap.holding ? 'Still listening…'
    : (st === 'hearing' || st === 'listening') && snap.stopped ? 'Stopped, listening'
    : st === 'listening' && snap.muted ? 'Muted'
    : st === 'listening' && snap.mode === 'ptt' ? (snap.pttDown ? 'Listening' : 'Ready')
    : st ? LABEL[st] : 'Connecting…'
  const hint = snap.phase === 'starting' ? 'Allow the microphone if your browser asks.'
    : snap.phase === 'paused' ? 'Voice pauses when the screen locks or you leave the page.'
    : snap.phase === 'ended' ? (snap.ended === 'cap' ? 'Raise the cap in voice settings to keep talking this month.' : 'It stopped after two quiet minutes.')
    : snap.phase === 'error' ? snap.error
    : caption || (st !== 'listening' ? '' : snap.muted ? 'Hamasa can\'t hear you until you unmute.' : snap.mode === 'ptt' ? 'Hold the button while you talk.' : 'Go ahead, I\'m listening.')
  const orb: OrbState = snap.phase === 'starting' || (live && !st) ? 'connecting' : st ? ORB[st] : 'breathing'

  return (
    <div data-voice-bar className="flex flex-col gap-3 rounded-2xl border bg-surface p-3" role="region" aria-label="Voice mode">
      <div className="flex items-center gap-3">
        <Orb state={orb} size={64} label={status} className={cn(!live && snap.phase !== 'starting' && 'opacity-50')} />
        <div className="min-w-0 flex-1" aria-live="polite">
          <div className="text-sm font-medium">{status}</div>
          {hint && <p className={cn('line-clamp-3 text-sm text-pretty', snap.phase === 'error' ? 'text-destructive' : 'text-muted-foreground')} dir="auto">{hint}</p>}
          {live && snap.error && <p className="mt-1 line-clamp-2 text-xs text-destructive">{snap.error}</p>}
        </div>
        {live && snap.holding && (
          <Button size="sm" onClick={client.sendNow} aria-label="Send it now">Send</Button>
        )}
        {live && st === 'speaking' && (
          <Button variant="ghost" size="icon" aria-label="Stop speaking" title="Stop speaking" onClick={client.interrupt}><Square /></Button>
        )}
      </div>

      {live || snap.phase === 'starting' ? (
        <>
          <div className="flex items-center gap-2">
            {snap.mode === 'hands-free' && (
              <Button variant={snap.muted ? 'secondary' : 'ghost'} size="icon" aria-pressed={snap.muted}
                aria-label={snap.muted ? 'Unmute' : 'Mute'} title={snap.muted ? 'Unmute' : 'Mute'} onClick={() => client.setMuted(!snap.muted)}>
                {snap.muted ? <MicOff /> : <Mic />}
              </Button>
            )}
            <ToggleGroup type="single" spacing={1} value={snap.mode} onValueChange={(m) => m && client.setMode(m as VoiceSnapshot['mode'])}
              className="min-w-0 flex-1 rounded-full bg-background p-1" aria-label="How you talk">
              <ToggleGroupItem value="hands-free" className="flex-1 rounded-full px-3 text-xs hover:bg-surface-2">Hands-free</ToggleGroupItem>
              <ToggleGroupItem value="ptt" className="flex-1 rounded-full px-3 text-xs hover:bg-surface-2">Push to talk</ToggleGroupItem>
            </ToggleGroup>
            <Button variant="ghost" size="icon" aria-label="End voice mode" title="End voice mode" onClick={client.stop}><X /></Button>
          </div>
          {snap.mode === 'ptt' && (
            <Button className={cn('h-12 w-full touch-none text-base select-none transition-transform', snap.pttDown && 'scale-[0.98] ring-4 ring-primary/25')} disabled={!live}
              onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); client.ptt(true) }}
              onPointerUp={() => client.ptt(false)} onPointerCancel={() => client.ptt(false)}
              onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); client.ptt(true) } }}
              onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') client.ptt(false) }}
              onContextMenu={(e) => e.preventDefault()}>
              <Mic />{snap.pttDown ? 'Release to send' : 'Hold to talk'}
            </Button>
          )}
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void client.start()}><Mic />{snap.phase === 'paused' ? 'Resume' : snap.phase === 'error' ? 'Try again' : 'Talk again'}</Button>
          {(snap.phase === 'error' || snap.ended === 'cap') && <Button variant="outline" onClick={onSettings}>Settings</Button>}
          <Button variant="ghost" onClick={client.stop}>Type instead</Button>
        </div>
      )}
    </div>
  )
}
