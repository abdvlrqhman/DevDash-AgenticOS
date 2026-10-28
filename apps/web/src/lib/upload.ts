import { ApiError } from './api'

// Big files go up in pieces: Cloudflare caps one request at 100 MB, and a piece that fails can be sent again on its
// own (the server writes each at its offset). XHR rather than fetch, because only XHR reports upload progress.

export const PIECE = 32 * 1024 * 1024
const RETRIES = 8 // 2, 4, 8, 16, 30, 30, 30 s: about two minutes, longer than a deploy's restart

/** Worth waiting out: the network, a busy or restarting server, a member's agent restarting after a deploy. */
export const temporary = (status: number, code?: string) => status === 0 || status >= 500 || status === 429 || code === 'agent_unavailable'

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Cancelled', 'AbortError')) }, { once: true })
})

function sendOnce(url: string, body: Blob, onProgress: (loaded: number) => void, signal?: AbortSignal) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('POST', url)
    x.setRequestHeader('content-type', 'application/octet-stream')
    x.upload.onprogress = (e) => onProgress(e.loaded)
    x.onload = () => resolve({ status: x.status, text: x.responseText })
    x.onerror = () => resolve({ status: 0, text: '' }) // no answer at all: the network or a restarting server
    x.onabort = () => reject(new DOMException('Cancelled', 'AbortError'))
    signal?.addEventListener('abort', () => x.abort(), { once: true })
    x.send(body)
  })
}

/**
 * Uploads `file` in pieces to `url(offset)`, reporting the bytes sent so far. Retries a piece through blips and
 * restarts; stops on a real refusal (with the server's message) or when `signal` is aborted.
 */
export async function uploadInPieces(file: Blob, url: (offset: number) => string, onProgress: (sent: number) => void, signal?: AbortSignal) {
  for (let offset = 0; offset === 0 || offset < file.size; offset += PIECE) {
    const piece = file.slice(offset, offset + PIECE)
    for (let attempt = 1; ; attempt++) {
      const r = await sendOnce(url(offset), piece, (loaded) => onProgress(offset + loaded), signal)
      if (r.status >= 200 && r.status < 300) break
      let error: { code?: string; message?: string } = {}
      try { error = (JSON.parse(r.text) as { error?: typeof error }).error ?? {} } catch { /* not JSON (Cloudflare's page) */ }
      if (!temporary(r.status, error.code)) throw new ApiError(error.message ?? `Upload failed (${r.status})`, r.status, error.code ?? 'upload')
      if (attempt >= RETRIES) throw new ApiError('The server stayed out of reach for a few minutes. Try again shortly.', r.status, 'upload')
      onProgress(offset)
      await sleep(Math.min(30_000, 1000 * 2 ** attempt), signal)
    }
    if (file.size === 0) break
  }
  onProgress(file.size)
}

export const uploadId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
