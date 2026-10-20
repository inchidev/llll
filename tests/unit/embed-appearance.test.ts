// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { computed, createApp, h, nextTick, reactive, ref, watch, type Ref } from 'vue'
import { useServers } from '../../app/composables/useServers'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear() })

it('publishes renamed Server settings and icon changes from the real query cache through embed metadata', async () => {
  const origin = location.origin
  const id = '00000000-0000-4000-8000-000000000001'
  const state = new Map<string, Ref<unknown>>()
  for (const [name, fn] of Object.entries({ computed, watch, useServers })) vi.stubGlobal(name, fn)
  vi.stubGlobal('defineNuxtPlugin', (plugin: unknown) => plugin)
  vi.stubGlobal('useState', (key: string, create: () => unknown) => {
    if (!state.has(key)) state.set(key, ref(create()))
    return state.get(key)
  })
  const post = vi.fn()
  vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage: post } as unknown as Window)
  sessionStorage.setItem('llll.embed-parent', 'https://llll.gg')
  vi.stubGlobal('useSessionStore', () => reactive({ user: { id: 'owner' } }))
  vi.stubGlobal('useLiveStore', () => reactive({ connection: 'disconnected' }))
  vi.stubGlobal('useColorMode', () => ({ preference: 'dark' }))
  vi.stubGlobal('useRouter', () => ({ afterEach: vi.fn(), replace: vi.fn() }))
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ product: 'llll', kind: 'server', apiVersion: 2, id, origin, name: 'Old name', version: 'test', ready: true, embedOrigins: ['https://llll.gg'] })))
  const connection = useServers()
  await connection.discover(origin); connection.select(origin, id)
  const app = createApp(() => h('div'))
  const queryPlugin = (await import('../../app/plugins/query')).default
  const result = queryPlugin({ vueApp: app } as never)
  const client = result!.provide.queryClient
  const hooks = new Map<string, () => void>()
  const embedPlugin = (await import('../../app/plugins/embed.client')).default
  await embedPlugin({ hook: (name: string, callback: () => void) => { hooks.set(name, callback) } } as never)
  app.mount(document.createElement('div'))
  hooks.get('app:mounted')!()
  const row = { id, name: 'abra cadabra', iconR2Key: 'private-key-never-posted', updatedAt: '2026-10-20T02:00:00.000Z', ownerId: 'private-owner', createdAt: '2026-10-20T01:00:00.000Z' }
  client.setQueryData(['server', id], { server: row })
  expect(connection.servers.value[0]?.name).toBe('abra cadabra')
  await nextTick()
  const published = () => post.mock.calls.filter(call => call[0].type === 'servers').at(-1)![0].servers[0]
  expect(published()).toMatchObject({ id, name: 'abra cadabra', iconUrl: origin + '/.well-known/llll/icon?v=2026-10-20T02%3A00%3A00.000Z' })
  expect(JSON.stringify(post.mock.calls)).not.toContain('private-')
  client.setQueryData(['server', id], { server: { ...row, iconR2Key: null, updatedAt: '2026-10-20T03:00:00.000Z' } })
  await nextTick()
  expect(published().iconUrl).toBeNull()
  app.unmount(); client.clear()
})
