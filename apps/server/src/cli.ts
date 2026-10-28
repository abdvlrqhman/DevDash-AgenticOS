// Admin CLI, run on the server (deploy/install.sh adds a `devdash` wrapper):
//   devdash invite --email you@example.com --username you --role admin
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig } from './core/config.ts'
import { openDb } from './core/db.ts'
import { z } from 'zod'
import { authService } from './modules/auth/service.ts'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { email: { type: 'string' }, username: { type: 'string' }, role: { type: 'string', default: 'member' } },
})

if (positionals[0] !== 'invite' || !z.email().safeParse(values.email).success || !values.username || !['admin', 'member'].includes(values.role)) {
  console.error('usage: devdash invite --email <email> --username <linux-username> [--role admin|member]')
  process.exit(2)
}

const config = loadConfig()
const db = openDb(join(config.dataDir, 'devdash.db'))
const auth = authService({ db, masterKey: config.masterKey, spaceName: config.spaceName })
const { token } = auth.createInvite({ email: values.email!, username: values.username, role: values.role as 'admin' | 'member' }, null, 'cli')
console.log(`Invite link (valid 7 days, single use):\n${config.origin}/invite/${token}`)
db.close()
