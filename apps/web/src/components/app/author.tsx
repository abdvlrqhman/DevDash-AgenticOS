import { Bot, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/** Who made something: a team role by its name ("CEO"), else the person. */
export const authorName = (name: string | null | undefined, role?: string | null) => role || name || 'Someone'

/**
 * The tag shown after an author's name: "AI team" for a team role (the account its plan runs on is the hover title), or a
 * "Claude" tag when a person's own Claude did it. Nothing for a plain person.
 */
export function AuthorTag({ role, viaClaude, account, className }: { role?: string | null; viaClaude?: boolean; account?: string | null; className?: string }) {
  if (role) return <Badge variant="secondary" className={cn('h-5 gap-1 px-1.5 font-normal', className)} title={account ? `AI team — runs on ${account}'s plan` : 'AI team'}><Bot className="size-3" />AI team</Badge>
  if (viaClaude) return <Badge variant="secondary" className={cn('h-5 gap-1 px-1.5 font-normal', className)}><Sparkles className="size-3" />Claude</Badge>
  return null
}
