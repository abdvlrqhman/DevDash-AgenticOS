// Connect screen: validates a space domain via /.well-known/devdash.json, remembers it, then loads the space.
const KEY = 'devdash-spaces'
const $ = (id) => document.getElementById(id)

// Resolves true when the launch updater (updater.js) is installing a new app version from this space, so we hold off
// opening it (navigating away would kill the in-flight download). Any absence or error resolves false — the updater is
// best-effort and never blocks opening.
const updatePending = (host) =>
  Promise.resolve(typeof window.devdashUpdate === 'function' ? window.devdashUpdate(host) : false).then((v) => v === true, () => false)

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
function save(space) {
  const rest = load().filter((s) => s.host !== space.host)
  localStorage.setItem(KEY, JSON.stringify([space, ...rest].slice(0, 5)))
}

/** Accepts "dev.example.com", "https://dev.example.com/anything" or "Dev.Example.com ". */
function normalize(value) {
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0]
}

async function check(host) {
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host) || !host.includes('.')) throw new Error('Enter an address like dev.example.com.')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  let res
  try {
    res = await fetch(`https://${host}/.well-known/devdash.json`, { signal: ctrl.signal, cache: 'no-store' })
  } catch {
    throw new Error(`Can't reach ${host}. Check the address and your connection.`)
  } finally {
    clearTimeout(timer)
  }
  const meta = res.ok ? await res.json().catch(() => null) : null
  if (!meta || meta.app !== 'devdash') throw new Error(`${host} is not a DevDash space.`)
  return meta
}

function showForm(error, host) {
  $('opening').hidden = true
  $('connect').hidden = false
  if (host) $('host').value = host
  $('error').textContent = error || ''
  $('error').hidden = !error
  const recent = load()
  $('recent-wrap').hidden = recent.length === 0
  $('recent').replaceChildren(...recent.map((s) => {
    const li = document.createElement('li')
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'space'
    b.innerHTML = '<span class="name"></span><span class="host"></span>'
    b.querySelector('.name').textContent = s.name
    b.querySelector('.host').textContent = s.host
    b.onclick = () => open(s.host)
    li.append(b)
    return li
  }))
  $('host').focus()
}

async function open(host) {
  $('submit').disabled = true
  $('submit').textContent = 'Checking…'
  try {
    const meta = await check(host)
    save({ host, name: meta.name })
    if (await updatePending(host)) return
    location.replace(`https://${host}/`)
  } catch (err) {
    showForm(err.message, host)
  } finally {
    $('submit').disabled = false
    $('submit').textContent = 'Connect'
  }
}

$('connect').addEventListener('submit', (e) => {
  e.preventDefault()
  void open(normalize($('host').value))
})
$('cancel').addEventListener('click', () => {
  sessionStorage.setItem('devdash-stay', '1')
  showForm()
})

const last = load()[0]
const switching = new URLSearchParams(location.search).has('switch') || sessionStorage.getItem('devdash-stay')
if (last && !switching) {
  $('opening').hidden = false
  $('opening-name').textContent = last.name
  $('opening-host').textContent = last.host
  void updatePending(last.host) // ask for an update while the space is being checked
  void check(last.host).then(
    async () => {
      if (sessionStorage.getItem('devdash-stay')) return
      if (await updatePending(last.host)) return
      location.replace(`https://${last.host}/`)
    },
    (err) => showForm(err.message, last.host),
  )
} else {
  showForm()
}
