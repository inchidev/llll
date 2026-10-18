import { afterEach, expect, it, vi } from 'vitest'
import { computed, ref, type Ref } from 'vue'
import { useInstances } from '../../app/composables/useInstances'

afterEach(() => vi.unstubAllGlobals())

it('sends the JSON sign-out request and waits for server revocation before clearing local state', async () => {
  const states = new Map<string, Ref<unknown>>()
  vi.stubGlobal('useState', (key: string, initial: () => unknown) => {
    if (!states.has(key)) states.set(key, ref(initial()))
    return states.get(key)
  })
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('location', new URL('https://instance.example'))
  const removeItem = vi.fn()
  vi.stubGlobal('sessionStorage', { removeItem })
  vi.stubGlobal('localStorage', { setItem: vi.fn() })
  let respond: ((response: Response) => void) | undefined
  const fetcher = vi.fn((_url: string, options: RequestInit) => {
    expect(new Headers(options.headers).get('Content-Type')).toBe('application/json')
    expect(options.body).toBe('{}')
    return new Promise<Response>(resolve => { respond = resolve })
  })
  vi.stubGlobal('fetch', fetcher)
  const connections = useInstances()
  const origin = 'https://instance.example'
  connections.installations.value = [{ origin, id: 'community', name: 'Community', kind: 'installation', userId: 'member', servers: [] }]
  connections.tokens.value[origin] = 'signed-test-session'

  const pending = connections.logout(origin)
  expect(fetcher).toHaveBeenCalledOnce()
  expect(connections.tokens.value[origin]).toBe('signed-test-session')
  expect(removeItem).not.toHaveBeenCalled()
  respond!(Response.json({ success: true }))
  await pending
  expect(connections.tokens.value[origin]).toBeUndefined()
  expect(connections.installations.value[0]?.userId).toBeUndefined()
  expect(removeItem).toHaveBeenCalledWith('llll.installation-session:' + origin)
})
