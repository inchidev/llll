export default defineNuxtPlugin(async () => {
  const session = useSessionStore()
  const { api, native, serverOrigin } = useApi()
  if (!session.ready) {
    if (import.meta.client && native) {
      if (!serverOrigin.value) return
      await session.refresh(api)
    }
    else await session.refresh(asSessionFetcher(useRequestFetch()))
  }
})
