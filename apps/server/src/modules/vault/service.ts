import { transaction, type Db } from '../../core/db.ts'
import { AppError } from '../../core/http.ts'
import type { User } from '../auth/repo.ts'

type VaultUser = { user_id: number; salt: string; iterations: number; public_key: string; private_key: string }
type Vault = { id: number; kind: 'personal' | 'team'; owner_id: number | null; key_version: number; needs_rotation: number }
type Key = { vault_id: number; user_id: number; key_version: number; wrapped: string }
type Item = { id: string; vault_id: number; key_version: number; iv: string; data: string; updated_by: number | null; created_at: number; updated_at: number; updated_by_name: string | null }

const B64 = /^[A-Za-z0-9+/=_-]{1,20000}$/
const ID = /^[0-9a-f-]{36}$/

/**
 * The vault's server half. It never sees a password or a key in the clear: it keeps public keys, wrapped keys and
 * ciphertext, and decides only who may fetch what (a personal vault: its owner; the team vault: members holding its key).
 */
export function vaultService({ db }: { db: Db }) {
  const q = {
    me: db.prepare('select * from vault_users where user_id = ?'),
    insertMe: db.prepare('insert into vault_users (user_id, salt, iterations, public_key, private_key) values (?, ?, ?, ?, ?)'),
    updateMe: db.prepare('update vault_users set salt = ?, iterations = ?, private_key = ?, updated_at = unixepoch() where user_id = ?'),
    personal: db.prepare("select * from vaults where kind = 'personal' and owner_id = ?"),
    team: db.prepare("select * from vaults where kind = 'team'"),
    vault: db.prepare('select * from vaults where id = ?'),
    insertVault: db.prepare('insert into vaults (kind, owner_id) values (?, ?) returning id'),
    key: db.prepare('select * from vault_keys where vault_id = ? and user_id = ?'),
    putKey: db.prepare(`insert into vault_keys (vault_id, user_id, key_version, wrapped) values (?, ?, ?, ?)
      on conflict(vault_id, user_id) do update set key_version = excluded.key_version, wrapped = excluded.wrapped`),
    dropKeys: db.prepare('delete from vault_keys where vault_id = ?'),
    dropUserKeys: db.prepare('delete from vault_keys where user_id = ?'),
    pending: db.prepare(`select u.id, u.name, v.public_key from users u join vault_users v on v.user_id = u.id
      where u.disabled_at is null and not exists (select 1 from vault_keys k where k.vault_id = ? and k.user_id = u.id and k.key_version = ?)`),
    identities: db.prepare('select u.id, u.name, v.public_key from users u join vault_users v on v.user_id = u.id where u.disabled_at is null'),
    items: db.prepare('select i.*, u.name as updated_by_name from vault_items i left join users u on u.id = i.updated_by where i.vault_id = ?'),
    item: db.prepare('select * from vault_items where id = ?'),
    putItem: db.prepare(`insert into vault_items (id, vault_id, key_version, iv, data, updated_by) values (?, ?, ?, ?, ?, ?)
      on conflict(id) do update set key_version = excluded.key_version, iv = excluded.iv, data = excluded.data, updated_by = excluded.updated_by, updated_at = unixepoch()
      where vault_items.vault_id = excluded.vault_id`),
    dropItem: db.prepare('delete from vault_items where id = ? and vault_id = ?'),
    bumpVault: db.prepare('update vaults set key_version = ?, needs_rotation = 0 where id = ?'),
    flagTeam: db.prepare("update vaults set needs_rotation = 1 where kind = 'team'"),
  }
  const str = (v: unknown, what: string) => {
    if (typeof v !== 'string' || !B64.test(v)) throw new AppError(400, 'bad_vault_data', `Invalid ${what}.`)
    return v
  }
  const wrappedJson = (v: unknown) => {
    const o = v as { epk?: unknown; iv?: unknown; data?: unknown }
    return JSON.stringify({ epk: str(o?.epk, 'key'), iv: str(o?.iv, 'iv'), data: str(o?.data, 'wrapped key') })
  }

  /** The vault if this member may use it, with their wrapped key. */
  function access(user: Pick<User, 'id'>, vaultId: number) {
    const v = q.vault.get(vaultId) as Vault | undefined
    if (!v || (v.kind === 'personal' && v.owner_id !== user.id)) throw new AppError(404, 'not_found', 'No such vault.')
    const k = q.key.get(vaultId, user.id) as Key | undefined
    if (!k) throw new AppError(403, 'no_access', 'You don\'t have this vault\'s key yet. A teammate who has it gives you access when they unlock.')
    return { v, k }
  }

  return {
    me(user: Pick<User, 'id'>) {
      const m = q.me.get(user.id) as VaultUser | undefined
      return m ? { setup: true as const, salt: m.salt, iterations: m.iterations, publicKey: m.public_key, privateKey: JSON.parse(m.private_key) as { iv: string; data: string } } : { setup: false as const }
    },

    /**
     * First step of setting up: the member's key pair and their personal vault (and the team vault if nobody made one).
     * The browser then sends each new vault's first key (init), wrapped for this vault's id.
     */
    setup(user: Pick<User, 'id'>, b: { salt: string; iterations: number; publicKey: string; privateKey: { iv: string; data: string } }) {
      if (q.me.get(user.id)) throw new AppError(409, 'exists', 'Your vault is already set up.')
      if (!Number.isInteger(b.iterations) || b.iterations < 300_000) throw new AppError(400, 'weak', 'Too few iterations.')
      transaction(db, () => {
        q.insertMe.run(user.id, str(b.salt, 'salt'), b.iterations, str(b.publicKey, 'public key'), JSON.stringify({ iv: str(b.privateKey?.iv, 'iv'), data: str(b.privateKey?.data, 'private key') }))
        q.insertVault.get('personal', user.id)
        if (!q.team.get()) q.insertVault.get('team', null)
      })
      return this.vaults(user)
    },

    /** A vault's very first key: your own personal vault, or a team vault nobody holds a key for yet. */
    init(user: Pick<User, 'id'>, vaultId: number, wrapped: unknown) {
      const v = q.vault.get(vaultId) as Vault | undefined
      if (!v || (v.kind === 'personal' && v.owner_id !== user.id)) throw new AppError(404, 'not_found', 'No such vault.')
      const anyKey = db.prepare('select 1 from vault_keys where vault_id = ? limit 1').get(vaultId)
      if (anyKey) throw new AppError(409, 'has_key', 'This vault already has a key.')
      q.putKey.run(vaultId, user.id, v.key_version, wrappedJson(wrapped))
    },

    changePassword(user: Pick<User, 'id'>, b: { salt: string; iterations: number; privateKey: { iv: string; data: string } }) {
      if (!q.me.get(user.id)) throw new AppError(404, 'not_setup', 'Set up your vault first.')
      q.updateMe.run(str(b.salt, 'salt'), b.iterations, JSON.stringify({ iv: str(b.privateKey?.iv, 'iv'), data: str(b.privateKey?.data, 'private key') }), user.id)
    },

    /** The vaults this member can open, plus teammates still waiting for the team vault's key. */
    vaults(user: Pick<User, 'id'>) {
      const list = [q.personal.get(user.id), q.team.get()].filter(Boolean) as Vault[]
      const team = q.team.get() as Vault | undefined
      const teamKey = team ? (q.key.get(team.id, user.id) as Key | undefined) : undefined
      return {
        vaults: list.map((v) => {
          const k = q.key.get(v.id, user.id) as Key | undefined
          const fresh = !db.prepare('select 1 from vault_keys where vault_id = ? limit 1').get(v.id)
          return { id: v.id, kind: v.kind, keyVersion: v.key_version, needsRotation: v.needs_rotation === 1, fresh, key: k && k.key_version === v.key_version ? JSON.parse(k.wrapped) : null }
        }),
        // Members with a vault identity but no current team key: whoever unlocks next wraps the key for them.
        waiting: team && teamKey ? (q.pending.all(team.id, team.key_version) as { id: number; name: string; public_key: string }[])
          .filter((m) => m.id !== user.id).map((m) => ({ userId: m.id, name: m.name, publicKey: m.public_key })) : [],
        teamVaultExists: !!team,
        // Everyone who keeps the team vault when its key is replaced (active members with a vault).
        members: team && teamKey ? (q.identities.all() as { id: number; name: string; public_key: string }[]).map((m) => ({ userId: m.id, name: m.name, publicKey: m.public_key })) : [],
      }
    },

    grant(user: Pick<User, 'id'>, vaultId: number, b: { userId: number; keyVersion: number; wrapped: unknown }) {
      const { v } = access(user, vaultId)
      if (v.kind !== 'team') throw new AppError(400, 'personal', 'Personal vaults are not shared.')
      if (b.keyVersion !== v.key_version) throw new AppError(409, 'stale', 'The vault key changed. Reload and try again.')
      if (!q.me.get(b.userId)) throw new AppError(404, 'not_found', 'That member has not set up a vault.')
      q.putKey.run(vaultId, b.userId, v.key_version, wrappedJson(b.wrapped))
    },

    items(user: Pick<User, 'id'>, vaultId: number) {
      access(user, vaultId)
      return (q.items.all(vaultId) as Item[]).map((i) => ({ id: i.id, keyVersion: i.key_version, iv: i.iv, data: i.data, updatedAt: i.updated_at, updatedBy: i.updated_by_name }))
    },

    putItem(user: Pick<User, 'id'>, vaultId: number, id: string, b: { keyVersion: number; iv: string; data: string }) {
      const { v } = access(user, vaultId)
      if (!ID.test(id)) throw new AppError(400, 'bad_id', 'Invalid item id.')
      if (b.keyVersion !== v.key_version) throw new AppError(409, 'stale', 'The vault key changed. Reload and try again.')
      const existing = q.item.get(id) as Item | undefined
      if (existing && existing.vault_id !== vaultId) throw new AppError(409, 'conflict', 'That item belongs to another vault.')
      if (typeof b.data !== 'string' || b.data.length > 200_000) throw new AppError(400, 'too_big', 'This item is too large.')
      q.putItem.run(id, vaultId, v.key_version, str(b.iv, 'iv'), b.data, user.id)
    },

    removeItem(user: Pick<User, 'id'>, vaultId: number, id: string) {
      access(user, vaultId)
      q.dropItem.run(id, vaultId)
    },

    /** A new key for a vault: every item re-encrypted and the key wrapped for everyone who keeps access, all at once. */
    rotate(user: Pick<User, 'id'>, vaultId: number, b: { keyVersion: number; keys: { userId: number; wrapped: unknown }[]; items: { id: string; iv: string; data: string }[] }) {
      const { v } = access(user, vaultId)
      if (b.keyVersion !== v.key_version + 1) throw new AppError(409, 'stale', 'Someone else just changed this vault. Reload and try again.')
      const current = new Set((q.items.all(vaultId) as Item[]).map((i) => i.id))
      if (b.items.length !== current.size || b.items.some((i) => !current.has(i.id))) throw new AppError(409, 'stale', 'Items changed while rotating. Reload and try again.')
      if (!b.keys.some((k) => k.userId === user.id)) throw new AppError(400, 'self', 'Keep a key for yourself.')
      transaction(db, () => {
        q.dropKeys.run(vaultId)
        for (const k of b.keys) q.putKey.run(vaultId, k.userId, b.keyVersion, wrappedJson(k.wrapped))
        for (const i of b.items) q.putItem.run(i.id, vaultId, b.keyVersion, str(i.iv, 'iv'), i.data, user.id)
        q.bumpVault.run(b.keyVersion, vaultId)
      })
    },

    /** A member left: their keys go, and the team vault asks for a new key on the next unlock. */
    memberRemoved(userId: number) {
      q.dropUserKeys.run(userId)
      q.flagTeam.run()
    },
  }
}

export type VaultService = ReturnType<typeof vaultService>
