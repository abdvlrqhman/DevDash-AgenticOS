// Hashing. SHA-* come from Web Crypto (also present in node, so these are testable); MD5 isn't offered there,
// so we ship a compact, self-contained implementation.

export type HashAlgo = 'MD5' | 'SHA-1' | 'SHA-256' | 'SHA-512'

export async function hashText(algo: HashAlgo, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  if (algo === 'MD5') return md5(bytes)
  const digest = await crypto.subtle.digest(algo, bytes as BufferSource)
  return toHex(new Uint8Array(digest))
}

export async function hashBytes(algo: HashAlgo, bytes: Uint8Array): Promise<string> {
  if (algo === 'MD5') return md5(bytes)
  const digest = await crypto.subtle.digest(algo, bytes as BufferSource)
  return toHex(new Uint8Array(digest))
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** RFC 1321 MD5 over a byte array, returning lowercase hex. */
export function md5(input: Uint8Array): string {
  const rotl = (x: number, c: number) => (x << c) | (x >>> (32 - c))
  const add = (a: number, b: number) => (a + b) | 0

  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21]
  const K = new Int32Array(64)
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0

  const originalLen = input.length
  const bitLen = originalLen * 8
  const withPad = ((originalLen + 8) >> 6) + 1
  const bytes = new Uint8Array(withPad * 64)
  bytes.set(input)
  bytes[originalLen] = 0x80
  // Append the length as a 64-bit little-endian integer.
  for (let i = 0; i < 8; i++) bytes[withPad * 64 - 8 + i] = (bitLen / 2 ** (8 * i)) & 0xff

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  const M = new Int32Array(16)
  for (let chunk = 0; chunk < bytes.length; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      const j = chunk + i * 4
      M[i] = (bytes[j] ?? 0) | ((bytes[j + 1] ?? 0) << 8) | ((bytes[j + 2] ?? 0) << 16) | ((bytes[j + 3] ?? 0) << 24)
    }
    let A = a0, B = b0, C = c0, D = d0
    for (let i = 0; i < 64; i++) {
      let F: number, g: number
      if (i < 16) { F = (B & C) | (~B & D); g = i }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16 }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16 }
      else { F = C ^ (B | ~D); g = (7 * i) % 16 }
      F = add(add(add(F, A), K[i] ?? 0), M[g] ?? 0)
      A = D; D = C; C = B
      B = add(B, rotl(F, S[i] ?? 0))
    }
    a0 = add(a0, A); b0 = add(b0, B); c0 = add(c0, C); d0 = add(d0, D)
  }

  const out = new Uint8Array(16)
  ;[a0, b0, c0, d0].forEach((v, i) => {
    out[i * 4] = v & 0xff
    out[i * 4 + 1] = (v >>> 8) & 0xff
    out[i * 4 + 2] = (v >>> 16) & 0xff
    out[i * 4 + 3] = (v >>> 24) & 0xff
  })
  return toHex(out)
}
