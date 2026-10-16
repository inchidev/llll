export default defineNuxtPlugin(async () => {
  const session = useSessionStore()
  const { api, native, serverOrigin } = useApi()
  if (session.ready) return
  if (import.meta.client && native && !serverOrigin.value) return
  const fetcher = import.meta.client && native ? api : asSessionFetcher(useRequestFetch())
  await session.refresh(fetcher)
})
