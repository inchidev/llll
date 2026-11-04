// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inject, ref, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import CreateDialogs from '../../app/components/data/CreateDialogs.vue'
import { documentCreateGuardKey } from '../../app/composables/useDocumentCreateGuard'

let client: QueryClient
let api: ReturnType<typeof vi.fn>
let navigate: ReturnType<typeof vi.fn>
let nav: { createDatabaseOpen: ReturnType<typeof ref<boolean>>; createDocumentOpen: ReturnType<typeof ref<boolean>>; createCanvasOpen: ReturnType<typeof ref<boolean>>; documentCreating: ReturnType<typeof ref<boolean>> }
beforeEach(() => {
  client = new QueryClient()
  api = vi.fn(async () => ({ document: { id: 'new', title: 'Untitled' } }))
  navigate = vi.fn()
  nav = { createDatabaseOpen: ref(false), createDocumentOpen: ref(false), createCanvasOpen: ref(false), documentCreating: ref(false) }
  for (const [name, value] of Object.entries({ inject, ref, watch, useServer: () => ({ serverId: ref('server') }), useApi: () => ({ api }), useNavActions: () => nav, useRoute: () => ({ path: '/data' }), useToast: () => ({ add: vi.fn() }), navigateTo: navigate, errorMessage: String })) vi.stubGlobal(name, value)
})
afterEach(() => { client.clear(); vi.unstubAllGlobals() })
function view(save: () => Promise<boolean>) {
  return mount(CreateDialogs, { global: { plugins: [[VueQueryPlugin, { queryClient: client }]], provide: { [documentCreateGuardKey as symbol]: ref(save) }, stubs: { UModal: true } } })
}
it('keeps the current document open if its draft cannot be saved', async () => {
  const save = vi.fn(async () => false)
  const v = view(save)
  nav.createDocumentOpen.value = true
  await flushPromises()
  expect(save).toHaveBeenCalledTimes(1)
  expect(api).not.toHaveBeenCalled()
  expect(navigate).not.toHaveBeenCalled()
  expect(nav.documentCreating.value).toBe(false)
  v.unmount()
})
it('saves the draft before one untitled creation, including repeated clicks while saving', async () => {
  let finish!: (value: boolean) => void
  const save = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
  const v = view(save)
  nav.createDocumentOpen.value = true
  await flushPromises()
  nav.createDocumentOpen.value = true
  await flushPromises()
  expect(nav.documentCreating.value).toBe(true)
  expect(api).not.toHaveBeenCalled()
  finish(true)
  await flushPromises()
  expect(save).toHaveBeenCalledTimes(1)
  expect(api).toHaveBeenCalledExactlyOnceWith('/api/servers/server/documents', { method: 'POST', body: {} })
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/documents?document=new')
  expect(nav.documentCreating.value).toBe(false)
  v.unmount()
})
