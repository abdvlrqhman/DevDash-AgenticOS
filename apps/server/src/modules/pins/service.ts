import { transaction, type Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'
import { AppError } from '../../core/http.ts'
import type { User } from '../auth/repo.ts'

// Each member's own shortcuts in the sidebar. This module only keeps the list and its order; what a pin shows (its
// title, link and live state) comes from the module that owns the item, through a resolver registered at the
// composition root (app.ts) — so each module's own visibility rules decide, and pins never import feature modules.

export const PIN_KINDS = ['project', 'session', 'task', 'note', 'service'] as const
export type PinKind = (typeof PIN_KINDS)[number]
/** What the sidebar shows for a pin. `state` is a live status (a session's working/waiting…, a task's status). */
export type Resolved = { title: string; url: string; state?: string | null; detail?: string | null }
/** Looks up the member's pins of one kind; refs it can't find, or the member can't see, are left out. */
export type Resolver = (user: User, refs: string[]) => Map<string, Resolved>

export const MAX_PINS = 30

export function pinsService({ db, hub }: { db: Db; hub: Hub }) {
  const q = {
    all: db.prepare('select kind, ref from pins where user_id = ? order by position, created_at'),
    has: db.prepare('select 1 from pins where user_id = ? and kind = ? and ref = ?'),
    count: db.prepare('select count(*) as n from pins where user_id = ?'),
    last: db.prepare('select coalesce(max(position), 0) as p from pins where user_id = ?'),
    add: db.prepare('insert into pins (user_id, kind, ref, position) values (?, ?, ?, ?) on conflict do nothing'),
    remove: db.prepare('delete from pins where user_id = ? and kind = ? and ref = ?'),
    move: db.prepare('update pins set position = ? where user_id = ? and kind = ? and ref = ?'),
  }
  const resolvers = new Map<PinKind, Resolver>()
  hub.authorize('pins', () => true)
  // Every device of the member follows along (the sidebar on the phone, another tab).
  const changed = (user: User) => hub.publish('pins', { type: 'changed' }, (u) => u.id === user.id)
  const resolve = (user: User, kind: PinKind, refs: string[]) => {
    try {
      return resolvers.get(kind)?.(user, refs) ?? new Map<string, Resolved>()
    } catch {
      return new Map<string, Resolved>() // one module failing never empties the whole sidebar
    }
  }

  const rows = (user: User) => q.all.all(user.id) as { kind: PinKind; ref: string }[]
  /** The member's pins in their order, each as its module shows it now; ones they can't see are skipped, not lost. */
  function list(user: User) {
    const all = rows(user)
    const byKind = new Map<PinKind, string[]>()
    for (const r of all) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r.ref])
    const found = new Map([...byKind].map(([kind, refs]) => [kind, resolve(user, kind, refs)]))
    return all.flatMap((r) => {
      const v = found.get(r.kind)?.get(r.ref)
      return v ? [{ kind: r.kind, ref: r.ref, ...v }] : []
    })
  }

  return {
    list,

    /** A module says how to show its items (app.ts). */
    register(kind: PinKind, fn: Resolver) {
      resolvers.set(kind, fn)
    },

    /** Pins an item for this member, at the end. Only something they can see; pinning twice is fine. */
    pin(user: User, kind: PinKind, ref: string) {
      if (q.has.get(user.id, kind, ref)) return list(user)
      if (!resolve(user, kind, [ref]).has(ref)) throw new AppError(404, 'not_found', "That doesn't exist, or you can't see it.")
      if ((q.count.get(user.id) as { n: number }).n >= MAX_PINS) {
        throw new AppError(409, 'too_many', `You can pin up to ${MAX_PINS} things. Unpin one first.`)
      }
      q.add.run(user.id, kind, ref, (q.last.get(user.id) as { p: number }).p + 1)
      changed(user)
      return list(user)
    },

    unpin(user: User, kind: PinKind, ref: string) {
      q.remove.run(user.id, kind, ref)
      changed(user)
      return list(user)
    },

    /**
     * The member dragged their pins into a new order. Pins the list leaves out (hidden ones the sidebar doesn't show)
     * follow, in their old order; pins it names that aren't theirs are ignored.
     */
    reorder(user: User, order: { kind: PinKind; ref: string }[]) {
      const key = (p: { kind: string; ref: string }) => `${p.kind}\n${p.ref}`
      const mine = rows(user)
      const known = new Set(mine.map(key))
      const first = order.filter((p) => known.has(key(p)))
      const named = new Set(first.map(key))
      transaction(db, () => [...first, ...mine.filter((p) => !named.has(key(p)))].forEach((p, i) => q.move.run(i + 1, user.id, p.kind, p.ref)))
      changed(user)
      return list(user)
    },
  }
}

export type PinsService = ReturnType<typeof pinsService>
