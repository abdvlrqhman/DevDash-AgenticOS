import { test } from 'node:test'
import assert from 'node:assert/strict'
import { externalUrl } from './open-outside.ts'

test('a framed service may ask DevDash to open only a real http(s) link outside it', () => {
  assert.equal(externalUrl({ type: 'devdash:open-external', url: 'https://youtu.be/dQw4w9WgXcQ' }), 'https://youtu.be/dQw4w9WgXcQ')
  assert.equal(externalUrl({ type: 'devdash:open-external', url: 'http://example.com/a b' }), 'http://example.com/a%20b')
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'devdash-shell://switch', 'intent://x#Intent;end', '/relative', '']) {
    assert.equal(externalUrl({ type: 'devdash:open-external', url }), null, url)
  }
  assert.equal(externalUrl({ type: 'something-else', url: 'https://x.io' }), null)
  assert.equal(externalUrl({ type: 'devdash:open-external' }), null)
  assert.equal(externalUrl('https://x.io'), null)
  assert.equal(externalUrl(null), null)
  assert.equal(externalUrl({ type: 'devdash:open-external', url: `https://x.io/${'a'.repeat(5000)}` }), null)
})
