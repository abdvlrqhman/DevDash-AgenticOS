// Google OAuth and the few Drive calls DevDash makes itself (the folder, the quota). Moving files is rclone's job, in
// the member's own account. `fetch` is passed in so tests run without the network.

/** drive.file: only files DevDash creates (or the member picks), never the rest of their Drive. Non-sensitive, so the
 * Google app can be published without Google's review (an app left in "Testing" loses access every 7 days). */
export const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file']
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const DRIVE = 'https://www.googleapis.com/drive/v3'
const FOLDER = 'application/vnd.google-apps.folder'
export const FOLDER_NAME = 'DevDash'

export type GoogleApp = { clientId: string; clientSecret: string }
export type Fetch = typeof fetch

/** A Google error by its OAuth code (invalid_grant: the member revoked access or the token expired). */
export class GoogleError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** Where the member's browser goes to grant access. PKCE (S256) and a single-use state guard the round trip. */
export function authUrl(app: GoogleApp, redirectUri: string, state: string, challenge: string) {
  const q = new URLSearchParams({
    client_id: app.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', // offline + consent: a refresh token every time, not only the first
    state, code_challenge: challenge, code_challenge_method: 'S256',
  })
  return `${AUTH_URL}?${q}`
}

async function post(f: Fetch, url: string, form: Record<string, string>) {
  const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new GoogleError(String(body.error ?? res.status), String(body.error_description ?? body.error ?? `Google answered ${res.status}`))
  return body
}

/** The signed-in Google account, from the id_token the token endpoint just sent (straight from Google over TLS). */
function account(idToken: unknown) {
  try {
    const claims = JSON.parse(Buffer.from(String(idToken).split('.')[1]!, 'base64url').toString()) as { sub?: string; email?: string }
    if (claims.sub && claims.email) return { sub: claims.sub, email: claims.email }
  } catch { /* fall through */ }
  throw new GoogleError('no_account', 'Google did not say which account this is.')
}

/** Trades the one-time code for tokens. The member must have ticked Drive access (Google lets them untick scopes). */
export async function exchangeCode(f: Fetch, app: GoogleApp, redirectUri: string, code: string, verifier: string) {
  const t = await post(f, TOKEN_URL, {
    code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier,
  })
  if (!String(t.scope ?? '').split(' ').includes(DRIVE_FILE)) {
    throw new GoogleError('no_drive_scope', 'Google Drive access was not granted. Connect again and tick the Drive permission.')
  }
  if (typeof t.refresh_token !== 'string') throw new GoogleError('no_refresh_token', 'Google did not give long-term access. Try connecting again.')
  return { refreshToken: t.refresh_token, accessToken: String(t.access_token), expiresIn: Number(t.expires_in) || 3600, ...account(t.id_token) }
}

/** A fresh access token (about an hour) from the refresh token. */
export async function refresh(f: Fetch, app: GoogleApp, refreshToken: string) {
  const t = await post(f, TOKEN_URL, { client_id: app.clientId, client_secret: app.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
  return { accessToken: String(t.access_token), expiresIn: Number(t.expires_in) || 3600 }
}

/** Ends DevDash's access to the account (best effort: a token Google already dropped is fine). */
export async function revoke(f: Fetch, token: string) {
  await post(f, REVOKE_URL, { token }).catch(() => {})
}

async function drive(f: Fetch, accessToken: string, path: string, init: RequestInit = {}) {
  const res = await f(`${DRIVE}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${accessToken}` } })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const e = body.error as { message?: string; status?: string } | undefined
    throw new GoogleError(e?.status ?? String(res.status), e?.message ?? `Google Drive answered ${res.status}`)
  }
  return body
}

/** The member's "DevDash" folder: the one DevDash made before (drive.file only lists DevDash's own files), or a new one. */
export async function ensureFolder(f: Fetch, accessToken: string) {
  const q = `name = '${FOLDER_NAME}' and mimeType = '${FOLDER}' and 'root' in parents and trashed = false`
  const found = await drive(f, accessToken, `/files?${new URLSearchParams({ q, fields: 'files(id)', spaces: 'drive', pageSize: '1' })}`)
  const id = (found.files as { id: string }[] | undefined)?.[0]?.id
  if (id) return id
  const made = await drive(f, accessToken, '/files?fields=id', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER }),
  })
  return String(made.id)
}

/** Bytes used and the account's limit (null: unlimited). Shared with Gmail and Photos on personal accounts. */
export async function quota(f: Fetch, accessToken: string) {
  const a = await drive(f, accessToken, '/about?fields=storageQuota(limit,usage)')
  const q = a.storageQuota as { limit?: string; usage?: string } | undefined
  return { used: Number(q?.usage ?? 0), limit: q?.limit ? Number(q.limit) : null }
}

export const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`
