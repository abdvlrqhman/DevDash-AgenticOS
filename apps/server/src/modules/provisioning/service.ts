import { join } from 'node:path'
import type { Db } from '../../core/db.ts'
import { now } from '../../core/db.ts'
import { requestLine } from '../../core/unix.ts'
import { z } from 'zod'
import type { User } from '../auth/repo.ts'

/**
 * Keeps each member's Linux account in step with DevDash via the root helper (deploy/helper).
 * Never blocks sign-in: failures are stored on the user row and retried on the next server start.
 */
export function provisioningService({ db, runDir, onReady }: { db: Db; runDir: string; onReady?: (username: string) => void }) {
  const s = {
    set: db.prepare('update users set provisioned_at = ?, provision_error = ? where id = ?'),
    pending: db.prepare('select id, email, username, name, role from users where disabled_at is null'),
  }

  async function ensure(u: User) {
    if (!runDir) return void s.set.run(now(), null, u.id) // dev machine: no host integration
    try {
      const r = await requestLine<{ ok: boolean; error?: string }>(join(runDir, 'helper.sock'), {
        cmd: 'user-ensure',
        args: {
          username: u.username,
          name: u.name.replace(/[:,\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80) || u.username,
          ...(z.email().safeParse(u.email).success ? { email: u.email } : {}), // git identity is skipped without one
          admin: u.role === 'admin',
        },
      }, 120_000)
      if (!r.ok) throw new Error(r.error)
      s.set.run(now(), null, u.id)
      onReady?.(u.username)
    } catch (err) {
      const msg = (err as Error).message.slice(0, 300)
      s.set.run(null, msg, u.id)
      console.error(`provisioning ${u.username} failed: ${msg}`)
    }
  }

  return {
    ensure,
    /** Linux password for an admin (sudo in the admin shell). The password only passes through to chpasswd. */
    async setServerPassword(username: string, password: string) {
      if (!runDir) throw new Error('This needs DevDash running on its Linux server.')
      const r = await requestLine<{ ok: boolean; error?: string }>(join(runDir, 'helper.sock'), { cmd: 'set-password', args: { username, password } }, 30_000)
      if (!r.ok) throw new Error(r.error?.replace(/^refused: /, '') ?? 'Could not set the password.')
    },
    /** Lets every member run git in a shared checkout (see the helper's git-safe-dir). */
    async gitSafeDir(path: string) {
      if (!runDir) return
      const r = await requestLine<{ ok: boolean; error?: string }>(join(runDir, 'helper.sock'), { cmd: 'git-safe-dir', args: { path } }, 30_000)
      if (!r.ok) throw new Error(r.error ?? 'Could not register the project folder.')
    },
    usernames: () => (s.pending.all() as User[]).map((u) => u.username),
    /** Idempotent: re-applies every active member (role changes, missed sign-ups, a fresh host). */
    async reconcileAll() {
      for (const u of s.pending.all() as User[]) await ensure(u)
    },
  }
}

export type ProvisioningService = ReturnType<typeof provisioningService>
