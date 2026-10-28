import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import '@xterm/xterm/css/xterm.css'
import { openExternal } from '../../lib/shell'

export type Status = 'connecting' | 'live' | 'reconnecting' | 'ended'
export type Mods = { ctrl: boolean; alt: boolean }
export type TerminalHandle = { send: (data: string) => void; paste: (text: string) => void; focus: () => void; toggle: (mod: keyof Mods) => void; select: () => void }

/** Theme colour as hex: the theme uses oklch(), which a canvas normalizes for xterm. */
function css(name: string) {
  const ctx = document.createElement('canvas').getContext('2d')!
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return ctx.fillStyle
}

/**
 * One xterm bound to one tmux-backed terminal on the server. Reconnects after network drops (tmux keeps the state).
 * To start again after the shell exited, the parent remounts it with a new `key`.
 */
export function TerminalView({ path, onStatus, onMods, ref }: {
  /** WebSocket path, e.g. /api/terminals/main/ws or /api/claude/sessions/<id>/cli */
  path: string
  onStatus: (s: Status) => void
  onMods?: (m: Mods) => void
  ref?: Ref<TerminalHandle>
}) {
  const host = useRef<HTMLDivElement>(null)
  const handle = useRef<TerminalHandle | null>(null)
  const [selecting, setSelecting] = useState<string | null>(null)
  const cb = useRef({ onStatus, onMods })
  cb.current = { onStatus, onMods }
  useImperativeHandle(ref, () => ({
    send: (d) => handle.current?.send(d),
    paste: (t) => handle.current?.paste(t),
    focus: () => handle.current?.focus(),
    toggle: (mod) => handle.current?.toggle(mod),
    select: () => handle.current?.select(),
  }), [])

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"Geist Mono Variable", ui-monospace, monospace',
      fontSize: matchMedia('(pointer: coarse)').matches ? 12 : 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10_000,
      macOptionIsMeta: true,
      theme: { background: css('--term-bg'), foreground: css('--term-fg'), cursor: css('--attention'), selectionBackground: '#ffffff40' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => openExternal(uri)))
    term.loadAddon(new ClipboardAddon()) // OSC 52: tmux copy-mode selections land in the device clipboard
    term.open(host.current!)
    try {
      term.loadAddon(new WebglAddon())
    } catch {
      // falls back to the DOM renderer
    }
    const refit = () => {
      try { fit.fit() } catch { /* not visible yet */ }
    }
    refit()
    void document.fonts.ready.then(refit)

    let ws: WebSocket | null = null
    let disposed = false
    let retry = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const mods: Mods = { ctrl: false, alt: false }
    const emitMods = () => cb.current.onMods?.({ ...mods })

    const raw = (d: string) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ d }))
    }
    // Sticky Ctrl/Alt from the phone key bar apply to the next key typed on the soft keyboard.
    const typed = (d: string) => {
      const had = mods.ctrl || mods.alt
      if (mods.ctrl && d.length === 1) {
        const c = d.toUpperCase().charCodeAt(0)
        if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64)
      }
      if (mods.alt) d = '\x1b' + d
      mods.ctrl = mods.alt = false
      if (had) emitMods()
      raw(d)
    }
    handle.current = {
      send: raw,
      paste: (t) => term.paste(t),
      focus: () => term.focus(),
      toggle: (mod) => {
        mods[mod] = !mods[mod]
        emitMods()
      },
      // Touch screens can't drag-select in a canvas: show the scrollback as text the OS can select and copy.
      select: () => setSelecting(bufferText(term)),
    }

    const connect = () => {
      cb.current.onStatus(retry ? 'reconnecting' : 'connecting')
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}${path}?cols=${term.cols}&rows=${term.rows}`)
      ws.onopen = () => {
        retry = 0
        term.reset() // tmux redraws the whole screen on attach
        cb.current.onStatus('live')
      }
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data as string) as { d?: string; error?: string }
        if (m.d) term.write(m.d)
        else if (m.error) term.write(`\r\n\x1b[31m${m.error}\x1b[0m\r\n`)
      }
      ws.onclose = (e) => {
        if (disposed) return
        if (e.code === 1000) return cb.current.onStatus('ended') // the shell exited
        retry++
        cb.current.onStatus('reconnecting')
        timer = setTimeout(connect, Math.min(10_000, 400 * 2 ** retry))
      }
    }
    connect()

    // Windows Terminal conventions: Ctrl+C copies when text is selected, Ctrl+V pastes,
    // right-click copies the selection or pastes when there is none.
    const copySelection = () => {
      const text = term.getSelection()
      if (!text) return false
      void navigator.clipboard.writeText(text)
      term.clearSelection()
      return true
    }
    const paste = () => void navigator.clipboard.readText().then((t) => t && term.paste(t)).catch(() => {})
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !(e.ctrlKey || e.metaKey) || e.altKey) return true
      const k = e.key.toLowerCase()
      if (k === 'c' && (e.shiftKey || term.hasSelection())) return !copySelection() && !e.shiftKey
      if (k === 'v') return false // let the browser fire its paste event; xterm turns it into input
      return true
    })
    const onContextMenu = (e: MouseEvent) => {
      if (!('readText' in navigator.clipboard)) return // keep the browser menu where reading the clipboard isn't allowed
      e.preventDefault()
      if (!copySelection()) paste()
    }
    host.current!.addEventListener('contextmenu', onContextMenu)

    const sub = term.onData(typed)
    const ro = new ResizeObserver(() => {
      refit()
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ r: [term.cols, term.rows] }))
    })
    ro.observe(host.current!)
    term.focus()

    return () => {
      disposed = true
      host.current?.removeEventListener('contextmenu', onContextMenu)
      clearTimeout(timer)
      ro.disconnect()
      sub.dispose()
      ws?.close()
      term.dispose()
      handle.current = null
    }
  }, [path])

  return (
    <div className="relative h-full w-full">
      <div ref={host} className="h-full w-full" />
      {selecting !== null && <SelectText text={selecting} onDone={() => { setSelecting(null); handle.current?.focus() }} />}
    </div>
  )
}

/** The last few thousand lines, with wrapped rows joined back into their original lines. */
function bufferText(term: Terminal) {
  const b = term.buffer.active
  const lines: string[] = []
  for (let i = Math.max(0, b.length - 3000); i < b.length; i++) {
    const line = b.getLine(i)
    if (!line) continue
    const text = line.translateToString(true)
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text
    else lines.push(text)
  }
  return lines.join('\n').trimEnd()
}

function SelectText({ text, onDone }: { text: string; onDone: () => void }) {
  const pre = useRef<HTMLPreElement>(null)
  useEffect(() => { pre.current?.scrollTo(0, pre.current.scrollHeight) }, [])
  const copy = () => {
    const sel = window.getSelection()?.toString()
    void navigator.clipboard.writeText(sel || text).then(onDone, () => {})
  }
  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-term-bg">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 pb-2 text-term-fg">
        <p className="min-w-0 flex-1 text-xs opacity-70">Long-press to select, then copy.</p>
        <Button size="sm" variant="secondary" onClick={copy}><Copy />Copy</Button>
        <Button size="sm" variant="ghost" className="text-term-fg" onClick={onDone}>Done</Button>
      </div>
      <pre ref={pre} data-selectable className="min-h-0 flex-1 overflow-auto pt-2 font-mono text-xs leading-snug whitespace-pre-wrap text-term-fg select-text">{text}</pre>
    </div>
  )
}
