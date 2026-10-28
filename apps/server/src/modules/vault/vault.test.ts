import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../core/db.ts'
import * as vc from '../../../../web/src/features/vault/crypto.ts'
import { vaultService } from './service.ts'

// Two members' browsers against the real server half: setup, first keys, sharing the team vault, rotation on removal.
test('vault: setup, team sharing and key rotation, all end to end', async () => {
  const db = openDb(':memory:')
  for (const [id, name] of [[1, 'ann'], [2, 'bob'], [3, 'cy']] as const) {
    db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (?, ?, ?, ?, 'x', 'x', 'member')").run(id, `${name}@x.io`, name, name)
  }
  const vault = vaultService({ db })

  // A member's browser: set up, then open vaults like VaultPage's openVaults does.
  async function join(userId: number, password: string) {
    const id = await vc.newIdentity(password, userId)
    vault.setup({ id: userId }, id.body)
    const { privateKey } = await vc.unlockIdentity(password, id.body, userId)
    const keys = new Map<number, { key: CryptoKey; version: number }>()
    const open = async () => {
      const r = vault.vaults({ id: userId })
      for (const v of r.vaults) {
        if (v.key) keys.set(v.id, { key: await vc.unwrap(v.key, privateKey, vc.wrapInfo(v.id, v.keyVersion, userId)), version: v.keyVersion })
        else if (v.fresh) {
          const key = await vc.newVaultKey()
          vault.init({ id: userId }, v.id, await vc.wrapFor(key, id.publicKey, vc.wrapInfo(v.id, v.keyVersion, userId)))
          keys.set(v.id, { key, version: v.keyVersion })
        }
      }
      return r
    }
    return { userId, publicKey: id.publicKey, keys, open }
  }

  const ann = await join(1, 'ann pw')
  const annView = await ann.open()
  const team = annView.vaults.find((v) => v.kind === 'team')!
  const personal = annView.vaults.find((v) => v.kind === 'personal')!
  assert.ok(ann.keys.get(team.id) && ann.keys.get(personal.id))

  const put = async (who: typeof ann, vaultId: number, itemId: string, value: unknown) => {
    const k = who.keys.get(vaultId)!
    vault.putItem({ id: who.userId }, vaultId, itemId, { keyVersion: k.version, ...(await vc.encryptItem(k.key, vaultId, itemId, value)) })
  }
  const read = async (who: typeof ann, vaultId: number) => {
    const k = who.keys.get(vaultId)!
    return Promise.all(vault.items({ id: who.userId }, vaultId).map((i) => vc.decryptItem(k.key, vaultId, i.id, { iv: i.iv, data: i.data })))
  }
  await put(ann, team.id, '00000000-0000-4000-8000-000000000001', { type: 'login', name: 'Staging DB', password: 's3cret' })
  await put(ann, personal.id, '00000000-0000-4000-8000-000000000002', { type: 'note', name: 'mine' })

  // Bob joins: no team key until someone who has it grants it.
  const bob = await join(2, 'bob pw')
  await bob.open()
  assert.ok(!bob.keys.get(team.id))
  assert.throws(() => vault.items({ id: 2 }, team.id), /key/)
  assert.throws(() => vault.items({ id: 2 }, personal.id), /No such vault/)
  const waiting = (await ann.open()).waiting
  assert.deepEqual(waiting.map((w) => w.userId), [2])
  for (const w of waiting) vault.grant({ id: 1 }, team.id, { userId: w.userId, keyVersion: 1, wrapped: await vc.wrapFor(ann.keys.get(team.id)!.key, w.publicKey, vc.wrapInfo(team.id, 1, w.userId)) })
  await bob.open()
  assert.deepEqual(await read(bob, team.id), [{ type: 'login', name: 'Staging DB', password: 's3cret' }])

  // Bob leaves: his keys go and the next unlock replaces the team key for the members who stay.
  vault.memberRemoved(2)
  db.prepare('update users set disabled_at = unixepoch() where id = 2').run()
  const r = await ann.open()
  const t = r.vaults.find((v) => v.kind === 'team')!
  assert.equal(t.needsRotation, true)
  const old = ann.keys.get(team.id)!
  const key = await vc.newVaultKey()
  const items = await Promise.all(vault.items({ id: 1 }, team.id).map(async (i) => ({ id: i.id, ...(await vc.encryptItem(key, team.id, i.id, await vc.decryptItem(old.key, team.id, i.id, { iv: i.iv, data: i.data }))) })))
  vault.rotate({ id: 1 }, team.id, { keyVersion: 2, items, keys: await Promise.all(r.members.map(async (m) => ({ userId: m.userId, wrapped: await vc.wrapFor(key, m.publicKey, vc.wrapInfo(team.id, 2, m.userId)) }))) })
  assert.deepEqual(r.members.map((m) => m.userId), [1], 'only members still on the team get the new key')
  await ann.open()
  assert.equal(ann.keys.get(team.id)!.version, 2)
  assert.deepEqual(await read(ann, team.id), [{ type: 'login', name: 'Staging DB', password: 's3cret' }])
  assert.equal(vault.vaults({ id: 1 }).vaults.find((v) => v.kind === 'team')!.needsRotation, false)
})
