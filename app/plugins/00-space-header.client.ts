import { SPACE_HEADER } from '~~/shared/spaces'
import { activeSpaceStore } from '../composables/useSpaces'
import { spaceHeaderApplies } from '../utils/spaces'

/**
 * Names the active Space on every API request. This wraps `fetch` itself: the bundle binds `$fetch`
 * to its own import, so wrapping `globalThis.$fetch` would miss almost every call, while ofetch
 * reads `globalThis.fetch` each time. Named to load before plugins that fetch at startup.
 */
export default defineNuxtPlugin(() => {
  const connection = useServers()
  const active = activeSpaceStore()
  const inner = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (input, init) => {
    const server = connection.activeServer.value
    // The first requests leave before the active Server resolves; a Client serves one Server.
    const spaceId = server ? active.value[server.id] : Object.values(active.value)[0]
    const url = input instanceof Request ? input.url : String(input)
    if (!spaceId || !spaceHeaderApplies(url, undefined, location.origin, server?.origin)) return inner(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set(SPACE_HEADER, spaceId)
    return inner(input, { ...init, headers })
  }
})
