// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { dropFromList, putInList } from '../../app/utils/list-cache'

afterEach(() => vi.unstubAllGlobals())
const secret = { id: 'secret-1', name: 'TELEGRAM_TOKEN', placeholder: 'L4_SECRET_TELEGRAM_TOKEN', hosts: ['api.telegram.org'], createdAt: '2026-11-07T09:00:00Z', updatedAt: '2026-11-07T09:00:00Z', lastUsedAt: null }
const stubs = {
  LayoutLoadError: true,
  UModal: { props: ['open'], template: '<div v-if="open" data-modal><slot name="body" /></div>' },
  UFormField: { template: '<label><slot /></label>' },
  UInput: { props: ['modelValue', 'placeholder'], emits: ['update:modelValue'], template: '<input :placeholder="placeholder" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />' },
  UButton: { props: ['label', 'type', 'disabled'], emits: ['click'], template: '<button :type="type ?? \'button\'" :disabled="disabled" @click="$emit(\'click\')">{{ label }}</button>' },
}

it('shows a new secret as its dialog closes, before the refetch that confirms it answers', async () => {
  let refetched: (() => void) | undefined
  const calls: string[] = []
  const api = vi.fn(async (url: string, options?: { method?: string }) => {
    calls.push(`${options?.method ?? 'GET'} ${url}`)
    if (options?.method === 'PUT') return { secret }
    // The first read is the empty list; the confirming read after the create is still on its way.
    if (calls.filter(call => call.startsWith('GET')).length === 1) return { secrets: [], canManage: true }
    return new Promise(resolve => { refetched = () => resolve({ secrets: [secret], canManage: true }) })
  })
  for (const [name, value] of Object.entries({ computed, ref, useApi: () => ({ api }), useToast: () => ({ add: vi.fn() }), errorMessage: String })) vi.stubGlobal(name, value)
  const Secrets = (await import('../../app/components/projects/Secrets.vue')).default
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = mount(Secrets, { props: { projectId: 'project-1', archived: false }, global: { plugins: [[VueQueryPlugin, { queryClient: client }]], stubs } })
  try {
    await flushPromises()
    expect(view.text()).toContain('No secrets.')
    await view.findAll('button').find(button => button.text() === 'Add secret')!.trigger('click')
    const [name, value, hosts] = view.findAll('[data-modal] input')
    await name!.setValue('TELEGRAM_TOKEN'); await value!.setValue('123:abc'); await hosts!.setValue('api.telegram.org')
    await view.get('form').trigger('submit')
    await flushPromises()
    expect(view.find('[data-modal]').exists()).toBe(false)
    expect(view.text()).toContain('L4_SECRET_TELEGRAM_TOKEN')
    expect(view.text()).not.toContain('No secrets.')
    expect(view.text()).not.toContain('123:abc')
    refetched?.()
    await flushPromises()
    expect(view.text()).toContain('L4_SECRET_TELEGRAM_TOKEN')
  } finally { view.unmount(); client.clear() }
})

it('puts a created or updated item into its cached list once, and takes a deleted one out', () => {
  const client = new QueryClient()
  const key = ['projects', 'server-1']
  putInList(client, key, 'projects', { id: 'a', name: 'Before' })
  expect(client.getQueryData(key)).toBeUndefined()
  client.setQueryData(key, { projects: [{ id: 'a', name: 'Before' }], total: 1 })
  putInList(client, key, 'projects', { id: 'b', name: 'New' })
  putInList(client, key, 'projects', { id: 'a', name: 'Renamed' })
  expect(client.getQueryData(key)).toEqual({ projects: [{ id: 'a', name: 'Renamed' }, { id: 'b', name: 'New' }], total: 1 })
  dropFromList(client, key, 'projects', 'a')
  expect(client.getQueryData(key)).toEqual({ projects: [{ id: 'b', name: 'New' }], total: 1 })
})
