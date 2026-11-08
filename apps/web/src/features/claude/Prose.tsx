import { createContext, memo, useContext, useMemo, type ComponentProps, type MouseEvent, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useRouter } from '@tanstack/react-router'
import { textDir } from '@/lib/dir'
import { openExternal } from '@/lib/shell'
import { FileLinksContext, useFileLinks } from '../files/open-file'
import { appPath, codeFile, folderOf, foldersIn, hrefFile, lookIn, type FileRef } from './file-links'
import { panelCoversPage, setAssistantOpen } from '../assistant/store'
import { toast } from '@/lib/toast'
import { CopyButton, copyText } from './CopyButton'

/**
 * Claude's markdown, with links opening outside DevDash; under a FileViewerProvider, file paths open in the viewer.
 * `cwd`: the folder Claude was in when it wrote this, when that isn't the session's own (it had cd'd, or was in a worktree).
 */
export const Prose = memo(function Prose({ text, cwd }: { text: string; cwd?: string }) {
  const links = useFileLinks()
  const here = useMemo(() => {
    if (!links) return links
    const at = cwd && cwd !== links.cwd ? { ...links, cwd, base: links.cwd } : links
    const near = foldersIn(text, at)
    return near.length ? { ...at, near } : at
  }, [links, cwd, text])
  const body = (
    <div className="prose-dd text-[15px] md:text-sm">
      <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>{text}</Markdown>
    </div>
  )
  return here === links ? body : <FileLinksContext.Provider value={here}>{body}</FileLinksContext.Provider>
})

/** Code inside a code block is never a file link, only inline code. */
const InBlock = createContext(false)

/** A file link: a real link to its folder in Files (so it can open in a new tab), a tap opens the viewer. */
function FileAnchor({ f, said, className, children }: { f: FileRef; said: string; className?: string; children: ReactNode }) {
  const files = useFileLinks()!
  return (
    <a href={`/files?${new URLSearchParams({ path: folderOf(f.path) })}`} title={f.line ? `${f.path}, line ${f.line}` : f.path} className={className}
      onClick={(e: MouseEvent) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); files.open({ ...f, said, lookIn: lookIn(files) }) }}>{children}</a>
  )
}

type Hast = { type?: string; value?: string; children?: Hast[] }
const textOf = (n: Hast | undefined): string => (n?.type === 'text' ? n.value ?? '' : (n?.children ?? []).map(textOf).join(''))

/**
 * Direction follows the text: an Arabic paragraph reads right to left, an English one left to right. Paragraphs and
 * headings decide for themselves (dir auto). Lists, quotes and tables decide from their whole text, and their items and
 * cells follow them, so bullets, the quote bar and the column order sit on the right side for Arabic.
 */
const auto = <T extends 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'>(Tag: T) =>
  function Auto({ node: _, ...props }: ComponentProps<T> & { node?: unknown }) {
    const El = Tag as 'p'
    return <El dir="auto" {...(props as ComponentProps<'p'>)} />
  }
const byText = <T extends 'ul' | 'ol' | 'blockquote' | 'table'>(Tag: T) =>
  function ByText({ node, ...props }: ComponentProps<T> & { node?: unknown }) {
    const El = Tag as 'ul'
    return <El dir={textDir(textOf(node as Hast))} {...(props as ComponentProps<'ul'>)} />
  }

const COMPONENTS: Components = {
  p: auto('p'), h1: auto('h1'), h2: auto('h2'), h3: auto('h3'), h4: auto('h4'), h5: auto('h5'), h6: auto('h6'),
  ul: byText('ul'), ol: byText('ol'), blockquote: byText('blockquote'), table: byText('table'),
  a: function ProseLink({ href, children }) {
    const files = useFileLinks()
    const router = useRouter()
    if (href && appPath(href)) {
      return (
        <a href={href} onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) return
          e.preventDefault()
          router.history.push(href.trim())
          // From the personal agent's panel on a phone, where it covers the page: show the page.
          if (e.currentTarget.closest('[data-assistant]') && panelCoversPage()) setAssistantOpen(false)
        }}>{children}</a>
      )
    }
    const f = files && href ? hrefFile(href, files) : null
    if (f) return <FileAnchor f={f} said={href!}>{children}</FileAnchor>
    return <a href={href} onClick={(e) => { e.preventDefault(); if (href) openExternal(href) }}>{children}</a>
  },
  // A code block reads left to right even in an Arabic reply, with a copy button in its top right corner: shown on hover
  // or focus with a mouse, always on touch screens. It copies the code as written, without the trailing newline.
  pre: function ProsePre({ node, ...props }: ComponentProps<'pre'> & { node?: unknown }) {
    const code = textOf(node as Hast).replace(/\n$/, '')
    return (
      <InBlock.Provider value>
        <div dir="ltr" className="code-block group/code relative">
          <pre {...props} />
          {code && <CopyButton text={code} label="Copy code"
            className="absolute top-1.5 right-1.5 bg-term-bg text-term-fg/60 opacity-0 hover:bg-term-fg/15 hover:text-term-fg group-hover/code:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 dark:hover:bg-term-fg/15" />}
        </div>
      </InBlock.Provider>
    )
  },
  code: function ProseCode({ node: _, children, ...props }) {
    const files = useFileLinks()
    const block = useContext(InBlock)
    const f = files && !block && typeof children === 'string' ? codeFile(children, files) : null
    if (f) return <FileAnchor f={f} said={children as string} className="file-code"><code {...props}>{children}</code></FileAnchor>
    if (block) return <code {...props}>{children}</code>
    // Inline code copies on a tap, like monospace in Telegram; not inside a link, and not when you dragged to select.
    return <code {...props} dir="ltr" className="copy-code" title="Tap to copy" onClick={(e) => {
      if ((e.target as HTMLElement).closest('a') || window.getSelection()?.toString()) return
      const text = e.currentTarget.textContent ?? ''
      if (text) void copyText(text).then((ok) => { if (ok) toast.success('Copied') })
    }}>{children}</code>
  },
}
