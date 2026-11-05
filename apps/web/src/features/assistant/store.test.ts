import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageTag } from './store.ts'

test("the page tag carries the path and heading, and a heading can't break out of it", () => {
  assert.equal(pageTag('/tasks/shop/12', 'Fix login'), '<devdash-page path="/tasks/shop/12" title="Fix login"/>')
  assert.equal(pageTag('/notes/3', 'A "quoted" <b>title</b>\n  & more'), '<devdash-page path="/notes/3" title="A &quot;quoted&quot; &lt;b&gt;title&lt;/b&gt; &amp; more"/>')
})
