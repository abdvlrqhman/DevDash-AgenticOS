import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effortLevels, groupModels, modelLabel, type ModelInfo } from './models.ts'

// The shape Claude Code reports (trimmed).
const list: ModelInfo[] = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', supportedEffortLevels: ['low', 'high'] },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6' },
  { value: 'claude-opus-4-8', displayName: 'Opus 4.8' },
  { value: 'claude-opus-5', displayName: 'Opus 5' },
  { value: 'claude-nova-1', displayName: 'Nova 1' }, // a family that doesn't exist yet
]

test('models group by family, newest first, the default says what it is', () => {
  const { defName, families } = groupModels(list)
  assert.equal(defName, 'Opus 5.5')
  assert.deepEqual(families.map((f) => f.name), ['Opus', 'Fable', 'Sonnet', 'Haiku', 'Nova'], 'in the order Claude Code ranks them')
  assert.deepEqual(families[0]!.rows.map((r) => r.displayName), ['Opus 5.5', 'Opus 5', 'Opus 4.8', 'Opus 4.6'])
  assert.equal(families[0]!.rows[0]!.newest, true, "'opus' always means the newest Opus")
  assert.deepEqual(families[3]!.rows[0]!.version, [4, 5], 'a release date is not a version')

  assert.equal(modelLabel(list, null), 'Default · Opus 5.5')
  assert.equal(modelLabel(list, 'claude-opus-4-8'), 'Opus 4.8')
  assert.equal(modelLabel(list, 'claude-opus-9-9'), 'claude-opus-9-9', 'an ID typed in by hand shows as itself')
  assert.equal(modelLabel([{ value: '', displayName: 'Default' }], ''), 'Default', 'the offline list has no resolved default')

  const all = ['low', 'medium', 'high', 'xhigh', 'max']
  assert.deepEqual(effortLevels(list, 'claude-haiku-4-5-20251001', all), ['low', 'high'])
  assert.deepEqual(effortLevels(list, 'fable', all), all, 'unknown support: offer everything')
})
