// The vault's cryptography. Runs only in the browser with WebCrypto; nothing here ever leaves it in the clear.
//
// password ──PBKDF2-SHA256 (600k)──▶ password key ──AES-GCM──▶ member's P-256 private key (stored sealed)
// vault key (random AES-256) ──ECDH(ephemeral, member public key) + HKDF──▶ wrapped per member
// item JSON ──AES-GCM(vault key, AAD = vault + item id)──▶ ciphertext on the server

const enc = new TextEncoder()
const dec = new TextDecoder()
const subtle = crypto.subtle
export const ITERATIONS = 600_000
const EC = { name: 'ECDH', namedCurve: 'P-256' } as const

export type Sealed = { iv: string; data: string }
export type Wrapped = { epk: string; iv: string; data: string }

export function b64(buf: ArrayBuffer | Uint8Array) {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n))

type Bytes = Uint8Array<ArrayBuffer>

async function seal(key: CryptoKey, plain: Bytes, aad: string): Promise<Sealed> {
  const iv = random(12)
  const data = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, plain)
  return { iv: b64(iv), data: b64(data) }
}
async function open(key: CryptoKey, s: Sealed, aad: string) {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(s.iv), additionalData: enc.encode(aad) }, key, unb64(s.data)))
}

async function passwordKey(password: string, salt: Bytes, iterations: number) {
  const base = await subtle.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
const identityAad = (userId: number) => `devdash:vault-identity:${userId}`

/** A new member key pair, its private half sealed with the vault password. */
export async function newIdentity(password: string, userId: number) {
  const pair = await subtle.generateKey(EC, true, ['deriveBits'])
  const salt = random(16)
  const pk = await passwordKey(password, salt, ITERATIONS)
  return {
    privateKey: pair.privateKey,
    publicKey: b64(await subtle.exportKey('spki', pair.publicKey)),
    body: {
      salt: b64(salt), iterations: ITERATIONS,
      publicKey: b64(await subtle.exportKey('spki', pair.publicKey)),
      privateKey: await seal(pk, new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey)), identityAad(userId)),
    },
  }
}

/** Opens the member's private key. A wrong password fails here (the seal doesn't verify). */
export async function unlockIdentity(password: string, me: { salt: string; iterations: number; privateKey: Sealed }, userId: number) {
  const pk = await passwordKey(password, unb64(me.salt), me.iterations)
  const pkcs8 = await open(pk, me.privateKey, identityAad(userId)).catch(() => { throw new Error('That vault password is not right.') })
  return { privateKey: await subtle.importKey('pkcs8', pkcs8, EC, false, ['deriveBits']), pkcs8 }
}

/** The same private key, sealed with a new password. */
export async function resealIdentity(pkcs8: Bytes, password: string, userId: number) {
  const salt = random(16)
  return { salt: b64(salt), iterations: ITERATIONS, privateKey: await seal(await passwordKey(password, salt, ITERATIONS), pkcs8, identityAad(userId)) }
}

export const newVaultKey = () => subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']) as Promise<CryptoKey>
export const wrapInfo = (vaultId: number, version: number, userId: number) => `devdash:vault:${vaultId}:v${version}:user:${userId}`

async function kek(shared: ArrayBuffer, info: string, usage: KeyUsage) {
  const base = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) }, base, { name: 'AES-GCM', length: 256 }, false, [usage])
}

/** Wraps a vault key for one member: only their private key can open it. */
export async function wrapFor(vaultKey: CryptoKey, recipientSpki: string, info: string): Promise<Wrapped> {
  const recipient = await subtle.importKey('spki', unb64(recipientSpki), EC, false, [])
  const eph = await subtle.generateKey(EC, true, ['deriveBits'])
  const shared = await subtle.deriveBits({ name: 'ECDH', public: recipient }, eph.privateKey, 256)
  const sealed = await seal(await kek(shared, info, 'encrypt'), new Uint8Array(await subtle.exportKey('raw', vaultKey)), info)
  return { epk: b64(await subtle.exportKey('spki', eph.publicKey)), ...sealed }
}

export async function unwrap(w: Wrapped, privateKey: CryptoKey, info: string) {
  const eph = await subtle.importKey('spki', unb64(w.epk), EC, false, [])
  const shared = await subtle.deriveBits({ name: 'ECDH', public: eph }, privateKey, 256)
  const raw = await open(await kek(shared, info, 'decrypt'), w, info)
  return subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

const itemAad = (vaultId: number, itemId: string) => `devdash:vault:${vaultId}:item:${itemId}`
export const encryptItem = async (key: CryptoKey, vaultId: number, itemId: string, value: unknown) =>
  seal(key, enc.encode(JSON.stringify(value)), itemAad(vaultId, itemId))
export const decryptItem = async <T>(key: CryptoKey, vaultId: number, itemId: string, s: Sealed) =>
  JSON.parse(dec.decode(await open(key, s, itemAad(vaultId, itemId)))) as T

/** RFC 6238 code from a base32 secret (or an otpauth:// URI). */
export async function totp(secret: string, now = Date.now()) {
  const uri = secret.startsWith('otpauth://') ? new URL(secret) : null
  const s = (uri?.searchParams.get('secret') ?? secret).toUpperCase().replace(/[\s=-]/g, '')
  const digits = Number(uri?.searchParams.get('digits')) || 6
  const period = Number(uri?.searchParams.get('period')) || 30
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const ch of s) {
    const v = alphabet.indexOf(ch)
    if (v < 0) throw new Error('Not a valid authenticator secret.')
    bits += v.toString(2).padStart(5, '0')
  }
  const key = new Uint8Array((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)))
  const counter = new DataView(new ArrayBuffer(8))
  counter.setBigUint64(0, BigInt(Math.floor(now / 1000 / period)))
  const h = new Uint8Array(await subtle.sign('HMAC', await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']), counter.buffer))
  const o = h[h.length - 1]! & 0xf
  const n = (((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 10 ** digits
  return { code: String(n).padStart(digits, '0'), remaining: period - (Math.floor(now / 1000) % period), period }
}

/** Unbiased random password from the chosen character sets. */
export function generatePassword(length = 20, sets = { lower: true, upper: true, digits: true, symbols: true }) {
  const pool = [
    sets.lower && 'abcdefghijkmnopqrstuvwxyz', sets.upper && 'ABCDEFGHJKLMNPQRSTUVWXYZ', sets.digits && '23456789', sets.symbols && '!@#$%^&*-_=+?',
  ].filter(Boolean).join('') || 'abcdefghijkmnopqrstuvwxyz'
  const out: string[] = []
  const limit = 256 - (256 % pool.length)
  while (out.length < length) for (const b of random(length * 2)) if (b < limit && out.length < length) out.push(pool[b % pool.length]!)
  return out.join('')
}
