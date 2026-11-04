// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, ref, toValue, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import type { SpaceDTO } from '../../shared/spaces'
import { SPACE_HEADER } from '../../shared/spaces'
import { activeSpaceStore, useSpaces } from '../../app/composables/useSpaces'
import { resolveActiveSpace, showSpaceSwitcher, spaceHeaderApplies } from '../../app/utils/spaces'
import Switcher from '../../app/components/layout/SpaceSwitcher.vue'

const space = (id: string, extra: Partial<SpaceDTO> = {}): SpaceDTO => ({ id, name: id, description: '', isDefault: false, role: 'member', memberCount: 1, ...extra })
const clients: QueryClient[] = []
afterEach(() => { activeSpaceStore().value = {}; clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals() })
async function settle() { await flushPromises(); await new Promise(resolve => setTimeout(resolve, 15)); await flushPromises() }

function renderSwitcher(spaces: SpaceDTO[]) {
  for (const [name, value] of Object.entries({ computed, ref, toValue, watch, nextTick, useApi: () => ({ api: async () => ({ spaces }) }), useSpaces, useNavActions: () => ({ openServerSettings: vi.fn() }) })) vi.stubGlobal(name, value)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  return { client, view: mount(Switcher, { props: { serverId: 'server' }, global: { plugins: [[VueQueryPlugin, { queryClient: client }]], stubs: { UIcon: true, UDropdownMenu: { template: '<div><slot/></div>' } } } }) }
}

describe('Space switcher', () => {
  it('needs two Spaces', () => {
    expect(showSpaceSwitcher([])).toBe(false)
    expect(showSpaceSwitcher([space('a')])).toBe(false)
    expect(showSpaceSwitcher([space('a'), space('b')])).toBe(true)
  })
  it('renders nothing and stores nothing for someone in one Space', async () => {
    const { view } = renderSwitcher([space('a', { isDefault: true })]); await settle()
    expect(view.find('button').exists()).toBe(false)
    expect(activeSpaceStore().value).toEqual({})
    view.unmount()
  })
  it('renders the active Space, stores the fallback and reloads what loaded unscoped', async () => {
    const reload = vi.fn()
    vi.stubGlobal('window', { location: { reload } })
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ server: 'main' }) })
    const { view } = renderSwitcher([space('a'), space('main', { isDefault: true })])
    await settle()
    expect(view.get('button').attributes('title')).toBe('main')
    expect(activeSpaceStore().value).toEqual({ server: 'main' })
    expect(reload).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('refreshes queries instead when storage is blocked, since a reload would loop', async () => {
    const reload = vi.fn()
    vi.stubGlobal('window', { location: { reload } })
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') } })
    const { view, client } = renderSwitcher([space('a'), space('main', { isDefault: true })])
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await settle()
    expect(reload).not.toHaveBeenCalled()
    expect(invalidate).toHaveBeenCalledTimes(1)
    view.unmount()
  })
})

describe('active Space', () => {
  const spaces = [space('a'), space('main', { isDefault: true }), space('hidden', { role: null })]
  it('keeps the stored Space while it is listed', () => {
    expect(resolveActiveSpace(spaces, 'a')?.id).toBe('a')
  })
  it('falls back to the default, then the first', () => {
    expect(resolveActiveSpace(spaces, 'gone')?.id).toBe('main')
    expect(resolveActiveSpace(spaces, null)?.id).toBe('main')
    expect(resolveActiveSpace([space('a'), space('b')], 'gone')?.id).toBe('a')
  })
  it('never lands on a Space the Owner has not joined', () => {
    expect(resolveActiveSpace(spaces, 'hidden')?.id).toBe('main')
    expect(resolveActiveSpace([space('hidden', { role: null, isDefault: true })], null)).toBeNull()
  })
})

describe('Space header', () => {
  const page = 'https://server.example'
  it('goes to this Server API only', () => {
    expect(spaceHeaderApplies('/api/channels', undefined, page, null)).toBe(true)
    expect(spaceHeaderApplies(`${page}/api/channels`, undefined, page, null)).toBe(true)
    expect(spaceHeaderApplies('https://active.example/api/channels', undefined, page, 'https://active.example')).toBe(true)
    expect(spaceHeaderApplies('/api/channels', 'https://active.example', page, 'https://active.example')).toBe(true)
    expect(spaceHeaderApplies('/.well-known/llll', undefined, page, null)).toBe(false)
    expect(spaceHeaderApplies('https://other.example/api/channels', undefined, page, null)).toBe(false)
  })
  it('adds the header to this Server’s API calls through fetch, which every fetcher reaches', async () => {
    const inner = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', inner)
    vi.stubGlobal('defineNuxtPlugin', (setup: unknown) => setup)
    vi.stubGlobal('useServers', () => ({ activeServer: ref({ id: 'server', origin: location.origin }) }))
    activeSpaceStore().value = { server: 'sales' }
    const plugin = (await import('../../app/plugins/00-space-header.client')).default as unknown as () => void
    plugin()
    const sent = () => new Headers((inner.mock.lastCall as unknown as [unknown, RequestInit])[1]?.headers).get(SPACE_HEADER)
    await globalThis.fetch(`${location.origin}/api/channels`)
    expect(sent()).toBe('sales')
    await globalThis.fetch('https://other.example/api/channels')
    expect(sent()).toBeNull()
    await globalThis.fetch(`${location.origin}/_nuxt/app.js`)
    expect(sent()).toBeNull()
  })
})
