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
  try {
    const server = await connection.discover(location.origin)
    connection.select(server.origin, server.id)
  } catch {
    /* The setup/health page explains an unavailable Server. */
  }
})
