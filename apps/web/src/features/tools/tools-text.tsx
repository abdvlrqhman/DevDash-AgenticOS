import { useMemo } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { NativeSelect } from '@/components/app/native-select'
import { cn } from '@/lib/utils'
import { countText, decodeJwt, diffLines, slugify, transformLines } from './lib'
import { CopyButton, Output, ToolError, ToolField, TwoPane, tryRun, useToolState } from './ui'

const MONO = 'min-h-[16rem] font-mono text-[13px]'

/* ------------------------------------------------------------------- diff --- */

export function TextDiff() {
  const [left, setLeft] = useToolState('diff.left', '')
  const [right, setRight] = useToolState('diff.right', '')
  const ops = useMemo(() => diffLines(left, right), [left, right])
  const adds = ops.filter((o) => o.op === 'add').length
  const removes = ops.filter((o) => o.op === 'remove').length
  return (
    <div className="flex flex-col gap-4">
      <TwoPane>
        <ToolField label="Original"><Textarea value={left} onChange={(e) => setLeft(e.target.value)} spellCheck={false} placeholder="Paste the original…" className={MONO} /></ToolField>
        <ToolField label="Changed"><Textarea value={right} onChange={(e) => setRight(e.target.value)} spellCheck={false} placeholder="Paste the changed version…" className={MONO} /></ToolField>
      </TwoPane>
      <div className="flex items-center gap-2 text-xs">
        <Badge variant="outline" className="text-emerald-600 dark:text-emerald-400">+{adds} added</Badge>
        <Badge variant="outline" className="text-destructive">−{removes} removed</Badge>
      </div>
      <ToolField label="Diff">
        <div className="overflow-auto rounded-lg border bg-muted/30 font-mono text-[13px]">
          {ops.length === 0 || (!left && !right) ? (
            <div className="px-3 py-6 text-center text-muted-foreground">Enter text on both sides to compare.</div>
          ) : ops.map((o, i) => (
            <div key={i} className={cn('flex gap-2 px-3 py-0.5 whitespace-pre-wrap',
              o.op === 'add' && 'bg-emerald-500/10', o.op === 'remove' && 'bg-destructive/10')}>
              <span className={cn('w-4 shrink-0 select-none text-center',
                o.op === 'add' ? 'text-emerald-600 dark:text-emerald-400' : o.op === 'remove' ? 'text-destructive' : 'text-muted-foreground/40')}>
                {o.op === 'add' ? '+' : o.op === 'remove' ? '−' : ''}
              </span>
              <span className="min-w-0 break-words">{o.op === 'add' ? o.right : o.left}</span>
            </div>
          ))}
        </div>
      </ToolField>
    </div>
  )
}

/* ------------------------------------------------------------------ regex --- */

export function RegexTester() {
  const [pattern, setPattern] = useToolState('regex.pattern', '')
  const [flags, setFlags] = useToolState('regex.flags', 'g')
  const [sample, setSample] = useToolState('regex.sample', '')
  const result = useMemo(() => {
    if (!pattern) return null
    return tryRun(() => {
      const re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g')
      const matches = [...sample.matchAll(re)].map((m) => ({ match: m[0], index: m.index ?? 0, groups: m.slice(1), named: m.groups ?? null }))
      return matches
    })
  }, [pattern, flags, sample])
  const matches = result?.ok ? result.value : []
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <ToolField label="Pattern" className="min-w-0 flex-1">
          <div className="flex items-center gap-1 font-mono">
            <span className="text-muted-foreground">/</span>
            <Input value={pattern} onChange={(e) => setPattern(e.target.value)} spellCheck={false} placeholder="\b\w+@\w+\.\w+\b" className="h-9 font-mono" />
            <span className="text-muted-foreground">/</span>
          </div>
        </ToolField>
        <ToolField label="Flags" className="w-28">
          <Input value={flags} onChange={(e) => setFlags(e.target.value.replace(/[^gimsuy]/g, ''))} spellCheck={false} placeholder="gi" className="h-9 font-mono" />
        </ToolField>
      </div>
      {result && !result.ok && <ToolError message={result.error} />}
      <ToolField label="Test string"><Textarea value={sample} onChange={(e) => setSample(e.target.value)} spellCheck={false} placeholder="Text to search…" className="min-h-28 font-mono text-[13px]" /></ToolField>
      <ToolField label={`Matches${result?.ok ? ` (${matches.length})` : ''}`}>
        {result?.ok && matches.length === 0 ? (
          <div className="rounded-lg border px-3 py-4 text-center text-sm text-muted-foreground">{pattern ? 'No matches.' : 'Enter a pattern.'}</div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {matches.map((m, i) => (
              <li key={i} className="rounded-lg border px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="font-mono">{m.match || '(empty)'}</Badge>
                  <span className="text-xs text-muted-foreground">at index {m.index}</span>
                </div>
                {m.groups.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                    {m.groups.map((g, gi) => <span key={gi} className="font-mono">${gi + 1}: {g === undefined ? '∅' : JSON.stringify(g)}</span>)}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </ToolField>
    </div>
  )
}

/* -------------------------------------------------------------------- JWT --- */

export function JwtDecoder() {
  const [token, setToken] = useToolState('jwt.token', '')
  const res = token.trim() ? tryRun(() => decodeJwt(token)) : null
  return (
    <div className="flex flex-col gap-4">
      <ToolField label="JWT">
        <Textarea value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} placeholder="eyJhbGciOi…" className="min-h-24 font-mono text-[13px] break-all" />
      </ToolField>
      {res && !res.ok && <ToolError message={res.error} />}
      {res?.ok && (
        <>
          {res.value.expired !== null && (
            <div className={cn('flex flex-wrap items-center gap-2 text-sm', res.value.expired ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400')}>
              <Badge variant="outline" className={res.value.expired ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400'}>{res.value.expired ? 'Expired' : 'Valid (not expired)'}</Badge>
              {res.value.expiresAt && <span className="text-xs text-muted-foreground">expires {res.value.expiresAt}</span>}
              {res.value.issuedAt && <span className="text-xs text-muted-foreground">· issued {res.value.issuedAt}</span>}
            </div>
          )}
          <p className="text-xs text-muted-foreground">Decoded only — the signature is not verified.</p>
          <TwoPane>
            <Output value={JSON.stringify(res.value.header, null, 2)} label="Header" />
            <Output value={JSON.stringify(res.value.payload, null, 2)} label="Payload" />
          </TwoPane>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ lines --- */

export function LineTools() {
  const [input, setInput] = useToolState('lines.input', '')
  const [opts, setOpts] = useToolState('lines.opts', { trim: true, dedup: true, removeEmpty: false, caseInsensitive: false, sort: 'none' as 'asc' | 'desc' | 'none' })
  const output = useMemo(() => transformLines(input, opts), [input, opts])
  const before = useMemo(() => countText(input), [input])
  const after = useMemo(() => countText(output), [output])
  const toggles: { key: 'trim' | 'dedup' | 'removeEmpty' | 'caseInsensitive'; label: string }[] = [
    { key: 'trim', label: 'Trim each line' }, { key: 'dedup', label: 'Remove duplicates' },
    { key: 'removeEmpty', label: 'Remove blank lines' }, { key: 'caseInsensitive', label: 'Case-insensitive' },
  ]
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {toggles.map((t) => (
          <label key={t.key} className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={opts[t.key]} onChange={(e) => setOpts({ ...opts, [t.key]: e.target.checked })} className="accent-primary" />{t.label}
          </label>
        ))}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Sort</span>
          <NativeSelect className="w-28" value={opts.sort} onChange={(e) => setOpts({ ...opts, sort: e.target.value as 'asc' | 'desc' | 'none' })}>
            <option value="none">None</option><option value="asc">A → Z</option><option value="desc">Z → A</option>
          </NativeSelect>
        </div>
      </div>
      <TwoPane>
        <ToolField label={`Input · ${before.lines} lines`}>
          <Textarea value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} placeholder={'banana\napple\nbanana\ncherry'} className={MONO} />
        </ToolField>
        <Output value={output} label={`Output · ${after.lines} lines, ${after.words} words`} />
      </TwoPane>
    </div>
  )
}

/* ---------------------------------------------------------------- slugify --- */

export function Slugify() {
  const [input, setInput] = useToolState('slug.input', '')
  const [sep, setSep] = useToolState('slug.sep', '-')
  const out = input ? slugify(input, sep) : ''
  return (
    <div className="flex flex-col gap-4">
      <TwoPane className="lg:grid-cols-[1fr_10rem]">
        <ToolField label="Text"><Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Hello, World! Café déjà vu" className="h-9" /></ToolField>
        <ToolField label="Separator">
          <NativeSelect value={sep} onChange={(e) => setSep(e.target.value)}><option value="-">Hyphen (-)</option><option value="_">Underscore (_)</option></NativeSelect>
        </ToolField>
      </TwoPane>
      <ToolField label="Slug">
        <div className="relative">
          <Input readOnly value={out} placeholder="hello-world-cafe-deja-vu" className="h-10 pr-12 font-mono" />
          <CopyButton value={out} size="icon-sm" variant="ghost" className="absolute top-1.5 right-1.5" />
        </div>
      </ToolField>
    </div>
  )
}
