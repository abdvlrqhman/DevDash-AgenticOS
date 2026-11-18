import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newestInLine } from './service.ts'

test("the browser's newest release is the highest patch of its pinned line, never a newer line", async () => {
  const urls: string[] = []
  const get = (async (url: string) => {
    urls.push(url)
    return new Response(JSON.stringify(url.includes('/token') ? { token: 't' } : { tags: ['latest', '3', '3.0.9', '3.1', '3.1.2', '3.1.10', '3.1.6', '3.2', '3.2.0', 'sha-abc'] }))
  }) as typeof fetch
  assert.equal(await newestInLine('ghcr.io/m1k1o/neko/chromium:3.1', get), '3.1.10')
  assert.deepEqual(urls, ['https://ghcr.io/token?scope=repository:m1k1o/neko/chromium:pull', 'https://ghcr.io/v2/m1k1o/neko/chromium/tags/list?n=1000'])
  assert.equal(await newestInLine('docker.io/library/nginx:1.27', get), null, 'only ghcr.io images')
  assert.equal(await newestInLine('ghcr.io/m1k1o/neko/chromium:latest', get), null, 'only a numeric line')
})
