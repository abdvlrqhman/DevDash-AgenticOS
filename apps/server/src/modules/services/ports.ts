import { readFileSync } from 'node:fs'

/**
 * Every TCP port something listens on, server-wide (any user, Docker included), from /proc/net/tcp{,6}.
 * Empty where /proc doesn't exist (development on Windows or macOS).
 */
export function listeningPorts(): { port: number; user: string }[] {
  const users = new Map<number, string>()
  try {
    for (const line of readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const [name, , uid] = line.split(':')
      if (name && uid) users.set(Number(uid), name)
    }
  } catch {
    return []
  }
  const found = new Map<number, string>()
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string
    try { text = readFileSync(file, 'utf8') } catch { continue }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/)
      if (f[3] !== '0A') continue // LISTEN
      const port = parseInt(f[1]!.split(':').pop()!, 16)
      if (!found.has(port)) found.set(port, users.get(Number(f[7])) ?? `uid ${f[7]}`)
    }
  }
  return [...found].map(([port, user]) => ({ port, user })).sort((a, b) => a.port - b.port)
}

/** Parses KEY=value lines; blank lines and # comments are skipped. PORT is DevDash's to set. */
export function parseEnv(text: string) {
  const out: [string, string][] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    const key = i > 0 ? line.slice(0, i).trim() : ''
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`"${line.slice(0, 40)}" is not KEY=value.`)
    if (key === 'PORT') throw new Error('PORT is set by DevDash. Remove it from the environment.')
    out.push([key, line.slice(i + 1)])
  }
  return out
}
