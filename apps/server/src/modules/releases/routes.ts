import { Hono, type Context } from 'hono'
import { AppError, rateLimit } from '../../core/http.ts'
import { esc, page } from '../storage/pages.ts'
import type { Release, ReleasesService } from './service.ts'

/** Which file is which app, in the order the page lists them. */
const KINDS: { label: string; test: RegExp; how: string }[] = [
  { label: 'Android', test: /\.apk$/, how: 'Open the file on the phone and allow installing from your browser or files app.' },
  { label: 'iPhone and iPad', test: /\.ipa$/, how: 'Install it with your sideloading app (AltStore, SideStore or similar).' },
  { label: 'Windows', test: /-setup\.exe$/, how: 'Run the installer. The app keeps itself up to date from this space.' },
  { label: 'Windows (MSI)', test: /\.msi$/, how: 'The same app as an MSI package, for managed installs.' },
]

function downloadsPage(release: Release, space: { name: string; origin: string }) {
  const files = KINDS.flatMap((k) => release.assets.filter((a) => k.test.test(a.name)).map((a) => ({ ...k, a })))
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`
  return page(`Get the ${esc(space.name)} app`, `
<h1>Get the app</h1>
<p class="lead">Version ${esc(release.version)}${release.published ? `, ${new Date(release.published * 1000).toISOString().slice(0, 10)}` : ''}. After installing, enter this space's address: <strong>${esc(new URL(space.origin).host)}</strong>.</p>
<ul>
${files.map((f) => `<li><a href="/api/app/download/${encodeURIComponent(f.a.name)}"><strong>${esc(f.label)}</strong>: ${esc(f.a.name)}</a> (${mb(f.a.size)})<br>${esc(f.how)}</li>`).join('\n')}
</ul>
<footer>${esc(space.name)}</footer>`)
}

/**
 * The native app, from this space (/api/app): the downloads page, the desktop updater's manifest and the files. Public
 * like the releases on GitHub used to be (the app holds nothing of the space's); downloads are rate-limited per address.
 */
export function releasesRoutes(releases: ReleasesService, space: { name: string; origin: string }, ip: (c: Context) => string) {
  return new Hono()
    .get('/', async (c) => c.html(downloadsPage(await releases.latest(), space)))
    .get('/latest.json', async (c) => c.json(await releases.manifest(), 200, { 'cache-control': 'no-store' }))
    .get('/download/:name', async (c) => {
      rateLimit(`app-download:${ip(c)}`, 40, 60 * 60_000)
      const name = c.req.param('name')
      if (!/^[\w.+-]{1,120}$/.test(name)) throw new AppError(404, 'not_found', 'No such file.')
      return releases.download(name)
    })
}
