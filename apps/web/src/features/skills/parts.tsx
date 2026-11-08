import { memo, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Cpu, ExternalLink, FileCode2, FileText, Link2, ShieldAlert } from 'lucide-react'
import { openExternal } from '@/lib/shell'
import { bytes, cn } from '@/lib/utils'
import { commitUrl, shortSha, sourceLabel, type SkillFile, type SkillSource } from './data'

/** Frontmatter off: name and description are shown above it already. */
const body = (md: string) => md.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '')

// A skill's SKILL.md comes from anyone: no raw HTML (react-markdown drops it), images shown as their text so nothing
// loads from elsewhere, links open outside DevDash.
const COMPONENTS: Components = {
  img: ({ alt, src }) => <span className="text-muted-foreground">[image: {alt || String(src ?? '')}]</span>,
  a: ({ href, children }) => (
    <a href={href} onClick={(e) => { e.preventDefault(); if (href && /^https?:/i.test(href)) openExternal(href) }} className="underline underline-offset-2">{children}</a>
  ),
}

export const SkillMarkdown = memo(function SkillMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className="prose-dd text-[15px] md:text-sm">
      <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>{body(markdown)}</Markdown>
    </div>
  )
})

function Mark({ tone, icon: Icon, children }: { tone: 'warn' | 'quiet'; icon: typeof Cpu; children: ReactNode }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
      tone === 'warn' ? 'bg-attention-soft text-attention-foreground' : 'bg-surface-2 text-muted-foreground')}>
      <Icon className="size-3" />{children}
    </span>
  )
}

/** Every file with its size; anything that can run is marked, so it's the first thing you see. */
export function FileList({ files }: { files: SkillFile[] }) {
  const sorted = [...files].sort((a, b) => Number(b.kind !== 'text' || b.executable) - Number(a.kind !== 'text' || a.executable) || a.path.localeCompare(b.path))
  return (
    <ul className="flex flex-col gap-0.5 rounded-2xl bg-surface p-1.5">
      {sorted.map((f) => {
        const Icon = f.link ? Link2 : f.kind === 'binary' ? Cpu : f.kind === 'script' ? FileCode2 : FileText
        return (
          <li key={f.path} className="flex min-h-10 items-start gap-2.5 rounded-xl px-3 py-2 text-sm">
            <Icon className={cn('mt-0.5 size-4 shrink-0', f.kind !== 'text' || f.executable || f.link ? 'text-attention' : 'text-muted-foreground')} />
            <span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
              <span className="min-w-0 font-mono text-[13px] break-all sm:flex-1">{f.path}</span>
              {(f.link || f.kind !== 'text' || f.executable) && (
                <span className="flex flex-wrap gap-1">
                  {f.link && <Mark tone="warn" icon={Link2}>Link</Mark>}
                  {f.kind === 'script' && <Mark tone="warn" icon={FileCode2}>Script</Mark>}
                  {f.kind === 'binary' && <Mark tone="warn" icon={Cpu}>Binary</Mark>}
                  {f.executable && <Mark tone="warn" icon={ShieldAlert}>Executable</Mark>}
                </span>
              )}
            </span>
            <span className="w-14 shrink-0 pt-px text-right text-xs text-muted-foreground tabular-nums">{bytes(f.size)}</span>
          </li>
        )
      })}
    </ul>
  )
}

/** Where a skill came from; for GitHub, the exact commit, linked. */
export function SourceLine({ source }: { source: (SkillSource | { kind: 'github'; url: string; repo: string; ref: string | null; path: string; sha: string } | { kind: 'upload'; file: string }) | null }) {
  if (source?.kind === 'github') {
    return (
      <button onClick={() => openExternal(commitUrl(source))} className="inline text-left text-sm break-words hover:underline">
        {sourceLabel(source as SkillSource)}{' '}
        <span className="font-mono text-xs whitespace-nowrap text-muted-foreground">{source.ref ? `${source.ref} · ` : ''}{shortSha(source.sha)}</span>
        <ExternalLink className="ml-1 inline size-3.5 align-[-2px] text-muted-foreground" />
      </button>
    )
  }
  return <span className="text-sm">{sourceLabel(source as SkillSource | null)}</span>
}

/** The one thing to know before installing someone else's skill. */
export function RunWarning({ count }: { count: number }) {
  return (
    <div className="flex gap-3 rounded-2xl bg-attention-soft p-4 text-sm text-attention-foreground">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      <p className="text-pretty">
        {count > 0
          ? <><span className="font-medium">{count === 1 ? 'One file here can run' : `${count} files here can run`}</span> as you, with your logins, whenever your agent uses this skill. </>
          : <>No scripts or binaries, but its instructions still steer your agent, with your logins. </>}
        Install only what you have read and trust. Nothing runs while it installs.
      </p>
    </div>
  )
}
