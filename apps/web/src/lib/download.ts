import { toast } from 'sonner'

// Files made in the page (a converted image, a merged PDF, backup codes) saved to the device. A browser, the desktop app
// and the iPhone app save a blob: link themselves; the Android app's WebView can't, so it's handed the bytes in pieces
// (apps/shell/android/Downloads.kt) and puts the file in Downloads.

const PIECE = 768 * 1024 // 1 MB of base64 per call into the Android app

/** Bytes as base64, a slice at a time (String.fromCharCode takes only so many arguments). */
function base64(bytes: Uint8Array) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

async function saveInAndroidApp(blob: Blob, filename: string) {
  const android = window.DevDashAndroid!
  const failed = () => new Error(`Couldn't save ${filename} on this phone.`)
  const id = android.saveFileStart!(filename, blob.type || 'application/octet-stream')
  if (!id) throw failed()
  for (let at = 0; at < blob.size; at += PIECE) {
    if (!android.saveFilePiece!(id, base64(new Uint8Array(await blob.slice(at, at + PIECE).arrayBuffer())))) throw failed()
  }
  if (!android.saveFileEnd!(id)) throw failed()
}

/** Save a blob (or raw bytes) to the device. */
export function downloadBlob(data: Blob | Uint8Array | ArrayBuffer, filename: string, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime })
  if (window.DevDashAndroid?.saveFileStart) {
    void saveInAndroidApp(blob, filename).catch((e: Error) => toast.error(e.message))
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** Save several files one after another, spaced so browsers don't drop the later ones. */
export async function downloadAll(files: { blob: Blob; name: string }[]) {
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    if (!f) continue
    downloadBlob(f.blob, f.name)
    if (i < files.length - 1) await new Promise((r) => setTimeout(r, 350))
  }
}
