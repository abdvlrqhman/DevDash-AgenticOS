import type { PendingRequest } from './data.ts'

/** How a live `session:<id>` event last touched one request, so a stale info snapshot can't undo it. */
export type PendingChange = 'added' | 'removed'

/**
 * The pending question/permission/plan cards are driven by two sources that can disagree for a moment: the live
 * `session:<id>` events (a `permission` adds a card, `permission_done` clears it — instant, authoritative) and the
 * session info query's `pending` snapshot (the agent's authoritative map, but only as fresh as the last fetch).
 *
 * This merges them so info stays the fallback without ever clobbering a live change still settling:
 * - `fromInfo` is the base (seeds on first load, re-seeds on reconnect, and catches a request we never saw a live
 *   event for).
 * - For a request a live event just touched (`recentlyChanged`), the live view wins: one it just added is kept
 *   (taken from `live`, so its full shape survives even when `fromInfo` hasn't caught up); one it just removed stays
 *   gone even if a stale `fromInfo` still lists it.
 *
 * Caller drops a request from `recentlyChanged` once `fromInfo` agrees (has an added one / lacks a removed one), so
 * info is authoritative again the moment it catches up.
 */
export function reconcilePending(
  live: PendingRequest[],
  fromInfo: PendingRequest[],
  recentlyChanged: Map<string, PendingChange>,
): PendingRequest[] {
  const byId = new Map(fromInfo.map((r) => [r.requestId, r]))
  for (const [id, change] of recentlyChanged) {
    if (change === 'removed') byId.delete(id)
    else {
      const r = live.find((x) => x.requestId === id)
      if (r) byId.set(id, r)
    }
  }
  const next = [...byId.values()]
  // Keep the current array when nothing actually changed, so a routine status event doesn't re-render the cards.
  if (next.length === live.length && next.every((r, i) => r === live[i])) return live
  return next
}
