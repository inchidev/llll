// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import Shell from '../../apps/site/app/components/Shell.vue'
import ShellServers from '../../apps/site/app/components/ShellServers.vue'
import App from '../../apps/site/app/app.vue'

vi.mock('../../packages/client-ui/CommunityRail.vue', () => ({ default: { name: 'CommunityRail', props: ['homeHref', 'homeLabel', 'homeActive', 'addActive', 'activeOrigin'], emits: ['home', 'connect', 'server'], template: '<nav />' } }))
const id = '00000000-0000-4000-8000-000000000001'
const origin = 'https://fixture.customer.workers.dev'
const route = reactive({ path: '/' + id, fullPath: '/' + id, params: { serverId: id } as Record<string, string>, query: {}, hash: '' })
const servers = ref([{ id, origin, name: 'Fixture community', unread: 3 }])
const selected = ref(origin)
const loaded = ref([origin])
const error = ref('')
const forget = vi.fn()
const initialize = vi.fn()
const navigate = vi.fn()
const headConfig = vi.fn()
const shell = {
  servers, selected, loaded, error,
  groups: computed(() => [{ origin, name: 'Fixture', servers: servers.value }]),
  frames: ref({}),
  frameSrc: () => 'about:blank', initialize, forget,
  refreshMetadata: vi.fn(async () => {}),
  resolveServer: vi.fn(async () => { selected.value = origin }),
}
let view: ReturnType<typeof mount> | undefined
function go(path: string) {
  route.path = path; route.fullPath = path
  route.params = path === '/' + id ? { serverId: id } : {}
}
const Button = defineComponent({ props: ['label', 'to'], setup: (props, { attrs }) => () => h(props.to ? 'a' : 'button', { ...attrs, href: props.to }, props.label) })
const Link = defineComponent({ props: ['to'], setup: (props, { attrs, slots }) => () => h('a', { ...attrs, href: props.to }, slots.default?.()) })
const Alert = defineComponent({ props: ['description'], setup: props => () => h('p', props.description) })
const Slot = { template: '<div><slot /></div>' }
const stubs = { UButton: Button, NuxtLink: Link, UAlert: Alert, UIcon: true, ShellServers, ServerCreate: { template: '<h1>Add a server</h1>' } }

beforeEach(() => {
  go('/' + id)
  servers.value = [{ id, origin, name: 'Fixture community', unread: 3 }]
  selected.value = origin; loaded.value = [origin]; error.value = ''
  forget.mockReset().mockImplementation(() => { servers.value = [] })
  initialize.mockReset(); shell.resolveServer.mockClear()
  navigate.mockReset().mockImplementation(async (path: string) => { go(path) })
  for (const [name, fn] of Object.entries({ computed, ref, watch, onMounted, onUnmounted })) vi.stubGlobal(name, fn)
  vi.stubGlobal('useShell', () => shell)
  vi.stubGlobal('useRoute', () => route)
  vi.stubGlobal('navigateTo', navigate)
  headConfig.mockReset()
  vi.stubGlobal('useHead', headConfig)
})
afterEach(() => { view?.unmount(); view = undefined; vi.unstubAllGlobals() })

it('opens My servers through the logo without unloading the Client, and keeps + for Add a server', async () => {
  view = mount(Shell, { attachTo: document.body, global: { stubs } })
  await flushPromises()
  const frame = view.get('iframe').element
  const rail = view.getComponent({ name: 'CommunityRail' })
  expect(rail.props('homeHref')).toBe('/servers')
  expect(rail.props('homeLabel')).toBe('My servers')
  const click = new MouseEvent('click', { cancelable: true })
  rail.vm.$emit('home', click)
  expect(click.defaultPrevented).toBe(true)
  expect(selected.value).toBe('')
  await flushPromises()
  expect(view.get('h1').text()).toBe('My servers')
  expect(rail.props('homeActive')).toBe(true)
  expect(rail.props('activeOrigin')).toBeUndefined()
  expect(view.get('iframe').element).toBe(frame)
  expect(view.get('iframe').isVisible()).toBe(false)
  expect(view.find(`a[href="/${id}"]`).text()).toContain('Fixture community')
  rail.vm.$emit('connect')
  await flushPromises()
  expect(route.path).toBe('/create')
  expect(view.get('h1').text()).toBe('Add a server')
  expect(rail.props('addActive')).toBe(true)
  expect(rail.props('homeActive')).toBe(false)
  go('/' + id)
  await flushPromises()
  expect(view.get('iframe').element).toBe(frame)
  expect(view.get('iframe').isVisible()).toBe(true)
})

it('clears the selected origin when history opens /servers/ and preserves modified logo clicks', async () => {
  view = mount(Shell, { attachTo: document.body, global: { stubs } })
  await flushPromises()
  const click = new MouseEvent('click', { cancelable: true, metaKey: true })
  view.getComponent({ name: 'CommunityRail' }).vm.$emit('home', click)
  expect(click.defaultPrevented).toBe(false)
  expect(navigate).not.toHaveBeenCalled()
  go('/servers/')
  await flushPromises()
  expect(selected.value).toBe('')
  expect(view.get('h1').text()).toBe('My servers')
  expect(view.get('iframe').isVisible()).toBe(false)
})

it('shows public bookmarks and removes only the device connection, including the empty state', async () => {
  view = mount(ShellServers, { global: { stubs } })
  expect(view.text()).toContain('Saved on this device')
  expect(view.text()).toContain('fixture.customer.workers.dev')
  expect(view.get('a').attributes('href')).toBe('/' + id)
  expect(view.get('[aria-label="3 unread"]').exists()).toBe(true)
  await view.get('button[aria-label="Remove Fixture community from this device"]').trigger('click')
  expect(forget).toHaveBeenCalledWith(origin)
  expect(view.text()).toContain('No saved servers yet')
  expect(view.get('a').attributes('href')).toBe('/create')
})

it('keeps the bookmark visible when an active call blocks removal', async () => {
  forget.mockImplementation(() => { throw new Error('End the active call before removing this Server') })
  view = mount(ShellServers, { global: { stubs } })
  await view.get('button').trigger('click')
  expect(view.text()).toContain('End the active call')
  expect(view.find(`a[href="/${id}"]`).exists()).toBe(true)
})

it('recognizes a fresh /servers/ route as Shell and sets its browser title', () => {
  go('/servers/')
  view = mount(App, { attachTo: document.body, global: { stubs: { UApp: Slot, ClientOnly: Slot, Shell: { template: '<main>Shell content</main>' }, NuxtPage: { template: '<article>Landing content</article>' } } } })
  expect(view.get('main').isVisible()).toBe(true)
  expect(view.get('article').isVisible()).toBe(false)
  const head = headConfig.mock.calls[0]![0]
  expect(head.title.value).toBe('My servers · L4')
})
