import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sharedEnv } from './shared-tools.ts'

test('the shared tools: caches always, SDKs once there, the team Flutter first on PATH; nothing without the folder', () => {
  const root = '/srv/devdash/shared'
  assert.deepEqual(sharedEnv(root, () => false), {}, 'no shared folder yet (before install.sh made it)')

  const bare = sharedEnv(root, (p) => p === root, '/usr/bin')
  assert.equal(bare.PUB_CACHE, `${root}/pub-cache`)
  assert.equal(bare.HF_HUB_CACHE, `${root}/huggingface/hub`)
  assert.equal(bare.HF_HOME, undefined, "the Hugging Face login stays each member's")
  assert.equal(bare.PLAYWRIGHT_SKIP_BROWSER_GC, '1')
  assert.equal(bare.ANDROID_HOME, undefined, 'no SDK there yet')
  assert.equal(bare.PATH, undefined)

  const there = new Set([root, `${root}/android-sdk`, `${root}/gradle-ro`, `${root}/flutter/bin/flutter`])
  const full = sharedEnv(root, (p) => there.has(p), `/usr/bin:${root}/flutter/bin:/bin`)
  assert.equal(full.ANDROID_HOME, `${root}/android-sdk`)
  assert.equal(full.ANDROID_SDK_ROOT, `${root}/android-sdk`)
  assert.equal(full.GRADLE_RO_DEP_CACHE, `${root}/gradle-ro`)
  assert.equal(full.PATH, `${root}/flutter/bin:/usr/bin:/bin`, 'first, once')
})
