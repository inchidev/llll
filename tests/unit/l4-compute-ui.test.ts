// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { computed, onMounted, ref, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import L4Compute from '../../app/components/settings/L4Compute.vue'
import type { L4ComputeOverview } from '../../shared/l4-compute'

const base: L4ComputeOverview = { linked: false, hosted: false, account: null, linkedAt: null, canConnect: true, nodeId: null, status: null, statusError: null, statusAt: null,
  boxes: { active: 0, retained: 0 }, pricingUrl: 'https://llll.gg/pricing', accountUrl: 'https://llll.gg/account' }
afterEach(() => vi.unstubAllGlobals())

function show(overview: L4ComputeOverview, query: Record<string, string> = {}) {
  const connect = vi.fn(), disconnect = vi.fn(async () => {}), toasts: Array<{ title: string }> = []
  for (const [name, value] of Object.entries({ computed, ref, watch, onMounted, useRoute: () => ({ query }), navigateTo: vi.fn(), useToast: () => ({ add: (toast: { title: string }) => { toasts.push(toast) } }),
    useL4Compute: () => ({ overview: { data: ref(overview), error: ref(null), refetch: vi.fn() }, busy: ref(false), connect, disconnect }) })) vi.stubGlobal(name, value)
  const view = mount(L4Compute, { global: { stubs: {
    UButton: { props: ['label', 'disabled'], template: '<button :disabled="disabled">{{ label }}</button>' },
    UAlert: { props: ['title', 'description'], template: '<p role="alert">{{ title }} {{ description }}</p>' },
    UModal: { props: ['open'], template: '<div v-if="open"><slot name="footer" /></div>' },
    LayoutLoadError: true,
  } } })
  return { view, connect, disconnect, toasts }
}

it('offers Add L4 Compute while the Server is not linked, and starts the link from it', async () => {
  const { view, connect, toasts } = show(base, { l4: 'failed', message: 'llll.gg did not accept the link (502)' })
  await flushPromises()
  expect(view.text()).toContain('Not linked')
  const button = view.get('[data-l4-connect]')
  expect(button.text()).toBe('Add L4 Compute')
  await button.trigger('click')
  expect(connect).toHaveBeenCalledOnce()
  expect(toasts).toEqual([{ title: 'L4 Compute was not linked', description: 'llll.gg did not accept the link (502)', color: 'error' }])
  view.unmount()
})

it('shows the linked account with what llll.gg reports, never a price of its own, and offers Disconnect', async () => {
  const { view, disconnect } = show({ ...base, linked: true, account: 'owner@example.com', linkedAt: '2026-11-08T12:00:00Z', canConnect: false, nodeId: 'n1',
    status: { creditMicrocents: 12050000000, spentThisMonthMicrocents: 1999000000, spendLimitMicrocents: 5000000000, mayStartBox: true }, statusAt: '2026-11-08T12:00:00Z', boxes: { active: 2, retained: 3 } })
  await flushPromises()
  expect(view.get('[data-l4-linked]').text()).toBe('Linked to llll.gg account owner@example.com')
  expect(view.get('[data-l4-status]').text()).toContain('$120.50')
  expect(view.get('[data-l4-status]').text()).toContain('$19.99')
  expect(view.get('[data-l4-status]').text()).toContain('$50.00')
  expect(view.text()).toContain('2 boxes running now · 3 kept')
  expect(view.text()).not.toMatch(/per hour|\/h\b/u)
  const buttons = view.findAll('button').map(button => button.text())
  expect(buttons).toContain('Disconnect')
  expect(buttons).not.toContain('Add L4 Compute')
  await view.findAll('button').find(button => button.text() === 'Disconnect')!.trigger('click')
  await flushPromises()
  await view.findAll('button').filter(button => button.text() === 'Disconnect').at(-1)!.trigger('click')
  expect(disconnect).toHaveBeenCalledOnce()
  view.unmount()
})

it('says llll.gg is unreachable without hiding the link, and shows a hosted Server as linked with no disconnect', async () => {
  const { view } = show({ ...base, linked: true, hosted: true, canConnect: false, nodeId: 'n1', statusError: 'llll.gg unreachable' })
  await flushPromises()
  expect(view.get('[data-l4-linked]').text()).toContain('runs on L4 Cloud')
  expect(view.get('[role="alert"]').text()).toContain('llll.gg unreachable')
  expect(view.findAll('button').map(button => button.text())).not.toContain('Disconnect')
  view.unmount()
})
