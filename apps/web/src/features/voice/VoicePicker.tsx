import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Search, Square } from 'lucide-react'
import { NativeSelect } from '@/components/app/native-select'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api, unwrap } from '@/lib/api'
import { toast } from '@/lib/toast'
import { voiceQuery, type VoiceSettingsState } from './VoiceMode'

const NAMES = new Intl.DisplayNames(['en'], { type: 'language' })
const languageName = (l: string) => { try { return NAMES.of(l) ?? l } catch { return l } }
/** The languages a preview speaks: theirs that have a sample line, else English. */
const SAMPLED = ['ar', 'en', 'de']
export const previewLanguages = (langs: string[]) => { const l = langs.filter((x) => SAMPLED.includes(x)); return l.length ? l : ['en'] }
const count = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))
const onEnter = (fn: () => void) => (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); fn() } }

/**
 * Plays previews: a short line per language, in a voice, made with their key on the server. The AudioContext is made
 * in the tap itself, so phones let it play once the audio arrives.
 */
function usePreview() {
  const [playing, setPlaying] = useState<string | null>(null)
  const run = useRef(0)
  const ctx = useRef<AudioContext | null>(null)
  const source = useRef<AudioBufferSourceNode | null>(null)
  const stop = () => { run.current++; source.current?.stop(); source.current = null; setPlaying(null) }
  useEffect(() => () => { stop(); void ctx.current?.close() }, [])
  async function play(key: string, languages: string[], voice?: string, long = false) {
    if (playing === key) return stop()
    stop()
    const me = ++run.current
    const c = (ctx.current ??= new AudioContext())
    void c.resume()
    setPlaying(key)
    try {
      for (const language of languages) {
        const r = await fetch('/api/voice/preview', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language, ...(voice ? { voice } : {}), ...(long ? { long } : {}) }) })
        if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? 'The preview didn\'t work.')
        const buf = await c.decodeAudioData(await r.arrayBuffer())
        if (me !== run.current) return
        await new Promise<void>((done) => {
          const s = (source.current = c.createBufferSource())
          s.buffer = buf
          s.connect(c.destination)
          s.onended = () => done()
          s.start()
        })
        if (me !== run.current) return
      }
    } catch (err) {
      if (me === run.current) toast.error((err as Error).message)
    }
    if (me === run.current) setPlaying(null)
  }
  return { playing, play }
}
type Preview = ReturnType<typeof usePreview>

function PreviewButton({ id, preview, languages, voice, label = 'Preview', long }: { id: string; preview: Preview; languages: string[]; voice?: string; label?: string; long?: boolean }) {
  const on = preview.playing === id
  return (
    <Button type="button" variant="ghost" size="sm" aria-pressed={on} aria-label={on ? 'Stop the preview' : `${label}: hear it in ${languages.map(languageName).join(', ')}`}
      onClick={() => void preview.play(id, languages, voice, long)}>
      {on ? <Square /> : <Play />}{on ? 'Stop' : label}
    </Button>
  )
}

function useSetVoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (json: { voice: string | null; language?: string }) => unwrap(api.api.voice.voice.$put({ json })),
    onSuccess: (r) => qc.setQueryData(voiceQuery.queryKey, r),
    onError: (e) => toast.error(e.message),
  })
}

/**
 * The voice Hamasa speaks with. A fixed list (OpenAI) is a select. A library (Fish Audio) is searched right here,
 * filtered by language and most used first, and every voice can be heard first; a voice's id or link works too. A
 * voice per language is there for when one voice sounds wrong in one of them.
 */
export function VoicePicker({ v, onPerLanguage }: { v: VoiceSettingsState; onPerLanguage: (on: boolean) => void }) {
  const p = v.providers.tts.find((x) => x.id === v.tts)
  const preview = usePreview()
  const set = useSetVoice()
  const [choosing, setChoosing] = useState<string | null>(null) // '' the main voice, or a language
  if (!p) return null
  const langs = previewLanguages(v.languages)
  const hasKey = !!v.keys[v.tts]

  if (p.voices) {
    return (
      <Field>
        <FieldLabel htmlFor="voice-voice">Voice</FieldLabel>
        <div className="flex items-center gap-2">
          <NativeSelect id="voice-voice" className="min-w-0 flex-1" value={v.voice?.id ?? p.defaultVoice ?? ''} onChange={(e) => set.mutate({ voice: e.target.value })}>
            {p.voices.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </NativeSelect>
          {hasKey && <PreviewButton id="main" preview={preview} languages={langs} />}
        </div>
        {hasKey && <TestParagraph preview={preview} languages={langs} />}
      </Field>
    )
  }

  const row = (slot: string, title: string, current: { id: string; name: string } | null, fallback: string, langsFor: string[]) => (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted-foreground">{title}</div>
          <div className="truncate text-sm font-medium">{current?.name ?? fallback}</div>
        </div>
        {current && <PreviewButton id={slot || 'main'} preview={preview} languages={langsFor} voice={current.id} />}
        {slot && current && <Button type="button" variant="ghost" size="sm" onClick={() => set.mutate({ voice: null, language: slot })}>Reset</Button>}
        <Button type="button" variant="outline" size="sm" disabled={!hasKey} onClick={() => setChoosing(choosing === slot ? null : slot)}>
          {choosing === slot ? 'Close' : current ? 'Change' : 'Choose'}
        </Button>
      </div>
      {choosing === slot && (
        <Library language={slot || v.languages[0] || ''} languages={v.languages} preview={preview} previewLangs={langsFor} provider={p.label}
          onPick={(voice) => set.mutate({ voice, ...(slot ? { language: slot } : {}) }, { onSuccess: () => setChoosing(null) })} picking={set.isPending} />
      )}
    </div>
  )

  return (
    <Field>
      <FieldLabel>Voice</FieldLabel>
      {!hasKey && <FieldDescription>Save your {p.label} key above first: the library and previews use it.</FieldDescription>}
      {row('', v.perLanguage ? 'Main voice' : 'Hamasa speaks with', v.voice, 'None yet: choose one', langs)}
      {hasKey && v.voice && <TestParagraph preview={preview} languages={langs} voice={v.voice.id} />}
      {v.languages.length > 1 && (
        <div className="flex items-center gap-3 pt-1">
          <div className="min-w-0 flex-1 text-sm">
            <div>A different voice per language</div>
            <div className="text-xs text-muted-foreground">If one voice sounds wrong in one of your languages.</div>
          </div>
          <Switch checked={v.perLanguage} aria-label="A different voice per language" onCheckedChange={onPerLanguage} />
        </div>
      )}
      {v.perLanguage && v.languages.map((l) => (
        <div key={l} className="border-l-2 pl-3">
          {row(l, languageName(l), v.languageVoices[l] ?? null, `Main voice${v.voice ? ` (${v.voice.name})` : ''}`, previewLanguages([l]))}
        </div>
      ))}
    </Field>
  )
}

/** One long, natural paragraph in a voice: how the voice itself sounds, apart from how replies are cut up. */
function TestParagraph({ preview, languages, voice }: { preview: Preview; languages: string[]; voice?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <span>Test sentence:</span>
      {languages.map((l) => <PreviewButton key={l} id={`long:${l}`} preview={preview} languages={[l]} voice={voice} long label={languageName(l)} />)}
    </div>
  )
}

/** The provider's voice library: search by name, one language or any, most used first; hear one, use one. */
function Library({ language, languages, preview, previewLangs, provider, onPick, picking }: {
  language: string; languages: string[]; preview: Preview; previewLangs: string[]; provider: string; onPick: (voice: string) => void; picking: boolean
}) {
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const [lang, setLang] = useState(language)
  const [page, setPage] = useState(1)
  useEffect(() => { const t = setTimeout(() => { setQ(text.trim()); setPage(1) }, 350); return () => clearTimeout(t) }, [text])
  const r = useQuery({
    queryKey: ['voice', 'library', q, lang, page],
    queryFn: () => unwrap(api.api.voice.voices.$get({ query: { ...(q ? { q } : {}), ...(lang ? { language: lang } : {}), page } })),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  })
  return (
    <div ref={(el) => el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })} className="flex scroll-mb-4 flex-col gap-2 rounded-xl border p-2.5">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onEnter(() => setQ(text.trim()))} placeholder="Search by name, or paste a voice id or link" aria-label={`Search ${provider} voices by name, id or link`} className="pl-9" />
        </div>
        <NativeSelect value={lang} onChange={(e) => { setLang(e.target.value); setPage(1) }} aria-label="Language" className="w-32">
          <option value="">Any language</option>
          {languages.map((l) => <option key={l} value={l}>{languageName(l)}</option>)}
        </NativeSelect>
      </div>
      {r.error ? <p className="text-xs text-destructive">{r.error.message}</p>
        : !r.data ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)
        : r.data.notice ? <p className="px-1 py-2 text-sm text-pretty text-muted-foreground" role="status">{r.data.notice}</p>
        : !r.data.items.length ? <p className="px-1 py-2 text-sm text-muted-foreground">No voices found{lang ? ` in ${languageName(lang)}` : ''}. Try another name or any language.</p>
        : (
          <ul className="flex flex-col divide-y" aria-label="Voices">
            {r.data.items.map((x) => (
              <li key={x.id} className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-left text-sm font-medium" dir="auto">{x.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {[x.languages.slice(0, 3).map(languageName).join(', '), `${count(x.uses)} uses`, x.likes ? `${count(x.likes)} likes` : ''].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <PreviewButton id={`lib:${x.id}`} preview={preview} languages={previewLangs} voice={x.id} label="Hear" />
                <Button type="button" size="sm" disabled={picking} onClick={() => onPick(x.id)}>Use</Button>
              </li>
            ))}
          </ul>
        )}
      {r.data && r.data.total > 20 && (
        <div className="flex justify-between">
          <Button type="button" variant="ghost" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</Button>
          <Button type="button" variant="ghost" size="sm" disabled={r.data.items.length < 20 && page * 20 >= r.data.total} onClick={() => setPage(page + 1)}>More</Button>
        </div>
      )}
    </div>
  )
}
