import { useState, type DragEvent } from 'react'
import { ArrowRightLeft, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { NativeSelect } from '@/components/app/native-select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { bytes, cn } from '@/lib/utils'
import {
  bytesToBase64, convertBase, dateToUnix, decodeBase64, decodeHtml, decodeUrl, encodeBase64, encodeHtml, encodeUrl,
  formatJson, jsonToYaml, parseColor, rgbToHsl, toCase, toHex, toHslString, toRgbString, unixToDate, yamlToJson,
  type CaseKind,
} from './lib'
import { CopyButton, Output, ToolError, ToolField, TwoPane, tryRun, useToolState } from './ui'

const MONO = 'min-h-[18rem] font-mono text-[13px]'

/* -------------------------------------------------------------- JSON format - */

export function JsonFormatter() {
  const [input, setInput] = useToolState('json.input', '')
  const [minify, setMinify] = useToolState('json.minify', false)
  const [indent, setIndent] = useToolState('json.indent', 2)
  const res = input.trim() ? tryRun(() => formatJson(input, { minify, indent })) : null
  return (
    <TwoPane>
      <ToolField label="JSON" hint={<span className="ml-auto">{input.length.toLocaleString()} chars</span>}>
        <Textarea value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false}
          placeholder={'{\n  "hello": "world",\n  "items": [1, 2, 3]\n}'} className={MONO} />
      </ToolField>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup type="single" variant="outline" size="sm" value={minify ? 'min' : 'pretty'} onValueChange={(v) => v && setMinify(v === 'min')}>
            <ToggleGroupItem value="pretty">Pretty</ToggleGroupItem>
            <ToggleGroupItem value="min">Minify</ToggleGroupItem>
          </ToggleGroup>
          {!minify && (
            <NativeSelect className="w-28" value={String(indent)} onChange={(e) => setIndent(Number(e.target.value))} aria-label="Indent">
              <option value="2">2 spaces</option>
              <option value="4">4 spaces</option>
            </NativeSelect>
          )}
        </div>
        {res && !res.ok && <ToolError message={res.error} />}
        {res?.ok && res.value !== '' && <span className="text-xs text-emerald-600 dark:text-emerald-400">Valid JSON</span>}
        <Output value={res?.ok ? res.value : ''} label="Result" />
      </div>
    </TwoPane>
  )
}

/* ---------------------------------------------------------------- JSON/YAML - */

export function JsonYaml() {
  const [dir, setDir] = useToolState<'j2y' | 'y2j'>('jsonyaml.dir', 'j2y')
  const [input, setInput] = useToolState('jsonyaml.input', '')
  const res = input.trim()
    ? tryRun(() => (dir === 'j2y' ? jsonToYaml(JSON.parse(input)) : JSON.stringify(yamlToJson(input), null, 2)))
    : null
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <ToggleGroup type="single" variant="outline" size="sm" value={dir} onValueChange={(v) => v && setDir(v as 'j2y' | 'y2j')}>
          <ToggleGroupItem value="j2y">JSON → YAML</ToggleGroupItem>
          <ToggleGroupItem value="y2j">YAML → JSON</ToggleGroupItem>
        </ToggleGroup>
        <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => { if (res?.ok) { setInput(res.value); setDir(dir === 'j2y' ? 'y2j' : 'j2y') } }} disabled={!res?.ok}>
          <ArrowRightLeft />Swap
        </Button>
      </div>
      <TwoPane>
        <ToolField label={dir === 'j2y' ? 'JSON' : 'YAML'}>
          <Textarea value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false}
            placeholder={dir === 'j2y' ? '{ "name": "devdash", "ports": [80, 443] }' : 'name: devdash\nports:\n  - 80\n  - 443'} className={MONO} />
        </ToolField>
        <div className="flex flex-col gap-3">
          {res && !res.ok && <ToolError message={res.error} />}
          <Output value={res?.ok ? res.value : ''} label={dir === 'j2y' ? 'YAML' : 'JSON'} />
        </div>
      </TwoPane>
    </div>
  )
}

/* ----------------------------------------------------------------- base 64 -- */

export function Base64Tool() {
  const [mode, setMode] = useToolState<'enc' | 'dec'>('base64.mode', 'enc')
  const [input, setInput] = useToolState('base64.input', '')
  const [urlSafe, setUrlSafe] = useToolState('base64.url', false)
  const [file, setFile] = useState<{ name: string; size: number; b64: string } | null>(null)
  const res = file ? { ok: true as const, value: file.b64 }
    : input.trim() ? tryRun(() => (mode === 'enc' ? encodeBase64(input, urlSafe) : decodeBase64(input))) : null

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    const f = e.dataTransfer.files?.[0]
    if (!f) return
    void f.arrayBuffer().then((buf) => setFile({ name: f.name, size: f.size, b64: bytesToBase64(new Uint8Array(buf)) }))
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup type="single" variant="outline" size="sm" value={mode} onValueChange={(v) => { if (v) { setMode(v as 'enc' | 'dec'); setFile(null) } }}>
          <ToggleGroupItem value="enc">Encode</ToggleGroupItem>
          <ToggleGroupItem value="dec">Decode</ToggleGroupItem>
        </ToggleGroup>
        {mode === 'enc' && (
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={urlSafe} onChange={(e) => setUrlSafe(e.target.checked)} className="accent-primary" />URL-safe
          </label>
        )}
      </div>
      <TwoPane>
        <div className="flex flex-col gap-2">
          <ToolField label={mode === 'enc' ? 'Text' : 'Base64'}>
            <Textarea value={file ? '' : input} onChange={(e) => { setInput(e.target.value); setFile(null) }} spellCheck={false}
              placeholder={mode === 'enc' ? 'Text to encode…' : 'SGVsbG8gd29ybGQ='} className={MONO}
              onDrop={mode === 'enc' ? onDrop : undefined} onDragOver={mode === 'enc' ? (e) => e.preventDefault() : undefined} />
          </ToolField>
          {mode === 'enc' && (
            file
              ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><Upload className="size-3.5" />{file.name} · {bytes(file.size)} <button className="underline" onClick={() => setFile(null)}>clear</button></p>
              : <p className="flex items-center gap-2 text-xs text-muted-foreground"><Upload className="size-3.5" />…or drop a file onto the box to encode its bytes.</p>
          )}
        </div>
        <div className="flex flex-col gap-3">
          {res && !res.ok && <ToolError message={res.error} />}
          <Output value={res?.ok ? res.value : ''} label="Result" mono />
        </div>
      </TwoPane>
    </div>
  )
}

/* ------------------------------------------------------- URL / HTML entities */

function PairTool({ id, encode, decode, labels, placeholder }: {
  id: string; encode: (s: string) => string; decode: (s: string) => string; labels: [string, string]; placeholder: string
}) {
  const [mode, setMode] = useToolState<'enc' | 'dec'>(`${id}.mode`, 'enc')
  const [input, setInput] = useToolState(`${id}.input`, '')
  const res = input ? tryRun(() => (mode === 'enc' ? encode(input) : decode(input))) : null
  return (
    <div className="flex flex-col gap-3">
      <ToggleGroup type="single" variant="outline" size="sm" value={mode} onValueChange={(v) => v && setMode(v as 'enc' | 'dec')} className="w-fit">
        <ToggleGroupItem value="enc">Encode</ToggleGroupItem>
        <ToggleGroupItem value="dec">Decode</ToggleGroupItem>
      </ToggleGroup>
      <TwoPane>
        <ToolField label={mode === 'enc' ? labels[0] : labels[1]}>
          <Textarea value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} placeholder={placeholder} className={cn(MONO, 'min-h-[12rem]')} />
        </ToolField>
        <div className="flex flex-col gap-3">
          {res && !res.ok && <ToolError message={res.error} />}
          <Output value={res?.ok ? res.value : ''} label={mode === 'enc' ? labels[1] : labels[0]} />
        </div>
      </TwoPane>
    </div>
  )
}

export const UrlTool = () => <PairTool id="url" encode={encodeUrl} decode={decodeUrl} labels={['Plain text', 'Encoded']} placeholder="name=John Doe&city=São Paulo" />
export const HtmlEntityTool = () => <PairTool id="html" encode={encodeHtml} decode={decodeHtml} labels={['Plain text', 'Entities']} placeholder={'<a href="#">Tom & Jerry</a>'} />

/* --------------------------------------------------------------- timestamp -- */

export function TimestampTool() {
  const [ts, setTs] = useToolState('ts.unix', '')
  const [date, setDate] = useToolState('ts.date', '')
  const tsRes = ts.trim() ? tryRun(() => unixToDate(ts)) : null
  const dateRes = date.trim() ? tryRun(() => dateToUnix(date)) : null
  const now = () => { const u = dateToUnix(''); setTs(String(u.seconds)); setDate('') }
  return (
    <div className="flex flex-col gap-4">
      <Button type="button" size="sm" variant="outline" className="w-fit" onClick={now}>Use current time</Button>
      <TwoPane>
        <div className="flex flex-col gap-3">
          <ToolField label="Unix timestamp" hint={<span className="ml-auto">seconds or ms</span>}>
            <Input value={ts} onChange={(e) => { setTs(e.target.value); setDate('') }} placeholder="1700000000" className="h-9 font-mono" inputMode="numeric" />
          </ToolField>
          {tsRes && !tsRes.ok && <ToolError message={tsRes.error} />}
          {tsRes?.ok && (
            <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-sm">
              <Row k="Local" v={tsRes.value.local} />
              <Row k="UTC" v={tsRes.value.utc} />
              <Row k="ISO 8601" v={tsRes.value.iso} mono />
              <Row k="Relative" v={tsRes.value.relative} />
            </dl>
          )}
        </div>
        <div className="flex flex-col gap-3">
          <ToolField label="Date" hint={<span className="ml-auto">ISO or local</span>}>
            <Input value={date} onChange={(e) => { setDate(e.target.value); setTs('') }} placeholder="2025-01-31 14:30" className="h-9 font-mono" />
          </ToolField>
          {dateRes && !dateRes.ok && <ToolError message={dateRes.error} />}
          {dateRes?.ok && (
            <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-sm">
              <Row k="Seconds" v={String(dateRes.value.seconds)} mono copy />
              <Row k="Millis" v={String(dateRes.value.millis)} mono copy />
            </dl>
          )}
        </div>
      </TwoPane>
    </div>
  )
}

function Row({ k, v, mono, copy }: { k: string; v: string; mono?: boolean; copy?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={cn('flex min-w-0 items-center gap-2 break-all', mono && 'font-mono')}>
        <span className="min-w-0 break-all">{v}</span>
        {copy && <CopyButton value={v} size="icon-sm" variant="ghost" />}
      </dd>
    </>
  )
}

/* -------------------------------------------------------------- number base - */

const BASES: { label: string; base: number; key: string }[] = [
  { label: 'Decimal', base: 10, key: 'dec' },
  { label: 'Hexadecimal', base: 16, key: 'hex' },
  { label: 'Binary', base: 2, key: 'bin' },
  { label: 'Octal', base: 8, key: 'oct' },
]

export function NumberBaseTool() {
  const [value, setValue] = useToolState('base.value', '')
  const [from, setFrom] = useToolState('base.from', 10)
  const res = value.trim() ? tryRun(() => BASES.map((b) => ({ ...b, out: convertBase(value, from, b.base) }))) : null
  return (
    <div className="flex flex-col gap-4">
      <TwoPane className="lg:grid-cols-[1fr_12rem]">
        <ToolField label="Value">
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="255" className="h-9 font-mono" />
        </ToolField>
        <ToolField label="From base">
          <NativeSelect value={String(from)} onChange={(e) => setFrom(Number(e.target.value))}>
            {BASES.map((b) => <option key={b.key} value={b.base}>{b.label}</option>)}
          </NativeSelect>
        </ToolField>
      </TwoPane>
      {res && !res.ok && <ToolError message={res.error} />}
      {res?.ok && (
        <div className="grid gap-2 sm:grid-cols-2">
          {res.value.map((b) => (
            <ToolField key={b.key} label={b.label}>
              <div className="relative">
                <Input readOnly value={b.out} className="h-9 pr-10 font-mono" />
                <CopyButton value={b.out} size="icon-sm" variant="ghost" className="absolute top-1 right-1" />
              </div>
            </ToolField>
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------- case --- */

const CASES: { kind: CaseKind; label: string }[] = [
  { kind: 'camel', label: 'camelCase' }, { kind: 'pascal', label: 'PascalCase' }, { kind: 'snake', label: 'snake_case' },
  { kind: 'kebab', label: 'kebab-case' }, { kind: 'constant', label: 'CONSTANT_CASE' }, { kind: 'title', label: 'Title Case' },
  { kind: 'sentence', label: 'Sentence case' }, { kind: 'dot', label: 'dot.case' }, { kind: 'path', label: 'path/case' },
  { kind: 'upper', label: 'UPPERCASE' }, { kind: 'lower', label: 'lowercase' },
]

export function CaseTool() {
  const [input, setInput] = useToolState('case.input', '')
  return (
    <div className="flex flex-col gap-4">
      <ToolField label="Text">
        <Textarea value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} placeholder="hello world example" className="min-h-20" />
      </ToolField>
      <div className="grid gap-2 sm:grid-cols-2">
        {CASES.map((c) => {
          const out = input ? toCase(input, c.kind) : ''
          return (
            <ToolField key={c.kind} label={c.label}>
              <div className="relative">
                <Input readOnly value={out} placeholder="—" className="h-9 pr-10 font-mono" />
                <CopyButton value={out} size="icon-sm" variant="ghost" className="absolute top-1 right-1" />
              </div>
            </ToolField>
          )
        })}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ color --- */

export function ColorTool() {
  const [input, setInput] = useToolState('color.input', '#3b82f6')
  const res = input.trim() ? tryRun(() => parseColor(input)) : null
  const rgb = res?.ok ? res.value : null
  const hsl = rgb ? rgbToHsl(rgb) : null
  return (
    <div className="flex flex-col gap-4">
      <TwoPane className="lg:grid-cols-[1fr_auto]">
        <ToolField label="Colour" hint={<span className="ml-auto">hex, rgb() or hsl()</span>}>
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="#3b82f6" className="h-9 font-mono" />
        </ToolField>
        <ToolField label="Picker">
          <input type="color" aria-label="Colour picker" value={rgb ? toHex({ ...rgb, a: 1 }) : '#000000'}
            onChange={(e) => setInput(e.target.value)} className="h-9 w-16 cursor-pointer rounded-lg border bg-transparent p-1" />
        </ToolField>
      </TwoPane>
      {res && !res.ok && <ToolError message={res.error} />}
      {rgb && hsl && (
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="h-28 w-full rounded-xl border sm:w-40" style={{ background: toRgbString(rgb) }} />
          <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
            {([
              ['HEX', toHex(rgb)],
              ['RGB', toRgbString(rgb)],
              ['HSL', toHslString(rgb)],
              ['HSL values', `${hsl.h}, ${hsl.s}%, ${hsl.l}%`],
            ] as [string, string][]).map(([label, val]) => (
              <ToolField key={label} label={label}>
                <div className="relative">
                  <Input readOnly value={val} className="h-9 pr-10 font-mono" />
                  <CopyButton value={val} size="icon-sm" variant="ghost" className="absolute top-1 right-1" />
                </div>
              </ToolField>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
