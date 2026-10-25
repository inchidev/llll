// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import AgentEditor from '../../app/components/settings/AgentEditorModal.vue'
afterEach(() => vi.unstubAllGlobals())
it.each([null, 'l4:openrouter:fixture'])('selects configured models with default %s and creates through the API', async defaultModel => {
  const api = vi.fn(async (path: string, opts?: { method?: string }) => {
    if (opts?.method === 'POST') return { agent: { id: 'created', displayName: 'Helper', model: 'l4:openrouter:fixture', instructions: '', status: 'active' } }
    if (path.endsWith('/roles')) return { roles: [] }
    return { models: [{ value: 'l4:openrouter:fixture', label: 'Fixture', provider: 'OpenRouter' }], defaultModel }
  })
  for (const [name, value] of Object.entries({ computed, reactive, ref, shallowRef, watch, useApi: () => ({ api }), useToast: () => ({ add: vi.fn() }), useSessionStore: () => ({ health: null }), useRoleGrants: () => ({ can: () => false }), errorMessage: () => 'Error' })) vi.stubGlobal(name, value)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = mount(AgentEditor, { props: { serverId: 'server', open: true }, global: { plugins: [[VueQueryPlugin, { queryClient: client }]], stubs: {
    UModal: { template: '<div><slot name="body" /></div>' }, UForm: { props: ['state'], emits: ['submit'], template: '<form @submit.prevent="$emit(\'submit\', { data: state })"><slot /></form>' }, UFormField: { template: '<div><slot /></div>' },
    USelectMenu: { props: ['items', 'modelValue'], emits: ['update:modelValue'], template: '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="item in items" :value="item.value">{{ item.label }}</option></select>' },
    UInput: { props: ['modelValue'], emits: ['update:modelValue'], template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />' },
    UButton: { props: ['label', 'disabled', 'type'], template: '<button :type="type || \'button\'" :disabled="disabled">{{ label }}</button>' },
    UAlert: { props: ['title'], template: '<p>{{ title }}</p>' }, UFileUpload: true, UTextarea: true, UserAvatar: true, LayoutLoadError: true,
  } } })
  try {
    await flushPromises()
    expect(view.text()).not.toContain('Agents need a model provider')
    expect(view.findAll('option').map(x => x.text())).toEqual(defaultModel ? ['Server default', 'OpenRouter / Fixture'] : ['OpenRouter / Fixture'])
    expect(view.get('button[type="submit"]').attributes('disabled') !== undefined).toBe(!defaultModel)
    await view.get('input').setValue('Helper')
    await view.get('select').setValue('l4:openrouter:fixture')
    await flushPromises()
    expect(view.get('button[type="submit"]').attributes('disabled')).toBeUndefined()
    await view.get('form').trigger('submit')
    await flushPromises()
    expect(api).toHaveBeenCalledWith('/api/servers/server/agents', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ displayName: 'Helper', model: 'l4:openrouter:fixture' }) }))
  } finally { view.unmount(); client.clear() }
})
