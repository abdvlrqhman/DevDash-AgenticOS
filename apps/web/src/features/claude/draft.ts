/**
 * A half-typed message, kept per session in the browser so switching sessions to check something and coming back
 * doesn't lose it. Text only — image/file attachments are in-memory blobs and aren't worth persisting. Every access is
 * guarded: private mode (or a full quota) throws on localStorage, and a dropped draft beats a crash.
 */
type DraftStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const browserStore = (): DraftStore | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export const draftKey = (sessionId: string) => `devdash:draft:${sessionId}`

export function loadDraft(sessionId: string, store: DraftStore | null = browserStore()): string {
  try {
    return store?.getItem(draftKey(sessionId)) ?? ''
  } catch {
    return ''
  }
}

export function saveDraft(sessionId: string, text: string, store: DraftStore | null = browserStore()): void {
  try {
    if (text) store?.setItem(draftKey(sessionId), text)
    else store?.removeItem(draftKey(sessionId))
  } catch {
    // Private mode or quota: losing a draft beats throwing on a keystroke.
  }
}
