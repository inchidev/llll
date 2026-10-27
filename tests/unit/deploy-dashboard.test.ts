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
const Alert = defineComponent({ props: ['description', 'title'], setup: props => () => h('p', [props.title, props.description].filter(Boolean).join(' ')) })
const Checkbox = defineComponent({
  props: ['modelValue', 'label'], emits: ['update:modelValue'],
  setup: (props, { emit }) => () => h('label', [props.label, h('input', { type: 'checkbox', checked: Boolean(props.modelValue), onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).checked) })]),
})
const stubs = { UButton: Button, UInput: Input, USelect: Select, UForm: Form, UFormField: Field, UAlert: Alert, UCheckbox: Checkbox, UBadge: { template: '<span><slot /></span>' }, UIcon: true }

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  sessionStorage.clear()
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

it('restores the Finish setup action after losing the original tab and installer claim', async () => {
  const original = api.getMockImplementation()!
  let recovered = false
  api.mockImplementation(async (path: string) => {
    if (path === '/api/deploy/setup/recover') { recovered = true; return { claim: pending + '/setup#claim=' + claim } }
    const value = await original(path)
    if (path === '/api/deploy/servers') return { servers: value.servers.map((entry: object) => ({ ...entry, workerName: 'community' })) }
    if (path === '/api/deploy/session') return { ...value, completed: false, step: undefined, origin: undefined, claim: undefined, deployments: recovered ? value.deployments : [] }
    return value
  })
  const view = await render()
  let row = view.findAll('li').find(row => row.text().includes('Unclaimed Server'))!
  const finish = row.findAll('button').find(button => button.text() === 'Finish setup on your Server')!
  expect(finish.exists()).toBe(true)
  await finish.trigger('click'); await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/deploy/setup/recover', expect.objectContaining({ body: { origin: pending, accountId: account, workerName: 'community' } }))
  row = view.findAll('li').find(row => row.text().includes('Unclaimed Server'))!
  expect(row.findAll('a').find(a => a.text() === 'Finish setup on your Server')?.attributes('href')).toContain('#claim=')
  expect(localStorage.getItem('llll.deploy-recall.v1')).not.toContain(claim)
})

it('keeps Factory provisioning on its own page and restores consent after the Cloudflare redirect', async () => {
  const worker = 'llll-worker'
  sessionStorage.setItem(`llll-factory-consent:${account}:${worker}`, '1')
  vi.stubGlobal('useRoute', () => ({ params: {}, query: { factory: '1', account, worker, server: 'https://customer.example' } }))
  const view = await render()
  expect(view.text()).toContain('Enable Software Factory')
  expect(view.text()).not.toContain('Update not loaded')
  expect(view.text()).not.toContain('Add a server instead')
  expect(view.text()).not.toContain('Tick the checkbox')
  expect((view.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true)
  expect(view.findAll('button').find(button => button.text() === 'Provision Factory')?.attributes('disabled')).toBeUndefined()
})

it('asks for Factory consent again when the checkbox was not kept', async () => {
  vi.stubGlobal('useRoute', () => ({ params: {}, query: { factory: '1', account, worker: 'llll-worker', server: 'https://customer.example' } }))
  const view = await render()
  expect(view.text()).toContain('Tick the checkbox to enable Provision')
  const provision = view.findAll('button').find(button => button.text() === 'Provision Factory')
  expect(provision?.attributes('disabled')).toBeDefined()
  await view.get('input[type="checkbox"]').setValue(true)
  expect(sessionStorage.getItem(`llll-factory-consent:${account}:llll-worker`)).toBe('1')
  expect(view.findAll('button').find(button => button.text() === 'Provision Factory')?.attributes('disabled')).toBeUndefined()
})

it('keeps the selected Factory limits through OAuth and provisions the values shown', async () => {
  const worker = 'llll-worker'
  vi.stubGlobal('useRoute', () => ({ params: {}, query: { factory: '1', account, worker } }))
  let view = await render()
  await view.get('select').setValue('small')
  await view.findAll('input')[0]!.setValue('60')
  await view.findAll('input')[1]!.setValue('64')
  await view.get('input[type="checkbox"]').setValue(true)
  view.unmount()
  view = await render()
  expect(view.get('select').element.value).toBe('small')
  expect(view.findAll('input')[0]!.element.value).toBe('60')
  expect(view.findAll('input')[1]!.element.value).toBe('64')
  expect(view.text()).toContain('Small · 0.25 CPU, 1 GiB RAM, 4 GB disk; one active operation')
  expect(view.text()).not.toContain('Standard · 0.5 CPU, 4 GiB RAM, 8 GB disk; one active operation')
  await view.findAll('button').find(button => button.text() === 'Provision Factory')!.trigger('click')
  expect(api).toHaveBeenCalledWith('/api/deploy/factory/enable', expect.objectContaining({ body: { accountId: account, workerName: worker, paidConsent: true, size: 'small', timeoutSeconds: 60, processes: 64 } }))
  view.unmount()
  vi.stubGlobal('useRoute', () => ({ params: {}, query: { factory: '1', account, worker: 'other-worker' } }))
  view = await render()
  expect(view.get('select').element.value).toBe('standard')
  expect((view.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false)
})

it('ignores malformed stored Factory limits', async () => {
  const worker = 'llll-worker'
  sessionStorage.setItem(`llll-factory-options:${account}:${worker}`, JSON.stringify({ size: 'extra-paid', timeoutSeconds: 601, processes: -1 }))
  vi.stubGlobal('useRoute', () => ({ params: {}, query: { factory: '1', account, worker } }))
  const view = await render()
  expect(view.get('select').element.value).toBe('standard')
  expect(view.findAll('input')[0]!.element.value).toBe('120')
  expect(view.findAll('input')[1]!.element.value).toBe('128')
})

it('loads Factory with unchecked consent when browser storage is blocked', async () => {
  vi.stubGlobal('useRoute', () => ({ params: {}, query: { factory: '1', account, worker: 'llll-worker' } }))
  const read = vi.spyOn(sessionStorage, 'getItem').mockImplementation(() => { throw new DOMException('Storage blocked', 'SecurityError') })
  try {
    const view = await render()
    expect(view.text()).toContain('Reconnect Cloudflare')
    expect((view.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false)
    expect(view.findAll('button').find(button => button.text() === 'Provision Factory')?.attributes('disabled')).toBeDefined()
  } finally { read.mockRestore() }
})

it('shows why the Cloudflare connection could not be loaded', async () => {
  api.mockImplementation(async (path: string) => {
    if (path === '/api/deploy/config') return { oauth: true }
    if (path === '/api/deploy/releases') return { releases: [] }
    if (path === '/api/deploy/session') throw Object.assign(new Error('[GET] "/api/deploy/session": 502'), { status: 502, data: { error: { message: 'Cloudflare could not complete GET /accounts (502): timeout' } } })
    throw new Error('Unexpected API request ' + path)
  })
  const view = await render()
  expect(view.text()).toContain('Could not load the Cloudflare connection. Cloudflare could not complete GET /accounts (502): timeout')
})
