import { useSyncExternalStore } from 'react'

/**
 * The unlocked vault: the member's private key and the vault keys, in this tab's memory. To spare retyping the vault
 * password, the private key can also stay on this device for a while (sliding: every use extends it), sealed with a
 * device key that can't be read out of the browser (a non-extractable AES key in IndexedDB). Lock forgets both.
 */
type Keys = Map<number, { key: CryptoKey; version: number }>
type State = { unlocked: false } | { unlocked: true; privateKey: CryptoKey; pkcs8: Uint8Array<ArrayBuffer>; keys: Keys }

export const REMEMBER_OPTIONS = [
  { minutes: 15, label: '15 minutes' }, { minutes: 60, label: '1 hour' }, { minutes: 480, label: '8 hours' },
  { minutes: 1440, label: '1 day' }, { minutes: 10080, label: '7 days' },
] as const
const PREF = 'devdash.vault.remember-minutes'
export const rememberMinutes = () => {
  try { return Number(localStorage.getItem(PREF)) || 1440 } catch { return 1440 }
}
export const setRememberMinutes = (m: number) => {
  try { localStorage.setItem(PREF, String(m)) } catch { /* not remembered */ }
  touch(true)
}

let state: State = { unlocked: false }
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }
let timer: ReturnType<typeof setTimeout> | undefined
let lastSaved = 0

// ── a tiny IndexedDB key-value store ────────────────────────────────────────────
function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('devdash-vault', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('kv')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode)
      const req = fn(tx.objectStore('kv'))
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => open.result.close()
    }
  })
}
const get = <T>(k: string) => idb<T | undefined>('readonly', (s) => s.get(k))
const put = (k: string, v: unknown) => idb('readwrite', (s) => s.put(v, k))
const del = (k: string) => idb('readwrite', (s) => s.delete(k))

async function deviceKey() {
  const existing = await get<CryptoKey>('device-key')
  if (existing) return existing
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  await put('device-key', key)
  return key
}

type Saved = { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer; expiresAt: number; userId: number }
let userIdForSave = 0

async function save() {
  if (!state.unlocked || !userIdForSave) return
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deviceKey(), state.pkcs8)
  await put('unlocked', { iv, data, expiresAt: Date.now() + rememberMinutes() * 60_000, userId: userIdForSave } satisfies Saved)
  lastSaved = Date.now()
}

/** Every use pushes the lock time back (saved at most once a minute). */
function touch(force = false) {
  if (!state.unlocked) return
  clearTimeout(timer)
  timer = setTimeout(() => vault.lock(), rememberMinutes() * 60_000)
  if (force || Date.now() - lastSaved > 60_000) void save().catch(() => {})
}
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => touch(), { passive: true, capture: true })

export const vault = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l)
    return () => void listeners.delete(l)
  },
  unlock(privateKey: CryptoKey, pkcs8: Uint8Array<ArrayBuffer>, userId: number) {
    state = { unlocked: true, privateKey, pkcs8, keys: new Map() }
    userIdForSave = userId
    touch(true)
    emit()
  },
  setKey(vaultId: number, key: CryptoKey, version: number) {
    if (!state.unlocked) return
    state = { ...state, keys: new Map(state.keys).set(vaultId, { key, version }) }
    emit()
  },
  /** Opens the vault without the password if this device still remembers it for this member. */
  async restore(userId: number) {
    if (state.unlocked) return true
    try {
      const s = await get<Saved>('unlocked')
      if (!s || s.userId !== userId || s.expiresAt < Date.now()) { if (s) await del('unlocked'); return false }
      const pkcs8 = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: s.iv }, await deviceKey(), s.data))
      const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
      vault.unlock(privateKey, pkcs8, userId)
      return true
    } catch {
      return false
    }
  },
  lock() {
    if (state.unlocked) state.pkcs8.fill(0)
    state = { unlocked: false }
    clearTimeout(timer)
    void del('unlocked').catch(() => {})
    emit()
  },
}

export const useVault = () => useSyncExternalStore(vault.subscribe, vault.get)

/** Copies a secret and clears the clipboard 30 seconds later (best effort: browsers only allow it while focused). */
export async function copySecret(value: string) {
  await navigator.clipboard.writeText(value)
  setTimeout(() => { if (document.hasFocus()) void navigator.clipboard.writeText('').catch(() => {}) }, 30_000)
}
