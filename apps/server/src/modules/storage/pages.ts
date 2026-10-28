import { Hono } from 'hono'

// The two public pages about this space that Google checks before it lets the space's Google app be published
//: a home page that says what the app is for without signing in, and a privacy policy.
// Plain server-rendered HTML, so Google's checker reads them without running the app.

/** When the policy text below last changed in a way members should know about. */
export const POLICY_UPDATED = '2026-10-22'

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export type SpaceInfo = { name: string; origin: string; contact: string | null }

export function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --muted: #6b7280; --rule: #e5e7eb; }
  @media (prefers-color-scheme: dark) { :root { --muted: #9ca3af; --rule: #374151; } }
  body { margin: 0; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 42rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
  h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 .5rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; }
  .lead { font-size: 1.15rem; color: var(--muted); margin: 0 0 1.5rem; }
  li { margin: .35rem 0; }
  code { font-size: .9em; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--rule); color: var(--muted); font-size: .9rem; }
  a { color: inherit; }
</style>
</head>
<body><main>
${body}
</main></body>
</html>
`
}

const contactLine = (s: SpaceInfo) =>
  s.contact ? `<a href="mailto:${esc(s.contact)}">${esc(s.contact)}</a>` : `the people who run ${esc(s.name)}`

/** The home page: what the app is, what it asks Google for and why. */
export function aboutPage(s: SpaceInfo) {
  const host = esc(new URL(s.origin).host)
  return page(`${esc(s.name)} — ${host}`, `
<h1>${esc(s.name)}</h1>
<p class="lead">The private workspace of the team at ${host}.</p>

<h2>What ${esc(s.name)} is</h2>
<p>${esc(s.name)} is a workspace the team runs on its own server: projects and tasks, notes, terminals, and AI coding
sessions (Claude) that keep running on the server while people are away. Accounts are by invitation only; there is no
public sign-up.</p>

<h2>How ${esc(s.name)} uses Google</h2>
<p>Connecting Google is optional. A member can connect their own Google Drive so that large files their work produces —
videos, renders, datasets — are stored in their own Drive instead of on the team's server. When connected,
${esc(s.name)} asks Google for:</p>
<ul>
  <li><strong>Your email address</strong>, to show which Google account is connected.</li>
  <li><strong>Google Drive, only the files ${esc(s.name)} creates</strong> (Google's <code>drive.file</code> permission).
    It makes a “DevDash” folder in your Drive and works only with what it put there. It cannot see, open or change any
    other file in your Drive.</li>
</ul>
<p>You can disconnect at any time on the Storage page in ${esc(s.name)}, or remove its access in your Google account at
<a href="https://myaccount.google.com/connections">myaccount.google.com/connections</a>.</p>

<footer>
  <a href="/privacy">Privacy policy</a> · <a href="/login">Member sign-in</a> · Contact: ${contactLine(s)}
</footer>`)
}

/** The privacy policy for the Google data the space handles. */
export function privacyPage(s: SpaceInfo) {
  const n = esc(s.name)
  return page(`Privacy policy — ${n}`, `
<h1>Privacy policy</h1>
<p class="lead">${n} at ${esc(new URL(s.origin).host)} · Last updated ${POLICY_UPDATED}</p>

<p>${n} is a private, invitation-only workspace run by its team for its own members. This policy covers the information
${n} receives when a member connects their Google account, and what happens to it.</p>

<h2>What ${n} receives from Google, and why</h2>
<ul>
  <li><strong>Your email address and Google account ID</strong>: to show which Google account is connected and to tell
    connections apart.</li>
  <li><strong>Access to the files ${n} creates in your Google Drive</strong> (<code>drive.file</code>): to store large
    files you, or Claude sessions you run, put in your “DevDash” folder, and to list, fetch and share them when you
    ask. ${n} cannot see any other file in your Drive.</li>
</ul>

<h2>How it is stored</h2>
<p>The tokens Google issues for your connection are kept on the team's ${n} server, encrypted (AES-256-GCM). They are
never sent to browsers. Your files are stored in your Google Drive; a copy is on the server only while a file is being
made and uploaded, or when you or one of your sessions fetches it back to work on it.</p>

<h2>Sharing and use</h2>
<p>${n} does not sell Google user data, does not share it with third parties, does not use it for advertising, and does
not use it to train AI models. A file leaves your Drive only when you, or a Claude session you run, fetches it — and is
then handled like any other file in your workspace. ${n}'s use of information received from Google APIs adheres to the
<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>,
including the Limited Use requirements.</p>

<h2>Keeping and deleting it</h2>
<p>Disconnecting on the Storage page deletes the stored tokens at once and revokes ${n}'s access at Google; you can also
revoke it at <a href="https://myaccount.google.com/connections">myaccount.google.com/connections</a>. Files in your
Drive are yours: delete them in Google Drive whenever you like. When a member leaves the workspace, their connection is
deleted with their account.</p>

<h2>Contact</h2>
<p>Questions about this policy or your data: ${contactLine(s)}.</p>

<footer><a href="/about">About ${n}</a> · <a href="/login">Member sign-in</a></footer>`)
}

export function spacePagesRoutes(info: () => SpaceInfo) {
  const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } })
  return new Hono()
    .get('/about', () => html(aboutPage(info())))
    .get('/privacy', () => html(privacyPage(info())))
}
