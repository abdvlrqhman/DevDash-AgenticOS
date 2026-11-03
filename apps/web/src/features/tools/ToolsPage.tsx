import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { Lock, Search, X } from 'lucide-react'
import { PageBody, PageHeader } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Spinner } from '@/components/ui/spinner'
import { CATEGORIES, CATEGORY_META, TOOLS, TOOLS_BY_ID, type Tool } from './registry'

/** The hub: one big search field over every tool, then the tools by category. All of it runs in your browser. */
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
      <PageHeader title="Tools" description={`${TOOLS.length} developer tools that run in your browser`} />
      <PageBody className="gap-10 md:py-8">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-4 size-4.5 -translate-y-1/2 text-muted-foreground" />
          <Input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools: JSON, image, PDF, cron, regex…" aria-label="Search tools"
            className="h-12 rounded-2xl border-transparent bg-surface pr-11 pl-11 text-base transition-[background-color,border-color,box-shadow] duration-300 ease-spring hover:bg-surface-2 focus-visible:bg-background md:text-base dark:bg-surface dark:focus-visible:bg-background" />
          {q
            ? <Button variant="ghost" size="icon-sm" onClick={() => { setQ(''); inputRef.current?.focus() }} aria-label="Clear search" className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground"><X /></Button>
            : <Kbd className="absolute top-1/2 right-4 hidden -translate-y-1/2 sm:flex">/</Kbd>}
        </div>

        {matches.length === 0 ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-pretty text-muted-foreground">No tools match “{q}”. Try a format (JSON, PDF) or what you want to do (resize, merge).</p>
            <Button variant="outline" size="sm" onClick={() => { setQ(''); inputRef.current?.focus() }}>Clear search</Button>
          </div>
        ) : term ? (
          <Group title={`Matches for “${q.trim()}”`} count={matches.length}><ToolGrid tools={matches} /></Group>
        ) : (
          CATEGORIES.map((cat) => {
            const tools = TOOLS.filter((t) => t.category === cat)
            return <Group key={cat} title={cat} count={tools.length} description={CATEGORY_META[cat].description}><ToolGrid tools={tools} /></Group>
          })
        )}

        <p className="flex items-center justify-center gap-1.5 text-center text-xs text-pretty text-muted-foreground">
          <Lock className="size-3.5 shrink-0" />
          Every tool runs on this device. Nothing you paste, drop or open is uploaded.
        </p>
      </PageBody>
    </>
  )
}

function Group({ title, count, description, children }: { title: string; count: number; description?: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="min-w-0">
        <h2 className="text-base font-semibold tracking-[-0.01em]">{title}<span className="ml-2 font-normal text-muted-foreground tabular-nums">{count}</span></h2>
        {description && <p className="mt-0.5 text-sm text-pretty text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  )
}

/** A category's tools as rows on one panel, in columns where there's room: the panel groups them, hover marks one. */
function ToolGrid({ tools }: { tools: Tool[] }) {
  return (
    <ul className="grid gap-0.5 rounded-2xl bg-surface p-1.5 sm:grid-cols-2 lg:grid-cols-3">
      {tools.map((t) => (
        <li key={t.id} className="min-w-0">
          <Link to="/tools/$tool" params={{ tool: t.id }}
            className="group flex h-full items-start gap-3 rounded-xl px-3 py-3 transition-[background-color,scale] duration-300 ease-spring hover:bg-surface-2 active:scale-[0.99] focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground transition-colors duration-200 group-hover:text-foreground">
              <t.icon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t.name}</span>
              <span className="mt-0.5 line-clamp-2 text-xs text-pretty text-muted-foreground">{t.description}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
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
          <p className="text-sm text-muted-foreground">
            There's no tool called “{id}”. <Link to="/tools" className="text-foreground underline underline-offset-4">See all tools</Link>
          </p>
        </PageBody>
      </>
    )
  }
  const { Component } = tool
  return (
    <>
      <PageHeader
        title={<span className="flex items-center gap-2"><tool.icon className="size-4 shrink-0 text-muted-foreground" />{tool.name}</span>}
        description={tool.description}
        back="/tools"
      />
      <PageBody className="md:py-8">
        <Suspense fallback={<div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Spinner className="size-4" />Loading the tool…</div>}>
          <Component />
        </Suspense>
      </PageBody>
    </>
  )
}
