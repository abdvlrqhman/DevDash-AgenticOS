import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { Lock, Search, X } from 'lucide-react'
import { PageBody, PageHeader } from '@/components/app/page'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Spinner } from '@/components/ui/spinner'
import { CATEGORIES, CATEGORY_META, TOOLS, TOOLS_BY_ID, type Tool } from './registry'

/** The hub: a searchable, categorised grid of every tool. All of it runs in your browser. */
export function ToolsPage() {
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // Press "/" anywhere on the page to jump to the filter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault(); inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const term = q.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!term) return TOOLS
    return TOOLS.filter((t) =>
      t.name.toLowerCase().includes(term) || t.description.toLowerCase().includes(term) ||
      t.category.toLowerCase().includes(term) || t.keywords.some((k) => k.includes(term)))
  }, [term])

  return (
    <>
      <PageHeader title="Tools" description={`${TOOLS.length} developer tools, all running in your browser`} />
      <PageBody className="gap-8">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools — JSON, image, PDF, cron, regex…"
            className="h-11 pr-10 pl-9 text-base" aria-label="Search tools" />
          {q
            ? <button onClick={() => setQ('')} aria-label="Clear search" className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
            : <Kbd className="absolute top-1/2 right-3 -translate-y-1/2 hidden sm:flex">/</Kbd>}
        </div>

        {matches.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center">
            <p className="text-sm text-muted-foreground">No tools match “{q}”.</p>
            <button onClick={() => { setQ(''); inputRef.current?.focus() }} className="text-sm font-medium text-primary underline underline-offset-4">Clear search</button>
          </div>
        ) : term ? (
          <section className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">{matches.length} {matches.length === 1 ? 'tool' : 'tools'} for “{q}”</p>
            <ToolGrid tools={matches} />
          </section>
        ) : (
          CATEGORIES.map((cat) => {
            const tools = TOOLS.filter((t) => t.category === cat)
            const meta = CATEGORY_META[cat]
            return (
              <section key={cat} className="flex flex-col gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground">
                    <meta.icon className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="flex items-baseline gap-2 text-sm font-semibold">
                      {cat}<span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">{tools.length}</span>
                    </h2>
                    <p className="truncate text-xs text-muted-foreground">{meta.description}</p>
                  </div>
                </div>
                <ToolGrid tools={tools} />
              </section>
            )
          })
        )}

        <p className="flex items-center justify-center gap-1.5 border-t pt-6 text-xs text-muted-foreground">
          <Lock className="size-3.5" />
          Every tool runs on this device. Nothing you paste, drop or open is ever uploaded.
        </p>
      </PageBody>
    </>
  )
}

function ToolGrid({ tools }: { tools: Tool[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {tools.map((t) => (
        <Link key={t.id} to="/tools/$tool" params={{ tool: t.id }}
          className="group flex items-start gap-3 rounded-xl border bg-card p-3.5 transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
            <t.icon className="size-4.5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium">{t.name}</div>
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{t.description}</p>
          </div>
        </Link>
      ))}
    </div>
  )
}

/** A single tool, deep-linkable at /tools/<id>. */
export function ToolPage() {
  const { tool: id } = useParams({ from: '/app/tools/$tool' })
  const tool = TOOLS_BY_ID[id]
  if (!tool) {
    return (
      <>
        <PageHeader title="Tool not found" back="/tools" />
        <PageBody>
          <div className="rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
            No tool called “{id}”. <Link to="/tools" className="text-primary underline underline-offset-4">Back to all tools</Link>
          </div>
        </PageBody>
      </>
    )
  }
  const { Component } = tool
  return (
    <>
      <PageHeader
        title={<span className="flex items-center gap-2"><tool.icon className="size-4 text-muted-foreground" />{tool.name}</span>}
        description={tool.description}
        back="/tools"
      />
      <PageBody>
        <Suspense fallback={<div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Spinner className="size-4" />Loading tool…</div>}>
          <Component />
        </Suspense>
      </PageBody>
    </>
  )
}
