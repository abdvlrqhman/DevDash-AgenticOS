import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { Cable, ChevronRight, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { confirmAction } from '@/components/app/confirm'
import { NativeSelect } from '@/components/app/native-select'
import { PageBody, PageHeader } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api, unwrap } from '@/lib/api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import type { McpEntry, McpSource } from '../../../../agent/src/member-mcps'

const key = ['member-mcps']
const endpoint = api.api.skills.mcps
type Edit = Parameters<typeof endpoint.$post>[0]['json']

const rowClass = 'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-[background-color,scale] duration-300 ease-spring hover:bg-surface-2 active:scale-[0.99]'

function useMcps() {
  return useQuery({ queryKey: key, queryFn: () => unwrap(endpoint.$get()) })
}

function parseCommand(value: string): string[] | null {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return null }
  if (!Array.isArray(parsed) || !parsed.length || !parsed.every((v) => typeof v === 'string' && v.length > 0)) return null
  return parsed
}

export function McpsPage() {
  const q = useMcps()
  const [search, setSearch] = useState('')
  const [checks, setChecks] = useState<Record<string, string>>({})
  const check = useMutation({
    mutationFn: (json: Pick<Edit, 'name' | 'source' | 'revision'>) => unwrap(endpoint.check.$post({ json })),
    onSuccess: (result, row) => setChecks((old) => ({ ...old, [[row.source, row.revision, row.name].join('/')]: result.status })),
  })
  const term = search.toLowerCase().trim()
  const totalEntries = q.data?.entries.length ?? 0

  return (
    <>
      <PageHeader title="MCP servers" description="Connections configured for your provider accounts" back="/more" backOnSmall
        actions={<Button size="sm" variant="outline" onClick={() => void q.refetch()} disabled={q.isFetching}><RefreshCw className={cn(q.isFetching && 'animate-spin')} />Refresh</Button>} />
      <PageBody className="gap-8 py-6 md:py-8">
        <ErrorAlert error={q.error || check.error} />
        {q.isPending && (
          <div className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-13 rounded-xl bg-surface-2" />)}
          </div>
        )}
        {totalEntries > 0 && (
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find an MCP server" aria-label="Find an MCP server" />
        )}
        {q.data?.sources.map((source) => {
          const allEntries = q.data.entries.filter((e) => e.source === source.id)
          const entries = term
            ? allEntries.filter((e) => [e.name, e.host ?? '', e.transport, source.label].join(' ').toLowerCase().includes(term))
            : allEntries
          if (term && !entries.length) return null
          return (
            <section key={source.id} className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold tracking-[-0.01em]">
                  {source.label}
                  {allEntries.length ? <span className="ml-2 font-normal text-muted-foreground tabular-nums">{allEntries.length}</span> : null}
                </h2>
                {!source.error && (
                  <Button size="sm" variant="outline" asChild>
                    <Link to="/mcps/add/$source" params={{ source: source.id }}><Plus />Add server</Link>
                  </Button>
                )}
              </div>
              {source.error && <p className="text-sm text-destructive">{source.error}</p>}
              {!source.error && !entries.length && <p className="text-sm text-muted-foreground">No servers configured.</p>}
              {entries.length > 0 && (
                <ul className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
                  {entries.map((row) => {
                    const status = checks[[source.id, source.revision, row.name].join('/')]
                    return (
                      <li key={row.name} className="flex items-center gap-1">
                        <Link to="/mcps/$source/$name" params={{ source: source.id, name: row.name }} className={cn(rowClass, 'min-w-0 flex-1')}>
                          <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"><Cable className="size-4" /></span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <span className={cn('truncate font-medium', !row.enabled && 'text-muted-foreground')}>{row.name}</span>
                              {!row.enabled && <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted-foreground">Off</span>}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {row.transport}{row.host ? ` · ${row.host}` : ''}{status ? ` · ${status}` : row.enabled ? ' · Enabled' : ' · Disabled'}
                            </span>
                          </span>
                          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        </Link>
                        {row.enabled && (
                          <Button size="sm" variant="ghost" className="mr-1 shrink-0" disabled={check.isPending}
                            onClick={() => check.mutate({ source: source.id, revision: source.revision, name: row.name })}>
                            Check
                          </Button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )
        })}
        {term && q.data && !q.data.entries.some((e) => {
          const src = q.data.sources.find((s) => s.id === e.source)
          return [e.name, e.host ?? '', e.transport, src?.label ?? ''].join(' ').toLowerCase().includes(term)
        }) && <p className="text-sm text-muted-foreground">No matching MCP servers.</p>}
      </PageBody>
    </>
  )
}

/** Full-page view & editor for a single MCP server connection (matching SkillPage). */
export function McpDetailPage() {
  const { source: sourceId, name } = useParams({ strict: false }) as { source: string; name: string }
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useMcps()
  const source: McpSource | undefined = q.data?.sources.find((s) => s.id === sourceId)
  const row: McpEntry | undefined = q.data?.entries.find((e) => e.source === sourceId && e.name === name)

  const [checkStatus, setCheckStatus] = useState<string | null>(null)
  const [transport, setTransport] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState('')

  const activeTransport = transport ?? (row?.transport === 'stdio' ? 'stdio' : 'HTTP')

  const check = useMutation({
    mutationFn: (json: Pick<Edit, 'name' | 'source' | 'revision'>) => unwrap(endpoint.check.$post({ json })),
    onSuccess: (result) => setCheckStatus(result.status),
    onError: (err) => toast.error((err as Error).message),
  })

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => unwrap(endpoint.$post({
      json: { source: source!.id, revision: source!.revision, name: row!.name, action: 'edit', enabled },
    })),
    onSuccess: async (_r, enabled) => {
      await qc.invalidateQueries({ queryKey: key })
      toast.success(enabled ? `${name} is enabled` : `${name} is disabled`)
    },
    onError: (err) => toast.error((err as Error).message),
  })

  const save = useMutation({
    mutationFn: (json: Edit) => unwrap(endpoint.$post({ json })),
    onSuccess: async () => {
      setValue('')
      setCheckStatus(null)
      await qc.invalidateQueries({ queryKey: key })
      toast.success(`${name} updated`)
    },
  })

  const remove = useMutation({
    mutationFn: () => unwrap(endpoint.$post({
      json: { source: source!.id, revision: source!.revision, name: row!.name, action: 'remove' },
    })),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: key })
      toast.success(`${name} removed`)
      void navigate({ to: '/mcps' })
    },
    onError: (err) => toast.error((err as Error).message),
  })

  const askRemove = async () => {
    if (!source || !row) return
    const ok = await confirmAction({
      title: `Remove ${row.name}?`,
      description: `Remove this server from ${source.label}.`,
      action: 'Remove',
      destructive: true,
    })
    if (ok) remove.mutate()
  }

  return (
    <>
      <PageHeader title={row?.name ?? name} description={source?.label ?? 'MCP server'} back="/mcps"
        actions={row && source ? (
          <Button variant="ghost" size="sm" className="text-destructive" disabled={remove.isPending} onClick={() => void askRemove()}>
            <Trash2 />Remove
          </Button>
        ) : undefined} />
      <PageBody className="gap-8 py-6 md:py-8">
        <ErrorAlert error={q.error || check.error} />
        {q.isPending && <Skeleton className="h-44 rounded-2xl" />}
        {q.isSuccess && (!source || !row) && (
          <div className="rounded-2xl bg-surface p-6 text-sm text-muted-foreground">
            This MCP server is no longer configured.
          </div>
        )}
        {source && row && (
          <>
            <header className="flex flex-col gap-4">
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
                <dt className="text-muted-foreground">Provider</dt>
                <dd className="min-w-0">{source.label}</dd>
                <dt className="text-muted-foreground">Transport</dt>
                <dd className="min-w-0">{row.transport}</dd>
                {row.host && (
                  <>
                    <dt className="text-muted-foreground">Host</dt>
                    <dd className="min-w-0 break-all font-mono text-[13px]">{row.host}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">Status</dt>
                <dd className="flex flex-wrap items-center gap-2">
                  <span>{checkStatus ?? (row.enabled ? 'Enabled' : 'Disabled')}</span>
                  {row.enabled && (
                    <Button size="sm" variant="outline" disabled={check.isPending || save.isPending}
                      onClick={() => check.mutate({ source: source.id, revision: source.revision, name: row.name })}>
                      {check.isPending ? 'Checking…' : 'Check connection'}
                    </Button>
                  )}
                </dd>
              </dl>
            </header>

            {source.canToggle && (
              <label className="flex items-center gap-3 rounded-2xl bg-surface px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">Enabled</span>
                  <span className="block text-xs text-pretty text-muted-foreground">
                    Turn off to keep this server in {source.label} without connecting to it.
                  </span>
                </span>
                <Switch checked={row.enabled} disabled={toggle.isPending || save.isPending} onCheckedChange={(v) => toggle.mutate(v)} />
              </label>
            )}

            <section className="flex flex-col gap-3">
              <div>
                <h2 className="text-base font-semibold tracking-[-0.01em]">Replace connection</h2>
                <p className="mt-0.5 text-sm text-pretty text-muted-foreground">
                  Existing URLs, headers, tokens, and environment variables stay private in your provider config. Replacing the transport clears previous credentials and options.
                </p>
              </div>
              <form className="flex flex-col gap-4 rounded-2xl bg-surface p-4 md:p-5" onSubmit={(e) => {
                e.preventDefault()
                setInvalid('')
                let command: string[] | null = null
                if (activeTransport === 'stdio') {
                  command = parseCommand(value)
                  if (!command) {
                    setInvalid('Enter a JSON array with the executable and its arguments.')
                    return
                  }
                }
                save.mutate({
                  source: source.id,
                  revision: source.revision,
                  name: row.name,
                  action: 'edit',
                  ...(command ? { command } : { url: value }),
                })
              }}>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium" htmlFor="mcp-transport">Transport</label>
                  <NativeSelect id="mcp-transport" value={activeTransport} onChange={(e) => { setTransport(e.target.value); setValue(''); setInvalid('') }}>
                    <option value="HTTP">HTTP</option>
                    <option value="stdio">stdio</option>
                  </NativeSelect>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium" htmlFor="mcp-destination">
                    {activeTransport === 'HTTP' ? 'Server URL' : 'Command and arguments (JSON array)'}
                  </label>
                  <Input id="mcp-destination" required type={activeTransport === 'HTTP' ? 'url' : 'text'}
                    value={value} onChange={(e) => setValue(e.target.value)}
                    placeholder={activeTransport === 'HTTP' ? 'https://example.com/mcp' : '["server", "--stdio"]'} />
                </div>
                {invalid && <p role="alert" className="text-sm text-destructive">{invalid}</p>}
                <ErrorAlert error={save.error} />
                <div>
                  <Button disabled={save.isPending} type="submit">{save.isPending ? 'Saving…' : 'Save connection'}</Button>
                </div>
              </form>
            </section>
          </>
        )}
      </PageBody>
    </>
  )
}

/** Full-page form for adding a new MCP server to a provider source. */
export function McpCreatePage() {
  const { source: sourceId } = useParams({ strict: false }) as { source: string }
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useMcps()
  const source = q.data?.sources.find((s) => s.id === sourceId)

  const [name, setName] = useState('')
  const [transport, setTransport] = useState('HTTP')
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState('')

  const save = useMutation({
    mutationFn: (json: Edit) => unwrap(endpoint.$post({ json })),
    onSuccess: async (_r, vars) => {
      await qc.invalidateQueries({ queryKey: key })
      toast.success(`${vars.name} added`)
      void navigate({ to: '/mcps/$source/$name', params: { source: vars.source, name: vars.name } })
    },
  })

  return (
    <>
      <PageHeader title="Add MCP server" description={source?.label ?? sourceId} back="/mcps" />
      <PageBody className="gap-6 py-6 md:py-8">
        <ErrorAlert error={q.error} />
        {q.isPending && <Skeleton className="h-56 rounded-2xl" />}
        {q.isSuccess && !source && (
          <div className="rounded-2xl bg-surface p-6 text-sm text-muted-foreground">
            That provider source is not available.
          </div>
        )}
        {source && (
          <form className="flex flex-col gap-4 rounded-2xl bg-surface p-4 md:p-5" onSubmit={(e) => {
            e.preventDefault()
            setInvalid('')
            let command: string[] | null = null
            if (transport === 'stdio') {
              command = parseCommand(value)
              if (!command) {
                setInvalid('Enter a JSON array with the executable and its arguments.')
                return
              }
            }
            save.mutate({
              source: source.id,
              revision: source.revision,
              name: name.trim(),
              action: 'create',
              ...(command ? { command } : { url: value }),
            })
          }}>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium" htmlFor="mcp-new-name">Server name</label>
              <Input id="mcp-new-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium" htmlFor="mcp-new-transport">Transport</label>
              <NativeSelect id="mcp-new-transport" value={transport} onChange={(e) => { setTransport(e.target.value); setValue(''); setInvalid('') }}>
                <option value="HTTP">HTTP</option>
                <option value="stdio">stdio</option>
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium" htmlFor="mcp-new-destination">
                {transport === 'HTTP' ? 'Server URL' : 'Command and arguments (JSON array)'}
              </label>
              <Input id="mcp-new-destination" required type={transport === 'HTTP' ? 'url' : 'text'}
                value={value} onChange={(e) => setValue(e.target.value)}
                placeholder={transport === 'HTTP' ? 'https://example.com/mcp' : '["server", "--stdio"]'} />
            </div>
            {invalid && <p role="alert" className="text-sm text-destructive">{invalid}</p>}
            <ErrorAlert error={save.error} />
            <div>
              <Button disabled={save.isPending} type="submit">{save.isPending ? 'Saving…' : 'Save server'}</Button>
            </div>
          </form>
        )}
      </PageBody>
    </>
  )
}
