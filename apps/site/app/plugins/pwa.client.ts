export default defineNuxtPlugin(() => {
  if (!import.meta.dev && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) void navigator.serviceWorker.register('/sw.js').catch(() => {})
})
