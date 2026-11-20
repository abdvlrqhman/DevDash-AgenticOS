import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, RefreshCw } from 'lucide-react'
import { PageBody, PageHeader } from '@/components/app/page'
import { NativeSelect } from '@/components/app/native-select'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { confirmAction } from '@/components/app/confirm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'
import type { McpEntry, McpSource } from '../../../../agent/src/member-mcps'

const key = ['member-mcps']
const endpoint = api.api.skills.mcps
type Edit = Parameters<typeof endpoint.$post>[0]['json']
export function McpsPage() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: key, queryFn: () => unwrap(endpoint.$get()) })
  const [checks, setChecks] = useState<Record<string, string>>({})
  const check = useMutation({ mutationFn: (json: Pick<Edit, 'name' | 'source' | 'revision'>) => unwrap(endpoint.check.$post({ json })),
    onSuccess: (result, row) => setChecks((old) => ({ ...old, [[row.source, row.revision, row.name].join('/')]: result.status })) })
  const [form, setForm] = useState<{source: McpSource; row?: McpEntry} | null>(null)
  const [name, setName] = useState('')
  const [transport, setTransport] = useState('HTTP')
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState('')
  const save = useMutation({
    mutationFn: (json: Edit) => unwrap(endpoint.$post({ json })),
    onSuccess: async () => { setForm(null); await qc.invalidateQueries({ queryKey: key }) },
  })
  function edit(source: McpSource, row?: McpEntry) {
    save.reset()
    setInvalid('')
    setName(row?.name ?? '')
    setTransport(row?.transport === 'stdio' ? 'stdio' : 'HTTP')
    setValue('')
    setForm({ source, row })
  }
  return <>
    <PageHeader title="MCP servers" description="Connections configured for your provider accounts" back="/skills"
      actions={<Button variant="outline" onClick={() => void q.refetch()} disabled={q.isFetching}><RefreshCw />Refresh</Button>} />
    <PageBody className="gap-6 py-6">
      <ErrorAlert error={q.error || check.error || (!form && save.error)} />
      {q.isPending && <p>Loading connections…</p>}
      {q.data?.sources.map((source) => {
        const entries = q.data.entries.filter((e) => e.source === source.id)
        return <section key={source.id} className="grid gap-2">
          <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">{source.label}</h2>
            <Button size="sm" variant="outline" disabled={!!source.error || save.isPending} onClick={() => edit(source)}><Plus />Add server</Button></div>
          {source.error && <p className="text-sm text-destructive">{source.error}</p>}
          {!source.error && !entries.length && <p className="text-sm text-muted-foreground">No servers configured.</p>}
          {entries.map((row) => <div key={row.name} className="flex flex-wrap items-center gap-2 rounded-xl bg-surface p-3">
            <div className="min-w-40 flex-1"><div className="font-medium">{row.name}</div><div className="break-all text-xs text-muted-foreground">{row.transport} · {row.host && row.host + ' · '}{checks[[source.id, source.revision, row.name].join('/')] ?? (row.enabled ? 'Enabled' : 'Disabled')}</div></div>
            {row.enabled && <Button size="sm" variant="ghost" disabled={check.isPending || save.isPending} onClick={() => check.mutate({ source: source.id, revision: source.revision, name: row.name })}>Check</Button>}
            <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => edit(source, row)}>Edit</Button>
            {source.canToggle && <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate({ source: source.id, revision: source.revision, name: row.name, action: 'edit', enabled: !row.enabled })}>{row.enabled ? 'Disable' : 'Enable'}</Button>}
            <Button size="sm" variant="ghost" disabled={save.isPending} onClick={async () => {
              if (await confirmAction({ title: 'Remove ' + row.name + '?', description: 'Remove this server from ' + source.label + '.', action: 'Remove', destructive: true }))
                save.mutate({ source: source.id, revision: source.revision, name: row.name, action: 'remove' })
            }}>Remove</Button>
          </div>)}
        </section>
      })}
    </PageBody>
    <ResponsiveDialog open={!!form} onOpenChange={(open) => { if (!open) setForm(null) }} title={form?.row ? 'Edit ' + form.row.name : 'Add MCP server'} description={form?.source.label}>
      {form && <form className="grid gap-4" onSubmit={(e) => {
        e.preventDefault()
        let command: unknown
        if (transport === 'stdio') {
          try { command = JSON.parse(value) } catch { /* validated below */ }
          if (!Array.isArray(command) || !command.length || !command.every((v) => typeof v === 'string')) {
            setInvalid('Enter a JSON array with the executable and its arguments.'); return
          }
        }
        save.mutate({ source: form.source.id, revision: form.source.revision, name, action: form.row ? 'edit' : 'create',
          ...(Array.isArray(command) ? { command } : { url: value }) })
      }}>
        <label>Server name<Input required disabled={!!form.row} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Transport<NativeSelect value={transport} onChange={(e) => { setTransport(e.target.value); setValue('') }}><option>HTTP</option><option>stdio</option></NativeSelect></label>
        <label>{transport === 'HTTP' ? 'Server URL' : 'Command and arguments (JSON array)'}<Input required type={transport === 'HTTP' ? 'url' : 'text'} value={value} onChange={(e) => setValue(e.target.value)} placeholder={transport === 'HTTP' ? 'https://example.com/mcp' : '["server", "--stdio"]'} /></label>
        {form.row && <p className="text-sm text-muted-foreground">Replacing a transport clears its previous credentials and options. The provider may ask you to sign in again.</p>}
        {invalid && <p role="alert">{invalid}</p>}<ErrorAlert error={save.error} />
        <Button disabled={save.isPending} type="submit">Save server</Button>
      </form>}
    </ResponsiveDialog>
  </>
}
