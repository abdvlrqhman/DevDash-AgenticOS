import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** Puts `text` on the clipboard; says so when the browser refuses. */
export const copyText = (text: string): Promise<boolean> =>
  navigator.clipboard.writeText(text).then(() => true, () => { toast.error("Couldn't copy"); return false })

/** Copies `text`; the icon turns into a tick for a moment. Used on messages, replies and code blocks. */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = () => void copyText(text).then((ok) => {
    if (!ok) return
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  })
  return (
    <Button type="button" size="icon-xs" variant="ghost" aria-label={copied ? 'Copied' : label} title={label} className={cn('text-muted-foreground', className)} onClick={copy}>
      {copied ? <Check /> : <Copy />}
    </Button>
  )
}
