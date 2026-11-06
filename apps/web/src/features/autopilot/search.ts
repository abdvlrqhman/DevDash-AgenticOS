// The Activity page's filters, read from the URL (kept out of the page so the router doesn't load it early).

export type ActivitySearch = { who?: 'autopilot' | 'sessions' | 'settings'; tier?: 'green' | 'yellow' | 'red' | 'action' | 'system'; project?: string; q?: string; order?: 'old'; page?: number }

export const WHO = { autopilot: 'Autopilot', sessions: 'Your sessions', settings: 'Settings' } as const
export const TIERS = { action: 'Done by autopilot', green: 'Green', yellow: 'Yellow', red: 'Red / needs you', system: 'Setting' } as const
const pick = <T extends string>(v: unknown, of: readonly T[]) => (of.includes(v as T) ? (v as T) : undefined)

/** Reads the page's filters from the URL, so a filtered view can be linked and survives a reload. */
export function validateActivitySearch(s: Record<string, unknown>): ActivitySearch {
  const page = Number(s.page)
  return {
    who: pick(s.who, Object.keys(WHO) as (keyof typeof WHO)[]),
    tier: pick(s.tier, Object.keys(TIERS) as (keyof typeof TIERS)[]),
    project: typeof s.project === 'string' && s.project ? s.project.slice(0, 100) : undefined,
    q: typeof s.q === 'string' && s.q ? s.q.slice(0, 200) : undefined,
    order: s.order === 'old' ? 'old' : undefined,
    page: Number.isInteger(page) && page > 1 ? page : undefined,
  }
}

