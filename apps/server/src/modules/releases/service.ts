import { AppError } from '../../core/http.ts'
import { attachment } from '../files/stream.ts'

// The native app's releases (GitHub releases of DevDash's own repository), served by the space itself. The repository
// can be private, and then neither the desktop app's updater nor someone installing the app can fetch them from GitHub:
// the server does, with its read-only token (config.githubToken), and passes them through.

type Asset = { id: number; name: string; size: number }
export type Release = { tag: string; version: string; published: number; assets: Asset[] }

const TYPES: Record<string, string> = {
  apk: 'application/vnd.android.package-archive', // so Android browsers offer to install it
  json: 'application/json', sig: 'text/plain', msi: 'application/x-msi',
}
const typeOf = (name: string) => TYPES[name.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream'

export function releasesService({ repo, token, origin, github = fetch }: { repo: string; token: string | null; origin: string; github?: typeof fetch }) {
  const headers = (accept = 'application/vnd.github+json') => ({
    accept, 'user-agent': 'DevDash', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}),
  })
  // The newest release, asked at most every 5 minutes; when GitHub can't be reached the last one keeps being served.
  let known: { at: number; release: Release | null; manifest: unknown } = { at: 0, release: null, manifest: null }

  async function latest(): Promise<Release> {
    if (known.release && Date.now() - known.at < 5 * 60_000) return known.release
    try {
      const r = await github(`https://api.github.com/repos/${repo}/releases?per_page=10`, { headers: headers(), signal: AbortSignal.timeout(8000) })
      if (r.status === 404) {
        throw new AppError(404, 'no_release', "The app's releases are in a private repository: this space needs its GitHub token (DEVDASH_GITHUB_TOKEN) to serve them.")
      }
      if (!r.ok) throw new AppError(409, 'github', `GitHub answered ${r.status}.`)
      // The newest complete one: a release is published before its builds finish, and latest.json is attached last.
      const all = (await r.json() as { tag_name: string; published_at: string; draft: boolean; prerelease: boolean; assets: Asset[] }[])
        .filter((x) => !x.draft && !x.prerelease && x.tag_name.startsWith('app-v'))
      const j = all.find((x) => x.assets.some((a) => a.name === 'latest.json')) ?? all[0]
      if (!j) throw new AppError(404, 'no_release', 'There is no app release yet.')
      const release = {
        tag: j.tag_name, version: j.tag_name.replace(/^app-v/, ''), published: Math.floor(Date.parse(j.published_at) / 1000) || 0,
        assets: j.assets.map((a) => ({ id: a.id, name: a.name, size: a.size })),
      }
      if (release.tag !== known.release?.tag) known.manifest = null
      known = { ...known, at: Date.now(), release }
      return release
    } catch (err) {
      if (known.release) return known.release
      throw err instanceof AppError ? err : new AppError(409, 'github', "Couldn't reach GitHub for the app's releases.")
    }
  }

  /** One file of the newest release, streamed from GitHub (which answers with a short-lived link to its storage). */
  async function download(name: string): Promise<Response> {
    const release = await latest()
    const a = release.assets.find((x) => x.name === name)
    if (!a) throw new AppError(404, 'not_found', `${release.tag} has no file called ${name}.`)
    const first = await github(`https://api.github.com/repos/${repo}/releases/assets/${a.id}`, {
      headers: headers('application/octet-stream'), redirect: 'manual', signal: AbortSignal.timeout(15_000),
    })
    // The storage link carries its own signature: the token is never sent there.
    const location = first.status >= 300 && first.status < 400 ? first.headers.get('location') : null
    const r = location ? await github(location, { headers: { 'user-agent': 'DevDash' }, signal: AbortSignal.timeout(10 * 60_000) }) : first
    if (!r.ok || !r.body) throw new AppError(409, 'github', `GitHub answered ${r.status} for ${name}.`)
    return new Response(r.body, {
      headers: { 'content-type': typeOf(name), 'content-length': String(a.size), 'content-disposition': attachment(name), 'cache-control': 'private, max-age=300' },
    })
  }

  /**
   * The desktop updater's manifest (latest.json from the release) with its download links pointing here instead of at
   * GitHub. The signatures inside are untouched: the app checks every update against its built-in public key.
   */
  async function manifest(): Promise<unknown> {
    await latest()
    if (known.manifest) return known.manifest
    const m = await (await download('latest.json')).json() as { platforms?: Record<string, { url?: string }> }
    for (const p of Object.values(m.platforms ?? {})) {
      const name = p.url?.split('/').pop()
      if (name) p.url = `${origin}/api/app/download/${encodeURIComponent(decodeURIComponent(name))}`
    }
    known.manifest = m
    return m
  }

  return { latest, download, manifest }
}
export type ReleasesService = ReturnType<typeof releasesService>
