import { test } from 'node:test'
import assert from 'node:assert/strict'
import { githubRepo } from './service.ts'

test('githubRepo reads owner/repo from https and ssh remotes only for github.com', () => {
  assert.equal(githubRepo('https://github.com/acme/shop.git'), 'acme/shop')
  assert.equal(githubRepo('https://github.com/acme/shop'), 'acme/shop')
  assert.equal(githubRepo('git@github.com:acme/my.app.git'), 'acme/my.app')
  assert.equal(githubRepo('https://gitlab.com/acme/shop.git'), null)
  assert.equal(githubRepo(null), null)
})
