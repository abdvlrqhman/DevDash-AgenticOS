import { useState, type RefObject } from 'react'
import { Clipboard, TextSelect } from 'lucide-react'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { Mods, TerminalHandle } from './TerminalView'

const KEYS: { label: string; seq?: string; mod?: keyof Mods; aria?: string }[] = [
  { label: 'Esc', seq: '\x1b' }, { label: 'Tab', seq: '\t' }, { label: '⇧Tab', seq: '\x1b[Z', aria: 'Shift Tab' }, { label: 'Ctrl', mod: 'ctrl' }, { label: 'Alt', mod: 'alt' },
  { label: '↑', seq: '\x1b[A', aria: 'Up' }, { label: '↓', seq: '\x1b[B', aria: 'Down' }, { label: '←', seq: '\x1b[D', aria: 'Left' }, { label: '→', seq: '\x1b[C', aria: 'Right' },
  { label: '|', seq: '|' }, { label: '~', seq: '~' }, { label: '/', seq: '/' }, { label: '-', seq: '-' },
]

/** Keys a phone keyboard lacks, plus select and paste. Only on touch screens; buttons don't take focus, so the keyboard stays up. */
export function KeyBar({ term, mods }: { term: RefObject<TerminalHandle | null>; mods: Mods }) {
  const [pasting, setPasting] = useState(false)
  const keep = (e: React.PointerEvent) => e.preventDefault()
  // Reading the clipboard directly isn't allowed everywhere (Android's WebView, some browsers): fall back to a box to paste into.
  const paste = () => {
    if (!navigator.clipboard?.readText) return setPasting(true)
    navigator.clipboard.readText().then((t) => (t ? term.current?.paste(t) : setPasting(true)), () => setPasting(true))
  }
  return (
    <>
      <div className="hidden shrink-0 gap-1.5 overflow-x-auto px-2 pb-2 [@media(pointer:coarse)]:flex">
        <Button size="sm" variant="outline" aria-label="Select text" onPointerDown={keep} className="h-9 min-w-10" onClick={() => term.current?.select()}>
          <TextSelect />
        </Button>
        <Button size="sm" variant="outline" aria-label="Paste" onPointerDown={keep} className="h-9 min-w-10" onClick={paste}>
          <Clipboard />
        </Button>
        {KEYS.map((k) => (
          <Button key={k.label} size="sm" variant={k.mod && mods[k.mod] ? 'default' : 'outline'} onPointerDown={keep}
            aria-label={k.aria} aria-pressed={k.mod ? mods[k.mod] : undefined} className="h-9 min-w-10 font-mono"
            onClick={() => (k.mod ? term.current?.toggle(k.mod) : term.current?.send(k.seq!))}>
            {k.label}
          </Button>
        ))}
      </div>
      <PasteDialog open={pasting} onOpenChange={setPasting} onPaste={(t) => { term.current?.paste(t); term.current?.focus() }} />
    </>
  )
}

function PasteDialog({ open, onOpenChange, onPaste }: { open: boolean; onOpenChange: (v: boolean) => void; onPaste: (t: string) => void }) {
  const [text, setText] = useState('')
  const close = (v: boolean) => { onOpenChange(v); if (!v) setText('') }
  return (
    <ResponsiveDialog open={open} onOpenChange={close} title="Paste into the terminal" description="Long-press the box and choose Paste.">
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (text) { onPaste(text); close(false) } }}>
        <Textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={4} className="font-mono text-sm" aria-label="Text to paste" />
        <Button type="submit" className="h-10" disabled={!text}>Paste</Button>
      </form>
    </ResponsiveDialog>
  )
}
