// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { computed, ref, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { errorMessage } from '../../app/composables/useApi'
import FactorySetup from '../../app/components/settings/FactorySetup.vue'

const image = 'registry.cloudflare.com/account/factory@sha256:' + 'a'.repeat(64)
afterEach(() => vi.unstubAllGlobals())

it('shows the activation error in the Factory card', async () => {
  const calls: string[] = []
  const api = vi.fn(async (_path: string, options?: { method?: string }) => {
    calls.push(options?.method || 'GET')
    if (options?.method === 'POST') throw { data: { error: { message: 'Artifacts namespace unavailable' } } }
    return { usage: null, limits: { cpu: 0.5, memoryMiB: 4096, diskBytes: 8000000000, processLimit: 128, timeoutMs: 120000 }, placement: 'cloudflare', resources: true, state: 'disabled', nodeId: null, image, connectUrl: null, cli: null, durability: 'Checkpointed source.', costs: 'Cloudflare compute is billed separately.' }
  })
  for (const [name, value] of Object.entries({ computed, ref, watch, useApi: () => ({ api }), useToast: () => ({ add: vi.fn() }), errorMessage })) vi.stubGlobal(name, value)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = mount(FactorySetup, { global: { plugins: [[VueQueryPlugin, { queryClient: client }]], stubs: {
    UButton: { props: ['label', 'disabled'], template: '<button :disabled="disabled">{{ label }}</button>' },
    UCheckbox: { props: ['modelValue', 'label'], emits: ['update:modelValue'], template: '<label><input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)">{{ label }}</label>' },
    UAlert: { props: ['title'], template: '<p role="alert">{{ title }}</p>' },
    LayoutLoadError: true,
  } } })
  try {
    await flushPromises()
    expect(view.text()).toContain('Compute node disabled')
    await view.get('input[type="checkbox"]').setValue(true)
    await view.get('button').trigger('click')
    await flushPromises()
    expect(calls).toContain('POST')
    expect(view.get('[role="alert"]').text()).toBe('Artifacts namespace unavailable')
  } finally { view.unmount(); client.clear() }
})
