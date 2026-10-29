// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import RunPage from '../../app/pages/runs/[id].vue'
afterEach(() => vi.unstubAllGlobals())
it.each([403, 409, 0])('shows cancellation failure %s and refreshes the actual run state', async status => {
  let current = 'running'
  const toast = vi.fn()
  const api = vi.fn(async (path: string) => {
    if (path.endsWith('/cancel')) { current = 'completed'; throw Error(status ? `Cancel failed: ${status}` : 'Network unavailable') }
    return { run: { status: current, createdAt: '2026-10-24', modelCalls: 0 }, canCancel: true }
  })
  for (const [name, value] of Object.entries({ computed, ref, definePageMeta: () => {}, useRoute: () => ({ params: { id: 'run' } }), useApi: () => ({ api }), useRoleGrants: () => ({ can: () => false }), useNavActions: () => ({ openServerSettings: () => {} }), useToast: () => ({ add: toast }), errorMessage: (error: Error) => error.message })) vi.stubGlobal(name, value)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = mount(RunPage, { global: { plugins: [[VueQueryPlugin, { queryClient: client }]], stubs: {
    LayoutPageHeader: true, LayoutSkeleton: true, LayoutLoadError: true, UBadge: { props: ['label'], template: '<span>{{ label }}</span>' }, UAlert: true,
    UButton: { props: ['label', 'loading'], template: '<button :disabled="loading">{{ label }}</button>' },
  } } })
  try {
    await flushPromises()
    await view.get('button').trigger('click')
    await flushPromises()
    expect(toast).toHaveBeenCalledWith({ title: status ? `Cancel failed: ${status}` : 'Network unavailable', color: 'error' })
    expect(view.text()).toContain('completed')
    expect(view.text()).not.toContain('Stop run')
    expect(api.mock.calls.filter(([path]) => path === '/api/agent-runs/run')).toHaveLength(2)
  } finally { view.unmount(); client.clear() }
})
