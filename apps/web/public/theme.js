// Runs before the first paint, so dark mode never flashes white. lib/theme.ts takes over once the app loads.
(function () {
  var t
  try { t = localStorage.getItem('devdash-theme') } catch (e) {}
  var dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  var meta = document.querySelector('meta[name=theme-color]')
  if (meta) meta.content = dark ? '#0A0A0A' : '#FFFFFF'
})()
