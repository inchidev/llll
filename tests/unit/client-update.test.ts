// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import App from '../../app/app.vue'
import UpdateBanner from '../../app/components/client/UpdateBanner.vue'

beforeEach(() => {
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('defineNuxtPlugin', (plugin: unknown) => plugin)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; localStorage.clear() })

it('allows a retry if activation stalls and rechecks unsaved work before a delayed reload', async () => {
  vi.useFakeTimers()
  const handlers = new Map<string, () => void>()
  const reload = vi.spyOn(location, 'reload').mockImplementation(() => {})
  const postMessage = vi.fn()
  const worker = { postMessage, addEventListener: vi.fn() }
  vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn(async () => ({ waiting: worker, addEventListener: vi.fn() })), addEventListener: (name: string, fn: () => void) => handlers.set(name, fn) } })
  const plugin = (await import('../../app/plugins/pwa.client')).default
  const result = plugin({ hook: vi.fn() } as never)!
  await Promise.resolve(); await Promise.resolve()
  const pwa = result.provide.pwa
  pwa.update()
  expect(pwa.updating.value).toBe(true)
  await vi.advanceTimersByTimeAsync(15_000)
  expect(pwa.updating.value).toBe(false)
  expect(pwa.error.value).toMatch(/try again/i)
  pwa.update()
  expect(postMessage).toHaveBeenCalledTimes(2)
  const blocker = document.createElement('div')
  blocker.dataset.updateBlocked = 'true'; document.body.append(blocker)
  const ownAction = document.createElement('button')
  ownAction.dataset.clientUpdateAction = ''
  ownAction.setAttribute('aria-busy', 'true')
  document.body.append(ownAction)
  handlers.get('controllerchange')!()
  expect(reload).not.toHaveBeenCalled()
  expect(pwa.updating.value).toBe(false)
  expect(pwa.waiting.value).toBe(true)
  blocker.remove()
  pwa.update()
  expect(reload).toHaveBeenCalledOnce()
})

it('notices an update that was already installing when registration resolved', async () => {
  let installed!: () => void
  const registration = {
    waiting: null as null | { postMessage: ReturnType<typeof vi.fn> },
    installing: { addEventListener: vi.fn((name: string, listener: () => void) => { if (name === 'statechange') installed = listener }) },
    addEventListener: vi.fn(),
  }
  vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn(async () => registration), addEventListener: vi.fn() } })
  const plugin = (await import('../../app/plugins/pwa.client')).default
  const result = plugin({ hook: vi.fn() } as never)!
  await flushPromises()
  expect(result.provide.pwa.waiting.value).toBe(false)
  registration.waiting = { postMessage: vi.fn() }
  installed()
  expect(result.provide.pwa.waiting.value).toBe(true)
})

it.each([false, true])('offers a waiting update in the web Client (embedded=%s)', async (embedded) => {
  const postMessage = vi.fn()
  const handlers = new Map<string, () => void>()
  const reload = vi.spyOn(location, 'reload').mockImplementation(() => {})
  const register = vi.fn(async () => ({ waiting: { postMessage, addEventListener: vi.fn() }, addEventListener: vi.fn() }))
  vi.stubGlobal('navigator', { serviceWorker: { register, addEventListener: (name: string, fn: () => void) => handlers.set(name, fn) } })
  const plugin = (await import('../../app/plugins/pwa.client')).default
  const result = plugin({ hook: vi.fn() } as never)!
  vi.stubGlobal('useNuxtApp', () => ({ $pwa: result.provide.pwa }))
  vi.stubGlobal('useRequestURL', () => new URL('https://server.example.com'))
  vi.stubGlobal('useClientServers', () => ({ native: false }))
  vi.stubGlobal('useState', () => ref({ enabled: embedded, parent: '' }))
  vi.stubGlobal('useSeoMeta', vi.fn())
  const view = mount(App, { global: { stubs: { UApp: { template: '<div><slot /></div>' }, NuxtLayout: { template: '<main><slot /></main>' }, NuxtPage: true, NuxtRouteAnnouncer: true, ClientUpdateBanner: UpdateBanner, UButton: { props: ['label'], template: '<button @click="$emit(\'click\')">{{ label }}</button>' } } } })
  await flushPromises()
  expect(view.get('[role="status"]').text()).toContain('An L4 update is ready')
  expect(register).toHaveBeenCalledWith('/sw.js', { updateViaCache: 'none' })
  const blocker = document.createElement('div')
  blocker.dataset.updateBlocked = 'true'; document.body.append(blocker)
  await view.get('button').trigger('click')
  expect(postMessage).not.toHaveBeenCalled()
  expect(view.text()).toContain('Save or reset your changes')
  blocker.remove()
  localStorage.setItem('saved-draft', 'Unsent message')
  await view.get('button').trigger('click')
  expect(postMessage).toHaveBeenCalledWith({ type: 'ACTIVATE_UPDATE' })
  expect(reload).not.toHaveBeenCalled()
  handlers.get('controllerchange')!()
  expect(reload).toHaveBeenCalledOnce()
  expect(localStorage.getItem('saved-draft')).toBe('Unsent message')
  view.unmount()
})
