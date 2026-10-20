export default defineNuxtPlugin((nuxtApp) => {
  const waiting = ref(false)
  const updating = ref(false)
  const error = ref('')
  let registration: ServiceWorkerRegistration | undefined
  let reloadRequested = false
  let readyToReload = false
  let activationTimer: ReturnType<typeof setTimeout> | undefined

  function blocked() {
    if (document.querySelector('[data-update-blocked="true"]')) { error.value = 'Save or reset your changes and finish recording before updating.'; return true }
    if (document.querySelector('[data-uploading="true"]') || document.querySelector('[aria-busy="true"]:not([data-client-update-action])')) { error.value = 'Finish sending and uploading before updating.'; return true }
    try { localStorage.setItem('llll.storage-check', '1'); localStorage.removeItem('llll.storage-check') }
    catch { error.value = 'Copy your draft before reloading: browser storage is unavailable.'; return true }
    return false
  }

  function finishUpdate() {
    clearTimeout(activationTimer)
    updating.value = false
    readyToReload = true
    waiting.value = true
    // Activation can be delayed. Work started since the click must stay safe too.
    if (blocked()) return
    reloadRequested = false
    readyToReload = false
    waiting.value = false
    location.reload()
  }

  if ('serviceWorker' in navigator && !import.meta.dev && ['http:', 'https:'].includes(location.protocol)) {
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloadRequested) finishUpdate() })
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((value) => {
      registration = value
      const syncWaiting = () => { waiting.value = Boolean(value.waiting) || readyToReload }
      const watchInstalling = () => {
        syncWaiting()
        value.installing?.addEventListener('statechange', syncWaiting)
      }
      watchInstalling()
      value.addEventListener('updatefound', watchInstalling)
    }).catch(() => { error.value = 'Offline setup is unavailable. You can continue online.' })
  }

  function update() {
    if (updating.value || (!registration?.waiting && !readyToReload) || blocked()) return
    error.value = ''
    reloadRequested = true
    if (readyToReload) { finishUpdate(); return }
    updating.value = true
    clearTimeout(activationTimer)
    activationTimer = setTimeout(() => {
      updating.value = false
      error.value = 'The update is taking longer than expected. Please try again.'
    }, 15_000)
    try { registration!.waiting!.postMessage({ type: 'ACTIVATE_UPDATE' }) }
    catch {
      clearTimeout(activationTimer)
      updating.value = false
      reloadRequested = false
      error.value = 'The update could not start. Please try again.'
    }
  }
  nuxtApp.hook('app:chunkError', () => { error.value = 'Some app files are unavailable. Reconnect and check for an update.' })
  return { provide: { pwa: { waiting, updating, error, update } } }
})
