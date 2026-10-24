// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, onMounted, reactive, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import Setup from '../../app/pages/setup.vue'
const token = 'fixture-private-claim-'.padEnd(64, 'x')
let api: ReturnType<typeof vi.fn>, session: { user: null; health: Record<string, unknown>; refresh: ReturnType<typeof vi.fn> }
const wrappers: ReturnType<typeof mount>[] = []
const Form = defineComponent({ emits: ['submit'], setup: (_, { slots }) => () => h('form', slots.default?.()) })
const Alert = defineComponent({ props: ['title'], setup: p => () => h('p', p.title) })
beforeEach(() => {
  sessionStorage.clear(); window.history.replaceState({}, '', '/setup')
  session = { user: null, health: { ownerSetup: true, ready: false, migrated: true }, refresh: vi.fn(async () => {}) }
  api = vi.fn(async () => ({ email: 'owner@example.test' }))
  for (const [key, value] of Object.entries({ ref, computed, reactive, onMounted, definePageMeta: vi.fn(), useSessionStore: () => session, useApi: () => ({ api }), useState: () => ref(''), navigateTo: vi.fn(), errorMessage: String })) vi.stubGlobal(key, value)
})
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); vi.unstubAllGlobals() })
async function page() {
  const v = mount(Setup, { global: { stubs: { UAlert: Alert, UForm: Form, UFormField: { template: '<label><slot /></label>' }, UInput: true, FormPasswordInput: true, UButton: true, UIcon: true } } }); wrappers.push(v); await flushPromises(); return v
}
it('restores a private setup claim after reloading the setup tab', async () => {
  window.history.replaceState({}, '', '/setup#claim=' + token)
  const first = await page(); expect(first.find('form').exists()).toBe(true)
  expect(window.location.hash).toBe(''); first.unmount()
  const reopened = await page()
  expect(reopened.find('form').exists()).toBe(true)
  expect(api).toHaveBeenLastCalledWith('/api/setup/owner/identity', expect.objectContaining({ body: { token } }))
})
it('never flashes a missing-claim warning while a successful owner setup refreshes the session', async () => {
  sessionStorage.setItem('df:owner-setup-token', token)
  const v = await page()
  session.refresh.mockImplementation(() => new Promise(() => {}))
  v.getComponent(Form).vm.$emit('submit', { data: { name: 'Owner', serverName: 'Fixture', password: 'fixture-password-long' } })
  await flushPromises()
  expect(v.text()).not.toContain('missing its private claim')
})
