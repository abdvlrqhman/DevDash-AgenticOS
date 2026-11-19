import { test } from 'node:test'
import assert from 'node:assert/strict'
import { plainReply, splitReply, VOICE_TAG_RE } from './reply.ts'

test('the chat shows what was said, then what was written', () => {
  assert.deepEqual(splitReply('Plain answer with <b>'), { spoken: '', written: 'Plain answer with <b>' })
  assert.deepEqual(splitReply('<voice>Two tasks. Links are in the chat.</voice>\n\n- [shop#1](/tasks/shop/1)'), { spoken: 'Two tasks. Links are in the chat.', written: '- [shop#1](/tasks/shop/1)' })
  assert.deepEqual(splitReply('<voice>Yes, it\'s deployed.</voice>'), { spoken: 'Yes, it\'s deployed.', written: '' })
  // Still streaming: an open block shows as it grows, half a tag never flashes.
  assert.deepEqual(splitReply('<voice>One sec'), { spoken: 'One sec', written: '' })
  assert.deepEqual(splitReply('Hi <vo'), { spoken: '', written: 'Hi' })
  assert.deepEqual(splitReply('<voice>Done.</voice> Details <'), { spoken: 'Done.', written: 'Details' })
  assert.deepEqual(splitReply('<voice>[chuckling] Morning! All good [sigh'), { spoken: 'Morning! All good', written: '' })
  assert.deepEqual(splitReply('<voice>See [the PR](/x).</voice>'), { spoken: 'See [the PR](/x).', written: '' })
  assert.equal(plainReply('<voice>Said.</voice>\nWritten.'), 'Said.\n\nWritten.')
  assert.equal('<devdash-voice lang="ar"/>\n\nhi'.replace(VOICE_TAG_RE, ''), 'hi')
})
