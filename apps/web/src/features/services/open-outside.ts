/** What a framed service may ask: open a link outside DevDash (docs below, at useOpenOutside). */
export type OpenExternalMessage = { type: 'devdash:open-external'; url: string }

/** The http(s) address a framed service asked to open, or null if the message isn't that (or isn't safe to open). */
export function externalUrl(data: unknown): string | null {
  const m = data as Partial<OpenExternalMessage> | null
  if (!m || typeof m !== 'object' || m.type !== 'devdash:open-external' || typeof m.url !== 'string' || m.url.length > 4000) return null
  try {
    const u = new URL(m.url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}
