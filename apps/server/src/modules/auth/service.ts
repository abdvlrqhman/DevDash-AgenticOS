import { randomBytes } from 'node:crypto'
import type { Db } from '../../core/db.ts'
import { now } from '../../core/db.ts'
import { AppError, rateLimit } from '../../core/http.ts'
import {
  base32Encode, hashPassword, newBackupCode, newToken, newTotpSecret, normalizeBackupCode,
  seal, sha256, totpUri, unseal, verifyPassword, verifyTotp,
} from '../../core/crypto.ts'
import { authRepo, toUser, type Role, type User } from './repo.ts'

/** Same rule as deploy/bootstrap.sh: the DevDash username is also the member's Linux username. */
export const USERNAME_RE = /^[a-z][a-z0-9-]{1,30}$/
const RESERVED = new Set([
  'root', 'admin', 'devdash', 'caddy', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news',
  'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc', 'gnats', 'nobody', 'sshd', 'syslog', 'messagebus',
  'ubuntu', 'docker', 'lxd', 'polkitd', 'tss', 'uuidd', 'tcpdump', 'landscape', 'dnsmasq', 'pollinate', 'neko',
])
export const isAllowedUsername = (u: string) =>
  USERNAME_RE.test(u) && !RESERVED.has(u) && !u.startsWith('systemd-') && !u.startsWith('devdash') // same rules as deploy/helper

const DAY = 86_400
const REMEMBER_TTL = 30 * DAY
const IDLE_TTL = 12 * 3600
const INVITE_TTL = 7 * DAY
const TOUCH_EVERY = 60
const FIFTEEN_MIN = 15 * 60_000

type Meta = { ip: string; ua: string }
const invalidLogin = () => new AppError(401, 'invalid_login', 'Wrong email, password or code.')

export function authService(deps: { db: Db; masterKey: Buffer; spaceName: string }) {
  const repo = authRepo(deps.db)
  const key = deps.masterKey
  // Unknown emails still pay the Argon2 cost, so response time doesn't reveal which emails exist.
  const dummyHash = hashPassword(randomBytes(16).toString('hex'))

  function createSession(userId: number, remember: boolean, meta: Meta) {
    const token = newToken()
    repo.insertSession({ tokenHash: sha256(token), userId, remember, expiresAt: now() + (remember ? REMEMBER_TTL : IDLE_TTL), ...meta })
    return token
  }

  function openInvite(token: string) {
    const inv = repo.inviteByHash(sha256(token))
    if (!inv) throw new AppError(404, 'invite_not_found', 'This invite link is not valid.')
    if (inv.used_at || inv.expires_at < now()) throw new AppError(410, 'invite_expired', 'This invite was already used or has expired. Ask for a new one.')
    return { inv, secret: unseal(key, inv.totp_secret, `totp:invite:${inv.token_hash}`) }
  }

  return {
    async login(input: { login: string; password: string; code: string; remember: boolean }, meta: Meta) {
      rateLimit(`login:ip:${meta.ip}`, 20, FIFTEEN_MIN)
      rateLimit(`login:id:${input.login.toLowerCase()}`, 8, FIFTEEN_MIN)
      const u = repo.userByLogin(input.login.trim())
      const passwordOk = await verifyPassword(input.password, u?.password_hash ?? (await dummyHash))
      if (!u || !passwordOk || u.disabled_at) {
        repo.audit(u?.id ?? null, 'login.fail', input.login, meta.ip, { reason: 'password' })
        throw invalidLogin()
      }
      const code = input.code.trim()
      let secondFactor: 'totp' | 'backup_code'
      if (/^\d{6}$/.test(code)) {
        const step = verifyTotp(unseal(key, u.totp_secret, `totp:user:${u.id}`), code, u.totp_last_step)
        if (step === null || !repo.advanceTotpStep(u.id, step)) {
          repo.audit(u.id, 'login.fail', input.login, meta.ip, { reason: 'totp' })
          throw invalidLogin()
        }
        secondFactor = 'totp'
      } else {
        if (!repo.useBackupCode(u.id, sha256(normalizeBackupCode(code)))) {
          repo.audit(u.id, 'login.fail', input.login, meta.ip, { reason: 'backup_code' })
          throw invalidLogin()
        }
        secondFactor = 'backup_code'
      }
      repo.audit(u.id, 'login.ok', null, meta.ip, { secondFactor, remember: input.remember })
      return { token: createSession(u.id, input.remember, meta), user: toUser(u), remember: input.remember }
    },

    /** Validates a session cookie and slides its expiry. `refreshCookie` is true when a remembered cookie should be re-sent. */
    sessionUser(token: string | undefined): { user: User; remember: boolean; refreshCookie: boolean } | null {
      if (!token) return null
      const s = repo.sessionByHash(sha256(token))
      const t = now()
      if (!s || s.expires_at < t) return null
      const u = repo.userById(s.user_id)
      if (!u || u.disabled_at) return null
      const touch = t - s.last_seen_at >= TOUCH_EVERY
      if (touch) repo.touchSession(s.id, t, t + (s.remember ? REMEMBER_TTL : IDLE_TTL))
      return { user: toUser(u), remember: s.remember === 1, refreshCookie: touch && s.remember === 1 }
    },

    logout(token: string | undefined) {
      if (token) repo.deleteSession(sha256(token))
    },

    createInvite(input: { email: string; username: string; role: Role }, actorId: number | null, ip: string | null) {
      if (!isAllowedUsername(input.username)) throw new AppError(400, 'bad_username', 'Username must be 2–31 lowercase letters, digits or dashes, start with a letter, and not be a system name.')
      if (repo.userByEmail(input.email)) throw new AppError(409, 'email_taken', 'A member with this email already exists.')
      if (repo.usernameTaken(input.username)) throw new AppError(409, 'username_taken', 'This username is taken or has a pending invite.')
      const token = newToken()
      const tokenHash = sha256(token)
      repo.insertInvite({
        tokenHash, email: input.email, username: input.username, role: input.role,
        totpSecret: seal(key, newTotpSecret(), `totp:invite:${tokenHash}`),
        expiresAt: now() + INVITE_TTL, createdBy: actorId,
      })
      repo.audit(actorId, 'invite.create', input.email, ip, { username: input.username, role: input.role })
      return { token }
    },

    getInvite(token: string) {
      const { inv, secret } = openInvite(token)
      return {
        email: inv.email, username: inv.username, role: inv.role, spaceName: deps.spaceName,
        totpSecret: base32Encode(secret), totpUri: totpUri(secret, inv.email, deps.spaceName),
      }
    },

    async acceptInvite(token: string, input: { name: string; password: string; code: string }, meta: Meta) {
      rateLimit(`invite:ip:${meta.ip}`, 20, FIFTEEN_MIN)
      const { inv, secret } = openInvite(token)
      const step = verifyTotp(secret, input.code.trim(), 0)
      if (step === null) throw new AppError(400, 'bad_code', 'That code is not valid. Check the time on your phone and try again.')
      const passwordHash = await hashPassword(input.password)
      const backupCodes = Array.from({ length: 10 }, newBackupCode)
      const user = repo.transaction(() => {
        if (!repo.markInviteUsed(inv.id)) throw new AppError(410, 'invite_expired', 'This invite was already used.')
        if (repo.userByEmail(inv.email)) throw new AppError(409, 'email_taken', 'A member with this email already exists.')
        const id = repo.insertUser({ email: inv.email, username: inv.username, name: input.name.trim(), role: inv.role, passwordHash, totpLastStep: step })
        repo.setTotpSecret(id, seal(key, secret, `totp:user:${id}`))
        repo.insertBackupCodes(id, backupCodes.map((c) => sha256(normalizeBackupCode(c))))
        return toUser(repo.userById(id)!)
      })
      repo.audit(user.id, 'invite.accept', inv.email, meta.ip)
      return { token: createSession(user.id, false, meta), user, backupCodes }
    },

    /** Requires the current password; signs out every other device. Returns how many sessions were ended. */
    async changePassword(userId: number, current: string, next: string, keepToken: string, ip: string) {
      rateLimit(`password:${userId}`, 8, FIFTEEN_MIN)
      const u = repo.userById(userId)
      if (!u || !(await verifyPassword(current, u.password_hash))) {
        repo.audit(userId, 'password.change_fail', null, ip)
        throw new AppError(400, 'wrong_password', 'Your current password is not correct.')
      }
      repo.setPassword(userId, await hashPassword(next))
      const ended = repo.deleteOtherSessions(userId, sha256(keepToken))
      repo.audit(userId, 'password.change', null, ip, { endedSessions: ended })
      return ended
    },

    /** Requires the current password. */
    async changeEmail(userId: number, password: string, email: string, ip: string) {
      rateLimit(`password:${userId}`, 8, FIFTEEN_MIN)
      const u = repo.userById(userId)
      if (!u || !(await verifyPassword(password, u.password_hash))) throw new AppError(400, 'wrong_password', 'Your current password is not correct.')
      const taken = repo.userByEmail(email)
      if (taken && taken.id !== userId) throw new AppError(409, 'email_taken', 'Another member already uses this email.')
      repo.setEmail(userId, email)
      repo.audit(userId, 'email.change', email, ip)
      return toUser(repo.userById(userId)!)
    },

    /** Re-confirms identity for sensitive changes: current password plus a fresh 2FA code. */
    async confirm(userId: number, password: string, code: string, ip: string) {
      rateLimit(`password:${userId}`, 8, FIFTEEN_MIN)
      const u = repo.userById(userId)
      if (!u || !(await verifyPassword(password, u.password_hash))) {
        repo.audit(userId, 'confirm.fail', null, ip, { reason: 'password' })
        throw new AppError(400, 'wrong_password', 'Your DevDash password is not correct.')
      }
      const step = /^\d{6}$/.test(code) ? verifyTotp(unseal(key, u.totp_secret, `totp:user:${u.id}`), code, u.totp_last_step) : null
      if (step === null || !repo.advanceTotpStep(u.id, step)) {
        repo.audit(userId, 'confirm.fail', null, ip, { reason: 'totp' })
        throw new AppError(400, 'bad_code', 'That code is not valid. Wait for the next one and try again.')
      }
    },

    audit: (userId: number, action: string, ip: string) => repo.audit(userId, action, null, ip),

    /** Fresh 2FA check for sensitive actions (admin shell). Shares the replay guard with sign-in. */
    verifyFreshTotp(userId: number, code: string): boolean {
      rateLimit(`totp:${userId}`, 10, FIFTEEN_MIN)
      const u = repo.userById(userId)
      if (!u || !/^\d{6}$/.test(code)) return false
      const step = verifyTotp(unseal(key, u.totp_secret, `totp:user:${u.id}`), code, u.totp_last_step)
      return step !== null && repo.advanceTotpStep(u.id, step)
    },

    removeMember(actor: User, id: number, ip: string) {
      if (actor.id === id) throw new AppError(400, 'self', 'You cannot remove yourself.')
      const u = repo.userById(id)
      if (!u || u.disabled_at) throw new AppError(404, 'not_found', 'No such member.')
      repo.disable(id)
      repo.audit(actor.id, 'member.remove', u.username, ip, {})
    },
    members() {
      return { users: repo.listUsers(), invites: repo.pendingInvites() }
    },

    cleanup() {
      return repo.deleteExpiredSessions(now())
    },
  }
}

export type AuthService = ReturnType<typeof authService>
