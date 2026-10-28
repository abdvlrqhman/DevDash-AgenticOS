import type { WebSocket } from 'ws'
import type { User } from '../modules/auth/repo.ts'

type Conn = { ws: WebSocket; user: User; topics: Set<string>; active: boolean }

/**
 * Live updates for browsers: one WebSocket per tab (/api/live), subscribed to topics like "sessions" or
 * "session:<id>". Whoever publishes decides who may see an event (`allow`), so the hub stays dumb.
 */
export function createHub() {
  const conns = new Set<Conn>()
  const authorizers = new Map<string, (user: User, topic: string) => boolean>()
  // Topics whose subscribers see each other ("who's watching"): every join or leave tells the topic who is there.
  const presence = new Set<string>()
  const watchers = (topic: string) => {
    const seen = new Map<number, { id: number; name: string }>()
    for (const c of conns) if (c.topics.has(topic)) seen.set(c.user.id, { id: c.user.id, name: c.user.name })
    return [...seen.values()]
  }
  const changed = (topic: string) => {
    if (!presence.has(topic.split(':')[0]!)) return
    const data = JSON.stringify({ topic, type: 'viewers', viewers: watchers(topic) })
    for (const c of conns) if (c.topics.has(topic)) c.ws.send(data)
  }

  return {
    /** Registers who may subscribe to topics starting with `prefix`. */
    authorize(prefix: string, fn: (user: User, topic: string) => boolean) {
      authorizers.set(prefix, fn)
    },
    attach(ws: WebSocket, user: User) {
      const c: Conn = { ws, user, topics: new Set(), active: false }
      conns.add(c)
      ws.on('close', () => {
        conns.delete(c)
        for (const t of c.topics) changed(t)
      })
      ws.on('message', (data) => {
        let m: { sub?: unknown; unsub?: unknown; active?: unknown }
        try {
          m = JSON.parse(String(data))
        } catch {
          return
        }
        if (typeof m.unsub === 'string' && c.topics.delete(m.unsub)) changed(m.unsub)
        // The tab is visible and focused: the member sees in-app notifications there, so push stays quiet.
        if (typeof m.active === 'boolean') c.active = m.active
        if (typeof m.sub === 'string' && m.sub.length < 100) {
          const prefix = m.sub.split(':')[0]!
          if (authorizers.get(prefix)?.(user, m.sub)) {
            c.topics.add(m.sub)
            changed(m.sub)
          } else ws.send(JSON.stringify({ topic: m.sub, type: 'denied' }))
        }
      })
    },
    /** Subscribers of topics starting with `prefix` are told who else is subscribed, as {type: 'viewers'}. */
    trackPresence(prefix: string) {
      presence.add(prefix)
    },
    viewers: watchers,
    isActive(userId: number) {
      for (const c of conns) if (c.user.id === userId && c.active) return true
      return false
    },
    publish(topic: string, payload: object, allow: (u: User) => boolean = () => true) {
      const data = JSON.stringify({ topic, ...payload })
      for (const c of conns) if (c.topics.has(topic) && allow(c.user)) c.ws.send(data)
    },
  }
}

export type Hub = ReturnType<typeof createHub>
