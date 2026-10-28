import type { Db } from '../../core/db.ts'

export type Role = 'admin' | 'member'
export type User = { id: number; email: string; username: string; name: string; role: Role }

export type UserRow = User & {
  password_hash: string
  totp_secret: string
  totp_last_step: number
  created_at: number
  disabled_at: number | null
}

export type InviteRow = {
  id: number
  token_hash: string
  email: string
  username: string
  role: Role
  totp_secret: string
  expires_at: number
  used_at: number | null
}

export type SessionRow = { id: number; user_id: number; remember: number; expires_at: number; last_seen_at: number }

export const toUser = ({ id, email, username, name, role }: User): User => ({ id, email, username, name, role })

export function authRepo(db: Db) {
  const s = {
    userByEmail: db.prepare('select * from users where email = ?'),
    userByLogin: db.prepare('select * from users where email = ?1 or username = lower(?1)'),
    setEmail: db.prepare('update users set email = ? where id = ?'),
    userById: db.prepare('select * from users where id = ?'),
    usernameTaken: db.prepare(`select 1 from users where username = ?1
      union all select 1 from invites where username = ?1 and used_at is null and expires_at > unixepoch()`),
    insertUser: db.prepare(`insert into users (email, username, name, role, password_hash, totp_secret, totp_last_step)
      values (?, ?, ?, ?, ?, '', ?)`),
    setTotpSecret: db.prepare('update users set totp_secret = ? where id = ?'),
    advanceTotpStep: db.prepare('update users set totp_last_step = ?1 where id = ?2 and totp_last_step < ?1'),
    listUsers: db.prepare('select id, email, username, name, role, created_at, disabled_at, provisioned_at, provision_error from users where disabled_at is null order by created_at'),
    setPassword: db.prepare('update users set password_hash = ? where id = ?'),
    disable: db.prepare('update users set disabled_at = unixepoch() where id = ? and disabled_at is null'),
    deleteAllSessions: db.prepare('delete from sessions where user_id = ?'),
    deleteOtherSessions: db.prepare('delete from sessions where user_id = ? and token_hash != ?'),
    insertBackupCode: db.prepare('insert into backup_codes (user_id, code_hash) values (?, ?)'),
    useBackupCode: db.prepare('update backup_codes set used_at = unixepoch() where user_id = ? and code_hash = ? and used_at is null'),
    insertSession: db.prepare(`insert into sessions (token_hash, user_id, remember, expires_at, last_seen_at, ip, user_agent)
      values (?, ?, ?, ?, ?, ?, ?)`),
    sessionByHash: db.prepare('select id, user_id, remember, expires_at, last_seen_at from sessions where token_hash = ?'),
    touchSession: db.prepare('update sessions set last_seen_at = ?, expires_at = ? where id = ?'),
    deleteSession: db.prepare('delete from sessions where token_hash = ?'),
    deleteExpiredSessions: db.prepare('delete from sessions where expires_at < ?'),
    insertInvite: db.prepare(`insert into invites (token_hash, email, username, role, totp_secret, expires_at, created_by)
      values (?, ?, ?, ?, ?, ?, ?)`),
    inviteByHash: db.prepare('select * from invites where token_hash = ?'),
    markInviteUsed: db.prepare('update invites set used_at = unixepoch() where id = ? and used_at is null'),
    pendingInvites: db.prepare(`select id, email, username, role, expires_at, created_at from invites
      where used_at is null and expires_at > unixepoch() order by created_at desc`),
    audit: db.prepare('insert into audit (actor_id, action, target, ip, meta) values (?, ?, ?, ?, ?)'),
  }

  return {
    userByEmail: (email: string) => s.userByEmail.get(email) as UserRow | undefined,
    /** Sign-in identifier: email (case-insensitive) or username. */
    userByLogin: (login: string) => s.userByLogin.get(login) as UserRow | undefined,
    setEmail: (id: number, email: string) => void s.setEmail.run(email, id),
    userById: (id: number) => s.userById.get(id) as UserRow | undefined,
    usernameTaken: (username: string) => s.usernameTaken.get(username) !== undefined,
    insertUser: (u: Omit<User, 'id'> & { passwordHash: string; totpLastStep: number }) =>
      Number(s.insertUser.run(u.email, u.username, u.name, u.role, u.passwordHash, u.totpLastStep).lastInsertRowid),
    setTotpSecret: (id: number, sealed: string) => void s.setTotpSecret.run(sealed, id),
    /** Atomic replay guard: false if this step (or a later one) was already used. */
    advanceTotpStep: (id: number, step: number) => s.advanceTotpStep.run(step, id).changes === 1,
    listUsers: () => s.listUsers.all() as (User & { created_at: number; disabled_at: number | null; provisioned_at: number | null; provision_error: string | null })[],
    setPassword: (id: number, hash: string) => void s.setPassword.run(hash, id),
    /** Signs the member out everywhere and blocks sign-in. Their Linux account and files stay. */
    disable(id: number) {
      s.disable.run(id)
      s.deleteAllSessions.run(id)
    },
    deleteOtherSessions: (userId: number, keepHash: string) => Number(s.deleteOtherSessions.run(userId, keepHash).changes),
    insertBackupCodes: (userId: number, hashes: string[]) => hashes.forEach((h) => s.insertBackupCode.run(userId, h)),
    useBackupCode: (userId: number, hash: string) => s.useBackupCode.run(userId, hash).changes === 1,
    insertSession: (v: { tokenHash: string; userId: number; remember: boolean; expiresAt: number; ip: string; ua: string }) =>
      void s.insertSession.run(v.tokenHash, v.userId, v.remember ? 1 : 0, v.expiresAt, Math.floor(Date.now() / 1000), v.ip, v.ua),
    sessionByHash: (hash: string) => s.sessionByHash.get(hash) as SessionRow | undefined,
    touchSession: (id: number, lastSeen: number, expiresAt: number) => void s.touchSession.run(lastSeen, expiresAt, id),
    deleteSession: (hash: string) => void s.deleteSession.run(hash),
    deleteExpiredSessions: (t: number) => Number(s.deleteExpiredSessions.run(t).changes),
    insertInvite: (v: { tokenHash: string; email: string; username: string; role: Role; totpSecret: string; expiresAt: number; createdBy: number | null }) =>
      void s.insertInvite.run(v.tokenHash, v.email, v.username, v.role, v.totpSecret, v.expiresAt, v.createdBy),
    inviteByHash: (hash: string) => s.inviteByHash.get(hash) as InviteRow | undefined,
    markInviteUsed: (id: number) => s.markInviteUsed.run(id).changes === 1,
    pendingInvites: () => s.pendingInvites.all() as Omit<InviteRow, 'token_hash' | 'totp_secret' | 'used_at'>[],
    audit: (actorId: number | null, action: string, target: string | null, ip: string | null, meta?: unknown) =>
      void s.audit.run(actorId, action, target, ip, meta === undefined ? null : JSON.stringify(meta)),
    transaction<T>(fn: () => T): T {
      db.exec('begin')
      try {
        const r = fn()
        db.exec('commit')
        return r
      } catch (err) {
        db.exec('rollback')
        throw err
      }
    },
  }
}

export type AuthRepo = ReturnType<typeof authRepo>
