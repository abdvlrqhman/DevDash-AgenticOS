type Setup = { enabled: boolean; missing: string[]; overCap: boolean }

/** Why voice mode can't start yet, in a sentence, or null when it can. Pure, tested. */
export function voiceBlocker(v: Setup | undefined): string | null {
  if (!v || !v.enabled) return 'Voice mode is off. Turn it on and add your keys in Voice settings.'
  if (v.missing.some((m) => m !== 'voice')) return 'Voice mode isn\'t set up yet. Add your keys in Voice settings.'
  if (v.missing.includes('voice')) return 'Pick a voice for Hamasa in Voice settings.'
  if (v.overCap) return 'This month\'s voice cap is reached. You can raise it in Voice settings.'
  return null
}

/**
 * Languages to start with from the browser's own list ("de-DE" → "de"), when a member has picked none or only one:
 * those, theirs, in that order, only ones on offer. Pure, tested.
 */
export function fromBrowser(browser: readonly string[], choices: string[], current: string[]) {
  const all = [...current, ...browser.map((l) => l.toLowerCase().split('-')[0]!)]
  return [...new Set(all)].filter((l) => choices.includes(l))
}

/**
 * Why the microphone didn't open, in words that say whose side it's on. `policyAllows` is the page's
 * Permissions-Policy (null where the browser can't tell, like Safari). Pure, tested.
 */
export function micError(o: { name?: string; message?: string; secure: boolean; policyAllows: boolean | null; hasMediaDevices: boolean; inApp?: boolean }) {
  if (!o.secure) return 'Voice mode needs a secure (https) connection to DevDash.'
  if (o.policyAllows === false) return 'DevDash\'s own site settings block the microphone. That\'s on our side, not your browser: tell an admin.'
  // The DevDash app before voice mode had no microphone permission: its web view offers no microphone at all.
  if (!o.hasMediaDevices && o.inApp) return 'This version of the DevDash app can\'t use the microphone yet. Update the app, or use DevDash in your browser for now.'
  if (!o.hasMediaDevices) return 'This browser can\'t use a microphone here.'
  if ((o.name === 'NotAllowedError' || o.name === 'SecurityError') && o.inApp) return 'Microphone access was denied. Allow it for DevDash in your phone\'s settings, then try again.'
  if (o.name === 'NotAllowedError' || o.name === 'SecurityError') return 'Microphone access was denied. Allow it for this site in your browser\'s settings, then try again.'
  if (o.name === 'NotFoundError' || o.name === 'OverconstrainedError') return 'No microphone found. Connect one, then try again.'
  if (o.name === 'NotReadableError') return 'The microphone is busy in another app. Close it there, then try again.'
  return o.message || 'Couldn\'t start voice mode.'
}
