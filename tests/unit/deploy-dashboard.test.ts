// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, nextTick, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import Dashboard from '../../apps/site/app/components/ServerDeploy.vue'
import { useShell } from '../../apps/site/app/composables/useShell'

const account = 'a'.repeat(32)
const ready = 'https://ready.customer.workers.dev'
const pending = 'https://pending.customer.workers.dev'
const claim = 'synthetic-owner-claim-'.padEnd(64, 'x')
const api = vi.fn()
let wrapper: ReturnType<typeof mount> | undefined
const Button = defineComponent({
  inheritAttrs: false,
  props: ['label', 'to', 'disabled', 'type'],
  setup: (props, { attrs }) => () => h(props.to ? 'a' : 'button', { ...attrs, href: props.to, disabled: props.disabled, type: props.type || 'button' }, props.label),
})
const Input = defineComponent({
  props: ['modelValue'], emits: ['update:modelValue'],
  setup: (props, { emit }) => () => h('input', { value: props.modelValue, onInput: event => emit('update:modelValue', (event.target as HTMLInputElement).value) }),
})
const Select = defineComponent({
  props: ['modelValue', 'items'], emits: ['update:modelValue'],
  setup: (props, { emit }) => () => h('select', { value: props.modelValue, onChange: event => emit('update:modelValue', (event.target as HTMLSelectElement).value) }, props.items.map((item: { label: string; value: string }) => h('option', { value: item.value }, item.label))),
})
const Form = defineComponent({ emits: ['submit'], setup: (_, { emit, slots }) => () => h('form', { onSubmit: event => { event.preventDefault(); emit('submit') } }, slots.default?.()) })
const Field = defineComponent({ props: ['label'], setup: (props, { slots }) => () => h('label', [props.label, slots.default?.()]) })
const Alert = defineComponent({ props: ['description'], setup: props => () => h('p', props.description) })
const stubs = { UButton: Button, UInput: Input, USelect: Select, UForm: Form, UFormField: Field, UAlert: Alert, UBadge: { template: '<span><slot /></span>' }, UIcon: true }

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  const state = new Map<string, Ref<unknown>>()
  vi.stubGlobal('useState', (key: string, create: () => unknown) => {
    if (!state.has(key)) state.set(key, ref(create()))
    return state.get(key)
  })
  vi.stubGlobal('useShell', useShell)
  vi.stubGlobal('useRoute', () => ({ params: {} }))
  vi.stubGlobal('useRouter', () => ({ push: vi.fn(), replace: vi.fn() }))
  for (const [name, fn] of Object.entries({ ref, computed, watch, onMounted, onUnmounted })) vi.stubGlobal(name, fn)
  vi.stubGlobal('navigateTo', vi.fn())
  api.mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/deploy/config') return { oauth: true }
    if (path === '/api/deploy/releases') return { releases: [{ version: 'v0.2.0-alpha.3' }] }
    if (path === '/api/deploy/servers') return { servers: [ready, pending].map((origin, index) => ({ origin, accountId: account, name: index ? 'Unclaimed Server' : 'Ready Server', version: '0.2.0-alpha.3' })) }
    if (path === '/api/deploy/session') return {
      authorized: true, accounts: [{ id: account, name: 'Cloudflare account' }], accountId: account,
      sessionExpiresAt: Date.now() + 3600000, grantExpiresAt: Date.now() + 1800000,
      completed: true, step: 3, origin: ready, name: 'Ready Server', claim: ready + '/setup#claim=' + claim,
      deployments: [{ origin: pending, name: 'Unclaimed Server', accountId: account, claim: pending + '/setup#claim=' + claim }],
    }
    throw new Error('Unexpected API request')
  })
  vi.stubGlobal('$fetch', api)
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const origin = new URL(input).origin
    return Response.json({ product: 'llll', kind: 'server', apiVersion: 2, id: '00000000-0000-4000-8000-000000000001', origin, name: origin === ready ? 'Ready Server' : origin === pending ? 'Unclaimed Server' : 'Other account Server', ready: origin === ready })
  }))
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals(); vi.useRealTimers() })
async function render() {
  wrapper = mount(Dashboard, { global: { stubs } })
  await flushPromises(); await nextTick(); await flushPromises()
  return wrapper
}

it('replaces the completed-deployment screen with account inventory and setup only for the unclaimed Server', async () => {
  const view = await render()
  expect(view.text()).toContain('Cloudflare connected')
  expect(view.text()).toContain('Ready Server')
  expect(view.text()).toContain('Cloudflare access: 30 min')
  expect(view.text()).toContain('Installer session: 60 min')
  expect(view.text()).not.toContain('Your Server is deployed')
  const rows = view.findAll('li')
  expect(rows[0]!.text()).toContain('Ready')
  expect(rows[0]!.text()).not.toContain('Finish setup on your Server')
  expect(rows[1]!.text()).toContain('Finish setup on your Server')
  expect(rows[1]!.find('a').attributes('href')).toContain('#claim=')
  expect(localStorage.getItem('llll.deploy-recall.v1')).not.toContain(claim)
})

it('keeps saved Servers and offers reconnection when Cloudflare access expires', async () => {
  const view = await render()
  await vi.advanceTimersByTimeAsync(1800001)
  expect(view.text()).toContain('Cloudflare connection ended')
  expect(view.text()).toContain('Reconnect Cloudflare')
  expect(view.text()).toContain('Saved on this device')
  expect(view.text()).toContain('Ready Server')
  expect(view.findAll('button').find(button => button.text() === 'Create another Server')?.attributes('disabled')).toBeDefined()
})

it('allows creating another Server from a completed session and keeps the account selector in place', async () => {
  const view = await render()
  await view.findAll('button').find(button => button.text() === 'Create another Server')!.trigger('click')
  expect(view.find('form').exists()).toBe(true)
  expect(view.text()).toContain('Your admin email')
  expect(view.findAll('select')[0]!.element.value).toBe(account)
  await view.findAll('input')[0]!.setValue('owner@example.com')
  await view.findAll('input')[1]!.setValue('Second Server')
  await view.find('form').trigger('submit')
  await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/deploy/start', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ accountId: account, name: 'Second Server', ownerEmail: 'owner@example.com' }) }))
})

it('offers reconnect for an older completed session and stops suggesting setup for a ready Server', async () => {
  const original = api.getMockImplementation()!
  api.mockImplementation(async (path: string) => {
    const value = await original(path)
    if (path === '/api/deploy/session') return { ...value, authorized: false, accounts: [], grantExpiresAt: undefined }
    return value
  })
  const view = await render()
  expect(view.text()).toContain('Reconnect Cloudflare')
  expect(view.text()).toContain('Ready Server')
  expect(view.findAll('li').find(row => row.text().includes('Ready Server'))?.text()).not.toContain('Finish setup on your Server')
  expect(api.mock.calls.some(call => call[0] === '/api/deploy/servers')).toBe(false)
})

it('switches Cloudflare accounts without displaying the previous account’s Servers', async () => {
  const other = 'b'.repeat(32)
  const original = api.getMockImplementation()!
  api.mockImplementation(async (path: string, options?: { query?: { accountId: string } }) => {
    if (path === '/api/deploy/servers' && options?.query?.accountId === other)
      return { servers: [{ accountId: other, name: 'Other account Server', origin: 'https://other.customer.workers.dev' }] }
    const value = await original(path)
    if (path === '/api/deploy/session') value.accounts.push({ id: other, name: 'Other account' })
    return value
  })
  const view = await render()
  await view.find('select').setValue(other)
  await flushPromises(); await nextTick()
  expect(view.text()).toContain('Other account Server')
  expect(view.text()).not.toContain('Ready Server')
  expect(view.text()).not.toContain('Unclaimed Server')
})

it('uses a successful account refresh rather than presenting a deleted cached Server as current', async () => {
  const view = await render()
  const original = api.getMockImplementation()!
  api.mockImplementation(async (path: string) => path === '/api/deploy/servers' ? { servers: [] } : original(path))
  await view.findAll('button').find(button => button.text() === 'Refresh Servers')!.trigger('click')
  await flushPromises(); await nextTick()
  expect(view.findAll('li')).toHaveLength(0)
  expect(view.text()).toContain('No L4 Servers found')
  expect(localStorage.getItem('llll.deploy-recall.v1')).toContain(ready)
})

it('uses current public names and icons rather than Cloudflare deployment labels and removes a deleted icon', async () => {
  const discovery = { product: 'llll', kind: 'server', apiVersion: 2, id: '00000000-0000-4000-8000-000000000001', origin: ready, name: 'Renamed community', iconUrl: ready + '/.well-known/llll/icon?v=2', updatedAt: '2026-10-20T02:00:00.000Z', ready: true }
  vi.stubGlobal('fetch', vi.fn(async (input: string) => new URL(input).origin === ready ? Response.json(discovery) : Response.json({ ...discovery, origin: pending, name: 'Unclaimed Server', ready: false })))
  const view = await render()
  expect(view.findAll('li')[0]!.text()).toContain('Renamed community')
  expect(view.findAll('li')[0]!.get('img').attributes('src')).toBe(discovery.iconUrl)
  expect(localStorage.getItem('llll.deploy-recall.v1')).toContain('Renamed community')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...discovery, iconUrl: null, updatedAt: '2026-10-20T03:00:00.000Z' })))
  await view.findAll('button').find(button => button.text() === 'Refresh Servers')!.trigger('click')
  await flushPromises()
  expect(view.findAll('li')[0]!.find('img').exists()).toBe(false)
})

it('offers reconnect while connected and lets a failed installation be paused without deleting resources', async () => {
  const original = api.getMockImplementation()!
  api.mockImplementation(async (path: string) => path === '/api/deploy/session'
    ? { ...(await original(path)), step: 1, completed: false, name: 'My community', error: 'Verify your Cloudflare email, then reconnect.' }
    : original(path))
  const view = await render()
  expect(view.text()).toContain('Reconnect Cloudflare')
  expect(view.findAll('a').find(a => a.text() === 'Reconnect Cloudflare')?.attributes('href')).toContain('resume=1')
  const pause = view.findAll('button').find(button => button.text() === 'Pause and start another')
  expect(pause).toBeDefined()
  await pause!.trigger('click'); await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/deploy/pause', expect.objectContaining({ method: 'POST' }))
})
