// Self-update on launch (desktop only).
//
// The shell's own commands (check_update / install_update in src-tauri/src/lib.rs, desktop only) are reached through the
// global `window.__TAURI__` API (app.withGlobalTauri in tauri.conf.json), so this stays a plain classic script like the
// rest of ui/. They ask the space being opened (https://<space>/api/app/latest.json) whether a newer, signed build
// exists; if so this shows a quiet "Updating…" screen reusing the launch styling, installs it, and relaunches.
//
// Everything is best-effort: no Tauri (web preview), no commands (Android/iOS build), no network, or any error resolves
// to "nothing to do" so the connect screen opens normally. connect.js awaits `window.devdashUpdate(host)` right before
// it navigates to a space, so we never get torn down mid-download — but it stays non-blocking: the check has a short
// timeout and any failure continues the normal flow. One check per space per launch.
(function () {
  const checks = new Map()

  window.devdashUpdate = (host) => {
    if (!checks.has(host)) checks.set(host, update(host))
    return checks.get(host)
  }

  async function update(host) {
    const core = window.__TAURI__ && window.__TAURI__.core
    if (!core || typeof core.invoke !== 'function') return false

    let version
    try {
      version = await core.invoke('check_update', { space: host })
    } catch {
      return false // offline, an older space without /api/app, a bad manifest — just open normally
    }
    if (!version) return false

    try {
      showUpdating(version)
      let total = 0
      let got = 0
      const progress = new core.Channel()
      progress.onmessage = (event) => {
        if (!event || !event.event) return
        if (event.event === 'Started') total = (event.data && event.data.contentLength) || 0
        else if (event.event === 'Progress') { got += (event.data && event.data.chunkLength) || 0; setProgress(got, total) }
        else if (event.event === 'Finished') setStatus('Installing…')
      }
      await core.invoke('install_update', { onEvent: progress })
      // On Windows downloadAndInstall already launches the installer and exits; relaunch
      // covers macOS/Linux. If it isn't reached, the app is already restarting.
      const proc = window.__TAURI__.process
      if (proc && typeof proc.relaunch === 'function') await proc.relaunch()
      return true // updating / restarting — do NOT open the space
    } catch {
      hideUpdating() // install failed: fall back to the normal flow
      return false
    }
  }

  // ---- quiet "Updating…" UI, repurposing the launch (#opening) section ----
  function showUpdating(version) {
    const connect = document.getElementById('connect')
    if (connect) connect.hidden = true
    const opening = document.getElementById('opening')
    if (!opening) return
    const h1 = opening.querySelector('h1')
    if (h1) h1.textContent = 'Updating DevDash'
    const cancel = document.getElementById('cancel')
    if (cancel) cancel.hidden = true
    const loader = opening.querySelector('.loader')
    if (loader) loader.setAttribute('aria-label', 'Updating DevDash')
    setStatus(version ? `Getting version ${version}` : 'Getting the latest version')
    opening.hidden = false
  }

  function hideUpdating() {
    const opening = document.getElementById('opening')
    if (opening) opening.hidden = true
    const connect = document.getElementById('connect')
    if (connect) connect.hidden = false
  }

  function setStatus(text) {
    const host = document.getElementById('opening-host')
    if (host) host.textContent = text
  }

  function setProgress(got, total) {
    if (total > 0) setStatus(`Downloading… ${Math.min(100, Math.round((got / total) * 100))}%`)
    else setStatus('Downloading…')
  }
})()
