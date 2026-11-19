import { useState, type KeyboardEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NativeSelect } from '@/components/app/native-select'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api, unwrap } from '@/lib/api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { voiceQuery, type VoiceSettingsState } from './VoiceMode'
import { VoicePicker } from './VoicePicker'
import { fromBrowser } from './ready'

type Patch = Parameters<typeof api.api.voice.$patch>[0]['json']
const LANGUAGE_NAMES = new Intl.DisplayNames(['en'], { type: 'language' })
/** Enter in a field does this, not submit the settings form around it. */
const onEnter = (fn: () => void) => (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); fn() } }
const usd = (n: number) => (n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`)
const WHERE: Record<string, { url: string; site: string }> = {
  soniox: { url: 'https://console.soniox.com', site: 'console.soniox.com' },
  openai: { url: 'https://platform.openai.com/api-keys', site: 'platform.openai.com' },
  fish: { url: 'https://fish.audio/app/api-keys', site: 'fish.audio' },
}

/**
 * Voice mode in Hamasa's settings: on or off, who listens (speech recognition) and who speaks (the voice), the
 * member's own keys for them, the languages they talk in, and what it costs. Keys are checked when saved, kept on the
 * server and only shown again as their last four characters.
 */
export function VoiceSettings() {
  const qc = useQueryClient()
  const q = useQuery(voiceQuery)
  const save = useMutation({
    mutationFn: (json: Patch) => unwrap(api.api.voice.$patch({ json })),
    onSuccess: (r) => qc.setQueryData(voiceQuery.queryKey, r),
    onError: (e) => toast.error(e.message),
  })
  const v = q.data
  return (
    <section className="flex flex-col gap-4" aria-labelledby="voice-heading">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="voice-heading" className="text-sm font-semibold">Voice mode</h2>
          <p className="mt-1 text-xs text-pretty text-muted-foreground">
            Talk instead of typing, to Hamasa or to your own sessions (the mic in their message box): hands-free, or hold to talk. It
            answers out loud in the language you spoke and writes the details in the chat. It uses your own speech provider accounts.
          </p>
        </div>
        {v && <Switch checked={v.enabled} disabled={save.isPending} aria-label="Voice mode" onCheckedChange={(enabled) => save.mutate({ enabled, ...(enabled && v.languages.length <= 1 ? { languages: fromBrowser(navigator.languages, v.languageChoices, v.languages) } : {}) })} />}
      </div>
      {!v ? <Skeleton className="h-40" /> : v.enabled && (
        <>
          <Provider title="Speech recognition" kind="stt" v={v} onChange={(stt) => save.mutate({ stt })} />
          <Provider title="Voice provider" kind="tts" v={v} onChange={(tts) => save.mutate({ tts })} />
          <Languages v={v} onChange={(languages) => save.mutate({ languages })} />
          <VoicePicker v={v} onPerLanguage={(perLanguage) => save.mutate({ perLanguage })} />
          <Field>
            <FieldLabel htmlFor="voice-speed">Speaking speed</FieldLabel>
            <NativeSelect id="voice-speed" value={String(v.speed)} onChange={(e) => save.mutate({ speed: Number(e.target.value) })}>
              {[0.9, 1, 1.1, 1.2, 1.3].map((x) => <option key={x} value={String(x)}>{x === 1 ? 'Normal' : `${x}×`}{x === 1.1 ? ' (default)' : ''}</option>)}
            </NativeSelect>
            <FieldDescription>Change it, then tap Preview to hear the difference.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="voice-end-wait">How long to wait when I stop talking</FieldLabel>
            <NativeSelect id="voice-end-wait" value={v.endWait} onChange={(e) => save.mutate({ endWait: e.target.value as 'quick' | 'normal' | 'patient' })}>
              <option value="quick">Quick</option>
              <option value="normal">Normal (default)</option>
              <option value="patient">Patient</option>
            </NativeSelect>
            <FieldDescription>A breath in the middle of a thought isn't the end: Hamasa waits a moment for more, longer after "and", "يعني" or "ähm", shorter after a question. Patient waits the longest. You can always say "send" or tap Send.</FieldDescription>
          </Field>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-medium">Say something while I wait</div>
              <div className="text-xs text-pretty text-muted-foreground">A short "let me check" when an answer takes a while, and "still on it" during long work. Off: Hamasa only speaks when it has something to say.</div>
            </div>
            <Switch checked={v.waitTalk} aria-label="Say something while I wait" onCheckedChange={(waitTalk) => save.mutate({ waitTalk })} />
          </div>
          <Costs v={v} onCap={(monthlyCapUsd) => save.mutate({ monthlyCapUsd })} />
          <Diagnostics />
        </>
      )}
    </section>
  )
}

function Provider({ title, kind, v, onChange }: { title: string; kind: 'stt' | 'tts'; v: VoiceSettingsState; onChange: (id: string) => void }) {
  const list = v.providers[kind]
  const id = v[kind]
  const note = kind === 'tts' ? v.providers.tts.find((p) => p.id === id)?.note : null
  return (
    <Field>
      <FieldLabel htmlFor={`voice-${kind}`}>{title}</FieldLabel>
      {list.length > 1 ? (
        <NativeSelect id={`voice-${kind}`} value={id} onChange={(e) => onChange(e.target.value)}>
          {list.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </NativeSelect>
      ) : <div id={`voice-${kind}`} className="text-sm">{list[0]?.label}</div>}
      <KeyField provider={id} label={list.find((p) => p.id === id)?.label ?? id} saved={v.keys[id] ?? null} />
      {note && <FieldDescription>{note}</FieldDescription>}
    </Field>
  )
}

/** A provider key: pasted once, checked with the provider, then only its last four characters. */
function KeyField({ provider, label, saved }: { provider: string; label: string; saved: string | null }) {
  const qc = useQueryClient()
  const [key, setKey] = useState('')
  const [editing, setEditing] = useState(false)
  const set = (r: VoiceSettingsState) => qc.setQueryData(voiceQuery.queryKey, r)
  const put = useMutation({
    mutationFn: () => unwrap(api.api.voice.keys[':provider'].$put({ param: { provider }, json: { key } })),
    onSuccess: (r) => { set(r); setKey(''); setEditing(false); toast.success(`${label} key saved.`) },
  })
  const remove = useMutation({
    mutationFn: () => unwrap(api.api.voice.keys[':provider'].$delete({ param: { provider } })),
    onSuccess: set, onError: (e) => toast.error(e.message),
  })
  const check = useMutation({
    mutationFn: () => unwrap(api.api.voice.keys[':provider'].check.$post({ param: { provider } })),
    onSuccess: () => toast.success(`${label} accepts the key.`), onError: (e) => toast.error(e.message),
  })
  const where = WHERE[provider]
  if (saved && !editing) {
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="mr-auto font-mono text-xs text-muted-foreground" aria-label={`${label} key ending in ${saved.slice(-4)}`}>{saved}</span>
        <Button type="button" variant="ghost" size="sm" disabled={check.isPending} onClick={() => check.mutate()}>{check.isPending ? 'Checking…' : 'Check'}</Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>Replace</Button>
        <Button type="button" variant="ghost" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()}>Remove</Button>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Input type="password" autoComplete="off" spellCheck={false} placeholder={`${label} API key`} aria-label={`${label} API key`} value={key}
          onChange={(e) => { setKey(e.target.value); put.reset() }} onKeyDown={onEnter(() => key.trim() && put.mutate())} className="min-w-0 flex-1" />
        <Button type="button" variant="outline" disabled={!key.trim() || put.isPending} onClick={() => put.mutate()}>{put.isPending ? 'Checking…' : 'Save'}</Button>
        {saved && <Button type="button" variant="ghost" onClick={() => { setEditing(false); setKey(''); put.reset() }}>Cancel</Button>}
      </div>
      {put.error ? <p className="text-xs text-destructive">{put.error.message}</p>
        : where && <FieldDescription>From <a href={where.url} target="_blank" rel="noreferrer" className="underline">{where.site}</a>. Stored on this server, never shown again.</FieldDescription>}
    </div>
  )
}

/** Shown without "More languages": the ones most of the team speaks. */
const COMMON = ['en', 'de', 'ar']

function Languages({ v, onChange }: { v: VoiceSettingsState; onChange: (l: string[]) => void }) {
  const [more, setMore] = useState(false)
  const has = new Set(v.languages)
  const toggle = (l: string) => {
    const next = has.has(l) ? v.languages.filter((x) => x !== l) : [...v.languages, l]
    if (next.length) onChange(next)
  }
  const shown = v.languageChoices.filter((l) => more || has.has(l) || COMMON.includes(l))
  const hidden = v.languageChoices.length - v.languageChoices.filter((l) => has.has(l) || COMMON.includes(l)).length
  return (
    <Field>
      <FieldLabel>Languages you speak</FieldLabel>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Languages you speak">
        {shown.map((l) => (
          <button key={l} type="button" aria-pressed={has.has(l)} onClick={() => toggle(l)}
            className={cn('rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              has.has(l) ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
            {LANGUAGE_NAMES.of(l) ?? l}
          </button>
        ))}
        {hidden > 0 && (
          <button type="button" aria-expanded={more} onClick={() => setMore(!more)}
            className="rounded-full px-2.5 py-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            {more ? 'Fewer languages' : `More languages (${hidden})`}
          </button>
        )}
      </div>
      <FieldDescription>
        Helps Hamasa understand you: speech recognition listens for these languages first. Pick the ones you actually speak. Mixing them in one sentence works,
        and Hamasa answers in the one you spoke.
      </FieldDescription>
    </Field>
  )
}

function Costs({ v, onCap }: { v: VoiceSettingsState; onCap: (cap: number | null) => void }) {
  const [cap, setCap] = useState(v.monthlyCapUsd == null ? '' : String(v.monthlyCapUsd))
  const u = v.usage
  const parsed = cap.trim() === '' ? null : Number(cap)
  const valid = parsed === null || (Number.isFinite(parsed) && parsed >= 0)
  return (
    <Field>
      <FieldLabel htmlFor="voice-cap">Cost</FieldLabel>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Per minute of talking, about</dt><dd className="text-right tabular-nums">{usd(u.perMinuteUsd)}</dd>
        <dt className="text-muted-foreground">{u.conversations >= 3 ? 'Per conversation, your average' : 'A ten-minute conversation, about'}</dt><dd className="text-right tabular-nums">{usd(u.perConversationUsd)}</dd>
        <dt className="text-muted-foreground">This month so far ({u.conversations} {u.conversations === 1 ? 'conversation' : 'conversations'})</dt><dd className="text-right tabular-nums">{usd(u.monthUsd)}</dd>
        {u.projectedMonthUsd != null && <><dt className="text-muted-foreground">At this pace, the month</dt><dd className="text-right tabular-nums">{usd(u.projectedMonthUsd)}</dd></>}
      </dl>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Monthly cap $</span>
        <Input id="voice-cap" inputMode="decimal" placeholder="None" value={cap} onChange={(e) => setCap(e.target.value)}
          onKeyDown={onEnter(() => valid && onCap(parsed))} className="w-24" aria-invalid={!valid} />
        <Button type="button" variant="outline" disabled={!valid || parsed === v.monthlyCapUsd} onClick={() => onCap(parsed)}>Save</Button>
      </div>
      <FieldDescription>
        Speech recognition and the voice, at the providers' prices today; Hamasa's own answers are billed as usual. At the cap, voice mode stops until next month.
        {v.overCap && <span className="text-attention-foreground"> The cap is reached.</span>}
      </FieldDescription>
    </Field>
  )
}

/**
 * The last voice conversation's numbers, for "it's choppy": when each step happened, gaps and underruns, which
 * provider and speed. Timings and names only, never words or audio. Copy sends the whole day.
 */
function Diagnostics() {
  const [open, setOpen] = useState(false)
  const q = useQuery({ queryKey: ['voice', 'events'], queryFn: () => unwrap(api.api.voice.events.$get()), enabled: open, staleTime: 0 })
  const events = q.data?.events ?? []
  const turn = [...events].reverse().find((e) => e.kind === 'turn')?.data as Record<string, unknown> | undefined
  const start = [...events].reverse().find((e) => e.kind === 'start')?.data as Record<string, unknown> | undefined
  const underruns = events.filter((e) => e.kind === 'underrun' || e.kind === 'client:underrun').length
  const stuck = events.filter((e) => e.kind === 'stuck').length
  const row = (label: string, v: unknown) => v === undefined || v === null ? null : <><dt className="text-muted-foreground">{label}</dt><dd className="text-right tabular-nums">{String(v)}</dd></>
  const ms = (v: unknown) => (typeof v === 'number' ? `${(v / 1000).toFixed(1)} s` : undefined)
  return (
    <details className="text-sm" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">Voice diagnostics</summary>
      <div className="mt-2 flex flex-col gap-2">
        {!q.data ? <Skeleton className="h-20" /> : !turn ? <p className="text-xs text-muted-foreground">No voice conversation today yet.</p> : (
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-xs">
            {row('Voice provider, speed', start ? `${start.tts}, ${start.speed}×` : undefined)}
            {row('First sound after you stopped', ms(turn.playStart))}
            {row('Acknowledgement', ms(turn.ack))}
            {row('First word from Hamasa', ms(turn.firstVoiceText))}
            {row('Its answer starts playing', ms(turn.firstAnswerAudio))}
            {row('Voice service response (TTS)', Array.isArray(turn.ttfb) && turn.ttfb.length ? (turn.ttfb as number[]).map((x) => `${x} ms`).join(', ') : undefined)}
            {row('Gaps between sentences', Array.isArray(turn.gaps) && turn.gaps.length ? (turn.gaps as number[]).map((x) => `${x} ms`).join(', ') : 'none')}
            {row('Audio ran out mid-sentence (today)', underruns)}
            {row('Player resets (today)', stuck)}
          </dl>
        )}
        <div>
          <Button type="button" variant="outline" size="sm" disabled={!events.length} onClick={() => void navigator.clipboard.writeText(JSON.stringify(events))
            .then(() => toast.success('Copied: timings and states of today\'s voice conversations, no words or audio.'), (e: Error) => toast.error(e.message))}>
            Copy diagnostics
          </Button>
        </div>
      </div>
    </details>
  )
}
