import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Download, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { NativeSelect } from '@/components/app/native-select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { hashText, type HashAlgo } from './hash'
import { lorem, randomString } from './lib'
import { CopyButton, Output, ToolError, ToolField, TwoPane, tryRun, useToolState } from './ui'

/* ------------------------------------------------------------------- UUID --- */

export function UuidTool() {
  const [count, setCount] = useToolState('uuid.count', 1)
  const [list, setList] = useState<string[]>(() => [crypto.randomUUID()])
  const gen = () => setList(Array.from({ length: Math.max(1, Math.min(count, 1000)) }, () => crypto.randomUUID()))
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <ToolField label="How many" className="w-32">
          <Input type="number" min={1} max={1000} value={count} onChange={(e) => setCount(Number(e.target.value))} className="h-9" />
        </ToolField>
        <Button type="button" onClick={gen}><RefreshCw />Generate</Button>
      </div>
      <Output value={list.join('\n')} label={`UUID v4${list.length > 1 ? ` × ${list.length}` : ''}`} />
    </div>
  )
}

/* ------------------------------------------------------------------- hash --- */

const ALGOS: HashAlgo[] = ['MD5', 'SHA-1', 'SHA-256', 'SHA-512']

export function HashTool() {
  const [input, setInput] = useToolState('hash.input', '')
  const [results, setResults] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    if (!input) { setResults({}); return }
    void Promise.all(ALGOS.map(async (a) => [a, await hashText(a, input)] as const)).then((pairs) => {
      if (!cancelled) setResults(Object.fromEntries(pairs))
    })
    return () => { cancelled = true }
  }, [input])
  return (
    <div className="flex flex-col gap-4">
      <ToolField label="Text">
        <Textarea value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} placeholder="The quick brown fox" className="min-h-24 font-mono text-[13px]" />
      </ToolField>
      <div className="flex flex-col gap-2">
        {ALGOS.map((a) => (
          <ToolField key={a} label={a}>
            <div className="relative">
              <Input readOnly value={results[a] ?? ''} placeholder="—" className="h-9 pr-10 font-mono text-[13px]" />
              <CopyButton value={results[a] ?? ''} size="icon-sm" variant="ghost" className="absolute top-1 right-1" />
            </div>
          </ToolField>
        ))}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- password --- */

const CHARSETS = [
  { key: 'lower', label: 'a-z' }, { key: 'upper', label: 'A-Z' },
  { key: 'digits', label: '0-9' }, { key: 'symbols', label: '!@#$' },
] as const

export function PasswordTool() {
  const [length, setLength] = useToolState('pw.length', 20)
  const [sets, setSets] = useToolState<Record<string, boolean>>('pw.sets', { lower: true, upper: true, digits: true, symbols: true })
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const gen = () => {
    const r = tryRun(() => randomString(length, sets))
    if (r.ok) { setValue(r.value); setError(null) } else { setValue(''); setError(r.error) }
  }
  useEffect(gen, [length, sets])
  return (
    <div className="flex flex-col gap-4">
      <ToolField label={<span className="flex w-full items-center justify-between"><span>Length</span><span className="font-mono text-foreground">{length}</span></span>}>
        <input type="range" min={4} max={128} value={length} onChange={(e) => setLength(Number(e.target.value))} className="w-full accent-primary" />
      </ToolField>
      <ToolField label="Character sets">
        <div className="flex flex-wrap gap-2">
          {CHARSETS.map((c) => {
            const on = sets[c.key]
            return (
              <button key={c.key} type="button" onClick={() => setSets({ ...sets, [c.key]: !on })}
                className={cn('rounded-lg border px-3 py-1.5 font-mono text-sm transition-colors', on ? 'border-primary/40 bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted')}>
                {c.label}
              </button>
            )
          })}
        </div>
      </ToolField>
      <ToolError message={error} />
      <ToolField label="Password">
        <div className="flex gap-2">
          <Input readOnly value={value} className="h-10 font-mono text-base" />
          <CopyButton value={value} size="sm" className="h-10" />
          <Button type="button" variant="outline" size="icon" className="size-10" aria-label="Regenerate" onClick={gen}><RefreshCw /></Button>
        </div>
      </ToolField>
    </div>
  )
}

/* -------------------------------------------------------------------- lorem - */

export function LoremTool() {
  const [count, setCount] = useToolState('lorem.count', 3)
  const [unit, setUnit] = useToolState<'words' | 'sentences' | 'paragraphs'>('lorem.unit', 'paragraphs')
  const [value, setValue] = useState('')
  const gen = () => setValue(lorem(Math.max(1, Math.min(count, 500)), unit))
  useEffect(gen, [count, unit])
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <ToolField label="Count" className="w-28">
          <Input type="number" min={1} max={500} value={count} onChange={(e) => setCount(Number(e.target.value))} className="h-9" />
        </ToolField>
        <ToolField label="Unit" className="w-40">
          <NativeSelect value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)}>
            <option value="words">Words</option>
            <option value="sentences">Sentences</option>
            <option value="paragraphs">Paragraphs</option>
          </NativeSelect>
        </ToolField>
        <Button type="button" variant="outline" onClick={gen}><RefreshCw />Regenerate</Button>
      </div>
      <Output value={value} label="Lorem ipsum" mono={false} className="whitespace-pre-wrap" />
    </div>
  )
}

/* --------------------------------------------------------------------- QR --- */

export function QrTool() {
  const [input, setInput] = useToolState('qr.input', 'https://')
  const [dataUrl, setDataUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!input) { setDataUrl(''); setError(null); return }
    QRCode.toDataURL(input, { margin: 2, width: 320, errorCorrectionLevel: 'M' })
      .then((url) => { if (!cancelled) { setDataUrl(url); setError(null) } })
      .catch((e: Error) => { if (!cancelled) { setDataUrl(''); setError(e.message) } })
    return () => { cancelled = true }
  }, [input])
  return (
    <TwoPane className="lg:grid-cols-[1fr_auto]">
      <ToolField label="Text or URL">
        <Textarea value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} placeholder="https://devdash.local" className="min-h-28 font-mono text-[13px]" />
      </ToolField>
      <div className="flex flex-col items-center gap-3">
        {error ? <ToolError message={error} /> : (
          <div className="flex size-48 items-center justify-center rounded-xl border bg-white p-2">
            {dataUrl ? <img src={dataUrl} alt="QR code" className="size-full" /> : <span className="text-xs text-muted-foreground">QR appears here</span>}
          </div>
        )}
        {dataUrl && (
          <Button type="button" size="sm" variant="outline" asChild>
            <a href={dataUrl} download="qr-code.png"><Download />Download PNG</a>
          </Button>
        )}
      </div>
    </TwoPane>
  )
}
