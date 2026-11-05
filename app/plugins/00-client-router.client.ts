import { readDiscovery } from '~/utils/boot-cache'

export default defineNuxtPlugin(async () => {
  if (!['http:', 'https:'].includes(location.protocol)) return
  const connection = useServers()
  connection.initialize()
  const original = globalThis.$fetch
  globalThis.$fetch = original.create({
    onRequest({ request, options }) {
      if (typeof request !== 'string' || !request.startsWith('/api/')) return
      const token = connection.tokens.value[location.origin]
      if (token) {
        const headers = new Headers(options.headers)
        headers.set('Authorization', `Bearer ${token}`)
        options.headers = headers
      }
    },
  })
  const select = (server: { origin: string, id: string }) => connection.select(server.origin, server.id)
  // The last answer keeps the first screen from waiting; a current one replaces it in the background.
  const remembered = readDiscovery()
  if (remembered) {
    try {
      select(connection.adopt(location.origin, remembered))
      void connection.discover(location.origin).then(select).catch(() => { /* The screen keeps the last answer. */ })
      return
    } catch { /* A Server changed since then: ask it below. */ }
  }
  try {
    select(await connection.discover(location.origin))
  } catch {
    /* The setup/health page explains an unavailable Server. */
  }
})
