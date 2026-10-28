import { argon2, createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// ---------- passwords: Argon2id in PHC format ----------

const PW = { m: 19456, t: 2, p: 1 } // OWASP minimum for server-side Argon2id

function argon2id(password: string, salt: Buffer, p: { m: number; t: number; p: number }, tagLength = 32): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    argon2('argon2id', { message: password, nonce: salt, memory: p.m, passes: p.t, parallelism: p.p, tagLength },
      (err, key) => (err ? reject(err) : resolve(key))))
}

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '')

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await argon2id(password, salt, PW)
  return `$argon2id$v=19$m=${PW.m},t=${PW.t},p=${PW.p}$${b64(salt)}$${b64(hash)}`
}

/** Re-derives with the params stored in the hash, so params can be raised later without breaking old hashes. */
export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(phc)
  if (!m) return false
  const expected = Buffer.from(m[5]!, 'base64')
  const actual = await argon2id(password, Buffer.from(m[4]!, 'base64'), { m: +m[1]!, t: +m[2]!, p: +m[3]! }, expected.length)
  return timingSafeEqual(actual, expected)
}

// ---------- base32 (RFC 4648, no padding) ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0, value = 0
  const out: number[] = []
  for (const ch of clean) {
    const i = B32.indexOf(ch)
    if (i < 0) throw new Error('invalid base32')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return Buffer.from(out)
}

// ---------- TOTP (RFC 6238, SHA-1, 30 s) ----------

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', secret).update(msg).digest()
  const off = h[h.length - 1]! & 0xf
  return String((h.readUInt32BE(off) & 0x7fffffff) % 10 ** digits).padStart(digits, '0')
}

export const totpStep = (now = Date.now()) => Math.floor(now / 30_000)

/**
 * Returns the matched time step, or null. Accepts one step of clock drift either way.
 * Steps <= lastStep are rejected so a code can't be replayed (RFC 6238 §5.2).
 */
export function verifyTotp(secret: Buffer, code: string, lastStep: number, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const step = totpStep(now)
  for (const s of [step - 1, step, step + 1]) {
    if (s > lastStep && timingSafeEqual(Buffer.from(hotp(secret, s)), Buffer.from(code))) return s
  }
  return null
}

export const newTotpSecret = () => randomBytes(20)

export function totpUri(secret: Buffer, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}

// ---------- tokens ----------

/** 256-bit random token for cookies, invites, share links. Store only sha256(token). */
export const newToken = () => randomBytes(32).toString('base64url')
export const sha256 = (s: string) => createHash('sha256').update(s).digest('base64url')

/** 80-bit one-time backup code, shown as XXXX-XXXX-XXXX-XXXX. Enough entropy to store as plain sha256. */
export const newBackupCode = () => base32Encode(randomBytes(10)).match(/.{4}/g)!.join('-')
export const normalizeBackupCode = (code: string) => code.toUpperCase().replace(/[^A-Z2-7]/g, '')

// ---------- secrets at rest: AES-256-GCM ----------

/** AAD binds the ciphertext to where it is stored (e.g. "totp:user:7"), so it can't be swapped between rows. */
export function seal(key: Buffer, plain: Buffer, aad: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(aad))
  const ct = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')
}

export function unseal(key: Buffer, sealed: string, aad: string): Buffer {
  const raw = Buffer.from(sealed, 'base64')
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12)).setAAD(Buffer.from(aad))
  d.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([d.update(raw.subarray(28)), d.final()])
}
