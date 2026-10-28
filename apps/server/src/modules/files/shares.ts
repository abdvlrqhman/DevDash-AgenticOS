import { createReadStream, createWriteStream, mkdirSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Db } from '../../core/db.ts'
import { hashPassword, newToken, seal, sha256, unseal, verifyPassword } from '../../core/crypto.ts'
import { AppError } from '../../core/http.ts'
import type { User } from '../auth/repo.ts'

export const EXPIRY = { '1h': 3600, '1d': 86400, '7d': 7 * 86400, '30d': 30 * 86400, never: null } as const
export type Expiry = keyof typeof EXPIRY
const MAX_BYTES = 4 * 1024 ** 3 // ponytail: per-file cap; move big files to object storage if this ever pinches

type Row = {
  id: number; token_hash: string; token_sealed: string; name: string; size: number; source: string; password_hash: string | null
  expires_at: number | null; max_downloads: number | null; downloads: number; created_by: number; created_at: number; revoked_at: number | null
  creator_name: string; creator_username: string
}

/**
 * Share links. Creating one copies the file into the server's own storage, so the link is a fixed snapshot and the
 * server never needs to read members' files. Tokens are stored hashed (plus sealed, so the creator can copy it again).
 */
export function sharesService({ db, dataDir, masterKey, origin, exists }: {
  db: Db; dataDir: string; masterKey: Buffer; origin: string
  /** Asks the creator's agent whether a shared file is still there: false = gone, null = can't tell right now. */
  exists?: (username: string, path: string) => Promise<boolean | null>
}) {
  const dir = join(dataDir, 'shares')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = (id: number) => join(dir, String(id))
  const q = {
    insert: db.prepare(`insert into shares (token_hash, token_sealed, name, source, password_hash, expires_at, max_downloads, created_by)
      values (?, '', ?, ?, ?, ?, ?, ?) returning id`),
    finish: db.prepare('update shares set size = ?, token_sealed = ? where id = ?'),
    byHash: db.prepare('select s.*, u.name as creator_name, u.username as creator_username from shares s join users u on u.id = s.created_by where s.token_hash = ?'),
    byId: db.prepare('select s.*, u.name as creator_name, u.username as creator_username from shares s join users u on u.id = s.created_by where s.id = ?'),
    list: db.prepare(`select s.*, u.name as creator_name, u.username as creator_username from shares s join users u on u.id = s.created_by
      where s.revoked_at is null and (?1 = 1 or s.created_by = ?2) order by s.id desc limit 200`),
    revoke: db.prepare('update shares set revoked_at = unixepoch() where id = ?'),
    // Links made from a path, or from anything inside it when it is a folder.
    fromPath: db.prepare(`select id from shares where created_by = ?1 and revoked_at is null
      and (source = ?2 or substr(source, 1, length(?2) + 1) = ?2 || '/')`),
    remove: db.prepare('delete from shares where id = ?'),
    count: db.prepare('update shares set downloads = downloads + 1 where id = ?'),
    expired: db.prepare('select id from shares where revoked_at is null and expires_at is not null and expires_at < unixepoch() - 86400'),
  }
  const link = (r: Row) => `${origin}/s/${unseal(masterKey, r.token_sealed, `share:${r.id}`).toString()}`
  const live = (r: Row) => !r.revoked_at && (!r.expires_at || r.expires_at > Date.now() / 1000) && (!r.max_downloads || r.downloads < r.max_downloads)
  const dto = (r: Row) => ({
    id: r.id, name: r.name, size: r.size, source: r.source, hasPassword: !!r.password_hash, expiresAt: r.expires_at, maxDownloads: r.max_downloads,
    downloads: r.downloads, createdAt: r.created_at, creator: r.creator_name, active: live(r), url: link(r),
  })

  // A day after expiring, the copy goes; the row stays for the record.
  setInterval(() => {
    for (const { id } of q.expired.all() as { id: number }[]) { q.revoke.run(id); void rm(file(id), { force: true }) }
  }, 3_600_000).unref()

  return {
    /** Copies `body` into storage and returns the new link. */
    async create(user: Pick<User, 'id'>, input: { name: string; source: string; body: ReadableStream<Uint8Array>; password?: string; expires: Expiry; maxDownloads?: number | null }) {
      const token = newToken()
      const ttl = EXPIRY[input.expires]
      const { id } = q.insert.get(sha256(token), input.name.slice(0, 255), input.source.slice(0, 500), input.password ? await hashPassword(input.password) : null,
        ttl ? Math.floor(Date.now() / 1000) + ttl : null, input.maxDownloads ?? null, user.id) as { id: number }
      try {
        let bytes = 0
        const counted = Readable.fromWeb(input.body as never).on('data', (c: Buffer) => {
          bytes += c.length
          if (bytes > MAX_BYTES) counted.destroy(new AppError(400, 'too_big', 'Files up to 4 GB can be shared.'))
        })
        await pipeline(counted, createWriteStream(file(id), { mode: 0o600 }))
        q.finish.run((await stat(file(id))).size, seal(masterKey, Buffer.from(token), `share:${id}`), id)
      } catch (err) {
        q.remove.run(id)
        await rm(file(id), { force: true })
        throw err
      }
      return dto(q.byId.get(id) as Row)
    },

    list: (user: Pick<User, 'id' | 'role'>) => (q.list.all(user.role === 'admin' ? 1 : 0, user.id) as Row[]).map(dto),

    async revoke(user: Pick<User, 'id' | 'role'>, id: number) {
      const r = q.byId.get(id) as Row | undefined
      if (!r) throw new AppError(404, 'not_found', 'No such link.')
      if (r.created_by !== user.id && user.role !== 'admin') throw new AppError(403, 'forbidden', 'Only its creator or an admin can turn off this link.')
      q.revoke.run(id)
      await rm(file(id), { force: true })
    },

    /** Turns off the links made from a file or folder that was just deleted. Returns how many. */
    async revokeSource(user: Pick<User, 'id'>, path: string) {
      const ids = (q.fromPath.all(user.id, path.replace(/\/+$/, '')) as { id: number }[]).map((r) => r.id)
      for (const id of ids) { q.revoke.run(id); await rm(file(id), { force: true }) }
      return ids.length
    },

    /** The share behind a token, if it is live (not turned off, expired or used up). */
    lookup(token: string) {
      const r = q.byHash.get(sha256(token)) as Row | undefined
      return r && live(r) ? r : null
    },
    /**
     * For the public page: a live share whose file still exists. A link stops working once its file is deleted,
     * however it was deleted (Files, the terminal, Claude). If the creator's agent can't answer, the link keeps working.
     */
    async available(token: string) {
      const r = this.lookup(token)
      if (!r || !exists || !r.source.startsWith('/')) return r
      if ((await exists(r.creator_username, r.source)) !== false) return r
      q.revoke.run(r.id)
      await rm(file(r.id), { force: true })
      return null
    },
    async checkPassword(r: Row, password: string) {
      return !r.password_hash || (await verifyPassword(password, r.password_hash))
    },
    open(r: Row) {
      q.count.run(r.id)
      return Readable.toWeb(createReadStream(file(r.id))) as ReadableStream<Uint8Array>
    },
  }
}

export type SharesService = ReturnType<typeof sharesService>
export type ShareRow = Row
