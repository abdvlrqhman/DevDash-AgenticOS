// Where Claude sessions work, in the words people use (pure, so it can be tested on its own).

type Place = { cwd: string; status: string; lastActivityAt: number; owner: { username: string }; project: { slug: string; name: string } | null }

export const URGENCY: Record<string, number> = { waiting: 0, working: 1, error: 2, idle: 3, stopped: 3 }

/** "~/projects/app" for paths in the member's home. */
export const shortPath = (cwd: string, username: string) => cwd.replace(new RegExp(`^/home/${username}(?=/|$)`), '~')

/** A folder's own name ("portfolio"); the home folder is "Home folder". */
export function folderName(cwd: string, username: string) {
  const p = shortPath(cwd, username).replace(/\/+$/, '')
  return p === '~' ? 'Home folder' : p.split('/').pop() || p
}

/** Where a session works, as people say it: its project's name, or its folder's name. */
export const sessionPlace = (s: Pick<Place, 'cwd' | 'owner' | 'project'>) => s.project?.name ?? folderName(s.cwd, s.owner.username)

/**
 * Sessions grouped by where they work: a project (its checkout and every branch of it), else a folder. Groups with
 * something waiting come first, then by most recent activity. Labels are names people use: the project's name, or
 * the folder's own name, with its parent added when two folders share a name.
 */
export function byFolder<S extends Place>(sessions: S[]) {
  const groups = new Map<string, S[]>()
  for (const s of sessions) {
    const key = s.project ? `project:${s.project.slug}` : s.cwd
    const g = groups.get(key)
    if (g) g.push(s)
    else groups.set(key, [s])
  }
  const list = [...groups.entries()].map(([key, list]) => {
    const first = list[0]!
    return {
      key,
      project: first.project,
      cwd: first.cwd,
      label: first.project?.name ?? folderName(first.cwd, first.owner.username),
      path: first.project ? `${first.project.name} (a project)` : shortPath(first.cwd, first.owner.username),
      sessions: list.sort((a, b) => URGENCY[a.status]! - URGENCY[b.status]! || b.lastActivityAt - a.lastActivityAt),
      waiting: list.filter((s) => s.status === 'waiting').length,
      latest: Math.max(...list.map((s) => s.lastActivityAt)),
    }
  })
  const clashing = new Set(list.filter((g) => !g.project && list.some((o) => o !== g && o.label === g.label)))
  for (const g of clashing) g.label = g.path.split('/').slice(-2).join('/')
  return list.sort((a, b) => Number(b.waiting > 0) - Number(a.waiting > 0) || b.latest - a.latest)
}
