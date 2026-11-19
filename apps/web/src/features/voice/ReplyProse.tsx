import { Volume2 } from 'lucide-react'
import { Prose } from '../claude/Prose'
import { splitReply } from './reply'

/** A reply in the chat: what Hamasa said out loud (quieter, with a speaker), then what it wrote. */
export function ReplyProse({ text, cwd }: { text: string; cwd?: string }) {
  const { spoken, written } = splitReply(text)
  if (!spoken) return <Prose text={written} cwd={cwd} />
  return (
    <div className="flex flex-col gap-2">
      {/* dir follows the words, so in Arabic the speaker sits at the start of the line, on the right. */}
      <p dir={/^[^\p{L}]*[\u0600-\u06FF]/u.test(spoken) ? 'rtl' : 'ltr'} className="flex items-start gap-2 text-[15px] leading-relaxed text-muted-foreground md:text-sm" data-selectable>
        <Volume2 className="mt-[0.3em] size-3.5 shrink-0" aria-label="Said out loud" />
        <span className="min-w-0">{spoken}</span>
      </p>
      {written && <Prose text={written} cwd={cwd} />}
    </div>
  )
}
