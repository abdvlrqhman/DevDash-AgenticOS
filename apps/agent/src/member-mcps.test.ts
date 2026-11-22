import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inventory, change, check } from './member-mcps.ts'
import { ops } from './skills.ts'

test('provider settings preserve unrelated fields, detect stale edits and keep credentials out of inventory', async () => {
  const old = process.env.HOME
  const dir = await mkdtemp(join(tmpdir(), 'dd-member-catalog-'))
  process.env.HOME = dir
  try {
    const oc = join(dir, '.config/opencode')
    await mkdir(oc, { recursive: true })
    const file = join(oc, 'opencode.jsonc')
    await writeFile(file, '// preserve this comment\n{"mcp":{"servers":{"remote":{"type":"remote","url":"https://old.test/private/path","headers":{"Authorization":"secret"}}}},"theme":"dark"}')
    const read = async (source: string) => (await inventory()).sources.find((s) => s.id === source)!.revision
    const initial = await inventory()
    assert.doesNotMatch(JSON.stringify(initial), /private\/path|Authorization|secret/)
    const revision = await read('opencode')
    const edit = { source: 'opencode', name: 'remote', action: 'edit', revision }
    await change({ ...edit, enabled: false })
    assert.match(await readFile(file, 'utf8'), /secret/)
    await assert.rejects(change(edit), /changed/)
    await change({ ...edit, revision: await read('opencode'), url: 'https://new.test/api' })
    const raw = await readFile(file, 'utf8')
    assert.match(raw, /preserve this comment/)
    assert.match(raw, /"theme":\s*"dark"/)
    assert.doesNotMatch(raw, /secret|old.test/)
    await mkdir(join(dir, '.codex'))
    const config = join(dir, '.codex/config.toml')
    await writeFile(config, '# retained\nmodel = "sample"\n')
    await change({ source: 'codex', name: 'one', revision: await read('codex'), action: 'create', command: ['native-server','--stdio'] })
    assert.ok((await inventory()).entries.some((e) => e.name === 'one' && e.transport === 'stdio' && e.enabled))
    assert.match(await readFile(config, 'utf8'), /# retained/)
    await change({ source: 'codex', name: 'one', revision: await read('codex'), action: 'remove' })
    assert.ok(!(await inventory()).entries.some((e) => e.name === 'one'))
    const script = join(dir, 'echo-mcp.mjs')
    await writeFile(script, `import { createInterface } from 'node:readline'
for await (const line of createInterface({input: process.stdin})) {
  const m = JSON.parse(line)
  if (m.method === 'initialize') console.log(JSON.stringify({ jsonrpc:'2.0', id:m.id, result:{
    protocolVersion:m.params.protocolVersion, capabilities:{}, serverInfo:{name:'fixture',version:'1'}
  } }))
}`)
    await change({ source: 'codex', name: 'fixture', revision: await read('codex'), action: 'create', command: [process.execPath, script] })
    assert.equal((await check({ source: 'codex', name: 'fixture', revision: await read('codex') })).status, 'Connected')
    const skill = join(dir, '.agents/skills/example')
    await mkdir(skill, { recursive: true })
    await writeFile(join(skill, 'SKILL.md'), '---\nname: example\ndescription: Example skill\n---\nInstructions')
    const { discovered } = await ops.list({})
    assert.equal(discovered?.length, 1)
    const readSkill = await ops.providerRead({ id: discovered![0]!.id })
    assert.match(readSkill.markdown, /Instructions/)
    assert.equal(readSkill.skill.name, 'example')
    assert.equal(readSkill.skill.description, 'Example skill')
    assert.deepEqual(readSkill.skill.sources, ['Shared agents'])
    assert.equal(readSkill.skill.files.length, 1)
    await assert.rejects(ops.providerRead({ id: '../config.toml' }))
  } finally {
    if (old === undefined) delete process.env.HOME
    else process.env.HOME = old
    await rm(dir, { recursive: true, force: true })
  }
})
