import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newestRelease } from './service.ts'

test("the browser's newest release is the highest x.y.z of the major version DevDash speaks, compared as numbers", async () => {
  const urls: string[] = []
  const get = (async (url: string) => {
    urls.push(url)
    return new Response(JSON.stringify(url.includes('/token') ? { token: 't' } : { tags: ['latest', '3', '3.1', '3.1.6', '3.2', '3.2.0', '3.10.1', '3.9.4', '4.0.0', 'sha-abc'] }))
  }) as typeof fetch
  assert.equal(await newestRelease('ghcr.io/m1k1o/neko/chromium:3.1', 3, get), '3.10.1')
  assert.deepEqual(urls, ['https://ghcr.io/token?scope=repository:m1k1o/neko/chromium:pull', 'https://ghcr.io/v2/m1k1o/neko/chromium/tags/list?n=1000'])
  assert.equal(await newestRelease('ghcr.io/m1k1o/neko/chromium:3.2.0', 4, get), '4.0.0')
  assert.equal(await newestRelease('ghcr.io/m1k1o/neko/chromium', 5, get), null)
  assert.equal(await newestRelease('docker.io/library/nginx:1.27', 1, get), null, 'only ghcr.io images')
})
