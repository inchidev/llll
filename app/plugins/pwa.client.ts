export default defineNuxtPlugin((nuxtApp) => {
  const waiting = ref(false)
  const updating = ref(false)
  const error = ref('')
  let registration: ServiceWorkerRegistration | undefined
  let reload = false
  if ('serviceWorker' in navigator && !import.meta.dev && ['http:', 'https:'].includes(location.protocol)) {
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (reload) location.reload() })
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((value) => {
      registration = value
      waiting.value = Boolean(value.waiting)
      value.addEventListener('updatefound', () => value.installing?.addEventListener('statechange', () => { waiting.value = Boolean(value.waiting) }))
    }).catch(() => { error.value = 'Offline setup is unavailable. You can continue online.' })
  }
  function update() {
    if (!registration?.waiting || updating.value) return
    if (document.querySelector('[data-uploading="true"]') || document.querySelector('[aria-busy="true"]')) { error.value = 'Finish sending and uploading before updating.'; return }
    try { localStorage.setItem('llll.storage-check', '1'); localStorage.removeItem('llll.storage-check') }
    catch { error.value = 'Copy your draft before reloading: browser storage is unavailable.'; return }
    updating.value = true
    reload = true
    registration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' })
  }
  nuxtApp.hook('app:chunkError', () => { error.value = 'Some app files are unavailable. Reconnect and check for an update.' })
  return { provide: { pwa: { waiting, updating, error, update } } }
})
