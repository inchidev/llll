export default defineNuxtPlugin(() => {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) void navigator.serviceWorker.register('/sw.js').catch(() => {})
})
