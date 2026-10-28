export default defineNuxtPlugin(async () => {
  const session = useSessionStore()
  const { api, native, serverOrigin } = useApi()
  if (session.ready) return
  if (import.meta.client && native && !serverOrigin.value) return
  // Typed separately: inferring one union of both route-typed fetchers exceeds TypeScript's instantiation depth.
  const fetcher = import.meta.client && native ? asSessionFetcher(api) : asSessionFetcher(useRequestFetch() as unknown)
  await session.refresh(fetcher)
})
