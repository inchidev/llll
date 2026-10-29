import { useEventListener, useIntervalFn } from '@vueuse/core'

export default defineNuxtPlugin((nuxtApp) => {
  const waiting = ref(false)
  const updating = ref(false)
  const error = ref('')
  let registration: ServiceWorkerRegistration | undefined
  let reloadRequested = false
  let readyToReload = false
  let activationTimer: ReturnType<typeof setTimeout> | undefined
  let checking: Promise<void> | undefined

  function syncWaiting() {
    waiting.value = Boolean(registration?.waiting) || readyToReload
  }

  function check() {
    if (!registration || document.visibilityState === 'hidden' || navigator.onLine === false) return
    if (checking) return checking
    const current = registration
    checking = (async () => {
      try { await current.update() }
      // A transient network failure must not hide an already downloaded update.
      catch { /* Retry on the next foreground/online check. */ }
      finally { syncWaiting() }
    })().finally(() => { checking = undefined })
    return checking
  }

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
    let controlled = Boolean(navigator.serviceWorker.controller)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadRequested) finishUpdate()
      else if (controlled) { readyToReload = true; syncWaiting() }
      controlled = true
    })
    useEventListener(window, 'focus', () => { void check() })
    useEventListener(window, 'online', () => { void check() })
    useEventListener(document, 'visibilitychange', () => { void check() })
    useIntervalFn(() => { void check() }, 60_000)
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((value) => {
      registration = value
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
  /**
   * Loads the client that matches the installed Server. A worker that is still downloading is
   * awaited; when none is coming, the cached shell is dropped so the reload reaches the Worker.
   */
  async function reloadLatest() {
    if (updating.value || blocked()) return
    error.value = ''
    updating.value = true
    try {
      await check()
      const installing = registration?.installing
      if (installing) {
        await new Promise<void>((resolve) => {
          const done = () => { if (installing.state !== 'installing') { installing.removeEventListener('statechange', done); resolve() } }
          installing.addEventListener('statechange', done)
          setTimeout(resolve, 30_000)
        })
        syncWaiting()
      }
    } finally { updating.value = false }
    if (registration?.waiting || readyToReload) { update(); return }
    try { for (const key of await caches.keys()) if (key.startsWith('llll-public-')) await caches.delete(key) }
    catch { /* The reload still asks the network for anything the cache no longer holds. */ }
    location.reload()
  }
  nuxtApp.hook('app:chunkError', () => { error.value = 'Some app files are unavailable. Reconnect and check for an update.' })
  return { provide: { pwa: { waiting, updating, error, update, check, reloadLatest } } }
})
